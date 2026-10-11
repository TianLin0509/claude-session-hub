'use strict';
// Generation speed divides output by the model's own working time; tools,
// sub-agents and waits stay out. Each provider times calls from its records.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { measureTurnSpeed, coveredMs } = require('../core/turn-speed-metrics');
const { parseCodexRolloutText } = require('../core/codex-transcript-parser');
const { claudeDiskRecords } = require('../core/claude-disk-transcript');
const { claudeTranscriptTurns } = require('../core/claude-native-transcript');
const { parseKimiWireText } = require('../core/kimi-transcript-parser');
const { parseGeminiTranscriptToTurns } = require('../core/gemini-transcript-parser');
const { nativeTranscriptTurns } = require('../core/codex-native-transcript');
const { acpTurnUsage } = require('../core/acp-session');
const { speedDisplay } = require('../renderer/turn-speed-display');
const { displayChatTurns } = require('../renderer/simple-chat-display');
const BASE = 1791200000000;
const at = s => new Date(BASE + s * 1000).toISOString();
const text = rows => rows.map(JSON.stringify).join('\n') + '\n';

test('overlapping tool intervals are subtracted once; untimed or impossible generation stays unknown', () => {
  assert.equal(coveredMs([[5, 20], [10, 25], [40, 50], [60, 90]], 0, 70), 40);
  const turn = { role: 'assistant', nativeOutcome: 'completed', ts: 1000, tsEnd: 11000, usage: { output_tokens: 500 } };
  assert.equal(measureTurnSpeed({ ...turn, generation: { outputTokens: 500, activeMs: 5000, method: 'per-call' } })
    .generation.tokensPerSecond, 100);
  for (const generation of [{ outputTokens: 500, activeMs: 50000, method: 'per-call' },
    { outputTokens: 500, activeMs: 5000, method: 'guess' }, { outputTokens: 500, activeMs: 5000, method: 'per-call', invalid: true },
    { outputTokens: 0, activeMs: 5000, method: 'per-call' }, null])
    assert.equal(measureTurnSpeed({ ...turn, generation }).generation, null);
});

