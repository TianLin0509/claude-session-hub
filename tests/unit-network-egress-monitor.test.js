'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createCurlGeoProbe,
  createNetworkEgressMonitor,
  normalizeGeoPayload,
  safeProxyEndpoint,
} = require('../core/network-egress-monitor.js');

function route(ip, countryCode, country, city, region = '') {
  return normalizeGeoPayload({
    ip,
    country_code: countryCode,
    country,
    city,
    region,
    organization_name: 'Test ISP',
  }, 'fixture');
}

test('normalizes public IP geo data and hides proxy credentials', () => {
  const losAngeles = route('38.246.239.122', 'US', 'United States', 'Los Angeles', 'California');
  assert.equal(losAngeles.locationLabel, '美国·洛杉矶');
  assert.equal(losAngeles.ipVersion, 4);
  assert.equal(safeProxyEndpoint('http://alice:secret@127.0.0.1:7890/path'), 'http://127.0.0.1:7890');
});

test('first healthy VPN exit becomes baseline, a later IP change stays visible until acknowledged', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-egress-unit-'));
  const statePath = path.join(root, 'network-egress-state.json');
  let foreign = route('38.246.239.122', 'US', 'United States', 'Los Angeles', 'California');
  const domestic = route('180.158.74.254', 'CN', 'China', 'Shanghai', 'Shanghai');
  const monitor = createNetworkEgressMonitor({
    getProxy: () => 'http://127.0.0.1:7890',
    statePath,
    cacheMs: 0,
    probe: async ({ route: routeType }) => routeType === 'proxy' ? foreign : domestic,
  });

  try {
    const initial = await monitor.getStatus({ force: true });
    assert.equal(initial.alert, null);
    assert.equal(initial.foreign.locationLabel, '美国·洛杉矶');
    assert.equal(initial.domestic.locationLabel, '中国·上海');
    assert.ok(fs.existsSync(statePath));

    foreign = route('203.0.113.9', 'US', 'United States', 'Seattle', 'Washington');
    const changed = await monitor.getStatus({ force: true });
    assert.equal(changed.alert.type, 'vpn_changed');
    assert.equal(changed.alert.severity, 'warning');
    assert.equal(changed.alert.acknowledgeable, true);
    assert.match(changed.alert.message, /洛杉矶.*西雅图/);

    const acknowledged = await monitor.acknowledgeForeignChange();
    assert.equal(acknowledged.ok, true);
    assert.equal(acknowledged.status.alert, null);
    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(persisted.acknowledgedForeign.route.ip, '203.0.113.9');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reports unavailable or bypassed VPN as critical alerts', async () => {
  const domestic = route('180.158.74.254', 'CN', 'China', 'Shanghai', 'Shanghai');
  const unavailable = createNetworkEgressMonitor({
    getProxy: () => 'http://127.0.0.1:7890',
    cacheMs: 0,
    probe: async ({ route: routeType }) => routeType === 'proxy'
      ? { ok: false, errorCode: 'vpn_unavailable', error: 'VPN 出口不可用' }
      : domestic,
  });
  const failed = await unavailable.getStatus({ force: true });
  assert.equal(failed.alert.type, 'vpn_unavailable');
  assert.equal(failed.alert.severity, 'critical');

  const bypassed = createNetworkEgressMonitor({
    getProxy: () => 'http://127.0.0.1:7890',
    cacheMs: 0,
    probe: async () => domestic,
  });
  const sameIp = await bypassed.getStatus({ force: true });
  assert.equal(sameIp.alert.type, 'vpn_bypassed');
  assert.equal(sameIp.alert.severity, 'critical');
});

test('one transient VPN probe failure keeps the recent healthy route and retries quickly', async () => {
  let now = 1_800_000_000_000;
  let foreign = route('38.246.239.122', 'US', 'United States', 'Los Angeles', 'California');
  const domestic = route('180.158.74.254', 'CN', 'China', 'Shanghai', 'Shanghai');
  const monitor = createNetworkEgressMonitor({
    getProxy: () => 'http://127.0.0.1:7890',
    now: () => now,
    cacheMs: 60_000,
    failureCacheMs: 5_000,
    probe: async ({ route: routeType }) => routeType === 'proxy' ? foreign : domestic,
  });

  const healthy = await monitor.getStatus({ force: true });
  assert.equal(healthy.alert, null);

  now += 60_000;
  foreign = { ok: false, errorCode: 'probe_timeout', error: 'VPN 出口不可用' };
  const transient = await monitor.getStatus({ force: true });
  assert.equal(transient.alert.type, 'vpn_probe_retrying');
  assert.equal(transient.alert.severity, 'warning');
  assert.equal(transient.foreign.ok, true);
  assert.equal(transient.foreign.stale, true);
  assert.equal(transient.foreign.ip, healthy.foreign.ip);

  now += 6_000;
  const confirmed = await monitor.getStatus();
  assert.equal(confirmed.alert.type, 'vpn_unavailable');
  assert.equal(confirmed.foreign.ok, false);

  now += 6_000;
  foreign = route('38.246.239.122', 'US', 'United States', 'Los Angeles', 'California');
  const recovered = await monitor.getStatus();
  assert.equal(recovered.alert, null);
  assert.equal(recovered.consecutiveForeignFailures, 0);
});

