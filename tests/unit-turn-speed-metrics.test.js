'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { measureTurnSpeed, codexTurnUsage } = require('../core/turn-speed-metrics');
const { parseCodexRolloutText, parseCodexRolloutToTurns } = require('../core/codex-transcript-parser');
const { claudeDiskRecords } = require('../core/claude-disk-transcript');
const { claudeTranscriptTurns } = require('../core/claude-native-transcript');
const { displayChatTurns } = require('../renderer/simple-chat-display');
const { speedDisplay } = require('../renderer/turn-speed-display');
const { codexLineFilter } = require('../core/codex-rollout-reader');
const at = s => new Date(1791200000000 + s * 1000).toISOString();
const row = (type, payload, s) => ({ type, payload, timestamp: at(s) });
const event = (type, values, s) => row('event_msg', { type, ...values }, s);
const usage = (output, input = 100, reasoning = 0) => ({ input_tokens: input, output_tokens: output, reasoning_output_tokens: reasoning });
const tokens = (total, last, s) => event('token_count', { info: { total_token_usage: total, last_token_usage: last } }, s);
const text = rows => rows.map(JSON.stringify).join('\n') + '\n';

test('turn average includes elapsed waiting, reasoning is not added twice, partial and invalid data are hidden', () => {
  const turn = { role: 'assistant', nativeOutcome: 'completed', ts: 1000, tsEnd: 11000,
    usage: usage(200, 100, 100), speedTier: 'fast' };
  const metric = measureTurnSpeed(turn);
  assert.equal(metric.tokensPerSecond, 20); assert.equal(metric.includesReasoning, true);
  assert.equal(metric.speedTier, 'fast'); assert.match(speedDisplay(metric).title, /不代表纯生成/);
  assert.equal(measureTurnSpeed({ ...turn, speedTier: 'standard' }).tokensPerSecond, metric.tokensPerSecond,
    'a Fast setting must never manufacture a speed multiplier');
  for (const extra of [{ nativeOutcome: null }, { nativeOutcome: 'interrupted' }, { outputUsageComplete: false },
    { tsEnd: 1000 }, { ts: null }, { usage: usage(NaN) }, { usage: usage(-1) }, { usage: usage(0) }])
    assert.equal(measureTurnSpeed({ ...turn, ...extra }), null);
});

test('usage records are retained only for cards/live observers, leaving search filtering unchanged', () => {
  for (const row of [tokens(usage(200), usage(200), 0), { type: 'token_usage_record', payload: { turn_token_usage: usage(200) } },
    { type: 'turn_context', payload: { service_tier: 'fast' } }]) {
    assert.equal(codexLineFilter(JSON.stringify(row), { final: true }, 'turns'), true);
    assert.equal(codexLineFilter(JSON.stringify(row), { final: true }, 'search'), false);
  }
});

test('Codex pairs whole-turn counter deltas, duplicate snapshots and tool time with the same boundaries', () => {
  const rows = [tokens(usage(500), usage(500), -1), event('user_message', { message: 'hello' }, 0),
    event('task_started', { turn_id: 'turn' }, 0), row('turn_context', { model: 'gpt-test', service_tier: 'fast' }, 0),
    tokens(usage(600, 200, 50), usage(100, 100, 50), 1), tokens(usage(600, 200, 50), usage(100, 100, 50), 2),
    tokens(usage(800, 300, 150), usage(200, 100, 100), 9), event('task_complete', { last_agent_message: 'answer' }, 10)];
  const answer = parseCodexRolloutText(text(rows)).at(-1);
  assert.equal(answer.usage.output_tokens, 300); assert.equal(answer.turnSpeed.tokensPerSecond, 30);
  assert.equal(answer.turnSpeed.speedTier, 'fast');
  assert.equal(displayChatTurns([answer])[0].turnSpeed.tokensPerSecond, 30);
});

test('Codex first turn with several calls can establish a verified zero baseline; truncated/reset counters cannot', () => {
  const start = [event('task_started', {}, 0)];
  const end = event('task_complete', { last_agent_message: 'answer' }, 10);
  const first = parseCodexRolloutText(text([...start, tokens(usage(100), usage(100), 1),
    tokens(usage(300, 200), usage(200), 9), end])).at(-1);
  assert.equal(first.turnSpeed.tokensPerSecond, 30);
  assert.equal(parseCodexRolloutText(text([...start, tokens(usage(300), usage(100), 9), end])).at(-1).turnSpeed, undefined);
  assert.equal(parseCodexRolloutText(text([...start, tokens(usage(100), usage(100), 1),
    tokens(usage(50), usage(50), 5), tokens(usage(200), usage(150), 9), end])).at(-1).turnSpeed, undefined);
  assert.equal(codexTurnUsage(usage(100), { total_token_usage: usage(99) }), null);
});

