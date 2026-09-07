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
  // ptyText 刻意不写进解构签名：合并位的取证脚本按源码文本替换这一行
  //   （'function setup({ extract = null } = {})'），签名一改就会静默弄坏对方的复现脚本。
  const ptyText = (arguments[0] && arguments[0].ptyText) || null;
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
    groupChatWatcher: {
      extractStreamingText: () => (ptyText ? { text: ptyText, source: 'pty_buffer' } : null),
      resendCurrentPrompt: async () => ({ ok: true }),
    },
    isWorkflowRunning: mid => loopEngine.isRunning(mid),
    getLoopEngine: () => loopEngine,
    meetingManager,
    sendToRenderer: () => {},
    sessionManager,
    transcriptTap: { extractLatestTurn: async () => extract },
    logger: silentLogger(),
  });

  // 生产里每次派发都先经 recordTurnPrompt 落一份回执（带 workflowRun 与 attemptId），
  //   台账的步骤身份就是从这儿来的。夹具照做，别手写 attempts 字面量。
  function recordStep(sid, stepIndex, text) {
    const workflowRun = {
      runId, kind: 'serial', stepIndex,
      attempt: 1, targetMemberIds: [sid === 's1' ? 'm1' : 'm2'],
    };
    const receipt = orch.recordTurnPrompt(turnNum, sid, 'PROMPT STEP ' + stepIndex, { workflowRun });
    if (text !== undefined) {
      orch.completeTurn(turnNum, '', [{ sid, attemptId: receipt.attemptId, status: 'completed', text }],
        { s1: 'm1', s2: 'm2' }, {}, { runId, workflowRun });
    }
    return receipt;
  }

  return { ipc, orch, turnNum, runId, meetingId, meeting, dispatchedMemberIds, loopEngine, dataDir, recordStep };
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
    // 三种拒绝原因都合法，取决于第一次采用把流程推到了哪里：本步已有答案、
    //   已经推进到下一步、或者整条串行已经跑完。要守的是后果而不是措辞。
    assert.ok(['already_adopted', 'step_advanced', 'no_active_step'].includes(second.reason),
      '第二次提交必须被挡住，实际 reason=' + second.reason);
    if (second.reason !== 'no_active_step') {
      assert.strictEqual(second.keepText, true, '被挡时正文要留给用户，不能直接丢');
    }
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


  await t('B4 · 同步只认最终信号：开场白不采用、不启动下一步', async () => {
    const env = setup({ extract: { text: '好的，我先看一下这个问题……', source: 'manual_claude_transcript', extractMode: 'partial_commentary' } });
    const res = await env.ipc.invoke('workflow:sync-step', { meetingId: env.meetingId });
    await settle(env.loopEngine, env.meetingId, 400);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.adopted, false, '开场白不是交付，不能替用户认下来');
    assert.strictEqual(res.advanced, false);
    assert.deepStrictEqual(env.dispatchedMemberIds, [],
      '没有最终信号时一次派发都不许有；实际：' + JSON.stringify(env.dispatchedMemberIds));
    const tried = (res.tried || [])[0];
    assert.strictEqual(tried && tried.reason, 'not_final');
    assert.ok(/手动提供回答/.test(tried.detail || ''), '要告诉用户下一步能干嘛：' + (tried && tried.detail));
  });

  await t('B4 · 同步不走 PTY 兜底：屏幕上的半截文字不算交付', async () => {
    const env = setup({ ptyText: '屏幕上刷着的半截输出' });
    const res = await env.ipc.invoke('workflow:sync-step', { meetingId: env.meetingId });
    await settle(env.loopEngine, env.meetingId, 400);
    assert.strictEqual(res.adopted, false);
    assert.deepStrictEqual(env.dispatchedMemberIds, []);
  });

  await t('B2 · 等待中（running）也给同步与手动提供回答两个入口', () => {
    const fs = require('fs');
    const room = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'meeting-room.js'), 'utf8');
    const loopRunning = room.slice(room.indexOf("if (loopSt && loopSt.status === 'running')"),
      room.indexOf("} else if (loopSt && loopSt.status === 'paused' && discussingNow)"));
    assert.ok(/_renderStepAdoptionChips/.test(loopRunning),
      '拆掉回答超时之后，卡住的步骤会长期停在 running；只在 paused 时渲染等于最需要时没有入口');
    const serialRunning = room.slice(room.indexOf("if (serialSt && serialSt.status === 'running')"),
      room.indexOf("} else if (serialSt && serialSt.status === 'paused'"));
    assert.ok(/_renderStepAdoptionChips/.test(serialRunning), '串行等待中同样要有');
  });

  await t('B1 · 不能拿「引擎被调用了」当推进成功', () => {
    const fs = require('fs');
    const handlers = fs.readFileSync(path.join(__dirname, '..', 'main', 'ipc', 'groupchat-recovery-handlers.js'), 'utf8');
    assert.ok(/async function awaitAdvance\(/.test(handlers),
      '采用之后要观察持久状态，确认流程真的往前走了');
    assert.ok(!/advanced: !!resumed\.ok/.test(handlers),
      'resumed.ok 只说明引擎被叫起来了，不代表这一步推进了');
  });


  // ───────── 合并位第二轮 BLOCKERS 的回归（R2-1 / R2-2 / R2-3）─────────

  await t('R2-1 · 人工答案只在同一次尝试内受保护，后续步骤的修订不许被压住', async () => {
    const env = setup();
    const first = env.recordStep('s1', 0);                      // 第 1 步的派发回执
    const ctx = await env.ipc.invoke('workflow:step-context', { meetingId: env.meetingId });
    await env.ipc.invoke('groupchat-adopt-pasted-result', {
      meetingId: env.meetingId, sid: 's1', text: 'ORIGINAL MANUALLY PASTED IMPLEMENTATION',
      token: { meetingId: env.meetingId, sid: 's1', runId: ctx.runId, turnNum: ctx.turnNum, stepIndex: ctx.stepIndex },
    });
    await settle(env.loopEngine, env.meetingId);
    // 第 3 步（同一位成员、新的一次尝试）交出修订稿
    const third = env.recordStep('s1', 2, 'NEW REVISED IMPLEMENTATION');
    const turn = env.orch.state.turns.find(x => x.n === env.turnNum);
    assert.notStrictEqual(String(first.attemptId), String(third.attemptId), '两次尝试必须是不同身份');
    assert.strictEqual(turn.by.s1, 'NEW REVISED IMPLEMENTATION',
      '人工正文只该护住它自己那一次尝试；护过头会把后续步骤真写出来的修订静默丢掉');
    assert.strictEqual(turn.byStatus.s1, 'completed');
  });

  await t('R2-1 · 同一次尝试内，迟到的失败信号仍然顶不掉人工正文', async () => {
    const env = setup();
    const receipt = env.recordStep('s1', 0);
    const ctx = await env.ipc.invoke('workflow:step-context', { meetingId: env.meetingId });
    await env.ipc.invoke('groupchat-adopt-pasted-result', {
      meetingId: env.meetingId, sid: 's1', text: '人工采用的正文',
      token: { meetingId: env.meetingId, sid: 's1', runId: ctx.runId, turnNum: ctx.turnNum, stepIndex: ctx.stepIndex },
    });
    await settle(env.loopEngine, env.meetingId);
    // 同一个 attemptId 的迟到失败信号
    env.orch.completeTurn(env.turnNum, '',
      [{ sid: 's1', attemptId: receipt.attemptId, status: 'errored', text: '', reason: 'pty exit' }],
      { s1: 'm1' }, {}, { runId: env.runId });
    const turn = env.orch.state.turns.find(x => x.n === env.turnNum);
    assert.strictEqual(turn.by.s1, '人工采用的正文', '同一次尝试内的保护不能被这次修改削掉');
    assert.strictEqual(turn.byStatus.s1, 'manual_paste');
  });

  await t('R2-2 · 第二步粘贴要结算它自己的 attempt，不是这个成员最后一次出现的那个', async () => {
    const env = setup();
    env.recordStep('s1', 0, 'FIRST STEP FINISHED');
    const second = env.recordStep('s2', 1);                     // 已派发、尚未结算
    Object.assign(env.meeting.serialWorkflow.serialRunState, {
      currentStepIndex: 1, nextStepIndex: 1, status: 'paused', attemptsByStep: { 0: 1, 1: 1 },
    });
    const ctx = await env.ipc.invoke('workflow:step-context', { meetingId: env.meetingId });
    assert.strictEqual(ctx.stepIndex, 1);
    assert.strictEqual((ctx.members[0] || {}).attemptId, second.attemptId,
      '步骤上下文要给出**这一步**的派发回执，写回答案时才不会认错尝试');
    const res = await env.ipc.invoke('groupchat-adopt-pasted-result', {
      meetingId: env.meetingId, sid: 's2', text: 'SECOND STEP PASTED FINAL',
      token: { meetingId: env.meetingId, sid: 's2', runId: ctx.runId, turnNum: ctx.turnNum, stepIndex: ctx.stepIndex },
    });
    await settle(env.loopEngine, env.meetingId);
    assert.strictEqual(res.ok, true);
    const attempt = env.orch.getAttempt ? env.orch.getAttempt(second.attemptId) : null;
    // 台账的生命周期状态统一是 completed，来源记在 signalSource 上（settleAttempt 的既有口径）。
    assert.ok(attempt && attempt.status === 'completed' && Number(attempt.resultTextLength) > 0,
      '这一步自己的 attempt 必须被结算，否则就是「气泡好了、流程没动」：' + JSON.stringify(attempt));
    assert.strictEqual(attempt.signalSource, 'manual_paste', '来源要如实留痕');
    assert.strictEqual(env.meeting.serialWorkflow.serialRunState.status, 'done',
      '采用之后流程要真的跑完，不能只更新气泡');
  });

  await t('R2-3 · 同步读取跨越 await 后步骤已推进：拒绝采用，不写进新步骤', async () => {
    let resolveExtract;
    const pending = new Promise(r => { resolveExtract = r; });
    const env = setup({ extract: pending });
    env.recordStep('s1', 0);
    const before = env.orch.state.turns.find(x => x.n === env.turnNum);
    const textBefore = (before && before.by && before.by.s1) || '';

    const syncPromise = env.ipc.invoke('workflow:sync-step', { meetingId: env.meetingId });
    // 读转录期间，流程走到了第 3 步（同一位成员、同一个可见轮次）
    await new Promise(r => setTimeout(r, 20));
    env.meeting.serialWorkflow.steps = [['m1'], ['m2'], ['m1']];
    env.meeting.serialWorkflow.stepConfigs.push({ name: 'step-3', prompt: 'role-3' });
    env.recordStep('s1', 2);
    Object.assign(env.meeting.serialWorkflow.serialRunState, {
      currentStepIndex: 2, nextStepIndex: 2, attemptsByStep: { 0: 1, 1: 1, 2: 1 },
    });
    // 第 1 步的 final 文本这才迟到
    resolveExtract({ text: 'STALE STEP ZERO FINAL', source: 'manual_claude_transcript', extractMode: 'final_answer' });

    const res = await syncPromise;
    await settle(env.loopEngine, env.meetingId, 300);
    const tried = (res.tried || [])[0];
    assert.ok(tried && !tried.ok, '迟到的旧步骤文本不许被采用：' + JSON.stringify(res));
    assert.strictEqual(tried.reason, 'step_advanced');
    const after = env.orch.state.turns.find(x => x.n === env.turnNum);
    assert.notStrictEqual((after && after.by && after.by.s1) || '', 'STALE STEP ZERO FINAL',
      '旧步骤的正文绝不能写进新步骤');
    assert.strictEqual((after && after.by && after.by.s1) || '', textBefore, '不该有任何写入');
  });

  await t('R2-3 · watcher 也要对身份：attemptId 不是这一步的就不结算它', () => {
    const fs2 = require('fs');
    const handlers = fs2.readFileSync(path.join(__dirname, '..', 'main', 'ipc', 'groupchat-recovery-handlers.js'), 'utf8');
    assert.ok(/watcherMatchesStep/.test(handlers),
      '三步共用一个 turnNum，「currentTurn 没变」挡不住「步骤已推进」，必须比对 attemptId');
    assert.ok(/getAttemptIdentity/.test(handlers), '身份要从 watcher 自己那儿拿');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
