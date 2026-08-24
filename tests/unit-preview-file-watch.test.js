'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createPreviewFileWatchManager, fileSignature } = require('../renderer/preview-file-watch.js');

function makeFakeFs() {
  const signatures = new Map();
  const watchers = [];
  const fake = {
    signatures,
    watchers,
    watchFailures: 0,
    statSync(filePath) {
      const value = signatures.get(path.resolve(filePath));
      if (!value) {
        const error = new Error('ENOENT');
        error.code = 'ENOENT';
        throw error;
      }
      return { mtimeMs: value.mtimeMs, size: value.size };
    },
    watch(directory, _options, callback) {
      if (fake.watchFailures > 0) {
        fake.watchFailures -= 1;
        throw new Error('watch setup failed');
      }
      const handlers = new Map();
      const watcher = {
        directory,
        closed: false,
        callback,
        on(type, handler) { handlers.set(type, handler); return this; },
        close() { this.closed = true; },
        unref() {},
        emit(type, value) { handlers.get(type)?.(value); },
      };
      watchers.push(watcher);
      return watcher;
    },
  };
  return fake;
}

test('shares one directory watcher and emits only changed file signatures', async () => {
  const fs = makeFakeFs();
  const first = path.resolve('C:\\work\\first.md');
  const second = path.resolve('C:\\work\\second.md');
  fs.signatures.set(first, { mtimeMs: 1, size: 10 });
  fs.signatures.set(second, { mtimeMs: 1, size: 20 });
  const manager = createPreviewFileWatchManager({ fs, debounceMs: 1 });
  const events = [];
  const firstSub = manager.subscribe(first, event => events.push(event));
  const secondSub = manager.subscribe(second, event => events.push(event));
  assert.deepEqual(manager.getStats(), { directories: 1, files: 2, listeners: 2, degradedDirectories: 0, cleanupFailures: 0 });
  assert.equal(fs.watchers.length, 1);

  fs.watchers[0].callback('change', path.basename(first));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(events.length, 0, 'same signature must not create a stale marker');

  fs.signatures.set(first, { mtimeMs: 2, size: 25 });
  fs.watchers[0].callback('change', path.basename(first));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    path: first,
    exists: true,
    missing: false,
    mtimeMs: 2,
    size: 25,
    eventType: 'change',
    error: undefined,
    errorCode: undefined,
  });

  firstSub.dispose();
  assert.deepEqual(manager.getStats(), { directories: 1, files: 1, listeners: 1, degradedDirectories: 0, cleanupFailures: 0 });
  secondSub.dispose();
  assert.deepEqual(manager.getStats(), { directories: 0, files: 0, listeners: 0, degradedDirectories: 0, cleanupFailures: 0 });
  assert.equal(fs.watchers[0].closed, true);
});

test('rename is surfaced even when timestamp and size are unchanged', async () => {
  const fs = makeFakeFs();
  const target = path.resolve('C:\\work\\same-size.md');
  fs.signatures.set(target, { mtimeMs: 1, size: 10 });
  const manager = createPreviewFileWatchManager({ fs, debounceMs: 1 });
  const events = [];
  manager.subscribe(target, event => events.push(event));
  fs.watchers[0].callback('rename', path.basename(target));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'rename');
  manager.dispose();
});

test('watch setup failure remains subscribed, reports degradation and recovers', async () => {
  const fs = makeFakeFs();
  const target = path.resolve('C:\\work\\retry.md');
  fs.signatures.set(target, { mtimeMs: 1, size: 10 });
  fs.watchFailures = 1;
  const errors = [];
  const events = [];
  const manager = createPreviewFileWatchManager({
    fs,
    debounceMs: 1,
    retryMs: 1,
    maxRetryMs: 2,
    onError: error => errors.push(error.message),
  });
  manager.subscribe(target, event => events.push(event));
  assert.equal(manager.getStats().degradedDirectories, 1);
  assert.equal(events.filter(event => event.eventType === 'watch-error').length, 1);
  assert.match(events[0].watchError, /watch setup failed/);
  fs.signatures.set(target, { mtimeMs: 2, size: 11 });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(fs.watchers.length, 1);
  assert.equal(manager.getStats().degradedDirectories, 0);
  assert.ok(events.some(event => event.eventType === 'watch-recovered' && event.watchError === null));
  assert.ok(events.some(event => event.eventType === 'watch-recovered-scan' && event.exists === true));
  assert.ok(errors.some(message => /watch setup failed/.test(message)));
  manager.dispose();
});

