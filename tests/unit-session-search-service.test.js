'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { sqlitePathForLegacyCache } = require('../core/session-search-config.js');
const { SessionSearchService } = require('../core/session-search-service.js');

function writeClaudeTranscript(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const rows = [
    {
      type: 'user', uuid: 'worker-u1', cwd: 'C:\\worker-repo', timestamp: '2026-08-20T10:00:00Z',
      message: { content: 'Worker 搜索用户问题：EADDRINUSE' },
    },
    {
      type: 'assistant', uuid: 'worker-a1', timestamp: '2026-08-20T10:00:01Z',
      message: { model: 'claude-sonnet', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Worker 回答：检查端口并复用现有服务。' }] },
    },
  ];
  fs.writeFileSync(filePath, rows.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8');
}

class FakeChild extends EventEmitter {
  constructor({ autoRespond = false } = {}) {
    super();
    this.autoRespond = autoRespond;
    this.connected = true;
    this.stderr = new EventEmitter();
    this.sent = [];
  }

  send(message, callback) {
    this.sent.push(message);
    if (typeof callback === 'function') setImmediate(() => callback(null));
    if (message && message.type === 'close') {
      setImmediate(() => {
        this.connected = false;
        this.emit('exit', 0, null);
      });
      return true;
    }
    if (this.autoRespond && message && message.id) {
      const result = message.type === 'search'
        ? {
          results: [], totalSessions: 0, totalMatches: 0, truncated: false,
          facets: { providers: {}, scopes: {}, projects: [] }, queryMs: 1,
        }
        : {};
      setImmediate(() => this.emit('message', { id: message.id, result }));
    }
    return true;
  }

  kill() {
    this.connected = false;
    setImmediate(() => this.emit('exit', 0, null));
    return true;
  }
}

test('parent service stays free of SQLite engine/native-module imports', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'session-search-service.js'), 'utf8');
  assert.doesNotMatch(source, /session-search-engine|node:sqlite/);
  assert.match(source, /session-search-config/);
});

test('child-process service builds, queries, previews and reopens its persistent SQLite index', { timeout: 30_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-session-search-service-'));
  const claudeRoot = path.join(root, '.claude', 'projects');
  const transcriptPath = path.join(claudeRoot, 'C--worker-repo', 'worker-session.jsonl');
  const cachePath = path.join(root, 'hub-data', 'cache', 'session-search-v2.json');
  const databasePath = sqlitePathForLegacyCache(cachePath);
  const meetingDir = path.join(root, 'hub-data', 'meetings');
  fs.mkdirSync(meetingDir, { recursive: true });
  writeClaudeTranscript(transcriptPath);
  const snapshot = { sessions: [{
    hubId: 'hub-worker', kind: 'claude', title: 'Worker 自定义标题',
    ccSessionId: 'worker-session', transcriptPath, cwd: 'C:\\worker-repo',
  }], meetings: [] };

  const service = new SessionSearchService({
    claudeRoots: [claudeRoot], codexRoots: [], meetingDir, cachePath, refreshTtlMs: 5,
  });
  t.after(async () => {
    await service.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  });
  const refreshed = await service.refresh(snapshot, { force: true });
  assert.equal(refreshed.ready, true);
  assert.ok(refreshed.index.documents >= 3);
  assert.equal(refreshed.index.storage, 'sqlite-fts5');
  assert.equal(fs.existsSync(databasePath), true);
  assert.equal(fs.existsSync(cachePath), false);
  assert.equal(fs.existsSync(`${cachePath}.sources`), false);

  const title = await service.search({ query: 'Worker 自定义', scopes: ['title'] }, snapshot);
  assert.equal(title.totalSessions, 1);
  assert.equal(title.results[0].hubSessionId, 'hub-worker');
  const answer = await service.search({ query: '复用现有服务', providers: ['claude'], scopes: ['assistant'] }, snapshot);
  assert.equal(answer.totalSessions, 1);
  const preview = await service.preview({
    sessionKey: answer.results[0].sessionKey,
    eventId: answer.results[0].bestMatch.eventId,
    query: '复用现有服务',
  });
  assert.equal(preview.context.some(item => item.isMatch && /复用现有服务/.test(item.text)), true);

  fs.appendFileSync(transcriptPath, `${JSON.stringify({
    type: 'user', uuid: 'worker-u2', timestamp: '2026-08-20T10:00:02Z', message: { content: '增量刷新问题' },
  })}\n${JSON.stringify({
    type: 'assistant', uuid: 'worker-a2', timestamp: '2026-08-20T10:00:03Z',
    message: { model: 'claude-sonnet', stop_reason: 'end_turn', content: [{ type: 'text', text: 'INCREMENTAL_REFRESH_MARKER 已进入索引' }] },
  })}\n`, 'utf8');
  await new Promise(resolve => setTimeout(resolve, 20));
  const incremental = await service.refresh(snapshot, { force: false });
  assert.equal(incremental.ready, true);
  assert.equal(incremental.parsedSources, 1);
  const incrementalResult = await service.search({ query: 'INCREMENTAL_REFRESH_MARKER' }, snapshot);
  assert.equal(incrementalResult.totalSessions, 1);

  await service.close();
  const cached = new SessionSearchService({
    claudeRoots: [claudeRoot], codexRoots: [], meetingDir, cachePath, refreshTtlMs: 60_000,
  });
  try {
    const cachedResult = await cached.search({ query: 'EADDRINUSE' }, snapshot);
    assert.equal(cachedResult.totalSessions, 1);
    assert.equal(cachedResult.status.ready, true);
    assert.equal(cached.getStats().status.ready, true);
  } finally {
    await cached.close();
  }
});

