'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), fsp = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { createReconnectBackoff } = require('../core/reconnect-backoff');
const { createBrokerUpgrade } = require('../core/broker-upgrade');
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(check) { const end = Date.now() + 5000; while (!check()) { if (Date.now() > end) throw Error('condition timed out'); await delay(15); } }
test('short successful connections retain backoff; stable recovery resets it', () => {
  let at = 0; const backoff = createReconnectBackoff({ now: () => at, random: () => 0 });
  for (const expected of [250, 500, 1000, 2000, 4000, 8000, 15000, 15000]) {
    backoff.connected(); at += 20; assert.equal(backoff.disconnected(), expected);
  }
  backoff.connected(); at += 30000; assert.equal(backoff.disconnected(), 250);
});
test('upgrade waits for idle, pending commands and confirmed writer exit', async () => {
  let busy = true, kills = 0, ready = 0;
  const session = new EventEmitter(); session.kill = () => { kills++; };
  const record = { session, pendingCommands: 0, canTransfer: () => ({ ok: !busy }) };
  const broker = { records: new Map([['one', record]]), draining: false };
  const upgrade = createBrokerUpgrade({ broker, build: { version: '1.0.0', fingerprint: 'a' }, onReady: () => ready++ });
  upgrade.request({ version: '1.1.0', fingerprint: 'b' }); await delay(15); assert.equal(kills, 0);
  busy = false; record.pendingCommands = 1; upgrade.check(); await delay(15); assert.equal(kills, 0);
  record.pendingCommands = 0; upgrade.check(); await until(() => kills === 1);
  assert.equal(ready, 0); assert.equal(broker.draining, true);
  session.emit('exit', { exitCode: 0 }); await until(() => ready === 1);
  assert.equal(broker.records.size, 0);
});
test('an old window cannot downgrade a newer broker', async () => {
  const broker = { records: new Map(), draining: false };
  const upgrade = createBrokerUpgrade({ broker, build: { version: '1.2.0', fingerprint: 'b' }, onReady: () => assert.fail('must not downgrade') });
  assert.equal(upgrade.request({ version: '1.1.0', fingerprint: 'a' }), null);
  await delay(15); assert.equal(broker.draining, false);
});
test('paused file workflows scan once per explicit tick, without duplicate status reads', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hub-idle-engine-'));
  const meetings = Array.from({ length: 9 }, (_, i) => ({ id: String(i), groupChat: true, serialWorkflow: { fileFlowVersion: 2, fileFlow: { paused: true } } }));
  for (const m of meetings) await fsp.mkdir(path.join(root, 'task-docs', m.id), { recursive: true });
  let scans = 0; const original = fs.readdirSync;
  fs.readdirSync = function (dir, ...args) { if (String(dir).startsWith(root)) scans++; return original.call(this, dir, ...args); };
  const engine = require('../main/groupchat/dev-file-engine').createDevFileEngine({
    meetingManager: { getAllMeetings: () => meetings, getMeeting: id => meetings.find(m => m.id === id) },
    getHubDataDir: () => root, getDispatcher: () => { throw Error('paused task must not dispatch'); },
  });
  try { engine.tick(); assert.equal(scans, 9); engine.start(); const before = scans; await delay(1100); assert.equal(scans, before); }
  finally { engine.dispose(); fs.readdirSync = original; await fsp.rm(root, { recursive: true, force: true }); }
});
test('unchanged task does not reread each runtime tick; atomic file replacement refreshes it', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hub-idle-reader-'));
  const meeting = { id: 'one', groupChat: true, serialWorkflow: { fileFlowVersion: 2, soloDevelopment: true } };
  const dir = path.join(root, 'task-docs', 'one'); await fsp.mkdir(dir, { recursive: true });
  let reads = 0;
  const reader = require('../main/groupchat/dev-task-reader').createTaskReader({
    getMeetings: () => [meeting], getMeeting: () => meeting, getHubDataDir: () => root,
    onChanged() {}, interval: 30, read: async () => { reads++; return { name: '', record: null }; },
  });
  try {
    reader.reconcile(); await until(() => reader._test.cache.has('one')); const before = reads;
    await delay(180); assert.equal(reads, before, 'idle runtime ticks must reuse the file result');
    await fsp.writeFile(path.join(dir, 'record.tmp'), 'changed'); await fsp.rename(path.join(dir, 'record.tmp'), path.join(dir, '任务记录.md'));
    await until(() => reads > before);
  } finally { reader.dispose(); await fsp.rm(root, { recursive: true, force: true }); }
});
test('unchanged Git proof starts no processes; target branch changes invalidate it', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hub-merge-proof-'));
  const dir = path.join(root, '.git', 'refs', 'heads'); await fsp.mkdir(dir, { recursive: true });
  const one = 'a'.repeat(40), two = 'b'.repeat(40), merge = { candidate: one, commit: one, target: 'refs/heads/master' };
  await fsp.writeFile(path.join(dir, 'master'), one + '\n');
  let calls = 0;
  const options = { run: async () => { calls++; }, now: () => 1000 };
  const { verifyMerge } = require('../core/git-merge-verification');
  try {
    await verifyMerge(root, merge, options); await verifyMerge(root, merge, options); assert.equal(calls, 2);
    await fsp.writeFile(path.join(dir, 'master'), two + '\n');
    await verifyMerge(root, merge, options); assert.equal(calls, 4);
    await fsp.unlink(path.join(dir, 'master')); await fsp.writeFile(path.join(root, '.git', 'packed-refs'), two + ' refs/heads/master\n');
    await verifyMerge(root, merge, options); assert.equal(calls, 4, 'packing the same target preserves its proof');
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});
test('sidebar resource requests skip GPU/disk sampling; explicit details still work', async () => {
  const handlers = new Map(); let extendedCalls = 0;
  require('../main/ipc/app-utility-handlers').registerAppUtilityIpc({ handle: (name, fn) => handlers.set(name, fn) }, {
    systemTelemetry: { sample: async () => { extendedCalls++; return { gpu: { name: 'fixture' } }; } },
  });
  const sample = handlers.get('get-system-resource-usage');
  for (let i = 0; i < 6; i++) assert(Number.isFinite((await sample(null, { extended: false })).memoryPct));
  assert.equal(extendedCalls, 0);
  assert.equal((await sample(null, { force: true })).gpu.name, 'fixture'); assert.equal(extendedCalls, 1);
});
test('unchanged usage files are not reread and caller mutation cannot poison the cache', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hub-usage-read-'));
  const file = path.join(root, 'usage.json'); await fsp.writeFile(file, JSON.stringify({ claude: { ts: 1 } }));
  const { readUsageCacheFile } = require('../main/usage/usage-cache-merge');
  let reads = 0; const original = fs.readFileSync;
  fs.readFileSync = function (name, ...args) { if (name === file) reads++; return original.call(this, name, ...args); };
  try {
    readUsageCacheFile(file).claude.ts = 99;
    assert.equal(readUsageCacheFile(file).claude.ts, 1); assert.equal(reads, 1);
    await fsp.writeFile(file + '.tmp', JSON.stringify({ claude: { ts: 2 } })); await fsp.rename(file + '.tmp', file);
    assert.equal(readUsageCacheFile(file).claude.ts, 2); assert.equal(reads, 2);
  } finally { fs.readFileSync = original; await fsp.rm(root, { recursive: true, force: true }); }
});
