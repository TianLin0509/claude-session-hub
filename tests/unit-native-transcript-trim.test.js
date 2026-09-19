'use strict';
// What a journal may drop is exactly what the provider transcript still holds
// and the cards never render: tool output beyond the preview budget. Everything
// else — identities, ordering, assistant text, thinking, tool inputs — must
// survive byte for byte, because nothing else can rebuild it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { preview } = require('../core/acp-tool-preview');
const { KEEP_CHARS, trimFramesForJournal, trimRecordForJournal } = require('../core/native-transcript-trim');

const big = size => 'x'.repeat(size);
const frame = content => ({ uuid: 'u', type: 'user', message: { content } });

test('the kept head still renders an identical card preview', () => {
  const output = '工具输出🧪'.repeat(20000);
  const [stored] = trimFramesForJournal([frame([{ type: 'tool_result', tool_use_id: 't', content: output }])]);
  const kept = stored.message.content[0].content;
  assert.equal(preview(kept).text, preview(output).text);
  assert.equal(preview(kept).truncated, preview(output).truncated);
});

test('assistant text, thinking and tool inputs are never trimmed', () => {
  const blocks = [
    { type: 'text', text: big(KEEP_CHARS * 3) },
    { type: 'thinking', thinking: big(KEEP_CHARS * 3) },
    { type: 'tool_use', id: 't', name: 'Edit', input: { new_string: big(KEEP_CHARS * 3) } },
  ];
  const frames = [{ uuid: 'u', type: 'assistant', message: { content: blocks } }];
  assert.equal(trimFramesForJournal(frames), frames, 'nothing to trim must return the same frames');
});

test('tool_result metadata survives trimming', () => {
  const block = { type: 'tool_result', tool_use_id: 'tool-7', is_error: true, content: big(KEEP_CHARS * 4) };
  const [stored] = trimFramesForJournal([frame([block])]);
  const kept = stored.message.content[0];
  assert.equal(kept.tool_use_id, 'tool-7');
  assert.equal(kept.is_error, true);
  assert.ok(kept.content.startsWith(big(KEEP_CHARS)), 'the kept head is the original prefix');
  assert.match(kept.content, /Hub 保留的开头/, 'a trimmed body must say so wherever it is rendered');
  assert.deepEqual(kept.hubTrimmed, { bytes: KEEP_CHARS * 4, kept: KEEP_CHARS });
});

test('block-list results are trimmed within one shared budget', () => {
  const content = [{ type: 'text', text: big(3000) }, { type: 'text', text: big(3000) }];
  const [stored] = trimFramesForJournal([frame([{ type: 'tool_result', tool_use_id: 't', content }])]);
  const kept = stored.message.content[0].content;
  assert.equal(kept.length, 2, 'blocks are trimmed, never dropped');
  assert.equal(kept[0].text, big(3000));
  assert.ok(kept[1].text.startsWith(big(KEEP_CHARS - 3000)));
  assert.match(kept[1].text, /全文共 6000 字/);
});

test('inline image payloads are dropped, their envelope is kept', () => {
  const content = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: big(KEEP_CHARS * 2) } }];
  const [stored] = trimFramesForJournal([frame([{ type: 'tool_result', tool_use_id: 't', content }])]);
  const image = stored.message.content[0].content[0];
  assert.equal(image.source.data, '');
  assert.equal(image.source.media_type, 'image/png');
  assert.match(image.hubOmitted, /图片/);
});

test('frame-level passthrough copies of the same output are reduced to a head', () => {
  const payload = { stdout: big(KEEP_CHARS * 5) };
  const [stored] = trimFramesForJournal([{ uuid: 'u', type: 'user', tool_use_result: payload,
    message: { content: [{ type: 'text', text: 'ok' }] } }]);
  assert.ok(stored.tool_use_result.hubTrimmed);
  assert.equal(stored.tool_use_result.head, JSON.stringify(payload).slice(0, KEEP_CHARS));
  assert.equal(stored.message.content[0].text, 'ok');
});

test('trimming is never applied twice and never mutates the caller', () => {
  const original = frame([{ type: 'tool_result', tool_use_id: 't', content: big(KEEP_CHARS * 2) }]);
  const before = JSON.stringify(original);
  const [once] = trimFramesForJournal([original]);
  const [twice] = trimFramesForJournal([once]);
  assert.equal(JSON.stringify(original), before, 'the live frame must keep its full output');
  assert.equal(twice, once, 'an already-trimmed frame is returned unchanged');
});

test('records carry their transcript through either field name', () => {
  const blocks = [{ type: 'tool_result', tool_use_id: 't', content: big(KEEP_CHARS * 2) }];
  const record = { userMessageId: 'a', transcriptMessages: [frame(blocks)], transcriptAppend: [frame(blocks)] };
  const stored = trimRecordForJournal(record);
  assert.ok(stored.transcriptMessages[0].message.content[0].hubTrimmed);
  assert.ok(stored.transcriptAppend[0].message.content[0].hubTrimmed);
  assert.equal(stored.userMessageId, 'a');
  const small = { userMessageId: 'a', transcriptMessages: [frame([{ type: 'text', text: 'hi' }])] };
  assert.equal(trimRecordForJournal(small), small);
});