test('Claude times each message id from the prompt or latest tool result to its last frame', () => {
  const assistant = (id, s, output, content, stop = 'tool_use') => ({ type: 'assistant', uuid: `${id}-${s}`, timestamp: at(s),
    message: { id, content, stop_reason: stop, usage: { input_tokens: 10, output_tokens: output } } });
  const result = (s, id) => ({ type: 'user', uuid: 'r' + s, timestamp: at(s),
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
  const rows = [{ type: 'user', uuid: 'u', timestamp: at(0), message: { content: 'hello' } },
    assistant('m1', 4, 200, [{ type: 'thinking', thinking: 'plan' }]),
    assistant('m1', 5, 200, [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]),
    result(65, 't1'), assistant('m2', 71, 400, [{ type: 'text', text: 'answer' }], 'end_turn')];
  const card = claudeTranscriptTurns(claudeDiskRecords(rows)).at(-1);
  assert.equal(card.turnSpeed.tokensPerSecond, 600 / 71);
  assert.deepEqual({ ...card.turnSpeed.generation }, { outputTokens: 600, activeMs: 11000, tokensPerSecond: 600 / 11,
    calls: 2, method: 'per-call' });
  assert.equal(displayChatTurns([card])[0].turnSpeed.generation.calls, 2);
  const continued = claudeTranscriptTurns(claudeDiskRecords([...rows,
    { type: 'user', uuid: 'n', timestamp: at(80), origin: { kind: 'task-notification' }, message: { content: '<task-notification>done</task-notification>' } },
    assistant('m3', 84, 100, [{ type: 'text', text: 'more' }], 'end_turn')])).at(-1);
  assert.equal(continued.turnSpeed.generation.outputTokens, 700);
  assert.equal(continued.turnSpeed.generation.activeMs, 15000);
});

test('Codex times own-turn usage records; oversized tool output falls back to the next token_count', () => {
  const row = (type, payload, s) => ({ type, payload, timestamp: at(s) });
  const event = (type, values, s) => row('event_msg', { type, ...values }, s);
  const record = (turn, output, s, total = output) => row('token_usage_record', { turn_id: turn,
    usage: { output_tokens: output }, turn_token_usage: { input_tokens: 10, output_tokens: total, reasoning_output_tokens: 0 } }, s);
  const rows = [event('task_started', { turn_id: 'turn-1' }, 0),
    row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }, 1),
    row('response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'sleep' }, 4), record('turn-1', 100, 4),
    row('response_item', { type: 'custom_tool_call_output', call_id: 'c1', output: 'done' }, 24),
    event('token_count', { info: null }, 24), record('sub-agent-turn', 9999, 25), record('turn-1', 400, 30, 500),
    event('task_complete', { last_agent_message: 'answer' }, 31)];
  const generation = parseCodexRolloutText(text(rows)).at(-1).turnSpeed.generation;
  assert.deepEqual([generation.outputTokens, generation.activeMs, generation.calls], [500, 9000, 2]);
  const dropped = rows.filter(r => r.payload.type !== 'custom_tool_call_output');
  assert.equal(parseCodexRolloutText(text(dropped)).at(-1).turnSpeed.generation.activeMs, 9000);
  const noTools = rows.filter(r => !/custom_tool_call/.test(r.payload.type));
  assert.equal(parseCodexRolloutText(text(noTools)).at(-1).turnSpeed.generation.activeMs, 3000 + 26000,
    'a token_count without a tool request does not move the start');
});

test('Kimi steps run from llm.request to the first tool call or step end; untimed steps hide the rate', () => {
  const loop = (event, s) => ({ type: 'context.append_loop_event', event, time: BASE + s * 1000 });
  const rows = [{ type: 'turn.prompt', input: [{ type: 'text', text: 'hello' }], time: BASE },
    loop({ type: 'step.begin', uuid: 's1' }, 0), { type: 'llm.request', kind: 'loop', time: BASE + 1000 },
    loop({ type: 'tool.call', stepUuid: 's1', toolCallId: 't', name: 'Bash' }, 5),
    loop({ type: 'tool.result', toolCallId: 't' }, 20),
    loop({ type: 'step.end', uuid: 's1', finishReason: 'tool_use', usage: { output: 100, inputOther: 10 } }, 20),
    loop({ type: 'step.begin', uuid: 's2' }, 20), { type: 'llm.request', kind: 'loop', time: BASE + 21000 },
    loop({ type: 'content.part', stepUuid: 's2', part: { type: 'text', text: 'answer' } }, 25),
    loop({ type: 'step.end', uuid: 's2', finishReason: 'stop', usage: { output: 200, inputOther: 10 } }, 30)];
  const generation = parseKimiWireText(text(rows)).at(-1).turnSpeed.generation;
  assert.deepEqual([generation.outputTokens, generation.activeMs, generation.calls], [300, 13000, 2]);
  assert.equal(parseKimiWireText(text(rows.filter(r => r.type !== 'llm.request'))).at(-1).turnSpeed.generation, null);
});

test('Gemini replies are timed from the latest prompt, reply or tool completion; thoughts count as output', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-gemini-speed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, text([{ sessionId: 's' }, { id: 'u', type: 'user', timestamp: at(0), content: 'hello' },
    { id: 'g1', type: 'gemini', timestamp: at(5), content: '', tokens: { input: 10, output: 40, thoughts: 60, total: 110 },
      toolCalls: [{ id: 't', name: 'shell', status: 'success', timestamp: at(15) }] },
    { id: 'g2', type: 'gemini', timestamp: at(20), content: 'answer', tokens: { input: 10, output: 100, thoughts: 0, total: 110 } }]));
  const [, first, second] = parseGeminiTranscriptToTurns(file);
  assert.equal(first.turnSpeed.generation.tokensPerSecond, 20);
  assert.equal(second.turnSpeed.generation.tokensPerSecond, 20);
  assert.equal(second.turnSpeed.generation.activeMs, 5000);
});

