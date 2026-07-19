'use strict';

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const HUB_ROOT = path.resolve(__dirname, '..');
const ARTIFACT_DIR = path.join(HUB_ROOT, 'artifacts');
const WORKFLOW_SCREENSHOT = path.join(ARTIFACT_DIR, 'groupchat-workflow-autosave-custom-prompt.png');
const TIMELINE_SCREENSHOT = path.join(ARTIFACT_DIR, 'groupchat-real-timeline-two-times.png');
const INTERRUPT_SCREENSHOT = path.join(ARTIFACT_DIR, 'groupchat-interrupted-turn-restored.png');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitFor(cdp, expression, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdp.eval(expression)) return;
    await _waitMs(150);
  }
  throw new Error('Timed out waiting for: ' + expression);
}

async function capture(cdp, targetPath) {
  await cdp.send('Page.bringToFront');
  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, Buffer.from(shot.data, 'base64'));
  assert.ok(fs.statSync(targetPath).size > 10_000, 'screenshot should not be empty');
}

async function addMember(cdp, meetingId, label, expectedCount) {
  const trigger = expectedCount === 1
    ? "document.getElementById('mr-btn-add-sub').click()"
    : "document.querySelector('[data-gc-add-member]').click()";
  await cdp.eval(trigger);
  await waitFor(cdp, "!!document.getElementById('mr-add-sub-menu')");
  const clicked = await cdp.eval(`(() => {
    const item = [...document.querySelectorAll('#mr-add-sub-menu .mr-quote-menu-item')]
      .find(el => el.textContent.trim() === ${JSON.stringify(label)});
    if (!item) return false;
    item.click();
    return true;
  })()`);
  assert.strictEqual(clicked, true, `${label} should be available in add-member menu`);
  await waitFor(
    cdp,
    `window.MeetingRoom.getMeetingData(${JSON.stringify(meetingId)}).subSessions.length === ${expectedCount}`,
    30000,
  );
}

