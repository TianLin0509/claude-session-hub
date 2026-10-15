'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const sourcePath = require.resolve('../core/web-risk-guard');
function loadGuard(platform = 'win32') {
  const mod = { exports: {} };
  // Exercise both platform policies on every host; the filesystem and shared
  // rename helper remain real, only selected filesystem failures are injected.
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), {
    module: mod, exports: mod.exports, require: createRequire(sourcePath),
    process: { platform, pid: process.pid }, console, URL, setTimeout, clearTimeout,
  }, { filename: sourcePath });
  return mod.exports;
}

const guard = loadGuard();
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-risk-atomic-unit-'));
  t.after(() => {
    t.mock.restoreAll();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const target = path.join(dir, 'web-risk.json');
  const before = JSON.stringify({ handoff: null, sites: { 'old:site': { marker: 'preserve' } }, visits: {} });
  fs.writeFileSync(target, before, 'utf8');
  return { dir, target, before, lock: target + '.lock' };
}

function interceptRename(t, f, onAttempt) {
  const original = fs.renameSync;
  const attempts = [];
  t.mock.method(fs, 'renameSync', (source, target) => {
    if (target !== f.target) return original(source, target);
    attempts.push({ source, target });
    assert.ok(fs.existsSync(f.lock), 'the writer keeps its lock through every rename attempt');
    assert.equal(fs.readFileSync(target, 'utf8'), f.before, 'the old complete file remains until replacement succeeds');
    assert.equal(source, attempts[0].source, 'retries reuse one serialized snapshot');
    onAttempt(attempts.length, source);
    return original(source, target);
  });
  return attempts;
}

for (const code of ['EPERM', 'EBUSY']) {
  test(`a short ${code} retries only rename and commits the state change once`, t => {
    const f = fixture(t);
    let uuidCalls = 0;
    t.mock.method(crypto, 'randomUUID', () => { uuidCalls += 1; return 'one-handoff'; });
    const write = fs.writeFileSync;
    let snapshotWrites = 0;
    t.mock.method(fs, 'writeFileSync', (file, ...args) => {
      if (String(file).startsWith(f.target + '.') && String(file).endsWith('.tmp')) snapshotWrites += 1;
      return write(file, ...args);
    });
    const attempts = interceptRename(t, f, n => {
      if (n <= 2) throw Object.assign(new Error('short sharing conflict'), { code });
    });

    const lease = guard.startHandoff(f.dir, { identity: 'main', site: 'chatgpt', now: 1000 });
    assert.equal(lease.id, 'one-handoff');
    assert.equal(uuidCalls, 1, 'the state callback is not repeated');
    assert.equal(snapshotWrites, 1, 'the state is serialized and written only once');
    assert.ok(attempts.length >= 3 && attempts.length <= 21);
    assert.equal(guard.read(f.dir).handoff.id, 'one-handoff');
    assert.equal(guard.read(f.dir).sites['old:site'].marker, 'preserve');
    assert.deepEqual(fs.readdirSync(f.dir), ['web-risk.json']);
  });
}

test('retries do not charge more than one visit against the browser budget', t => {
  const f = fixture(t);
  interceptRename(t, f, n => {
    if (n <= 2) throw Object.assign(new Error('short sharing conflict'), { code: 'EPERM' });
  });
  const visit = guard.takeVisit(f.dir, 'main', 'chatgpt', 1000);
  assert.equal(visit.used, 1);
  assert.equal(guard.read(f.dir).visits['main:chatgpt'].length, 1);
  assert.equal(guard.read(f.dir).visits['main:chatgpt'][0], 1000);
});

for (const code of ['EPERM', 'EBUSY']) {
  test(`a persistent ${code} stops after 21 attempts, preserves the old file and cleans its temp`, t => {
    const f = fixture(t);
    const failure = Object.assign(new Error('still held'), { code });
    const attempts = interceptRename(t, f, () => { throw failure; });
    assert.throws(() => guard.takeVisit(f.dir, 'main', 'chatgpt', 1000), error => error === failure);
    assert.equal(attempts.length, 21, 'one initial attempt and twenty bounded retries');
    assert.equal(fs.readFileSync(f.target, 'utf8'), f.before);
    assert.deepEqual(fs.readdirSync(f.dir), ['web-risk.json']);
  });
}

for (const code of ['EACCES', 'ENOSPC', 'ENOENT']) {
  test(`${code} is not retried or converted to success`, t => {
    const f = fixture(t);
    const failure = Object.assign(new Error('permanent write error'), { code });
    const attempts = interceptRename(t, f, () => { throw failure; });
    assert.throws(() => guard.takeVisit(f.dir, 'main', 'chatgpt', 1000), error => error === failure);
    assert.equal(attempts.length, 1);
    assert.equal(fs.readFileSync(f.target, 'utf8'), f.before);
    assert.deepEqual(fs.readdirSync(f.dir), ['web-risk.json']);
  });
}

test('a temp-cleanup failure does not replace the original save error or keep the write lock', t => {
  const f = fixture(t);
  const failure = Object.assign(new Error('save failed'), { code: 'ENOSPC' });
  const cleanupFailure = Object.assign(new Error('temp still held'), { code: 'EBUSY' });
  const attempts = interceptRename(t, f, () => { throw failure; });
  const remove = fs.rmSync;
  let cleanupAttempts = 0;
  t.mock.method(fs, 'rmSync', (file, options) => {
    if (String(file).startsWith(f.target + '.') && String(file).endsWith('.tmp')) {
      cleanupAttempts += 1;
      throw cleanupFailure;
    }
    return remove(file, options);
  });
  assert.throws(() => guard.takeVisit(f.dir, 'main', 'chatgpt', 1000), error => error === failure);
  assert.equal(attempts.length, 1);
  assert.equal(cleanupAttempts, 1, 'cleanup is attempted even when the save failed');
  assert.equal(fs.readFileSync(f.target, 'utf8'), f.before);
  assert.equal(fs.existsSync(f.lock), false);
  assert.equal(fs.readdirSync(f.dir).filter(name => name.endsWith('.tmp')).length, 1,
    'an externally held temp may remain, but it never replaces the authoritative file');
});

test('a lock-cleanup failure does not mask the original save error', t => {
  const f = fixture(t);
  const failure = Object.assign(new Error('save failed'), { code: 'ENOSPC' });
  interceptRename(t, f, () => { throw failure; });
  const remove = fs.rmSync;
  t.mock.method(fs, 'rmSync', (file, options) => {
    if (file === f.lock) throw Object.assign(new Error('lock cleanup denied'), { code: 'EPERM' });
    return remove(file, options);
  });
  assert.throws(() => guard.takeVisit(f.dir, 'main', 'chatgpt', 1000), error => error === failure);
  assert.equal(fs.readFileSync(f.target, 'utf8'), f.before);
  assert.equal(fs.readdirSync(f.dir).filter(name => name.endsWith('.tmp')).length, 0);
});

test('a partial temp write is cleaned without replacing the old state', t => {
  const f = fixture(t);
  const failure = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  const write = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    if (String(file).startsWith(f.target + '.') && String(file).endsWith('.tmp')) {
      write(file, '{partial', 'utf8');
      throw failure;
    }
    return write(file, ...args);
  });
  assert.throws(() => guard.takeVisit(f.dir, 'main', 'chatgpt', 1000), error => error === failure);
  assert.equal(fs.readFileSync(f.target, 'utf8'), f.before);
  assert.deepEqual(fs.readdirSync(f.dir), ['web-risk.json']);
});

test('non-Windows writes keep the previous single-attempt policy', t => {
  const otherGuard = loadGuard('linux');
  const f = fixture(t);
  const failure = Object.assign(new Error('not a Windows sharing conflict'), { code: 'EPERM' });
  const attempts = interceptRename(t, f, () => { throw failure; });
  assert.throws(() => otherGuard.takeVisit(f.dir, 'main', 'chatgpt', 1000), error => error === failure);
  assert.equal(attempts.length, 1);
  assert.equal(fs.readFileSync(f.target, 'utf8'), f.before);
  assert.deepEqual(fs.readdirSync(f.dir), ['web-risk.json']);
});
