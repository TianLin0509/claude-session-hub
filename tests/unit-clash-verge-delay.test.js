'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createClashVergeDelayReader, latestDelay, selectedNode } = require('../core/clash-verge-delay');

const measuredAt = Date.parse('2026-10-01T10:00:00Z');
const proxies = {
  '🚀 节点选择': { type: 'Selector', now: '自动选择' },
  '自动选择': { type: 'URLTest', now: '美国 A' },
  '美国 A': { type: 'Vless', history: [{ delay: 150, time: '2026-10-01T10:00:00Z' }] },
};

test('follows the selected proxy group and ignores stale measurements', () => {
  assert.deepEqual(latestDelay(selectedNode(proxies), measuredAt + 1_000), {
    delayMs: 150, measuredAt, nodeName: '美国 A',
  });
  assert.equal(latestDelay(selectedNode(proxies), measuredAt + 3_600_001), null);
  assert.equal(latestDelay({ name:'美国 A', value:{ history:[...proxies['美国 A'].history,
    { delay:0, time:'2026-10-01T10:00:01Z' }] } }, measuredAt + 2_000), null);
  assert.equal(selectedNode({ ...proxies, '自动选择': { type: 'URLTest', now: '🚀 节点选择' } }), null);
  assert.equal(selectedNode({ ...proxies, '自动选择': { type: 'URLTest', now: 'DIRECT' },
    DIRECT: { type: 'Direct', history: [{ delay: 100, time: '2026-10-01T10:00:00Z' }] } }), null);
});

test('reads the local Clash pipe once per cache period without exposing credentials', async () => {
  let calls = 0;
  const http = { request(options, onResponse) {
    calls += 1;
    assert.equal(options.socketPath, '\\\\.\\pipe\\verge-mihomo-test');
    assert.equal(options.headers.Authorization, 'Bearer hidden-secret');
    const request = new EventEmitter();
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = 200;
      onResponse(response);
      process.nextTick(() => { response.emit('data', JSON.stringify({ proxies })); response.emit('end'); });
    };
    return request;
  } };
  const reader = createClashVergeDelayReader({
    readFile: async () => 'external-controller-pipe: \\\\.\\pipe\\verge-mihomo-test\nsecret: hidden-secret\n',
    http, now: () => measuredAt + 1_000,
  });
  const first = await reader.sample();
  const second = await reader.sample();
  assert.equal(first.delayMs, 150);
  assert.deepEqual(second, first);
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(first).includes('hidden-secret'), false);
});

test('does not connect to a non-local controller', async () => {
  const reader = createClashVergeDelayReader({
    readFile: async () => 'external-controller-pipe: http://example.test\nsecret: hidden-secret\n',
    http: { request() { throw new Error('must not connect'); } },
  });
  assert.deepEqual(await reader.sample(), { status: 'unavailable' });
});

test('falls back to the live verge-mihomo pipe when the config names a stale one', async () => {
  const tried = [];
  const http = { request(options, onResponse) {
    tried.push(options.socketPath);
    const request = new EventEmitter();
    request.end = () => {
      if (options.socketPath.endsWith('sidecar-old')) { process.nextTick(() => request.emit('error', new Error('ENOENT'))); return; }
      const response = new EventEmitter();
      response.statusCode = 200;
      onResponse(response);
      process.nextTick(() => { response.emit('data', JSON.stringify({ proxies })); response.emit('end'); });
    };
    return request;
  } };
  const reader = createClashVergeDelayReader({
    readFile: async () => 'external-controller-pipe: \\\\.\\pipe\\verge-mihomo-sidecar-old\n',
    listPipes: () => ['\\\\.\\pipe\\verge-mihomo-production-new'],
    http, now: () => measuredAt + 1_000,
  });
  const value = await reader.sample();
  assert.equal(value.delayMs, 150);
  assert.deepEqual(tried, ['\\\\.\\pipe\\verge-mihomo-sidecar-old', '\\\\.\\pipe\\verge-mihomo-production-new']);
});

test('pipe candidates only include local verge-mihomo pipes', () => {
  const { controllerPipeCandidates } = require('../core/clash-verge-delay');
  assert.deepEqual(controllerPipeCandidates('external-controller-pipe: http://example.test\n', () => ['\\\\.\\pipe\\verge-mihomo-a']),
    ['\\\\.\\pipe\\verge-mihomo-a']);
});
