'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');
const { SessionSearchEngine, clipSource } = require('../core/session-search-engine.js');
const { collectSourceDescriptors } = require('../core/session-search-sources.js');
const { FakeCodexRollout } = require('./helpers/fake-codex-rollout.js');

test('storage clipping marks the source stale so the limitation survives restart', () => {
  const limited = clipSource({
    key: 'clip-test', signature: 'sig', searchable: true,
    docs: [{ id: 'long', scope: 'assistant', text: 'x'.repeat(80 * 1024) }],
  }, { maxSourceChars: 64 * 1024, maxDocChars: 64 * 1024 });
  assert.equal(limited.truncated, true);
  assert.equal(limited.source.stale, true);
  assert.equal(limited.chars, 64 * 1024);
});

test('oversized transcripts keep a searchable title and persist the visible stale state', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-search-engine-oversized-'));
  const claudeRoot = path.join(root, '.claude', 'projects');
  const transcriptPath = path.join(claudeRoot, 'C--oversized', 'oversized-session.jsonl');
  const databasePath = path.join(root, 'cache', 'search.sqlite');
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.writeFileSync(transcriptPath, `${JSON.stringify({
    type: 'user', uuid: 'large-u1', timestamp: '2026-08-24T10:00:00Z',
    message: { content: `UNINDEXED_CONTENT_MARKER ${'x'.repeat(1024 * 1024)}` },
  })}\n`, 'utf8');
  const snapshot = { sessions: [{
    hubId: 'hub-oversized', kind: 'claude', ccSessionId: 'oversized-session',
    title: 'OVERSIZED_TITLE_MARKER', transcriptPath, cwd: 'C:\\oversized',
  }], meetings: [] };
  let engine = new SessionSearchEngine({
    databasePath, claudeRoots: [claudeRoot], codexRoots: [], meetingDir: path.join(root, 'meetings'),
    maxFileBytes: 1024 * 1024,
  });
  t.after(() => {
    engine.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const refreshed = await engine.refresh(snapshot, { force: true });
  assert.equal(refreshed.phase, 'ready_with_errors');
  assert.equal(refreshed.staleSources, 1);
  assert.equal((await engine.search({ query: 'OVERSIZED_TITLE_MARKER' })).totalSessions, 1);
  assert.equal((await engine.search({ query: 'UNINDEXED_CONTENT_MARKER' })).totalSessions, 0);
  assert.equal(engine.index.getSourceStates().get('claude:claude:oversized-session').stale, true);

  engine.close();
  engine = new SessionSearchEngine({ databasePath, claudeRoots: [claudeRoot], codexRoots: [] });
  const reopened = engine.status();
  assert.equal(reopened.ready, true);
  assert.equal(reopened.phase, 'ready_with_errors');
  assert.equal(reopened.staleSources, 1);
});

test('oversized Codex rollouts index complete semantic history while skipping binary output rows', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-search-engine-large-codex-'));
  const codexRoot = path.join(root, '.codex', 'sessions');
  const databasePath = path.join(root, 'cache', 'search.sqlite');
  const meetingDir = path.join(root, 'meetings');
  fs.mkdirSync(meetingDir, { recursive: true });
  const sid = '11111111-2222-7333-8444-555555555555';
  const rollout = new FakeCodexRollout({ sessionsRoot: codexRoot, cwd: 'C:\\large-codex', sid });
  let engine = null;
  t.after(async () => {
    if (engine) engine.close();
    await rollout.cleanup().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  });

  await rollout.start();
  await rollout.writeRaw({
    timestamp: '2026-08-27T04:00:00.000Z',
    type: 'event_msg',
    payload: { type: 'user_message', message: 'CODEX_EARLY_SEMANTIC_MARKER' },
  });
  await rollout.writeRaw({
    timestamp: '2026-08-27T04:00:00.100Z',
    type: 'response_item',
    payload: {
      type: 'custom_tool_call_output',
      output: `data:image/png;base64,CODEX_BINARY_OUTPUT_MARKER${'Z'.repeat(2 * 1024 * 1024)}`,
    },
  });
  await rollout.writeRaw({
    timestamp: '2026-08-27T04:00:00.200Z',
    type: 'response_item',
    payload: { item: { type: 'command_execution', command: 'node CODEX_TOOL_METADATA_MARKER.js', cwd: 'C:\\large-codex' } },
  });
  await rollout.writeRaw({
    timestamp: '2026-08-27T04:00:01.000Z',
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      last_agent_message: `${'meaningful '.repeat(20_000)}CODEX_LATE_SEMANTIC_MARKER`,
    },
  });
  await rollout.close();

  const snapshot = { sessions: [{
    hubId: 'hub-large-codex', kind: 'codex', title: 'Large Codex semantic index',
    codexSid: sid, codexSessionsRoot: codexRoot, transcriptPath: rollout.rolloutPath,
    cwd: 'C:\\large-codex',
  }], meetings: [] };
  engine = new SessionSearchEngine({
    databasePath,
    claudeRoots: [],
    codexRoots: [codexRoot],
    meetingDir,
    maxFileBytes: 1024 * 1024,
    maxSourceChars: 64 * 1024,
    maxDocChars: 16 * 1024,
  });
  const refreshed = await engine.refresh(snapshot, { force: true });
  assert.equal(refreshed.phase, 'ready', JSON.stringify(refreshed));
  assert.equal(refreshed.staleSources, 0);
  assert.equal((await engine.search({ query: 'CODEX_EARLY_SEMANTIC_MARKER' })).totalSessions, 1);
  assert.equal((await engine.search({ query: 'CODEX_LATE_SEMANTIC_MARKER' })).totalSessions, 1);
  assert.equal((await engine.search({ query: 'CODEX_TOOL_METADATA_MARKER' })).totalSessions, 1);
  assert.equal((await engine.search({ query: 'CODEX_BINARY_OUTPUT_MARKER' })).totalSessions, 0);
});

