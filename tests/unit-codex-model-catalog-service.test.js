'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createCodexModelCatalogService,
  readCodexModelList,
} = require('../main/codex-model-catalog-service.js');

function fakeAppServer() {
  const proc = new EventEmitter();
  proc.pid = 12345;
  proc.killed = false;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = new EventEmitter();
  proc.stdin.write = (chunk, callback) => {
    const request = JSON.parse(String(chunk).trim());
    queueMicrotask(() => {
      if (request.method === 'initialize') {
        proc.stdout.emit('data', Buffer.from(JSON.stringify({ id: request.id, result: {} }) + '\n'));
      } else if (request.method === 'model/list') {
        proc.stdout.emit('data', Buffer.from(JSON.stringify({
          id: request.id,
          result: { data: [{
            id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol',
            description: 'Current model', hidden: false, isDefault: true,
            defaultReasoningEffort: 'low',
            supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Fast' }],
          }] },
        }) + '\n'));
      }
    });
    callback?.();
  };
  proc.stdin.end = () => {};
  proc.kill = () => { proc.killed = true; };
  return proc;
}

test('app-server client performs initialize then model/list', async () => {
  const proc = fakeAppServer();
  const models = await readCodexModelList({
    platform: 'linux',
    codexCommand: 'codex',
    spawnFn: () => proc,
    killTreeFn: () => { proc.killed = true; },
    timeoutMs: 1000,
  });
  assert.deepEqual(models.map(model => model.id), ['gpt-5.6-sol']);
});

function isolatedHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-catalog-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test('catalog service caches live model/list and exposes dynamic options', async (t) => {
  const home = isolatedHome(t);
  let calls = 0;
  const service = createCodexModelCatalogService({
    ttlMs: 60_000,
    readLive: async () => {
      calls += 1;
      return [{
        id: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', description: 'Balanced',
        hidden: false, isDefault: true, defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }],
      }];
    },
  });
  const first = await service.getCatalog({ home });
  const second = await service.getCatalog({ home });
  assert.equal(first.source, 'codex-app-server');
  assert.deepEqual(first.models.map(model => model.id), ['gpt-5.6-terra']);
  assert.equal(second.cached, true);
  assert.equal(calls, 1);
  await service.getCatalog({ home: isolatedHome(t) });
  assert.equal(calls, 2, 'different Codex profiles must not share one account catalog cache entry');
});

test('live refresh failure is explicit and falls back to the latest CLI cache', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-codex-catalog-fallback-'));
  try {
    fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({ models: [{
      slug: 'gpt-5.6-luna', display_name: 'GPT-5.6 Luna', visibility: 'list',
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }],
    }] }), 'utf8');
    const service = createCodexModelCatalogService({
      readLive: async () => { throw new Error('controlled app-server outage'); },
    });
    const result = await service.getCatalog({ home, force: true });
    assert.equal(result.source, 'codex-models-cache');
    assert.match(result.refreshError, /controlled app-server outage/);
    assert.deepEqual(result.models.map(model => model.id), ['gpt-5.6-luna']);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('an expired catalog answers at once and refreshes behind the caller', async (t) => {
  const home = isolatedHome(t);
  let calls = 0;
  let clock = 1_000_000;
  let release;
  const service = createCodexModelCatalogService({
    ttlMs: 60_000,
    now: () => clock,
    readLive: async () => {
      calls += 1;
      if (calls === 2) await new Promise(resolve => { release = resolve; });
      return [{ id: calls === 1 ? 'gpt-old' : 'gpt-new', displayName: 'X', hidden: false, isDefault: true,
        defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }];
    },
  });
  await service.getCatalog({ home });
  clock += 60_001;
  const stale = await service.getCatalog({ home });
  assert.equal(stale.stale, true, 'expired list is returned without waiting for the CLI');
  assert.deepEqual(stale.models.map(model => model.id), ['gpt-old']);
  assert.equal(calls, 2, 'one background refresh started');
  await service.getCatalog({ home });
  assert.equal(calls, 2, 'a second caller does not start another refresh');
  release();
  await new Promise(resolve => setImmediate(resolve));
  const fresh = await service.getCatalog({ home });
  assert.deepEqual(fresh.models.map(model => model.id), ['gpt-new']);
  assert.equal(fresh.stale, undefined);
  const forced = service.getCatalog({ home, force: true });
  assert.equal(calls, 3, 'force still waits for a live answer');
  await forced;
});

test('first launch uses the same profile disk catalog while one live refresh is pending', async (t) => {
  const home = isolatedHome(t);
  fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({ models: [{
    slug: 'gpt-6-astra', display_name: 'Astra',
    supported_reasoning_levels: [{ effort: 'high' }, { effort: 'ultra' }],
    additional_speed_tiers: ['fast'],
  }] }));
  let release, calls = 0;
  const service = createCodexModelCatalogService({ readLive: () => {
    calls++;
    return new Promise(resolve => { release = resolve; });
  } });
  const started = Date.now();
  let answered = false;
  const pending = service.getCatalog({ home }).then(value => { answered = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  // Release even on a red baseline so the test leaves no unfinished refresh.
  if (!answered) release([{ id: 'gpt-6-sol', displayName: 'Sol' }]);
  assert.equal(answered, true, 'a populated CLI cache must not wait for app-server on the first click');
  const initial = await pending;
  console.log('cold disk catalog latency ms:', Date.now() - started);
  assert.equal(initial.source, 'codex-models-cache');
  assert.equal(initial.refreshing, true);
  assert.deepEqual(initial.byModel['gpt-6-astra'].efforts, ['high', 'ultra']);
  assert.equal(initial.byModel['gpt-6-astra'].supportsFast, true);
  assert.equal((await service.getCatalog({ home })).refreshing, true);
  assert.equal(calls, 1);
  let forcedAnswered = false;
  const forced = service.getCatalog({ home, force: true }).then(value => { forcedAnswered = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(forcedAnswered, false, 'explicit refresh still waits for its live result');
  release([{ id: 'gpt-6-sol', displayName: 'Sol' }]);
  await forced;
  const fresh = await service.getCatalog({ home });
  assert.equal(fresh.refreshing, undefined);
  assert.deepEqual(fresh.models.map(model => model.id), ['gpt-6-sol']);
});

test('a profile without a usable disk catalog still waits for its own live result', async (t) => {
  for (const cache of [null, '{broken', JSON.stringify({ models: [] })]) {
    const home = isolatedHome(t);
    if (cache !== null) fs.writeFileSync(path.join(home, 'models_cache.json'), cache);
    let release, answered = false;
    const service = createCodexModelCatalogService({ readLive: () => new Promise(resolve => { release = resolve; }) });
    const pending = service.getCatalog({ home }).then(value => { answered = true; return value; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(answered, false);
    release([{ id: 'gpt-6-sol', displayName: 'Sol' }]);
    assert.equal((await pending).source, 'codex-app-server');
  }
});
