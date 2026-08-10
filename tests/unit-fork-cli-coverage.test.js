'use strict';
// 分支（fork）的 CLI 覆盖面。
// New DeepSeek sessions use `codex fork`; pre-migration sessions retain the
// Claude `--fork-session` path so existing history remains branchable.
// Kimi 则确实没有 fork 能力 —— `kimi --help` 只有 `-S/--session`（恢复）和
// `-c/--continue`，没有任何 fork 子命令或 flag（2026-07-27 实测）。
// 所以"不支持 Kimi 分支"是 CLI 的能力边界，必须给出准确原因而不是笼统拒绝。

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const IPC_SRC = fs.readFileSync(path.join(__dirname, '..', 'main', 'ipc', 'session-handlers.js'), 'utf8');
const MANAGER_SRC = fs.readFileSync(path.join(__dirname, '..', 'core', 'session-manager.js'), 'utf8');
const CAP_SRC = fs.readFileSync(path.join(__dirname, '..', 'core', 'session-capabilities.js'), 'utf8');

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

console.log('Running fork CLI coverage tests...');

test('DeepSeek fork runtime is selected from the persisted native id', () => {
  assert.match(IPC_SRC, /const isDeepSeek = source\.kind === 'deepseek' \|\| source\.kind === 'deepseek-resume'/);
  assert.match(IPC_SRC, /const runtimeKind = runtimeKindForSession\(source\)/);
  assert.match(IPC_SRC, /const providerFamily = sessionProviderFamily\(source\)/);
  assert.match(IPC_SRC, /if \(!supportsForkSession\(source\)\)/,
    'the shared capability gate must accept current Codex and legacy Claude-backed DeepSeek sessions');
  assert.match(CAP_SRC, /baseKind\(kind\) === 'deepseek' && session\.ccSessionId && !session\.codexSid/,
    'the capability authority must distinguish legacy DeepSeek by its persisted native id');
});

test('a DeepSeek fork spawns as deepseek, not as claude', () => {
  assert.match(
    IPC_SRC,
    /kind = isDeepSeek \? 'deepseek' : 'claude';/,
    'forking legacy DeepSeek must keep its public DeepSeek identity',
  );
  assert.match(IPC_SRC, /opts\.forkCCSessionId = nativeSessionId;/);
  assert.match(IPC_SRC, /kind = isDeepSeek \? 'deepseek' : 'codex';/,
    'forking current DeepSeek must keep DeepSeek branding on the Codex runtime');
  assert.match(IPC_SRC, /opts\.codexForkSid = nativeSessionId;/);
});

test('the native session id comes from ccSessionId for every claude-CLI kind', () => {
  assert.match(IPC_SRC, /const identity = nativeSessionIdentity\(source\)/);
  assert.match(IPC_SRC, /const nativeSessionId = identity && identity\.value;/);
  assert.match(CAP_SRC, /family === 'claude'[\s\S]{0,80}'ccSessionId'/);
});

test('session-manager builds both current Codex and legacy Claude DeepSeek forks', () => {
  assert.match(
    MANAGER_SRC,
    /cmd = ` codex fork \$\{opts\.codexForkSid\} --dangerously-bypass-approvals-and-sandbox --model \$\{codexModel\}/,
    'new DeepSeek branches must use codex fork',
  );
  assert.match(
    MANAGER_SRC,
    /if \(opts\.forkCCSessionId\) \{[\s\S]{0,400}claude --resume \$\{opts\.forkCCSessionId\} --fork-session --model \$\{model\} --permission-mode bypassPermissions/,
    'DeepSeek fork must reuse the claude CLI fork flag and keep bypassPermissions',
  );
  // The bounded regex above also pins forkCCSessionId ahead of the resume cases
  // inside the legacy command block without depending on unrelated earlier guards.
});

test('Kimi is rejected with the real reason, not a generic refusal', () => {
  assert.match(IPC_SRC, /Kimi CLI 无 fork 能力/,
    'the error must state why Kimi cannot branch so the user does not think it is a Hub bug');
  assert.match(IPC_SRC, /仅支持 Claude Code、DeepSeek 和 Codex 会话创建分支/);
  // 防回归：别哪天把 kimi 塞进 fork 分支——它的 CLI 根本不接受 fork 参数
  assert.doesNotMatch(IPC_SRC, /isKimiCliKind\(source\.kind\)[\s\S]{0,120}forkCCSessionId/);
});

test('fork still inherits model and effort for every supported kind', () => {
  assert.match(IPC_SRC, /if \(source\.currentModel && source\.currentModel\.id\) opts\.model = source\.currentModel\.id;/);
  assert.match(IPC_SRC, /if \(source\.effort\) opts\.effort = source\.effort;/);
});

if (!process.exitCode) console.log('All fork CLI coverage tests passed.');