test('a subscriber added while degraded sees error before recovery', () => {
  const fs = makeFakeFs();
  const first = path.resolve('C:\\work\\degraded-a.md');
  const second = path.resolve('C:\\work\\degraded-b.md');
  fs.signatures.set(first, { mtimeMs: 1, size: 10 });
  fs.signatures.set(second, { mtimeMs: 1, size: 20 });
  fs.watchFailures = 1;
  const manager = createPreviewFileWatchManager({
    fs,
    debounceMs: 1,
    retryMs: 10_000,
    maxRetryMs: 10_000,
  });
  manager.subscribe(first, () => {});
  const secondEvents = [];
  manager.subscribe(second, event => secondEvents.push(event));
  assert.equal(secondEvents[0].eventType, 'watch-error');
  assert.match(secondEvents[0].watchError, /watch setup failed/);
  assert.equal(secondEvents[1].eventType, 'watch-recovered');
  assert.equal(secondEvents[1].watchError, null);
  assert.equal(manager.getStats().degradedDirectories, 0);
  manager.dispose();
});

test('I/O errors are distinct from missing files', () => {
  const deniedFs = {
    statSync() {
      const error = new Error('EACCES denied');
      error.code = 'EACCES';
      throw error;
    },
  };
  const result = fileSignature(deniedFs, 'C:\\locked\\report.md');
  assert.equal(result.exists, null);
  assert.equal(result.missing, false);
  assert.equal(result.errorCode, 'EACCES');
});

test('unexpected close retries, rescans changes and ignores late errors from old watcher', async () => {
  const fs = makeFakeFs();
  const target = path.resolve('C:\\work\\runtime-close.md');
  fs.signatures.set(target, { mtimeMs: 1, size: 10 });
  const events = [];
  const manager = createPreviewFileWatchManager({ fs, debounceMs: 1, retryMs: 1, maxRetryMs: 2 });
  manager.subscribe(target, event => events.push(event));
  const oldWatcher = fs.watchers[0];
  oldWatcher.emit('close');
  assert.equal(manager.getStats().degradedDirectories, 1);
  fs.signatures.set(target, { mtimeMs: 2, size: 12 });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(fs.watchers.length, 2);
  assert.equal(manager.getStats().degradedDirectories, 0);
  assert.ok(events.some(event => event.eventType === 'watch-recovered-scan' && event.exists === true));
  oldWatcher.emit('error', new Error('late old watcher error'));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(manager.getStats().degradedDirectories, 0);
  assert.equal(fs.watchers[1].closed, false);
  manager.dispose();
});

test('reports atomic removal and disposes all resources', async () => {
  const fs = makeFakeFs();
  const target = path.resolve('C:\\work\\report.md');
  fs.signatures.set(target, { mtimeMs: 1, size: 10 });
  const manager = createPreviewFileWatchManager({ fs, debounceMs: 1 });
  const events = [];
  manager.subscribe(target, event => events.push(event));
  fs.signatures.delete(target);
  fs.watchers[0].callback('rename', path.basename(target));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(events[0].exists, false);
  assert.equal(events[0].missing, true);
  assert.equal(events[0].errorCode, 'ENOENT');
  assert.match(events[0].error, /ENOENT/);
  manager.dispose();
  assert.deepEqual(manager.getStats(), { directories: 0, files: 0, listeners: 0, degradedDirectories: 0, cleanupFailures: 0 });
  assert.equal(fs.watchers[0].closed, true);
});

test('watcher close failures remain visible in cleanup statistics', () => {
  const fs = makeFakeFs();
  const target = path.resolve('C:\\work\\close-failure.md');
  fs.signatures.set(target, { mtimeMs: 1, size: 10 });
  const errors = [];
  const manager = createPreviewFileWatchManager({
    fs,
    debounceMs: 1,
    onError: error => errors.push(error.message),
  });
  const subscription = manager.subscribe(target, () => {});
  fs.watchers[0].close = () => { throw new Error('close failed'); };
  subscription.dispose();
  assert.equal(manager.getStats().cleanupFailures, 1);
  assert.ok(errors.some(message => /close failed/.test(message)));
  assert.deepEqual(manager.dispose(), { ok: false, cleanupFailures: 1 });
});
