'use strict';
// 2026-10-14: a streaming group member's Claude transcript is captured every
// 1.5 s. Only the turns after the dispatched prompt are kept, so the capture
// reads a tail window instead of parsing the whole multi-MB file each poll.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const capture = require('../core/conversation-capture');

const base = Date.parse('2026-10-14T01:00:00.000Z');
const iso = i => new Date(base + i * 1000).toISOString();
const user = (i, text) => JSON.stringify({ type: 'user', uuid: 'u-' + i, timestamp: iso(i), message: { content: text } });
const reply = (i, text) => JSON.stringify({ type: 'assistant', uuid: 'a-' + i, timestamp: iso(i),
  message: { id: 'msg-' + i, model: 'claude-opus-4-7', stop_reason: 'end_turn', content: [{ type: 'text', text }] } });

function transcript(t, historyTurns) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-capture-window-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'member.jsonl');
  const filler = 'history '.repeat(400);
  const lines = [];
  for (let i = 0; i < historyTurns; i++) lines.push(user(i * 2, 'old question ' + i), reply(i * 2 + 1, filler + i));
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return { file, nextIndex: historyTurns * 2 };
}

function fullParseCapture(args) {
  // The behaviour before 2026-10-14, kept here as the reference.
  const { displayTurns, userTextIdentity } = require('../core/conversation-display');
  const { displayUserText } = require('../core/synthetic-user-filter');
  const turns = require('../core/claude-transcript-parser').parseClaudeTranscriptToTurns(args.sourcePath, { limit: Infinity });
  const expected = userTextIdentity(displayUserText(args.prompt || '') || args.prompt);
  const start = turns.findLastIndex(t => t.role === 'user' && Number(t.ts) >= Number(args.since || Infinity) - 1000
    && userTextIdentity(t.text) === expected);
  if (start < 0) return [];
  const owned = [];
  for (const t of turns.slice(start + 1)) { if (t.role === 'user') break; owned.push(t); }
  return displayTurns(owned).filter(m => m.role === 'assistant' && (m.text || m.toolCalls?.length));
}

function countWholeReads(t, file) {
  const original = fs.readFileSync;
  const reads = { whole: 0 };
  fs.readFileSync = function (target, ...rest) {
    if (path.resolve(String(target)) === path.resolve(file)) reads.whole += 1;
    return original.call(this, target, ...rest);
  };
  t.after(() => { fs.readFileSync = original; });
  return reads;
}

test('a streaming member is captured from a tail window with the same result as a full parse', t => {
  const { file, nextIndex } = transcript(t, 600); // ~2 MB of history before the prompt
  assert.ok(fs.statSync(file).size > 1024 * 1024);
  const prompt = '本轮问题：请比较两个方案';
  const since = base + nextIndex * 1000;
  fs.appendFileSync(file, user(nextIndex, prompt) + '\n' + reply(nextIndex + 1, '第一段回答') + '\n');
  const args = { kind: 'claude', sourcePath: file, prompt, since };
  const reads = countWholeReads(t, file);
  const first = capture.captureConversationMessages(args);
  assert.deepEqual(first.map(m => m.text), ['第一段回答']);
  fs.appendFileSync(file, reply(nextIndex + 2, '第二段回答') + '\n');
  const second = capture.captureConversationMessages(args);
  assert.equal(reads.whole, 0, 'no poll reads the whole transcript');
  assert.deepEqual(second, fullParseCapture(args));
  assert.deepEqual(second.map(m => m.text), ['第一段回答', '第二段回答']);
});

test('a prompt beyond the windows still comes from the full parse, and an unknown one stays empty', t => {
  const prompt = '很早以前的问题';
  const { file } = transcript(t, 0);
  fs.appendFileSync(file, user(0, prompt) + '\n' + reply(1, '早期回答') + '\n');
  const filler = 'later '.repeat(2000);
  const later = [];
  for (let i = 0; i < 700; i++) later.push(user(10 + i * 2, 'later ' + i), reply(11 + i * 2, filler));
  fs.appendFileSync(file, later.join('\n') + '\n'); // > 4 MB after the prompt
  assert.ok(fs.statSync(file).size > 4 * 1024 * 1024);
  const args = { kind: 'claude', sourcePath: file, prompt, since: base };
  assert.deepEqual(capture.captureConversationMessages(args).map(m => m.text), ['早期回答']);
  assert.deepEqual(capture.captureConversationMessages(args), fullParseCapture(args));
  assert.deepEqual(capture.captureConversationMessages({ ...args, prompt: '从未发送过' }), []);
});

test('a missing transcript still reports the read error to the caller', () => {
  assert.throws(() => capture.captureConversationMessages({ kind: 'claude', sourcePath: path.join(os.tmpdir(), 'no-such-' + Date.now() + '.jsonl'), prompt: 'x', since: base }));
});
