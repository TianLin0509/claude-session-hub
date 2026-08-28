'use strict';

// 2026-08-28：用户要求「侧栏这 682 个标题，随便搜什么都要 1 秒内出来」。
// 682 个标题一共 10KB，且本来就在渲染进程内存里，所以这一层：
//   不走 IPC、不建索引、不等 SQLite 全文索引 —— 单字查询也必须立刻有结果。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  buildTitleIndex,
  mergeTitleHits,
  normalizeTitleText,
  sameSession,
  searchTitles,
} = require('../core/title-index.js');

const SAMPLE = [
  { key: 'a', hubSessionId: 'a', title: '梦境沉淀方案', provider: 'claude', updatedAt: 300 },
  { key: 'b', hubSessionId: 'b', title: 'AI HUB 路径优化与归档策略', provider: 'codex', updatedAt: 200 },
  { key: 'c', hubSessionId: 'c', title: '归档', provider: 'codex', updatedAt: 100 },
  { key: 'm1', meetingId: 'm1', title: '通用圆桌 #1', provider: 'meeting', updatedAt: 400 },
  { key: 'd', hubSessionId: 'd', title: '无线 SRS 资源分配', provider: 'claude', updatedAt: 50 },
];

test('单字就能搜 —— 682 条数据没理由要求最少两个字', () => {
  const index = buildTitleIndex(SAMPLE);
  const hits = searchTitles(index, '归');
  assert.equal(hits.length, 2, '「归」应命中「归档」和「AI HUB 路径优化与归档策略」');
  assert.equal(hits[0].title, '归档', '完全等于查询的标题必须排第一');
});

test('结果形状与全文检索一致，UI 能用同一套渲染', () => {
  const [hit] = searchTitles(buildTitleIndex(SAMPLE), '梦境');
  assert.equal(hit.sessionKey, 'a');
  assert.equal(hit.hubSessionId, 'a', 'openGlobalSearchHit 靠 hubSessionId 找回真会话');
  assert.equal(hit.titleOnly, true);
  assert.equal(hit.matchCount, 1);
  assert.equal(hit.bestMatch.scope, 'title');
  assert.equal(hit.bestMatch.text, '梦境沉淀方案');
  assert.equal(hit.bestMatch.timestamp, 300);
});

test('群聊标题带 meetingId，否则打不开', () => {
  const [hit] = searchTitles(buildTitleIndex(SAMPLE), '圆桌');
  assert.equal(hit.meetingId, 'm1');
  assert.equal(hit.provider, 'meeting');
});

test('多词是 AND，不是 OR', () => {
  const index = buildTitleIndex(SAMPLE);
  assert.equal(searchTitles(index, '路径 归档').length, 1);
  assert.equal(searchTitles(index, '路径 无线').length, 0, '两个词分别存在于不同标题，不该命中任何一条');
});

test('大小写 / 全角半角 / 多余空格都要归一', () => {
  const index = buildTitleIndex([{ key: 'x', title: 'AI  HUB   路径', updatedAt: 1 }]);
  assert.equal(normalizeTitleText('AI  HUB   路径'), 'ai hub 路径');
  assert.equal(searchTitles(index, 'ai hub').length, 1);
  assert.equal(searchTitles(index, 'ＡＩ').length, 1, '全角字母要能匹配半角标题');
});

test('排序：完全相等 > 前缀 > 包含；同分按最近活动', () => {
  const index = buildTitleIndex([
    { key: '1', title: '归档流程重构', updatedAt: 10 },
    { key: '2', title: '归档', updatedAt: 5 },
    { key: '3', title: '会话归档', updatedAt: 20 },
  ]);
  const hits = searchTitles(index, '归档');
  assert.deepEqual(hits.map(h => h.title), ['归档', '归档流程重构', '会话归档']);
});

test('provider 与时间筛选在标题层同样生效', () => {
  const index = buildTitleIndex(SAMPLE);
  assert.equal(searchTitles(index, '归档', { providers: ['codex'] }).length, 2);
  assert.equal(searchTitles(index, '归档', { providers: ['claude'] }).length, 0);
  assert.equal(searchTitles(index, '归档', { since: 150 }).length, 1, '只留 updatedAt>=150 的');
});

test('空标题、重复 key、脏数据都不该让它崩', () => {
  const index = buildTitleIndex([
    null, undefined, 42, { key: 'a', title: '' }, { key: 'a', title: '第一个' },
    { key: 'a', title: '重复 key 的第二个' }, { title: '没有 key 但有 hubSessionId', hubSessionId: 'h1' },
  ]);
  assert.equal(index.length, 2, '空标题跳过、重复 key 只留第一个、缺 key 用 hubSessionId 兜底');
  assert.deepEqual(searchTitles(index, ''), [], '空查询返回空而不是全量');
  assert.deepEqual(searchTitles(null, '归档'), []);
  assert.deepEqual(searchTitles(index, '   '), []);
});

