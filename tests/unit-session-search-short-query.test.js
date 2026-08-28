'use strict';

// 2026-08-28：全局搜索「非常久」的三条根因各配一条回归。
//
// 实测（真实索引 2277 session / 325483 doc / 1.8GB）改前 → 改后：
//   「梦境」(2 字·全部内容)   1080ms → 135ms
//   「梦境」(2 字·标题档)     1038ms →   2ms
//   「梦境系统」(4 字)          97ms →   2ms
//
// 根因：① 2 字中文进不了 trigram 索引，退化成 instr 顺序扫 686MB，其中 87% 是
//        tool 输出；② FTS 明明给出了命中行，代码却丢掉它、改用 session_key 回头
//        把整个 session 的 doc 连正文全捞进 JS（命中率实测 0.3%~1.8%）；
//        ③ getStats() 每次返回都跑一遍 count(*) FROM docs。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SqliteSessionSearchIndex } = require('../core/session-search-sqlite-index.js');

function makeSource(key, provider, title, docs, updatedAt = Date.now()) {
  return {
    key,
    signature: `sig-${key}`,
    searchable: true,
    session: {
      key, provider, nativeFamily: provider, kind: provider, title,
      cwd: `C:\\${provider}-repo`, projectLabel: `${provider}-repo`, model: `${provider}-model`,
      updatedAt, hubSessionId: `hub-${key}`, nativeSessionId: `native-${key}`,
      meetingId: null, transcriptPath: `C:\\transcripts\\${key}.jsonl`, turnCount: docs.length,
    },
    docs: docs.map((doc, index) => ({
      id: doc.id || `doc-${index}`, eventId: doc.id || `doc-${index}`,
      scope: doc.scope, role: doc.scope, speaker: provider,
      text: doc.text, ordinal: index, timestamp: (doc.timestamp || updatedAt) + index,
    })),
  };
}