test('a parse failure preserves the last good disk index and recovers on the next rebuild', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-search-engine-stale-'));
  const meetingDir = path.join(root, 'meetings');
  const meetingPath = path.join(meetingDir, 'meeting-1.json');
  const databasePath = path.join(root, 'cache', 'search.sqlite');
  fs.mkdirSync(meetingDir, { recursive: true });
  const meeting = marker => ({
    id: 'meeting-1', title: '可靠索引测试', workspace: 'C:\\meeting',
    _timeline: [{ sid: 'user', idx: 0, ts: Date.now(), text: marker }],
  });
  fs.writeFileSync(meetingPath, JSON.stringify(meeting('OLD_MEETING_MARKER')), 'utf8');
  const snapshot = { sessions: [], meetings: [{ id: 'meeting-1', title: '可靠索引测试', workspace: 'C:\\meeting' }] };
  const engine = new SessionSearchEngine({ databasePath, claudeRoots: [], codexRoots: [], meetingDir, refreshTtlMs: 60_000 });
  t.after(() => {
    engine.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  await engine.refresh(snapshot, { force: true });
  assert.equal((await engine.search({ query: 'OLD_MEETING_MARKER' })).totalSessions, 1);

  fs.writeFileSync(meetingPath, '{"_timeline":[', 'utf8');
  const stale = await engine.refresh(snapshot, { force: true });
  assert.equal(stale.phase, 'ready_with_errors');
  assert.equal(stale.staleSources, 1);
  assert.equal((await engine.search({ query: 'OLD_MEETING_MARKER' })).totalSessions, 1);

  fs.writeFileSync(meetingPath, JSON.stringify(meeting('RECOVERED_MEETING_MARKER')), 'utf8');
  const recovered = await engine.refresh(snapshot, { force: true });
  assert.equal(recovered.phase, 'ready');
  assert.equal(recovered.staleSources, 0);
  assert.equal((await engine.search({ query: 'OLD_MEETING_MARKER' })).totalSessions, 0);
  assert.equal((await engine.search({ query: 'RECOVERED_MEETING_MARKER' })).totalSessions, 1);
});

test('the legacy gzip cache migrates one shard at a time and avoids reparsing unchanged transcripts', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-search-engine-migrate-'));
  const claudeRoot = path.join(root, '.claude', 'projects');
  const transcriptPath = path.join(claudeRoot, 'C--migrate', 'migrate-session.jsonl');
  const cachePath = path.join(root, 'cache', 'session-search-v2.json');
  const shardDir = `${cachePath}.sources`;
  const databasePath = path.join(root, 'cache', 'session-search-v3.sqlite');
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.mkdirSync(shardDir, { recursive: true });
  fs.writeFileSync(transcriptPath, `${JSON.stringify({
    type: 'user', uuid: 'migrate-u1', timestamp: '2026-08-24T10:00:00Z',
    message: { content: '原始 transcript 不含缓存专用词' },
  })}\n`, 'utf8');
  const snapshot = { sessions: [{
    hubId: 'hub-migrate', kind: 'claude', ccSessionId: 'migrate-session',
    title: '迁移测试', transcriptPath, cwd: 'C:\\migrate',
  }], meetings: [] };
  const descriptor = collectSourceDescriptors({ claudeRoots: [claudeRoot], codexRoots: [] }, snapshot).descriptors[0];
  const source = {
    key: descriptor.key, signature: descriptor.signature, searchable: true,
    session: {
      key: descriptor.key, provider: 'claude', nativeFamily: 'claude', kind: 'claude',
      title: '迁移测试', cwd: 'C:\\migrate', projectLabel: 'migrate', model: 'claude-test',
      updatedAt: Date.now(), hubSessionId: 'hub-migrate', nativeSessionId: 'migrate-session',
      meetingId: null, transcriptPath, codexSessionsRoot: null, codexProfile: null, turnCount: 1,
    },
  };
  const fileName = 'legacy-000.json.gz';
  fs.writeFileSync(path.join(shardDir, fileName), zlib.gzipSync(Buffer.from(JSON.stringify({
    source,
    docs: [{ id: 'cached-a1', eventId: 'cached-a1', scope: 'assistant', role: 'assistant', speaker: 'Claude', text: 'LEGACY_CACHE_ONLY_MARKER', ordinal: 0, timestamp: Date.now() }],
  }), 'utf8')));
  fs.writeFileSync(cachePath, JSON.stringify({
    version: 2, savedAt: Date.now(),
    entries: [{ key: descriptor.key, signature: descriptor.signature, stale: false, files: [fileName] }],
  }), 'utf8');

  const engine = new SessionSearchEngine({ databasePath, cachePath, claudeRoots: [claudeRoot], codexRoots: [] });
  t.after(() => {
    engine.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const refreshed = await engine.refresh(snapshot, { force: false });
  assert.equal(refreshed.reusedSources, 1);
  assert.equal(refreshed.parsedSources, 0);
  assert.equal((await engine.search({ query: 'LEGACY_CACHE_ONLY_MARKER' })).totalSessions, 1);
  assert.equal(engine.index.getMeta('legacyCacheMigrationVersion'), 3);
});
