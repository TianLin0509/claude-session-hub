const assert = require('assert');
const {
  codexAgentMessageEventFromRecord,
  codexTextFromContent,
  codexTextFromPayload,
  codexUserMessageEventFromRecord,
  timestampToMs,
} = require('../core/transcript-payload-utils.js');

assert.strictEqual(codexTextFromContent('hello'), 'hello');
assert.strictEqual(
  codexTextFromContent(['a', { text: 'b' }, { content: 'c' }, null, { nope: 'x' }]),
  'a\nb\nc',
);

assert.deepStrictEqual(
  codexAgentMessageEventFromRecord({
    timestamp: '2026-08-20T03:46:38.476Z',
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      turn_id: 'turn-0147',
      item: {
        type: 'AgentMessage',
        id: 'commentary-1',
        content: [{ type: 'text', text: '中间进度已完成' }],
        phase: 'commentary',
      },
      started_at_ms: 1787197596066,
      completed_at_ms: 1787197598476,
    },
  }),
  {
    text: '中间进度已完成',
    phase: 'commentary',
    completed: false,
    completedAt: Date.parse('2026-08-20T03:46:38.476Z'),
    durationMs: 2410,
    turnId: 'turn-0147',
    signalSource: 'item_completed_agent_message_commentary',
  },
);

assert.deepStrictEqual(
  codexAgentMessageEventFromRecord({
    timestamp: '2026-08-20T03:47:00.000Z',
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      turn_id: 'turn-0147',
      item: {
        type: 'AgentMessage',
        id: 'final-1',
        content: [{ type: 'text', text: '最终回答' }],
        phase: 'final_answer',
      },
      started_at_ms: 1787197619000,
      completed_at_ms: 1787197620000,
    },
  }),
  {
    text: '最终回答',
    phase: 'final_answer',
    completed: true,
    completedAt: Date.parse('2026-08-20T03:47:00.000Z'),
    durationMs: 1000,
    turnId: 'turn-0147',
    signalSource: 'item_completed_agent_message_final_answer',
  },
);
assert.strictEqual(codexTextFromContent({ text: 'object text' }), 'object text');
assert.strictEqual(codexTextFromContent({ content: [{ text: 'nested' }] }), 'nested');
assert.strictEqual(codexTextFromContent({ nope: true }), '');

assert.strictEqual(codexTextFromPayload({ message: 'm', text: 't' }), 'm');
assert.strictEqual(codexTextFromPayload({ text: 't' }), 't');
assert.strictEqual(codexTextFromPayload({ content: [{ text: 'c' }] }), 'c');
assert.strictEqual(codexTextFromPayload(null), '');

assert.strictEqual(timestampToMs(null), null);
assert.strictEqual(timestampToMs('not a date'), null);
assert.strictEqual(timestampToMs('2026-05-22T00:00:00.000Z'), Date.UTC(2026, 4, 22));

assert.deepStrictEqual(
  codexUserMessageEventFromRecord({
    timestamp: '2026-08-16T08:00:00.000Z',
    type: 'event_msg',
    payload: { type: 'user_message', message: ' legacy prompt ' },
  }),
  {
    text: 'legacy prompt',
    submittedAt: Date.UTC(2026, 7, 16, 8),
    turnId: null,
    signalSource: 'user_message',
  },
);

assert.strictEqual(
  codexUserMessageEventFromRecord({
    timestamp: '2026-08-20T04:00:00.000Z',
    type: 'event_msg',
    payload: {
      type: 'thread_goal_updated',
      goal: { objective: '已经完成的旧目标', status: 'completed' },
    },
  }),
  null,
  'goal status bookkeeping must not fabricate a new user submission',
);

assert.deepStrictEqual(
  codexUserMessageEventFromRecord({
    timestamp: '2026-08-20T03:46:28.186Z',
    type: 'event_msg',
    payload: {
      type: 'thread_goal_updated',
      threadId: 'thread-goal-1',
      goal: {
        threadId: 'thread-goal-1',
        objective: '  修复 /goal 首轮自动命名  ',
        status: 'active',
        updatedAt: 1787197588,
      },
    },
  }),
  {
    text: '修复 /goal 首轮自动命名',
    submittedAt: Date.parse('2026-08-20T03:46:28.186Z'),
    turnId: null,
    signalSource: 'thread_goal_updated',
  },
);

assert.deepStrictEqual(
  codexUserMessageEventFromRecord({
    timestamp: '2026-08-16T09:00:00.000Z',
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      turn_id: 'turn-0147',
      item: {
        type: 'UserMessage',
        id: 'user-item-1',
        content: [{ type: 'text', text: ' 0.147 prompt ', text_elements: [] }],
      },
    },
  }),
  {
    text: '0.147 prompt',
    submittedAt: Date.UTC(2026, 7, 16, 9),
    turnId: 'turn-0147',
    signalSource: 'item_completed_user_message',
  },
);

assert.strictEqual(
  codexUserMessageEventFromRecord({
    timestamp: '2026-08-16T09:00:00.000Z',
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'injected context' }] },
  }),
  null,
  'response_item user records also contain injected context and are not authoritative submit events',
);

assert.strictEqual(
  codexUserMessageEventFromRecord({
    timestamp: '2026-08-16T09:00:00.000Z',
    type: 'event_msg',
    payload: { type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'text', text: 'answer' }] } },
  }),
  null,
);

console.log('transcript-payload-utils.test.js OK');
