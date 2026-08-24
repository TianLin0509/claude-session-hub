'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const {
  classifyFileRisk,
  createWorkbenchOperationsService,
  parsePorcelainZ,
  parseStorageMetrics,
  parseUnifiedDiff,
  readRemoteServerStatus,
  requestBody,
} = require('../core/workbench-operations.js');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}
const execFileAsync = promisify(execFile);

test('parses Git status, unified hunks and risk without shelling through strings', () => {
  const status = parsePorcelainZ(' M renderer/home.js\0?? core/new.js\0');
  assert.deepStrictEqual(status.map(item => [item.path, item.untracked]), [
    ['renderer/home.js', false],
    ['core/new.js', true],
  ]);
  const hunks = parseUnifiedDiff('@@ -1,2 +1,2 @@\n-old\n+new\n same\n');
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].lines[0].oldLine, 1);
  assert.equal(hunks[0].lines[1].newLine, 1);
  assert.equal(classifyFileRisk({ path: 'main/ipc/auth.js', additions: 300, deletions: 4 }).level, 'high');
});

test('normalizes common remote storage metric shapes', () => {
  assert.deepStrictEqual(parseStorageMetrics({ metrics: { disk: { total_bytes: 1000, used_bytes: 700, mount: '/' } } }), {
    totalBytes: 1000, usedBytes: 700, freeBytes: null, usagePct: 70, mount: '/',
  });
});

test('remote status distinguishes unconfigured, online and metrics errors', async () => {
  const unconfigured = await readRemoteServerStatus({ aliyunMonitor: {} });
  assert.equal(unconfigured.configured, false);
  const online = await readRemoteServerStatus({
    aliyunMonitor: { enabled: true, label: 'ECS', healthUrl: 'https://ops.example/health' },
  }, {
    request: async () => ({ statusCode: 200, latencyMs: 18, body: { status: 'ok', storage: { totalBytes: 100, usedBytes: 50 } } }),
  });
  assert.equal(online.online, true);
  assert.equal(online.storage.usagePct, 50);
});

test('overview preserves the injected remote request while tracking a scan request', async t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ops-request-shadow-'));
  const repo = path.join(tempRoot, 'repo');
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init']);
  git(repo, ['config', 'user.name', 'Hub Test']);
  git(repo, ['config', 'user.email', 'hub@example.invalid']);
  fs.writeFileSync(path.join(repo, 'app.js'), 'module.exports = 1;\n', 'utf8');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'initial']);
  fs.writeFileSync(path.join(repo, 'app.js'), 'module.exports = 2;\n', 'utf8');
  let requestCalls = 0;
  const service = createWorkbenchOperationsService({
    dataDir: path.join(tempRoot, 'hub-data'),
    getConfig: () => ({ operations: { aliyunMonitor: { enabled: true, healthUrl: 'https://ops.example/health' } } }),
    request: async () => {
      requestCalls += 1;
      return { statusCode: 200, latencyMs: 7, body: { status: 'ok' } };
    },
  });
  const overview = await service.overview({ workspaces: [{ cwd: repo }], force: true });
  assert.equal(requestCalls, 1);
  assert.equal(overview.remote.online, true);
});

test('cross-origin health redirects never receive the configured bearer token', async t => {
  let receivedAuthorization = null;
  const target = http.createServer((request, response) => {
    receivedAuthorization = request.headers.authorization || null;
    response.setHeader('content-type', 'application/json');
    response.end('{"status":"ok"}');
  });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  const redirect = http.createServer((_request, response) => {
    response.statusCode = 302;
    response.setHeader('location', `http://127.0.0.1:${target.address().port}/health`);
    response.end();
  });
  await new Promise(resolve => redirect.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => redirect.close(resolve));
    await new Promise(resolve => target.close(resolve));
  });

  const result = await requestBody(`http://127.0.0.1:${redirect.address().port}/start`, {
    bearerToken: 'must-not-leak',
  });
  assert.equal(result.statusCode, 200);
  assert.equal(receivedAuthorization, null);
});

