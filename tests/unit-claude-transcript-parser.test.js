const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  parseClaudeTranscriptToTurns,
  parseAssistantContent,
  isToolResultEntry,
} = require('../core/claude-transcript-parser.js');

let tmpCounter = 0;
function writeTmp(name, content) {
  tmpCounter += 1;
  const p = path.join(
    os.tmpdir(),
    `test-claude-parser-${process.pid}-${Date.now()}-${tmpCounter}-${name}`
  );
  fs.writeFileSync(p, content, 'utf8');
  return p;
}
function cleanup(p) {
  try { fs.unlinkSync(p); } catch {}
}

// ---- Test 1: 基本解析（1 user + 1 assistant） ----
test('basic: 1 user + 1 assistant → 2 turns with correct fields', () => {
  const userLine = JSON.stringify({
    type: 'user',
    uuid: 'u-1',
    timestamp: '2026-05-04T08:00:00.000Z',
    message: { content: 'hello world' },
  });
  const assistantLine = JSON.stringify({
    type: 'assistant',
    uuid: 'a-1',
    timestamp: '2026-05-04T08:00:01.000Z',
    message: {
      model: 'claude-opus-4-7',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'hi there' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  });
  const fp = writeTmp('basic.jsonl', userLine + '\n' + assistantLine + '\n');
  try {
    const turns = parseClaudeTranscriptToTurns(fp);
    assert.strictEqual(turns.length, 2);
    assert.strictEqual(turns[0].role, 'user');
    assert.strictEqual(turns[0].text, 'hello world');
    assert.strictEqual(turns[0].id, 'u-1');
    assert.strictEqual(turns[0].ts, new Date('2026-05-04T08:00:00.000Z').getTime());
    assert.strictEqual(turns[1].role, 'assistant');
    assert.strictEqual(turns[1].text, 'hi there');
    assert.strictEqual(turns[1].id, 'a-1');
    assert.strictEqual(turns[1].model, 'claude-opus-4-7');
    assert.strictEqual(turns[1].stopReason, 'end_turn');
    assert.deepStrictEqual(turns[1].toolCalls, []);
    assert.strictEqual(turns[1].thinking, null);
    assert.deepStrictEqual(turns[1].usage, { input_tokens: 10, output_tokens: 5 });
  } finally {
    cleanup(fp);
  }
});

// ---- Test 2: 跳 tool_result 污染 ----
test('skip tool_result: user(text) + assistant(tool_use) + user(tool_result) + assistant(text) → 3 turns', () => {
  const u1 = JSON.stringify({
    type: 'user', uuid: 'u-1', timestamp: '2026-05-04T08:00:00.000Z',
    message: { content: 'do something' },
  });
  const a1 = JSON.stringify({
    type: 'assistant', uuid: 'a-1', timestamp: '2026-05-04T08:00:01.000Z',
    message: {
      model: 'claude-opus-4-7', stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'calling tool' },
        { type: 'tool_use', id: 'toolu_x', name: 'Bash', input: { command: 'ls' } },
      ],
    },
  });
  const tr = JSON.stringify({
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_x', content: 'file1\nfile2' },
      ],
    },
  });
  const a2 = JSON.stringify({
    type: 'assistant', uuid: 'a-2', timestamp: '2026-05-04T08:00:03.000Z',
    message: {
      model: 'claude-opus-4-7', stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'done' }],
    },
  });
  const fp = writeTmp('toolresult.jsonl', [u1, a1, tr, a2].join('\n') + '\n');
  try {
    const turns = parseClaudeTranscriptToTurns(fp);
    assert.strictEqual(turns.length, 3, 'tool_result row must be skipped');
    assert.strictEqual(turns[0].role, 'user');
    assert.strictEqual(turns[1].role, 'assistant');
    assert.strictEqual(turns[2].role, 'assistant');
    assert.ok(!turns.some(t => typeof t.text === 'string' && t.text.includes('file1\nfile2')));
  } finally {
    cleanup(fp);
  }
});

