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

test('a temporarily unavailable meeting root preserves the last searchable transcript',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-search-missing-meeting-'));
  const meetingDir=path.join(root,'meetings'),offline=path.join(root,'meetings-offline');fs.mkdirSync(meetingDir);
  fs.writeFileSync(path.join(meetingDir,'m1.json'),JSON.stringify({id:'m1',title:'Meeting',_timeline:[{sid:'user',idx:0,ts:Date.now(),text:'PRESERVED_MEETING_MARKER'}]}));
  const engine=new SessionSearchEngine({databasePath:path.join(root,'search.sqlite'),claudeRoots:[],codexRoots:[],meetingDir});
  t.after(()=>{engine.close();fs.rmSync(root,{recursive:true,force:true});});
  const snapshot={sessions:[],meetings:[{id:'m1',title:'Meeting'}]};
  await engine.refresh(snapshot,{force:true});
  assert.equal((await engine.search({query:'PRESERVED_MEETING_MARKER'})).totalSessions,1);
  assert.ok([meetingDir,offline].every(p=>path.resolve(p).startsWith(fs.realpathSync(root)+path.sep)));
  fs.renameSync(meetingDir,offline);
  const missing=await engine.refresh(snapshot,{immediate:true});
  assert.equal(missing.phase,'ready_with_errors');assert.match(missing.lastError,/暂不可达/);
  assert.equal((await engine.search({query:'PRESERVED_MEETING_MARKER'})).totalSessions,1);
  fs.renameSync(offline,meetingDir);
  assert.equal((await engine.refresh(snapshot,{immediate:true})).lastError,null);
});

test('storage clipping marks the source stale so the limitation survives restart', () => {
  const limited = clipSource({
    key: 'clip-test', signature: 'sig', searchable: true,
    docs: [{ id: 'long', scope: 'assistant', text: 'x'.repeat(80 * 1024) }],
  }, { maxSourceChars: 64 * 1024, maxDocChars: 64 * 1024 });
  assert.equal(limited.truncated, true);
  assert.equal(limited.source.stale, true);
  assert.equal(limited.chars, 64 * 1024);
});

