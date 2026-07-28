'use strict';
// 分支（fork）的 CLI 覆盖面。
// DeepSeek 跑的就是 claude CLI，--fork-session 一直可用，只是 Hub 没接线；
// Kimi 则确实没有 fork 能力 —— `kimi --help` 只有 `-S/--session`（恢复）和
// `-c/--continue`，没有任何 fork 子命令或 flag（2026-07-27 实测）。
// 所以"不支持 Kimi 分支"是 CLI 的能力边界，必须给出准确原因而不是笼统拒绝。

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const IPC_SRC = fs.readFileSync(path.join(__dirname, '..', 'main', 'ipc', 'session-handlers.js'), 'utf8');
const MANAGER_SRC = fs.readFileSync(path.join(__dirname, '..', 'core', 'session-manager.js'), 'utf8');

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

test('DeepSeek is accepted as a claude-CLI fork source', () => {
  assert.match(IPC_SRC, /const isDeepSeek = source\.kind === 'deepseek' \|\| source\.kind === 'deepseek-resume'/);
  assert.match(IPC_SRC, /const isClaudeCli = isClaude \|\| isDeepSeek/);
  assert.match(IPC_SRC, /if \(!isClaudeCli && !isCodex\)/,
    'the gate must accept every claude-CLI backed kind, not just claude');
});

test('a DeepSeek fork spawns as deepseek, not as claude', () => {
  assert.match(
    IPC_SRC,
    /kind = isDeepSeek \? 'deepseek' : 'claude';/,
    'forking DeepSeek must keep the DeepSeek backend (own CLAUDE_CONFIG_DIR / base URL)',
  );
  assert.match(IPC_SRC, /opts\.forkCCSessionId = nativeSessionId;/);
});

test('the native session id comes from ccSessionId for every claude-CLI kind', () => {
  assert.match(IPC_SRC, /const nativeSessionId = isClaudeCli \? source\.ccSessionId : source\.codexSid;/);
});

test('session-manager builds a --fork-session command for DeepSeek', () => {
  assert.match(
    MANAGER_SRC,
    /if \(opts\.forkCCSessionId\) \{[\s\S]{0,400}claude --resume \$\{opts\.forkCCSessionId\} --fork-session --model \$\{model\} --permission-mode bypassPermissions/,
    'DeepSeek fork must reuse the claude CLI fork flag and keep bypassPermissions',
  );
  // 该分支必须排在 deepseek-resume / resumeCCSessionId 之前，否则永远走不到
  const deepSeekBlock = MANAGER_SRC.slice(MANAGER_SRC.indexOf('if (isDeepSeek) {'));
  const forkAt = deepSeekBlock.indexOf('opts.forkCCSessionId');
  const resumeAt = deepSeekBlock.indexOf("kind === 'deepseek-resume'");
  assert.ok(forkAt > 0 && resumeAt > forkAt, 'the fork branch must be evaluated first');
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
