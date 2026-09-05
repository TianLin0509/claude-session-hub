'use strict';
// CJK 短词辅助索引（2026-09-05）。
//
// FTS5 的 trigram 分词器至少要 3 个字符才走索引，而中文最常用的检索单位是两个字。
// 真实索引实测（4048 会话 / 366k 行）：「圆桌」顺序扫描 837ms，四字词走 FTS 12ms，
// 差 70 倍。也实测确认 trigram 不支持前缀查询（MATCH '"圆桌"*' 返回 0），绕不过去。
//
// 这里的不变量只有一条，但它比速度重要得多：
//   **辅助索引给出的结果必须与顺序扫描逐个相同。** 快而漏是最糟的结果 ——
//   用户不会知道自己少看见了什么。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SqliteSessionSearchIndex } = require('../core/session-search-sqlite-index.js');
const { cjkAuxTokens, isCjkAuxTerm } = require('../core/session-search-index.js');

function makeSource(key, docs, updatedAt = 1_700_000_000_000) {
  return {
    key,
    signature: `sig-${key}`,
    searchable: true,
    session: {
      key, provider: 'claude', nativeFamily: 'claude', kind: 'claude',
      title: docs.title || `会话 ${key}`, cwd: 'C:\\repo', projectLabel: 'repo', model: 'm',
      updatedAt, hubSessionId: `hub-${key}`, nativeSessionId: `native-${key}`,
      meetingId: null, transcriptPath: `C:\\t\\${key}.jsonl`, turnCount: 1,
    },
    docs: (docs.rows || []).map((doc, index) => ({
      id: `${key}-${index}`, eventId: `${key}-${index}`,
      scope: doc.scope, role: doc.scope, speaker: 'claude',
      text: doc.text, ordinal: index, timestamp: updatedAt + index,
    })),
  };
}

test('分词器：只切 CJK 的一元+二元，拉丁一个都不收', () => {
  assert.equal(cjkAuxTokens('信息熵'), '信 信息 息 息熵 熵');
  assert.equal(cjkAuxTokens('hello world'), '', '纯拉丁不进辅助索引');
  // 拉丁是子串语义（查 ai 要能命中 openai），用词元匹配会假阴性，所以刻意不收
  assert.equal(isCjkAuxTerm('ai'), false);
  assert.equal(isCjkAuxTerm('v'), false);
  assert.equal(isCjkAuxTerm('圆桌'), true);
  assert.equal(isCjkAuxTerm('熵'), true, '单个汉字是完整的检索单位');
  assert.equal(isCjkAuxTerm('索引重建'), false, '3 字以上交给 trigram，别重复建索引');
  assert.equal(isCjkAuxTerm('a圆'), false, '混合词有子串语义，不能走词元匹配');
});

// 语料刻意覆盖几个容易漏的形状：词在开头 / 结尾 / 夹在拉丁中间 / 单字 / 跨标点
const CORPUS = [
  { scope: 'user', text: '圆桌会议今天几点开始' },          // 词在开头
  { scope: 'assistant', text: '这个问题请交给圆桌' },        // 词在结尾
  { scope: 'assistant', text: 'AI圆桌v2 的排期' },           // 夹在拉丁之间
  { scope: 'user', text: '信息熵是多少' },                   // 单字 熵 在中间
  { scope: 'assistant', text: '最后一个字是熵' },            // 单字 熵 在结尾
  { scope: 'user', text: '圆桌、会议、纪要' },               // 跨标点（标点会断开 CJK run）
  { scope: 'assistant', text: '完全无关的内容' },            // 反例
  { scope: 'tool', text: '工具输出里也有圆桌两个字' },        // tool 档刻意不进辅助索引
];

function buildIndex(dbPath) {
  const index = new SqliteSessionSearchIndex(dbPath);
  CORPUS.forEach((row, i) => {
    index.replaceSource(makeSource(`s-${i}`, { title: `标题 ${i}`, rows: [row] }));
  });
  return index;
}