function freshIndex(t, name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `hub-search-${name}-`));
  const index = new SqliteSessionSearchIndex(path.join(root, 'search.sqlite'));
  t.after(() => { index.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return index;
}

test('2 字中文词能搜到（trigram 索引不到，必须有顺序扫描兜底）', (t) => {
  const index = freshIndex(t, 'short');
  index.replaceSource(makeSource('s1', 'codex', '梦境系统排查', [
    { id: 'u1', scope: 'user', text: '梦境到底跑没跑' },
  ]));
  const hit = index.search({ query: '梦境' });
  assert.equal(hit.totalSessions, 1, '两个字必须能搜到，这是中文最常见的检索长度');
  assert.equal(hit.results[0].sessionKey, 's1');
});

test('短词默认不扫 tool，并如实告知已收窄；显式选工具页签时照常搜', (t) => {
  const index = freshIndex(t, 'short-scope');
  index.replaceSource(makeSource('s1', 'codex', '无关标题', [
    { id: 'u1', scope: 'user', text: '看看日志' },
    { id: 't1', scope: 'tool', text: 'rg --files C:/归档输出目录' },
  ]));

  const all = index.search({ query: '归档' });
  assert.equal(all.totalSessions, 0, '默认档不该为了两个字去扫 205MB 的工具输出');
  assert.deepEqual(all.narrowedScopes, ['title', 'user', 'assistant'],
    '收窄了就必须告诉调用方，否则用户以为「没搜到」= 不存在');

  const toolTab = index.search({ query: '归档', scopes: ['tool'] });
  assert.equal(toolTab.totalSessions, 1, '用户显式选「工具 / 文件」就该扫 tool');
  assert.equal(toolTab.narrowedScopes, undefined, '显式指定了 scope 就不算收窄');

  const long = index.search({ query: '归档输出' });
  assert.equal(long.totalSessions, 1, '≥3 字走 FTS，不受短词收窄影响');
});

test('scope 下推：标题档不再把整个 session 的正文捞出来再丢掉', (t) => {
  const index = freshIndex(t, 'scope-pushdown');
  // 一个「标题命中、正文里堆了大量无关文档」的 session：旧实现会把 400 条全捞出来。
  const noise = Array.from({ length: 400 }, (_, i) => ({
    id: `n${i}`, scope: 'tool', text: `无关工具输出 ${i} ${'x'.repeat(200)}`,
  }));
  index.replaceSource(makeSource('s1', 'codex', '梦境沉淀方案', [
    { id: 'u1', scope: 'user', text: '正文里没有那两个字' },
    ...noise,
  ]));

  const titleOnly = index.search({ query: '梦境沉淀', scopes: ['title'] });
  assert.equal(titleOnly.totalSessions, 1);
  assert.equal(titleOnly.results[0].bestMatch.scope, 'title');
  assert.equal(titleOnly.results[0].matchCount, 1, '标题档只该有标题那一条命中');

  const userOnly = index.search({ query: '梦境沉淀', scopes: ['user'] });
  assert.equal(userOnly.totalSessions, 0, 'scope 过滤必须真的生效，不是摆设');
});

test('只加载命中行：海量无关文档不再顶爆 maxQueryDocs 闸门', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-search-guard-'));
  // 闸门压到 50：旧实现会先把 300 条无关文档捞满 50 就 break，命中的那条永远看不到。
  const index = new SqliteSessionSearchIndex(path.join(root, 'search.sqlite'), { maxQueryDocs: 50 });
  t.after(() => { index.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const noise = Array.from({ length: 300 }, (_, i) => ({
    id: `n${i}`, scope: 'assistant', text: `无关内容 ${i}`,
  }));
  index.replaceSource(makeSource('noisy', 'codex', '很吵的会话', [
    ...noise,
    { id: 'needle', scope: 'assistant', text: 'NEEDLE_MARKER 藏在最后' },
  ]));

  const found = index.search({ query: 'NEEDLE_MARKER' });
  assert.equal(found.totalSessions, 1, '命中行只有 1 条，不该被 300 条无关文档挤掉');
  assert.equal(found.results[0].bestMatch.eventId, 'needle');
  assert.equal(found.truncated, false, '只取命中行就不该报截断');
});

test('多词 AND 仍然按 session 聚合，且跨文档成立', (t) => {
  const index = freshIndex(t, 'multi-term');
  index.replaceSource(makeSource('both', 'codex', '会话一', [
    { id: 'a', scope: 'user', text: '归档路径怎么定' },
    { id: 'b', scope: 'assistant', text: '交给梦境系统自动推荐' },
  ]));
  index.replaceSource(makeSource('onlyone', 'claude', '会话二', [
    { id: 'c', scope: 'user', text: '归档路径怎么定' },
  ]));

  const both = index.search({ query: '归档路径 梦境系统' });
  assert.equal(both.totalSessions, 1, '两个词分布在不同文档里也算这个 session 命中');
  assert.equal(both.results[0].sessionKey, 'both');
  assert.equal(both.results[0].matchCount, 2);
});

test('getStats 缓存在写入后失效，不会返回过期的 session/doc 计数', (t) => {
  const index = freshIndex(t, 'stats-cache');
  index.replaceSource(makeSource('s1', 'codex', '第一个', [{ id: 'u1', scope: 'user', text: 'ALPHA_MARKER' }]));
  const before = index.getStats();
  assert.equal(before.sessions, 1);
  assert.equal(index.getStats(), before, '没写过就该复用同一个对象（这正是缓存的意义）');

  index.replaceSource(makeSource('s2', 'claude', '第二个', [{ id: 'u2', scope: 'user', text: 'BETA_MARKER' }]));
  const after = index.getStats();
  assert.equal(after.sessions, 2, '写完必须重新统计');
  assert.equal(after.documents, 4, '每个 source 一条 title + 一条 user');

  index.pruneSources(new Set(['s1']));
  assert.equal(index.getStats().sessions, 1, 'prune 之后也要失效');
});

test('FTS 分支绝不能把 scope 放进 WHERE（放进去实测慢 18000 倍）', (t) => {
  const index = freshIndex(t, 'fts-shape');
  // 真实索引上的实测：powershell + scope IN ('tool')
  //   WHERE 里  → 298477 ms（规划器改用 idx_docs_scope_time 驱动，LIMIT 失去短路）
  //   投影里    →     16 ms
  // 这个性质在几行夹具上复现不出来，只能锁语句形状。
  const fts = index._matchStatement({ useFts: true, scopes: ['tool'], hasSince: true });
  const ftsSql = String(fts.sourceSQL || fts.expandedSQL || index._lastMatchSql || '');
  assert.ok(ftsSql, '拿不到 FTS 语句的 SQL 文本，测试本身失效了');
  assert.doesNotMatch(ftsSql, /scope\s+IN/i, 'FTS 分支的 WHERE 里出现 scope 过滤 —— 这正是那个 298 秒的查询');
  assert.doesNotMatch(ftsSql, /timestamp\s*>=/i, 'FTS 分支的 WHERE 里也不该有时间过滤');
  assert.match(ftsSql, /d\.scope AS scope/i, 'scope 要留在投影里，交给 JS 过滤');

  const instr = index._matchStatement({ useFts: false, scopes: ['tool'], hasSince: true });
  const instrSql = String(instr.sourceSQL || instr.expandedSQL || '');
  assert.match(instrSql, /scope\s+IN/i, 'instr 分支相反：scope 必须留在 WHERE，那是它唯一的收窄手段');
});

test('FTS 路径 + scope 过滤：JS 侧过滤的结果必须和语义一致', (t) => {
  const index = freshIndex(t, 'fts-js-filter');
  index.replaceSource(makeSource('s1', 'codex', '无关标题', [
    { id: 'u1', scope: 'user', text: '我问了 SHAPEPROBE 这个词' },
    { id: 't1', scope: 'tool', text: 'rg SHAPEPROBE C:/somewhere' },
    { id: 'a1', scope: 'assistant', text: '回答里也有 SHAPEPROBE' },
  ]));
  assert.equal(index.search({ query: 'SHAPEPROBE' }).results[0].matchCount, 3, '不限 scope 时三条都算');
  assert.equal(index.search({ query: 'SHAPEPROBE', scopes: ['tool'] }).results[0].matchCount, 1);
  assert.equal(index.search({ query: 'SHAPEPROBE', scopes: ['user'] }).results[0].matchCount, 1);
  assert.equal(index.search({ query: 'SHAPEPROBE', scopes: ['user', 'assistant'] }).results[0].matchCount, 2);
  assert.equal(index.search({ query: 'SHAPEPROBE', scopes: ['title'] }).totalSessions, 0);
});

test('时间过滤下推后，超出时间窗的命中不再被算进 matchCount', (t) => {
  const index = freshIndex(t, 'since');
  const now = Date.now();
  const old = now - 40 * 86_400_000;
  index.replaceSource(makeSource('s1', 'codex', '跨时间会话', [
    { id: 'old', scope: 'user', text: 'TIMEBOX_MARKER 很久以前', timestamp: old },
  ], old));
  index.replaceSource(makeSource('s2', 'codex', '新会话', [
    { id: 'new', scope: 'user', text: 'TIMEBOX_MARKER 刚刚', timestamp: now },
  ], now));

  assert.equal(index.search({ query: 'TIMEBOX_MARKER' }).totalSessions, 2);
  const recent = index.search({ query: 'TIMEBOX_MARKER', timeRange: '7d' });
  assert.equal(recent.totalSessions, 1);
  assert.equal(recent.results[0].sessionKey, 's2');
});

console.log('unit-session-search-short-query OK');

test('单个汉字也要真的去搜（此前是静默不搜，不是没结果）', (t) => {
  const index = freshIndex(t, 'single-char');
  index.replaceSource(makeSource('s1', 'codex', '海市蜃楼现象', [
    { id: 'u1', scope: 'user', text: '这个「蜃」字怎么念' },
    { id: 'a1', scope: 'assistant', text: '读 shèn。' },
  ]));
  index.replaceSource(makeSource('s2', 'claude', '无关会话', [
    { id: 'u2', scope: 'user', text: '今天天气不错' },
  ]));

  // 2026-08-28 压测抓到：search() 里 `length < 2` 直接返回空，
  // 于是单字查询根本没到索引层。中文里单字是完整的检索单位。
  const hit = index.search({ query: '蜃' });
  assert.equal(hit.totalSessions, 1, '单个汉字必须能搜到');
  assert.equal(hit.results[0].sessionKey, 's1');

  assert.equal(index.search({ query: '蜃', scopes: ['title'] }).totalSessions, 1, '标题里也有这个字');
  assert.equal(index.search({ query: '蜃', scopes: ['assistant'] }).totalSessions, 0, 'AI 回答里没有');

  // 空查询仍然返回空，别把闸门开过头
  assert.equal(index.search({ query: '' }).totalSessions, 0);
  assert.equal(index.search({ query: '   ' }).totalSessions, 0);
});

test('渲染层不再拦单字，否则后端放开了也白搭', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'global-session-search.js'), 'utf8');
  assert.doesNotMatch(src, /if \(trimmed\.length < 2\) return;/,
    '渲染层还拦着单字的话，后端放开也没用');
});

