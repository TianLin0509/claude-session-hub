'use strict';
// Card history from a Claude transcript on disk must not ship screenshots and
// megabyte tool outputs to the window on every click (2026-10-08: one click
// carried 12.7 MB, 12.0 MB of it base64 images). What the card shows, what the
// presentation layer reads, and what「查看全文 / 复制」returns must not change.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseClaudeTranscriptToNativeTurns } = require('../core/claude-disk-transcript.js');
const { normalizeToolActivity, buildTurnPresentation } = require('../core/turn-presentation.js');
const { COMPACT_OVER, DISPLAY_KEEP, compactToolOutput, compactTurnsToolOutputs } = require('../core/transcript-tool-compact.js');
const { parseSessionTranscript, readCompactedToolResult, registerTranscriptIpc } = require('../main/ipc/transcript-handlers.js');

const IMAGE = 'iVBORw0KGgo' + 'A'.repeat(400000);
const LONG_LOG = Array.from({ length: 6000 }, (_, i) => `line ${i} ok`).join('\n') + '\n42 passed, 0 failed\nall tests passed';

function writeTranscript(dir) {
  const at = n => new Date(Date.UTC(2026, 9, 8, 12, 0, n)).toISOString();
  const lines = [
    { type: 'user', uuid: 'u1', timestamp: at(0), message: { role: 'user', content: '截图看看界面' } },
    { type: 'assistant', uuid: 'a1', timestamp: at(1), message: { id: 'm1', role: 'assistant', stop_reason: 'tool_use', content: [
      { type: 'tool_use', id: 'shot', name: 'Read', input: { file_path: 'C:\\x\\shot.png' } },
      { type: 'tool_use', id: 'test', name: 'Bash', input: { command: 'npm test' } },
      { type: 'tool_use', id: 'small', name: 'Bash', input: { command: 'echo hi' } },
    ] } },
    { type: 'user', uuid: 'r1', timestamp: at(2), message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'shot', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: IMAGE } }] },
    ] } },
    { type: 'user', uuid: 'r2', timestamp: at(3), message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'test', content: LONG_LOG },
    ] } },
    { type: 'user', uuid: 'r3', timestamp: at(4), message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'small', content: 'hi' },
    ] } },
    { type: 'assistant', uuid: 'a2', timestamp: at(5), message: { id: 'm2', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '看完了' }] } },
  ];
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
  return file;
}

const toolById = (turns, id) => turns.flatMap(turn => turn.toolCalls || []).find(tool => tool.id === id);

test('images lose their data, long output keeps the displayed head and the tail', () => {
  const image = compactToolOutput([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: IMAGE } }]);
  assert.equal(image[0].type, 'image');
  assert.equal(image[0].source.media_type, 'image/png');
  assert.equal(image[0].source.data, '');
  assert.match(image[0].hubOmitted, /查看全文/);

  const text = compactToolOutput(LONG_LOG);
  assert.ok(text.length < LONG_LOG.length);
  assert.equal(text.slice(0, DISPLAY_KEEP), LONG_LOG.slice(0, DISPLAY_KEEP), 'the card shows the same first 50,000 characters');
  assert.ok(text.endsWith('all tests passed'), 'the summary printed last is kept');

  const short = 'x'.repeat(COMPACT_OVER);
  assert.equal(compactToolOutput(short), short, 'outputs within the budget are untouched');
  const blocks = [{ type: 'text', text: 'hello' }];
  assert.equal(compactToolOutput(blocks), blocks, 'unchanged blocks keep identity');
});

test('turns are copied, never mutated, and only changed tools get a resultRef', () => {
  const turns = [{ id: 't', toolCalls: [{ id: 'a', output: LONG_LOG }, { id: 'b', output: 'small' }] }];
  const snapshot = JSON.stringify(turns);
  const next = compactTurnsToolOutputs(turns, { transcriptPath: 'C:\\t.jsonl' });
  assert.equal(JSON.stringify(turns), snapshot, 'cached parser results must not be mutated');
  assert.deepEqual(next[0].toolCalls[0].resultRef, { source: 'claude-transcript-file', transcriptPath: 'C:\\t.jsonl', itemId: 'a' });
  assert.equal(next[0].toolCalls[0].resultTruncated, true);
  assert.equal(next[0].toolCalls[1], turns[0].toolCalls[1]);
  const plain = [{ id: 'p', toolCalls: [{ id: 'c', output: 'ok' }] }];
  assert.equal(compactTurnsToolOutputs(plain, { transcriptPath: 'C:\\t.jsonl' }), plain);
});

test('card history IPC is small, keeps presentation, and reads the full result back', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-tool-compact-'));
  try {
    const file = writeTranscript(dir);
    const full = parseClaudeTranscriptToNativeTurns(file, { limit: 9, fromTail: true });
    const session = { id: 'hub-1', kind: 'claude', transcriptPath: file, ccSessionId: 'cc-1' };
    const deps = {
      defer: async () => {},
      sessionManager: { getSession: id => (id === 'hub-1' ? session : null) },
      transcriptTap: {},
      isCodexCliKind: () => false,
      parseClaudeTranscriptToNativeTurns,
      parseClaudeTranscriptToTurns: () => [],
      findTranscriptByCCSessionId: () => null,
      updateSessionTranscriptBinding: () => {},
      commandTranscriptStore: { read: () => [] },
    };
    const result = await parseSessionTranscript({ hubSessionId: 'hub-1', kind: 'claude', opts: { limit: 9, fromTail: true } }, deps);
    assert.equal(result.error, null);
    assert.ok(JSON.stringify(result).length < JSON.stringify(full).length / 4, 'the payload shrinks by the image and the long log');

    for (const id of ['shot', 'test', 'small']) {
      const before = normalizeToolActivity(toolById(full, id));
      const after = normalizeToolActivity(toolById(result.turns, id));
      assert.equal(after.status, before.status);
      assert.equal(after.kind, before.kind);
      assert.equal(after.detail, before.detail);
    }
    const before = buildTurnPresentation(full.at(-1)), after = buildTurnPresentation(result.turns.at(-1));
    assert.deepEqual(after.delivery, before.delivery, 'delivery summary, including test checks, is unchanged');
    assert.equal(after.delivery.checks.find(check => check.id === 'test').status, 'completed', 'the test summary printed last is still recognised');
    assert.equal(toolById(result.turns, 'small').resultRef, undefined, 'small outputs stay inline');

    for (const id of ['shot', 'test']) {
      const tool = toolById(result.turns, id);
      assert.equal(tool.resultTruncated, true);
      const text = await readCompactedToolResult(tool.resultRef);
      assert.equal(text, normalizeToolActivity(toolById(full, id)).result, '查看全文 returns exactly the original result');
    }

    const ipc = { handlers: new Map(), handle(channel, fn) { this.handlers.set(channel, fn); } };
    registerTranscriptIpc(ipc, deps);
    const viaIpc = await ipc.handlers.get('claude-transcript:tool-result')({}, toolById(result.turns, 'test').resultRef);
    assert.equal(viaIpc, LONG_LOG);
    await assert.rejects(readCompactedToolResult({ source: 'claude-transcript-file', transcriptPath: path.join(dir, 'other.jsonl'), itemId: 'test' }),
      /重新载入/, 'a transcript the Hub never served cannot be read through this channel');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