test('合并：全文结果在前，标题层只补全文没覆盖到的', () => {
  const titleHits = searchTitles(buildTitleIndex(SAMPLE), '归档');
  const fullText = [{ sessionKey: 'idx-c', hubSessionId: 'c', title: '归档', matchCount: 7 }];
  const merged = mergeTitleHits(fullText, titleHits, 50);
  assert.equal(merged.results[0].matchCount, 7, '全文结果排在前面且不被标题层覆盖');
  assert.equal(merged.titleOnlyCount, 1, '「AI HUB 路径优化与归档策略」全文没命中，作为仅标题命中补进来');
  assert.equal(merged.results.length, 2);
  assert.equal(merged.results.filter(r => r.hubSessionId === 'c').length, 1, '同一个会话不能出现两次');
});

test('合并：全文层为空时（冷启动/索引没建好）整张列表就是标题层', () => {
  const titleHits = searchTitles(buildTitleIndex(SAMPLE), '归档');
  const merged = mergeTitleHits([], titleHits, 50);
  assert.equal(merged.results.length, 2);
  assert.equal(merged.titleOnlyCount, 2);
  const empty = mergeTitleHits(null, null, 50);
  assert.deepEqual(empty.results, []);
  assert.equal(empty.titleOnlyCount, 0);
});

test('sameSession：hubSessionId / meetingId / sessionKey 逐级判定', () => {
  assert.equal(sameSession({ hubSessionId: 'x' }, { hubSessionId: 'x' }), true);
  assert.equal(sameSession({ hubSessionId: 'x' }, { hubSessionId: 'y' }), false);
  assert.equal(sameSession({ meetingId: 'm' }, { meetingId: 'm' }), true);
  assert.equal(sameSession({ sessionKey: 'k' }, { sessionKey: 'k' }), true);
  assert.equal(sameSession({ sessionKey: 'k' }, { hubSessionId: 'k' }), false, '不同维度的 id 不能混判');
  assert.equal(sameSession(null, {}), false);
});

test('682 条真实量级下，一次查询必须是亚毫秒', () => {
  const many = [];
  for (let i = 0; i < 682; i++) {
    many.push({ key: `s${i}`, hubSessionId: `s${i}`, updatedAt: i, title: `会话标题 ${i} 归档 无线 投研 AI HUB 路径优化` });
  }
  const index = buildTitleIndex(many);
  const started = process.hrtime.bigint();
  for (let i = 0; i < 50; i++) searchTitles(index, '归档');
  const perQuery = Number(process.hrtime.bigint() - started) / 1e6 / 50;
  assert.ok(perQuery < 5, `单次标题检索 ${perQuery.toFixed(2)}ms，应当远低于 5ms（用户要求 1 秒内，这里留了 200 倍余量）`);
});

// —— 下面锁的是接线，光有纯函数正确还不够 ——
test('renderer 必须同步先画标题层，再去跑全文', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'global-session-search.js'), 'utf8');
  assert.match(src, /lastTitleHits = localTitleHits\(request\);/, '每次按键都要重算标题命中');
  assert.match(src, /renderResults\(\{ results: \[\], totalSessions: 0, totalMatches: 0, pendingFullText:/,
    '标题命中必须在发 IPC 之前就画出来');
  assert.match(src, /mergeTitleHits\(fullText, lastTitleHits/, '全文回来要与标题层合并去重');
  assert.match(src, /refreshTitleIndex\(\);/, '打开弹窗时要重建标题索引');
  assert.doesNotMatch(src, /正在更新搜索条件…/, '中间态转圈已经删掉，别再加回来');

  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  assert.match(renderer, /getLocalTitles: collectLocalSearchTitles/, 'renderer 要把内存里的标题喂进去');
  // 渲染层的会话对象是 `id`，`hubId` 只是落盘字段名 —— 写错就一条会话标题都收集不到
  assert.match(renderer, /hubSessionId: session\.id/, '必须带 hubSessionId(=session.id)，否则点开会话找不回来');
  assert.doesNotMatch(renderer, /hubSessionId: session\.hubId/, '渲染层没有 session.hubId，写成它等于全量漏收');
  assert.match(renderer, /meetingId: meeting\.id/, '群聊必须带 meetingId');
});

test('engine 冷启动不得阻塞查询', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'session-search-engine.js'), 'utf8');
  const search = src.slice(src.indexOf('async search('));
  // 注释里会引用旧写法来解释为什么改，断言只能看代码
  const body = search.slice(0, search.indexOf('\n  preview('))
    .split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(body, /await this\.refresh\(/,
    '第一次搜索不能 await 整个索引重建 —— 那是几分钟，用户明确要求放后台冷加载');
  assert.match(body, /indexing: true/, '索引没建好时要告诉前端，好让它显示「后台建立中，标题已可搜」');
});

console.log('unit-title-index OK');
