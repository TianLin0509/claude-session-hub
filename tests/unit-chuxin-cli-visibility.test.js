'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { ChuxinSessionRegistry } = require('../core/chuxin-session-registry.js');
const { MODEL_OPTIONS_BY_KIND, DEFAULT_MODEL_BY_KIND } = require('../core/model-options.js');
const { CHUXIN_DEFAULT_MODEL_BY_KIND, modelCatalog, registerChuxinIpc, resumeOptions, validateProviderModel } = require('../main/ipc/chuxin-handlers.js');

function test(name, fn) {
  try {
    fn();
    console.log(`  OK ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}`);
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

console.log('Running Chuxin native PTY tests...');

test('research model picker consumes the Hub catalog instead of a private list', () => {
  const catalog = modelCatalog();
  assert.deepStrictEqual(catalog.map((row) => row.provider), ['codex-cli', 'claude-cli', 'kimi-cli']);
  for (const row of catalog) {
    assert.strictEqual(row.defaultModel, CHUXIN_DEFAULT_MODEL_BY_KIND[row.kind] || DEFAULT_MODEL_BY_KIND[row.kind]);
    assert.deepStrictEqual(row.models, MODEL_OPTIONS_BY_KIND[row.kind]);
    assert.strictEqual(validateProviderModel(row.provider, row.defaultModel).ok, true);
  }
  assert.strictEqual(validateProviderModel('codex-cli', 'made-up-model').ok, false);
  assert.deepStrictEqual(CHUXIN_DEFAULT_MODEL_BY_KIND, {
    codex: 'gpt-5.6-sol',
    claude: 'claude-opus-4-8[1m]',
    kimi: 'kimi-code/k3',
  });
});

test('closing a running native PTY releases its global writer lease', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chuxin-exit-'));
  const previous = process.env.CHUXIN_GLOBAL_SESSION_DIR;
  process.env.CHUXIN_GLOBAL_SESSION_DIR = root;
  try {
    const sessionManager = new EventEmitter();
    const sent = [];
    const bridge = registerChuxinIpc({ handle() {} }, {
      sessionManager,
      sendToRenderer: (channel, payload) => sent.push({ channel, payload }),
    });
    const id = bridge.registry.createId();
    bridge.registry.upsert(id, { provider: 'codex-cli', kind: 'codex', model: 'gpt-5.6-sol' });
    const lease = bridge.registry.claim(id, { ownerHub: 'test' });
    const leaseTimer = setInterval(() => {}, 60_000);
    leaseTimer.unref?.();
    bridge.ownershipByHubSession.set('hub-native-1', {
      researchSessionId: id,
      leaseToken: lease.token,
      leaseTimer,
    });
    bridge.pendingByHubSession.set('hub-native-1', {
      runId: 'spirit-analysis-test',
      researchSessionId: id,
    });
    assert.strictEqual(bridge.isAuthorizedResearchScope(`chuxin-${id}`), true);
    assert.strictEqual(bridge.isAuthorizedResearchScope('meeting-not-chuxin'), false);
    sessionManager.emit('session-exited', { sessionId: 'hub-native-1' });
    assert.strictEqual(bridge.pendingByHubSession.has('hub-native-1'), false);
    assert.strictEqual(bridge.ownershipByHubSession.has('hub-native-1'), false);
    assert.strictEqual(bridge.registry.lease(id), null);
    assert.strictEqual(bridge.isAuthorizedResearchScope(`chuxin-${id}`), false);
    assert.strictEqual(bridge.registry.get(id).status, 'interrupted');
    assert.strictEqual(sent.at(-1).channel, 'chuxin:task-failed');
  } finally {
    if (previous === undefined) delete process.env.CHUXIN_GLOBAL_SESSION_DIR;
    else process.env.CHUXIN_GLOBAL_SESSION_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('global logical sessions survive a second registry instance and enforce a writer lease', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chuxin-registry-'));
  try {
    const first = new ChuxinSessionRegistry({ root });
    const id = first.createId();
    first.upsert(id, { provider: 'codex-cli', kind: 'codex', model: 'gpt-5.6-sol', title: '投研测试' });
    const second = new ChuxinSessionRegistry({ root });
    assert.strictEqual(second.get(id).model, 'gpt-5.6-sol');
    assert.strictEqual(second.list().length, 1);
    const lease = first.claim(id, { ownerHub: 'hub-a' });
    assert.strictEqual(lease.ok, true);
    assert.strictEqual(second.claim(id, { ownerHub: 'hub-b' }).ok, false);
    assert.strictEqual(second.renew(id, lease.token), true);
    assert.strictEqual(second.lease(id).token, lease.token);
    assert.strictEqual(first.release(id, lease.token), true);
    assert.strictEqual(second.lease(id), null);
    assert.strictEqual(second.claim(id, { ownerHub: 'hub-b' }).ok, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Hub shutdown releases every native research lease synchronously', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chuxin-shutdown-'));
  const previous = process.env.CHUXIN_GLOBAL_SESSION_DIR;
  process.env.CHUXIN_GLOBAL_SESSION_DIR = root;
  try {
    const bridge = registerChuxinIpc({ handle() {} }, { sessionManager: new EventEmitter() });
    for (const suffix of ['a', 'b']) {
      const id = `research-shutdown-${suffix}`;
      bridge.registry.upsert(id, { provider: 'codex-cli', kind: 'codex', model: 'gpt-5.6-sol' });
      const lease = bridge.registry.claim(id, { ownerHub: 'test' });
      bridge.ownershipByHubSession.set(`hub-${suffix}`, { researchSessionId: id, leaseToken: lease.token });
    }
    bridge.releaseAllOwnership();
    assert.strictEqual(bridge.ownershipByHubSession.size, 0);
    assert.strictEqual(bridge.registry.lease('research-shutdown-a'), null);
    assert.strictEqual(bridge.registry.lease('research-shutdown-b'), null);
  } finally {
    if (previous === undefined) delete process.env.CHUXIN_GLOBAL_SESSION_DIR;
    else process.env.CHUXIN_GLOBAL_SESSION_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex, Claude and Kimi records map to precise native resume options', () => {
  assert.deepStrictEqual(resumeOptions({ kind: 'codex', nativeSession: { codexSid: 'codex-id' } }), { useResume: true, codexSid: 'codex-id' });
  assert.deepStrictEqual(resumeOptions({ kind: 'claude', nativeSession: { ccSessionId: 'claude-id' } }), { resumeCCSessionId: 'claude-id' });
  assert.deepStrictEqual(resumeOptions({ kind: 'kimi', nativeSession: { kimiSid: 'kimi-id', kimiSessionDir: 'dir' } }), { useResume: true, kimiSid: 'kimi-id', kimiSessionDir: 'dir' });
});

test('renderer embeds one native PTY inside Chuxin and excludes it from the sidebar', () => {
  const root = path.join(__dirname, '..');
  const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
  const list = fs.readFileSync(path.join(root, 'renderer', 'session-list-renderer.js'), 'utf8');
  const chuxin = fs.readFileSync(path.join(root, 'renderer', 'chuxin.js'), 'utf8');
  const shortcuts = fs.readFileSync(path.join(root, 'renderer', 'keyboard-shortcuts.js'), 'utf8');
  assert.match(renderer, /__chuxinSessionBridge/);
  assert.match(renderer, /purpose === 'chuxin-research'/);
  assert.match(list, /s\.purpose !== 'chuxin-research'/);
  assert.match(shortcuts, /session\.purpose !== 'chuxin-research'/);
  assert.match(chuxin, /chuxin:run-agent-task/);
  assert.match(chuxin, /chuxin:model-catalog/);
  assert.match(chuxin, /cx-native-terminal/);
  assert.doesNotMatch(chuxin, /chuxin:attach-run-session/);
  assert.doesNotMatch(list, /appendSecHeader\('投研任务'/);
});

test('Chuxin exposes one five-item product nav and suppresses the embedded app nav', () => {
  const root = path.join(__dirname, '..');
  const chuxin = fs.readFileSync(path.join(root, 'renderer', 'chuxin.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'renderer', 'chuxin.css'), 'utf8');
  const frontendRoot = path.join(root, '..', 'chuxin-research', 'frontend');
  const embeddedApp = fs.readFileSync(path.join(frontendRoot, 'app.js'), 'utf8');
  const embeddedStyles = fs.readFileSync(path.join(frontendRoot, 'styles.css'), 'utf8');
  const primaryBlock = chuxin.match(/const PRIMARY_TABS = \[([\s\S]*?)\n  \];/);

  assert(primaryBlock, 'PRIMARY_TABS declaration is missing');
  assert.deepStrictEqual(
    [...primaryBlock[1].matchAll(/label: '([^']+)'/g)].map((match) => match[1]),
    ['观察', 'AI群聊', '持有', '英雄大厅', '今日感悟'],
  );
  assert.match(chuxin, /cx-primary-nav/);
  assert.match(chuxin, /cx-open-developer/);
  assert.match(chuxin, /&embed=hub#/);
  assert.doesNotMatch(chuxin, /className = 'cx-tabs'/);
  assert.doesNotMatch(chuxin, /label: '开发者'/);
  assert.match(styles, /\.cx-primary-nav/);
  assert.doesNotMatch(styles, /\.cx-tabs\s*\{/);
  assert.match(embeddedApp, /query\.get\("embed"\) === "hub"/);
  assert.match(embeddedStyles, /html\.hub-embed \.topbar/);
  assert.match(embeddedStyles, /html\.hub-embed \.mobile-nav/);
});

test('backend launcher polls readiness and exposes actionable startup errors', () => {
  const root = path.join(__dirname, '..');
  const handler = fs.readFileSync(path.join(root, 'main', 'ipc', 'chuxin-handlers.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer', 'chuxin.js'), 'utf8');
  const runScript = fs.readFileSync(path.join(root, '..', 'chuxin-research', 'run.ps1'), 'utf8');
  assert.match(handler, /stdio: \['ignore', 'pipe', 'pipe'\]/);
  assert.match(handler, /waitHealthy\(45000\)/);
  assert.match(handler, /launcher\.log/);
  assert.match(renderer, /cx-start-error/);
  assert.match(renderer, /投研后端启动失败/);
  assert.match(runScript, /StartupTimeoutSeconds = 35/);
  assert.match(runScript, /Only publish run-state after both processes are proven healthy/);
  assert.doesNotMatch(runScript, /Start-Sleep -Milliseconds 900/);
});

console.log('All Chuxin native PTY tests passed.');
