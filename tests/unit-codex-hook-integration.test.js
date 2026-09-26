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

// ---- TOML 语义（返工 R3）：同一个表的等价写法必须认出来，不能重复声明、不能写坏配置 ----
const { parseTomlWithPython } = require('../core/codex-hook-integration');
const { scanTomlStatements } = require('../core/toml-statements');

test('reviewer repro: a basic-quoted header Codex may write is the same table; redeploy keeps TOML valid', t => {
  const home = tempHome(t);
  const script = fakeScript(home);
  ensureCodexHookIntegration({ codexHome: home, sourceScript: script, logger: {} });
  const file = path.join(home, 'config.toml');
  const basic = fs.readFileSync(file, 'utf8').replace(/\[hooks\.state\.'([^']+)'\]/g, (_, key) => '[hooks.state.' + JSON.stringify(key) + ']');
  fs.writeFileSync(file, basic);
  const before = parseTomlWithPython(basic);
  const again = ensureCodexHookIntegration({ codexHome: home, sourceScript: script, logger: {} });
  assert.deepEqual(again.errors, []);
  assert.equal(again.trustChanged, false, 'equivalent header recognised, nothing rewritten');
  assert.equal(fs.readFileSync(file, 'utf8'), basic);
  assert.deepEqual(parseTomlWithPython(fs.readFileSync(file, 'utf8')), before);
});

test('spaces around dots, escapes, comments: stale hash is updated in place and the comment survives', () => {
  const key = 'C:\\h\\hooks.json:stop:0:0';
  const text = [
    'model = "x" # 用户注释',
    '[ hooks . state . "C:\\\\h\\\\hooks.json:stop:0:0" ]  # Codex 写的',
    'enabled = false',
    'trusted_hash = "sha256:old" # 旧值',
    '',
    '[hooks.state."C:\\\\h\\\\hooks.json:prompt:0:0"]',
    'trusted_hash = "sha256:keep"',
    '',
  ].join('\n');
  const next = upsertTrustedHashes(text, [{ key, hash: 'sha256:new' }, { key: 'C:\\h\\hooks.json:prompt:0:0', hash: 'sha256:keep' }]);
  assert.equal(next.changed, true);
  assert.deepEqual(next.skipped, []);
  assert.ok(next.text.includes('trusted_hash = "sha256:new" # 旧值'));
  const doc = parseTomlWithPython(next.text);
  assert.deepEqual(doc.hooks.state[key], { enabled: false, trusted_hash: 'sha256:new' });
  assert.equal(doc.hooks.state['C:\\h\\hooks.json:prompt:0:0'].trusted_hash, 'sha256:keep');
  assert.equal(doc.model, 'x');
});

test('entries written as dotted keys or inline tables are left alone and reported, never duplicated', t => {
  const home = tempHome(t);
  const script = fakeScript(home);
  const hooksPath = path.join(home, 'hooks.json');
  ensureCodexHookIntegration({ codexHome: home, sourceScript: script, logger: {} });
  const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8')).hooks;
  const stopKey = `${hooksPath}:stop:0:0`;
  const stopHash = codexHookTrustHash('stop', undefined, hooks.Stop[0].hooks[0]);
  // 同一份信任用点号键写在 [hooks.state] 下（合法 TOML），其余条目也改成点号写法但值过期。
  const others = HUB_CODEX_HOOKS.filter(([name]) => name !== 'Stop')
    .map(([name, label]) => `${JSON.stringify(`${hooksPath}:${label}:0:0`)}.trusted_hash = "sha256:stale-${name}"`);
  const text = `[hooks.state]\n${JSON.stringify(stopKey)}.trusted_hash = "${stopHash}"\n${others.join('\n')}\n`;
  fs.writeFileSync(path.join(home, 'config.toml'), text);
  const result = ensureCodexHookIntegration({ codexHome: home, sourceScript: script, logger: {} });
  assert.equal(result.trustChanged, false);
  assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), text, 'file untouched');
  assert.equal(result.untrusted.length, HUB_CODEX_HOOKS.length);
  assert.match(result.errors.join(), /手动信任/);
  parseTomlWithPython(text);
});

test('an unparsable config.toml is never rewritten', t => {
  const home = tempHome(t);
  const bad = '[hooks.state\ntrusted_hash = 1\n';
  fs.writeFileSync(path.join(home, 'config.toml'), bad);
  const result = ensureCodexHookIntegration({ codexHome: home, sourceScript: fakeScript(home), logger: {} });
  assert.equal(result.errors.length, 1);
  assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), bad);
});

test('the write is gated on a semantic diff: any unexpected change aborts the write', t => {
  const home = tempHome(t);
  const original = 'model = "x"\n';
  fs.writeFileSync(path.join(home, 'config.toml'), original);
  let calls = 0;
  const lyingParser = text => { calls += 1; const doc = parseTomlWithPython(text); if (calls === 2) doc.model = 'changed'; return doc; };
  const result = ensureCodexHookIntegration({ codexHome: home, sourceScript: fakeScript(home), logger: {}, parseToml: lyingParser });
  assert.equal(result.trustChanged, false);
  assert.match(result.errors.join(), /语义与预期不一致/);
  assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), original);
});

test('scanner skips values that look like headers: multi-line strings and arrays', () => {
  const text = [
    'notes = """',
    '[hooks.state.\'fake\']',
    'trusted_hash = "x"',
    '"""',
    'arr = [',
    '  [1, 2], # nested',
    '  "]",',
    ']',
    "[hooks.state.'real']",
    'trusted_hash = "y"',
  ].join('\r\n');
  const tables = scanTomlStatements(text).statements.filter(s => s.kind === 'table');
  assert.deepEqual(tables.map(s => s.path), [['hooks', 'state', 'real']]);
  const next = upsertTrustedHashes(text, [{ key: 'fake', hash: 'sha256:z' }]);
  const doc = parseTomlWithPython(next.text);
  assert.equal(doc.notes.includes("[hooks.state.'fake']"), true, 'string content untouched');
  assert.equal(doc.hooks.state.fake.trusted_hash, 'sha256:z');
});