// ---- Test 3: assistant content 多元素 ----
test('parseAssistantContent: multi-element content (thinking + text + tool_use + text)', () => {
  const out = parseAssistantContent([
    { type: 'thinking', thinking: 'let me think' },
    { type: 'text', text: 'first' },
    { type: 'tool_use', id: 'tu-1', name: 'Read', input: { file: 'a.js' } },
    { type: 'text', text: 'second' },
  ]);
  assert.strictEqual(out.thinking, 'let me think');
  assert.strictEqual(out.text, 'first\nsecond');
  assert.strictEqual(out.toolCalls.length, 1);
  assert.strictEqual(out.toolCalls[0].id, 'tu-1');
  assert.strictEqual(out.toolCalls[0].name, 'Read');
  assert.deepStrictEqual(out.toolCalls[0].input, { file: 'a.js' });
});

// ---- Test 4: 多 tool_use 顺序保留 ----
test('parseAssistantContent: multiple tool_use blocks preserve order', () => {
  const out = parseAssistantContent([
    { type: 'tool_use', id: 'a', name: 'T1', input: {} },
    { type: 'text', text: 'middle' },
    { type: 'tool_use', id: 'b', name: 'T2', input: { x: 1 } },
  ]);
  assert.strictEqual(out.toolCalls.length, 2);
  assert.strictEqual(out.toolCalls[0].id, 'a');
  assert.strictEqual(out.toolCalls[1].id, 'b');
  assert.strictEqual(out.toolCalls[1].name, 'T2');
});

// ---- Test 4b: thinking 多块用 \n\n 拼接 ----
test('parseAssistantContent: multiple thinking blocks joined with \\n\\n', () => {
  const out = parseAssistantContent([
    { type: 'thinking', thinking: 'part1' },
    { type: 'text', text: 'visible' },
    { type: 'thinking', thinking: 'part2' },
  ]);
  assert.strictEqual(out.thinking, 'part1\n\npart2');
  assert.strictEqual(out.text, 'visible');
});

// ---- Test 5: stop_reason 各种值 ----
test('stop_reason: end_turn / tool_use / max_tokens / stop_sequence all preserved as raw string', () => {
  const reasons = ['end_turn', 'tool_use', 'max_tokens', 'stop_sequence'];
  const lines = reasons.map((r, i) => JSON.stringify({
    type: 'assistant',
    uuid: `a-${i}`,
    timestamp: `2026-05-04T08:00:0${i}.000Z`,
    message: {
      model: 'claude-opus-4-7',
      stop_reason: r,
      content: [{ type: 'text', text: `text-${i}` }],
    },
  }));
  const fp = writeTmp('stopreasons.jsonl', lines.join('\n') + '\n');
  try {
    const turns = parseClaudeTranscriptToTurns(fp);
    assert.strictEqual(turns.length, 4);
    assert.deepStrictEqual(turns.map(t => t.stopReason), reasons);
  } finally {
    cleanup(fp);
  }
});

// ---- Test 6: 空 content 数组 ----
test('parseAssistantContent: empty array → defaults', () => {
  const out = parseAssistantContent([]);
  assert.deepStrictEqual(out, { thinking: null, text: '', toolCalls: [] });
});

test('parseAssistantContent: non-array → defaults', () => {
  const out = parseAssistantContent(undefined);
  assert.deepStrictEqual(out, { thinking: null, text: '', toolCalls: [] });
});

// ---- Test 7a: fromTail + limit ----
test('limit + fromTail: returns last N in chronological order', () => {
  // 10 turns, alternating user/assistant
  const lines = [];
  for (let i = 0; i < 10; i++) {
    const isUser = i % 2 === 0;
    lines.push(JSON.stringify(
      isUser
        ? {
            type: 'user', uuid: `u-${i}`,
            timestamp: `2026-05-04T08:00:${String(i).padStart(2, '0')}.000Z`,
            message: { content: `msg-${i}` },
          }
        : {
            type: 'assistant', uuid: `a-${i}`,
            timestamp: `2026-05-04T08:00:${String(i).padStart(2, '0')}.000Z`,
            message: {
              model: 'claude-opus-4-7', stop_reason: 'end_turn',
              content: [{ type: 'text', text: `reply-${i}` }],
            },
          }
    ));
  }
  const fp = writeTmp('tail.jsonl', lines.join('\n') + '\n');
  try {
    const turns = parseClaudeTranscriptToTurns(fp, { limit: 3, fromTail: true });
    assert.strictEqual(turns.length, 3);
    // Should be turns at index 7, 8, 9 in original order
    assert.strictEqual(turns[0].id, 'a-7');
    assert.strictEqual(turns[1].id, 'u-8');
    assert.strictEqual(turns[2].id, 'a-9');
  } finally {
    cleanup(fp);
  }
});

