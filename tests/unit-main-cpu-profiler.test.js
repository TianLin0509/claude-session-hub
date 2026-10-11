'use strict';
// Opt-in main-process profiler (2026-10-11): inert unless HUB_MAIN_CPU_PROFILE
// is set, and main.js only loads it behind that variable.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseMainCpuProfileOptions, startMainCpuProfiler, createSpawnAudit } = require('../core/main-cpu-profiler.js');

function test(name, fn) {
  try { fn(); console.log(`  OK ${name}`); }
  catch (err) { console.error(`  FAIL ${name}`); console.error(err.stack || err.message); process.exitCode = 1; }
}

test('disabled without HUB_MAIN_CPU_PROFILE', () => {
  assert.strictEqual(parseMainCpuProfileOptions({}), null);
  assert.strictEqual(parseMainCpuProfileOptions({ HUB_MAIN_CPU_PROFILE: '0' }), null);
  assert.strictEqual(parseMainCpuProfileOptions({ HUB_MAIN_CPU_PROFILE: 'yes' }), null);
  assert.strictEqual(startMainCpuProfiler({ env: {}, dataDir: 'unused' }), null);
});

test('parses duration, delay, trigger and interval with bounds', () => {
  assert.deepStrictEqual(parseMainCpuProfileOptions({
    HUB_MAIN_CPU_PROFILE: '60', HUB_MAIN_CPU_PROFILE_DELAY: '5',
    HUB_MAIN_CPU_PROFILE_TRIGGER: ' D:/x/trigger ', HUB_MAIN_CPU_PROFILE_INTERVAL_US: '500',
  }), { durationMs: 60000, delayMs: 5000, samplingIntervalUs: 500, triggerPath: 'D:/x/trigger' });
  const capped = parseMainCpuProfileOptions({ HUB_MAIN_CPU_PROFILE: '9999', HUB_MAIN_CPU_PROFILE_INTERVAL_US: '5' });
  assert.strictEqual(capped.durationMs, 600000);
  assert.strictEqual(capped.samplingIntervalUs, 1000);
});

test('main.js loads the profiler only behind the environment variable', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const at = src.indexOf("require('./core/main-cpu-profiler.js')");
  assert.ok(at > 0, 'main.js wires the profiler');
  const guard = src.lastIndexOf('if (process.env.HUB_MAIN_CPU_PROFILE)', at);
  assert.ok(guard > 0 && at - guard < 200, 'the require sits inside the env guard');
});

test('spawn audit passes calls through and records only while started', () => {
  const calls = [];
  const fake = { spawn: (file, args) => { calls.push([file, args]); return 'child'; } };
  const audit = createSpawnAudit({ childProcess: fake });
  assert.strictEqual(fake.spawn('a.exe', ['1']), 'child');
  audit.start();
  assert.strictEqual(fake.spawn('b.exe', ['2']), 'child');
  const records = audit.stop();
  fake.spawn('c.exe', []);
  assert.deepStrictEqual(calls.map(c => c[0]), ['a.exe', 'b.exe', 'c.exe']);
  assert.deepStrictEqual(records.map(r => r.file), ['b.exe']);
});
