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
  assert.equal(calls[0][calls[0].indexOf('--proxy') + 1], 'http://127.0.0.1:7890');
  assert.equal(calls[1][calls[1].indexOf('--noproxy') + 1], '*');
});