test('malformed health redirects reject through the request promise', async t => {
  const server = http.createServer((_request, response) => {
    response.statusCode = 302;
    response.setHeader('location', 'http://[');
    response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); });
  await assert.rejects(
    requestBody(`http://127.0.0.1:${server.address().port}/health`),
    /invalid_redirect/,
  );
});

test('overview, review decisions and checkpoints use an isolated Git index', { timeout: 30_000 }, async t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ops-test-'));
  const repo = path.join(tempRoot, 'repo');
  const dataDir = path.join(tempRoot, 'hub-data');
  const restoreRoot = path.join(tempRoot, 'restores');
  fs.mkdirSync(repo, { recursive: true });
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  git(repo, ['init']);
  git(repo, ['config', 'user.name', 'Hub Test']);
  git(repo, ['config', 'user.email', 'hub@example.invalid']);
  fs.writeFileSync(path.join(repo, 'app.js'), 'const value = 1;\n', 'utf8');
  git(repo, ['add', 'app.js']);
  git(repo, ['commit', '-m', 'initial']);
  fs.writeFileSync(path.join(repo, 'app.js'), 'const value = 2;\n', 'utf8');
  fs.mkdirSync(path.join(repo, 'tests'));
  fs.writeFileSync(path.join(repo, 'tests', 'app.test.js'), 'assert(value === 2);\n', 'utf8');

  const service = createWorkbenchOperationsService({
    dataDir,
    getConfig: () => ({
      operations: {
        aliyunMonitor: { enabled: false },
        restoreRoot,
      },
    }),
  });
  const workspaces = [{ cwd: repo, sessionId: 's1', title: '修改 value', kind: 'codex', lastMessageTime: Date.now() }];
  const overview = await service.overview({ workspaces, force: true });
  assert.equal(overview.repos.length, 1);
  assert.equal(overview.summary.files, 2);
  assert.equal(overview.repos[0].testFiles, 1);

  const detail = await service.diff({ repoRoot: repo, filePath: 'app.js' });
  assert.equal(detail.hunks.length, 1);
  const hunkId = detail.hunks[0].id;
  const reviewed = await service.setReviewDecision({
    repoRoot: repo, filePath: 'app.js', hunkId, decision: 'accepted', comment: '行为符合预期',
  });
  assert.equal(reviewed.review.decision, 'accepted');
  const detailAgain = await service.diff({ repoRoot: repo, filePath: 'app.js' });
  assert.equal(detailAgain.hunks[0].review.comment, '行为符合预期');

  assert.equal(git(repo, ['diff', '--cached', '--name-only']), '', 'real index starts clean');
  const checkpointResult = await service.createCheckpoint({ repoRoot: repo, sessions: workspaces, label: 'test checkpoint' });
  assert.equal(checkpointResult.ok, true);
  assert.equal(Object.keys(checkpointResult.checkpoint.reviewDecisions).length, 1);
  assert.equal(git(repo, ['diff', '--cached', '--name-only']), '', 'checkpoint must not touch the real index');
  assert.match(git(repo, ['show', `${checkpointResult.checkpoint.commit}:app.js`]), /value = 2/);
  assert.match(git(repo, ['show', `${checkpointResult.checkpoint.commit}:tests/app.test.js`]), /assert/);

  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', 'formal reviewed change']);
  const provenance = await service.lineProvenance({ repoRoot: repo, filePath: 'app.js', line: 1, sessions: workspaces });
  assert.equal(provenance.contentTrust, 'verified', 'matching tree proves checkpoint content');
  assert.equal(provenance.trust, 'inferred', 'workspace/time hints must not be promoted to verified causality');
  assert.match(provenance.reason, /代码内容已验证.*来源仍标为推断/);
  assert.equal(Object.keys(provenance.reviewDecisions).length, 1);

  const restored = await service.restoreCheckpoint({ checkpointId: checkpointResult.checkpoint.id });
  assert.equal(restored.ok, true);
  assert.equal(fs.existsSync(path.join(restored.destination, 'tests', 'app.test.js')), true);
  assert.notEqual(path.resolve(restored.destination), path.resolve(repo));

  const failingService = createWorkbenchOperationsService({
    dataDir: path.join(tempRoot, 'failing-data'),
    getConfig: () => ({ operations: {} }),
    execFile: async (command, args, options) => {
      if (args[0] === 'status') {
        const error = new Error('fixture timeout');
        error.killed = true;
        throw error;
      }
      return execFileAsync(command, args, options);
    },
  });
  const failedOverview = await failingService.overview({ workspaces, force: true });
  assert.equal(failedOverview.repos.length, 0);
  assert.deepStrictEqual(failedOverview.scanErrors.map(item => item.error), ['git_scan_timeout']);

  const reviewFiles = fs.readdirSync(path.join(dataDir, 'provenance', 'reviews'));
  fs.writeFileSync(path.join(dataDir, 'provenance', 'reviews', reviewFiles[0]), '{broken', 'utf8');
  await assert.rejects(
    service.setReviewDecision({ repoRoot: repo, filePath: 'app.js', hunkId, decision: 'rejected' }),
    /review_state_corrupt/,
    'a corrupt review ledger must stop writes instead of being silently overwritten',
  );
});