test('startup prewarm is deferred by default and does not allocate a child process', async () => {
  let childCount = 0;
  const service = new SessionSearchService({
    cachePath: path.join(os.tmpdir(), 'unused-search-v2.json'),
    fork: () => { childCount += 1; return new FakeChild(); },
  });
  try {
    const status = await service.prewarm({ sessions: [], meetings: [] });
    assert.equal(status.phase, 'deferred');
    assert.equal(status.ready, false);
    assert.equal(childCount, 0);
  } finally {
    await service.close();
  }
});

test('explicit startup prewarm launches the isolated child and submits a refresh', async () => {
  const child = new FakeChild({ autoRespond: true });
  const service = new SessionSearchService({
    cachePath: path.join(os.tmpdir(), 'enabled-prewarm-search-v2.json'),
    prewarmEnabled: true,
    fork: () => child,
  });
  try {
    await service.prewarm({ sessions: [], meetings: [] });
    assert.equal(child.sent.some(message => message.type === 'init'), true);
    assert.equal(child.sent.some(message => message.type === 'refresh'), true);
    assert.equal(service.getStats().submitted, 1);
  } finally {
    await service.close();
  }
});

test('search child is lowered to background priority when the platform supports it', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'session-search-service.js'), 'utf8');
  assert.match(source, /PRIORITY_BELOW_NORMAL/);
  assert.match(source, /os\.setPriority\(child\.pid, backgroundPriority\)/);
});

test('production main enables delayed prewarm while isolated Hubs remain opt-in', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(source, /prewarmEnabled:[\s\S]{0,180}HUB_SESSION_SEARCH_PREWARM[\s\S]{0,180}!isIsolatedHub\(\)/);
  assert.match(source, /HUB_SESSION_SEARCH_PREWARM_DELAY_MS[\s\S]{0,100}5_000/);
  assert.match(source, /sessionSearchService\.prewarm\(buildSessionSearchSnapshot\(\)\)/);
  assert.match(source, /session-search-prewarm\.lock/);
  assert.match(source, /acquireLockAsync\(lockPath, \{ retries: 0, staleMs: 30 \* 60 \* 1000 \}\)/);
  assert.match(source, /releaseLockAsync\(lock, lockPath\)/);
});

