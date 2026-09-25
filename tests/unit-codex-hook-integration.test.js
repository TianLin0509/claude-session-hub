'use strict';
// PTY Codex 的 hook 部署：信任 hash 必须与 Codex 源码算法逐字节一致，
// 否则 Codex 会静默跳过这些 hook，状态退化成只能看 rollout。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { codexHookTrustHash, upsertTrustedHashes, ensureCodexHookIntegration, HUB_CODEX_HOOKS, hookArg }
  = require('../core/codex-hook-integration');

// 真实 ~/.codex/config.toml 里 Codex 自己写下的 trusted_hash（2026-09-25 取样，codex-cli 0.153.4）。
const REAL_COMMAND = 'python "C:\\Users\\lintian\\.claude\\scripts\\session-hub-hook.py" prompt';
const REAL_HASH = 'sha256:4cc2805cb4824c75264fceb05103e61061b1349854c7737849a6a3c757b670d3';
const REAL_BASH_GUARD = 'python "C:\\Users\\lintian\\.claude\\scripts\\unified_bash_guard.py"';
const REAL_BASH_GUARD_HASH = 'sha256:5d59e554a1bdd2e1641695f235e99e9a5d1c0548f633710491d5d518788496b0';

test('trust hash reproduces the hashes Codex itself persisted', () => {
  assert.equal(codexHookTrustHash('user_prompt_submit', undefined, { type: 'command', command: REAL_COMMAND, timeout: 5 }), REAL_HASH);
  assert.equal(codexHookTrustHash('pre_tool_use', 'Bash', { type: 'command', command: REAL_BASH_GUARD, timeout: 10,
    statusMessage: 'Checking guards...' }), REAL_BASH_GUARD_HASH);
  // async、timeout 都进入身份：改了任何一项，旧的信任必须失效。
  assert.notEqual(codexHookTrustHash('user_prompt_submit', undefined, { command: REAL_COMMAND, timeout: 5, async: true }), REAL_HASH);
  assert.notEqual(codexHookTrustHash('user_prompt_submit', undefined, { command: REAL_COMMAND, timeout: 6 }), REAL_HASH);
});

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hooks-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
function fakeScript(home) {
  const file = path.join(home, 'src-session-hub-hook.py');
  fs.writeFileSync(file, 'print("hub")\n');
  return file;
}

test('deploys every Hub event once, keeps user hooks, and trusts only Hub entries', t => {
  const home = tempHome(t);
  const userHooks = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'python guard.py', timeout: 10 }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'python "C:\\x\\session-hub-hook.py" stop', timeout: 5 }] }] } };
  fs.writeFileSync(path.join(home, 'hooks.json'), JSON.stringify(userHooks));
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-5.5"\r\n\r\n[features]\r\nhooks = true\r\n');
  const result = ensureCodexHookIntegration({ codexHome: home, sourceScript: fakeScript(home), logger: {} });
  assert.deepEqual(result.errors, []);
  const hooks = JSON.parse(fs.readFileSync(path.join(home, 'hooks.json'), 'utf8')).hooks;
  assert.equal(hooks.PreToolUse[0].hooks[0].command, 'python guard.py', 'user hook preserved in place');
  for (const [eventName, , arg] of HUB_CODEX_HOOKS) {
    const managed = hooks[eventName].flatMap(group => group.hooks).filter(h => /session-hub-hook/.test(h.command) && hookArg(h.command) === arg);
    assert.equal(managed.length, 1, `${eventName} has exactly one Hub handler`);
  }
  // 已存在的 Stop 条目被复用，没有重复部署。
  assert.equal(hooks.Stop.length, 1);
  const config = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
  assert.ok(config.startsWith('model = "gpt-5.5"\r\n\r\n[features]\r\nhooks = true\r\n'), 'existing text untouched');
  assert.ok(!config.includes(':pre_tool_use:0:0'), 'the user guard is never trusted by Hub');
  assert.ok(config.includes(`[hooks.state.'${path.join(home, 'hooks.json')}:stop:0:0']`));
  const stopHash = codexHookTrustHash('stop', undefined, hooks.Stop[0].hooks[0]);
  assert.ok(config.includes(`trusted_hash = "${stopHash}"`));
  // 幂等：第二次什么都不改。
  const again = ensureCodexHookIntegration({ codexHome: home, sourceScript: fakeScript(home), logger: {} });
  assert.equal(again.hooksChanged, false);
  assert.equal(again.trustChanged, false);
});

test('a stale trusted_hash is replaced in place and enabled=false is respected', () => {
  const header = "[hooks.state.'C:\\h\\hooks.json:stop:0:0']";
  const text = `a = 1\n\n[hooks.state]\n\n${header}\nenabled = false\ntrusted_hash = "sha256:old"\n\n[projects.'c:\\x']\ntrust_level = "trusted"\n`;
  const next = upsertTrustedHashes(text, [{ key: 'C:\\h\\hooks.json:stop:0:0', hash: 'sha256:new' }]);
  assert.equal(next.changed, true);
  assert.ok(next.text.includes(`${header}\nenabled = false\ntrusted_hash = "sha256:new"\n`));
  assert.ok(next.text.endsWith(`[projects.'c:\\x']\ntrust_level = "trusted"\n`));
  assert.equal(upsertTrustedHashes(next.text, [{ key: 'C:\\h\\hooks.json:stop:0:0', hash: 'sha256:new' }]).changed, false);
});

test('a malformed hooks.json is reported, never overwritten', t => {
  const home = tempHome(t);
  fs.writeFileSync(path.join(home, 'hooks.json'), '{ not json');
  const result = ensureCodexHookIntegration({ codexHome: home, sourceScript: fakeScript(home), logger: {} });
  assert.equal(result.errors.length, 1);
  assert.equal(fs.readFileSync(path.join(home, 'hooks.json'), 'utf8'), '{ not json');
});