test('out-of-order overview scans cannot poison a newer workspace cache key', { timeout: 30_000 }, async t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ops-cache-race-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  function createDirtyRepo(name) {
    const repo = path.join(tempRoot, name);
    fs.mkdirSync(repo, { recursive: true });
    git(repo, ['init']);
    git(repo, ['config', 'user.name', 'Hub Test']);
    git(repo, ['config', 'user.email', 'hub@example.invalid']);
    fs.writeFileSync(path.join(repo, 'app.js'), `module.exports = '${name}-v1';\n`, 'utf8');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'initial']);
    fs.writeFileSync(path.join(repo, 'app.js'), `module.exports = '${name}-v2';\n`, 'utf8');
    return repo;
  }

  const slowRepo = createDirtyRepo('slow-repo');
  const fastRepo = createDirtyRepo('fast-repo');
  const slowKey = path.resolve(slowRepo).toLowerCase();
  const service = createWorkbenchOperationsService({
    dataDir: path.join(tempRoot, 'hub-data'),
    execFile: async (command, args, options) => {
      if (path.resolve(options.cwd).toLowerCase() === slowKey) {
        await new Promise(resolve => setTimeout(resolve, 35));
      }
      return execFileAsync(command, args, options);
    },
  });

  const slowScan = service.overview({ workspaces: [{ cwd: slowRepo }], force: true });
  await new Promise(resolve => setTimeout(resolve, 5));
  const fastResult = await service.overview({ workspaces: [{ cwd: fastRepo }], force: true });
  await slowScan;
  const cachedFastResult = await service.overview({ workspaces: [{ cwd: fastRepo }] });

  assert.equal(path.resolve(fastResult.repos[0].root), path.resolve(fastRepo));
  assert.equal(path.resolve(cachedFastResult.repos[0].root), path.resolve(fastRepo));
});

test('concurrent review decisions remain additive instead of last-writer-wins', { timeout: 30_000 }, async t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ops-review-race-'));
  const repo = path.join(tempRoot, 'repo');
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init']);
  git(repo, ['config', 'user.name', 'Hub Test']);
  git(repo, ['config', 'user.email', 'hub@example.invalid']);
  const files = Array.from({ length: 12 }, (_, index) => `file-${index}.js`);
  for (const file of files) fs.writeFileSync(path.join(repo, file), 'module.exports = 1;\n', 'utf8');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'initial']);
  for (const file of files) fs.writeFileSync(path.join(repo, file), 'module.exports = 2;\n', 'utf8');

  const dataDir = path.join(tempRoot, 'hub-data');
  const services = [
    createWorkbenchOperationsService({ dataDir }),
    createWorkbenchOperationsService({ dataDir }),
  ];
  const details = await Promise.all(files.map(filePath => services[0].diff({ repoRoot: repo, filePath })));
  await Promise.all(details.map((detail, index) => services[index % services.length].setReviewDecision({
    repoRoot: repo,
    filePath: files[index],
    hunkId: detail.hunks[0].id,
    decision: 'accepted',
    comment: `review-${index}`,
  })));
  const reviewed = await Promise.all(files.map(filePath => services[0].diff({ repoRoot: repo, filePath })));
  assert.deepStrictEqual(
    reviewed.map(detail => detail.hunks[0].review && detail.hunks[0].review.comment),
    files.map((_file, index) => `review-${index}`),
  );
});

