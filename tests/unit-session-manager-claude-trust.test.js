'use strict';
// Managed Claude uses print/stream-json and has no TUI trust dialog.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'session-manager.js'), 'utf8');
assert.doesNotMatch(source, /TRUST_SETTLE_MS|detectClaudeTrustDialog|_trustTimer/);
assert.match(source, /const isNativeClaude = isClaude \|\| isDeepSeekLegacy/);
assert.match(source, /isNativeClaude \? createNativeClaudeDriver/);
assert.match(source, /if \(!isNativeClaude\) terminalSnapshot = new TerminalSnapshot/);
const client = require('../main/claude-stream-client');
const args = client.streamArgs([]);
assert.ok(args.includes('--print'));
assert.ok(args.includes('--permission-prompt-tool'));
assert.ok(args.includes('stdio'));
console.log('PASS native Claude bypasses TUI trust interaction; tools retain protocol approvals');
