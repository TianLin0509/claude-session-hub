'use strict';
// Managed Claude uses print/stream-json and has no TUI trust dialog.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'session-manager.js'), 'utf8');
assert.doesNotMatch(source, /TRUST_SETTLE_MS|detectClaudeTrustDialog|_trustTimer/);
assert.match(source, /const isNativeClaude = isClaude \|\| isDeepSeekLegacy/);
assert.match(source, /isNativeClaude \? createNativeClaudeDriver/);
// Native Claude output is display-only. It reaches the backstage terminal the
// same way Codex's does, but must return before the activity counters, the
// scrollback rewriter and the CLI-ready detector that infer state from PTY
// bytes -- native items stay the single source of runtime truth.
const handler = source.slice(source.indexOf('ptyProcess.onData((data) => {'));
assert.match(handler, /if \(isNativeClaude \|\| isCodex\) \{[\s\S]*?deliverTerminalData\(data\);[\s\S]*?return;[\s\S]*?\}/);
assert.ok(handler.indexOf('deliverTerminalData(data);') < handler.indexOf('entry.groupChatLastActivity = Date.now();'),
  'native Claude and Codex must deliver display bytes before, and instead of, the PTY activity bookkeeping');
const client = require('../main/claude-stream-client');
const args = client.streamArgs([]);
assert.ok(args.includes('--print'));
assert.ok(args.includes('--permission-prompt-tool'));
assert.ok(args.includes('stdio'));
console.log('PASS native Claude bypasses TUI trust interaction; tools retain protocol approvals');