test('辅助索引与顺序扫描结果逐个相同（这是拿速度换正确性的红线）', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cjk-aux-'));
  const index = buildIndex(path.join(root, 'search.sqlite'));
  t.after(() => { index.close(); fs.rmSync(root, { recursive: true, force: true }); });

  // 回填前：辅助索引未就绪，走顺序扫描，这是基准真值
  assert.equal(index.cjkAuxReady(), false, '刚建库时辅助索引不该被当成就绪');
  const baseline = {};
  for (const q of ['圆桌', '熵', '会议', '纪要', '无关']) {
    baseline[q] = index.search({ query: q, limit: 200 }).results.map(r => r.key).sort();
  }
  assert.ok(baseline['圆桌'].length > 0, '基准必须非空，否则这个用例没有判别力');

  // 回填到底
  let guard = 0;
  for (;;) {
    const step = index.backfillCjkAux({ budgetMs: 50, batchSize: 2 });
    if (step.done) break;
    assert.ok((guard += 1) < 500, '回填必须能收敛，不能无限循环');
  }
  assert.equal(index.cjkAuxReady(), true, '回填跑完必须置位，否则永远用不上');

  // 回填后：必须与基准逐个相同
  for (const q of Object.keys(baseline)) {
    const after = index.search({ query: q, limit: 200 }).results.map(r => r.key).sort();
    assert.deepEqual(after, baseline[q],
      `「${q}」走辅助索引后的结果与顺序扫描不一致：`
      + `扫描=${JSON.stringify(baseline[q])} 辅助=${JSON.stringify(after)}`);
  }
});

// 模拟「迁移前建的老库」：辅助表是空的、meta 标志没置位。
// 新建库走不到这个状态 —— replaceSource 插入时就实时写了辅助索引，
// 回填对它是空操作。不模拟这一步，下面这条用例就是空转（变异测试实测抓到过）。
function degradeToLegacy(index) {
  index.db.exec('DELETE FROM docs_cjk');
  index.setMeta('cjkAuxReady', '0');
  index.setMeta('cjkAuxCursor', '0');
  index.statsCache = null;
}

test('回填未完成时绝不启用辅助索引（宁可慢也不能漏）', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cjk-partial-'));
  const index = buildIndex(path.join(root, 'search.sqlite'));
  t.after(() => { index.close(); fs.rmSync(root, { recursive: true, force: true }); });

  while (!index.backfillCjkAux({ budgetMs: 10_000, batchSize: 1000 }).done) { /* 先跑满拿真值 */ }
  const truth = index.search({ query: '圆桌', limit: 200 }).results.map(r => r.key).sort();
  assert.ok(truth.length >= 2, '真值至少要有两条，否则「漏一条」测不出来');

  degradeToLegacy(index);
  assert.equal(index.cjkAuxReady(), false);

  // 只回填一小步，故意停在中途：此时辅助索引严重不全
  const step = index.backfillCjkAux({ budgetMs: 0, batchSize: 1 });
  assert.equal(step.done, false, '一步就跑完的话这个用例失去意义');
  assert.equal(index.cjkAuxReady(), false);
  const auxRows = index.db.prepare('SELECT count(*) c FROM docs_cjk').get().c;
  assert.ok(Number(auxRows) < truth.length, `辅助索引必须确实不全才有判别力（现有 ${auxRows} 行）`);

  const partial = index.search({ query: '圆桌', limit: 200 }).results.map(r => r.key).sort();
  assert.deepEqual(partial, truth, '回填中途查询必须仍走顺序扫描，结果不得缺失');
});

test('回填可续跑：分多次调用与一次跑完等价', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cjk-resume-'));
  const a = buildIndex(path.join(root, 'a.sqlite'));
  const b = buildIndex(path.join(root, 'b.sqlite'));
  t.after(() => { a.close(); b.close(); fs.rmSync(root, { recursive: true, force: true }); });

  // a：一次性跑完
  let guard = 0;
  while (!a.backfillCjkAux({ budgetMs: 10_000, batchSize: 1000 }).done) {
    assert.ok((guard += 1) < 100);
  }
  // b：每次只处理 1 条，模拟被反复打断
  guard = 0;
  while (!b.backfillCjkAux({ budgetMs: 0, batchSize: 1 }).done) {
    assert.ok((guard += 1) < 500, '续跑必须收敛');
  }

  for (const q of ['圆桌', '熵', '会议']) {
    assert.deepEqual(
      b.search({ query: q, limit: 200 }).results.map(r => r.key).sort(),
      a.search({ query: q, limit: 200 }).results.map(r => r.key).sort(),
      `「${q}」分次回填与一次回填结果不一致`,
    );
  }
});

