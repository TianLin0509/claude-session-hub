'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { SqliteSessionSearchIndex } = require('../core/session-search-sqlite-index');
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

test('真实 SQLite：第 201 条正文命中的归档学习会话仍能通过面板搜索找到', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-search-facet-'));
  const index = new SqliteSessionSearchIndex(path.join(root, 'search.sqlite'));
  t.after(() => { index.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const entries = [];
  const query = 'facetbodyneedle';
  const now = Date.now();
  for (let i = 0; i < 201; i += 1) {
    const key = `indexed-${i}`;
    const session = {
      key, hubSessionId: `hub-${i}`, provider: 'codex', title: `会话 ${i}`,
      updatedAt: now - i * 1000,
    };
    index.replaceSource({ key, signature: key, session, docs: [{
      id: 'answer', scope: 'assistant', role: 'assistant', ordinal: 0,
      text: query, timestamp: session.updatedAt,
    }] });
    entries.push({ ...session, archived: i === 200, purpose: i === 200 ? 'study-companion' : '' });
  }
  const request = { query, sort: 'recent', limit: 50 };
  const unfiltered = index.search({ ...request, limit: 200 });
  assert.equal(unfiltered.totalSessions, 201);
  assert.equal(unfiltered.results.length, 200);
  assert.equal(unfiltered.results.some(hit => hit.hubSessionId === 'hub-200'), false);
  assert.equal(index.search({ query, scopes: ['title'] }).totalSessions, 0, '标题补搜不能掩盖正文漏搜');

  // 执行实际面板查询函数，只替换 DOM 边界和 IPC 传输；查询交给真实 SQLite。
  const source = fs.readFileSync(require.resolve('../renderer/global-session-search'), 'utf8');
  const start = source.indexOf('  async function performSearch(');
  const end = source.indexOf('\n  function previewLabel(', start);
  assert.ok(start >= 0 && end > start);
  let response;
  const context = vm.createContext({
    ...require('../renderer/global-session-search'),
    searchTimer: null, searchSequence: 0, lastTitleHits: [],
    searchRequest: () => request,
    browsingCatalogue: () => true,
    refreshTitleIndex() {},
    catalogueFilter: () => filterSearchEntries(entries, { scope: 'dormant', agent: 'study' }),
    localTitleHits: () => [],
    isOpen: () => true,
    ipcRenderer: { invoke: async (channel, payload) => {
      assert.equal(channel, 'search-past-sessions');
      return index.search(payload);
    } },
    renderResults: value => { response = value; },
    renderSearchError: error => { throw error; },
  });
  await vm.runInContext(`${source.slice(start, end)}\nperformSearch({ immediate: true });`, context);
  assert.equal(response.totalSessions, 1, '归档 + 学习筛选应在全局结果截断之前生效');
  assert.equal(response.results.length, 1);
  assert.equal(response.results[0].hubSessionId, 'hub-200');
  assert.equal(response.results[0].bestMatch.scope, 'assistant');
  assert.equal(response.truncated, false);

  context.catalogueFilter = () => [];
  await vm.runInContext('performSearch({ immediate: true });', context);
  assert.equal(response.totalSessions, 0, '空 facet 不能退回全局搜索');

  context.browsingCatalogue = () => false;
  await vm.runInContext('performSearch({ immediate: true });', context);
  assert.equal(response.totalSessions, 201, '取消 facet 后恢复普通全文查询');
  assert.equal(response.results.length, 50);
});

function memoryIndex(t, options) {
  const index = new SqliteSessionSearchIndex(':memory:', options);
  t.after(() => index.close());
  return index;
}

function addBodySource(index, key, ids, count = 1) {
  const updatedAt = Date.now();
  index.replaceSource({ key, signature: key, session: {
    key, title: `记录 ${key}`, provider: ids.meetingId ? 'meeting' : 'codex', updatedAt, ...ids,
  }, docs: Array.from({ length: count }, (_, ordinal) => ({
    id: `answer-${ordinal}`, scope: 'assistant', role: 'assistant', ordinal,
    text: 'facetbodyneedle 正文', timestamp: updatedAt,
  })) });
}

test('会话范围以稳定 ID 匹配群聊，空集合和未知 ID 不扩大搜索', t => {
  const index = memoryIndex(t);
  addBodySource(index, 'native-source', { hubSessionId: 'hub' });
  addBodySource(index, 'meeting-source', { meetingId: "group'1" });
  const request = { query: 'facetbodyneedle' };
  const meeting = index.search({ ...request, sessionFilter: { meetingIds: ["group'1"] } });
  assert.equal(meeting.totalSessions, 1);
  assert.equal(meeting.results[0].sessionKey, 'meeting-source');
  assert.equal(index.search({ ...request, sessionFilter: {} }).totalSessions, 0);
  assert.equal(index.search({ ...request, sessionFilter: { hubSessionIds: ['unknown'] } }).totalSessions, 0);
  assert.throws(() => index.search({ ...request, sessionFilter: { hubSessionIds: 'hub' } }), /arrays/);
  assert.equal(index.search(request).totalSessions, 2);
});

test('facet 命中超过展示上限时，计数与来源统计基于全部筛选结果', t => {
  const index = memoryIndex(t);
  for (let i = 0; i < 260; i += 1) addBodySource(index, `s-${i}`, { hubSessionId: `hub-${i}` });
  const response = index.search({ query: 'facetbodyneedle', limit: 50,
    sessionFilter: { hubSessionIds: Array.from({ length: 60 }, (_, i) => `hub-${i + 200}`) },
  });
  assert.equal(response.results.length, 50);
  assert.equal(response.totalSessions, 60);
  assert.equal(response.totalMatches, 60);
  assert.deepEqual(response.facets.providers, { codex: 60 });
  assert.equal(response.truncated, true);
  assert.equal(response.truncatedReason, 'result_limit');
});

test('facet 在正文候选预算之前生效，其他会话不能耗尽目标的查询预算', t => {
  const index = memoryIndex(t, { maxQueryDocs: 1000 });
  addBodySource(index, 'noise', { hubSessionId: 'noise' }, 1100);
  addBodySource(index, 'target', { hubSessionId: 'target' });
  const request = { query: 'facetbodyneedle' };
  assert.equal(index.search(request).truncated, true, '确认全局候选达到预算');
  const response = index.search({ ...request, sessionFilter: { hubSessionIds: ['target'] } });
  assert.equal(response.totalSessions, 1);
  assert.equal(response.results[0].hubSessionId, 'target');
  assert.equal(response.truncated, false);
});
