'use strict';

const assert = require('assert');
const { FeishuNotifier, buildNotifyCard } = require('../core/feishu-notifier.js');

function makeFakeClient() {
  const calls = [];
  return {
    calls,
    sendCard: async (args) => {
      calls.push(args);
      return { code: 0, data: { message_id: 'fake-mid-' + calls.length } };
    },
  };
}

function makeFakeClock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
  };
}

function basePayload(overrides = {}) {
  return Object.assign({
    sessionId: 'sess-A',
    title: 'lindang-agent',
    kind: 'codex',
    isWaiting: false,
    newlyWaiting: false,
    waitingText: null,
    preview: '已完成数据拉取，准备进入下一轮分析。',
    timestamp: 1_700_000_000_000,
  }, overrides);
}

async function testConstructorValidation() {
  assert.throws(
    () => new FeishuNotifier({ chatId: 'oc_x' }),
    /client is required/i,
    'missing client must throw',
  );
  assert.throws(
    () => new FeishuNotifier({ client: makeFakeClient() }),
    /chatId is required/i,
    'missing chatId must throw',
  );
  console.log('  ok constructor validation');
}

async function testFirstSend() {
  const client = makeFakeClient();
  const clock = makeFakeClock();
  const notifier = new FeishuNotifier({
    client,
    chatId: 'oc_target',
    now: clock.now,
  });

  const result = await notifier.notify(basePayload());

  assert.deepStrictEqual(result, { sent: true, reason: 'sent' });
  assert.strictEqual(client.calls.length, 1, 'sendCard called exactly once');
  assert.strictEqual(client.calls[0].chatId, 'oc_target');
  assert.ok(client.calls[0].card, 'card payload provided');
  console.log('  ok first send');
}

(async () => {
  console.log('Running FeishuNotifier tests...');
  await testConstructorValidation();
  await testFirstSend();
  console.log('All passed.');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