test('search child receives an isolated V8 heap and bounded indexing inputs', async () => {
  let childPath = null;
  let childOptions = null;
  const child = new FakeChild();
  const service = new SessionSearchService({
    cachePath: path.join(os.tmpdir(), 'captured-search-v2.json'),
    fork: (modulePath, _args, options) => {
      childPath = modulePath;
      childOptions = options;
      return child;
    },
    childMemoryLimitMb: 256,
    maxSources: 50,
    maxFileBytes: 4 * 1024 * 1024,
    maxSourceChars: 2 * 1024 * 1024,
    maxDocChars: 64 * 1024,
  });
  try {
    service._ensureChild();
    assert.match(childPath, /session-search-child\.js$/);
    assert.equal(childOptions.cwd, undefined);
    assert.deepStrictEqual(childOptions.execArgv, ['--max-old-space-size=256']);
    assert.equal(childOptions.env.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(childOptions.serialization, 'advanced');
    assert.deepStrictEqual(childOptions.stdio, ['ignore', 'ignore', 'pipe', 'ipc']);
    const init = child.sent.find(message => message.type === 'init');
    assert.equal(init.options.maxSources, 50);
    assert.equal(init.options.maxFileBytes, 4 * 1024 * 1024);
    assert.equal(init.options.maxSourceChars, 2 * 1024 * 1024);
    assert.equal(init.options.maxDocChars, 64 * 1024);
    assert.equal(init.options.maxCandidateSessions, 1200);
    // 2026-08-28 生产规模压测后从 20000 下调到 6000：这个值同时是「每个词的候选行
    // 上限」和「打分阶段总行数上限」。20000 时常见词（***/not/hub/的）一次要取两万行，
    // 打分 139~316ms、候选查询本身也慢（LIMIT 越小越早停）。实测 150 条真实正文探针
    // 在 4000/6000/10000/14000/20000 各档的召回都是 150/150，而 6000 的 p95 最低。
    assert.equal(init.options.maxQueryDocs, 6_000);
  } finally {
    await service.close();
  }
});

test('child crash rejects only the search request and the service restarts on the next query', async () => {
  const children = [];
  const service = new SessionSearchService({
    cachePath: path.join(os.tmpdir(), 'crash-isolation-search-v2.json'),
    fork: () => {
      const child = new FakeChild({ autoRespond: children.length > 0 });
      children.push(child);
      return child;
    },
  });
  try {
    const firstSearch = service.search({ query: '昨日之我' }, { sessions: [], meetings: [] });
    assert.equal(children.length, 1);
    children[0].stderr.emit('data', Buffer.from('heap limit reached\n'));
    children[0].emit('exit', 134, null);
    await assert.rejects(firstSearch, /heap limit reached/);
    assert.equal(service.getStats().failures, 1);

    const recovered = await service.search({ query: '昨日之我' }, { sessions: [], meetings: [] });
    assert.equal(children.length, 2);
    assert.equal(recovered.totalSessions, 0);
    assert.equal(service.getStats().workerRestarts, 2);
  } finally {
    await service.close();
  }
});

test('a real OS child exit is contained by the parent process', { timeout: 10_000 }, async () => {
  const parentPid = process.pid;
  const service = new SessionSearchService({
    cachePath: path.join(os.tmpdir(), 'real-child-exit-search-v2.json'),
    childPath: path.join(__dirname, 'fixtures', 'session-search-exit-child.js'),
  });
  try {
    await assert.rejects(
      service.search({ query: '隔离退出' }, { sessions: [], meetings: [] }),
      /intentional isolated search child exit/,
    );
    assert.equal(process.pid, parentPid);
    assert.equal(service.getStats().failures, 1);
    assert.equal(service.getStats().status.ready, false);
  } finally {
    await service.close();
  }
});

test('an unresponsive child is terminated after an inactivity timeout', async () => {
  const child = new FakeChild();
  const service = new SessionSearchService({
    cachePath: path.join(os.tmpdir(), 'hung-child-search-v2.json'),
    requestTimeoutMs: 50,
    fork: () => child,
  });
  try {
    await assert.rejects(
      service.search({ query: '无响应' }, { sessions: [], meetings: [] }),
      /did not respond for 50ms/,
    );
    assert.equal(service.getStats().failures, 1);
    assert.equal(service.getStats().pending, 0);
    assert.equal(child.connected, false);
  } finally {
    await service.close();
  }
});
