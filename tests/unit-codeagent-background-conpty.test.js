'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('CodeAgent PTYs start without a renderer cursor reply on every launch path', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-codeagent-conpty-'));
  const env = {
    CLAUDE_HUB_DATA_DIR: path.join(root, 'data'),
    CLAUDE_HUB_HOME_DIR: path.join(root, 'home'),
    CODEAGENT3_CONFIG_DIR: path.join(root, 'codeagent'),
    AI_HUB_CODEAGENT_CONFIG_DIR: path.join(root, 'codeagent'),
    AI_HUB_CODEAGENT_COMMAND: 'codeagent',
    CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
    CODEX_HOME: path.join(root, 'codex'),
  };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  for (const dir of Object.values(env).filter(value => path.isAbsolute(value))) fs.mkdirSync(dir, { recursive: true });
  Object.assign(process.env, env);
  require('../core/hub-config').clearConfigCache();
  const pty = require('node-pty');
  const launches = [];
  t.mock.method(pty, 'spawn', (file, args, options) => {
    const fake = { pid: 424242, onData() { return { dispose() {} }; },
      onExit() { return { dispose() {} }; }, write() {}, resize() {}, kill() {} };
    launches.push({ file, options });
    return fake;
  });
  const { SessionManager } = require('../core/session-manager');
  const manager = new SessionManager();
  t.after(() => {
    manager.dispose();
    manager.openOwners?.close();
    require('../core/hub-config').clearConfigCache();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    const relative = path.relative(os.tmpdir(), root);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('unsafe test cleanup');
    fs.rmSync(root, { recursive: true, force: true });
  });
  const nativeId = 'ce2b2941-1234-4567-89ab-123456789abc';
  for (const [label, kind, opts] of [
    ['new card', 'codeagent', {}],
    ['background resume', 'codeagent', { purpose: 'company-bridge', resumeCCSessionId: nativeId }],
    ['resume kind', 'codeagent-resume', { resumeCCSessionId: nativeId }],
    ['old caller explicitly requested inheritance', 'codeagent', { noInheritCursor: false }],
  ]) {
    await t.test(label, () => {
      manager.createSession(kind, { cwd: root, ...opts });
      assert.equal(launches.at(-1).file, 'powershell.exe');
      assert.equal(launches.at(-1).options.conptyInheritCursor, false,
        'no terminal is attached in card/background mode; ConPTY must not wait for ESC[6n response');
    });
  }
  await t.test('plain terminal keeps its existing cursor policy', () => {
    manager.createSession('powershell', { cwd: root });
    assert.equal(launches.at(-1).options.conptyInheritCursor, true);
    manager.createSession('powershell', { cwd: root, noInheritCursor: true });
    assert.equal(launches.at(-1).options.conptyInheritCursor, false);
  });
});
