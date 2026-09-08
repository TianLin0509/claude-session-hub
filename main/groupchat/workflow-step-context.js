'use strict';
/**
 * 「当前这一步是什么情况」—— 唯一的读取器（2026-09-07 Claude 1）。
 *
 * 状态栏文案、同步入口、手动粘贴弹窗、以及旧的 loop:resume / serial:resume，
 * 全部从这里取判断。分开各写一份的代价合并位已经实测过两次：
 *   - 状态栏说「可继续 · 已收到回答」，引擎却判 manual_paste 不合格，停回 paused；
 *   - 新入口会等，旧的 serial:resume 照样把原成员重问一遍。
 * 一个读取器 + 一个纯函数判据，这两类分叉在结构上就不成立。
 */

const WSR = require('../../core/workflow-step-result.js');
const DevDiscuss = require('../../core/dev-discuss.js');

function createStepContextReader(deps) {
  const {
    meetingManager,
    sessionManager,
    groupchat,
    getHubDataDir,
    isWorkflowRunning = () => false,
    logger = console,
  } = deps || {};

  function sidResolver(meeting) {
    const specs = Array.isArray(meeting.slotSpecs) ? meeting.slotSpecs : [];
    const subSessions = Array.isArray(meeting.subSessions) ? meeting.subSessions : [];
    return (memberId) => {
      let index = specs.findIndex((spec, i) => String((spec && spec.memberId) || `m${i + 1}`) === String(memberId));
      if (index < 0) {
        const legacy = /^m(\d+)$/.exec(String(memberId || ''));
        index = legacy ? Number(legacy[1]) - 1 : -1;
      }
      return index >= 0 ? (subSessions[index] || null) : null;
    };
  }

  /** workflowSteps 里 runId + stepIndex 那一条：步骤身份的来源。 */
  function findStepEntry(orchState, runId, stepIndex) {
    if (!orchState || !runId) return null;
    for (const turn of (orchState.turns || [])) {
      const entries = (turn && turn.meta && Array.isArray(turn.meta.workflowSteps)) ? turn.meta.workflowSteps : [];
      const hit = entries.find(item => item
        && String(item.runId) === String(runId)
        && Number(item.stepIndex) === Number(stepIndex));
      if (hit) return { entry: hit, turn, turnNum: turn.n };
    }
    return null;
  }

  /**
   * 这一步、这一位的**派发回执** —— attemptId 和 turnNum **必须一起从这里取**。
   *
   * 2026-09-07 合并位 e6e4183 阻断项：只把 attemptId 从回执里取回来，turnNum 却继续
   * 用 loopState.currentTurnNum，就会把「评审的 attemptId」和「实现的 turnNum」拼进
   * 同一次写入。同席位（极简）时评审另起一轮，这一拼就是：
   *   - 正文写回实现那一轮 → 刚落盘的 PROGRESS 被 RESULT 覆盖，工作台交付卡变 null；
   *   - requestedTurn 与真实当前轮对不上 → 错过活 watcher，评审那一步继续干等；
   *   - 而 IPC 还报「流程继续」。
   * 一次写入里 run / step / turn / attempt 四件事必须同源，这就是本函数的全部意义。
   *
   * 取值顺序（都带 turnNum 一起回）：
   *   ① 尝试台账里带 workflowRun 的那条 —— recordTurnPrompt 在派发那一刻写下，
   *      attemptId 与 turnNum 同一条记录，最可靠，且跨 Hub 重启仍在；
   *   ② pendingPrompts 回执 —— 按**所有轮次**去找，不能只翻当前轮
   *      （评审的回执压根不在实现那一轮下面）。
   * 两者都没有就返回 null：这一步还没派发出去，没有可写入的位置。
   */
  function stepReceiptFor(orchState, { runId, stepIndex, sid }) {
    if (!orchState || !sid) return null;
    const attempt = WSR.stepAttemptFor(orchState.attempts, { runId, stepIndex, sid });
    if (attempt) {
      return {
        attemptId: attempt.attemptId || null,
        runId: attempt.runId || runId,
        turnNum: Number(attempt.turnNum) || null,
        providerTurnId: attempt.providerTurnId || null,
        source: 'attempt_ledger',
      };
    }
    const pending = (orchState.pendingPrompts && typeof orchState.pendingPrompts === 'object')
      ? orchState.pendingPrompts : {};
    for (const [turnKey, bySid] of Object.entries(pending)) {
      const receipt = bySid && bySid[sid];
      const wr = receipt && receipt.workflowRun;
      if (!wr || String(wr.runId) !== String(runId) || Number(wr.stepIndex) !== Number(stepIndex)) continue;
      return {
        attemptId: receipt.attemptId || null,
        runId: receipt.runId || runId,
        turnNum: Number(turnKey) || null,
        providerTurnId: receipt.providerTurnId || null,
        source: 'pending_receipt',
      };
    }
    return null;
  }

  function describeWorkflowStep(meetingId) {
    const meeting = meetingManager.getMeeting(meetingId);
    if (!meeting || !meeting.groupChat) return { ok: false, reason: 'group_chat_not_found' };
    const workflow = meeting.serialWorkflow || {};
    const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
    const loopState = workflow.loopState || null;
    const serialState = workflow.serialRunState || null;

    let kind = null; let stepIndex = null; let turnNum = null; let runId = null; let status = null;
    let stepKey = null;
    let fallbackTurnNum = null;
    let targetMemberIds = [];
    if (loopState && ['running', 'paused', 'stopped_user'].includes(loopState.status)) {
      kind = 'loop';
      status = loopState.status;
      runId = loopState.runId || null;
      // 注意：loopState.currentTurnNum 是**实现那一轮**。同席位时评审另起一轮，
      //   所以它只能当最后兜底，真正的轮号要从这一步自己的回执里取（见下）。
      fallbackTurnNum = Number(loopState.currentTurnNum) || null;
      const round = Math.max(0, Number(loopState.round) || 0);
      const reviewerPhase = String(loopState.currentStep || '') === 'reviewer';
      stepIndex = round * 2 + (reviewerPhase ? 1 : 0);
      targetMemberIds = (steps[reviewerPhase ? 1 : 0] || []).filter(Boolean);
      stepKey = `loop:${round}:${reviewerPhase ? 'reviewer' : 'builder'}`;
    } else if (serialState && ['running', 'paused', 'stopped_user'].includes(serialState.status)) {
      kind = 'serial';
      status = serialState.status;
      runId = serialState.runId || null;
      fallbackTurnNum = Number(serialState.currentTurnNum) || null;
      const raw = serialState.currentStepIndex !== null && serialState.currentStepIndex !== undefined
        ? Number(serialState.currentStepIndex)
        : Number(serialState.nextStepIndex);
      stepIndex = Number.isFinite(raw) ? raw : 0;
      targetMemberIds = (steps[stepIndex] || []).filter(Boolean);
      stepKey = `serial:${stepIndex}`;
    } else {
      return { ok: true, kind: null, active: false };
    }

    const sidOf = sidResolver(meeting);

    let orchState = null;
    try {
      const orch = groupchat.getOrchestrator(getHubDataDir(), meetingId);
      orchState = orch && (typeof orch.getState === 'function' ? orch.getState() : orch.state);
    } catch (err) {
      logger.warn('[workflow-step-context] orchestrator load failed:', err && err.message);
    }
    const located = findStepEntry(orchState, runId, stepIndex);
    const stepEntry = located ? located.entry : null;

    // ── 这一步的轮次：只认这一步自己的证据，一件都不跟别的步骤借 ──
    const targetSids = targetMemberIds.map(sidOf).filter(Boolean);
    const receiptBySid = new Map();
    for (const sid of targetSids) {
      const receipt = stepReceiptFor(orchState, { runId, stepIndex, sid });
      if (receipt) receiptBySid.set(sid, receipt);
    }
    const receiptTurns = [...receiptBySid.values()].map(r => r.turnNum).filter(Boolean);
    let turnSource = null;
    if (receiptTurns.length) { turnNum = receiptTurns[0]; turnSource = 'step_receipt'; }
    else if (located && located.turnNum) { turnNum = located.turnNum; turnSource = 'step_snapshot'; }
    else if (fallbackTurnNum) { turnNum = fallbackTurnNum; turnSource = 'workflow_state_fallback'; }
    else if (orchState && Number(orchState.currentTurn) > 0) { turnNum = Number(orchState.currentTurn); turnSource = 'current_turn_fallback'; }
    // 同一步的成员应当在同一轮里。真出现分歧就不再猜，标出来让采用入口拒绝写入。
    const turnConsistent = receiptTurns.every(n => Number(n) === Number(turnNum));
    // 只有从这一步自己的回执/快照解析出来的轮号才允许被写入；兜底来的不算。
    const turnResolved = (turnSource === 'step_receipt' || turnSource === 'step_snapshot') && turnConsistent;

    const turn = orchState ? ((orchState.turns || []).find(t => t && Number(t.n) === Number(turnNum)) || null) : null;

    const view = WSR.inspectStepResults({
      turn,
      messages: orchState && orchState.messages,
      turnNum,
      targetSids,
      stepEntry,
      attempts: orchState && orchState.attempts,
      runId,
      stepIndex,
      requireStepIdentity: true,
    });
    const bySid = new Map((view.results || []).map(item => [item.sid, item]));
    const missing = new Set(view.missingSids || []);

    const members = targetMemberIds.map(memberId => {
      const sid = sidOf(memberId);
      const session = sid ? sessionManager.getSession(sid) : null;
      const item = bySid.get(sid) || { status: null, textLength: 0 };
      const receipt = sid ? (receiptBySid.get(sid) || null) : null;
      return {
        memberId,
        sid,
        label: (session && (session.title || session.kind)) || memberId,
        hasResult: !!sid && !missing.has(sid),
        status: item.status || null,
        textLength: item.textLength || 0,
        // 写回答案时要用的身份 —— 属于**这一步**，不是这个 sid 最后一次出现的那个。
        //   attemptId 与 turnNum 同源，采用入口会再核一次两者一致。
        attemptId: (receipt && receipt.attemptId) || null,
        attemptTurnNum: (receipt && receipt.turnNum) || null,
        providerTurnId: (receipt && receipt.providerTurnId) || null,
      };
    });

    const decision = WSR.decideResumeAction({
      turn,
      messages: orchState && orchState.messages,
      turnNum,
      targetSids,
      stepEntry,
      attempts: orchState && orchState.attempts,
      runId,
      stepIndex,
      requireStepIdentity: true,
      stopped: status === 'stopped_user',
      discussing: DevDiscuss.isDiscussing(meeting),
    });
    const nextStep = steps[Number(stepIndex) + 1] || [];
    const nextLabel = nextStep.map(id => {
      const sid = sidOf(id);
      const session = sid ? sessionManager.getSession(sid) : null;
      return (session && (session.title || session.kind)) || id;
    }).join(' / ');
    const chip = WSR.describeResumeAction(decision, {
      stepLabel: `第 ${Number(stepIndex) + 1} 步`,
      nextLabel,
    });

    return {
      ok: true,
      active: true,
      kind,
      status,
      runId,
      stepIndex,
      stepKey,
      turnNum,
      // 这个轮号是不是从这一步自己的证据里解析出来的。false = 只是兜底猜的，
      //   采用入口据此拒绝写入，绝不把正文写进别的步骤的轮次。
      turnResolved,
      turnSource,
      members,
      decision: { action: decision.action, why: decision.why, missingSids: decision.missingSids || [] },
      chip,
      running: !!isWorkflowRunning(meetingId),
      lastErrorAt: Number((loopState && loopState.lastError && loopState.lastError.at)
        || (serialState && serialState.lastError && serialState.lastError.at)) || 0,
      lastErrorReason: (loopState && loopState.lastError && loopState.lastError.reason)
        || (serialState && serialState.lastError && serialState.lastError.reason) || null,
    };
  }

  return { describeWorkflowStep };
}

module.exports = { createStepContextReader };