test('checkpoint omits review decisions whose diff changed after approval', { timeout: 30_000 }, async t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ops-stale-review-'));
  const repo = path.join(tempRoot, 'repo');
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init']);
  git(repo, ['config', 'user.name', 'Hub Test']);
  git(repo, ['config', 'user.email', 'hub@example.invalid']);
  fs.writeFileSync(path.join(repo, 'app.js'), 'module.exports = 1;\n', 'utf8');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'initial']);
  fs.writeFileSync(path.join(repo, 'app.js'), 'module.exports = 2;\n', 'utf8');
  const service = createWorkbenchOperationsService({ dataDir: path.join(tempRoot, 'hub-data') });
  const detail = await service.diff({ repoRoot: repo, filePath: 'app.js' });
  await service.setReviewDecision({
    repoRoot: repo,
    filePath: 'app.js',
    hunkId: detail.hunks[0].id,
    decision: 'accepted',
    comment: 'approved v2',
  });
  fs.writeFileSync(path.join(repo, 'app.js'), 'module.exports = 3;\n', 'utf8');
  const checkpoint = await service.createCheckpoint({ repoRoot: repo, label: 'v3 checkpoint' });
  assert.deepStrictEqual(checkpoint.checkpoint.reviewDecisions, {});
});

test('checkpoint validates reviews against the captured commit, not a later worktree edit', { timeout: 30_000 }, async t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ops-checkpoint-toctou-'));
  const repo = path.join(tempRoot, 'repo');
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init']);
  git(repo, ['config', 'user.name', 'Hub Test']);
  git(repo, ['config', 'user.email', 'hub@example.invalid']);
  fs.writeFileSync(path.join(repo, 'app.js'), 'module.exports = 1;\n', 'utf8');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'initial']);
  fs.writeFileSync(path.join(repo, 'app.js'), 'module.exports = 2;\n', 'utf8');
  let service;
  service = createWorkbenchOperationsService({
    dataDir: path.join(tempRoot, 'hub-data'),
    onCheckpointTreeCaptured: async () => {
      fs.writeFileSync(path.join(repo, 'app.js'), 'module.exports = 3;\n', 'utf8');
      const later = await service.diff({ repoRoot: repo, filePath: 'app.js' });
      await service.setReviewDecision({
        repoRoot: repo,
        filePath: 'app.js',
        hunkId: later.hunks[0].id,
        decision: 'accepted',
        comment: 'approved only after tree capture',
      });
    },
  });
  const checkpoint = await service.createCheckpoint({ repoRoot: repo, label: 'captured v2' });
  assert.match(git(repo, ['show', `${checkpoint.checkpoint.commit}:app.js`]), /2/);
  assert.deepStrictEqual(checkpoint.checkpoint.reviewDecisions, {});
});

test('review rejects a file changed between hunk read and blob capture', { timeout: 30_000 }, async t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ops-review-toctou-'));
  const repo = path.join(tempRoot, 'repo');
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init']);
  git(repo, ['config', 'user.name', 'Hub Test']);
  git(repo, ['config', 'user.email', 'hub@example.invalid']);
  fs.writeFileSync(path.join(repo, 'app.js'), 'module.exports = 1;\n', 'utf8');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'initial']);
  fs.writeFileSync(path.join(repo, 'app.js'), 'module.exports = 2;\n', 'utf8');
  let mutated = false;
  const service = createWorkbenchOperationsService({
    dataDir: path.join(tempRoot, 'hub-data'),
    onReviewDiffCaptured: async () => {
      if (mutated) return;
      mutated = true;
      fs.writeFileSync(path.join(repo, 'app.js'), 'module.exports = 3;\n', 'utf8');
    },
  });
  const detail = await service.diff({ repoRoot: repo, filePath: 'app.js' });
  await assert.rejects(service.setReviewDecision({
    repoRoot: repo,
    filePath: 'app.js',
    hunkId: detail.hunks[0].id,
    decision: 'accepted',
  }), /stale_hunk/);
});