test('curl probe forces IPv4 and chooses explicit proxy versus explicit direct route', async () => {
  const calls = [];
  const execFile = (_file, args, _options, callback) => {
    calls.push(args);
    callback(null, JSON.stringify({
      ip: '38.246.239.122',
      country_code: 'US',
      country: 'United States',
      city: 'Los Angeles',
      region: 'California',
    }), '');
  };
  const probe = createCurlGeoProbe({
    execFile,
    endpoints: [{ name: 'fixture', url: 'https://geo.example/json' }],
  });

  await probe({ route: 'proxy', proxy: 'http://127.0.0.1:7890' });
  await probe({ route: 'direct', proxy: '' });
  assert.ok(calls[0].includes('--ipv4'));
  assert.ok(Number(calls[0][calls[0].indexOf('--connect-timeout') + 1]) >= 8,
    'proxy CONNECT needs enough time for a healthy cold Mihomo tunnel');
  assert.equal(calls[0][calls[0].indexOf('--proxy') + 1], 'http://127.0.0.1:7890');
  assert.equal(calls[1][calls[1].indexOf('--noproxy') + 1], '*');
});

test('default curl probe starts its process off the main thread', async () => {
  // 2026-10-11: two curl spawns per sample held Electron's main thread 50-125 ms each.
  const childProcess = require('node:child_process');
  const mainThreadCalls = [];
  const originals = { execFile: childProcess.execFile, spawn: childProcess.spawn };
  childProcess.execFile = (...args) => { mainThreadCalls.push(args[0]); return originals.execFile(...args); };
  childProcess.spawn = (...args) => { mainThreadCalls.push(args[0]); return originals.spawn(...args); };
  try {
    const probe = createCurlGeoProbe({
      curlBin: process.execPath,
      endpoints: [{ name: 'fixture', url: 'http://127.0.0.1:9/never' }],
      timeoutMs: 1000,
    });
    const result = await probe({ route: 'direct' });
    assert.equal(result.ok, false, 'node is not curl: the probe reports a failure');
    assert.deepEqual(mainThreadCalls, [], 'no process was created on the calling thread');
  } finally {
    Object.assign(childProcess, originals);
  }
});

test('Hub 没配代理时退到 Windows 系统代理探测出口，并带上 xGate 是否开着（公司电脑，Q-1017-20）', async () => {
  const sg = route('203.0.113.20', 'SG', 'Singapore', 'Singapore');
  const calls = [];
  const monitor = createNetworkEgressMonitor({
    getProxy: () => '',
    getSystemProxy: async () => 'http://proxy.corp:8080',
    getTunnel: async () => ({ xgate: true }),
    cacheMs: 0,
    probe: async ({ route: routeType, proxy }) => { calls.push([routeType, proxy]); return routeType === 'proxy' ? sg : { ok: false, route: 'direct', error: '直连出口不可用' }; },
  });
  const status = await monitor.getStatus({ force: true });
  assert.deepEqual(calls.find(c => c[0] === 'proxy'), ['proxy', 'http://proxy.corp:8080'], '出口探测走系统代理');
  assert.equal(status.proxySource, 'system');
  assert.equal(status.proxyEndpoint, 'http://proxy.corp:8080');
  assert.equal(status.foreign.ok, true);
  assert.equal(status.tunnel.xgate, true);

  const own = createNetworkEgressMonitor({ getProxy: () => 'http://127.0.0.1:7890', getSystemProxy: async () => 'http://proxy.corp:8080', cacheMs: 0,
    probe: async ({ route: routeType, proxy }) => ({ ...sg, route: routeType, proxyUsed: proxy }) });
  const mine = await own.getStatus({ force: true });
  assert.equal(mine.proxySource, 'hub', 'Hub 配了代理（家里的 Clash）就用 Hub 的，不看系统代理');
  assert.equal(mine.proxyEndpoint, 'http://127.0.0.1:7890');
});

test('解析 Windows 系统代理与 xGate 进程', () => {
  const { parseSystemProxy, parseXgateRunning } = require('../core/windows-network-context.js');
  assert.equal(parseSystemProxy('    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    proxy.corp:8080\r\n'), 'http://proxy.corp:8080');
  assert.equal(parseSystemProxy('ProxyEnable    REG_DWORD    0x0\nProxyServer    REG_SZ    proxy.corp:8080'), '', '关着的不算');
  assert.equal(parseSystemProxy('ProxyEnable    REG_DWORD    0x1\nProxyServer    REG_SZ    http=h1:80;https=h2:443'), 'http://h2:443');
  assert.equal(parseSystemProxy('ProxyEnable    REG_DWORD    0x1'), '');
  assert.equal(parseXgateRunning('"SPES5.exe","15268","Console","1","182,340 K"\r\n'), true);
  assert.equal(parseXgateRunning('信息: 没有运行的任务匹配指定标准。'), false);
});
