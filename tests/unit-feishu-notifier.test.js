'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
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

async function testDedupeWithinWindow() {
  const client = makeFakeClient();
  const clock = makeFakeClock();
  const notifier = new FeishuNotifier({
    client, chatId: 'oc_target', dedupeWindowMs: 60_000, now: clock.now,
  });

  await notifier.notify(basePayload());
  clock.advance(30_000);
  const result = await notifier.notify(basePayload());

  assert.deepStrictEqual(result, { sent: false, reason: 'deduped' });
  assert.strictEqual(client.calls.length, 1, 'sendCard called only on first');
  console.log('  ok dedupe within window');
}

async function testReSendAfterWindow() {
  const client = makeFakeClient();
  const clock = makeFakeClock();
  const notifier = new FeishuNotifier({
    client, chatId: 'oc_target', dedupeWindowMs: 60_000, now: clock.now,
  });

  await notifier.notify(basePayload());
  clock.advance(61_000);
  const result = await notifier.notify(basePayload());

  assert.deepStrictEqual(result, { sent: true, reason: 'sent' });
  assert.strictEqual(client.calls.length, 2);
  console.log('  ok re-send after window');
}

async function testNewlyWaitingBypassesDedupe() {
  const client = makeFakeClient();
  const clock = makeFakeClock();
  const notifier = new FeishuNotifier({
    client, chatId: 'oc_target', dedupeWindowMs: 60_000, now: clock.now,
  });

  await notifier.notify(basePayload());
  clock.advance(10_000);
  const result = await notifier.notify(basePayload({ newlyWaiting: true, isWaiting: true }));

  assert.deepStrictEqual(result, { sent: true, reason: 'sent' });
  assert.strictEqual(client.calls.length, 2, 'newlyWaiting bypasses dedupe');
  console.log('  ok newlyWaiting bypasses dedupe');
}

async function testDifferentSessionsIndependent() {
  const client = makeFakeClient();
  const clock = makeFakeClock();
  const notifier = new FeishuNotifier({
    client, chatId: 'oc_target', dedupeWindowMs: 60_000, now: clock.now,
  });

  await notifier.notify(basePayload({ sessionId: 'sess-A' }));
  await notifier.notify(basePayload({ sessionId: 'sess-B' }));

  assert.strictEqual(client.calls.length, 2, 'different sessions both send');
  console.log('  ok different sessions independent');
}

async function testApiFailureNoThrow() {
  const failingClient = {
    sendCard: async () => { throw new Error('Feishu HTTP 500'); },
  };
  const clock = makeFakeClock();
  const notifier = new FeishuNotifier({
    client: failingClient, chatId: 'oc_target', now: clock.now,
    logger: { warn: () => {} },
  });

  const result = await notifier.notify(basePayload());

  assert.deepStrictEqual(result, { sent: false, reason: 'error' });
  assert.ok(notifier.lastError, 'lastError recorded');
  assert.strictEqual(notifier.lastError.message, 'Feishu HTTP 500');
  console.log('  ok api failure does not throw');
}

async function testDryRunMode() {
  const client = makeFakeClient();
  const clock = makeFakeClock();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-notify-dry-'));
  const logPath = path.join(tmpDir, 'feishu-notify.log');
  const notifier = new FeishuNotifier({
    client, chatId: '', dryRunLogPath: logPath, now: clock.now,
  });

  const result = await notifier.notify(basePayload());

  assert.deepStrictEqual(result, { sent: true, reason: 'dryrun' });
  assert.strictEqual(client.calls.length, 0, 'sendCard NOT called in dryrun');
  assert.ok(fs.existsSync(logPath), 'dry-run log exists');
  const logContent = fs.readFileSync(logPath, 'utf8');
  assert.ok(logContent.includes('sess-A'), 'log contains sessionId');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('  ok dry-run mode');
}

async function testCardWaitingState() {
  const card = buildNotifyCard(basePayload({
    isWaiting: true,
    newlyWaiting: true,
    waitingText: '请审批：删除文件 a.txt',
  }));
  assert.strictEqual(card.schema, '2.0');
  assert.strictEqual(card.header.template, 'orange', 'orange for waiting');
  const md = card.body.elements.map(e => e.content || '').join('\n');
  assert.ok(md.includes('lindang-agent'), 'title in markdown');
  assert.ok(md.includes('等你回复'), 'waiting label');
  assert.ok(md.includes('请审批：删除文件 a.txt'), 'waitingText shown');
  console.log('  ok card waiting state');
}

async function testCardCompletedState() {
  const card = buildNotifyCard(basePayload({
    isWaiting: false,
    preview: '已完成数据拉取，准备进入下一轮分析。',
  }));
  assert.strictEqual(card.header.template, 'wathet', 'wathet for completed');
  const md = card.body.elements.map(e => e.content || '').join('\n');
  assert.ok(md.includes('一轮完成'), 'completed label');
  assert.ok(md.includes('已完成数据拉取'), 'preview shown');
  console.log('  ok card completed state');
}

async function testCardPreviewTruncation() {
  const longPreview = 'x'.repeat(500);
  const card = buildNotifyCard(basePayload({ preview: longPreview }));
  const md = card.body.elements.map(e => e.content || '').join('\n');
  // preview 段不应超过 200 字符（不算 "..." 后缀）
  const xCount = (md.match(/x/g) || []).length;
  assert.ok(xCount <= 210, `preview truncated, got ${xCount} chars`);
  console.log('  ok card preview truncation');
}

(async () => {
  console.log('Running FeishuNotifier tests...');
  await testConstructorValidation();
  await testFirstSend();
  await testDedupeWithinWindow();
  await testReSendAfterWindow();
  await testNewlyWaitingBypassesDedupe();
  await testDifferentSessionsIndependent();
  await testApiFailureNoThrow();
  await testDryRunMode();
  await testCardWaitingState();
  await testCardCompletedState();
  await testCardPreviewTruncation();
  console.log('All passed.');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
