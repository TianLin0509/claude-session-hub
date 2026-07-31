'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseKimiWireToTurns } = require('../core/kimi-transcript-parser.js');

function line(value) {
  return JSON.stringify(value) + '\n';
}

test('Kimi turn ids stay stable when the 8 MB tail window moves', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-kimi-stable-id-'));
  const wire = path.join(root, 'wire.jsonl');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(wire, [
    line({ type: 'ignored-padding', payload: 'x'.repeat(9 * 1024 * 1024) }),
    line({ type: 'turn.prompt', input: [{ type: 'text', text: '问题' }], origin: { kind: 'user' }, time: 1785431086567 }),
    line({ type: 'context.append_loop_event', event: { type: 'step.begin', uuid: 'step-a', turnId: '17', step: 1 }, time: 1785431086579 }),
    line({ type: 'context.append_loop_event', event: { type: 'content.part', uuid: 'part-a', turnId: '17', step: 1, stepUuid: 'step-a', part: { type: 'text', text: '答案' } }, time: 1785431086580 }),
    line({ type: 'context.append_loop_event', event: { type: 'step.end', uuid: 'step-a', turnId: '17', step: 1, finishReason: 'stop' }, time: 1785431086581 }),
  ].join(''), 'utf8');

  const full = parseKimiWireToTurns(wire, { limit: 2, fromTail: false });
  const tail1 = parseKimiWireToTurns(wire, { limit: 2, fromTail: true });
  assert.deepEqual(tail1.map(turn => turn.id), full.map(turn => turn.id));
  assert.deepEqual(tail1.map(turn => turn.id), ['kimi-user-1785431086567', 'kimi-assistant-1785431086567']);

  fs.appendFileSync(wire, line({ type: 'ignored-growth', payload: 'y'.repeat(512 * 1024) }), 'utf8');
  const tail2 = parseKimiWireToTurns(wire, { limit: 2, fromTail: true });
  assert.deepEqual(tail2.map(turn => turn.id), full.map(turn => turn.id));
});

test('Kimi resume may reuse native turnId, so distinct prompts keep distinct card ids', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-kimi-reused-turn-id-'));
  const wire = path.join(root, 'wire.jsonl');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const oneTurn = (promptTime, promptText, answerText, stepPrefix) => [
    line({ type: 'turn.prompt', input: [{ type: 'text', text: promptText }], origin: { kind: 'user' }, time: promptTime }),
    line({ type: 'context.append_loop_event', event: { type: 'step.begin', uuid: `${stepPrefix}-step`, turnId: '3', step: 1 }, time: promptTime + 1 }),
    line({ type: 'context.append_loop_event', event: { type: 'content.part', uuid: `${stepPrefix}-part`, turnId: '3', step: 1, stepUuid: `${stepPrefix}-step`, part: { type: 'text', text: answerText } }, time: promptTime + 2 }),
    line({ type: 'context.append_loop_event', event: { type: 'step.end', uuid: `${stepPrefix}-step`, turnId: '3', step: 1, finishReason: 'end_turn' }, time: promptTime + 3 }),
  ].join('');
  fs.writeFileSync(wire, [
    oneTurn(1785236496872, '第一次问题', '第一次回答', 'first'),
    oneTurn(1785289717879, 'resume 后的问题', 'resume 后的回答', 'second'),
  ].join(''), 'utf8');

  const turns = parseKimiWireToTurns(wire);
  assert.deepEqual(turns.map(turn => turn.id), [
    'kimi-user-1785236496872',
    'kimi-assistant-1785236496872',
    'kimi-user-1785289717879',
    'kimi-assistant-1785289717879',
  ]);
  assert.equal(new Set(turns.map(turn => turn.id)).size, 4);
});

test('multiple terminal steps in one Kimi prompt coalesce to the latest final assistant card', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-kimi-multi-terminal-'));
  const wire = path.join(root, 'wire.jsonl');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(wire, [
    line({ type: 'turn.prompt', input: [{ type: 'text', text: '后台任务' }], origin: { kind: 'user' }, time: 1785400000000 }),
    line({ type: 'context.append_loop_event', event: { type: 'step.begin', uuid: 'step-one', turnId: '8', step: 1 }, time: 1785400000001 }),
    line({ type: 'context.append_loop_event', event: { type: 'content.part', stepUuid: 'step-one', turnId: '8', part: { type: 'text', text: '子任务已返回' } }, time: 1785400000002 }),
    line({ type: 'context.append_loop_event', event: { type: 'step.end', uuid: 'step-one', turnId: '8', step: 1, finishReason: 'end_turn' }, time: 1785400000003 }),
    line({ type: 'context.append_loop_event', event: { type: 'step.begin', uuid: 'step-two', turnId: '8', step: 2 }, time: 1785400000004 }),
    line({ type: 'context.append_loop_event', event: { type: 'content.part', stepUuid: 'step-two', turnId: '8', part: { type: 'text', text: '父任务最终总结' } }, time: 1785400000005 }),
    line({ type: 'context.append_loop_event', event: { type: 'step.end', uuid: 'step-two', turnId: '8', step: 2, finishReason: 'end_turn' }, time: 1785400000006 }),
  ].join(''), 'utf8');

  const turns = parseKimiWireToTurns(wire);
  assert.equal(turns.length, 2);
  assert.equal(turns[1].id, 'kimi-assistant-1785400000000');
  assert.equal(turns[1].text, '父任务最终总结');
  assert.equal(turns[1].tsEnd, 1785400000006);
});

test('Kimi resume tail cut inside one agent turn keeps the full card content', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-kimi-complete-tail-'));
  const wire = path.join(root, 'wire.jsonl');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(wire, [
    line({ type: 'turn.prompt', input: [{ type: 'text', text: '长任务' }], origin: { kind: 'user' }, time: 1785432086567 }),
    line({ type: 'context.append_loop_event', event: { type: 'step.begin', uuid: 'step-long-a', turnId: '29', step: 1 }, time: 1785432086570 }),
    line({ type: 'context.append_loop_event', event: { type: 'tool.call', uuid: 'call-long', toolCallId: 'call-long', turnId: '29', step: 1, stepUuid: 'step-long-a', name: 'shell', args: { payload: 'x'.repeat(9 * 1024 * 1024) } }, time: 1785432086571 }),
    line({ type: 'context.append_loop_event', event: { type: 'step.end', uuid: 'step-long-a', turnId: '29', step: 1, finishReason: 'tool_calls' }, time: 1785432086572 }),
    line({ type: 'context.append_loop_event', event: { type: 'step.begin', uuid: 'step-long-b', turnId: '29', step: 2 }, time: 1785432086573 }),
    line({ type: 'context.append_loop_event', event: { type: 'content.part', uuid: 'part-final', turnId: '29', step: 2, stepUuid: 'step-long-b', part: { type: 'text', text: '最终答案' } }, time: 1785432086574 }),
    line({ type: 'context.append_loop_event', event: { type: 'step.end', uuid: 'step-long-b', turnId: '29', step: 2, finishReason: 'stop' }, time: 1785432086575 }),
  ].join(''), 'utf8');

  const full = parseKimiWireToTurns(wire).slice(-1);
  const tail = parseKimiWireToTurns(wire, { limit: 1, fromTail: true });
  assert.equal(full.length, 1);
  assert.deepEqual(tail, full, 'resume tail must include the prompt and every step of the logical turn');
  assert.equal(tail[0].text, '最终答案');
  assert.equal(tail[0].toolCalls.length, 1);
  assert.ok(tail[0].toolCalls[0].input.payload.length > 8 * 1024 * 1024);
});