// ---- Test 7b: limit 边界 ----
test('limit boundaries: 0 → [], > total → all, undefined → all', () => {
  const lines = [];
  for (let i = 0; i < 4; i++) {
    lines.push(JSON.stringify({
      type: 'user', uuid: `u-${i}`,
      timestamp: `2026-05-04T08:00:0${i}.000Z`,
      message: { content: `m-${i}` },
    }));
  }
  const fp = writeTmp('limit.jsonl', lines.join('\n') + '\n');
  try {
    assert.deepStrictEqual(parseClaudeTranscriptToTurns(fp, { limit: 0 }), []);
    assert.strictEqual(parseClaudeTranscriptToTurns(fp, { limit: 999 }).length, 4);
    assert.strictEqual(parseClaudeTranscriptToTurns(fp).length, 4);
    // limit=2 fromTail=false → first 2
    const head = parseClaudeTranscriptToTurns(fp, { limit: 2 });
    assert.strictEqual(head.length, 2);
    assert.strictEqual(head[0].id, 'u-0');
    assert.strictEqual(head[1].id, 'u-1');
  } finally {
    cleanup(fp);
  }
});

// ---- Test 8a: 空 JSONL ----
test('empty JSONL → []', () => {
  const fp = writeTmp('empty.jsonl', '');
  try {
    assert.deepStrictEqual(parseClaudeTranscriptToTurns(fp), []);
  } finally {
    cleanup(fp);
  }
});

// ---- Test 8b: 损坏 JSONL 行容错 ----
test('corrupt JSONL line is skipped, others parsed', () => {
  const u = JSON.stringify({
    type: 'user', uuid: 'u-1', timestamp: '2026-05-04T08:00:00.000Z',
    message: { content: 'good user' },
  });
  const a = JSON.stringify({
    type: 'assistant', uuid: 'a-1', timestamp: '2026-05-04T08:00:01.000Z',
    message: {
      model: 'claude-opus-4-7', stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'good reply' }],
    },
  });
  const fp = writeTmp('corrupt.jsonl', [u, 'not-json-at-all{{{', a].join('\n') + '\n');
  try {
    const turns = parseClaudeTranscriptToTurns(fp);
    assert.strictEqual(turns.length, 2);
    assert.strictEqual(turns[0].text, 'good user');
    assert.strictEqual(turns[1].text, 'good reply');
  } finally {
    cleanup(fp);
  }
});

// ---- Test 8c: isToolResultEntry standalone ----
test('isToolResultEntry: detects only the tool_result-shaped user entry', () => {
  assert.strictEqual(isToolResultEntry({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }] },
  }), true);
  assert.strictEqual(isToolResultEntry({
    type: 'user',
    message: { content: 'plain text' },
  }), false);
  assert.strictEqual(isToolResultEntry({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'x' }] },
  }), false);
  assert.strictEqual(isToolResultEntry(null), false);
  assert.strictEqual(isToolResultEntry({}), false);
});

// ---- Test 9: 真实 fixture ----
test('real fixture (30a4345b...) parses without tool_result pollution', (t) => {
  const real = 'C:\\Users\\lintian\\.claude\\projects\\C--Users-lintian\\30a4345b-0083-4acc-8030-0fd8b3d5fded.jsonl';
  if (!fs.existsSync(real)) {
    t.skip('real fixture missing');
    return;
  }
  const turns = parseClaudeTranscriptToTurns(real);
  assert.ok(turns.length >= 2, `expected >= 2 turns, got ${turns.length}`);
  assert.ok(turns.some(x => x.role === 'user'), 'should have at least one user turn');
  assert.ok(turns.some(x => x.role === 'assistant'), 'should have at least one assistant turn');
  // No tool_result text should leak into a turn's text field
  assert.ok(
    !turns.some(x => typeof x.text === 'string' && x.text.includes('"tool_use_id"')),
    'no turn.text should contain raw tool_result payload'
  );
  const a = turns.find(x => x.role === 'assistant');
  assert.ok(a.model && typeof a.model === 'string', 'assistant turn must have a model string');
});
