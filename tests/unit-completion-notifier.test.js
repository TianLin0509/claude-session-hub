'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  CompletionNotifier,
  isUsableSendKey,
  maskSecret,
  normalizeNotificationConfig,
  readLastDeliveryAudit,
} = require('../core/completion-notifier.js');

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(body); },
  };
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
  assert.strictEqual(isUsableSendKey('SCT_TEST_123456'), true);
  assert.strictEqual(isUsableSendKey('bad/key'), false);
  assert.strictEqual(maskSecret('SCT_TEST_123456'), '***3456');
  assert.deepStrictEqual(normalizeNotificationConfig({
    enabled: 'true',
    // Legacy automatic-filter fields are intentionally ignored.
    mode: 'away_or_idle',
    idle_seconds: 3600,
    min_duration_seconds: 3600,
    include_preview: true,
    notify_group_chats: false,
    serverchan: { send_key: 'SCT_TEST_123456' },
  }, {}), {
    enabled: true,
    provider: 'serverchan',
    serverchanSendKey: 'SCT_TEST_123456',
    includePreview: true,
    previewChars: 160,
    notifyGroupChats: false,
  });
  const envConfig = normalizeNotificationConfig({ enabled: false }, {
    HUB_NOTIFY_ENABLED: '1',
    HUB_NOTIFY_SERVERCHAN_SENDKEY: 'SCT_ENV_123456',
  });
  assert.strictEqual(envConfig.enabled, true);
  assert.strictEqual(envConfig.serverchanSendKey, 'SCT_ENV_123456');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-completion-notifier-'));
  const auditPath = path.join(tempDir, 'notification-delivery.jsonl');
  try {
    const calls = [];
    const config = {
      notifications: {
        enabled: true,
        serverchanSendKey: 'SCT_PRIVATE_123456',
        includePreview: false,
        notifyGroupChats: true,
      },
    };
    const notifier = new CompletionNotifier({
      getConfig: () => config,
      getAttentionState: () => ({ focused: true, idleSeconds: 0 }),
      getLogPath: () => auditPath,
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return response(200, { code: 0, data: { pushid: 'mock' } });
      },
      endpointBuilder: sendKey => `https://mock.invalid/${encodeURIComponent(sendKey)}.send`,
      retryDelaysMs: [],
      now: () => 10_000,
    });

    notifier.notePromptSubmitted({ hubSessionId: 'session-1', submittedAt: 4_000 });
    const sent = await notifier.handleTurnComplete({
      hubSessionId: 'session-1',
      completedAt: 10_000,
      text: 'TOP SECRET ANSWER',
    }, {
      title: '研究任务',
      kind: 'codex',
    });
    assert.strictEqual(sent.ok, true);
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].url.includes(encodeURIComponent('SCT_PRIVATE_123456')));
    const form = new URLSearchParams(calls[0].options.body);
    assert.ok(form.get('title').includes('研究任务'));
    assert.ok(form.get('desp').includes('6 秒'));
    assert.ok(!form.get('desp').includes('TOP SECRET ANSWER'), 'reply preview is private by default');

    const duplicate = await notifier.handleTurnComplete({
      hubSessionId: 'session-1',
      completedAt: 10_010,
      text: 'TOP SECRET ANSWER',
    }, {
      title: '研究任务',
      kind: 'codex',
    });
    assert.strictEqual(duplicate.status, 'duplicate');
    assert.strictEqual(calls.length, 1);

    const memberResult = await notifier.handleTurnComplete({
      hubSessionId: 'member-1',
      text: 'member answer',
    }, {
      title: '群聊成员',
      kind: 'gemini',
      meetingId: 'meeting-1',
    });
    assert.strictEqual(memberResult.status, 'meeting_member');

    const groupResult = await notifier.handleGroupChatComplete({
      meetingId: 'meeting-1',
      turnNum: 7,
      durationMs: 42_000,
      results: [
        { label: 'Codex', status: 'completed', text: 'answer one' },
        { label: 'Gemini', status: 'errored', text: '' },
        { label: 'Kimi', status: 'absent', text: '' },
      ],
    }, { title: '产品圆桌' });
    assert.strictEqual(groupResult.ok, true);
    assert.strictEqual(calls.length, 2, 'group chat should produce one aggregate delivery');
    const groupForm = new URLSearchParams(calls[1].options.body);
    assert.ok(groupForm.get('desp').includes('完成 1 · 失败 1 · 缺席 1'));

    const audit = fs.readFileSync(auditPath, 'utf8');
    assert.ok(audit.includes('"status":"sent"'));
    assert.ok(!audit.includes('SCT_PRIVATE_123456'), 'audit log must not contain SendKey');
    assert.ok(!audit.includes('TOP SECRET ANSWER'), 'audit log must not contain reply content');
    assert.strictEqual(notifier.getHealth().lastDelivery.status, 'sent');
    assert.strictEqual(readLastDeliveryAudit(auditPath).status, 'sent');
    const restartedNotifier = new CompletionNotifier({ getLogPath: () => auditPath });
    assert.strictEqual(restartedNotifier.getHealth().lastDelivery.status, 'sent', 'notification health should survive Hub restart');
    restartedNotifier.dispose();
    notifier.dispose();

    let switchCalls = 0;
    const switchConfig = { notifications: {
      enabled: false,
      serverchanSendKey: 'SCT_SWITCH_123456',
      // These legacy values must not silently filter an explicitly enabled switch.
      mode: 'away_or_idle',
      idleSeconds: 3600,
      minDurationSeconds: 3600,
    } };
    const switchNotifier = new CompletionNotifier({
      getConfig: () => switchConfig,
      fetchImpl: async () => { switchCalls += 1; return response(200, { code: 0 }); },
      retryDelaysMs: [],
    });
    const switchedOff = await switchNotifier.handleTurnComplete({ hubSessionId: 'switch-off', text: 'done' }, {
      title: '总开关关闭', kind: 'claude',
    });
    assert.strictEqual(switchedOff.status, 'disabled');
    assert.strictEqual(switchCalls, 0);
    switchConfig.notifications.enabled = true;
    const switchedOn = await switchNotifier.handleTurnComplete({
      hubSessionId: 'switch-on',
      text: 'done',
      durationMs: 1,
    }, {
      title: '总开关开启', kind: 'claude',
    });
    assert.strictEqual(switchedOn.ok, true);
    assert.strictEqual(switchCalls, 1, 'explicit ON must send even while the old auto-filter fields are present');
    switchNotifier.dispose();

    let retryCalls = 0;
    const retryNotifier = new CompletionNotifier({
      getConfig: () => ({ notifications: {
        enabled: true,
        serverchanSendKey: 'SCT_RETRY_123456',
      } }),
      fetchImpl: async () => {
        retryCalls += 1;
        return retryCalls === 1
          ? response(503, { code: 503 })
          : response(200, { code: 0 });
      },
      retryDelaysMs: [5],
    });
    const retryScheduled = await retryNotifier.handleTurnComplete({ hubSessionId: 'retry', text: 'done' }, {
      title: '重试任务', kind: 'codex',
    });
    assert.strictEqual(retryScheduled.retryScheduled, true);
    await wait(30);
    assert.strictEqual(retryCalls, 2, 'transient HTTP failures should retry once');
    retryNotifier.dispose();

    let testCalls = 0;
    const testNotifier = new CompletionNotifier({
      getConfig: () => ({ notifications: { enabled: false } }),
      fetchImpl: async () => { testCalls += 1; return response(200, { code: 0 }); },
      retryDelaysMs: [],
    });
    const testResult = await testNotifier.sendTest({ sendKey: 'SCT_TEST_654321' });
    assert.strictEqual(testResult.ok, true, 'test delivery should work before enabling/saving');
    assert.strictEqual(testCalls, 1);
    testNotifier.dispose();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log('unit-completion-notifier.test.js OK');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