test('多词查询：任一词零命中就立刻收工，不把剩下的词也扫一遍', (t) => {
  const index = freshIndex(t, 'lazy-terms');
  index.replaceSource(makeSource('s1', 'codex', '会话', [
    { id: 'u1', scope: 'user', text: 'LAZYPROBE 常见词 的 是 在' },
  ]));

  // 模糊浸泡抓到的形态：粘一大段文本进搜索框，被空白切成十几个词，
  // 其中的 1~2 字词每个都是一次顺序扫描，串起来 3.5 秒。多词是 AND，
  // 只要有一个词零命中，整个结果必然为空，后面的词根本不该查。
  const calls = [];
  const orig = index._matchedDocsForTerm.bind(index);
  index._matchedDocsForTerm = (term, scopes, since) => { calls.push(term); return orig(term, scopes, since); };

  const res = index.search({ query: 'ZZZABSENTWORD 的 是 在 常见词' });
  assert.equal(res.totalSessions, 0);
  assert.equal(calls.length, 1, `零命中的长词应当第一个被查并立即收工，实际查了 ${calls.length} 个词: ${JSON.stringify(calls)}`);
  assert.equal(calls[0], 'zzzabsentword', '最长的词优先查（≥3 字走 FTS，毫秒级）');
});

test('多词都命中时，语义仍然是 AND（惰性求值不能改变结果）', (t) => {
  const index = freshIndex(t, 'lazy-and');
  index.replaceSource(makeSource('both', 'codex', '两个词都有', [
    { id: 'a', scope: 'user', text: 'ALPHAWORD 出现在提问' },
    { id: 'b', scope: 'assistant', text: 'BETAWORD 出现在回答' },
  ]));
  index.replaceSource(makeSource('one', 'claude', '只有一个词', [
    { id: 'c', scope: 'user', text: 'ALPHAWORD 只有这个' },
  ]));
  assert.equal(index.search({ query: 'ALPHAWORD BETAWORD' }).totalSessions, 1);
  assert.equal(index.search({ query: 'BETAWORD ALPHAWORD' }).totalSessions, 1, '词序不该影响结果');
  assert.equal(index.search({ query: 'ALPHAWORD' }).totalSessions, 2);
});