test('Codex scanner and append cache retain usage and context records, cold and warm readings agree', t => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-speed-')), 'rollout.jsonl');
  t.after(() => fs.unlinkSync(file));
  fs.writeFileSync(file, text([event('task_started', {}, 0), row('turn_context', { service_tier: 'default' }, 0),
    tokens(usage(100), usage(100), 2)]));
  assert.equal(parseCodexRolloutToTurns(file).length, 0);
  fs.appendFileSync(file, text([tokens(usage(300, 200), usage(200), 9), event('task_complete', { last_agent_message: 'answer' }, 10)]));
  const answer = parseCodexRolloutToTurns(file).at(-1);
  assert.equal(answer.turnSpeed.tokensPerSecond, 30); assert.equal(answer.turnSpeed.speedTier, 'standard');
});

test('recent Codex task-before-user order and explicit per-turn usage do not lose the start or borrow another turn', () => {
  const rows = [event('task_started', { turn_id: 'turn-1' }, 0),
    row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }, 0),
    row('turn_context', { turn_id: 'turn-1', model: 'gpt-test' }, 1),
    row('token_usage_record', { turn_id: 'turn-1', turn_token_usage: usage(300) }, 9),
    row('token_usage_record', { turn_id: 'other', turn_token_usage: usage(9999) }, 9),
    event('task_complete', { last_agent_message: 'answer' }, 10)];
  const answer = parseCodexRolloutText(text(rows)).at(-1);
  assert.equal(answer.turnSpeed.tokensPerSecond, 30); assert.equal(answer.turnSpeed.speedTier, null);
  assert.equal(answer.turnSpeed.elapsedMs, 10000);
});

test('Claude deduplicates shared message IDs and preserves metrics in compact cards and continuations', () => {
  const user = (id, s, notification = false) => ({ type: 'user', uuid: id, timestamp: at(s),
    ...(notification ? { origin: { kind: 'task-notification' } } : {}), message: { content: notification ? '<task-notification>done</task-notification>' : 'hello' } });
  const assistant = (id, output, s) => ({ type: 'assistant', uuid: `${id}-${s}`, timestamp: at(s),
    message: { id, content: [{ type: 'text', text: 'answer' }], stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: output, speed: 'fast' } } });
  const cards = claudeTranscriptTurns(claudeDiskRecords([user('u', 0), assistant('m', 200, 5), assistant('m', 100, 6)]));
  assert.equal(cards[1].usage.output_tokens, 200); assert.equal(cards[1].turnSpeed.speedTier, 'fast');
  assert.equal(displayChatTurns(cards)[1].turnSpeed.outputTokens, 200);
  const continued = claudeTranscriptTurns(claudeDiskRecords([user('u', 0), assistant('m1', 200, 5),
    user('u2', 6, true), assistant('m2', 100, 10)]));
  assert.equal(continued[1].turnSpeed.outputTokens, 300); assert.equal(continued[1].turnSpeed.tokensPerSecond, 30);
});

test('Kimi whole-turn time and step counters are paired; missing usage is not guessed; Gemini remains unknown', () => {
  const { parseKimiWireText } = require('../core/kimi-transcript-parser');
  const loop = (event, s) => ({ type: 'context.append_loop_event', event, time: 1791200000000 + s * 1000 });
  const rows = [{ type: 'turn.prompt', input: [{ type: 'text', text: 'hello' }], time: 1791200000000 },
    loop({ type: 'step.begin', uuid: 's' }, 1), loop({ type: 'content.part', stepUuid: 's', part: { type: 'text', text: 'answer' } }, 2),
    loop({ type: 'step.end', uuid: 's', finishReason: 'stop', usage: { output: 200, inputOther: 100 } }, 10)];
  const answer = parseKimiWireText(text(rows)).at(-1);
  assert.equal(answer.turnSpeed.tokensPerSecond, 20);
  assert.equal(parseKimiWireText(text([...rows, rows.at(-1)])).at(-1).turnSpeed.outputTokens, 200);
  delete rows.at(-1).event.usage;
  assert.equal(parseKimiWireText(text(rows)).at(-1).turnSpeed, undefined);
  assert.equal(measureTurnSpeed({ role: 'assistant', nativeOutcome: 'completed', ts: 1000, usage: { output: 200 } }), null);
});
