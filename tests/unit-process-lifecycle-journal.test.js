'use strict';

const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  installProcessLifecycleJournal,
  resolveLifecyclePaths,
} = require('../core/process-lifecycle-journal.js');

function fakeProcess(pid) {
  const processRef = new EventEmitter();
  Object.assign(processRef, {
    pid,
    ppid: 99,
    env: {},
    execPath: 'C:\\fake\\AIGroupChatHub.exe',
    versions: { node: '24.0.0', electron: '41.2.0', chrome: '142.0.0' },
    cwd: () => 'C:\\repo',
    uptime: () => 12.5,
    memoryUsage: () => ({ rss: 100, heapUsed: 50, external: 10 }),
  });
  return processRef;
}

function fakeApp() {
  const app = new EventEmitter();
  app.getVersion = () => '1.6.10';
  app.isReady = () => false;
  return app;
}

function readEvents(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

test('records app, window, renderer and clean-exit lifecycle without environment data', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-lifecycle-journal-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const app = fakeApp();
  const processRef = fakeProcess(1234);
  const windows = [];
  let intervalCallback = null;
  let intervalCleared = false;
  const journal = installProcessLifecycleJournal({
    app,
    BrowserWindow: { getAllWindows: () => windows.slice() },
    processRef,
    dataDir,
    now: (() => { let value = 1000; return () => value += 10; })(),
    heartbeatMs: 1000,
    setIntervalFn: callback => {
      intervalCallback = callback;
      return { unref() {} };
    },
    clearIntervalFn: () => { intervalCleared = true; },
  });
  t.after(() => journal.dispose({ recordEvent: false }));

  const window = new EventEmitter();
  window.id = 7;
  window.webContents = { id: 17 };
  window.getTitle = () => 'AI Hub';
  windows.push(window);

  app.emit('ready');
  app.emit('browser-window-created', {}, window);
  window.emit('unresponsive');
  window.emit('responsive');
  window.emit('close', {});
  windows.splice(0);
  window.emit('closed');
  app.emit('render-process-gone', {}, { id: 17 }, { reason: 'crashed', exitCode: 9 });
  app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 8 });
  processRef.emit('uncaughtExceptionMonitor', new Error('boom'), 'uncaughtException');
  app.emit('window-all-closed');
  app.emit('before-quit', {});
  app.emit('will-quit', {});
  app.emit('quit', {}, 0);
  processRef.emit('exit', 0);
  intervalCallback();

  const events = readEvents(journal.paths.journalPath);
  const names = events.map(item => item.event);
  for (const expected of [
    'process-start',
    'app-ready',
    'window-created',
    'window-close-requested',
    'window-closed',
    'render-process-gone',
    'child-process-gone',
    'uncaught-exception-monitor',
    'window-all-closed',
    'app-before-quit',
    'app-will-quit',
    'app-quit',
    'process-exit',
  ]) {
    assert.ok(names.includes(expected), `missing ${expected}`);
  }
  assert.equal(events.find(item => item.event === 'render-process-gone').reason, 'crashed');
  assert.equal(events.find(item => item.event === 'uncaught-exception-monitor').error.message, 'boom');
  assert.equal(events.some(item => Object.prototype.hasOwnProperty.call(item, 'env')), false);

  const heartbeat = JSON.parse(fs.readFileSync(journal.paths.heartbeatPath, 'utf8'));
  assert.equal(heartbeat.cleanExit, true);
  assert.equal(heartbeat.appVersion, '1.6.10');
  assert.equal(intervalCleared, true);
  assert.equal(journal.paths.journalPath, path.join(dataDir, 'diagnostics', 'process-lifecycle-1234.jsonl'));
});

