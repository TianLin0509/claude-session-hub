const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readLastAssistantMessage } = require('../core/read-last-assistant.js');

let tmpCounter = 0;
function writeTmp(name, content) {
  tmpCounter += 1;
  const p = path.join(
    os.tmpdir(),
    `test-read-last-assistant-${process.pid}-${Date.now()}-${tmpCounter}-${name}`
  );
  fs.writeFileSync(p, content, 'utf8');
  return p;
}
function cleanup(p) {
  try { fs.unlinkSync(p); } catch {}
}

function userLine(uuid, text, ts = '2026-05-04T08:00:00.000Z') {
  return JSON.stringify({
    type: 'user',
    uuid,
    timestamp: ts,
    message: { content: text },
  });
}
function assistantLine(uuid, text, opts = {}) {
  const {
    ts = '2026-05-04T08:00:01.000Z',
    model = 'claude-opus-4-7',
    stop_reason = 'end_turn',
    usage = { input_tokens: 10, output_tokens: 5 },
  } = opts;
  return JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: ts,
    message: {
      model,
      stop_reason,
      content: [{ type: 'text', text }],
      usage,
    },
  });
}
function toolResultUserLine(uuid, toolUseId = 'tu-1') {
  return JSON.stringify({
    type: 'user',
    uuid,
    timestamp: '2026-05-04T08:00:02.000Z',
    message: {
      content: [{
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: 'tool output',
      }],
    },
  });
}

// ---- Test 1: Basic — 1 user + 1 assistant → returns assistant ----
test('basic: 1 user + 1 assistant → returns assistant text', async () => {
  const fp = writeTmp('basic.jsonl',
    userLine('u-1', 'hello') + '\n' +
    assistantLine('a-1', 'hi there') + '\n'
  );
  try {
    const result = await readLastAssistantMessage(fp);
    assert.ok(result, 'expected non-null result');
    assert.strictEqual(result.text, 'hi there');
    assert.strictEqual(result.id, 'a-1');
    assert.strictEqual(result.model, 'claude-opus-4-7');
    assert.strictEqual(result.stopReason, 'end_turn');
    assert.deepStrictEqual(result.usage, { input_tokens: 10, output_tokens: 5 });
    assert.strictEqual(result.thinking, null);
    assert.deepStrictEqual(result.toolCalls, []);
    assert.ok(typeof result.ts === 'number' && result.ts > 0);
  } finally {
    cleanup(fp);
  }
});

// ---- Test 2: Multiple assistants → returns the LAST one ----
test('multiple assistants: [u, a1, u, a2] → returns a2', async () => {
  const fp = writeTmp('multi.jsonl',
    userLine('u-1', 'first') + '\n' +
    assistantLine('a-1', 'first reply', { ts: '2026-05-04T08:00:01.000Z' }) + '\n' +
    userLine('u-2', 'second') + '\n' +
    assistantLine('a-2', 'second reply', { ts: '2026-05-04T08:00:03.000Z', model: 'claude-sonnet-4-5' }) + '\n'
  );
  try {
    const result = await readLastAssistantMessage(fp);
    assert.ok(result);
    assert.strictEqual(result.text, 'second reply');
    assert.strictEqual(result.id, 'a-2');
    assert.strictEqual(result.model, 'claude-sonnet-4-5');
  } finally {
    cleanup(fp);
  }
});

// ---- Test 3: Skip tool_result-shaped user entries between assistants ----
test('tool_result-shaped user does not confuse scan: [u, a1, tool_result-as-user, a2] → returns a2', async () => {
  const fp = writeTmp('with-toolresult.jsonl',
    userLine('u-1', 'hi') + '\n' +
    assistantLine('a-1', 'reply 1') + '\n' +
    toolResultUserLine('tr-1') + '\n' +
    assistantLine('a-2', 'reply 2 after tool', { ts: '2026-05-04T08:00:05.000Z' }) + '\n'
  );
  try {
    const result = await readLastAssistantMessage(fp);
    assert.ok(result);
    assert.strictEqual(result.text, 'reply 2 after tool');
    assert.strictEqual(result.id, 'a-2');
  } finally {
    cleanup(fp);
  }
});

// ---- Test 4: No assistant at all → returns null ----
test('no assistant in file → returns null', async () => {
  const fp = writeTmp('user-only.jsonl',
    userLine('u-1', 'just me') + '\n' +
    userLine('u-2', 'still just me') + '\n'
  );
  try {
    const result = await readLastAssistantMessage(fp);
    assert.strictEqual(result, null);
  } finally {
    cleanup(fp);
  }
});

// ---- Test 4b: empty file → returns null ----
test('empty file → returns null', async () => {
  const fp = writeTmp('empty.jsonl', '');
  try {
    const result = await readLastAssistantMessage(fp);
    assert.strictEqual(result, null);
  } finally {
    cleanup(fp);
  }
});

// ---- Test 4c: nonexistent file → returns null (does not throw) ----
test('nonexistent file → returns null (does not throw)', async () => {
  const result = await readLastAssistantMessage(
    path.join(os.tmpdir(), `does-not-exist-${process.pid}-${Date.now()}.jsonl`)
  );
  assert.strictEqual(result, null);
});

// ---- Test 5: Real CC fixture ----
test('real fixture: parses claude-opus-4-6 hello session', async (t) => {
  const fixture = path.join(
    os.homedir(),
    '.claude', 'projects', 'C--Users-lintian',
    '30a4345b-0083-4acc-8030-0fd8b3d5fded.jsonl'
  );
  if (!fs.existsSync(fixture)) {
    t.skip(`fixture not present: ${fixture}`);
    return;
  }
  const result = await readLastAssistantMessage(fixture);
  assert.ok(result, 'expected non-null result from real fixture');
  assert.ok(result.text.includes('你好'), `expected text to contain 你好, got: ${JSON.stringify(result.text)}`);
  assert.strictEqual(result.model, 'claude-opus-4-6');
  assert.strictEqual(result.stopReason, 'end_turn');
  assert.ok(result.usage && typeof result.usage === 'object', 'usage should be an object');
  assert.ok(typeof result.ts === 'number' && result.ts > 0, 'ts should be a positive number');
});