test('新写入的会话实时进辅助索引，不必等下一轮回填', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cjk-live-'));
  const index = buildIndex(path.join(root, 'search.sqlite'));
  t.after(() => { index.close(); fs.rmSync(root, { recursive: true, force: true }); });
  while (!index.backfillCjkAux({ budgetMs: 10_000, batchSize: 1000 }).done) { /* 跑到底 */ }

  index.replaceSource(makeSource('fresh', { title: '新会话', rows: [
    { scope: 'assistant', text: '这是刚写入的圆桌内容' },
  ] }));
  const hit = index.search({ query: '圆桌', limit: 200 }).results.map(r => r.key);
  assert.ok(hit.includes('fresh'), '实时写入的会话必须立刻可被短词检索到');
});

test('来源被替换后不留孤儿词元（存储卫生，不是正确性）', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cjk-delete-'));
  const index = buildIndex(path.join(root, 'search.sqlite'));
  t.after(() => { index.close(); fs.rmSync(root, { recursive: true, force: true }); });
  while (!index.backfillCjkAux({ budgetMs: 10_000, batchSize: 1000 }).done) { /* 跑到底 */ }

  // 先说清楚这条测的是什么：**幽灵命中本来就不可能发生** ——
  // 查询是 docs_cjk JOIN docs，doc 行没了 JOIN 自然把孤儿丢弃。
  // 所以这里断言的是孤儿不许累积，否则辅助表会随着会话反复更新无限膨胀。
  const orphans = () => Number(index.db.prepare(
    'SELECT count(*) c FROM docs_cjk WHERE rowid NOT IN (SELECT id FROM docs)',
  ).get().c);
  assert.equal(orphans(), 0, '初始不该有孤儿');

  for (let round = 0; round < 3; round += 1) {
    index.replaceSource(makeSource('s-0', { title: '标题 0', rows: [
      { scope: 'user', text: `第 ${round} 轮换过的圆桌正文` },
    ] }));
    assert.equal(orphans(), 0, `第 ${round} 轮替换后出现了孤儿词元，辅助表会随更新次数膨胀`);
  }
  // 顺带确认替换后仍然搜得到（内容还含「圆桌」）
  assert.ok(index.search({ query: '圆桌', limit: 200 }).results.some(r => r.key === 's-0'));
});

test('tool 档不进辅助索引（体积属性：进了就是 7 倍膨胀）', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cjk-scope-'));
  const index = buildIndex(path.join(root, 'search.sqlite'));
  t.after(() => { index.close(); fs.rmSync(root, { recursive: true, force: true }); });
  while (!index.backfillCjkAux({ budgetMs: 10_000, batchSize: 1000 }).done) { /* 跑到底 */ }

  // 查询侧本来就按 scope 过滤，所以把 tool 灌进来不会让结果出错 ——
  // 它错在体积：真实语料里 tool 独占 220M 字符，其余三档合计才 33.8M。
  // 无脑全量建索引 = 拿 7 倍空间换一堆工具入参 JSON 里的噪声命中。
  const toolIndexed = Number(index.db.prepare(
    "SELECT count(*) c FROM docs_cjk JOIN docs d ON d.id = docs_cjk.rowid WHERE d.scope = 'tool'",
  ).get().c);
  assert.equal(toolIndexed, 0, 'tool 档的行不该出现在 CJK 辅助索引里');

  const indexed = Number(index.db.prepare(
    "SELECT count(*) c FROM docs_cjk JOIN docs d ON d.id = docs_cjk.rowid WHERE d.scope <> 'tool'",
  ).get().c);
  assert.ok(indexed > 0, '三档正文必须真的进了索引，否则上一条断言是空转');
});