async function run() {
  const dataDir = path.join(os.tmpdir(), `hub-groupchat-workflow-ux-${process.pid}-${Date.now()}`);
  const port = await getFreePort();
  let hub = null;
  let cdp = null;

  try {
    hub = await launchIsolatedHub({
      dataDir,
      port,
      label: 'groupchat-workflow-ux-e2e',
      extraEnv: { CLAUDE_HUB_E2E: '1' },
    });
    cdp = await connectFirstPage(
      hub,
      target => target.type === 'page' && /renderer[\\/]index\.html/i.test(target.url),
    );
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1600,
      height: 1080,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await waitFor(cdp, "document.readyState === 'complete' && !!window.MeetingRoom");

    const meeting = await cdp.eval(`(async () => {
      const ipc = require('electron').ipcRenderer;
      return await ipc.invoke('create-meeting', { title: '群聊工作流 UX E2E', scene: 'general' });
    })()`);
    assert.ok(meeting && meeting.id, 'real create-meeting IPC should return a meeting');
    const meetingId = meeting.id;

    await cdp.eval(`(async () => {
      localStorage.setItem('mr-group-chat-view-mode', 'chat');
      const ipc = require('electron').ipcRenderer;
      const all = await ipc.invoke('get-meetings');
      const current = all.find(item => item.id === ${JSON.stringify(meetingId)});
      window.MeetingRoom.openMeeting(current.id, current);
      return true;
    })()`);
    await waitFor(cdp, "!!document.querySelector('.mr-gc-shell')");

    await addMember(cdp, meetingId, 'Claude Code', 1);
    await addMember(cdp, meetingId, 'Codex CLI', 2);
    await waitFor(cdp, "document.querySelectorAll('.mr-gc-member-row').length === 2");

    await cdp.eval("document.getElementById('mr-workflow-btn').click()");
    await waitFor(cdp, "document.getElementById('workflow-config-modal')?.style.display === 'flex'");

    const initialModalContract = await cdp.eval(`(() => ({
      hasSave: !!document.querySelector('.wf-save'),
      hasDone: !!document.querySelector('.wf-done'),
      autosaveText: document.querySelector('.wf-autosave-state')?.textContent || '',
      removedActionBar: !document.querySelector('.mr-gc-next-actions'),
    }))()`);
    assert.strictEqual(initialModalContract.hasSave, false, 'workflow modal must not require Save');
    assert.strictEqual(initialModalContract.hasDone, true);
    assert.ok(initialModalContract.autosaveText.includes('自动生效'));
    assert.strictEqual(initialModalContract.removedActionBar, true, 'legacy next-action bar should be removed');

    const isEnabled = await cdp.eval("document.querySelector('.wf-switch').classList.contains('on')");
    if (!isEnabled) await cdp.eval("document.querySelector('.wf-switch').click()");
    await cdp.eval("document.querySelector('[data-wf=\"tpl\"][data-tpl=\"t4\"]').click()");
    await waitFor(
      cdp,
      `window.MeetingRoom.getMeetingData(${JSON.stringify(meetingId)}).serialWorkflow?.templateId === 't4'`,
    );

    const workflow = await cdp.eval(`(() => {
      const m = window.MeetingRoom.getMeetingData(${JSON.stringify(meetingId)});
      const sessions = m.subSessions.map(sid => window.sessions?.get?.(sid) || null);
      return {
        config: m.serialWorkflow,
        members: sessions.map((session, index) => ({
          sid: m.subSessions[index],
          kind: session && session.kind,
          title: session && session.title,
          memberId: 'm' + (index + 1),
        })),
      };
    })()`);
    assert.strictEqual(workflow.config.enabled, true);
    assert.deepStrictEqual(workflow.config.steps, [['m1'], ['m2']], 'T4 should keep Claude before Codex');
    assert.ok(workflow.config.stepPrompts[0].m1, 'Claude plan prompt should be prefilled');
    assert.ok(workflow.config.stepPrompts[1].m2, 'Codex execution prompt should be prefilled');

    const customPrompt = 'E2E_CUSTOM_PROMPT：先列验收标准，再输出方案。';
    await cdp.eval(`(() => {
      const chip = document.querySelector('.wf-member-chip[data-step="0"][data-member="m1"]');
      chip.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      return true;
    })()`);
    await waitFor(cdp, "!!document.querySelector('textarea[data-wf=\"prompt-input\"][data-step=\"0\"][data-member=\"m1\"]')");
    await cdp.eval(`(() => {
      const input = document.querySelector('textarea[data-wf="prompt-input"][data-step="0"][data-member="m1"]');
      input.value = ${JSON.stringify(customPrompt)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await waitFor(
      cdp,
      `window.MeetingRoom.getMeetingData(${JSON.stringify(meetingId)}).serialWorkflow?.stepPrompts?.[0]?.m1 === ${JSON.stringify(customPrompt)}`,
    );
    await waitFor(
      cdp,
      `(async () => {
        const all = await require('electron').ipcRenderer.invoke('get-meetings');
        return all.find(item => item.id === ${JSON.stringify(meetingId)})?.serialWorkflow?.stepPrompts?.[0]?.m1 === ${JSON.stringify(customPrompt)};
      })()`,
    );
    await capture(cdp, WORKFLOW_SCREENSHOT);
    await cdp.eval("document.querySelector('.wf-done').click()");

    const timingFixture = await cdp.eval(`(() => {
      const path = require('path');
      const { getOrchestrator } = require(path.join(process.cwd(), 'core', 'group-chat-orchestrator.js'));
      const m = window.MeetingRoom.getMeetingData(${JSON.stringify(meetingId)});
      const [claudeSid, codexSid] = m.subSessions;
      const orch = getOrchestrator(process.env.CLAUDE_HUB_DATA_DIR, m.id);
      const begun = orch.beginTurn('请按真实完成时间展示这一轮');
      const base = Date.now() - 30000;
      orch.completeTurn(begun.turnNum, '请按真实完成时间展示这一轮', [
        { sid: claudeSid, label: 'Claude', status: 'completed', text: 'Claude 后完成', startedAt: base, completedAt: base + 18000 },
        { sid: codexSid, label: 'Codex', status: 'completed', text: 'Codex 先完成', startedAt: base + 1000, completedAt: base + 8000 },
      ], {
        [claudeSid]: { sid: claudeSid, memberId: 'm1', displayName: 'Claude', kind: 'claude' },
        [codexSid]: { sid: codexSid, memberId: 'm2', displayName: 'Codex', kind: 'codex' },
      });
      window.MeetingRoom.debugRenderGroupChatState(m.id, JSON.parse(JSON.stringify(orch.state)));
      const cards = [...document.querySelectorAll('.mr-gc-msg.ai')].map(el => ({
        text: el.innerText,
        time: el.querySelector('.mr-gc-time')?.innerText || '',
      }));
      return { cards, turnNum: begun.turnNum };
    })()`);
    assert.strictEqual(timingFixture.cards.length, 2);
    assert.ok(timingFixture.cards[0].text.includes('Codex 先完成'), 'earlier completion should render first');
    assert.ok(timingFixture.cards[1].text.includes('Claude 后完成'), 'later completion should render second');
    assert.ok(timingFixture.cards.every(card => card.time.includes('开始') && card.time.includes('完成')));
    await capture(cdp, TIMELINE_SCREENSHOT);

    const question = '这条错误需求应当被一键中断并恢复到输入框';
    const interceptInstalled = await cdp.eval(`(() => {
      const ipc = require('electron').ipcRenderer;
      if (window.__workflowUxOriginalInvoke) return false;
      window.__workflowUxOriginalInvoke = ipc.invoke.bind(ipc);
      ipc.invoke = function(channel, ...args) {
        if (channel === 'groupchat:get-state' && window.__workflowUxFixtureState) {
          return Promise.resolve(window.__workflowUxFixtureState);
        }
        if (channel === 'groupchat:turn') {
          window.__workflowUxTurnArgs = args[0];
          return new Promise(resolve => { window.__workflowUxReleaseTurn = resolve; });
        }
        if (channel === 'groupchat:interrupt') {
          const path = require('path');
          const { getOrchestrator } = require(path.join(process.cwd(), 'core', 'group-chat-orchestrator.js'));
          const m = window.MeetingRoom.getMeetingData(${JSON.stringify(meetingId)});
          const orch = getOrchestrator(process.env.CLAUDE_HUB_DATA_DIR, m.id);
          const input = window.__workflowUxTurnArgs?.userInput || ${JSON.stringify(question)};
          const begun = orch.beginTurn(input);
          const now = Date.now();
          const members = {};
          const results = m.subSessions.map((sid, index) => {
            members[sid] = { sid, memberId: 'm' + (index + 1), displayName: index === 0 ? 'Claude' : 'Codex', kind: index === 0 ? 'claude' : 'codex' };
            return { sid, label: members[sid].displayName, status: 'interrupted', text: '', startedAt: now - 500, completedAt: now };
          });
          orch.completeTurn(begun.turnNum, input, results, members);
          // The orchestrator module loaded in the renderer has a separate in-memory
          // cache from the main process. Route subsequent fixture reads to this exact
          // state so the UI refresh exercises the persisted interrupted record.
          window.__workflowUxFixtureState = JSON.parse(JSON.stringify(orch.state));
          const reply = { status: 'interrupted', turnNum: begun.turnNum, results };
          if (window.__workflowUxReleaseTurn) window.__workflowUxReleaseTurn(reply);
          return Promise.resolve({ ok: true, status: 'interrupted', turnNum: begun.turnNum, interruptedSids: m.subSessions.slice() });
        }
        return window.__workflowUxOriginalInvoke(channel, ...args);
      };
      return true;
    })()`);
    assert.strictEqual(interceptInstalled, true);

    const immediate = await cdp.eval(`(() => {
      const input = document.getElementById('mr-input-box');
      input.textContent = ${JSON.stringify(question)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('mr-send-btn').click();
      return {
        visible: [...document.querySelectorAll('.mr-gc-msg.mine')].some(el => el.innerText.includes(${JSON.stringify(question)})),
        cleared: !input.innerText.trim(),
      };
    })()`);
    assert.deepStrictEqual(immediate, { visible: true, cleared: true });
    await waitFor(cdp, "document.getElementById('mr-interrupt-btn').hidden === false");
    await cdp.eval("document.getElementById('mr-interrupt-btn').click()");
    await waitFor(cdp, `document.getElementById('mr-input-box').innerText.includes(${JSON.stringify(question)})`);
    await waitFor(cdp, "[...document.querySelectorAll('.mr-gc-msg.ai')].some(el => el.innerText.includes('本轮已中断'))");
    const interrupted = await cdp.eval(`(() => ({
      inputRestored: document.getElementById('mr-input-box').innerText.includes(${JSON.stringify(question)}),
      interruptedCards: [...document.querySelectorAll('.mr-gc-msg.ai')].filter(el => el.innerText.includes('本轮已中断')).length,
      buttonHidden: document.getElementById('mr-interrupt-btn').hidden === true,
    }))()`);
    assert.strictEqual(interrupted.inputRestored, true);
    assert.strictEqual(interrupted.interruptedCards, 2);
    assert.strictEqual(interrupted.buttonHidden, true);
    await capture(cdp, INTERRUPT_SCREENSHOT);

    const idleIpc = await cdp.eval(`(async () => {
      const ipc = require('electron').ipcRenderer;
      ipc.invoke = window.__workflowUxOriginalInvoke;
      return await ipc.invoke('groupchat:interrupt', { meetingId: ${JSON.stringify(meetingId)} });
    })()`);
    assert.strictEqual(idleIpc.status, 'idle', 'real interrupt IPC should be registered and idle after fixture turn');

    // Close/reopen exercises the static input panel listener lifecycle. Then deliberately
    // resolve Q2's append before Q1: click order, not IPC completion order, must decide the
    // latest request. A duplicate listener would also show up as duplicate append calls.
    const raceQ1 = 'E2E_RACE_Q1_OLD_REQUEST';
    const raceQ2 = 'E2E_RACE_Q2_LATEST_REQUEST';
    await cdp.eval(`(() => {
      const m = window.MeetingRoom.getMeetingData(${JSON.stringify(meetingId)});
      m.serialWorkflow = Object.assign({}, m.serialWorkflow || {}, { enabled: false, loop: { enabled: false } });
      window.MeetingRoom.closeMeetingPanel();
      window.MeetingRoom.openMeeting(m.id, m);
      const ipc = require('electron').ipcRenderer;
      const original = ipc.invoke.bind(ipc);
      window.__raceOriginalInvoke = original;
      window.__raceAppendCalls = [];
      window.__raceTurns = [];
      ipc.invoke = function(channel, ...args) {
        if (channel === 'meeting-append-user-turn') {
          const text = args[0]?.text || '';
          window.__raceAppendCalls.push(text);
          if (text === ${JSON.stringify(raceQ1)}) {
            return new Promise(resolve => { window.__raceReleaseQ1 = resolve; });
          }
          if (text === ${JSON.stringify(raceQ2)}) return Promise.resolve({ ok: true });
        }
        if (channel === 'groupchat:turn') {
          window.__raceTurns.push(args[0]?.userInput || '');
          return Promise.resolve({ status: 'completed', turnNum: 999, results: [], superseded: false });
        }
        return original(channel, ...args);
      };
      return true;
    })()`);
    await cdp.eval(`(() => {
      const box = document.getElementById('mr-input-box');
      box.textContent = ${JSON.stringify(raceQ1)};
      box.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('mr-send-btn').click();
      box.textContent = ${JSON.stringify(raceQ2)};
      box.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('mr-send-btn').click();
      return true;
    })()`);
    await waitFor(cdp, "window.__raceTurns?.length === 1");
    await cdp.eval("window.__raceReleaseQ1({ ok: true })");
    await _waitMs(250);
    const raceResult = await cdp.eval(`(() => {
      const result = {
        appendCalls: window.__raceAppendCalls.slice(),
        turns: window.__raceTurns.slice(),
        latestVisible: [...document.querySelectorAll('.mr-gc-msg.mine')]
          .some(el => el.innerText.includes(${JSON.stringify(raceQ2)})),
        oldVisible: [...document.querySelectorAll('.mr-gc-msg.mine')]
          .some(el => el.innerText.includes(${JSON.stringify(raceQ1)})),
      };
      require('electron').ipcRenderer.invoke = window.__raceOriginalInvoke;
      return result;
    })()`);
    assert.deepStrictEqual(raceResult.appendCalls, [raceQ1, raceQ2], 'reopen must not duplicate send listeners');
    assert.deepStrictEqual(raceResult.turns, [raceQ2], 'late Q1 append completion must not dispatch over Q2');
    assert.strictEqual(raceResult.latestVisible, true, 'latest optimistic question must remain visible');
    assert.strictEqual(raceResult.oldVisible, false, 'stale optimistic question must be discarded');

    console.log(JSON.stringify({
      ok: true,
      meetingId,
      port,
      workflow: {
        enabled: workflow.config.enabled,
        templateId: workflow.config.templateId,
        steps: workflow.config.steps,
        customPrompt,
      },
      timing: timingFixture,
      interrupted,
      raceResult,
      screenshots: [WORKFLOW_SCREENSHOT, TIMELINE_SCREENSHOT, INTERRUPT_SCREENSHOT],
    }, null, 2));
  } finally {
    if (cdp) await cdp.close().catch(() => {});
    if (hub) await gracefulQuit(hub);
  }
}

run().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
