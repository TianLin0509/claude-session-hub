'use strict';

const assert = require('assert');
const {
  isCodexCliKind,
  isCodexSessionKind,
  isClaudeWebKind,
  isCodexWebKind,
  isWebStyleKind,
} = require('../core/ai-kinds.js');

assert.strictEqual(isCodexCliKind('codex'), true);
assert.strictEqual(isCodexCliKind('codex-resume'), true);
assert.strictEqual(isCodexCliKind('codex-web'), true);
assert.strictEqual(isCodexCliKind('codex-web-resume'), true);
assert.strictEqual(isCodexCliKind('codex-app'), false);
assert.strictEqual(isCodexCliKind('claude'), false);

assert.strictEqual(isCodexSessionKind('codex-app'), true);
assert.strictEqual(isCodexSessionKind('codex-web-resume'), true);
assert.strictEqual(isCodexSessionKind('gemini'), false);

assert.strictEqual(isClaudeWebKind('claude-web'), true);
assert.strictEqual(isClaudeWebKind('claude-web-resume'), true);
assert.strictEqual(isClaudeWebKind('claude'), false);

assert.strictEqual(isCodexWebKind('codex-web'), true);
assert.strictEqual(isCodexWebKind('codex-web-resume'), true);
assert.strictEqual(isCodexWebKind('codex'), false);

assert.strictEqual(isWebStyleKind('claude-web'), true);
assert.strictEqual(isWebStyleKind('codex-web'), true);
assert.strictEqual(isWebStyleKind('deepseek'), false);

console.log('ai-kinds helpers ok');
