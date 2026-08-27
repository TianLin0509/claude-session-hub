'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  clearCodexSemanticCache,
  getCodexSemanticCacheStats,
  isCodexSubagentRolloutMeta,
  parseCodexRolloutToTurns,
  readCodexRolloutMeta,
} = require('../core/codex-transcript-parser.js');
const {
  createCodexLineFilter,
  streamCodexJsonlRecordsSync,
} = require('../core/codex-rollout-reader.js');
const { JsonlTail } = require('../core/jsonl-tail.js');

function row(value) {
  return `${JSON.stringify(value)}\n`;
}

function user(message, timestamp) {
  return {
    timestamp,
    type: 'event_msg',
    payload: { type: 'user_message', message },
  };
}

function complete(message, timestamp) {
  return {
    timestamp,
    type: 'event_msg',
    payload: { type: 'task_complete', last_agent_message: message },
  };
}

test('Codex semantic scanner discards Base64/tool output before decoding the line body', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-stream-guard-'));
  const filePath = path.join(root, 'rollout.jsonl');
  t.after(() => {
    clearCodexSemanticCache(filePath);
    fs.rmSync(root, { recursive: true, force: true });
  });

  fs.writeFileSync(filePath, [
    row(user('first question', '2026-08-27T01:00:00.000Z')),
    row({
      timestamp: '2026-08-27T01:00:00.100Z',
      type: 'response_item',
      payload: {
        type: 'custom_tool_call_output',
        output: `data:image/png;base64,${'A'.repeat(2 * 1024 * 1024)}`,
      },
    }),
    row({
      timestamp: '2026-08-27T01:00:00.200Z',
      type: 'event_msg',
      payload: {
        type: 'image_generation_end',
        image_url: `data:image/png;base64,${'B'.repeat(2 * 1024 * 1024)}`,
      },
    }),
    row(complete('first answer', '2026-08-27T01:00:01.000Z')),
  ].join(''), 'utf8');

  const seen = [];
  const stats = streamCodexJsonlRecordsSync(filePath, record => seen.push(record), { profile: 'turns' });
  assert.deepEqual(seen.map(record => record.payload.type), ['user_message', 'task_complete']);
  assert.ok(stats.skippedBytes > 4 * 1024 * 1024, JSON.stringify(stats));
  assert.ok(stats.maxBufferedLineBytes <= 64 * 1024, JSON.stringify(stats));

  const turns = parseCodexRolloutToTurns(filePath, { limit: 50, fromTail: true });
  assert.deepEqual(turns.map(turn => turn.text), ['first question', 'first answer']);
  const cache = getCodexSemanticCacheStats(filePath);
  assert.equal(cache.fullScans, 1);
  assert.equal(cache.semanticRecords, 2);
  assert.ok(cache.scanStats.skippedBytes > 4 * 1024 * 1024, JSON.stringify(cache));
});

test('oversized session_meta projects identity fields without loading base instructions', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-meta-projection-'));
  const filePath = path.join(root, 'rollout.jsonl');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sid = '11111111-2222-7333-8444-666666666666';
  const parent = '11111111-2222-7333-8444-777777777777';
  fs.writeFileSync(filePath, row({
    timestamp: '2026-08-27T01:30:00.000Z',
    type: 'session_meta',
    payload: {
      session_id: sid,
      id: sid,
      forked_from_id: parent,
      timestamp: '2026-08-27T01:30:00.000Z',
      cwd: 'C:\\large-meta',
      source: { subagent: { thread_spawn: { parent_thread_id: parent } } },
      thread_source: 'subagent',
      base_instructions: { text: 'I'.repeat(2 * 1024 * 1024) },
    },
  }), 'utf8');
  const meta = readCodexRolloutMeta(filePath);
  assert.equal(meta.id, sid);
  assert.equal(meta.forked_from_id, parent);
  assert.equal(meta.cwd, 'C:\\large-meta');
  assert.equal(isCodexSubagentRolloutMeta(meta), true);
  assert.equal(Object.hasOwn(meta, 'base_instructions'), false);
});

test('Codex semantic cache scans only appended bytes after the first full projection', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-stream-incremental-'));
  const filePath = path.join(root, 'rollout.jsonl');
  t.after(() => {
    clearCodexSemanticCache(filePath);
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.writeFileSync(filePath,
    row(user('question one', '2026-08-27T02:00:00.000Z'))
    + row(complete('answer one', '2026-08-27T02:00:01.000Z')),
    'utf8');
  assert.equal(parseCodexRolloutToTurns(filePath).length, 2);

  fs.appendFileSync(filePath,
    row(user('question two', '2026-08-27T02:01:00.000Z'))
    + row(complete('answer two', '2026-08-27T02:01:01.000Z')),
    'utf8');
  const latest = parseCodexRolloutToTurns(filePath, { limit: 2, fromTail: true });
  assert.deepEqual(latest.map(turn => turn.text), ['question two', 'answer two']);
  const cache = getCodexSemanticCacheStats(filePath);
  assert.equal(cache.scanMode, 'incremental');
  assert.equal(cache.fullScans, 1);
  assert.equal(cache.incrementalScans, 1);
  assert.ok(cache.scanStats.bytesSeen < cache.fileSize, JSON.stringify(cache));

  fs.writeFileSync(filePath,
    row(user('replacement question', '2026-08-27T02:02:00.000Z'))
    + row(complete('replacement answer', '2026-08-27T02:02:01.000Z')),
    'utf8');
  const replaced = parseCodexRolloutToTurns(filePath, { limit: 10, fromTail: true });
  assert.deepEqual(replaced.map(turn => turn.text), ['replacement question', 'replacement answer']);
  const replacedCache = getCodexSemanticCacheStats(filePath);
  assert.equal(replacedCache.scanMode, 'full');
  assert.equal(replacedCache.fullScans, 2);
});

test('live Codex tail applies the same byte-level garbage filter', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-live-tail-filter-'));
  const filePath = path.join(root, 'rollout.jsonl');
  fs.writeFileSync(filePath,
    row({ type: 'response_item', payload: { type: 'function_call_output', output: 'C'.repeat(2 * 1024 * 1024) } })
    + row(complete('live final', '2026-08-27T03:00:01.000Z')),
    'utf8');
  const seen = [];
  const tail = new JsonlTail(filePath, record => seen.push(record), {
    lineFilter: createCodexLineFilter('live'),
    maxReadBytes: 256 * 1024,
  });
  t.after(() => {
    tail.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await tail.start();
  assert.deepEqual(seen.map(record => record.payload.type), ['task_complete']);
  const stats = tail.getStats();
  assert.ok(stats.maxBufferedLineBytes <= 64 * 1024, JSON.stringify(stats));
  assert.ok(stats.skippedBytes > 2 * 1024 * 1024, JSON.stringify(stats));
});
