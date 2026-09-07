'use strict';
/*
 * 「同步回答 / 手动粘贴」的 IPC 端到端计数验收（2026-09-07 Claude 1）
 * 跑法：node tests/unit-workflow-adoption-ipc.test.js
 *
 * 这一条是维护者与合并位共同点名的核心验收，判据是**派发计数**，不是「点了返回 ok」
 * 也不是「气泡更新了」：
 *   A1 异常 → 用户手动粘贴回答 → A1 的 prompt 派发数不增加，A2 恰好派发一次。
 *
 * 台账用真实 orchestrator 造：beginTurn + completeTurn(失败结果) 走的就是生产那条路，
 * 所以 turn.meta.workflowSteps 里那份「结算那一刻的快照」是真的，不是手写的。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const groupchat = require('../core/group-chat-orchestrator.js');
const { createLoopEngine } = require('../main/groupchat/loop-engine.js');
const { registerGroupchatRecoveryIpc } = require('../main/ipc/groupchat-recovery-handlers.js');

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('  ✓ ' + name); }
  catch (e) { fail += 1; console.log('  ✗ ' + name + '\n      ' + ((e && e.stack) || e)); }
}

function silentLogger() {
  return { log: () => {}, warn: () => {}, error: () => {} };
}

// 一个只记录 handler 的假 ipcMain。
function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, args) => {
      const fn = handlers.get(channel);
      if (!fn) throw new Error('no handler for ' + channel);
      return fn({}, args);
    },
    has: channel => handlers.has(channel),
  };
}

function setup({ extract = null } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-adopt-ipc-'));
  const meetingId = 'mtg-adopt';
  groupchat._private.resetCache();

  const sessions = new Map([
    ['s1', { id: 's1', title: 'Claude 1', kind: 'claude', status: 'idle', cwd: 'C:/work' }],
    ['s2', { id: 's2', title: 'Codex 2', kind: 'codex', status: 'idle', cwd: 'C:/work' }],
  ]);
  const meeting = {
    id: meetingId,
    groupChat: true,
    subSessions: ['s1', 's2'],
    slotSpecs: [{ memberId: 'm1' }, { memberId: 'm2' }],
    serialWorkflow: {
      enabled: true,
      steps: [['m1'], ['m2']],
      stepConfigs: [{ name: 'step-1', prompt: 'role-1' }, { name: 'step-2', prompt: 'role-2' }],
      loop: { enabled: false },
    },
  };

  // ── 造出「第 1 步失败、快照写着 errored」的真实台账 ──
  const orch = groupchat.getOrchestrator(dataDir, meetingId);
  const runId = 'RUN-ADOPT-1';
  orch.beginTurn('第 1 步任务', { runId });
  const turnNum = orch.state.currentTurn;
  orch.completeTurn(
    turnNum,
    '第 1 步任务',
    [{ sid: 's1', status: 'errored', text: '', reason: 'response_timeout', signalSource: 'hard_timeout' }],
    { s1: 'm1' },
    {},
    { runId, workflowRun: { runId, kind: 'serial', stepIndex: 0, attempt: 1, targetMemberIds: ['m1'] } },
  );

  const dispatchedMemberIds = [];
  const dispatcher = {
    async dispatchGroupChatTurn(_meetingId, args) {
      dispatchedMemberIds.push(...args.targetMemberIds);
      const results = args.targetMemberIds.map(memberId => ({
        sid: memberId === 'm1' ? 's1' : 's2',
        status: 'completed',
        text: memberId + ' answer',
      }));
      // 照生产：派发完成后把结果写回 orchestrator，下一步的活状态才看得到。
      orch.completeTurn(turnNum, '', results, { s1: 'm1', s2: 'm2' }, {}, {
        runId: args.workflowRun && args.workflowRun.runId,
        workflowRun: args.workflowRun,
      });
      return { status: 'completed', turnNum, results };
    },
    interruptMeetingTurn: () => ({ ok: true }),
  };

  const meetingManager = {
    getMeeting: () => meeting,
    getAllMeetings: () => [meeting],
    updateMeeting: (_id, fields) => {
      if (fields.serialWorkflow) meeting.serialWorkflow = fields.serialWorkflow;
      return meeting;
    },
  };
  const sessionManager = { getSession: sid => sessions.get(sid) || null };

  const loopEngine = createLoopEngine({
    stepTextWait: { verdictQuietMs: 20, verdictCapMs: 200, builderQuietMs: 20, builderCapMs: 200 },
    getDispatcher: () => dispatcher,
    getOrchestrator: () => orch,
    meetingManager,
    sessionManager,
    resumeSession: async () => null,
    sendToRenderer: () => {},
    logger: silentLogger(),
  });

  // 第 1 步失败后的持久检查点（生产里由引擎写下）。
  meeting.serialWorkflow.serialRunState = {
    schemaVersion: 1, driver: 'main', kind: 'serial',
    runId, goal: '目标', status: 'paused',
    nextStepIndex: 0, currentStepIndex: 0, currentTurnNum: turnNum,
    attemptsByStep: { 0: 2 }, completedSteps: [], startedAt: Date.now(),
    lastError: { stage: 'serial', stepIndex: 0, reason: 'response_timeout', at: Date.now() },
  };

  const ipc = fakeIpcMain();
  registerGroupchatRecoveryIpc(ipc, {
    dispatchGroupChatTurn: dispatcher.dispatchGroupChatTurn,
    getHubDataDir: () => dataDir,
    getActiveWatchers: () => new Map(),   // 硬超时之后 watcher 早就没了，正是出问题的那种局面
    groupchat,
    groupChatWatcher: { extractStreamingText: () => null, resendCurrentPrompt: async () => ({ ok: true }) },
    isWorkflowRunning: mid => loopEngine.isRunning(mid),
    getLoopEngine: () => loopEngine,
    meetingManager,
    sendToRenderer: () => {},
    sessionManager,
    transcriptTap: { extractLatestTurn: async () => extract },
    logger: silentLogger(),
  });

  return { ipc, orch, turnNum, runId, meetingId, meeting, dispatchedMemberIds, loopEngine, dataDir };
}

// 引擎是后台跑的：等它把这一轮走完。
async function settle(loopEngine, meetingId, ms = 1500) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 25));
    if (!loopEngine.isRunning(meetingId)) {
      await new Promise(r => setTimeout(r, 50));
      if (!loopEngine.isRunning(meetingId)) return;
    }
  }
}

async function main() {
  console.log('Running workflow adoption IPC tests...');

  await t('步骤上下文如实报告：第 1 步缺 Claude 1 的回答，动作是等待不是重发', async () => {
    const env = setup();
    const ctx = await env.ipc.invoke('workflow:step-context', { meetingId: env.meetingId });
    assert.strictEqual(ctx.ok, true);
    assert.strictEqual(ctx.active, true);
    assert.strictEqual(ctx.stepIndex, 0);
    assert.strictEqual(ctx.decision.action, 'wait');
    assert.deepStrictEqual(ctx.decision.missingSids, ['s1']);
    assert.ok(/不会重发|找不到就继续等/.test(ctx.chip.hint), '文案必须预告不发 prompt：' + ctx.chip.hint);
  });

  await t('没答案时点「同步回答」：不重发、不跳过、不清零重跑', async () => {
    const env = setup();                       // transcriptTap 什么都读不到
    const res = await env.ipc.invoke('workflow:sync-step', { meetingId: env.meetingId });
    await settle(env.loopEngine, env.meetingId, 400);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.advanced, false);
    assert.strictEqual(res.reason, 'awaiting_result');
    assert.deepStrictEqual(env.dispatchedMemberIds, [],
      '同步入口一次 prompt 都不许发；实际：' + JSON.stringify(env.dispatchedMemberIds));
  });

  await t('【核心】手动粘贴后一次提交：A1 派发数不增加，A2 恰好一次', async () => {
    const env = setup();
    const ctx = await env.ipc.invoke('workflow:step-context', { meetingId: env.meetingId });
    const res = await env.ipc.invoke('groupchat-adopt-pasted-result', {
      meetingId: env.meetingId,
      sid: 's1',
      text: '我从 CLI 里复制过来的完整回答正文。',
      token: { meetingId: env.meetingId, sid: 's1', runId: ctx.runId, turnNum: ctx.turnNum, stepIndex: ctx.stepIndex },
    });
    assert.strictEqual(res.ok, true, '粘贴应被采用：' + JSON.stringify(res));
    assert.strictEqual(res.adopted, true);
    await settle(env.loopEngine, env.meetingId);
    const m1 = env.dispatchedMemberIds.filter(id => id === 'm1').length;
    const m2 = env.dispatchedMemberIds.filter(id => id === 'm2').length;
    assert.strictEqual(m1, 0, 'A1 不该被再问一遍；实际派发：' + JSON.stringify(env.dispatchedMemberIds));
    assert.strictEqual(m2, 1, 'A2 应恰好启动一次；实际派发：' + JSON.stringify(env.dispatchedMemberIds));
  });

  await t('粘贴的正文如实标成 manual_paste，且写进了活状态', async () => {
    const env = setup();
    const ctx = await env.ipc.invoke('workflow:step-context', { meetingId: env.meetingId });
    await env.ipc.invoke('groupchat-adopt-pasted-result', {
      meetingId: env.meetingId, sid: 's1', text: '人工提供的正文',
      token: { meetingId: env.meetingId, sid: 's1', runId: ctx.runId, turnNum: ctx.turnNum, stepIndex: ctx.stepIndex },
    });
    await settle(env.loopEngine, env.meetingId);
    const msg = env.orch.state.messages.find(m => m && m.role === 'assistant' && m.sid === 's1');
    assert.ok(msg, '应写出一条 s1 的助手消息');
    assert.strictEqual(msg.status, 'manual_paste', '来源必须如实标注，不冒充自动完成');
    assert.strictEqual(msg.signalSource, 'manual_paste');
  });

  await t('重复提交同一段正文：第二次被挡，不覆盖也不重启', async () => {
    const env = setup();
    const ctx = await env.ipc.invoke('workflow:step-context', { meetingId: env.meetingId });
    const token = { meetingId: env.meetingId, sid: 's1', runId: ctx.runId, turnNum: ctx.turnNum, stepIndex: ctx.stepIndex };
    const first = await env.ipc.invoke('groupchat-adopt-pasted-result', { meetingId: env.meetingId, sid: 's1', text: '正文', token });
    const second = await env.ipc.invoke('groupchat-adopt-pasted-result', { meetingId: env.meetingId, sid: 's1', text: '另一段正文', token });
    await settle(env.loopEngine, env.meetingId);
    assert.strictEqual(first.ok, true);
    assert.strictEqual(second.ok, false);
    // 两种拒绝原因都合法，取决于第二次点得多快：本步已经有答案了（already_adopted），
    //   或者流程已经因为第一次采用推到了下一步（step_advanced）。
    //   要守的是后果，不是措辞：不覆盖、不重启、不多派发一次。
    assert.ok(['already_adopted', 'step_advanced'].includes(second.reason),
      '第二次提交必须被挡住，实际 reason=' + second.reason);
    assert.strictEqual(second.keepText, true, '被挡时正文要留给用户，不能直接丢');
    assert.strictEqual(env.dispatchedMemberIds.filter(id => id === 'm2').length, 1,
      '双击提交不许多派发一次；实际：' + JSON.stringify(env.dispatchedMemberIds));
    assert.strictEqual(env.dispatchedMemberIds.filter(id => id === 'm1').length, 0);
  });

  await t('弹窗过期（流程已推进到别的步骤）：拒绝，且把正文留给用户', async () => {
    const env = setup();
    const ctx = await env.ipc.invoke('workflow:step-context', { meetingId: env.meetingId });
    const stale = { meetingId: env.meetingId, sid: 's1', runId: ctx.runId, turnNum: ctx.turnNum, stepIndex: 5 };
    const res = await env.ipc.invoke('groupchat-adopt-pasted-result', {
      meetingId: env.meetingId, sid: 's1', text: '过期窗口里的正文', token: stale,
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'step_advanced');
    assert.strictEqual(res.keepText, true, '正文有价值，不能直接丢掉');
    assert.deepStrictEqual(env.dispatchedMemberIds, []);
  });

  await t('空正文不采用', async () => {
    const env = setup();
    const res = await env.ipc.invoke('groupchat-adopt-pasted-result', {
      meetingId: env.meetingId, sid: 's1', text: '   \n  ', token: { meetingId: env.meetingId, sid: 's1' },
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'empty_text');
  });

  await t('用户已停止之后：同步与粘贴都被拒，绝不推进', async () => {
    const env = setup();
    env.meeting.serialWorkflow.serialRunState.status = 'stopped_user';
    const ctx = await env.ipc.invoke('workflow:step-context', { meetingId: env.meetingId });
    assert.strictEqual(ctx.decision.action, 'blocked');
    const sync = await env.ipc.invoke('workflow:sync-step', { meetingId: env.meetingId });
    assert.strictEqual(sync.ok, false);
    assert.strictEqual(sync.reason, 'user_stopped');
    const paste = await env.ipc.invoke('groupchat-adopt-pasted-result', {
      meetingId: env.meetingId, sid: 's1', text: '停止之后才到的答案',
      token: { meetingId: env.meetingId, sid: 's1', runId: ctx.runId, turnNum: ctx.turnNum, stepIndex: ctx.stepIndex },
    });
    assert.strictEqual(paste.ok, false);
    assert.strictEqual(paste.reason, 'user_stopped');
    await settle(env.loopEngine, env.meetingId, 300);
    assert.deepStrictEqual(env.dispatchedMemberIds, []);
  });

  await t('转录里后来补上了答案：「同步回答」采用并接上 A2，A1 仍不重发', async () => {
    const env = setup({ extract: { text: 'A1 恢复之后写完的答案', source: 'manual_claude_transcript', extractMode: 'final_answer' } });
    const res = await env.ipc.invoke('workflow:sync-step', { meetingId: env.meetingId });
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.strictEqual(res.adopted, true);
    await settle(env.loopEngine, env.meetingId);
    assert.strictEqual(env.dispatchedMemberIds.filter(id => id === 'm1').length, 0,
      'A1 已经答过，同步不该重发；实际：' + JSON.stringify(env.dispatchedMemberIds));
    assert.strictEqual(env.dispatchedMemberIds.filter(id => id === 'm2').length, 1);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
