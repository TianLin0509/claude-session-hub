'use strict';
// Claude task-notification turns read like Codex progress rows: one card per
// human turn, continuations appended, no duplicate against the disk history,
// and no whole-transcript rewrite per late frame.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ClaudeNativeSession } = require('../core/claude-native-session');
const { claudeTranscriptTurns, tailClaudeRecords } = require('../core/claude-native-transcript');
const { NativeAgentJournal } = require('../core/native-agent-journal');
const { parseClaudeTranscriptToTurns } = require('../core/claude-transcript-parser');
const { claudeRuntimeTruth } = require('../core/claude-native-runtime');

function create(t, options = {}) {
  const s = new ClaudeNativeSession({ id: 'continuation-test', executable: process.execPath,
    commandArgs: [path.join(__dirname, 'fixtures/claude-stream.js'), '--fixture=hold'], closeTimeoutMs: 300, ...options });
  t.after(() => s.close());
  return s;
}
function frame(s, value) { s.message({ uuid: randomUUID(), session_id: s.sessionId, ...value }); }
function answer(s, text, extra = {}) {
  const id = randomUUID();
  frame(s, { type: 'assistant', message: { id, role: 'assistant', model: 'claude-haiku-4-5', stop_reason: 'end_turn',
    content: [{ type: 'text', text }] }, ...extra });
  return id;
}
function result(s, origin = { kind: 'human' }, text = 'root answer') {
  frame(s, { type: 'result', subtype: 'success', is_error: false, origin, result: text });
}

test('assistant frames that arrive before the replayed injected input are kept and adopted', async t => {
  const s = create(t); const states = []; s.on('state', e => states.push(e.state));
  await s.submit('A', { submissionId: 'A' }); answer(s, 'A answer'); result(s, { kind: 'human' }, 'A answer');
  // Measured wire order on Claude Code 2.1.269: assistant first, user replay
  // (no uuid, empty content) and result within milliseconds of each other.
  const progressId = answer(s, '进展一');
  assert.equal(s.runtime.state, 'running', 'a provisional activity keeps the session busy');
  s.message({ type: 'user', session_id: s.sessionId, origin: { kind: 'task-notification' }, message: { role: 'user', content: '' } });
  const finalId = answer(s, '最终结论');
  result(s, { kind: 'task-notification' }, '最终结论');
  const activities = [...s.activities.records.values()];
  assert.equal(activities.length, 1, 'the injected input adopts the provisional record instead of opening a second one');
  assert.deepEqual([activities[0].origin.kind, activities[0].status, activities[0].provisional], ['task-notification', 'completed', false]);
  assert.deepEqual([...activities[0].messages.values()].map(m => m.message.content[0].text), ['进展一', '最终结论']);
  assert.equal(activities[0].model, 'claude-haiku-4-5');
  assert.ok(s.historyExclusions().excludeMessageIds.includes(progressId) && s.historyExclusions().excludeMessageIds.includes(finalId),
    'captured message ids let the disk history parser skip the same turn');
  const cards = s.transcript();
  const assistant = cards.filter(c => c.role === 'assistant');
  assert.equal(assistant.length, 1, 'one card for the human turn and its continuation');
  assert.deepEqual(assistant[0].continuations, [activities[0].userMessageId]);
  assert.deepEqual(assistant[0].displayMessages.map(m => [m.text, m.phase]),
    [['A answer', 'commentary'], ['进展一', 'commentary'], ['最终结论', 'final_answer']]);
  assert.equal(assistant[0].text, '最终结论');
  assert.equal(assistant[0].nativeOutcome, 'completed');
  assert.equal(s.runtime.state, 'completed');
  assert.equal(s.records.get('A').finalText, 'A answer', 'the human submission itself is never rewritten');
});

test('a result with no replayed input still settles the provisional activity', async t => {
  const s = create(t);
  await s.submit('A', { submissionId: 'A' }); result(s);
  answer(s, '后台结论');
  result(s, { kind: 'task-notification' }, '后台结论');
  const activities = [...s.activities.records.values()];
  assert.equal(activities.length, 1);
  assert.deepEqual([activities[0].origin.kind, activities[0].status], ['task-notification', 'completed']);
  assert.equal(s.transcript().filter(c => c.role === 'assistant').length, 1);
});

