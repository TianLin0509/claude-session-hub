'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { filterSearchEntries, filterSearchHits, loadSearchFacets, FACET_STORAGE_KEY } = require('../renderer/global-session-search');
const { AGENT_SESSION_GROUPS } = require('../renderer/session-list-renderer');
const rows = [
  { hubSessionId: 'study', purpose: 'study-companion', provider: 'codex', archived: true },
  { hubSessionId: 'league', purpose: 'agent-league', provider: 'claude', archived: true },
  { hubSessionId: 'virtual', purpose: 'agent-league-virtual', provider: 'codex', archived: false },
  { hubSessionId: 'fresh', purpose: 'study-companion', provider: 'claude', archived: false },
  { meetingId: 'group', provider: 'meeting', archived: true },
];
test('Agent 定义复用学习与投研，归档和来源与 Agent 取交集', () => {
  assert.deepEqual(AGENT_SESSION_GROUPS.map(g => g.key), ['study', 'league']);
  assert.deepEqual(filterSearchEntries(rows, { scope: 'dormant', agent: 'study' }).map(r => r.hubSessionId), ['study']);
  assert.deepEqual(filterSearchEntries(rows, { agent: 'league' }).map(r => r.hubSessionId), ['league', 'virtual']);
  assert.equal(filterSearchEntries(rows, { scope: 'dormant', agent: 'league', providers: ['codex'] }).length, 0);
});
test('全文合并排除未知及非归档会话，群聊以 meetingId 精确匹配', () => {
  const hits = [...rows, { hubSessionId: 'outside' }];
  assert.deepEqual(filterSearchHits(hits, filterSearchEntries(rows, { scope: 'dormant' })), [rows[0], rows[1], rows[4]]);
});
test('筛选先于结果上限，学习条目排在 700 条普通记录后仍能找到', () => {
  const large = [...Array.from({ length: 712 }, (_, i) => ({ hubSessionId: String(i), archived: true })), rows[0]];
  assert.deepEqual(filterSearchEntries(large, { scope: 'dormant', agent: 'study' }).slice(0, 50), [rows[0]]);
});
test('来源和 Agent 选择可持久化恢复，损坏存储退回全部', () => {
  const storage = new Map([[FACET_STORAGE_KEY, JSON.stringify({ provider: 'codex', agent: 'study' })]]);
  assert.deepEqual(loadSearchFacets({ getItem: k => storage.get(k) }), { provider: 'codex', agent: 'study' });
  assert.deepEqual(loadSearchFacets({ getItem: () => '{' }), { provider: 'all', agent: 'all' });
  assert.deepEqual(loadSearchFacets({ getItem: () => JSON.stringify({ provider: 'bogus', agent: 'bogus' }) }), { provider: 'all', agent: 'all' });
});
test('归档浏览仍遵守时间和项目选择', () => {
  const now = Date.now();
  assert.equal(filterSearchEntries([{ archived: true, projectLabel: 'SuperRAN', updatedAt: now }], { scope: 'dormant', project: 'super', timeRange: '7d', now }).length, 1);
  assert.equal(filterSearchEntries([{ archived: true, updatedAt: now - 8 * 86400000 }], { timeRange: '7d', now }).length, 0);
});
