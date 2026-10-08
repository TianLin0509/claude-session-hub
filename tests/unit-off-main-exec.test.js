'use strict';
// Telemetry programs (nvidia-smi, netstat, tasklist) must not be created on the
// main thread: on Windows process creation blocks the caller, and on the live
// Hub one spawn held every click for 751 ms (2026-10-08).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createOffMainExecFile } = require('../core/off-main-exec.js');
const { createSystemTelemetry } = require('../core/system-telemetry.js');

const node = process.execPath;

test('output, errors and options match execFile on the main thread', async () => {
  const offMain = createOffMainExecFile();
  const script = 'process.stdout.write("中文 ok\\n"+process.argv[1]);process.stderr.write("warn")';
  const expected = await promisify(execFile)(node, ['-e', script, 'arg 1'], { windowsHide: true });
  const actual = await offMain(node, ['-e', script, 'arg 1'], { windowsHide: true });
  assert.equal(actual.stdout, expected.stdout);
  assert.equal(actual.stderr, expected.stderr);
  await assert.rejects(offMain(node, ['-e', 'process.exit(3)'], { windowsHide: true }), error => error.code === 3);
  await assert.rejects(offMain(node, ['-e', 'setTimeout(()=>{},5000)'], { windowsHide: true, timeout: 200 }), error => error.killed === true);
  await assert.rejects(offMain('definitely-not-a-program-hub', [], { windowsHide: true }), error => error.code === 'ENOENT');
});

test('spawning from the worker keeps the main event loop responsive', async () => {
  const offMain = createOffMainExecFile();
  await offMain(node, ['-e', '0'], { windowsHide: true });
  let maxGap = 0, last = performance.now();
  const timer = setInterval(() => { const t = performance.now(); maxGap = Math.max(maxGap, t - last); last = t; }, 5);
  // Spawn only (process creation), many times in a row; each one blocks the
  // calling thread for a few ms even on an idle machine.
  await Promise.all(Array.from({ length: 12 }, () => offMain(node, ['-e', '0'], { windowsHide: true })));
  clearInterval(timer);
  assert.ok(maxGap < 250, `main thread was blocked for ${Math.round(maxGap)} ms`);
});

test('system telemetry uses the worker by default and still accepts an injected execFile', async () => {
  const calls = [];
  const telemetry = createSystemTelemetry({ execFile: async (file, args) => { calls.push(file); return { stdout: 'RTX, 7, 100, 200, 50\n' }; },
    statfs: async () => ({ bsize: 1, blocks: 10, bavail: 5 }) });
  const sample = await telemetry.sample();
  assert.deepEqual(calls, ['nvidia-smi']);
  assert.equal(sample.gpu.usagePct, 7);
  assert.equal(sample.disk.usagePct, 50);
});
