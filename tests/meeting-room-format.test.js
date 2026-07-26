const assert = require('assert');
const {
  avatarBySlot,
  avatarFallbackBySlot,
  avatarFallbackFor,
  avatarSrcFor,
  escapeHtml,
  formatThinkTime,
  formatTokens,
  ftCtxClass,
} = require('../renderer/meeting-room-format.js');

assert.strictEqual(escapeHtml('<a x="1">&</a>'), '&lt;a x=&quot;1&quot;&gt;&amp;&lt;/a&gt;');
assert.strictEqual(formatTokens(null), '-');
assert.strictEqual(formatTokens(999), '999');
assert.strictEqual(formatTokens(1500), '1.5k');
assert.strictEqual(formatTokens(2000000), '2M');
assert.strictEqual(formatThinkTime(0), '-');
assert.strictEqual(formatThinkTime(1.2), '1.2s');
assert.strictEqual(formatThinkTime(12.2), '12s');
assert.strictEqual(formatThinkTime(125), '2m05s');
assert.strictEqual(ftCtxClass(undefined), 'ok');
assert.strictEqual(ftCtxClass(20), 'ok');
assert.strictEqual(ftCtxClass(60), 'warn');
assert.strictEqual(ftCtxClass(85), 'high');
assert.strictEqual(avatarSrcFor('claude'), 'assets/ai-logos/claude.svg');
assert.strictEqual(avatarSrcFor('deepseek'), 'assets/ai-logos/deepseek.svg');
assert.strictEqual(avatarSrcFor('unknown'), '');
assert.strictEqual(avatarFallbackFor('codex'), 'CX');
assert.strictEqual(avatarFallbackFor('unknown'), '\uD83E\uDD16');
assert.strictEqual(avatarBySlot(1), '');
assert.strictEqual(avatarBySlot(99), '');
assert.strictEqual(avatarFallbackBySlot(2), '3');
assert.strictEqual(avatarFallbackBySlot(99), '\uD83E\uDD16');

console.log('meeting-room-format.test.js OK');
