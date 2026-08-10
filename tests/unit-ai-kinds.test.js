'use strict';

const assert = require('assert');
const {
  canonicalAiKind,
  getKindLabel,
  isClaudeFamily,
  isCodexCliKind,
  isCodexSessionKind,
  isKimiCliKind,
  isClaudeWebKind,
  isCodexWebKind,
  isWebStyleKind,
} = require('../core/ai-kinds.js');

assert.strictEqual(isCodexCliKind('codex'), true);
assert.strictEqual(isCodexCliKind('codex-resume'), true);
assert.strictEqual(isCodexCliKind('deepseek'), true);
assert.strictEqual(isCodexCliKind('deepseek-resume'), true);
assert.strictEqual(isCodexCliKind('codex-web'), false);
assert.strictEqual(isCodexCliKind('codex-web-resume'), false);
assert.strictEqual(isCodexCliKind('codex-app'), false);
assert.strictEqual(isCodexCliKind('claude'), false);
assert.strictEqual(isClaudeFamily('deepseek'), false);
assert.strictEqual(isClaudeFamily('deepseek-legacy'), true);
assert.strictEqual(canonicalAiKind('deepseek-legacy-resume'), 'deepseek');
assert.strictEqual(getKindLabel('deepseek-legacy'), 'DeepSeek');

assert.strictEqual(isCodexSessionKind('codex-app'), false);
assert.strictEqual(isCodexSessionKind('codex-web-resume'), false);
assert.strictEqual(isCodexSessionKind('gemini'), false);

assert.strictEqual(isKimiCliKind('kimi'), true);
assert.strictEqual(isKimiCliKind('kimi-resume'), true);
assert.strictEqual(isKimiCliKind('codex'), false);

assert.strictEqual(isClaudeWebKind('claude-web'), false);
assert.strictEqual(isClaudeWebKind('claude-web-resume'), false);
assert.strictEqual(isClaudeWebKind('claude'), false);

assert.strictEqual(isCodexWebKind('codex-web'), false);
assert.strictEqual(isCodexWebKind('codex-web-resume'), false);
assert.strictEqual(isCodexWebKind('codex'), false);

assert.strictEqual(isWebStyleKind('claude-web'), false);
assert.strictEqual(isWebStyleKind('codex-web'), false);
assert.strictEqual(isWebStyleKind('deepseek'), false);

console.log('ai-kinds helpers ok');
