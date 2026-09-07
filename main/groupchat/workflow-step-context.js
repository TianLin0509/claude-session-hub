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

  function describeWorkflowStep(meetingId) {
    const meeting = meetingManager.getMeeting(meetingId);
    if (!meeting || !meeting.groupChat) return { ok: false, reason: 'group_chat_not_found' };
    const workflow = meeting.serialWorkflow || {};
    const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
    const loopState = workflow.loopState || null;
    const serialState = workflow.serialRunState || null;

    let kind = null; let stepIndex = null; let turnNum = null; let runId = null; let status = null;
    let stepKey = null;
    let targetMemberIds = [];
    if (loopState && ['running', 'paused', 'stopped_user'].includes(loopState.status)) {
      kind = 'loop';
      status = loopState.status;
      runId = loopState.runId || null;
      turnNum = Number(loopState.currentTurnNum) || null;
      const round = Math.max(0, Number(loopState.round) || 0);
      const reviewerPhase = String(loopState.currentStep || '') === 'reviewer';
      stepIndex = round * 2 + (reviewerPhase ? 1 : 0);
      targetMemberIds = (steps[reviewerPhase ? 1 : 0] || []).filter(Boolean);
      stepKey = `loop:${round}:${reviewerPhase ? 'reviewer' : 'builder'}`;
    } else if (serialState && ['running', 'paused', 'stopped_user'].includes(serialState.status)) {
      kind = 'serial';
      status = serialState.status;
      runId = serialState.runId || null;
      turnNum = Number(serialState.currentTurnNum) || null;
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
      if (!turnNum && orchState && Number(orchState.currentTurn) > 0) turnNum = Number(orchState.currentTurn);
    } catch (err) {
      logger.warn('[workflow-step-context] orchestrator load failed:', err && err.message);
    }
    const located = findStepEntry(orchState, runId, stepIndex);
    const stepEntry = located ? located.entry : null;
    if (!turnNum && located) turnNum = located.turnNum;
    const turn = orchState ? ((orchState.turns || []).find(t => t && Number(t.n) === Number(turnNum)) || null) : null;

    const targetSids = targetMemberIds.map(sidOf).filter(Boolean);
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
      return {
        memberId,
        sid,
        label: (session && (session.title || session.kind)) || memberId,
        hasResult: !!sid && !missing.has(sid),
        status: item.status || null,
        textLength: item.textLength || 0,
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
