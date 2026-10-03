'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const {
  createVpnTrafficRecorder, diffSnapshot, applyDeltas, aggregateDays, emptyDay,
  parseNetstatOwners, parseTasklist, rangeDates, localDateKey,
} = require('../core/vpn-traffic-recorder');

const conn = (id, upload, download, extra = {}) => ({
  id, upload, download,
  chains: extra.chains || ['美国 A', '🚀 节点选择'],
  metadata: { host: extra.host || 'api.anthropic.com', process: extra.process || '', sourcePort: extra.port || '50001' },
});

test('first snapshot is only a baseline; later snapshots yield per-connection deltas', () => {
  let state = { totals: null, conns: new Map() };
  const a = diffSnapshot(state, { uploadTotal: 1000, downloadTotal: 5000, connections: [conn('a', 100, 500)] });
  assert.equal(a.first, true);
  assert.deepEqual(a.deltas, []);
  state = a.nextState;
  const b = diffSnapshot(state, {
    uploadTotal: 1300, downloadTotal: 5900,
    connections: [conn('a', 300, 900), conn('b', 100, 500)],
  });
  assert.deepEqual(b.deltas.map(d => [d.conn.id, d.up, d.down]), [['a', 200, 400], ['b', 100, 500]]);
  assert.deepEqual(b.unattributed, { up: 0, down: 0 });
});

test('bytes of a connection that closed between samples go to that connection, by last rate', () => {
  let state = diffSnapshot({ totals: null, conns: new Map() }, {
    uploadTotal: 0, downloadTotal: 0, connections: [conn('fast', 0, 0), conn('slow', 0, 0)],
  }).nextState;
  state = diffSnapshot(state, {
    uploadTotal: 0, downloadTotal: 400, connections: [conn('fast', 0, 300), conn('slow', 0, 100)],
  }).nextState;
  // 两条都在下一轮前结束；核心总量又多了 800 字节下行。
  const result = diffSnapshot(state, { uploadTotal: 0, downloadTotal: 1200, connections: [] });
  const byId = Object.fromEntries(result.deltas.map(d => [d.conn.id, d.down]));
  assert.equal(byId.fast, 600);
  assert.equal(byId.slow, 200);
  assert.ok(result.deltas.every(d => d.estimated));
  assert.deepEqual(result.unattributed, { up: 0, down: 0 });
  assert.deepEqual(result.estimated, { up: 0, down: 800 });
});

test('residual without any vanished connection stays unattributed', () => {
  const state = diffSnapshot({ totals: null, conns: new Map() }, { uploadTotal: 0, downloadTotal: 0, connections: [conn('a', 0, 0)] }).nextState;
  const result = diffSnapshot(state, { uploadTotal: 50, downloadTotal: 70, connections: [conn('a', 10, 20)] });
  assert.deepEqual(result.unattributed, { up: 40, down: 50 });
});

test('a Clash core restart counts new totals from zero instead of going negative', () => {
  const state = diffSnapshot({ totals: null, conns: new Map() }, { uploadTotal: 9_000, downloadTotal: 9_000, connections: [conn('old', 9_000, 9_000)] }).nextState;
  const result = diffSnapshot(state, { uploadTotal: 100, downloadTotal: 200, connections: [conn('new', 100, 200)] });
  assert.equal(result.coreRestarted, true);
  assert.deepEqual(result.deltas.map(d => [d.conn.id, d.up, d.down]), [['new', 100, 200]]);
  assert.deepEqual(result.unattributed, { up: 0, down: 0 });
});

