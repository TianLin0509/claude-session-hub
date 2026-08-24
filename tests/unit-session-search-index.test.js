'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MAX_KEYS_PER_DOCUMENT,
  MAX_POSTING_ENTRIES,
  SessionSearchIndex,
  indexKeysForTerm,
  normalizeSearchText,
} = require('../core/session-search-index.js');

function source(key, provider, title, docs, extra = {}) {
  return {
    key,
    signature: `sig-${key}`,
    searchable: true,
    session: {
      key, provider, title, updatedAt: extra.updatedAt || Date.now(),
      projectLabel: extra.projectLabel || 'AI HUB',
      cwd: extra.cwd || 'C:\\repo',
      hubSessionId: extra.hubSessionId || key,
      nativeSessionId: extra.nativeSessionId || `${key}-native`,
      meetingId: extra.meetingId || null,
      turnCount: docs.length,
    },
    docs,
  };
}

const fixtures = [
  source('codex:1', 'codex', '修复卡片公式渲染', [
    { id: 't', eventId: 't', scope: 'title', role: 'title', text: '修复卡片公式渲染', ordinal: -1, timestamp: 100 },
    { id: 'u1', eventId: 'u1', scope: 'user', role: 'user', text: '卡片视图为什么不显示公式？', ordinal: 0, timestamp: 101 },
    { id: 'a1', eventId: 'a1', scope: 'assistant', role: 'assistant', text: '根因是 Markdown 流式渲染提前处理了数学块。', ordinal: 1, timestamp: 102 },
  ]),
  source('claude:1', 'claude', 'PTY 路径识别', [
    { id: 't', eventId: 't', scope: 'title', role: 'title', text: 'PTY 路径识别', ordinal: -1, timestamp: 200 },
    { id: 'u2', eventId: 'u2', scope: 'user', role: 'user', text: '请检查 EADDRINUSE 和路径 URL 识别。', ordinal: 0, timestamp: 201 },
    { id: 'a2', eventId: 'a2', scope: 'assistant', role: 'assistant', text: '需要统一 openPathInHub 入口。', ordinal: 1, timestamp: 202 },
  ]),
  source('meeting:1', 'meeting', '卡片渲染专项评审', [
    { id: 't', eventId: 't', scope: 'title', role: 'title', text: '卡片渲染专项评审', ordinal: -1, timestamp: 300 },
    { id: 'm1', eventId: 'm1', scope: 'assistant', role: 'assistant', speaker: 'Claude', text: '群聊结论：公式渲染需要两层 guard。', ordinal: 0, timestamp: 301 },
  ], { meetingId: 'meeting-1' }),
];

test('Chinese and multi-term queries rank title/user/assistant matches by session', () => {
  const index = new SessionSearchIndex(fixtures);
  const result = index.search({ query: '卡片 公式', limit: 10 });
  assert.equal(result.totalSessions, 2);
  assert.equal(result.results[0].sessionKey, 'codex:1');
  assert.equal(result.results[0].bestMatch.scope, 'title');
  assert.equal(result.results[0].matchCount, 2);
  assert.equal(result.facets.providers.codex, 1);
  assert.equal(result.facets.providers.meeting, 1);
});

test('provider and scope filters support Claude-only, meeting-only, title-only and answer-only searches', () => {
  const index = new SessionSearchIndex(fixtures);
  const claude = index.search({ query: '路径', providers: ['claude'] });
  assert.deepEqual(claude.results.map(row => row.provider), ['claude']);

  const meeting = index.search({ query: '公式', providers: ['meeting'], scopes: ['assistant'] });
  assert.equal(meeting.totalSessions, 1);
  assert.equal(meeting.results[0].meetingId, 'meeting-1');

  const title = index.search({ query: '卡片', scopes: ['title'] });
  assert.ok(title.results.every(row => row.bestMatch.scope === 'title'));

  const answer = index.search({ query: 'Markdown', scopes: ['assistant'] });
  assert.equal(answer.totalSessions, 1);
  assert.equal(answer.results[0].provider, 'codex');
});

test('oversized search input is rejected explicitly instead of consuming unbounded index work', () => {
  const index = new SessionSearchIndex(fixtures);
  const result = index.search({ query: 'x'.repeat(513) });
  assert.match(result.error, /最多 512/);
  assert.equal(result.totalSessions, 0);
});

test('preview returns neighboring context and marks the exact stable event', () => {
  const index = new SessionSearchIndex(fixtures);
  const preview = index.preview({ sessionKey: 'codex:1', eventId: 'a1', query: 'Markdown' });
  assert.equal(preview.session.title, '修复卡片公式渲染');
  assert.equal(preview.context.length, 2);
  assert.equal(preview.context[1].eventId, 'a1');
  assert.equal(preview.context[1].isMatch, true);
  const titlePreview = index.preview({ sessionKey: 'codex:1', eventId: 't', query: '卡片' });
  assert.equal(titlePreview.context[0].scope, 'title');
  assert.equal(titlePreview.context[0].isMatch, true);
});