test('native and ACP turns subtract running tools; ACP usage comes from the result or Qwen usage log', t => {
  const turn = { id: 't', status: 'completed', hubStartedAt: BASE, hubCompletedAt: BASE + 30000,
    hubUsage: { input_tokens: 10, output_tokens: 300 }, items: [
      { id: 'u', type: 'userMessage', content: [{ type: 'text', text: 'hello' }] },
      { id: 'a', type: 'acpTool', hubStartedAt: BASE + 4000, hubRunningAt: BASE + 5000, hubCompletedAt: BASE + 20000 },
      { id: 'c', type: 'commandExecution', hubStartedAt: BASE + 10000, hubCompletedAt: BASE + 25000 },
      { id: 'm', type: 'agentMessage', text: 'answer', hubStartedAt: BASE + 26000 }] };
  const card = nativeTranscriptTurns('thread', [turn]).at(-1);
  assert.deepEqual([card.turnSpeed.tokensPerSecond, card.turnSpeed.generation.tokensPerSecond], [10, 30]);
  const untimed = { ...turn, items: [...turn.items, { id: 'x', type: 'acpTool' }] };
  assert.equal(nativeTranscriptTurns('thread', [untimed]).at(-1).turnSpeed.generation, null, 'an untimed tool is not guessed');

  assert.deepEqual(acpTurnUsage({ kind: 'glm' }, 'th', { usage: { inputTokens: 9, outputTokens: 556 } }, BASE, BASE + 1),
    { hubUsage: { input_tokens: 9, output_tokens: 556 } });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-qwen-usage-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const d = new Date(BASE), month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  fs.mkdirSync(path.join(home, '.qwen', 'usage'), { recursive: true });
  const log = (sessionId, s, output, ms, source = 'main') => ({ sessionId, source, timestamp: at(s), inputTokens: 100,
    outputTokens: output, apiDurationMs: ms });
  fs.writeFileSync(path.join(home, '.qwen', 'usage', `token-usage-${month}.jsonl`), text([log('th', 5, 189, 6748),
    log('other', 6, 999, 100), log('th', 7, 999, 100, 'subagent'), log('th', 40, 1181, 32107), log('th', 99, 50, 1000)]));
  assert.deepEqual(acpTurnUsage({ kind: 'qwen', home }, 'th', { stopReason: 'end_turn' }, BASE, BASE + 41000), {
    hubUsage: { input_tokens: 200, output_tokens: 1370 },
    hubGeneration: { outputTokens: 1370, activeMs: 38855, calls: 2, method: 'api-duration' } });
});

test('Qwen terminal rows feed tool results and per-response usage into the Claude projection', async t => {
  const { QwenCliSession } = require('../core/qwen-cli-session');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-qwen-cli-speed-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, 'chats', 'sid.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(path.join(home, '.qwen'));
  fs.writeFileSync(path.join(home, '.qwen', 'settings.json'), '{}');
  const row = (type, s, message, extra = {}) => ({ uuid: type + s, sessionId: 'sid', type, timestamp: at(s), message, ...extra });
  fs.writeFileSync(file, text([row('user', 0, { parts: [{ text: 'hello' }] }, { provenance: 'real_user' }),
    row('assistant', 7, { parts: [{ text: 'run', thought: true }, { functionCall: { id: 'c', name: 'shell', args: {} } }] },
      { usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 189 } }),
    row('tool_result', 24, { parts: [{ functionResponse: { id: 'c', response: { output: 'done' } } }] }),
    row('assistant', 56, { parts: [{ text: 'answer' }] }, { usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 1181 } })]));
  const session = new QwenCliSession({ id: 'q', kind: 'qwen', home, cwd: home, launch: { args: [] } });
  session.threadId = 'sid'; session.bindRecord = () => {}; session.changed = () => {};
  session.loadTranscript(file);
  t.after(() => session.transcriptTail?.close());
  for (let i = 0; i < 50 && session.records[0]?.messages?.size !== 4; i++) await new Promise(r => setTimeout(r, 20));
  Object.assign(session.records[0], { status: 'completed', completedAt: BASE + 56000 });
  const card = session.readTranscript({}).at(-1);
  assert.equal(card.toolCalls[0].status, 'completed');
  assert.deepEqual([card.turnSpeed.generation.outputTokens, card.turnSpeed.generation.activeMs], [1370, 39000]);
});

test('cards show generation first with the whole-turn rate beside it; the tooltip explains both', () => {
  const metric = { outputTokens: 68487, elapsedMs: 4048000, tokensPerSecond: 16.92, speedTier: 'standard',
    generation: { outputTokens: 68487, activeMs: 1003000, tokensPerSecond: 68.28, calls: 124, method: 'per-call' } };
  const shown = speedDisplay(metric);
  assert.equal(shown.text, '标准 · 生成 ≈68 · 整轮 17 tok/s'); assert.equal(shown.bare, '生成 ≈68 · 整轮 17 tok/s');
  assert.match(shown.title, /16 分 43 秒（124 次调用，逐次调用计时）/);
  assert.match(shown.title, /整轮 1 小时 7 分，其中工具、子代理和等待约 50 分 45 秒/);
  const unknown = speedDisplay({ ...metric, generation: null });
  assert.equal(unknown.text, '标准 · 整轮 ≈17 tok/s'); assert.match(unknown.title, /不代表纯生成/);
});
