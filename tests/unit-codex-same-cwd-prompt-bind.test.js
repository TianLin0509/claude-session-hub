'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { CodexTap, TranscriptTap } = require('../core/transcript-tap');
const { FakeCodexRollout } = require('./helpers/fake-codex-rollout');

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function waitFor(cond, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await sleep(50);
  }
  return false;
}

async function writeUserMessage(fr, message) {
  await fr.writeRaw({
    timestamp: new Date().toISOString(),
    type: 'event_msg',
    payload: { type: 'user_message', message },
  });
}

async function writeCodex0147UserMessage(fr, message, turnId = 'turn-0147') {
  const at = new Date();
  await fr.writeRaw({
    timestamp: at.toISOString(),
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      thread_id: 'thread-0147',
      turn_id: turnId,
      item: {
        type: 'UserMessage',
        id: `user-${turnId}`,
        content: [{ type: 'text', text: message, text_elements: [] }],
      },
      started_at_ms: at.getTime() - 5,
      completed_at_ms: at.getTime(),
    },
  });
}

async function testSameCwdWaitsForPromptMatch() {
  const tmpRoot = path.join(os.tmpdir(), `codex-same-cwd-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  const cwd = 'C:\\test\\shared-cwd';
  const tap = new CodexTap({ sessionsRoot: tmpRoot, pollIntervalMs: 50 });
  const startAt = new Date();
  const frA = new FakeCodexRollout({ sessionsRoot: tmpRoot, cwd, sid: '019eaaaa-0000-7000-8000-000000000001', startAt });
  const frB = new FakeCodexRollout({ sessionsRoot: tmpRoot, cwd, sid: '019ebbbb-0000-7000-8000-000000000002', startAt });

  try {
    tap.registerSession('hub-A', { cwd });
    tap.registerSession('hub-B', { cwd });
    await frA.start();
    await frB.start();

    await sleep(250);
    assert.strictEqual(tap.getRolloutPath('hub-A'), null, 'shared cwd must not bind before prompt evidence');
    assert.strictEqual(tap.getRolloutPath('hub-B'), null, 'shared cwd must not bind before prompt evidence');

    tap.notePrompt('hub-A', 'prompt for A');
    await writeUserMessage(frA, 'prompt for A');
    assert.ok(await waitFor(() => tap.getRolloutPath('hub-A') === frA.rolloutPath), 'hub-A should bind to rollout whose user_message matches its prompt');
    assert.notStrictEqual(tap.getRolloutPath('hub-B'), frA.rolloutPath, 'hub-B must not steal hub-A rollout');
  } finally {
    tap.unregisterSession('hub-A');
    tap.unregisterSession('hub-B');
    await frA.close();
    await frB.close();
    await fs.promises.rm(tmpRoot, { recursive: true, force: true });
  }
}

async function testSameCwdBindsWhenCodexPointerPromptIsConcatenated() {
  const tmpRoot = path.join(os.tmpdir(), `codex-same-cwd-concat-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  const cwd = 'C:\\test\\shared-cwd-concat';
  const tap = new CodexTap({ sessionsRoot: tmpRoot, pollIntervalMs: 50 });
  const startAt = new Date();
  const frA = new FakeCodexRollout({ sessionsRoot: tmpRoot, cwd, sid: '019ecccc-0000-7000-8000-000000000003', startAt });
  const frB = new FakeCodexRollout({ sessionsRoot: tmpRoot, cwd, sid: '019edddd-0000-7000-8000-000000000004', startAt });
  const oldPointer = [
    'A UTF-8 group-chat prompt has been saved to this file:',
    'C:\\temp\\.hub-codex-prompts\\old.md',
    '',
    'Read that file, follow its instructions exactly, and answer in the language/schema requested inside it.',
  ].join('\n');
  const latestPointer = [
    'A UTF-8 group-chat prompt has been saved to this file:',
    'C:\\temp\\.hub-codex-prompts\\latest.md',
    '',
    'Read that file, follow its instructions exactly, and answer in the language/schema requested inside it.',
  ].join('\n');

  try {
    tap.registerSession('hub-A', { cwd });
    tap.registerSession('hub-B', { cwd });
    await frA.start();
    await frB.start();

    tap.notePrompt('hub-A', latestPointer);
    tap.notePrompt('hub-B', [
      'A UTF-8 group-chat prompt has been saved to this file:',
      'C:\\temp\\.hub-codex-prompts\\other.md',
    ].join('\n'));
    await writeUserMessage(frA, `${oldPointer}\n\n${latestPointer}`);

    assert.ok(await waitFor(() => tap.getRolloutPath('hub-A') === frA.rolloutPath),
      'hub-A should bind when Codex submits a concatenated input line containing the latest prompt pointer');
    assert.notStrictEqual(tap.getRolloutPath('hub-B'), frA.rolloutPath,
      'hub-B must not bind to a rollout that only contains hub-A prompt pointer');
  } finally {
    tap.unregisterSession('hub-A');
    tap.unregisterSession('hub-B');
    await frA.close();
    await frB.close();
    await fs.promises.rm(tmpRoot, { recursive: true, force: true });
  }
}

async function testSameCwdBindsWhenTuiDropsUnicodeFormatting() {
  const tmpRoot = path.join(os.tmpdir(), `codex-same-cwd-unicode-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  const cwd = 'C:\\test\\shared-cwd-unicode';
  const tap = new CodexTap({ sessionsRoot: tmpRoot, pollIntervalMs: 50 });
  const startAt = new Date();
  const frA = new FakeCodexRollout({ sessionsRoot: tmpRoot, cwd, sid: '019effff-0000-7000-8000-000000000005', startAt });
  const frB = new FakeCodexRollout({ sessionsRoot: tmpRoot, cwd, sid: '019effff-0000-7000-8000-000000000006', startAt });
  const shared = '这里是同一工作目录中的长群聊背景，需要依靠完整语义而不是时间差绑定。'.repeat(4);
  const promptA = `${shared}\n① 结论——恢复 512 维全信道，并验证协方差辅助估计。`;
  const promptB = `${shared}\n① 结论——分析另一个完全不同的调度问题。`;
  const submittedA = promptA.replace(/[①—]/g, '');

  try {
    tap.registerSession('hub-A', { cwd, requirePromptMatch: true });
    tap.registerSession('hub-B', { cwd, requirePromptMatch: true });
    tap.notePrompt('hub-A', promptA);
    tap.notePrompt('hub-B', promptB);
    await frA.start();
    await frB.start();
    await writeUserMessage(frA, submittedA);

    assert.ok(await waitFor(() => tap.getRolloutPath('hub-A') === frA.rolloutPath),
      'hub-A should bind when Codex TUI only drops Unicode presentation characters');
    assert.notStrictEqual(tap.getRolloutPath('hub-B'), frA.rolloutPath,
      'canonical matching must not bind a different long prompt in the same cwd');
  } finally {
    tap.unregisterSession('hub-A');
    tap.unregisterSession('hub-B');
    await frA.close();
    await frB.close();
    await fs.promises.rm(tmpRoot, { recursive: true, force: true });
  }
}

async function testCodex0147ItemCompletedBindsAndEmitsPrompt() {
  const tmpRoot = path.join(os.tmpdir(), `codex-0147-bind-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  const cwd = 'C:\\test\\codex-0147-shared';
  const tap = new CodexTap({ sessionsRoot: tmpRoot, pollIntervalMs: 50 });
  const startAt = new Date();
  const frA = new FakeCodexRollout({
    sessionsRoot: tmpRoot,
    cwd,
    sid: '019effff-0000-7000-8000-000000000147',
    startAt,
    cliVersion: '0.147.0',
  });
  const frB = new FakeCodexRollout({
    sessionsRoot: tmpRoot,
    cwd,
    sid: '019effff-0000-7000-8000-000000000148',
    startAt,
    cliVersion: '0.147.0',
  });
  const promptEvents = [];
  tap.on('prompt-submitted', event => promptEvents.push(event));

  try {
    tap.registerSession('hub-0147-A', { cwd, requirePromptMatch: true });
    tap.registerSession('hub-0147-B', { cwd, requirePromptMatch: true });
    tap.notePrompt('hub-0147-A', '修复 Codex 自动命名');
    tap.notePrompt('hub-0147-B', '另一个同目录任务');
    await frA.start();
    await frB.start();
    await writeCodex0147UserMessage(frA, '修复 Codex 自动命名');

    assert.ok(await waitFor(() => tap.getRolloutPath('hub-0147-A') === frA.rolloutPath),
      'Codex 0.147 UserMessage item should satisfy prompt matching and bind the correct rollout');
    assert.ok(await waitFor(() => promptEvents.length === 1),
      'Codex 0.147 UserMessage item should emit the prompt event used by auto-title');
    assert.strictEqual(tap.getRolloutPath('hub-0147-B'), null,
      'the other same-cwd Hub session must not steal the rollout');
    assert.deepStrictEqual(
      {
        hubSessionId: promptEvents[0].hubSessionId,
        text: promptEvents[0].text,
        turnId: promptEvents[0].turnId,
        signalSource: promptEvents[0].signalSource,
      },
      {
        hubSessionId: 'hub-0147-A',
        text: '修复 Codex 自动命名',
        turnId: 'turn-0147',
        signalSource: 'item_completed_user_message',
      },
    );
  } finally {
    tap.unregisterSession('hub-0147-A');
    tap.unregisterSession('hub-0147-B');
    await frA.close();
    await frB.close();
    await fs.promises.rm(tmpRoot, { recursive: true, force: true });
  }
}

async function testShortPromptKeepsPunctuationSignificant() {
  const tmpRoot = path.join(os.tmpdir(), `codex-short-prompt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  const cwd = 'C:\\test\\short-prompt';
  const tap = new CodexTap({ sessionsRoot: tmpRoot, pollIntervalMs: 50 });
  const fr = new FakeCodexRollout({
    sessionsRoot: tmpRoot,
    cwd,
    sid: '019effff-0000-7000-8000-000000000007',
    startAt: new Date(),
  });

  try {
    tap.registerSession('hub-short', { cwd, requirePromptMatch: true });
    tap.notePrompt('hub-short', 'A+B');
    await fr.start();
    await writeUserMessage(fr, 'AB');
    await sleep(250);
    assert.strictEqual(tap.getRolloutPath('hub-short'), null,
      'short prompts must not ignore punctuation because A+B and AB can mean different things');
  } finally {
    tap.unregisterSession('hub-short');
    await fr.close();
    await fs.promises.rm(tmpRoot, { recursive: true, force: true });
  }
}

function testTranscriptTapExposesNotePrompt() {
  const tap = new TranscriptTap();
  assert.strictEqual(typeof tap.notePrompt, 'function', 'TranscriptTap must expose notePrompt');
}

(async () => {
  const tests = [
    testTranscriptTapExposesNotePrompt,
    testSameCwdWaitsForPromptMatch,
    testSameCwdBindsWhenCodexPointerPromptIsConcatenated,
    testSameCwdBindsWhenTuiDropsUnicodeFormatting,
    testCodex0147ItemCompletedBindsAndEmitsPrompt,
    testShortPromptKeepsPunctuationSignificant,
  ];
  let failed = 0;
  for (const t of tests) {
    try {
      await t();
      console.log('OK', t.name);
    } catch (e) {
      failed++;
      console.error('FAIL', t.name);
      console.error(e.stack || e.message);
    }
  }
  process.exit(failed ? 1 : 0);
})();
