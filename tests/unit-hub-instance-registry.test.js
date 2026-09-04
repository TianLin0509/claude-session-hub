'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  compareHubVersions,
  readHubInstances,
  selectPreferredHub,
} = require('../core/hub-instance-registry.js');

test('Hub versions use SemVer ordering rather than string ordering', () => {
  assert(compareHubVersions('1.10.0', '1.9.99') > 0);
  assert(compareHubVersions('v2.0.0', '1.999.999') > 0);
  assert(compareHubVersions('1.6.46', '1.6.46-beta.2') > 0);
  assert(compareHubVersions('1.6.46-beta.10', '1.6.46-beta.2') > 0);
});

test('preferred scheduler uses highest version and then highest live PID', () => {
  const now = 100_000;
  const selected = selectPreferredHub([
    { pid: 9000, appVersion: '1.6.31', lastBeatAt: now - 1000 },
    { pid: 1200, appVersion: '1.6.46', lastBeatAt: now - 2000 },
    { pid: 2200, appVersion: '1.6.46', lastBeatAt: now - 3000 },
    { pid: 9999, appVersion: '9.0.0', lastBeatAt: now - 60_000 },
    { pid: 8888, appVersion: '10.0.0', lastBeatAt: now, cleanExit: true },
  ], { now, maxHeartbeatAgeMs: 35_000 });
  assert.equal(selected.preferred.pid, 2200);
  assert.equal(selected.preferred.appVersion, '1.6.46');
  assert.deepEqual(selected.candidates.map(row => row.pid), [2200, 1200, 9000]);
  assert.deepEqual(selected.excluded.map(row => row.exclusionReason).sort(), ['exited', 'heartbeat-stale']);
});

test('registry reads legacy Hub version from lifecycle journal when heartbeat lacks it', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-instance-registry-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const diagnostics = path.join(dataDir, 'diagnostics');
  fs.mkdirSync(diagnostics, { recursive: true });
  fs.writeFileSync(path.join(diagnostics, 'process-lifecycle-9816.heartbeat.json'), JSON.stringify({
    schemaVersion: 1,
    ts: '2026-09-03T00:00:00.000Z',
    epochMs: 12345,
    pid: 9816,
    event: 'heartbeat',
    phase: 'running',
  }), 'utf8');
  fs.writeFileSync(path.join(diagnostics, 'process-lifecycle-9816.jsonl'), [
    JSON.stringify({ event: 'process-start', pid: 9816, appVersion: '1.6.31' }),
    JSON.stringify({ event: 'app-ready', pid: 9816 }),
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(diagnostics, 'process-lifecycle-111.heartbeat.json'), JSON.stringify({
    schemaVersion: 1,
    epochMs: 100,
    pid: 111,
    event: 'heartbeat',
    phase: 'running',
  }), 'utf8');
  fs.writeFileSync(path.join(diagnostics, 'process-lifecycle-111.jsonl'), JSON.stringify({
    event: 'process-start', pid: 111, appVersion: '9.9.9',
  }), 'utf8');

  const result = readHubInstances({ dataDir });
  assert.equal(result.instances.length, 2);
  assert.equal(result.instances.find(row => row.pid === 9816).appVersion, '1.6.31');
  const recent = readHubInstances({ dataDir, minLastBeatAt: 12_000 });
  assert.deepEqual(recent.instances.map(row => row.pid), [9816]);
});