test('oversized non-streamed transcripts keep a searchable title and persist the visible stale state', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-search-engine-oversized-'));
  const meetingDir = path.join(root, 'meetings');
  const databasePath = path.join(root, 'cache', 'search.sqlite');
  fs.mkdirSync(meetingDir, { recursive: true });
  fs.writeFileSync(path.join(meetingDir, 'big.json'), JSON.stringify({
    id: 'big', title: 'OVERSIZED_TITLE_MARKER',
    _timeline: [{ sid: 'user', idx: 0, ts: Date.now(), text: `UNINDEXED_CONTENT_MARKER ${'x'.repeat(1024 * 1024)}` }],
  }), 'utf8');
  const snapshot = { sessions: [], meetings: [{ id: 'big', title: 'OVERSIZED_TITLE_MARKER' }] };
  let engine = new SessionSearchEngine({
    databasePath, claudeRoots: [], codexRoots: [], meetingDir, maxFileBytes: 1024 * 1024,
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

  engine.close();
  engine = new SessionSearchEngine({ databasePath, claudeRoots: [], codexRoots: [], meetingDir });
  const reopened = engine.status();
  assert.equal(reopened.ready, true);
  assert.equal(reopened.phase, 'ready_with_errors');
  assert.equal(reopened.staleSources, 1);
});

test('oversized Claude transcripts are streamed and fully searchable', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-search-engine-large-claude-'));
  const claudeRoot = path.join(root, '.claude', 'projects');
  const transcriptPath = path.join(claudeRoot, 'C--oversized', 'oversized-session.jsonl');
  const databasePath = path.join(root, 'cache', 'search.sqlite');
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  const line = obj => `${JSON.stringify(obj)}\n`;
  fs.writeFileSync(transcriptPath,
    line({ type: 'user', uuid: 'u1', timestamp: '2026-08-24T10:00:00Z', message: { content: `EARLY_CONTENT_MARKER ${'y'.repeat(1_200_000)}` } })
    + line({ type: 'user', uuid: 'r1', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'z'.repeat(2 * 1024 * 1024) }] } })
    + line({ type: 'user', uuid: 'u2', timestamp: '2026-08-24T10:01:00Z', message: { content: 'LATE_CONTENT_MARKER' } }), 'utf8');
  const snapshot = { sessions: [{
    hubId: 'hub-oversized', kind: 'claude', ccSessionId: 'oversized-session',
    title: 'OVERSIZED_TITLE_MARKER', transcriptPath, cwd: 'C:\\oversized',
  }], meetings: [] };
  const engine = new SessionSearchEngine({
    databasePath, claudeRoots: [claudeRoot], codexRoots: [], meetingDir: path.join(root, 'meetings'),
    maxFileBytes: 1024 * 1024,
  });
  t.after(() => {
    engine.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await engine.refresh(snapshot, { force: true });
  assert.equal((await engine.search({ query: 'EARLY_CONTENT_MARKER' })).totalSessions, 1);
  assert.equal((await engine.search({ query: 'LATE_CONTENT_MARKER' })).totalSessions, 1);
  assert.equal(engine.index.getSourceStates().get('claude:claude:oversized-session').stale, false);
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
  assert.equal((await engine.search({ query: 'CODEX_TOOL_METADATA_MARKER', scopes:['tool'] })).totalSessions, 0);
  assert.ok(engine.index.db.prepare("SELECT count(*) n FROM docs WHERE scope='tool' AND text LIKE '%CODEX_TOOL_METADATA_MARKER%'").get().n > 0,
    '工具调用仍以一行元信息保留，供预览与造梦阅读');
  assert.equal(engine.index.db.prepare(`SELECT count(*) n FROM docs_fts WHERE docs_fts MATCH '"codex_tool_metadata_marker"'`).get().n, 0,
    '工具 doc 不进全文索引');
  assert.ok(engine.index.db.prepare("SELECT max(length(text)) n FROM docs WHERE scope='tool'").get().n <= 120);
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

test('indexing writes a dialogue-only chat log md per session and regenerates it when missing', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-search-engine-transcript-md-'));
  const claudeRoot = path.join(root, '.claude', 'projects');
  const transcriptPath = path.join(claudeRoot, 'C--chat', 'chat-session.jsonl');
  const transcriptDir = path.join(root, 'transcripts');
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  const line = obj => `${JSON.stringify(obj)}\n`;
  fs.writeFileSync(transcriptPath,
    line({ type: 'user', uuid: 'u1', timestamp: '2026-09-17T10:00:00Z', message: { content: '# 看起来像标题的提问\n请帮我看日志' } })
    + line({ type: 'assistant', uuid: 'a1', timestamp: '2026-09-17T10:00:05Z', message: { id: 'm1', role: 'assistant', stop_reason: 'end_turn', content: [
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cat server.log' } },
      { type: 'text', text: '日志里没有异常。' },
    ] } })
    + line({ type: 'user', uuid: 'r1', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'SECRET_TOOL_OUTPUT' }] } }), 'utf8');
  const snapshot = { sessions: [{ hubId: 'hub-chat', kind: 'claude', ccSessionId: 'chat-session', title: '日志排查', transcriptPath, cwd: 'C:\chat' }], meetings: [] };
  const engine = new SessionSearchEngine({ databasePath: path.join(root, 'cache', 'search.sqlite'), claudeRoots: [claudeRoot], codexRoots: [], meetingDir: path.join(root, 'meetings'), transcriptDir });
  t.after(() => { engine.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await engine.refresh(snapshot, { force: true });
  const found = engine.transcriptFor({ hubSessionId: 'hub-chat' });
  assert.equal(found.exists, true);
  assert.ok(found.path.startsWith(transcriptDir));
  const md = fs.readFileSync(found.path, 'utf8');
  assert.match(md, /^# 日志排查/);
  assert.match(md, /## 我 · /);
  assert.match(md, /\# 看起来像标题的提问/);
  assert.match(md, /日志里没有异常。/);
  assert.match(md, /> 工具 · Bash/);
  assert.doesNotMatch(md, /SECRET_TOOL_OUTPUT/);
  fs.unlinkSync(found.path);
  await engine.refresh(snapshot, { immediate: true });
  assert.equal(fs.existsSync(found.path), true);
});
