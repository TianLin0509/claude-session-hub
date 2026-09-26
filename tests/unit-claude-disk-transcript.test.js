'use strict';
// PTY Claude 的卡片来自磁盘 transcript，必须与原生 stream-json 走同一投影：
// 结局只从记录判断（完成 / 中断 / 失败 / 仍在运行），工具带状态和耗时。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { claudeDiskRecords, parseClaudeTranscriptToNativeTurns } = require('../core/claude-disk-transcript');

let seq = 0;
const at = s => new Date(Date.UTC(2026, 8, 25, 1, 0, s)).toISOString();
const user = (text, s, extra = {}) => ({ type: 'user', uuid: 'u' + (++seq), timestamp: at(s),
  message: { role: 'user', content: text }, ...extra });
const assistant = (id, content, stop, s, extra = {}) => ({ type: 'assistant', uuid: 'a' + (++seq), timestamp: at(s),
  message: { id, role: 'assistant', model: 'claude-opus-5-5', content, stop_reason: stop,
    usage: { input_tokens: 10, output_tokens: 5 } }, ...extra });
const toolResult = (id, text, s, isError = false) => ({ type: 'user', uuid: 'r' + (++seq), timestamp: at(s),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] } });

function transcript(entries) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-disk-')), 't.jsonl');
  fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

test('a finished turn projects like the native card: progress, tools with status and duration, final answer', () => {
  const file = transcript([
    user('帮我看下目录', 0),
    assistant('m1', [{ type: 'text', text: '我先列一下文件。' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }], 'tool_use', 1),
    toolResult('t1', 'a.txt', 4),
    assistant('m2', [{ type: 'text', text: '目录里只有 a.txt。' }], 'end_turn', 5),
  ]);
  const turns = parseClaudeTranscriptToNativeTurns(file);
  assert.deepEqual(turns.map(t => t.role), ['user', 'assistant']);
  const answer = turns[1];
  assert.equal(answer.text, '目录里只有 a.txt。');
  assert.equal(answer.nativeOutcome, 'completed');
  assert.deepEqual(answer.displayMessages.map(m => m.phase), ['commentary', 'final_answer']);
  assert.equal(answer.toolCalls[0].status, 'completed');
  assert.equal(answer.toolCalls[0].durationMs, 3000);
  assert.equal(answer.model, 'claude-opus-5-5');
});

test('an interrupt settles the turn as interrupted and never becomes a prompt card', () => {
  const records = claudeDiskRecords([
    user('跑个长任务', 0),
    assistant('m1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 99' } }], 'tool_use', 1),
    user('[Request interrupted by user for tool use]', 3),
  ]);
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'interrupted');
});

test('the newest unfinished turn stays running; an empty end_turn is only a thinking marker', () => {
  const records = claudeDiskRecords([
    user('q1', 0), assistant('m1', [{ type: 'text', text: 'done' }], 'end_turn', 1),
    user('q2', 2),
    assistant('m2', [{ type: 'thinking', thinking: '', signature: 'x' }], 'end_turn', 3),
    assistant('m3', [{ type: 'tool_use', id: 't9', name: 'Read', input: { file_path: 'x' } }], 'tool_use', 4),
  ]);
  assert.deepEqual(records.map(r => r.status), ['completed', 'running']);
  const turns = require('../core/claude-native-transcript').claudeTranscriptTurns(records);
  assert.equal(turns.at(-1).toolCalls[0].status, 'running');
});

test('API errors fail the turn; sidechain and synthetic entries do not open cards', () => {
  const records = claudeDiskRecords([
    user('q', 0),
    assistant('s1', [{ type: 'text', text: 'subagent' }], 'end_turn', 1, { isSidechain: true }),
    assistant('e1', [{ type: 'text', text: 'API Error: overloaded' }], 'stop_sequence', 2, { isApiErrorMessage: true }),
    user('<command-name>/clear</command-name>', 3, { isMeta: true }),
  ]);
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'failed');
  assert.equal(records[0].finalText, 'API Error: overloaded');
});

test('a background task notification continues the previous card instead of opening a new question', () => {
  const file = transcript([
    user('后台跑测试', 0),
    assistant('m1', [{ type: 'text', text: '已在后台启动。' }], 'end_turn', 1),
    user('<task-notification>done</task-notification>', 9, { origin: { kind: 'task-notification' } }),
    assistant('m2', [{ type: 'text', text: '测试全部通过。' }], 'end_turn', 10),
  ]);
  const turns = parseClaudeTranscriptToNativeTurns(file);
  assert.deepEqual(turns.map(t => t.role), ['user', 'assistant']);
  assert.equal(turns[1].text, '测试全部通过。');
  assert.deepEqual(turns[1].displayMessages.map(m => m.phase), ['commentary', 'final_answer']);
});

test('tail limit keeps whole question/answer pairs', () => {
  const entries = [];
  for (let i = 0; i < 5; i += 1) entries.push(user('q' + i, i * 2), assistant('m' + i, [{ type: 'text', text: 'a' + i }], 'end_turn', i * 2 + 1));
  const turns = parseClaudeTranscriptToNativeTurns(transcript(entries), { limit: 2, fromTail: true });
  assert.deepEqual(turns.map(t => t.text), ['q4', 'a4']);
});
