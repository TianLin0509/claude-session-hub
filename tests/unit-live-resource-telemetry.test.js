'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLiveResourceTelemetry, networkDelta, rankProcesses } = require('../core/live-resource-telemetry');

test('network rates use elapsed time and reset baseline on adapter changes or counter resets', () => {
  const sample = (at, received, sent, id = 'a') => ({ at, adapters: [{ id, received, sent }] });
  assert.deepEqual(networkDelta(sample(1000, 100, 300), sample(3000, 2100, 800)), { status: 'ok', downloadBps: 1000, uploadBps: 250, windowMs: 2000 });
  assert.equal(networkDelta(null, sample(3000, 1, 1)).status, 'warming');
  assert.equal(networkDelta(sample(1000, 100, 300), sample(3000, 1, 1)).status, 'warming');
  assert.equal(networkDelta(sample(1000, 100, 300), sample(3000, 200, 400, 'b')).status, 'warming');
});

test('Top 3 ranks CPU deltas, normalizes by cores, and excludes unreadable/reused PIDs', () => {
  const row = (pid, cpuMs, memoryBytes, started = '1') => ({ pid, cpuMs, memoryBytes, started, name: `p${pid}` });
  const result = rankProcesses({ windowMs: 1000,
    before: [row(1, 100000, 10), row(2, 0, 20), row(3, 10, 30), row(4, 100, 40)],
    after: [row(1, 100000, 10), row(2, 1000, 20), row(3, null, 30), row(4, 5000, 40, '2')],
  }, 4);
  assert.deepEqual(result.cpu.map(row => [row.pid, row.cpuPct]), [[2, 25], [1, 0]]);
  assert.deepEqual(result.memory.map(row => row.pid), [4, 3, 2]);
  assert.equal(result.unreadableCpuCount, 2);
});

test('concurrent requests share one process sample; failure never returns stale success', async () => {
  let calls = 0; let clock = 10000; let fail = false;
  const telemetry = createLiveResourceTelemetry({ platform: 'win32', now: () => clock, cpuCount: 4, execFile: async () => {
    calls++;
    if (fail) throw new Error('probe failed');
    return { stdout: JSON.stringify({ windowMs: 1000, before: [{ pid: 1, name: 'test', started: 'x', cpuMs: 0 }], after: [{ pid: 1, name: 'test', started: 'x', cpuMs: 100, memoryBytes: 100 }] }) };
  } });
  const results = await Promise.all([telemetry.sampleProcesses(), telemetry.sampleProcesses()]);
  assert.equal(calls, 1); assert.equal(results[0].status, 'ok');
  await telemetry.sampleProcesses(); assert.equal(calls, 1);
  clock += 5001; fail = true;
  assert.equal((await telemetry.sampleProcesses()).status, 'unavailable');
});

test('network cache/coalescing and recovery require a fresh baseline after failure', async () => {
  let clock = 10000; let calls = 0; let fail = false;
  const telemetry = createLiveResourceTelemetry({ platform: 'win32', now: () => clock, execFile: async () => {
    calls++;
    if (fail) throw new Error('network probe failed');
    return { stdout: JSON.stringify({ ids: ['abcd'], at: clock, adapters: [{ id: 'abcd', name: 'Ethernet', received: clock, sent: clock / 2 }] }) };
  } });
  await Promise.all([telemetry.sampleNetwork(), telemetry.sampleNetwork()]); assert.equal(calls, 1);
  clock += 3000; assert.equal((await telemetry.sampleNetwork()).downloadBps, 1000);
  clock += 3000; fail = true; assert.equal((await telemetry.sampleNetwork()).status, 'unavailable');
  clock += 3000; fail = false; assert.equal((await telemetry.sampleNetwork()).status, 'warming');
});
