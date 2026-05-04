const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  parseClaudeTranscriptToTurns,
  parseAssistantContent,
  isToolResultEntry,
  extractToolResults,
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
test('skip tool_result + W5 merge: [u, a(tool_use), tr, a(end_turn)] → 2 turns (1 user + 1 merged-assistant)', () => {
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
    // W5: 两个相邻 assistant entries (a1 tool_use + a2 end_turn) 合为 1 logical turn。
    // tool_result 仍被跳过（不被算作 user 消息）。
    assert.strictEqual(turns.length, 2, 'tool_result skipped + 2 assistants merged → 2 turns');
    assert.strictEqual(turns[0].role, 'user');
    assert.strictEqual(turns[0].id, 'u-1');
    assert.strictEqual(turns[1].role, 'assistant');
    assert.strictEqual(turns[1].id, 'a-1', 'merged turn id = first assistant entry uuid');
    assert.strictEqual(turns[1].mergedCount, 2, 'mergedCount tracks how many entries combined');
    assert.strictEqual(turns[1].stopReason, 'end_turn', 'stopReason from last entry');
    assert.strictEqual(turns[1].toolCalls.length, 1, 'a1 toolCalls preserved');
    assert.ok(turns[1].text.includes('calling tool') && turns[1].text.includes('done'),
      'text from both entries joined');
    assert.ok(!turns.some(t => typeof t.text === 'string' && t.text.includes('file1\nfile2')),
      'tool_result content not surfaced');
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

// ---- Test 5: stop_reason 各种值 + W5 合并行为 ----
test('stop_reason values + W5 merge: tool_use chains into next, others terminate', () => {
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
    // W5: a-0 (end_turn) flush 单独; a-1 (tool_use) + a-2 (max_tokens) 合为 1 (max_tokens 终止);
    //     a-3 (stop_sequence) 独立 → 总 3 turns。
    assert.strictEqual(turns.length, 3, 'merge collapses tool_use chain');
    assert.deepStrictEqual(turns.map(t => t.stopReason), ['end_turn', 'max_tokens', 'stop_sequence']);
    assert.deepStrictEqual(turns.map(t => t.id), ['a-0', 'a-1', 'a-3'],
      'merged turn id = first entry of chain');
    assert.strictEqual(turns[1].mergedCount, 2, 'a-1 chain merged 2 entries');
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

// ---- Test 8d: isToolResultEntry tolerant of mixed content arrays ----
test('isToolResultEntry: detects tool_result anywhere in content array (not just first)', () => {
  // CC may produce mixed arrays in future
  const mixed = { type: 'user', message: { content: [
    { type: 'text', text: 'pre' },
    { type: 'tool_result', tool_use_id: 'toolu_x', content: 'r' }
  ]}};
  assert.strictEqual(isToolResultEntry(mixed), true);

  const onlyText = { type: 'user', message: { content: [
    { type: 'text', text: 'hello' }
  ]}};
  assert.strictEqual(isToolResultEntry(onlyText), false);
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

// ---- Test 16: skip empty assistant entries (api error / interrupted / empty content) ----
// 用户反馈：卡片视图偶尔出现"空 assistant 卡片"。根因：assistant entry 的 content
// 完全无 thinking/text/tool_use（API 异常/被打断/拒答）时，旧 parser 仍输出 turn，
// 渲染后视觉为空。修复：assistant 三种 visible content 全无 → skip entry。
test('skip assistant entry with no thinking/text/tool_use (empty content)', () => {
  const userLine = JSON.stringify({
    type: 'user', uuid: 'u-1', timestamp: '2026-01-01T00:00:00Z',
    message: { content: 'hi' },
  });
  const emptyAssistantLine = JSON.stringify({
    type: 'assistant', uuid: 'a-empty', timestamp: '2026-01-01T00:00:01Z',
    message: { content: [], model: 'claude-opus-4-7', stop_reason: 'end_turn' },
  });
  const realAssistantLine = JSON.stringify({
    type: 'assistant', uuid: 'a-real', timestamp: '2026-01-01T00:00:02Z',
    message: {
      content: [{ type: 'text', text: 'reply' }],
      model: 'claude-opus-4-7',
      stop_reason: 'end_turn',
    },
  });
  const p = writeTmp('skip-empty', [userLine, emptyAssistantLine, realAssistantLine].join('\n'));
  try {
    const turns = parseClaudeTranscriptToTurns(p);
    assert.strictEqual(turns.length, 2, 'empty assistant entry should be skipped');
    assert.strictEqual(turns[0].role, 'user');
    assert.strictEqual(turns[1].role, 'assistant');
    assert.strictEqual(turns[1].id, 'a-real');
  } finally { cleanup(p); }
});

// ---- Spec 3 · B2 tail-only fast path ----
// Big file (1000 entries) with fromTail+limit must return correct LAST N turns
// without reading the full file. Used to be readFileSync(whole file) → 200ms+
// on real 5MB transcripts; now reverse-chunk read finishes in <5ms typically.
test('B2 tail-only: fromTail+limit returns last N turns from large file', () => {
  const lines = [];
  for (let i = 0; i < 500; i++) {
    lines.push(JSON.stringify({
      type: 'user', uuid: `u-${i}`,
      timestamp: `2026-05-04T08:00:00.${String(i).padStart(3,'0')}Z`,
      message: { content: `user msg #${i} ` + 'x'.repeat(200) },
    }));
    lines.push(JSON.stringify({
      type: 'assistant', uuid: `a-${i}`,
      timestamp: `2026-05-04T08:00:01.${String(i).padStart(3,'0')}Z`,
      message: {
        model: 'claude-opus-4-7', stop_reason: 'end_turn',
        content: [{ type: 'text', text: `reply #${i} ` + 'y'.repeat(200) }],
      },
    }));
  }
  const fp = writeTmp('B2-tail-large', lines.join('\n') + '\n');
  try {
    const turns = parseClaudeTranscriptToTurns(fp, { limit: 5, fromTail: true });
    assert.strictEqual(turns.length, 5, 'tail returns exactly limit turns');
    // 1000 entries chronologically: ..., a-497, u-498, a-498, u-499, a-499
    // Last 5 (limit:5, fromTail:true): a-497, u-498, a-498, u-499, a-499
    assert.strictEqual(turns[4].id, 'a-499', 'last turn must be a-499');
    assert.strictEqual(turns[3].id, 'u-499');
    assert.strictEqual(turns[2].id, 'a-498');
    assert.strictEqual(turns[1].id, 'u-498');
    assert.strictEqual(turns[0].id, 'a-497');
  } finally { cleanup(fp); }
});

// tail-only must skip tool_result entries (regression guard)
test('B2 tail-only: skips tool_result entries during reverse scan', () => {
  const lines = [
    JSON.stringify({ type: 'user', uuid: 'u-1', timestamp: '2026-01-01T00:00:00Z',
      message: { content: 'q1' } }),
    JSON.stringify({ type: 'assistant', uuid: 'a-1', timestamp: '2026-01-01T00:00:01Z',
      message: { content: [{ type: 'tool_use', id: 'tool_1', name: 'Read', input: { file_path: '/x' } }],
                 model: 'claude-opus-4-7', stop_reason: 'tool_use' } }),
    JSON.stringify({ type: 'user', uuid: 'u-tr', timestamp: '2026-01-01T00:00:02Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'data' }] } }),
    JSON.stringify({ type: 'assistant', uuid: 'a-2', timestamp: '2026-01-01T00:00:03Z',
      message: { content: [{ type: 'text', text: 'final' }],
                 model: 'claude-opus-4-7', stop_reason: 'end_turn' } }),
  ];
  const fp = writeTmp('B2-tool-result', lines.join('\n') + '\n');
  try {
    const turns = parseClaudeTranscriptToTurns(fp, { limit: 10, fromTail: true });
    // W5: a-1 (tool_use) + a-2 (end_turn) merge → 1 turn → 总 2 turns
    assert.strictEqual(turns.length, 2, 'tool_result skipped + 2 assistants merged');
    assert.deepStrictEqual(turns.map(t => t.id), ['u-1', 'a-1']);
    assert.strictEqual(turns[1].mergedCount, 2);
    assert.strictEqual(turns[1].toolCalls.length, 1);
  } finally { cleanup(fp); }
});

// === Spec 3 · 多方审查 P0：input_tokens 不能累加（CLI 每次 call 含完整历史）===
test('R4 P0: input_tokens takes LAST entry value, not summed (avoid O(N^2) inflation)', () => {
  // 模拟 CLI 多轮 call：input_tokens 含历史 → 后续每次都比前次多
  // 这里 a-0 input=1000, a-1 input=1500 (含 a-0 的 history), a-2 input=2200 (含更多 history)
  const lines = [
    JSON.stringify({ type: 'user', uuid: 'u-1', timestamp: '2026-01-01T00:00:00Z',
      message: { content: 'q' } }),
    JSON.stringify({ type: 'assistant', uuid: 'a-0', timestamp: '2026-01-01T00:00:01Z',
      message: { model: 'claude-opus-4-7', stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } }],
        usage: { input_tokens: 1000, output_tokens: 50 } } }),
    JSON.stringify({ type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r1' }] } }),
    JSON.stringify({ type: 'assistant', uuid: 'a-1', timestamp: '2026-01-01T00:00:02Z',
      message: { model: 'claude-opus-4-7', stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/y' } }],
        usage: { input_tokens: 1500, output_tokens: 60 } } }),
    JSON.stringify({ type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'r2' }] } }),
    JSON.stringify({ type: 'assistant', uuid: 'a-2', timestamp: '2026-01-01T00:00:03Z',
      message: { model: 'claude-opus-4-7', stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'done' }],
        usage: { input_tokens: 2200, output_tokens: 30 } } }),
  ];
  const fp = writeTmp('R4-input-tokens-not-summed', lines.join('\n') + '\n');
  try {
    const turns = parseClaudeTranscriptToTurns(fp);
    const a = turns[1];
    assert.strictEqual(a.role, 'assistant');
    assert.strictEqual(a.mergedCount, 3);
    // 关键断言：input_tokens = 最后一条 a-2 的 2200，不是 1000+1500+2200=4700
    assert.strictEqual(a.usage.input_tokens, 2200,
      'input_tokens MUST = last entry value (max ctx size), NOT sum (O(N^2) inflation)');
    // output_tokens 仍累加（每次 call 自己的输出）
    assert.strictEqual(a.usage.output_tokens, 50 + 60 + 30,
      'output_tokens still summed (each call has own output)');
  } finally { cleanup(fp); }
});

// === Spec 3 · W9 tool_result association tests ===

test('W9 extractToolResults: string content + isError flag preserved', () => {
  const entry = { type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 't-1', content: 'stdout text' },
    { type: 'tool_result', tool_use_id: 't-2', content: 'err msg', is_error: true },
  ]}};
  const out = extractToolResults(entry);
  assert.strictEqual(out.length, 2);
  assert.deepStrictEqual(out[0], { tool_use_id: 't-1', content: 'stdout text', isError: false });
  assert.deepStrictEqual(out[1], { tool_use_id: 't-2', content: 'err msg', isError: true });
});

