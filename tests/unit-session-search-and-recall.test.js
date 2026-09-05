'use strict';
// 多词 AND 的召回完整性（2026-09-04）。
//
// 用户现象：「搜索经常搜不到很多 session，而且我确定信息是对的」。
//
// 根因：每个词各自 `LIMIT maxQueryDocs` 取候选，且那条 SQL **没有 ORDER BY**，
// 拿到的是 rowid 顺序（≈最早入库的一批）。随后的 AND 在**截断后**的集合上求交，
// 常见词的候选窗口彼此几乎不重叠，于是大量确实同时含有全部词的会话被静默丢掉。
// 代码里那句「按会话最近活动倒序，让被截掉的是最老的会话」救不回来 ——
// 那个排序发生在截断之后，排的是已经幸存的候选。
//
// 真实索引实测（4048 会话 / 366k 行，查「ai 圆桌 v」）：真值 170 个会话，
// 旧算法只给 121 个，静默丢 29%，UI 不提示。
//
// 这里用一个小索引把同一形状复现出来：稀有词只出现在最后几个会话，
// 常见词的前 N 行全部落在前面的会话上 —— 截断窗口天然错开。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SqliteSessionSearchIndex } = require('../core/session-search-sqlite-index.js');

const NOISE_SESSIONS = 60;   // 只含常见词，用来把常见词的候选窗口占满
const TARGET_SESSIONS = 8;   // 同时含常见词与稀有词，是本该被搜到的那些
const DOCS_PER_NOISE = 30;

function makeSource(key, docs, updatedAt) {
  return {
    key,
    signature: `sig-${key}`,
    searchable: true,
    session: {
      key, provider: 'claude', nativeFamily: 'claude', kind: 'claude',
      title: `会话 ${key}`, cwd: 'C:\\repo', projectLabel: 'repo', model: 'm',
      updatedAt, hubSessionId: `hub-${key}`, nativeSessionId: `native-${key}`,
      meetingId: null, transcriptPath: `C:\\t\\${key}.jsonl`, turnCount: docs.length,
    },
    docs: docs.map((doc, index) => ({
      id: `${key}-${index}`, eventId: `${key}-${index}`,
      scope: doc.scope, role: doc.scope, speaker: 'claude',
      text: doc.text, ordinal: index, timestamp: updatedAt + index,
    })),
  };
}

function buildIndex(dbPath) {
  // maxQueryDocs 调小，让截断在小语料上也能复现（语义与生产的 6000 完全一致）
  const index = new SqliteSessionSearchIndex(dbPath, { maxQueryDocs: 1000 });
  let clock = 1_700_000_000_000;

  // 先灌噪声会话：只含常见词 alpha/beta，把两个常见词的候选窗口塞满，
  // 而且它们的 rowid 都比目标会话小 —— 正是「截断取到最早那批」的形状。
  for (let s = 0; s < NOISE_SESSIONS; s += 1) {
    const docs = [];
    for (let d = 0; d < DOCS_PER_NOISE; d += 1) {
      docs.push({ scope: 'assistant', text: `alpha 噪声正文 ${d} beta` });
    }
    index.replaceSource(makeSource(`noise-${s}`, docs, clock));
    clock += 1000;
  }

  // 目标会话：同时含 alpha、beta 和稀有词 zeta。稀有词整个语料里只在这里出现。
  for (let s = 0; s < TARGET_SESSIONS; s += 1) {
    index.replaceSource(makeSource(`target-${s}`, [
      { scope: 'assistant', text: 'alpha 命中正文 beta zeta 稀有词' },
    ], clock));
    clock += 1000;
  }
  return index;
}

test('多词 AND：常见词候选被截断时，仍要召回全部同时命中的会话', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-search-recall-'));
  const dbPath = path.join(root, 'search.sqlite');
  const index = buildIndex(dbPath);
  t.after(() => { index.close(); fs.rmSync(root, { recursive: true, force: true }); });

  // 前提校验：稀有词单独搜必须只命中目标会话，否则这个用例的形状就没搭对。
  const rareOnly = index.search({ query: 'zeta', limit: 200 });
  assert.equal(rareOnly.totalSessions, TARGET_SESSIONS,
    `稀有词应命中 ${TARGET_SESSIONS} 个会话，实际 ${rareOnly.totalSessions}`);

  // 前提校验：常见词的候选确实被截断了，否则测不到这个 bug。
  const commonOnly = index.search({ query: 'alpha', limit: 200 });
  assert.equal(commonOnly.truncated, true, '常见词候选必须触发截断，否则用例失效');

  // 正题：三词 AND。只有目标会话同时含 alpha + beta + zeta。
  const combined = index.search({ query: 'alpha beta zeta', limit: 200 });
  assert.equal(combined.totalSessions, TARGET_SESSIONS,
    `多词 AND 应召回全部 ${TARGET_SESSIONS} 个会话，实际 ${combined.totalSessions}`
    + ' —— 少了就说明常见词的截断窗口把它们挤掉了');
  const keys = combined.results.map(item => item.key).sort();
  assert.deepEqual(keys, Array.from({ length: TARGET_SESSIONS }, (_v, i) => `target-${i}`).sort());
});

