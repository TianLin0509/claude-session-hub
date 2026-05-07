// tests/unit-state-store-concurrent-load.test.js
//
// 2026-05-07 道雪 — 模拟多进程并发对 state.json 高频写入。
// 用 child_process.fork 起 N 个 worker 同时 hammer state-store.save，
// 验证 lock 真的让 N 个进程不互相覆盖。

'use strict';
const { fork } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'state-concurrent-'));

const STATE_STORE_PATH = path.resolve(__dirname, '..', 'core', 'state-store.js').replace(/\\/g, '/');
const TEMP_FOR_JS = TEMP.replace(/\\/g, '/');

const WORKER_SCRIPT = path.join(TEMP, 'worker.js');
const workerSrc = [
  "'use strict';",
  "process.env.CLAUDE_HUB_DATA_DIR = '" + TEMP_FOR_JS + "';",
  "const stateStore = require('" + STATE_STORE_PATH + "');",
  "const workerId = process.argv[2];",
  "const count = parseInt(process.argv[3], 10);",
  "(async () => {",
  "  for (let i = 0; i < count; i++) {",
  "    const hubId = workerId + '-s-' + i;",
  "    stateStore.save({",
  "      version: 1, cleanShutdown: false,",
  "      sessions: [{ hubId, kind: 'claude', title: 'T-' + workerId + '-' + i, updatedAt: Date.now() }],",
  "      meetings: [], immersiveByMeeting: {}, pilotSlotByMeeting: {}, dispatchModeByMeeting: {},",
  "    }, { sync: true });",
  "    await new Promise(r => setImmediate(r));",
  "  }",
  "  process.exit(0);",
  "})();",
].join('\n');
fs.writeFileSync(WORKER_SCRIPT, workerSrc);

(async function run() {
  const NUM_WORKERS = 5;
  const PER_WORKER = 20;
  console.log('spawning ' + NUM_WORKERS + ' workers, each writing ' + PER_WORKER + ' entries...');

  const workers = [];
  for (let i = 0; i < NUM_WORKERS; i++) {
    const w = fork(WORKER_SCRIPT, ['W' + i, String(PER_WORKER)], { stdio: 'inherit' });
    workers.push(new Promise(resolve => w.on('exit', resolve)));
  }
  await Promise.all(workers);

  const state = JSON.parse(fs.readFileSync(path.join(TEMP, 'state.json'), 'utf-8'));
  const ids = new Set(state.sessions.map(s => s.hubId));
  let missing = 0;
  for (let i = 0; i < NUM_WORKERS; i++) {
    for (let j = 0; j < PER_WORKER; j++) {
      const expected = 'W' + i + '-s-' + j;
      if (!ids.has(expected)) {
        console.log('MISSING:', expected);
        missing++;
      }
    }
  }
  console.log('state.json sessions count: ' + state.sessions.length + ' (expected ' + (NUM_WORKERS * PER_WORKER) + ')');
  assert.strictEqual(missing, 0, missing + ' entries lost under concurrent write — lock failed');
  assert.strictEqual(state.sessions.length, NUM_WORKERS * PER_WORKER, 'no extra/duplicate entries');
  console.log('PASS — ' + NUM_WORKERS + ' workers x ' + PER_WORKER + ' writes preserved without loss');
})();
