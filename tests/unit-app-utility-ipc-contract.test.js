'use strict';

const assert = require('assert');
const { createSystemResourceSampler, registerAppUtilityIpc, saveClipboardImage } = require('../main/ipc/app-utility-handlers.js');

function createFakeIpc() {
  return {
    handlers: new Map(),
    listeners: new Map(),
    handle(channel, fn) {
      this.handlers.set(channel, fn);
    },
    on(channel, fn) {
      this.listeners.set(channel, fn);
    },
  };
}

function createDeps(overrides = {}) {
  const calls = [];
  const image = {
    isEmpty() { return false; },
    toPNG() { return Buffer.from('png'); },
  };
  const mainWindow = {
    isFocused() { calls.push(['isFocused']); return true; },
    show() { calls.push(['show']); },
    focus() { calls.push(['focus']); },
  };

  return {
    calls,
    clipboard: {
      readImage() { calls.push(['readImage']); return image; },
    },
    crypto: {
      randomBytes(size) { calls.push(['randomBytes', size]); return Buffer.from([0xab, 0xcd, 0xef]); },
    },
    fs: {
      mkdirSync(dir, opts) { calls.push(['mkdirSync', dir, opts]); },
      writeFileSync(filePath, data) { calls.push(['writeFileSync', filePath, data.toString()]); },
    },
    getHookPort: () => 3456,
    getMainWindow: () => mainWindow,
    getNetworkEgressStatus: async () => ({ checkedAt: 1, foreign: { ok: true }, domestic: { ok: true } }),
    acknowledgeNetworkEgressChange: async () => ({ ok: true }),
    imageDir: 'C:\\hub\\images',
    logger: { warn: (msg) => calls.push(['warn', msg]) },
    path: {
      join(...parts) { return parts.join('\\'); },
    },
    ...overrides,
  };
}

function test(name, fn) {
  try {
    fn();
    console.log(`  OK ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

console.log('Running app utility IPC contract tests...');

test('registers utility channels', () => {
  const ipc = createFakeIpc();
  const deps = createDeps();
  registerAppUtilityIpc(ipc, deps);

  assert.ok(!ipc.listeners.has('show-notification'), 'native toast IPC must stay disabled');
  assert.ok(ipc.handlers.has('is-window-focused'));
  assert.ok(ipc.handlers.has('save-clipboard-image'));
  assert.ok(ipc.handlers.has('get-hook-status'));
  assert.ok(ipc.handlers.has('get-system-resource-usage'));
  assert.ok(ipc.handlers.has('get-network-egress-status'));
  assert.ok(ipc.handlers.has('acknowledge-network-egress-change'));
});

test('system resource sampler reports CPU delta and memory usage', () => {
  const cpuSnapshots = [
    [{ times: { user: 40, nice: 0, sys: 10, idle: 50, irq: 0 } }],
    [{ times: { user: 70, nice: 0, sys: 20, idle: 110, irq: 0 } }],
  ];
  const fakeOs = {
    cpus: () => cpuSnapshots.shift(),
    totalmem: () => 1000,
    freemem: () => 350,
  };
  const result = createSystemResourceSampler(fakeOs)();

  assert.strictEqual(result.cpuPct, 40);
  assert.strictEqual(result.memoryPct, 65);
  assert.ok(Number.isFinite(result.sampledAt));
});

test('saveClipboardImage writes a timestamped png and returns its path', () => {
  const deps = createDeps();
  const filePath = saveClipboardImage(deps);

  assert.ok(filePath.startsWith('C:\\hub\\images\\'));
  assert.ok(filePath.endsWith('-abcdef.png'));
  assert.ok(deps.calls.some(call => call[0] === 'mkdirSync' && call[1] === 'C:\\hub\\images'));
  assert.ok(deps.calls.some(call => call[0] === 'writeFileSync' && call[1] === filePath));
});

test('saveClipboardImage returns null for empty image', () => {
  const deps = createDeps({
    clipboard: {
      readImage() {
        return { isEmpty: () => true };
      },
    },
  });

  assert.strictEqual(saveClipboardImage(deps), null);
  assert.ok(!deps.calls.some(call => call[0] === 'writeFileSync'));
});

test('registered handlers report focus and hook status', () => {
  const ipc = createFakeIpc();
  const deps = createDeps();
  registerAppUtilityIpc(ipc, deps);

  assert.strictEqual(ipc.handlers.get('is-window-focused')(), true);
  assert.deepStrictEqual(ipc.handlers.get('get-hook-status')(), { up: true, port: 3456 });
});

console.log('All app utility IPC contract tests passed.');
