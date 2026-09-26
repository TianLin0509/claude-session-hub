'use strict';
// Claude 有两条后端：
//   · 默认 PTY（2026-09-25 回到 CLI 为核心）：真实 TUI 会弹目录信任框，
//     spawn 前预写信任，兜底只在定位到「Yes」时按键，绝不盲按回车；
//   · 回退开关 native：print/stream-json，没有 TUI 信任框，工具走协议审批。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'session-manager.js'), 'utf8');

assert.match(source, /const isNativeClaude = \(isClaude && nativeAgentRuntime\) \|\| isDeepSeekLegacy/);
assert.match(source, /isNativeClaude \? createNativeClaudeDriver/);
assert.match(source, /ensureClaudeProjectTrusted\(spawnCwd/,
  'PTY Claude must pre-trust the cwd before the CLI starts');
const ptyLaunch = source.slice(source.indexOf('if (claudePtyLaunch) {'));
assert.match(ptyLaunch, /detectClaudeTrustDialog\(trustBuf\)[\s\S]*?dialog\.keys\.forEach/,
  'the fallback may only send the keys located for the Yes option');
assert.doesNotMatch(ptyLaunch.slice(0, ptyLaunch.indexOf('const cmd = claudePtyLaunch.cmd;')), /write\('\\r'\)/,
  'the trust fallback must never press a blind Enter');

// Native Claude output is display-only. It reaches the backstage terminal the
// same way Codex's does, but must return before the activity counters, the
// scrollback rewriter and the CLI-ready detector that infer state from PTY
// bytes -- native items stay the single source of runtime truth.
const handler = source.slice(source.indexOf('ptyProcess.onData((data) => {'));
assert.match(handler, /if \(isNativeClaude \|\| isNativeCodex\) \{[\s\S]*?deliverTerminalData\(data\);[\s\S]*?return;[\s\S]*?\}/);
assert.ok(handler.indexOf('deliverTerminalData(data);') < handler.indexOf('entry.groupChatLastActivity = Date.now();'),
  'native Claude and Codex must deliver display bytes before, and instead of, the PTY activity bookkeeping');
const client = require('../main/claude-stream-client');
const args = client.streamArgs([]);
assert.ok(args.includes('--print'));
assert.ok(args.includes('--permission-prompt-tool'));
assert.ok(args.includes('stdio'));
console.log('PASS PTY Claude pre-trusts its cwd; native Claude bypasses TUI trust interaction');