test('短词档要能预热，且预热是只读幂等的', (t) => {
  const index = freshIndex(t, 'prewarm');
  index.replaceSource(makeSource('s1', 'codex', '标题里有蜃', [
    { id: 'u1', scope: 'user', text: '提问里也有蜃' },
    { id: 't1', scope: 'tool', text: '工具输出里有蜃' },
  ]));
  const before = index.getStats();
  // 罕见 2 字词必须扫完整个短词 scope 才知道没有更多命中，冷缓存下实测 1241ms；
  // 预热一次 ~75ms 之后同一个查询 65ms。预热本身不能改数据。
  assert.equal(index.prewarmShortTermScopes(), true);
  assert.equal(index.prewarmShortTermScopes(), true, '幂等，可以反复调');
  const after = index.getStats();
  assert.equal(after.sessions, before.sessions);
  assert.equal(after.documents, before.documents);
  assert.equal(index.search({ query: '蜃' }).totalSessions, 1, '预热之后照常能搜');
});

test('engine 构造与刷新之后都要预热短词档', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'session-search-engine.js'), 'utf8');
  const hooks = src.split('\n').filter(line => line.includes('prewarmShortTermScopes'));
  assert.ok(hooks.length >= 2,
    `构造时和刷新完成后都要预热，实际只找到 ${hooks.length} 处`);
  for (const line of hooks) {
    assert.match(line, /setImmediate/, '预热必须放进 setImmediate，别挡住构造和第一次查询');
  }
});
