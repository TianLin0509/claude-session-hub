'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  createSystemTelemetry,
  parseNvidiaCsv,
} = require('../core/system-telemetry.js');

test('parses nvidia-smi utilization, VRAM and temperature', () => {
  assert.deepStrictEqual(parseNvidiaCsv('NVIDIA RTX 3080, 37, 2048, 10240, 55\r\n'), {
    name: 'NVIDIA RTX 3080',
    usagePct: 37,
    memoryUsedBytes: 2048 * 1024 * 1024,
    memoryTotalBytes: 10240 * 1024 * 1024,
    temperatureC: 55,
    source: 'nvidia-smi',
  });
});

test('extended telemetry caches GPU and disk probes', async () => {
  let execCalls = 0;
  let diskCalls = 0;
  let clock = 1000;
  const telemetry = createSystemTelemetry({
    now: () => clock,
    cwd: () => 'C:\\repo',
    execFile: async () => {
      execCalls += 1;
      return { stdout: 'GPU, 20, 100, 1000, 40' };
    },
    statfs: async () => {
      diskCalls += 1;
      return { bsize: 10, blocks: 100, bavail: 25 };
    },
  });
  const first = await telemetry.sample();
  clock += 500;
  const second = await telemetry.sample();
  assert.equal(first.gpu.usagePct, 20);
  assert.equal(first.disk.usagePct, 75);
  assert.equal(second.disk.usagePct, 75);
  assert.equal(execCalls, 1);
  assert.equal(diskCalls, 1);
});