test('W9 extractToolResults: array content (text blocks) joined', () => {
  const entry = { type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 't-x', content: [
      { type: 'text', text: 'line1' },
      { type: 'image', source: {} },  // image 跳过
      { type: 'text', text: 'line2' },
    ]},
  ]}};
  const out = extractToolResults(entry);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].content, 'line1\nline2');
});

test('W9 parser: tool_use.result populated from tool_result entry', () => {
  const lines = [
    JSON.stringify({ type: 'user', uuid: 'u-1', timestamp: '2026-01-01T00:00:00Z',
      message: { content: 'q' } }),
    JSON.stringify({ type: 'assistant', uuid: 'a-1', timestamp: '2026-01-01T00:00:01Z',
      message: { model: 'claude-opus-4-7', stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'toolu_x', name: 'Bash', input: { command: 'ls' } }] }
    }),
    JSON.stringify({ type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'file1\nfile2' }] }
    }),
    JSON.stringify({ type: 'assistant', uuid: 'a-2', timestamp: '2026-01-01T00:00:03Z',
      message: { model: 'claude-opus-4-7', stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'done' }] }
    }),
  ];
  const fp = writeTmp('W9-result-assoc', lines.join('\n') + '\n');
  try {
    const turns = parseClaudeTranscriptToTurns(fp);
    assert.strictEqual(turns.length, 2, 'user + merged assistant');
    const a = turns[1];
    assert.strictEqual(a.toolCalls.length, 1);
    assert.strictEqual(a.toolCalls[0].id, 'toolu_x');
    assert.strictEqual(a.toolCalls[0].result, 'file1\nfile2', 'result populated from tool_result');
    assert.strictEqual(a.toolCalls[0].isError, false);
  } finally { cleanup(fp); }
});