test('applyDeltas separates proxied, direct and rejected traffic and buckets by app/host/node/hour', () => {
  const day = emptyDay('2026-10-03');
  const at = new Date(2026, 9, 3, 14, 5).getTime();
  applyDeltas(day, {
    deltas: [
      { conn: conn('1', 10, 20, { process: 'C:\\Tools\\codex.exe', host: 'ChatGPT.com' }), up: 10, down: 20 },
      { conn: conn('2', 5, 5, { chains: ['DIRECT', '🎯 全球直连'], host: 'baidu.com' }), up: 5, down: 5 },
      { conn: conn('3', 7, 7, { chains: ['REJECT'] }), up: 7, down: 7 },
      { conn: conn('4', 1, 2), up: 1, down: 2 },
    ],
    unattributed: { up: 3, down: 4 },
  }, c => (c.metadata.process ? require('node:path').win32.basename(c.metadata.process) : null), at);
  assert.deepEqual(day.proxied, { up: 11, down: 22 });
  assert.deepEqual(day.direct, { up: 5, down: 5 });
  assert.deepEqual(day.unattributed, { up: 3, down: 4 });
  assert.deepEqual(day.byApp['codex.exe'], { up: 10, down: 20 });
  assert.deepEqual(day.byApp['(未识别)'], { up: 1, down: 2 });
  assert.deepEqual(day.byHost['chatgpt.com'], { up: 10, down: 20 });
  assert.deepEqual(day.byNode['美国 A'], { up: 11, down: 22 });
  assert.deepEqual(day.byHour[14], { up: 11, down: 22 });
  assert.equal(day.byHost['baidu.com'], undefined);
});

test('aggregateDays merges days and ranks apps with their top hosts', () => {
  const d1 = emptyDay('2026-10-01');
  const d2 = emptyDay('2026-10-02');
  d1.proxied = { up: 10, down: 100 }; d1.byApp = { 'claude.exe': { up: 10, down: 0 }, 'codex.exe': { up: 0, down: 100 } };
  d1.byAppHost = { 'codex.exe\tchatgpt.com': { up: 0, down: 100 }, 'claude.exe\tapi.anthropic.com': { up: 10, down: 0 } };
  d2.proxied = { up: 500, down: 0 }; d2.byApp = { 'claude.exe': { up: 500, down: 0 } };
  d2.byAppHost = { 'claude.exe\tapi.anthropic.com': { up: 500, down: 0 } };
  d2.recordedMs = 1000;
  const summary = aggregateDays([d1, d2]);
  assert.deepEqual(summary.proxied, { up: 510, down: 100 });
  assert.deepEqual(summary.apps.map(a => [a.key, a.total]), [['claude.exe', 510], ['codex.exe', 100]]);
  assert.deepEqual(summary.apps[0].hosts.map(h => [h.key, h.total]), [['api.anthropic.com', 510]]);
  assert.deepEqual(summary.daily.map(d => [d.date, d.up + d.down]), [['2026-10-01', 110], ['2026-10-02', 500]]);
  assert.equal(summary.recordedMs, 1000);
});

test('parses netstat owners for the proxy port and tasklist names', () => {
  const owners = parseNetstatOwners([
    '  TCP    127.0.0.1:53001        127.0.0.1:7890         ESTABLISHED     4242',
    '  TCP    127.0.0.1:7890         127.0.0.1:53001        ESTABLISHED     36032',
    '  TCP    192.168.3.5:53002      1.2.3.4:443            ESTABLISHED     99',
  ].join('\r\n'), 7890);
  assert.deepEqual([...owners], [['53001', 4242]]);
  assert.deepEqual([...parseTasklist('"codex.exe","4242","Console","1","10,000 K"\r\n')], [[4242, 'codex.exe']]);
});

test('range helpers produce local calendar days', () => {
  const at = new Date(2026, 9, 3, 9).getTime();
  assert.deepEqual(rangeDates('today', at), ['2026-10-03']);
  assert.deepEqual(rangeDates('7d', at), ['2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03']);
  assert.deepEqual(rangeDates('month', at), ['2026-10-01', '2026-10-02', '2026-10-03']);
  assert.equal(rangeDates('30d', at).length, 30);
  assert.equal(localDateKey(at), '2026-10-03');
});

