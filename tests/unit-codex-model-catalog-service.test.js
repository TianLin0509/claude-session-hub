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

test('catalog service caches live model/list and exposes dynamic options', async () => {
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
  const first = await service.getCatalog();
  const second = await service.getCatalog();
  assert.equal(first.source, 'codex-app-server');
  assert.deepEqual(first.models.map(model => model.id), ['gpt-5.6-terra']);
  assert.equal(second.cached, true);
  assert.equal(calls, 1);
  await service.getCatalog({ home: 'C:\\profiles\\second' });
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
    const result = await service.getCatalog({ home });
    assert.equal(result.source, 'codex-models-cache');
    assert.match(result.refreshError, /controlled app-server outage/);
    assert.deepEqual(result.models.map(model => model.id), ['gpt-5.6-luna']);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