test('continuations attach only to a human turn that had settled before they began', () => {
  const human = (id, status, createdAt, completedAt) => ({ userMessageId: id, submissionId: id, status, createdAt, completedAt,
    text: id, finalText: id + ' answer', messages: new Map() });
  const activity = (id, kind, createdAt) => ({ userMessageId: id, nativeActivity: true, origin: { kind }, status: 'completed',
    createdAt, completedAt: createdAt + 1, finalText: id + ' answer', messages: new Map() });
  const settled = [human('H1', 'completed', 1, 5), activity('N1', 'task-notification', 6), activity('N2', 'task-notification', 7)];
  const cards = claudeTranscriptTurns(settled).filter(c => c.role === 'assistant');
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0].continuations, ['N1', 'N2']);
  assert.deepEqual(cards[0].displayMessages.map(m => m.phase), ['commentary', 'commentary', 'final_answer']);
  assert.equal(tailClaudeRecords(settled, 1).length, 3, 'the live tail never separates a continuation from its human turn');
  const running = claudeTranscriptTurns([human('H2', 'accepted', 1, 0), activity('N3', 'task-notification', 6)]).filter(c => c.role === 'assistant');
  assert.equal(running.length, 1, 'an injected turn beside a running human turn stays its own card');
  assert.deepEqual([running[0].nativeActivity, running[0].id], [true, 'N3:assistant']);
  const channel = claudeTranscriptTurns([human('H3', 'completed', 1, 5), activity('C1', 'channel', 6)]).filter(c => c.role === 'assistant');
  assert.equal(channel.length, 2, 'remote channel input is a conversation of its own, not a continuation');
});

test('late child output after a settled turn is persisted as an appended slice, not a full rewrite', async t => {
  const s = create(t); const events = []; s.on('lifecycle', e => events.push(e));
  await s.submit('A', { submissionId: 'A' });
  frame(s, { type: 'assistant', message: { id: 'spawn', role: 'assistant', content: [{ type: 'tool_use', id: 'agent-call', name: 'Agent', input: {} }] } });
  result(s);
  answer(s, 'late child text', { parent_tool_use_id: 'agent-call' });
  const late = events.filter(e => e.type === 'transcript-appended');
  assert.equal(late.length, 1);
  assert.equal(late[0].transcriptAppend.length, 1);
  assert.equal(late[0].transcriptMessages, undefined);
  assert.equal(late[0].text, 'root answer');
});

test('journal merges appended frames by identity and compacts superseded snapshots atomically', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-journal-compact-'));
  const options = { directory, sessionId: 'session-a' };
  const journal = new NativeAgentJournal(options);
  const frameA = { type: 'assistant', uuid: 'f-a', message: { id: 'm-a', content: [{ type: 'text', text: 'a' }] } };
  const frameB = { type: 'assistant', uuid: 'f-b', message: { id: 'm-b', content: [{ type: 'text', text: 'b' }] } };
  journal.saveSubmission({ submissionId: 'a', text: '问题', content: '问题', promptFingerprint: 'fp', sendStatus: 'queued' });
  journal.saveLifecycle({ clientSubmissionId: 'a', promptFingerprint: 'fp', type: 'agent-turn-complete', status: 'completed', text: '答案', transcriptMessages: [frameA] });
  journal.saveLifecycle({ clientSubmissionId: 'a', promptFingerprint: 'fp', type: 'transcript-appended', status: 'completed', text: '答案', transcriptAppend: [frameB] });
  journal.saveLifecycle({ clientSubmissionId: 'a', promptFingerprint: 'fp', type: 'transcript-appended', status: 'completed', text: '答案', transcriptAppend: [frameB] });
  journal.saveActivity({ userMessageId: 'act', nativeActivity: true, origin: { kind: 'task-notification' }, status: 'running', transcriptMessages: [] });
  journal.saveActivity({ userMessageId: 'act', nativeActivity: true, origin: { kind: 'task-notification' }, status: 'completed', finalText: '后台', transcriptAppend: [frameA] });
  const expectRecord = record => {
    assert.deepEqual([record.text, record.finalText, record.status, record.promptFingerprint], ['问题', '答案', 'completed', 'fp']);
    assert.deepEqual(record.transcriptMessages.map(f => f.uuid), ['f-a', 'f-b'], 'the repeated slice is merged, not duplicated');
  };
  expectRecord(journal.list()[0]);
  assert.deepEqual(journal.listActivities()[0].transcriptMessages.map(f => f.uuid), ['f-a']);
  assert.equal(journal.entries.length, 6);
  assert.equal(journal.compactIfOversized({ minBytes: 0 }), true);
  assert.equal(journal.entries.length, 2);
  expectRecord(journal.list()[0]);
  const reopened = new NativeAgentJournal(options);
  expectRecord(reopened.list()[0]);
  assert.equal(reopened.listActivities()[0].finalText, '后台');
  assert.deepEqual(fs.readdirSync(directory), ['session-a.jsonl'], 'no temp file is left behind');
  reopened.saveLifecycle({ clientSubmissionId: 'a', promptFingerprint: 'fp', type: 'transcript-appended', status: 'completed', text: '答案', transcriptAppend: [frameA] });
  assert.equal(new NativeAgentJournal(options).entries.length, 3, 'appends continue after the compacted file');
  assert.equal(new NativeAgentJournal(options).compactIfOversized(), false, 'a small journal is left alone');
  fs.rmSync(directory, { recursive: true, force: true });
});

