'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');

const {
  expireCodexUsageWindows,
  normalizeCodexRateLimitsResponse,
  readCodexAccountUsage,
  shouldPreferCodexLiveUsage,
} = require('../main/usage/codex-app-server-usage.js');

const normalized = normalizeCodexRateLimitsResponse({
  rateLimits: {
    limitId: 'codex',
    primary: { usedPercent: 7, windowDurationMins: 300, resetsAt: 1783721120 },
    secondary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: 1784307920 },
  },
}, 123456);

assert.deepStrictEqual(normalized, {
  usage5h: { pct: 7, resetsAt: 1783721120000 },
  usage7d: { pct: 1, resetsAt: 1784307920000 },
  limitId: 'codex',
  observedAt: 123456,
  source: 'app-server',
});

const expired = expireCodexUsageWindows({
  usage5h: { pct: 90, resetsAt: 9_000 },
  usage7d: { pct: 40, resetsAt: 9_500 },
  observedAt: 8_000,
  source: 'app-server',
}, 10_000);
assert.deepStrictEqual(expired.usage5h, null);
assert.deepStrictEqual(expired.usage7d, null);
assert.strictEqual(expired.unavailable, true);
assert.strictEqual(shouldPreferCodexLiveUsage(expired, null, 10_000), false,
  'an expired live snapshot must not pin stale percentages when no newer local data exists');

const preferenceNow = 10_000_000;
assert.strictEqual(shouldPreferCodexLiveUsage({
  usage7d: { pct: 9, resetsAt: preferenceNow - 60_000 },
  observedAt: preferenceNow - 300_000,
}, {
  usage7d: { pct: 1, resetsAt: preferenceNow + 7 * 86400 * 1000 },
  observedAt: preferenceNow,
}, preferenceNow), false, 'expired live weekly window must not pin a newer reset window');

assert.strictEqual(shouldPreferCodexLiveUsage({
  usage7d: { pct: 9, resetsAt: preferenceNow + 86400 * 1000 },
  observedAt: preferenceNow - 300_000,
}, {
  usage7d: { pct: 1, resetsAt: preferenceNow + 7 * 86400 * 1000 },
  observedAt: preferenceNow,
}, preferenceNow), true, 'incompatible snapshots must keep non-expired account-scoped live data');

function createFakeProcess(onRequest) {
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.killed = false;
  proc.stdin = new Writable({
    write(chunk, _enc, callback) {
      onRequest(JSON.parse(chunk.toString('utf8').trim()), proc);
      callback();
    },
  });
  proc.kill = () => {
    proc.killed = true;
    proc.emit('exit', 0, null);
  };
  return proc;
}

(async () => {
  const requests = [];
  let spawnCall = null;
  const result = await readCodexAccountUsage({
    home: 'C:\\profiles\\main',
    proxy: 'http://127.0.0.1:7890',
    now: () => 789000,
    timeoutMs: 2000,
    platform: 'win32',
    appData: 'C:\\Users\\tester\\AppData\\Roaming',
    spawnFn(command, args, options) {
      spawnCall = { command, args, options };
      return createFakeProcess((request, proc) => {
        requests.push(request);
        if (request.method === 'initialize') {
          queueMicrotask(() => proc.stdout.write(JSON.stringify({ id: request.id, result: { userAgent: 'test' } }) + '\n'));
        }
        if (request.method === 'account/rateLimits/read') {
          queueMicrotask(() => proc.stdout.write(JSON.stringify({
            id: request.id,
            result: {
              rateLimits: {
                limitId: 'codex',
                primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 2000 },
                secondary: { usedPercent: 3, windowDurationMins: 10080, resetsAt: 3000 },
              },
            },
          }) + '\n'));
        }
      });
    },
  });

  assert.strictEqual(spawnCall.command.toLowerCase().endsWith('cmd.exe'), true);
  assert.ok(spawnCall.args.includes('app-server'));
  assert.strictEqual(spawnCall.options.env.CODEX_HOME, 'C:\\profiles\\main');
  assert.strictEqual(spawnCall.options.env.HTTP_PROXY, 'http://127.0.0.1:7890');
  assert.deepStrictEqual(requests.map(r => r.method), ['initialize', 'account/rateLimits/read']);
  assert.deepStrictEqual(result, {
    usage5h: { pct: 12, resetsAt: 2000000 },
    usage7d: { pct: 3, resetsAt: 3000000 },
    limitId: 'codex',
    observedAt: 789000,
    source: 'app-server',
  });

  let timedOutProcess = null;
  let timedOutTreeKill = null;
  const timeoutKeepAlive = setInterval(() => {}, 50);
  try {
    await assert.rejects(readCodexAccountUsage({
      timeoutMs: 500,
      platform: 'win32',
      spawnFn() {
        timedOutProcess = createFakeProcess(() => {});
        timedOutProcess.pid = 43210;
        return timedOutProcess;
      },
      killTreeFn(proc) {
        timedOutTreeKill = proc;
        proc.kill();
      },
    }), /超时/);
  } finally {
    clearInterval(timeoutKeepAlive);
  }
  assert.strictEqual(timedOutTreeKill, timedOutProcess,
    'timeout must terminate the owned app-server process tree');

  let brokenPipeTreeKill = null;
  await assert.rejects(readCodexAccountUsage({
    timeoutMs: 2000,
    platform: 'win32',
    spawnFn() {
      return createFakeProcess((request, proc) => {
        if (request.method === 'initialize') {
          queueMicrotask(() => proc.stdin.emit('error', new Error('broken pipe')));
        }
      });
    },
    killTreeFn(proc) {
      brokenPipeTreeKill = proc;
      proc.kill();
    },
  }), /broken pipe/);
  assert.ok(brokenPipeTreeKill, 'stdin errors must be handled and clean up the owned process tree');

  console.log('unit-codex-app-server-usage OK');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
