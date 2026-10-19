'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const cp = require('node:child_process'), { EventEmitter } = require('node:events');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-auth-background-'));
  fs.writeFileSync(path.join(root, '.credentials.json'), JSON.stringify({ idaasOAuth: { accountId: 'fixture', xAuthToken: 'fixture-encrypted-token', expiresAt: 4e12 } }));
  const values = { CLAUDE_HUB_DATA_DIR: path.join(root, 'hub'), AI_HUB_CODEAGENT_CONFIG_DIR: root,
    CODEAGENT3_X_AUTH_TOKEN: 'fixture-parent-token', TOOL_GUARD_CODEAGENT3_DATA_DIR: 'fixture-guard' };
  const old = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}
function check(env, dir) {
  assert.equal(env.CODEAGENT3_CONFIG_DIR, dir);
  assert.equal(env.CODEAGENT3_X_AUTH_TOKEN, undefined);
  assert.equal(env.TOOL_GUARD_CODEAGENT3_DATA_DIR, 'fixture-guard');
  assert.equal(process.env.CODEAGENT3_X_AUTH_TOKEN, 'fixture-parent-token');
}

test('background title subprocess authenticates with the selected personal profile', async t => {
  const dir = setup(t); let seen;
  t.mock.method(cp, 'spawn', (_cmd, options) => {
    seen = options.env;
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    queueMicrotask(() => { child.stdout.emit('data', '标题：测试标题'); child.emit('close', 0); });
    return child;
  });
  const modulePath = require.resolve('../main/auto-title-manager');
  delete require.cache[modulePath]; t.after(() => delete require.cache[modulePath]);
  const manager = require(modulePath).createAutoTitleManager({ allAiKinds: [], getHubConfig: () => ({}) });
  assert.equal(await manager.generateTitleViaCodeAgent('fixture prompt'), '测试标题');
  check(seen, dir);
});

test('version diagnostic subprocess uses the selected profile without exposing parent auth', async t => {
  const dir = setup(t); let seen;
  t.mock.method(cp, 'execFile', (_command, _args, options, callback) => {
    seen = options.env; queueMicrotask(() => callback(null, '1.2615.02.01', ''));
    return { pid: 0, kill() {} };
  });
  const sys = require('../core/company-bridge/diag').defaultSys();
  assert.equal(await sys.codeagentVersion('auth-fixture-version'), '1.2615.02.01');
  check(seen, dir);
});

test('relaunch on a node-pty terminal without options.env does not mutate the Hub parent environment', t => {
  const dir = setup(t), before = { ...process.env }, writes = [];
  const { SessionManager } = require('../core/session-manager');
  const info = { id: 'auth-relaunch', kind: 'codeagent', cwd: dir, codeagentConfigDir: dir, purpose: 'company-bridge' };
  const manager = { sessions: new Map([[info.id, { info, pty: { write: text => writes.push(text) } }]]),
    hubRulesSystemPrompt: () => null, emit() {} };
  assert.equal(SessionManager.prototype.relaunchCli.call(manager, info.id), true);
  assert.equal(writes.length, 1);
  assert.match(writes[0], /codeagent/);
  assert.deepEqual({ ...process.env }, before);
});