test('disk history appends a task-notification run to the previous card instead of opening another', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-claude-continuation-'));
  const file = path.join(directory, 'session.jsonl');
  const entry = (type, uuid, message, extra = {}) => JSON.stringify({ type, uuid, timestamp: new Date(1789321000000 + Number(uuid.slice(1)) * 1000).toISOString(), message, ...extra });
  fs.writeFileSync(file, [
    entry('user', 'u1', { role: 'user', content: '比对一下' }),
    entry('assistant', 'a1', { id: 'm1', role: 'assistant', model: 'claude-fable-5-1', stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 't1', name: 'Agent', input: {} }] }),
    entry('user', 'u2', { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'launched' }] }),
    entry('assistant', 'a2', { id: 'm2', role: 'assistant', model: 'claude-fable-5-1', stop_reason: 'end_turn',
      content: [{ type: 'text', text: '三路探索已在后台跑' }] }),
    entry('user', 'u3', { role: 'user', content: '<task-notification>\n<task-id>x</task-id>\n</task-notification>' }, { origin: { kind: 'task-notification' } }),
    entry('assistant', 'a3', { id: 'm3', role: 'assistant', model: 'claude-fable-5-1', stop_reason: 'end_turn',
      content: [{ type: 'text', text: '主进程这一路已回来' }] }),
    entry('user', 'u4', { role: 'user', content: '<task-notification>\n<task-id>y</task-id>\n</task-notification>' }, { origin: { kind: 'task-notification' } }),
    entry('assistant', 'a4', { id: 'm4', role: 'assistant', model: 'claude-fable-5-1', stop_reason: 'end_turn',
      content: [{ type: 'text', text: '三路都齐了，结论如下' }] }),
    entry('user', 'u5', { role: 'user', content: '下一个问题' }),
    entry('assistant', 'a5', { id: 'm5', role: 'assistant', model: 'claude-fable-5-1', stop_reason: 'end_turn',
      content: [{ type: 'text', text: '第二轮回答' }] }),
  ].join('\n') + '\n');
  const turns = parseClaudeTranscriptToTurns(file);
  assert.deepEqual(turns.map(turn => turn.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(turns[0].text, '比对一下');
  assert.deepEqual(turns[1].displayMessages.map(m => [m.text, m.phase]),
    [['三路探索已在后台跑', 'commentary'], ['主进程这一路已回来', 'commentary'], ['三路都齐了，结论如下', 'final_answer']]);
  assert.equal(turns[1].toolCalls.length, 1);
  assert.equal(turns[1].continued, 2);
  assert.equal(turns[3].text, '第二轮回答');
  fs.rmSync(directory, { recursive: true, force: true });
});

test('Claude runtime truth reports what it is waiting for and drops confidence when disconnected', () => {
  const waiting = claudeRuntimeTruth({ runtimeBackend: 'claude-stream-json', nativeRuntime: { state: 'waiting', connection: 'connected',
    requests: [{ method: 'claude/requestUserInput', params: { questions: [{ question: '保留全部记录吗？' }] } },
      { method: 'claude/requestApproval', params: { toolName: 'Bash' } }] } });
  assert.equal(waiting.evidence, '保留全部记录吗？; 等待批准工具 Bash');
  assert.equal(waiting.confidence, 'authoritative');
  const gone = claudeRuntimeTruth({ runtimeBackend: 'claude-stream-json', nativeRuntime: { state: 'running', connection: 'disconnected' } });
  assert.deepEqual([gone.state, gone.confidence], ['unknown', 'none']);
  const unstarted = claudeRuntimeTruth({ runtimeBackend: 'claude-stream-json', nativeRuntime: { state: 'idle', connection: 'unstarted' } });
  assert.equal(unstarted.confidence, 'authoritative');
});