test('unexpected exit leaves a non-clean heartbeat and explicit exit code', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-lifecycle-unexpected-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const app = fakeApp();
  const processRef = fakeProcess(4321);
  let intervalCallback = null;
  const journal = installProcessLifecycleJournal({
    app,
    BrowserWindow: { getAllWindows: () => [] },
    processRef,
    dataDir,
    heartbeatMs: 1000,
    setIntervalFn: callback => {
      intervalCallback = callback;
      return { unref() {} };
    },
    clearIntervalFn() {},
  });
  t.after(() => journal.dispose({ recordEvent: false }));

  intervalCallback();
  processRef.emit('exit', 23);

  const heartbeat = JSON.parse(fs.readFileSync(journal.paths.heartbeatPath, 'utf8'));
  const events = readEvents(journal.paths.journalPath);
  const exit = events.find(item => item.event === 'process-exit');
  assert.equal(exit.code, 23);
  assert.equal(exit.cleanExit, false);
  assert.equal(heartbeat.cleanExit, false);
  assert.equal(heartbeat.phase, 'process-exit-unexpected');
});

test('cleanup failure keeps lifecycle exit explicitly non-clean', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-lifecycle-degraded-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const app = fakeApp();
  const processRef = fakeProcess(5432);
  processRef.__hubShutdownCleanupClean = false;
  const journal = installProcessLifecycleJournal({
    app,
    BrowserWindow: { getAllWindows: () => [] },
    processRef,
    dataDir,
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn() {},
  });
  t.after(() => journal.dispose({ recordEvent: false }));
  app.emit('will-quit', {});
  app.emit('quit', {}, 0);
  processRef.emit('exit', 0);
  const events = readEvents(journal.paths.journalPath);
  assert.equal(events.find(item => item.event === 'app-will-quit').cleanExit, false);
  assert.equal(events.find(item => item.event === 'app-quit').phase, 'quit-degraded');
  assert.equal(events.find(item => item.event === 'process-exit').cleanExit, false);
});

test('diagnostic write failures never escape into the Hub process', () => {
  const app = fakeApp();
  const processRef = fakeProcess(777);
  const failure = new Error('disk unavailable');
  const throwingFs = {
    mkdirSync() { throw failure; },
    appendFileSync() { throw failure; },
    writeFileSync() { throw failure; },
  };

  let intervalCallback = null;
  const journal = installProcessLifecycleJournal({
    app,
    BrowserWindow: { getAllWindows: () => [] },
    processRef,
    dataDir: 'C:\\unwritable',
    fsRef: throwingFs,
    setIntervalFn: callback => {
      intervalCallback = callback;
      return { unref() {} };
    },
    clearIntervalFn() {},
  });

  assert.doesNotThrow(() => app.emit('before-quit', {}));
  assert.doesNotThrow(() => processRef.emit('uncaughtExceptionMonitor', failure, 'uncaughtException'));
  assert.doesNotThrow(() => intervalCallback());
  assert.match(journal.getHealth().lastWriteError, /disk unavailable/);
  journal.dispose({ recordEvent: false });
});

test('path resolution isolates lifecycle files per Hub PID', () => {
  const paths = resolveLifecyclePaths({ dataDir: 'C:\\hub-data', processRef: fakeProcess(88) });
  assert.equal(paths.journalPath, path.join('C:\\hub-data', 'diagnostics', 'process-lifecycle-88.jsonl'));
  assert.equal(paths.heartbeatPath, path.join('C:\\hub-data', 'diagnostics', 'process-lifecycle-88.heartbeat.json'));
});

test('bootstrap installs lifecycle diagnostics before loading the main process', () => {
  const bootstrap = fs.readFileSync(path.join(__dirname, '..', 'main-bootstrap.js'), 'utf8');
  const installAt = bootstrap.indexOf('installProcessLifecycleJournal({ app, BrowserWindow })');
  const mainAt = bootstrap.indexOf("require('./main.js')");
  assert.ok(installAt >= 0, 'bootstrap must install the lifecycle journal');
  assert.ok(mainAt > installAt, 'journal must be live before main.js can fail');
  assert.match(bootstrap, /catch \(error\)[\s\S]*__hubLifecycleJournalInstallError/);
});