test('incremental source replacement removes stale matches without rebuilding the full index', () => {
  const index = new SessionSearchIndex(fixtures);
  const replacement = source('codex:1', 'codex', '更新后的标题', [
    { id: 't2', eventId: 't2', scope: 'title', role: 'title', text: '更新后的标题', ordinal: -1, timestamp: 400 },
    { id: 'a-new', eventId: 'a-new', scope: 'assistant', role: 'assistant', text: '全新的增量索引答案', ordinal: 0, timestamp: 401 },
  ]);
  const update = index.updateSources([replacement], []);
  assert.equal(update.compacted, false);
  assert.equal(index.search({ query: 'Markdown', providers: ['codex'] }).totalSessions, 0, 'removed source text must not leak through stale postings');
  assert.equal(index.search({ query: '增量索引' }).totalSessions, 1);
  assert.equal(index.getStats().sessions, 3);
  assert.ok(index.getStats().inactiveDocuments >= 3);

  index.updateSources([], ['meeting:1']);
  assert.equal(index.search({ query: '群聊结论' }).totalSessions, 0);
  assert.equal(index.getStats().sessions, 2);
});

test('normalization and n-grams cover CJK, English substrings and Windows paths', () => {
  assert.equal(normalizeSearchText('  ＡI\nHub  '), 'ai hub');
  assert.deepEqual(indexKeysForTerm('公式'), ['c:公式']);
  assert.ok(indexKeysForTerm('renderer').includes('a:ren'));
  assert.ok(indexKeysForTerm('C:\\Repo\\file.js').length > 3);
  const mixed = new SessionSearchIndex([source('mixed:1', 'claude', '混排', [
    { id: 'mixed', eventId: 'mixed', scope: 'assistant', role: 'assistant', text: 'CLAUDE_ANSWER_MARKER：检查中文说明', ordinal: 0, timestamp: 1 },
  ])]);
  assert.equal(mixed.search({ query: 'CLAUDE_ANSWER_MARKER', scopes: ['assistant'] }).totalSessions, 1);
});

test('indexed query remains fast across 20k message documents', { timeout: 10_000 }, () => {
  const sources = [];
  for (let sessionIndex = 0; sessionIndex < 2_000; sessionIndex += 1) {
    const docs = [];
    for (let turn = 0; turn < 10; turn += 1) {
      const marker = sessionIndex === 1_777 && turn === 8 ? ' UNIQUE_EADDRINUSE_MARKER' : '';
      docs.push({
        id: `d-${turn}`, eventId: `d-${turn}`, scope: turn % 2 ? 'assistant' : 'user',
        role: turn % 2 ? 'assistant' : 'user',
        text: `普通历史内容 session ${sessionIndex} turn ${turn}${marker}`,
        ordinal: turn, timestamp: Date.now() - sessionIndex,
      });
    }
    sources.push(source(`perf:${sessionIndex}`, sessionIndex % 2 ? 'codex' : 'claude', `性能会话 ${sessionIndex}`, docs));
  }
  const index = new SessionSearchIndex(sources);
  const started = performance.now();
  const result = index.search({ query: 'EADDRINUSE_MARKER' });
  const elapsed = performance.now() - started;
  assert.equal(result.totalSessions, 1);
  assert.ok(elapsed < 250, `20k-doc query took ${elapsed.toFixed(1)}ms`);
});

test('high-entropy documents keep head and tail searchability within posting budgets', () => {
  let seed = 0x12345678;
  let noise = '';
  for (let index = 0; index < 180_000; index += 1) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    noise += String.fromCharCode(33 + ((seed >>> 0) % 90));
  }
  const index = new SessionSearchIndex([source('guard:1', 'claude', 'Memory guard', [{
    id: 'guard-doc', eventId: 'guard-doc', scope: 'assistant', role: 'assistant',
    text: `HEAD_MEMORY_GUARD_MARKER ${noise} TAIL_MEMORY_GUARD_MARKER`, ordinal: 0, timestamp: 1,
  }])]);
  const stats = index.getStats();
  assert.equal(stats.guardedDocuments, 1);
  assert.ok(stats.postingEntries <= MAX_KEYS_PER_DOCUMENT);
  assert.ok(stats.postingEntries <= MAX_POSTING_ENTRIES);
  assert.equal(index.search({ query: 'HEAD_MEMORY_GUARD_MARKER' }).totalSessions, 1);
  assert.equal(index.search({ query: 'TAIL_MEMORY_GUARD_MARKER' }).totalSessions, 1);
});

test('repeated high-entropy source replacement reclaims posting capacity', () => {
  const makeNoise = iteration => {
    let seed = 0x9e3779b9 ^ iteration;
    let text = '';
    for (let index = 0; index < 90_000; index += 1) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      text += String.fromCharCode(33 + ((seed >>> 0) % 90));
    }
    return text;
  };
  const makeSource = iteration => source('replace:entropy', 'codex', 'Entropy replacement', [{
    id: `doc-${iteration}`, eventId: `doc-${iteration}`, scope: 'assistant', role: 'assistant',
    text: `${makeNoise(iteration)} REPLACEMENT_MARKER_${iteration}`, ordinal: 0, timestamp: iteration + 1,
  }]);
  const index = new SessionSearchIndex([makeSource(0)]);
  for (let iteration = 1; iteration <= 60; iteration += 1) index.updateSources([makeSource(iteration)], []);
  const stats = index.getStats();
  assert.ok(stats.postingEntries <= MAX_KEYS_PER_DOCUMENT);
  assert.ok(stats.postingEntries <= MAX_POSTING_ENTRIES);
  assert.equal(index.search({ query: 'REPLACEMENT_MARKER_60' }).totalSessions, 1);
  assert.equal(index.search({ query: 'REPLACEMENT_MARKER_0' }).totalSessions, 0);
});
