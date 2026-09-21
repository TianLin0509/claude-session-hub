'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SqliteSessionSearchIndex } = require('../core/session-search-sqlite-index');
const { buildTitleIndex, searchTitles } = require('../core/title-index');
const { filterSearchEntries, loadSearchFacets } = require('../renderer/global-session-search');

const providers = ['codex', 'claude', 'meeting', 'deepseek', 'kimi', 'gemini', 'future-model', 'unknown'];
const others = providers.slice(3);
const entries = providers.map((provider, i) => ({ key: provider, hubSessionId: provider,
  provider, title: '检索样本', archived: true, purpose: 'study-companion', updatedAt: Date.now() - i * 1000 }));

test('其他覆盖未知与未来来源，标题、归档、Agent 筛选使用同一集合', () => {
  assert.deepEqual(filterSearchEntries(entries, { providers: ['other'], scope: 'dormant', agent: 'study' }).map(e => e.provider), others);
  assert.deepEqual(new Set(searchTitles(buildTitleIndex(entries), '检索样本', { providers: ['other'] }).map(e => e.provider)), new Set(others));
  assert.deepEqual(loadSearchFacets({ getItem: () => JSON.stringify({ provider: 'other', agent: 'study' }) }), { provider: 'other', agent: 'study' });
});

test('SQLite：其他在候选预算之前生效，并保留分页、真实来源和空查询语义', t => {
  const index = new SqliteSessionSearchIndex(':memory:', { maxQueryDocs: 1000 });
  t.after(() => index.close());
  for (const entry of entries) {
    index.replaceSource({ key: entry.key, signature: entry.key, session: entry,
      docs: Array.from({ length: entry.provider === 'claude' ? 1100 : 1 }, (_, i) => ({
        id: `a${i}`, role: 'assistant', scope: 'assistant', ordinal: i,
        text: 'needle 搜索正文', timestamp: entry.updatedAt,
      })) });
  }
  const request = { query: 'needle', providers: ['other'], sort: 'conversationTime', limit: 2 };
  let response = index.search(request);
  assert.equal(response.totalSessions, others.length);
  assert.equal(response.state, 'complete');
  assert.deepEqual(response.facets.providers, Object.fromEntries(others.map(p => [p, 1])));
  const found = [...response.results];
  while (response.nextPageCursor) {
    response = index.search({ ...request, cursor: response.nextPageCursor });
    assert.notEqual(response.state, 'error', response.error);
    found.push(...response.results);
  }
  assert.deepEqual(found.map(e => e.provider), others);
  assert.equal(index.search({ providers: ['other'] }).totalSessions, others.length);
  assert.equal(index.search({ query: 'absent', providers: ['other'] }).totalSessions, 0);
  assert.equal(index.search({ providers: ['codex'] }).totalSessions, 1);
  assert.equal(index.search({ providers: ['meeting'] }).totalSessions, 1);
  assert.equal(index.search({ providers: ['other', 'codex'] }).totalSessions, others.length + 1);
});
