'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CompletionNotifier,
  NotificationDeliveryError,
  buildFeishuCliArgs,
  isUsableFeishuTarget,
  normalizeNotificationConfig,
  parseCliJson,
  readDeliveredEventIds,
  readLastDeliveryAudit,
} = require('../core/completion-notifier.js');

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function success(messageId = 'om_mock') {
  return { ok: true, exitCode: 0, providerCode: messageId, messageId };
}

async function run() {
  const BASE_TIME = 1_700_000_000_000;
  assert.equal(isUsableFeishuTarget('oc_1234567890'), true);
  assert.equal(isUsableFeishuTarget('ou_1234567890'), true);
  assert.equal(isUsableFeishuTarget('chat-dev'), false);
  const normalized = normalizeNotificationConfig({
    enabled: 'true',
    mode: 'away_or_idle',
    idle_seconds: 3600,
    min_duration_seconds: 3600,
    include_preview: true,
    notify_group_chats: false,
    feishu: { target: 'oc_1234567890', cli_path: 'D:\\tools\\lark-cli.exe' },
  }, {});
  assert.equal(normalized.enabled, true);
  assert.equal(normalized.provider, 'feishu-cli');
  assert.equal(normalized.feishuTarget, 'oc_1234567890');
  assert.equal(normalized.feishuCliPath, 'D:\\tools\\lark-cli.exe');
  assert.equal(normalized.includePreview, true);
  assert.equal(normalized.notifyGroupChats, false);
  const envConfig = normalizeNotificationConfig({}, {
    HUB_NOTIFY_FEISHU_TARGET: 'ou_abcdefghij',
    HUB_NOTIFY_FEISHU_CLI_PATH: 'E:\\Lark\\lark-cli.exe',
  });
  assert.equal(envConfig.feishuTarget, 'ou_abcdefghij');
  assert.equal(envConfig.feishuCliPath, 'E:\\Lark\\lark-cli.exe');

  const chatArgs = buildFeishuCliArgs({
    eventId: 'session:event-1',
    target: 'oc_1234567890',
    title: '完成',
    desp: '正文',
  });
  assert.deepEqual(chatArgs.slice(0, 4), ['im', '+messages-send', '--chat-id', 'oc_1234567890']);
  assert.ok(chatArgs.includes('--idempotency-key'));
  assert.ok(chatArgs.includes('--as'));
  assert.ok(chatArgs.includes('bot'));
  const userArgs = buildFeishuCliArgs({
    eventId: 'session:event-2',
    target: 'ou_1234567890',
    title: '完成',
    desp: '正文',
  });
  assert.ok(userArgs.includes('--user-id'));
  assert.equal(parseCliJson('notice\n{"ok":true,"data":{"message_id":"om_1"}}\n').ok, true);
  assert.equal(parseCliJson(JSON.stringify({
    ok: false,
    error: { type: 'config', subtype: 'not_configured' },
  }, null, 2)).error.subtype, 'not_configured',
  'real lark-cli pretty-printed JSON must parse as one envelope');
  assert.equal(parseCliJson(`[notice] update available\n${JSON.stringify({
    ok: true,
    data: { message_id: 'om_prefixed' },
  }, null, 2)}\n`).data.message_id, 'om_prefixed',
  'a CLI notice before a pretty JSON envelope must not hide the result');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-completion-notifier-feishu-'));
  const auditPath = path.join(tempDir, 'notification-delivery.jsonl');
  try {
    let now = BASE_TIME + 10_000;
    const calls = [];
    const config = {
      notifications: {
        feishuTarget: 'oc_1234567890',
        feishuCliPath: 'lark-cli-test',
        includePreview: false,
        notifyGroupChats: true,
      },
    };
    const notifier = new CompletionNotifier({
      getConfig: () => config,
      getLogPath: () => auditPath,
      deliveryImpl: async (payload, options) => {
        calls.push({ payload, options });
        return success(`om_${calls.length}`);
      },
      retryDelaysMs: [],
      now: () => now,
    });

    notifier.notePromptSubmitted({
      hubSessionId: 'disabled-session',
      submittedAt: BASE_TIME + 3_000,
      turnId: 'disabled-turn',
    });
    const disabled = await notifier.handleTurnComplete({
      hubSessionId: 'disabled-session',
      completedAt: BASE_TIME + 3_500,
      turnId: 'disabled-turn',
      text: 'completed while notification was off',
    }, {
      title: '默认关闭',
      kind: 'codex',
      completionNotificationEnabled: false,
    });
    assert.equal(disabled.status, 'session_disabled');
    const enabledAfterCompletion = await notifier.handleTurnComplete({
      hubSessionId: 'disabled-session',
      completedAt: BASE_TIME + 3_600,
      turnId: 'disabled-turn',
      text: 'later transcript patch after the user toggled notification on',
    }, {
      title: '默认关闭',
      kind: 'codex',
      completionNotificationEnabled: true,
    });
    assert.equal(enabledAfterCompletion.status, 'duplicate',
      'enabling notifications after a turn completed must not retroactively notify that turn');
    assert.equal(calls.length, 0);

    notifier.notePromptSubmitted({
      hubSessionId: 'session-1',
      submittedAt: BASE_TIME + 4_000,
      turnId: 'turn-1',
    });
    const sent = await notifier.handleTurnComplete({
      hubSessionId: 'session-1',
      completedAt: BASE_TIME + 10_000,
      turnId: 'turn-1',
      text: 'TOP SECRET ANSWER',
    }, {
      title: '研究任务',
      kind: 'codex',
      completionNotificationEnabled: true,
    });
    assert.equal(sent.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].payload.target, 'oc_1234567890');
    assert.match(calls[0].payload.desp, /6 秒/);
    assert.doesNotMatch(calls[0].payload.desp, /TOP SECRET ANSWER/,
      'reply preview is private by default');

    const patchedSameTurn = await notifier.handleTurnComplete({
      hubSessionId: 'session-1',
      completedAt: BASE_TIME + 10_010,
      turnId: 'turn-1',
      text: 'TOP SECRET ANSWER plus transcript patch',
    }, {
      title: '研究任务',
      kind: 'codex',
      completionNotificationEnabled: true,
    });
    assert.equal(patchedSameTurn.status, 'duplicate',
      'one turn must remain exactly-once even when its transcript text is patched');
    assert.equal(calls.length, 1);

    now = BASE_TIME + 12_000;
    notifier.notePromptSubmitted({
      hubSessionId: 'session-1',
      submittedAt: BASE_TIME + 11_000,
      turnId: 'turn-2',
    });
    const delayedOldTurn = await notifier.handleTurnComplete({
      hubSessionId: 'session-1',
      completedAt: BASE_TIME + 12_000,
      turnId: 'turn-1',
      text: 'late old answer',
    }, {
      title: '研究任务',
      kind: 'codex',
      completionNotificationEnabled: true,
    });
    assert.equal(delayedOldTurn.status, 'stale_completion_turn');
    assert.equal(calls.length, 1, 'a delayed old turn must never notify over the current turn');

    notifier.noteTurnAborted({
      hubSessionId: 'session-1',
      abortedAt: BASE_TIME + 12_100,
      turnId: 'turn-2',
    });
    const abortedCompletion = await notifier.handleTurnComplete({
      hubSessionId: 'session-1',
      completedAt: BASE_TIME + 12_200,
      turnId: 'turn-2',
      text: 'must not notify',
    }, {
      title: '研究任务',
      kind: 'codex',
      completionNotificationEnabled: true,
    });
    assert.equal(abortedCompletion.status, 'aborted_turn');
    assert.equal(calls.length, 1);

    notifier.notePromptSubmitted({
      hubSessionId: 'failed-session',
      submittedAt: BASE_TIME + 12_300,
      turnId: 'failed-turn',
    });
    notifier.noteTurnFailed({
      hubSessionId: 'failed-session',
      completedAt: BASE_TIME + 12_400,
      turnId: 'failed-turn',
    });
    const failedCompletion = await notifier.handleTurnComplete({
      hubSessionId: 'failed-session',
      completedAt: BASE_TIME + 12_500,
      turnId: 'failed-turn',
      text: 'must not notify after task_complete.error',
    }, {
      title: '失败任务',
      kind: 'codex',
      completionNotificationEnabled: true,
    });
    assert.equal(failedCompletion.status, 'failed_turn');
    assert.equal(calls.length, 1);
    notifier.noteTurnFailed({
      hubSessionId: 'failed-without-prompt-state',
      completedAt: BASE_TIME + 12_600,
      turnId: 'failed-without-prompt-turn',
    });
    const failedWithoutPromptState = await notifier.handleTurnComplete({
      hubSessionId: 'failed-without-prompt-state',
      completedAt: BASE_TIME + 12_700,
      turnId: 'failed-without-prompt-turn',
      text: 'late completion after a restart-visible failure',
    }, {
      title: '失败任务',
      kind: 'codex',
      completionNotificationEnabled: true,
    });
    assert.equal(failedWithoutPromptState.status, 'failed_turn');
    assert.equal(calls.length, 1);

    now = BASE_TIME + 15_000;
    notifier.notePromptSubmitted({
      hubSessionId: 'session-1',
      submittedAt: BASE_TIME + 13_000,
      turnId: 'turn-3',
    });
    const nextTurn = await notifier.handleTurnComplete({
      hubSessionId: 'session-1',
      completedAt: BASE_TIME + 15_000,
      turnId: 'turn-3',
      text: 'TOP SECRET ANSWER',
    }, {
      title: '研究任务',
      kind: 'codex',
      completionNotificationEnabled: true,
    });
    assert.equal(nextTurn.ok, true);
    assert.equal(calls.length, 2, 'the same answer text in a later turn must still notify');
    const oldTurnAfterCurrentCompleted = await notifier.handleTurnComplete({
      hubSessionId: 'session-1',
      completedAt: BASE_TIME + 15_500,
      turnId: 'turn-1',
      text: 'old turn observed late after the current turn completed',
    }, {
      title: '研究任务',
      kind: 'codex',
      completionNotificationEnabled: true,
    });
    assert.equal(oldTurnAfterCurrentCompleted.status, 'stale_completion_turn');
    assert.equal(calls.length, 2,
      'a completion event alone must never invent a new turn after the tracked turn completed');

    notifier.notePromptSubmitted({ hubSessionId: 'claude-1', submittedAt: BASE_TIME + 16_000 });
    now = BASE_TIME + 17_000;
    const claudeFirst = await notifier.handleTurnComplete({
      hubSessionId: 'claude-1',
      completedAt: BASE_TIME + 17_000,
      text: 'first terminal text',
    }, {
      title: 'Claude',
      kind: 'claude',
      completionNotificationEnabled: true,
    });
    assert.equal(claudeFirst.ok, true);
    const claudePatch = await notifier.handleTurnComplete({
      hubSessionId: 'claude-1',
      completedAt: BASE_TIME + 17_010,
      text: 'first terminal text plus patch',
    }, {
      title: 'Claude',
      kind: 'claude',
      completionNotificationEnabled: true,
    });
    assert.equal(claudePatch.status, 'duplicate',
      'providers without native turnId use the prompt generation as their exact-once key');

    const memberResult = await notifier.handleTurnComplete({
      hubSessionId: 'member-1',
      text: 'member answer',
    }, {
      title: '群聊成员',
      kind: 'gemini',
      meetingId: 'meeting-1',
      completionNotificationEnabled: true,
    });
    assert.equal(memberResult.status, 'meeting_member');

    const unsettled = await notifier.handleGroupChatComplete({
      meetingId: 'meeting-1',
      turnNum: 6,
      results: [{ label: 'Codex', status: 'running', text: 'still working' }],
    }, {
      title: '产品圆桌',
      completionNotificationEnabled: true,
    });
    assert.equal(unsettled.status, 'unsettled_results');

    const groupEvent = {
      meetingId: 'meeting-1',
      turnNum: 7,
      durationMs: 42_000,
      results: [
        { label: 'Codex', status: 'manual_extracted', text: 'answer one' },
        { label: 'Gemini', status: 'errored', text: '' },
        { label: 'Kimi', status: 'absent', text: '' },
      ],
    };
    const groupDisabled = await notifier.handleGroupChatComplete(groupEvent, { title: '产品圆桌' });
    assert.equal(groupDisabled.status, 'meeting_disabled');
    const retroactiveGroup = await notifier.handleGroupChatComplete(groupEvent, {
      title: '产品圆桌',
      completionNotificationEnabled: true,
    });
    assert.equal(retroactiveGroup.status, 'duplicate',
      'enabling a room after the round completed must not retroactively notify that round');
    const groupResult = await notifier.handleGroupChatComplete({ ...groupEvent, turnNum: 8 }, {
      title: '产品圆桌',
      completionNotificationEnabled: true,
    });
    assert.equal(groupResult.ok, true);
    assert.match(calls.at(-1).payload.desp, /完成 1 · 失败 1 · 缺席 1/);

    const audit = fs.readFileSync(auditPath, 'utf8');
    assert.match(audit, /"provider":"feishu-cli"/);
    assert.doesNotMatch(audit, /TOP SECRET ANSWER/,
      'audit log must not contain reply content');
    assert.equal(notifier.getHealth().provider, 'feishu-cli');
    assert.equal(readLastDeliveryAudit(auditPath).status, 'sent');
    assert.ok(readDeliveredEventIds(auditPath).size >= 3);
    notifier.dispose();

    const auditWarnings = [];
    const degradedAuditNotifier = new CompletionNotifier({
      getLogPath: () => tempDir,
      getConfig: () => ({ notifications: { feishuCliPath: 'fake-lark-cli' } }),
      deliveryImpl: async () => success('om_audit_degraded'),
      logger: { warn: (...args) => auditWarnings.push(args) },
      retryDelaysMs: [],
    });
    assert.equal(degradedAuditNotifier.getHealth().auditReadError, 'EISDIR');
    assert.equal(auditWarnings.length, 1,
      'an unreadable audit must be surfaced once instead of silently losing restart dedupe');
    const degradedAuditSend = await degradedAuditNotifier.sendTest({ target: 'oc_1234567890' });
    assert.equal(degradedAuditSend.ok, true,
      'a local audit failure must not turn an already-sent Feishu message into a delivery failure');
    assert.equal(degradedAuditNotifier.getHealth().auditWriteError, 'EISDIR');
    assert.equal(auditWarnings.length, 2,
      'an audit write failure must be surfaced instead of silently losing persistent dedupe');
    degradedAuditNotifier.dispose();

    let restartCalls = 0;
    const restartedNotifier = new CompletionNotifier({
      getConfig: () => config,
      getLogPath: () => auditPath,
      deliveryImpl: async () => {
        restartCalls += 1;
        return success('om_restart');
      },
      retryDelaysMs: [],
      now: () => BASE_TIME + 18_000,
    });
    const restartDuplicate = await restartedNotifier.handleTurnComplete({
      hubSessionId: 'session-1',
      completedAt: BASE_TIME + 15_000,
      turnId: 'turn-3',
      text: 'TOP SECRET ANSWER',
    }, {
      title: '研究任务',
      kind: 'codex',
      completionNotificationEnabled: true,
    });
    assert.equal(restartDuplicate.status, 'duplicate');
    assert.equal(restartCalls, 0, 'successful audit entries must prevent replay after Hub restart');
    restartedNotifier.dispose();

    let retryCalls = 0;
    const retryNotifier = new CompletionNotifier({
      getConfig: () => config,
      deliveryImpl: async () => {
        retryCalls += 1;
        if (retryCalls === 1) {
          throw new NotificationDeliveryError('network_error', { transient: true, exitCode: 4 });
        }
        return success('om_retry');
      },
      retryDelaysMs: [5],
    });
    retryNotifier.notePromptSubmitted({ hubSessionId: 'retry', submittedAt: Date.now() - 1 });
    const retryScheduled = await retryNotifier.handleTurnComplete({
      hubSessionId: 'retry',
      text: 'done',
    }, {
      title: '重试任务',
      kind: 'codex',
      completionNotificationEnabled: true,
    });
    assert.equal(retryScheduled.retryScheduled, true);
    await wait(30);
    assert.equal(retryCalls, 2, 'transient CLI/network failures should retry once');
    retryNotifier.dispose();

    let testCalls = 0;
    const testNotifier = new CompletionNotifier({
      getConfig: () => ({ notifications: { feishuCliPath: 'lark-cli-test' } }),
      deliveryImpl: async payload => {
        testCalls += 1;
        assert.equal(payload.target, 'ou_1234567890');
        return success('om_test');
      },
      retryDelaysMs: [],
    });
    const testResult = await testNotifier.sendTest({ target: 'ou_1234567890' });
    assert.equal(testResult.ok, true, 'test delivery should work before enabling/saving');
    assert.equal(testCalls, 1);
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
