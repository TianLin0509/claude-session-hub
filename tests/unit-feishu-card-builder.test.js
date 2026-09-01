'use strict';

const assert = require('node:assert/strict');
const {
  buildSessionCompletionCard,
  cleanAnswerMarkdown,
  splitAnswer,
} = require('../core/feishu-card-builder.js');

const longAnswer = [
  '结论：功能已经完成。',
  '<at id=all></at>',
  ...Array.from({ length: 90 }, (_, index) => `- 第 ${index + 1} 条验证信息 ${'x'.repeat(70)}`),
  '<oai-mem-citation>INTERNAL MEMORY ONLY</oai-mem-citation>',
].join('\n');

const cleaned = cleanAnswerMarkdown(longAnswer);
assert.doesNotMatch(cleaned, /<at\s/i, 'model output must not inject a Feishu mention');
assert.doesNotMatch(cleaned, /INTERNAL MEMORY ONLY/, 'internal memory metadata must not enter the card');
assert.match(cleaned, /&#60;at id=all&#62;/, 'tag-looking text should remain visible as inert text');

const split = splitAnswer(longAnswer);
assert.ok(split.primary.length > 0);
assert.ok(split.primary.length <= 1_600);
assert.ok(split.secondary.length <= 4_800);
assert.equal(split.truncated, true);

const card = buildSessionCompletionCard({
  sessionTitle: '飞书成果快递实现',
  kind: 'codex',
  model: 'gpt-5.6-sol',
  durationText: '2 分 18 秒',
  completedAtText: '2026-09-01 11:22:33',
  includeContent: true,
  answerText: longAnswer,
  imageKey: 'img_v3_preview',
  artifacts: [
    { name: '20260901-AIHub-成果预览.html', kind: 'html' },
    { name: '20260901-AIHub-实现说明.md', kind: 'text' },
  ],
});

assert.equal(card.schema, '2.0');
assert.equal(card.config.width_mode, 'default');
assert.equal(card.config.enable_forward, false);
assert.equal(card.header.title.content, '飞书成果快递实现');
assert.equal(card.header.template, 'green');
assert.equal(card.header.icon.token, 'ai-common_colorful');
assert.equal(card.body.elements.length, 5, 'card complexity must stay inside the 2-5 visual-block gate');
assert.equal(card.body.elements[0].tag, 'column_set');
assert.equal(card.body.elements[0].flex_mode, 'none');
assert.equal(card.body.elements[2].tag, 'img');
assert.equal(card.body.elements[2].img_key, 'img_v3_preview');
assert.equal(card.body.elements.at(-1).tag, 'collapsible_panel');

const serialized = JSON.stringify(card);
assert.match(serialized, /gpt-5\.6-sol/);
assert.match(serialized, /成果预览\.html/);
assert.doesNotMatch(serialized, /<at\s/i);
assert.doesNotMatch(serialized, /INTERNAL MEMORY ONLY/);

const privateCard = buildSessionCompletionCard({
  sessionTitle: '隐私默认值',
  kind: 'claude',
  model: 'sonnet',
  durationText: '8 秒',
  includeContent: false,
  answerText: 'TOP SECRET BODY',
  artifacts: [],
});
assert.doesNotMatch(JSON.stringify(privateCard), /TOP SECRET BODY/,
  'answer content must remain absent until the existing opt-in is enabled');

console.log('unit-feishu-card-builder.test.js OK');