function fakeClash(snapshots) {
  let index = 0;
  return {
    calls: 0,
    request(options, onResponse) {
      this.calls += 1;
      assert.equal(options.socketPath, '\\\\.\\pipe\\verge-mihomo-test');
      const request = new EventEmitter();
      request.end = () => {
        const response = new EventEmitter();
        response.statusCode = 200;
        onResponse(response);
        const body = snapshots[Math.min(index, snapshots.length - 1)];
        index += 1;
        process.nextTick(() => { response.emit('data', JSON.stringify(body)); response.emit('end'); });
      };
      return request;
    },
  };
}

function recorderFor(dir, http, extra = {}) {
  let t = new Date(2026, 9, 3, 10, 0, 0).getTime();
  const config = 'external-controller-pipe: \\\\.\\pipe\\verge-mihomo-test\nsecret: s\nmixed-port: 7890\n';
  const configPath = path.join(dir, 'clash.yaml');
  fs.writeFileSync(configPath, config);
  const recorder = createVpnTrafficRecorder({
    dir: path.join(dir, 'traffic'), http, configPath, listPipes: () => [],
    now: () => t, intervalMs: 2_000, flushMs: 1_000,
    execFile: async () => '', isPidAlive: pid => pid === 111 || pid === 222,
    ...extra,
  });
  return { recorder, advance: ms => { t += ms; } };
}

test('recorder samples Clash, persists the day file and reports it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpn-traffic-'));
  try {
    const http = fakeClash([
      { uploadTotal: 0, downloadTotal: 0, connections: [conn('a', 0, 0, { process: 'codex.exe', host: 'chatgpt.com' })] },
      { uploadTotal: 100, downloadTotal: 2_000, connections: [conn('a', 100, 2_000, { process: 'codex.exe', host: 'chatgpt.com' })] },
    ]);
    const { recorder, advance } = recorderFor(dir, http, { pid: 111 });
    await recorder.tick(); advance(2_000);
    await recorder.tick();
    const report = recorder.report('today');
    assert.deepEqual(report.proxied, { up: 100, down: 2_000 });
    assert.equal(report.apps[0].key, 'codex.exe');
    assert.equal(report.status.holder, 'self');
    assert.equal(report.recordedMs, 2_000);
    recorder.stop();
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'traffic', '2026-10-03.json'), 'utf8'));
    assert.deepEqual(saved.proxied, { up: 100, down: 2_000 });
    assert.equal(fs.existsSync(path.join(dir, 'traffic', 'recorder.lock')), false, 'stop releases the lease');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('only one Hub instance records at a time; the other reads the shared files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpn-traffic-'));
  try {
    const snap = { uploadTotal: 0, downloadTotal: 0, connections: [] };
    const httpA = fakeClash([snap]);
    const httpB = fakeClash([snap]);
    const a = recorderFor(dir, httpA, { pid: 111 });
    const b = recorderFor(dir, httpB, { pid: 222 });
    await a.recorder.tick();
    await b.recorder.tick();
    assert.equal(httpA.calls, 1);
    assert.equal(httpB.calls, 0, 'second instance must not poll while the lease is fresh');
    assert.equal(b.recorder.report('today').status.holder, 'other');
    a.recorder.stop();
    b.advance(2_000);
    await b.recorder.tick();
    assert.equal(httpB.calls, 1, 'second instance takes over after the first releases');
    b.recorder.stop();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a stale lease from a dead process is taken over', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpn-traffic-'));
  try {
    fs.mkdirSync(path.join(dir, 'traffic'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'traffic', 'recorder.lock'), JSON.stringify({ pid: 999, heartbeatAt: new Date(2026, 9, 3, 10).getTime() }));
    const http = fakeClash([{ uploadTotal: 0, downloadTotal: 0, connections: [] }]);
    const { recorder } = recorderFor(dir, http, { pid: 111 });
    await recorder.tick();
    assert.equal(http.calls, 1);
    recorder.stop();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
