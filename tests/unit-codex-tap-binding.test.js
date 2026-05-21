'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const groupchat = require('../core/group-chat-orchestrator');
const { CodexTap } = require('../core/transcript-tap');
const { FakeCodexRollout } = require('./helpers/fake-codex-rollout');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(fn, timeoutMs, message) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await sleep(50);
  }
  assert.fail(message);
}

async function writeUserMessage(rollout, message) {
  await rollout.writeRaw({
    timestamp: new Date().toISOString(),
    type: 'event_msg',
    payload: { type: 'user_message', message },
  });
}

async function testCodexTaskCompleteReachesGroupChatState() {
  const tmpRoot = path.join(os.tmpdir(), `hub-codex-bind-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  const sessionsRoot = path.join(tmpRoot, 'codex-sessions');
  const hubDataDir = path.join(tmpRoot, 'hub-data');
  const cwd = path.join(tmpRoot, 'workspace');
  const meetingId = 'meeting-bind-test';
  const sid = 'sid-codex-a';
  const prompt = 'group chat binding probe';
  const finalText = 'task_complete reached groupchat state';
  const tap = new CodexTap({ sessionsRoot, pollIntervalMs: 50 });
  const rollout = new FakeCodexRollout({
    sessionsRoot,
    cwd,
    sid: '019ecccc-0000-7000-8000-000000000003',
  });

  try {
    fs.mkdirSync(cwd, { recursive: true });
    const orch = groupchat.getOrchestrator(hubDataDir, meetingId);
    const { turnNum } = orch.beginTurn(prompt);
    orch.recordTurnPrompt(turnNum, sid, prompt);

    tap.registerSession(sid, { cwd });
    tap.notePrompt(sid, prompt);

    tap.on('turn-complete', (ev) => {
      if (ev.hubSessionId !== sid) return;
      orch.completeTurn(turnNum, prompt, [{
        sid,
        label: 'Codex 1',
        status: 'completed',
        text: ev.text,
      }], {
        [sid]: { sid, memberId: 'm1', displayName: 'Codex 1', kind: 'codex' },
      });
    });

    await rollout.start();
    await writeUserMessage(rollout, prompt);
    await rollout.writeTaskStarted();
    await rollout.writeTaskComplete(finalText, 120);

    await waitFor(
      () => orch.state.messages.some(m => m.sid === sid && m.role === 'assistant' && m.content === finalText),
      5000,
      'Codex PTY task_complete observed but groupchat state has no assistant message after 5s',
    );
  } finally {
    tap.unregisterSession(sid);
    await rollout.close();
    await fs.promises.rm(tmpRoot, { recursive: true, force: true });
  }
}

(async () => {
  try {
    await testCodexTaskCompleteReachesGroupChatState();
    console.log('OK testCodexTaskCompleteReachesGroupChatState');
  } catch (e) {
    console.error('FAIL testCodexTaskCompleteReachesGroupChatState');
    console.error(e.stack || e.message);
    process.exit(1);
  }
})();