test('单词查询不受影响，且截断仍如实上报', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-search-recall-single-'));
  const dbPath = path.join(root, 'search.sqlite');
  const index = buildIndex(dbPath);
  t.after(() => { index.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const common = index.search({ query: 'alpha', limit: 200 });
  assert.equal(common.truncated, true, '单词命中超上限时必须如实上报截断，不能装作完整');
  assert.ok(common.totalSessions > 0);

  const rare = index.search({ query: 'zeta', limit: 200 });
  assert.equal(rare.truncated, false, '未超上限的查询不该被标成截断');
});

test('全部词都被截断时不崩，退回旧行为并上报截断', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-search-recall-alltrunc-'));
  const dbPath = path.join(root, 'search.sqlite');
  const index = buildIndex(dbPath);
  t.after(() => { index.close(); fs.rmSync(root, { recursive: true, force: true }); });

  // alpha 与 beta 在每一条噪声正文里都出现，两个词都会被截断 —— 没有可用的驱动词。
  const both = index.search({ query: 'alpha beta', limit: 200 });
  assert.equal(both.truncated, true, '没有未截断的驱动词时，必须如实上报截断');
  assert.ok(both.totalSessions > 0, '退化路径也要给出结果，不能直接空手而归');
});

// ---------------------------------------------------------------------------
// 「每次打开都要索引半天」的真凶不是索引，是状态在撒谎（2026-09-04）。
//
// 索引是持久化的（sqlite）、是增量的（signature=size:mtime 复用）、启动也有预热。
// 但 refreshTtlMs 只有 10s，用户每次打开搜索面板都会触发一次后台体检，而 refresh()
// 开头无条件 `_emit({ refreshing: true })` —— 前端一看见就显示
// 「正在建立本地索引 · 0/4047」并禁用按钮。真正需要重解析的来源往往是 0 个。
//
// 修法：已有可用索引时先数清楚有多少来源真要重解析；一个都不用动就全程不打扰，
// 状态保持 ready。有真活干时才翻 refreshing，且进度分母是「要干的活」而不是扫过的目录数。
const { SessionSearchEngine } = require('../core/session-search-engine.js');

function writeClaudeTranscript(root, name, lines) {
  const file = path.join(root, 'C--proj', `${name}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n'));
  return file;
}

test('已有索引时的增量体检必须全程静默，不得显示「正在建立本地索引」', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-search-silent-'));
  const claudeRoot = path.join(root, '.claude', 'projects');
  const databasePath = path.join(root, 'cache', 'search.sqlite');
  writeClaudeTranscript(claudeRoot, 'sess-a', [
    { type: 'user', uuid: 'u1', timestamp: '2026-09-01T10:00:00Z', message: { role: 'user', content: '静默体检验证' } },
    { type: 'assistant', uuid: 'a1', timestamp: '2026-09-01T10:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: '回答正文' }] } },
  ]);

  const seen = [];
  const engine = new SessionSearchEngine(
    { databasePath, claudeRoots: [claudeRoot], codexRoots: [], refreshTtlMs: 1 },
    status => seen.push({ phase: status.phase, refreshing: !!status.refreshing }),
  );
  t.after(() => { engine.close(); fs.rmSync(root, { recursive: true, force: true }); });

  // 第一次：确实要建索引，允许并且应该显示 refreshing
  await engine.refresh({ sessions: [], meetings: [] }, { force: true });
  assert.ok(seen.some(s => s.refreshing), '首次建索引必须如实显示进度');
  assert.equal(engine.status().ready, true);

  // 第二次：文件一个字没改，是纯体检 —— 全程不许出现 refreshing。
  // 注意必须等过 refreshTtlMs，否则 refresh() 直接早退、什么都不推，用例会空转通过。
  await new Promise(resolve => setTimeout(resolve, 20));
  seen.length = 0;
  await engine.refresh({ sessions: [], meetings: [] }, { force: false });
  assert.equal(seen.some(s => s.refreshing), false,
    `增量体检不得把状态翻成 refreshing（实际推送：${JSON.stringify(seen)}）`);
  assert.equal(engine.status().ready, true, '体检期间检索能力一秒都不该缺失');
});

test('真有新内容时仍要显示进度，且分母是待解析数而不是全部来源', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-search-progress-'));
  const claudeRoot = path.join(root, '.claude', 'projects');
  const databasePath = path.join(root, 'cache', 'search.sqlite');
  for (let i = 0; i < 4; i += 1) {
    writeClaudeTranscript(claudeRoot, `old-${i}`, [
      { type: 'user', uuid: `u${i}`, timestamp: '2026-09-01T10:00:00Z', message: { role: 'user', content: `旧会话 ${i}` } },
      { type: 'assistant', uuid: `a${i}`, timestamp: '2026-09-01T10:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: '旧回答' }] } },
    ]);
  }
  const engine = new SessionSearchEngine(
    { databasePath, claudeRoots: [claudeRoot], codexRoots: [], refreshTtlMs: 1 },
    () => {},
  );
  t.after(() => { engine.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await engine.refresh({ sessions: [], meetings: [] }, { force: true });

  // 只新增 1 个来源：进度分母应该是 1，不是 5
  writeClaudeTranscript(claudeRoot, 'fresh', [
    { type: 'user', uuid: 'nu', timestamp: '2026-09-02T10:00:00Z', message: { role: 'user', content: '新会话' } },
    { type: 'assistant', uuid: 'na', timestamp: '2026-09-02T10:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: '新回答' }] } },
  ]);
  await new Promise(resolve => setTimeout(resolve, 20));
  const totals = [];
  engine.emitStatus = status => { if (status.refreshing) totals.push(Number(status.totalSources) || 0); };
  await engine.refresh({ sessions: [], meetings: [] }, { force: false });
  assert.ok(totals.length > 0, '有新来源时必须显示进度');
  assert.ok(totals.every(v => v <= 1),
    `进度分母应为待解析数（1），实际出现 ${JSON.stringify(totals)} —— 用全部来源数会让人以为在从零重建`);
});