test('W9 parser: is_error flag propagates to toolCall.isError', () => {
  const lines = [
    JSON.stringify({ type: 'assistant', uuid: 'a-err', timestamp: '2026-01-01T00:00:00Z',
      message: { model: 'claude-opus-4-7', stop_reason: 'end_turn',
        content: [{ type: 'tool_use', id: 'toolu_err', name: 'Bash', input: { command: 'fail' } }] }
    }),
    JSON.stringify({ type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_err',
        content: 'command failed', is_error: true }] }
    }),
  ];
  const fp = writeTmp('W9-error-flag', lines.join('\n') + '\n');
  try {
    const turns = parseClaudeTranscriptToTurns(fp);
    assert.strictEqual(turns.length, 1);
    assert.strictEqual(turns[0].toolCalls[0].isError, true);
    assert.strictEqual(turns[0].toolCalls[0].result, 'command failed');
  } finally { cleanup(fp); }
});

// === Spec 3 · W5 merge architecture tests ===

// 长 tool 链：1 user + 5 个 1-tool assistant + 1 final → user + 1 merged turn
test('W5 merge: 5 consecutive 1-tool entries + 1 final = 1 user + 1 merged turn (6 toolCalls)', () => {
  const lines = [
    JSON.stringify({ type: 'user', uuid: 'u-q', timestamp: '2026-01-01T00:00:00Z',
      message: { content: 'do many things' } }),
  ];
  for (let i = 0; i < 5; i++) {
    lines.push(JSON.stringify({
      type: 'assistant', uuid: `a-${i}`, timestamp: `2026-01-01T00:00:0${i+1}Z`,
      message: { model: 'claude-opus-4-7', stop_reason: 'tool_use',
        content: [
          { type: 'thinking', thinking: `think-${i}` },
          { type: 'tool_use', id: `t-${i}`, name: 'Bash', input: { command: `cmd-${i}` } }
        ],
        usage: { input_tokens: 1000, output_tokens: 200 }
      }
    }));
    lines.push(JSON.stringify({ type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: `t-${i}`, content: `out-${i}` }] }
    }));
  }
  lines.push(JSON.stringify({
    type: 'assistant', uuid: 'a-final', timestamp: '2026-01-01T00:01:00Z',
    message: { model: 'claude-opus-4-7', stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'all done!' }],
      usage: { input_tokens: 5000, output_tokens: 100 }
    }
  }));
  const fp = writeTmp('W5-long-chain', lines.join('\n') + '\n');
  try {
    const turns = parseClaudeTranscriptToTurns(fp);
    assert.strictEqual(turns.length, 2, '6 raw assistants → 1 merged turn');
    assert.strictEqual(turns[0].role, 'user');
    const a = turns[1];
    assert.strictEqual(a.role, 'assistant');
    assert.strictEqual(a.id, 'a-0', 'merged id = first entry');
    assert.strictEqual(a.mergedCount, 6);
    assert.strictEqual(a.toolCalls.length, 5, '5 tool_use aggregated');
    assert.strictEqual(a.text, 'all done!');
    assert.ok(a.thinking.includes('think-0') && a.thinking.includes('think-4'),
      'all thinking concatenated');
    assert.strictEqual(a.stopReason, 'end_turn', 'last entry stop_reason wins');
    assert.strictEqual(a.tsEnd, new Date('2026-01-01T00:01:00Z').getTime(), 'tsEnd = last entry ts');
    // 多方审查 P0 fix：input_tokens 不累加，取最后一条 (a-final 是 5000)
    // 因为 Claude API 每次 call 的 input_tokens 含完整历史，累加 = O(N²) 虚高
    assert.strictEqual(a.usage.input_tokens, 5000, 'input_tokens = last entry value (not summed)');
    assert.strictEqual(a.usage.output_tokens, 100 + 5*200, 'output_tokens still summed (each call is own output)');
  } finally { cleanup(fp); }
});

// user 出现立即 flush（不会跨 user 合并）
test('W5 merge: user message flushes accumulator (no merge across user turns)', () => {
  const lines = [
    JSON.stringify({ type: 'user', uuid: 'u-1', timestamp: '2026-01-01T00:00:00Z',
      message: { content: 'q1' } }),
    JSON.stringify({ type: 'assistant', uuid: 'a-1', timestamp: '2026-01-01T00:00:01Z',
      message: { model: 'claude-opus-4-7', stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } }] }
    }),
    // 这条 a-1 的 tool_use 没有等到 tool_result 就被 user 打断
    JSON.stringify({ type: 'user', uuid: 'u-2', timestamp: '2026-01-01T00:01:00Z',
      message: { content: 'q2' } }),
    JSON.stringify({ type: 'assistant', uuid: 'a-2', timestamp: '2026-01-01T00:01:01Z',
      message: { model: 'claude-opus-4-7', stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'reply2' }] }
    }),
  ];
  const fp = writeTmp('W5-user-flush', lines.join('\n') + '\n');
  try {
    const turns = parseClaudeTranscriptToTurns(fp);
    assert.strictEqual(turns.length, 4, 'user flushes acc, no cross-user merge');
    assert.deepStrictEqual(turns.map(t => t.id), ['u-1', 'a-1', 'u-2', 'a-2']);
    assert.strictEqual(turns[1].mergedCount, 1);
    assert.strictEqual(turns[3].mergedCount, 1);
  } finally { cleanup(fp); }
});

// thinking-only assistant entry must NOT be skipped (renders as 💭 思考过程 summary)
test('keep assistant entry with thinking-only content (not skipped)', () => {
  const line = JSON.stringify({
    type: 'assistant', uuid: 'a-think', timestamp: '2026-01-01T00:00:00Z',
    message: {
      content: [{ type: 'thinking', thinking: 'planning…' }],
      model: 'claude-opus-4-7', stop_reason: 'tool_use',
    },
  });
  const p = writeTmp('keep-thinking-only', line);
  try {
    const turns = parseClaudeTranscriptToTurns(p);
    assert.strictEqual(turns.length, 1, 'thinking-only assistant should NOT be skipped');
    assert.strictEqual(turns[0].thinking, 'planning…');
    assert.strictEqual(turns[0].text, '');
  } finally { cleanup(p); }
});
