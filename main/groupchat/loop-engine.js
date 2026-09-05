'use strict';
/*
 * 循环工作流 · main 进程驱动引擎（Phase 2b 进阶，2026-06-29 道雪）
 * ──────────────────────────────────────────────────────────────
 * 把「开发→评审→gate→推进→打磨→终止」循环驱动放在 main 进程，复用现有 dispatcher。
 * renderer 崩溃不中断循环（turn 级容错）；每轮持久化 loopState，Hub 重启自动续跑。
 * 纯判定逻辑复用 renderer/loop-workflow.js（UMD：node 环境取 module.exports）。
 *
 * 依赖注入（便于单测 mock）：
 *   getDispatcher() → { dispatchGroupChatTurn(meetingId,args) }
 *   meetingManager  → getMeeting(id) / updateMeeting(id, fields)
 *   sessionManager  → getSession(sid) / createSession(kind,opts)
 *   sendToRenderer(channel, data)
 *   writeReport(html) → string|null（可选，写晨报，返回路径）
 *   logger
 */
const LC = require('../../renderer/loop-workflow.js'); // UMD → node 下为纯逻辑 module.exports
const WT = require('../../renderer/workflow-templates.js');
const { formatBeijingDateTime } = require('../../core/beijing-time.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 开机自动续跑串行工作流的年龄上限：超过这个时长没动静的，只做提示不自动派发。
const SERIAL_BOOT_RESUME_MAX_IDLE_MS = 6 * 60 * 60 * 1000;

function createLoopEngine(deps) {
  const {
    getDispatcher, getOrchestrator, meetingManager, resumeSession, sessionManager,
    sendToRenderer = () => {}, writeReport = () => null, logger = console,
  } = deps || {};
  const running = new Map(); // meetingId → { abort, mode, runId, startedAt }

  function runId(prefix) {
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  }

  function logError(message, error) {
    const fn = logger && (logger.error || logger.warn || logger.log);
    if (typeof fn === 'function') fn.call(logger, message, error && error.message ? error.message : error || '');
  }

  function sidOf(meeting, memberId) {
    const idx = parseInt(String(memberId).slice(1), 10);
    return (idx > 0 && Array.isArray(meeting.subSessions)) ? (meeting.subSessions[idx - 1] || null) : null;
  }
  function labelOf(meeting, memberId) {
    const sid = sidOf(meeting, memberId);
    const s = sid && sessionManager ? sessionManager.getSession(sid) : null;
    return (s && s.title) || memberId;
  }
  function textFrom(results, sid) {
    const r = (results || []).find((x) => x && x.sid === sid);
    return r ? (r.text || '') : '';
  }

  // ── 评审裁决的取文本路径（2026-09-05 修）────────────────────────────────────
  //
  // 症状：合并位明明跑完了全套验证、也给了 RESULT: PASS，引擎却当它「没给裁决」，
  //       保守判 fail、白烧一轮；连烧三轮报 stopped_max。代码其实已经正确合入了。
  //
  // 根因：ClaudeTap 有 idle timer —— 转录静默一段时间就主动 emit turn-complete。
  //       评审说完「现在开始验证」就去跑测试 / git 了，转录随之静默，计时器提前触发，
  //       watcher 拿当时那段开场白结算并 resolve。真正的完整回答稍后才通过
  //       patch-after-settle 补进转录（5 分钟窗口），**而引擎早已用短文本判完了**。
  //       更糟的是引擎以为评审结束、把下一步派给了工作位，于是工作位收到
  //       「评审没给裁决」这种它根本修不了的阻断项。
  //
  // 修法：不动 idle timer（它是为「首轮卡住不出卡」兜底的，动它会伤别的链路）。
  //       改在真正需要裁决的这一层等：结算文本与已持久化转录取更长的那个，
  //       解析不出裁决时就继续等——**只要文本还在长就一直等**（说明 agent 还在干活），
  //       连续 QUIET 毫秒不长才认定它是真没给裁决，另设硬上限兜底。
  // 等待预算可由 deps 注入 —— 生产用安全的默认值，单测注入毫秒级避免每轮空转。
  // （不注入的话，mock 出来的 agent 永远不会补文本，每一步都要白等满静默期。）
  const _w = (deps && deps.stepTextWait) || {};
  const VERDICT_QUIET_MS = Number(_w.verdictQuietMs) > 0 ? Number(_w.verdictQuietMs) : 60_000;
  const VERDICT_WAIT_CAP_MS = Number(_w.verdictCapMs) > 0 ? Number(_w.verdictCapMs) : 8 * 60_000;
  // 工作位的预算小一个量级：PROGRESS 缺了不影响流程正确性，不值得每轮白等一分钟。
  const BUILDER_QUIET_MS = Number(_w.builderQuietMs) > 0 ? Number(_w.builderQuietMs) : 10_000;
  const BUILDER_WAIT_CAP_MS = Number(_w.builderCapMs) > 0 ? Number(_w.builderCapMs) : 4 * 60_000;

  function persistedTurnText(meetingId, turnNum, sid) {
    if (typeof getOrchestrator !== 'function' || !turnNum || !sid) return '';
    try {
      const orchestrator = getOrchestrator(meetingId);
      const state = orchestrator && typeof orchestrator.getState === 'function'
        ? orchestrator.getState()
        : orchestrator && orchestrator.state;
      const turn = ((state && state.turns) || []).find(t => t && Number(t.n) === Number(turnNum));
      return (turn && turn.by && turn.by[sid]) || '';
    } catch (error) {
      return '';
    }
  }

  /** 取这一步「最完整」的文本：结算文本 vs 转录里已补丁的文本，谁长用谁。 */
  function bestTextSoFar(meetingId, turnNum, sid, settledText) {
    const settled = settledText || '';
    const persisted = persistedTurnText(meetingId, turnNum, sid);
    return persisted.length > settled.length ? persisted : settled;
  }

  /**
   * 等这一步真的「说完」。
   * isDone(text) 给出「已经拿到想要的东西」的判据，拿到就立刻走，不空等；
   * 拿不到就看文本还长不长 —— 还在长说明 agent 还在干活，继续等。
   */
  async function awaitStepText(meetingId, turnNum, sid, settledText, isDone, opts = {}) {
    const quietMs = Number(opts.quietMs) > 0 ? Number(opts.quietMs) : VERDICT_QUIET_MS;
    const capMs = Number(opts.capMs) > 0 ? Number(opts.capMs) : VERDICT_WAIT_CAP_MS;
    const tick = Number(opts.tickMs) > 0 ? Number(opts.tickMs) : 3000;
    const isAborted = typeof opts.isAborted === 'function' ? opts.isAborted : () => false;
    const done = typeof isDone === 'function' ? isDone : () => true;

    let best = bestTextSoFar(meetingId, turnNum, sid, settledText);
    if (done(best)) return best;

    let lastLen = best.length;
    let lastGrowthAt = Date.now();
    const deadline = Date.now() + capMs;

    while (Date.now() < deadline && !isAborted()) {
      await sleep(tick);
      const now = bestTextSoFar(meetingId, turnNum, sid, settledText);
      if (now.length > lastLen) {
        best = now; lastLen = now.length; lastGrowthAt = Date.now();
      }
      if (done(best)) return best;                         // 拿到就走，不空等
      if (Date.now() - lastGrowthAt >= quietMs) break;      // 真的不再输出了
    }
    return best;
  }

  // 评审：等到能解析出 RESULT 裁决
  const hasVerdict = (t) => !!LC.parseVerdict(t);
  // 工作位：等到它按合同交出 PROGRESS 那一行。
  // 不等的话，引擎会在工作位还在改文件时就把审查派出去 —— 评审看到的是半成品分支。
  const hasProgressCard = (t) => /(?:^|\n)\s*PROGRESS\s*[:：]/i.test(String(t || ''));

  const awaitVerdictText = (meetingId, turnNum, sid, settledText, opts) =>
    awaitStepText(meetingId, turnNum, sid, settledText, hasVerdict, opts);

  // Dormant members must resume through the same provider-native path as a
  // normal Session.  Recreating with only {id,title} silently lost cwd/model/
  // tuning/MCP and was a major source of workflow-only failures.
  async function ensureMemberReady(meeting, memberId) {
    const sid = sidOf(meeting, memberId);
    if (!sid || !sessionManager) throw new Error(`workflow member ${memberId} is missing`);
    let session = sessionManager.getSession(sid);
    // Boot resume can race renderer/session restoration. Wait for the persisted
    // session to materialize before declaring the workflow broken.
    for (let i = 0; !session && i < 60; i += 1) {
      await sleep(500);
      session = sessionManager.getSession(sid);
    }
    if (!session) throw new Error(`workflow session ${memberId} (${sid}) is missing after restore grace`);
    if (session.status !== 'dormant') return session;
    if (typeof resumeSession !== 'function') throw new Error(`workflow member ${memberId} cannot resume`);
    logger.log('[workflow-engine] resuming dormant member', sid);
    const resumed = await resumeSession({ ...session, hubId: session.id || sid, meetingId: meeting.id });
    if (!resumed) throw new Error(`workflow member ${memberId} resume failed`);
    for (let i = 0; i < 60; i += 1) {
      session = sessionManager.getSession(sid);
      if (session && session.status !== 'dormant') return session;
      await sleep(500);
    }
    throw new Error(`workflow member ${memberId} resume timed out`);
  }

  function buildConfig(loopCfg) {
    const c = LC.defaultConfig();
    // v2: one clean review pass is enough; suggestions never create an implicit polish phase.
    c.gate = { consecutivePass: 1 };
    c.polish = { enabled: false };
    c.stop = {
      maxRounds: Math.max(1, Math.min(10, (loopCfg && loopCfg.maxRounds) || 3)),
      deadlineTs: (loopCfg && loopCfg.deadlineTs) || null,
      noProgressRounds: (loopCfg && loopCfg.noProgressRounds) || 2,
    };
    c.cwd = (loopCfg && loopCfg.cwd) || null;
    return c;
  }

  function persist(meetingId, state, config) {
    try {
      const cur = (meetingManager.getMeeting(meetingId) || {}).serialWorkflow || {};
      meetingManager.updateMeeting(meetingId, {
        serialWorkflow: Object.assign({}, cur, {
          loopState: {
            runId: state.runId || null,
            goal: state.goal, status: state.status, phase: state.phase, round: state.round,
            consecutiveGreen: state.consecutiveGreen, suggestionPool: state.suggestionPool,
            history: state.history, _lastBlockerSig: state._lastBlockerSig, _noProgress: state._noProgress,
            deadlineTs: config.stop.deadlineTs, driver: 'main',
            currentStep: state.currentStep || null, attempt: state.attempt || (state.round + 1),
            currentTurnNum: state.currentTurnNum || null,
            stepAttempt: Number(state.stepAttempt) || 0,
            lastError: state.lastError || null,
          },
        }),
      });
      return true;
    } catch (e) {
      logError('[loop-engine] persist failed:', e);
      return false;
    }
  }

  function validateSerial(meetingId) {
    const meeting = meetingManager.getMeeting(meetingId);
    if (!meeting || !meeting.groupChat) return { ok: false, reason: 'group_chat_not_found' };
    const workflow = meeting.serialWorkflow || {};
    const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
    if (!workflow.enabled || !steps.length) return { ok: false, reason: 'serial_workflow_not_enabled' };
    if (steps.some(step => !Array.isArray(step) || !step.filter(Boolean).length)) {
      return { ok: false, reason: 'serial_workflow_has_empty_step' };
    }
    return { ok: true, meeting, workflow, steps };
  }

  function validateLoop(meetingId) {
    const meeting = meetingManager.getMeeting(meetingId);
    if (!meeting || !meeting.groupChat) return { ok: false, reason: 'group_chat_not_found' };
    const workflow = meeting.serialWorkflow || {};
    const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
    const builderId = (steps[0] || [])[0];
    const reviewers = Array.from(new Set([].concat(...steps.slice(1)).filter(Boolean)));
    if (!(workflow.loop && workflow.loop.enabled)) return { ok: false, reason: 'loop_workflow_not_enabled' };
    if (!builderId || !reviewers.length) return { ok: false, reason: 'loop_requires_builder_and_reviewer' };
    return { ok: true, meeting, workflow, steps };
  }

  function persistSerial(meetingId, state) {
    const meeting = meetingManager.getMeeting(meetingId);
    if (!meeting) throw new Error('meeting disappeared while persisting serial workflow');
    const current = meeting.serialWorkflow || {};
    meetingManager.updateMeeting(meetingId, {
      serialWorkflow: {
        ...current,
        serialRunState: {
          schemaVersion: 1,
          driver: 'main',
          kind: 'serial',
          runId: state.runId,
          goal: state.goal,
          status: state.status,
          nextStepIndex: state.nextStepIndex,
          currentStepIndex: state.currentStepIndex,
          currentTurnNum: state.currentTurnNum,
          attemptsByStep: { ...(state.attemptsByStep || {}) },
          completedSteps: Array.isArray(state.completedSteps) ? state.completedSteps.slice(-100) : [],
          startedAt: state.startedAt,
          updatedAt: Date.now(),
          lastError: state.lastError || null,
        },
      },
    });
  }

  function stepEvidence(meetingId, runIdValue, stepIndex) {
    if (typeof getOrchestrator !== 'function') return null;
    try {
      const orchestrator = getOrchestrator(meetingId);
      const state = orchestrator && typeof orchestrator.getState === 'function'
        ? orchestrator.getState()
        : orchestrator && orchestrator.state;
      for (const turn of (state && state.turns) || []) {
        const entries = turn && turn.meta && Array.isArray(turn.meta.workflowSteps)
          ? turn.meta.workflowSteps
          : [];
        const entry = entries.find(item => item
          && item.runId === runIdValue
          && Number(item.stepIndex) === Number(stepIndex));
        if (entry) return { entry, turnNum: turn.n, turn };
      }
    } catch (error) {
      logError('[workflow-engine] failed to inspect durable step evidence:', error);
    }
    return null;
  }

  function pendingStepTurn(meetingId, runIdValue, stepIndex) {
    if (typeof getOrchestrator !== 'function') return null;
    try {
      const orchestrator = getOrchestrator(meetingId);
      const state = orchestrator && typeof orchestrator.getState === 'function'
        ? orchestrator.getState()
        : orchestrator && orchestrator.state;
      for (const [turnNum, bySid] of Object.entries(state && state.pendingPrompts || {})) {
        for (const entry of Object.values(bySid || {})) {
          const workflowRun = entry && entry.workflowRun;
          if (workflowRun
            && workflowRun.runId === runIdValue
            && Number(workflowRun.stepIndex) === Number(stepIndex)) {
            const parsed = Number(turnNum);
            return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
          }
        }
      }
    } catch (error) {
      logError('[workflow-engine] failed to inspect pending step receipt:', error);
    }
    return null;
  }

  function resultIsSuccessful(result) {
    return !!(result
      && (!result.status || ['completed', 'manual_extracted'].includes(result.status))
      && String(result.text || '').trim());
  }

  function validateStepResult(meeting, targetMemberIds, dispatchResult) {
    if (!dispatchResult || dispatchResult.status !== 'completed') {
      return { ok: false, reason: dispatchResult && (dispatchResult.reason || dispatchResult.status) || 'step_not_completed' };
    }
    if (dispatchResult.interrupted || dispatchResult.superseded) {
      return { ok: false, takenOver: true, reason: dispatchResult.interrupted ? 'interrupted' : 'superseded' };
    }
    const expectedSids = targetMemberIds.map(id => sidOf(meeting, id)).filter(Boolean);
    const results = Array.isArray(dispatchResult.results) ? dispatchResult.results : [];
    const failed = expectedSids.map(sid => results.find(item => item && item.sid === sid))
      .filter(item => !resultIsSuccessful(item));
    if (expectedSids.length !== targetMemberIds.length) return { ok: false, reason: 'workflow_member_missing' };
    if (failed.length) {
      const first = failed[0];
      return { ok: false, reason: first && (first.reason || first.status) || 'participant_result_missing' };
    }
    return { ok: true };
  }

  function evidenceIsSuccessful(evidence, targetCount) {
    const results = evidence && evidence.entry && Array.isArray(evidence.entry.results)
      ? evidence.entry.results
      : [];
    return results.length >= targetCount && results.slice(0, targetCount).every(result =>
      result && (!result.status || ['completed', 'manual_extracted'].includes(result.status)) && Number(result.textLength) > 0);
  }

  function dispatchResultFromEvidence(meeting, targetMemberIds, evidence) {
    const turn = evidence && evidence.turn || {};
    return {
      status: 'completed',
      turnNum: evidence && evidence.turnNum || null,
      results: targetMemberIds.map(memberId => {
        const sid = sidOf(meeting, memberId);
        return {
          sid,
          status: turn.byStatus && turn.byStatus[sid] || 'completed',
          text: turn.by && turn.by[sid] || '',
          recovered: true,
        };
      }),
      recovered: true,
    };
  }

  async function runSerial(meetingId, userInput, persistedState, runOptions = {}) {
    if (running.has(meetingId)) return null;
    const validation = validateSerial(meetingId);
    if (!validation.ok) return { status: 'paused', lastError: { reason: validation.reason, at: Date.now() } };
    const { meeting, workflow, steps } = validation;
    const stepConfigs = WT.normalizeStepConfigs(steps, workflow.stepConfigs);
    const maxAttempts = Math.max(1, Math.min(3, Number(workflow.maxAttemptsPerStep) || 2));
    const state = persistedState && persistedState.status === 'running'
      ? {
          ...persistedState,
          attemptsByStep: { ...(persistedState.attemptsByStep || {}) },
          completedSteps: Array.isArray(persistedState.completedSteps) ? persistedState.completedSteps.slice() : [],
        }
      : {
          runId: runId('serial'),
          goal: String(userInput || '').trim(),
          status: 'running',
          nextStepIndex: 0,
          currentStepIndex: null,
          currentTurnNum: null,
          attemptsByStep: {},
          completedSteps: [],
          startedAt: Date.now(),
          lastError: null,
        };
    if (!state.goal) state.goal = String(userInput || '').trim();
    const entry = { abort: false, mode: 'serial', runId: state.runId, startedAt: Date.now() };
    running.set(meetingId, entry);
    const progress = (extra = {}) => {
      try {
        sendToRenderer('workflow:progress', {
          meetingId,
          kind: 'serial',
          runId: state.runId,
          goal: state.goal,
          status: state.status,
          nextStepIndex: state.nextStepIndex,
          currentStepIndex: state.currentStepIndex,
          currentTurnNum: state.currentTurnNum,
          totalSteps: steps.length,
          ...extra,
        });
      } catch (error) {
        logError('[workflow-engine] progress delivery failed:', error);
      }
    };
    try {
      persistSerial(meetingId, state);
      progress({ stage: 'start' });
      while (state.status === 'running' && state.nextStepIndex < steps.length) {
        if (entry.abort) { state.status = 'stopped_user'; break; }
        const index = state.currentStepIndex != null ? Number(state.currentStepIndex) : Number(state.nextStepIndex);
        const targetMemberIds = (steps[index] || []).filter(Boolean);

        // Crash window closure: dispatcher persists this evidence before its
        // Promise resolves. If Hub died after the provider answered but before
        // serialRunState advanced, do not execute the step twice.
        const recovered = stepEvidence(meetingId, state.runId, index);
        if (recovered && evidenceIsSuccessful(recovered, targetMemberIds.length)) {
          state.currentTurnNum = state.currentTurnNum || recovered.turnNum || null;
          if (!state.completedSteps.some(item => Number(item.stepIndex) === index)) {
            state.completedSteps.push({ stepIndex: index, completedAt: recovered.entry.completedAt || Date.now(), recovered: true });
          }
          state.nextStepIndex = index + 1;
          state.currentStepIndex = null;
          state.lastError = null;
          persistSerial(meetingId, state);
          progress({ stage: 'recovered-step', completedStepIndex: index });
          continue;
        }
        if (!state.currentTurnNum) {
          state.currentTurnNum = pendingStepTurn(meetingId, state.runId, index) || null;
        }

        const previousAttempts = Number(state.attemptsByStep[index]) || 0;
        if (previousAttempts >= maxAttempts) {
          state.status = 'paused';
          state.lastError = state.lastError || { stage: 'serial', stepIndex: index, reason: 'attempts_exhausted', at: Date.now() };
          break;
        }
        const attempt = previousAttempts + 1;
        state.currentStepIndex = index;
        state.attemptsByStep[index] = attempt;
        state.lastError = null;
        persistSerial(meetingId, state);
        progress({ stage: 'step', stepIndex: index, attempt });

        let dispatchResult = null;
        let failureReason = null;
        try {
          for (const memberId of targetMemberIds) await ensureMemberReady(meeting, memberId);
          if (entry.abort) { state.status = 'stopped_user'; break; }
          const stepPrompt = WT.buildSerialStepPrompt(state.goal, stepConfigs[index], index, steps.length);
          const timeoutMs = Math.max(60_000, Math.min(30 * 60_000, Number(stepConfigs[index] && stepConfigs[index].timeoutMs) || 10 * 60_000));
          dispatchResult = await getDispatcher().dispatchGroupChatTurn(meetingId, {
            userInput: stepPrompt,
            targetMemberIds,
            reuseTurnNum: state.currentTurnNum || null,
            appendUserMessage: !state.currentTurnNum,
            dispatchMode: 'serial',
            turnTimeoutMs: timeoutMs,
            allowActiveExtend: false,
            heroIdBySid: runOptions.heroIdBySid || {},
            workflowRun: {
              runId: state.runId,
              kind: 'serial',
              stepIndex: index,
              attempt,
              targetMemberIds,
            },
          });
          if (dispatchResult && dispatchResult.turnNum) state.currentTurnNum = dispatchResult.turnNum;
          const checked = validateStepResult(meeting, targetMemberIds, dispatchResult);
          if (checked.takenOver) {
            state.status = 'stopped_user';
            state.lastError = { stage: 'serial', stepIndex: index, reason: checked.reason, at: Date.now() };
            break;
          }
          if (!checked.ok) failureReason = checked.reason;
        } catch (error) {
          failureReason = error && error.message || 'serial_step_exception';
          logError(`[workflow-engine] serial step ${index + 1} failed:`, error);
        }

        if (!failureReason) {
          state.completedSteps.push({ stepIndex: index, completedAt: Date.now(), attempt });
          state.nextStepIndex = index + 1;
          state.currentStepIndex = null;
          state.lastError = null;
          persistSerial(meetingId, state);
          progress({ stage: 'step-complete', completedStepIndex: index, attempt });
          continue;
        }

        state.lastError = { stage: 'serial', stepIndex: index, reason: failureReason, attempt, at: Date.now() };
        persistSerial(meetingId, state);
        if (attempt < maxAttempts && !entry.abort) {
          progress({ stage: 'step-retry', stepIndex: index, attempt, error: state.lastError });
          await sleep(500);
          continue;
        }
        state.status = entry.abort ? 'stopped_user' : 'paused';
      }

      if (state.status === 'running' && state.nextStepIndex >= steps.length) state.status = 'done';
      state.currentStepIndex = null;
      persistSerial(meetingId, state);
      progress({ stage: state.status === 'done' ? 'done' : state.status, error: state.lastError });
      return state;
    } catch (error) {
      state.status = entry.abort ? 'stopped_user' : 'paused';
      state.lastError = { stage: 'serial-engine', reason: error && error.message || 'internal_error', at: Date.now() };
      try { persistSerial(meetingId, state); } catch (persistError) { logError('[workflow-engine] serial fatal persist failed:', persistError); }
      progress({ stage: 'paused', error: state.lastError });
      return state;
    } finally {
      if (running.get(meetingId) === entry) running.delete(meetingId);
    }
  }

  async function runLoop(meetingId, userInput, persistedLoopState, runOptions = {}) {
    if (running.has(meetingId)) { logger.log('[loop-engine] already running for ' + meetingId); return null; }
    let entry = null;
    let state = null;
    let config = null;
    try {
      const meeting = meetingManager.getMeeting(meetingId);
      if (!meeting) { logger.log('[loop-engine] meeting not found ' + meetingId); return null; }
      const wf = meeting.serialWorkflow || {};
      const steps = Array.isArray(wf.steps) ? wf.steps : [];
      const builderId = (steps[0] || [])[0];
      const reviewerIds = Array.from(new Set([].concat(...steps.slice(1)).filter(Boolean)));
      if (!builderId || !reviewerIds.length) { logger.log('[loop-engine] need builder + reviewer(s)'); return null; }
      config = buildConfig(wf.loop);

      let prevMerge = null, goal, resuming = false;
      if (persistedLoopState && persistedLoopState.status === 'running') {
        const r = LC.resumeState(persistedLoopState); state = r.state; prevMerge = r.prevMerge; goal = state.goal || (userInput || '').trim(); resuming = true;
      } else { goal = (userInput || '').trim(); state = LC.newLoopState(); state.goal = goal; }
      state.runId = state.runId || runId('loop');
      state.currentTurnNum = state.currentTurnNum || null;
      entry = { abort: false, mode: 'loop', runId: state.runId, startedAt: Date.now() };
      running.set(meetingId, entry);
      // v2 migration: a legacy run that already entered polishing has passed its gate.
      // Do not revive the old self-refilling suggestion loop after restart.
      if (state.phase === 'polishing' && !config.polish.enabled) {
        state.phase = 'reaching';
        state.status = 'done';
        state.suggestionPool = [];
      }

      const stepConfigs = Array.isArray(wf.stepConfigs) ? wf.stepConfigs : [];
      const builderRolePrompt = (stepConfigs[0] && stepConfigs[0].prompt) || '';
      const reviewerRolePrompt = (stepConfigs[1] && stepConfigs[1].prompt) || '';
      const builderTimeoutMs = Math.max(60_000, Math.min(30 * 60_000,
        Number(stepConfigs[0] && stepConfigs[0].timeoutMs) || 10 * 60_000));
      const reviewerTimeoutMs = Math.max(60_000, Math.min(30 * 60_000,
        Number(stepConfigs[1] && stepConfigs[1].timeoutMs) || 5 * 60_000));

      const dispatcher = getDispatcher();
      const progress = (extra) => {
        try { sendToRenderer('loop:progress', Object.assign({ meetingId, round: state.round, phase: state.phase, status: state.status }, extra || {})); }
        catch (error) { logError('[loop-engine] progress delivery failed:', error); }
      };
      const persistOrPause = () => {
        if (persist(meetingId, state, config)) return true;
        state.status = 'paused';
        state.lastError = { stage: 'persist', reason: 'workflow_state_persist_failed', at: Date.now() };
        progress({ stage: 'paused', error: state.lastError });
        return false;
      };
      logger.log('[loop-engine] ' + (resuming ? 'resume' : 'start') + ' meeting=' + meetingId + ' round=' + state.round + ' goal=' + goal);
      if (!persistOrPause()) return state;
      progress({ stage: 'start' });

      while (state.status === 'running') {
        if (entry.abort) { state.status = 'stopped_user'; break; }
        if (state.round > config.stop.maxRounds + 2) { state.status = 'stopped_max'; break; } // 本地兜底

        const taskInfo = LC.builderTaskText(state, prevMerge, config);
        const builderPrompt = LC.PROMPTS.builder({ goal, cwd: config.cwd, firstRound: taskInfo.firstRound, phase: taskInfo.phase, taskText: taskInfo.taskText, rolePrompt: builderRolePrompt });
        state.currentStep = 'builder'; state.attempt = state.round + 1; state.lastError = null;
        if (!persistOrPause()) break;
        progress({ stage: 'builder', round: state.round + 1 });
        let bRes = null;
        const builderStepIndex = state.round * 2;
        const builderEvidence = stepEvidence(meetingId, state.runId, builderStepIndex);
        if (builderEvidence && evidenceIsSuccessful(builderEvidence, 1)) {
          bRes = dispatchResultFromEvidence(meeting, [builderId], builderEvidence);
          state.currentTurnNum = bRes.turnNum;
          progress({ stage: 'builder-recovered', round: state.round + 1 });
        } else {
          if (!state.currentTurnNum) state.currentTurnNum = pendingStepTurn(meetingId, state.runId, builderStepIndex) || null;
          for (let transportAttempt = Math.max(0, Number(state.stepAttempt) || 0) + 1; transportAttempt <= 2; transportAttempt += 1) {
            state.stepAttempt = transportAttempt;
            if (!persistOrPause()) break;
            try {
              await ensureMemberReady(meeting, builderId);
              bRes = await dispatcher.dispatchGroupChatTurn(meetingId, {
                userInput: builderPrompt,
                targetMemberIds: [builderId],
                reuseTurnNum: state.currentTurnNum || null,
                appendUserMessage: !state.currentTurnNum,
                dispatchMode: 'serial',
                turnTimeoutMs: builderTimeoutMs,
                allowActiveExtend: false,
                heroIdBySid: runOptions.heroIdBySid || {},
                workflowRun: { runId: state.runId, kind: 'loop', stepIndex: builderStepIndex, attempt: transportAttempt, targetMemberIds: [builderId] },
              });
              if (bRes && bRes.turnNum) state.currentTurnNum = bRes.turnNum;
              const checked = validateStepResult(meeting, [builderId], bRes);
              if (checked.takenOver) break;
              if (checked.ok) break;
              state.lastError = { stage: 'builder', reason: checked.reason, attempt: transportAttempt, at: Date.now() };
            } catch (e) {
              state.lastError = { stage: 'builder', reason: (e && e.message) || 'builder_error', attempt: transportAttempt, at: Date.now() };
              logError('[loop-engine] builder turn failed:', e);
            }
            if (!persistOrPause()) break;
            if (transportAttempt < 2 && !entry.abort) {
              progress({ stage: 'builder-retry', round: state.round + 1, attempt: transportAttempt, error: state.lastError });
              await sleep(500);
            }
          }
        }
        const builderChecked = validateStepResult(meeting, [builderId], bRes);
        if (!builderChecked.ok && !builderChecked.takenOver) {
          state.status = 'paused';
          state.lastError = state.lastError || { stage: 'builder', reason: builderChecked.reason, at: Date.now() };
          logger.log('[loop-engine] builder not completed: ' + state.lastError.reason); break;
        }
        // 运行中被用户接管（2026-07-29 道雪）：用户点「停止本轮」(interrupted) 或直接
        //   追问下一题把本步抢占掉 (superseded) —— 语义明确定为「中断整个循环」，不是
        //   「排到下一步」：后续步骤的 prompt 依赖本步产出，本步已经作废，再往下跑只会
        //   拿空结果编排出垃圾。用户接管后由用户自己决定要不要重启循环。
        if (bRes.interrupted || bRes.superseded) {
          state.status = 'stopped_user';
          state.currentStep = null;
          logger.log('[loop-engine] builder turn taken over by user (' + (bRes.interrupted ? 'interrupted' : 'superseded') + '), stopping loop');
          break;
        }
        const turnNum = bRes.turnNum;
        state.currentTurnNum = turnNum;
        state.stepAttempt = 0;

        // 工作位这一步也可能被 idle timer 提前结算（它跑测试时转录同样是静默的）。
        // 不等它把 PROGRESS 交出来就派审查，评审看到的会是还在改的半成品分支。
        //
        // 但这里的等待预算比评审那边小一个量级，理由是两边的性质不同：
        //   评审的裁决是闸门必需品，拿不到就没法判 —— 值得等满。
        //   工作位的 PROGRESS 只是给人看的汇报，缺了不影响流程正确性 ——
        //   万一它就是没按合同输出，不该让每一轮都白等一分钟。
        // 10 秒足以跨过一次工具调用造成的静默，这才是这个等待真正要解决的问题。
        await awaitStepText(meetingId, turnNum, sidOf(meeting, builderId),
          textFrom(bRes.results, sidOf(meeting, builderId)), hasProgressCard,
          { isAborted: () => !!entry.abort, quietMs: BUILDER_QUIET_MS, capMs: BUILDER_WAIT_CAP_MS });

        const reviewerPrompt = LC.PROMPTS.reviewer({ goal, cwd: config.cwd, rolePrompt: reviewerRolePrompt });
        state.currentStep = 'reviewer'; state.lastError = null;
        if (!persistOrPause()) break;
        progress({ stage: 'reviewer', round: state.round + 1 });
        let rRes = null;
        const reviewerStepIndex = state.round * 2 + 1;
        const reviewerEvidence = stepEvidence(meetingId, state.runId, reviewerStepIndex);
        if (reviewerEvidence && evidenceIsSuccessful(reviewerEvidence, reviewerIds.length)) {
          rRes = dispatchResultFromEvidence(meeting, reviewerIds, reviewerEvidence);
          progress({ stage: 'reviewer-recovered', round: state.round + 1 });
        } else {
          for (let transportAttempt = Math.max(0, Number(state.stepAttempt) || 0) + 1; transportAttempt <= 2; transportAttempt += 1) {
            state.stepAttempt = transportAttempt;
            if (!persistOrPause()) break;
            try {
              for (const rid of reviewerIds) await ensureMemberReady(meeting, rid);
              rRes = await dispatcher.dispatchGroupChatTurn(meetingId, {
                userInput: reviewerPrompt,
                targetMemberIds: reviewerIds,
                reuseTurnNum: turnNum,
                appendUserMessage: false,
                dispatchMode: 'serial',
                turnTimeoutMs: reviewerTimeoutMs,
                allowActiveExtend: false,
                heroIdBySid: runOptions.heroIdBySid || {},
                workflowRun: { runId: state.runId, kind: 'loop', stepIndex: reviewerStepIndex, attempt: transportAttempt, targetMemberIds: reviewerIds },
              });
              const checked = validateStepResult(meeting, reviewerIds, rRes);
              if (checked.takenOver) break;
              if (checked.ok) break;
              state.lastError = { stage: 'reviewer', reason: checked.reason, attempt: transportAttempt, at: Date.now() };
            } catch (e) {
              state.lastError = { stage: 'reviewer', reason: (e && e.message) || 'reviewer_error', attempt: transportAttempt, at: Date.now() };
              logError('[loop-engine] reviewer turn failed:', e);
            }
            if (!persistOrPause()) break;
            if (transportAttempt < 2 && !entry.abort) {
              progress({ stage: 'reviewer-retry', round: state.round + 1, attempt: transportAttempt, error: state.lastError });
              await sleep(500);
            }
          }
        }
        const reviewerChecked = validateStepResult(meeting, reviewerIds, rRes);
        if (!reviewerChecked.ok && !reviewerChecked.takenOver) {
          state.status = 'paused';
          state.lastError = state.lastError || { stage: 'reviewer', reason: reviewerChecked.reason, at: Date.now() };
          logger.log('[loop-engine] reviewer not completed: ' + state.lastError.reason); break;
        }
        // 同 builder：评审步被中断/被新提问抢占 → 停整个循环，不拿空 verdict 推进 gate。
        if (rRes.interrupted || rRes.superseded) {
          state.status = 'stopped_user';
          state.currentStep = null;
          logger.log('[loop-engine] reviewer turn taken over by user (' + (rRes.interrupted ? 'interrupted' : 'superseded') + '), stopping loop');
          break;
        }

        // 结算文本可能是 idle timer 提前触发时抓到的开场白（见上方 awaitVerdictText 注释）。
        // 判裁决前先等文本真的不再增长，避免把「还在验证」误读成「没给裁决」。
        const verdictTurnNum = rRes.turnNum || turnNum;
        const reviews = [];
        for (const rid of reviewerIds) {
          const sid = sidOf(meeting, rid);
          const raw = await awaitVerdictText(meetingId, verdictTurnNum, sid, textFrom(rRes.results, sid), {
            isAborted: () => !!entry.abort,
          });
          reviews.push({ from: labelOf(meeting, rid), verdict: LC.parseVerdict(raw), raw });
        }
        const merge = LC.mergeVerdicts(reviews); prevMerge = merge;
        LC.advanceLoopState(state, merge, config, Date.now());
        state.currentStep = null; state.currentTurnNum = null; state.stepAttempt = 0; state.lastError = null;
        logger.log('[loop-engine] round=' + state.round + ' phase=' + state.phase + ' pass=' + merge.pass + ' status=' + state.status);
        if (!persistOrPause()) break;
        progress({ stage: 'advanced' });
      }

      persistOrPause();
      try {
        const html = LC.buildReportHtml(goal, state, config, { builderLabel: labelOf(meeting, builderId), reviewerLabels: reviewerIds.map((r) => labelOf(meeting, r)).join('+'), finishedAt: formatBeijingDateTime(Date.now()) });
        const p = writeReport(html); if (p) logger.log('[loop-engine] report → ' + p);
      } catch (e) { logger.log('[loop-engine] report err: ' + (e && e.message)); }
      progress({ stage: state.status === 'paused' ? (state.currentStep || 'paused') : 'done', status: state.status, error: state.lastError || null });
      logger.log('[loop-engine] finished ' + meetingId + ' status=' + state.status + ' rounds=' + state.round);
      return state;
    } catch (error) {
      logError('[loop-engine] unhandled runtime failure:', error);
      if (!state) {
        return { status: 'paused', lastError: { stage: 'loop-engine', reason: error && error.message || 'internal_error', at: Date.now() } };
      }
      state.status = entry && entry.abort ? 'stopped_user' : 'paused';
      state.lastError = { stage: 'loop-engine', reason: error && error.message || 'internal_error', at: Date.now() };
      if (config) persist(meetingId, state, config);
      try { sendToRenderer('loop:progress', { meetingId, round: state.round, phase: state.phase, status: state.status, stage: state.status, error: state.lastError }); }
      catch (progressError) { logError('[loop-engine] fatal progress delivery failed:', progressError); }
      return state;
    } finally {
      if (entry && running.get(meetingId) === entry) running.delete(meetingId);
    }
  }

  function stopLoop(meetingId, options = {}) {
    const r = running.get(meetingId);
    if (!r) return false;
    r.abort = true;
    if (options.interrupt !== false) {
      try { getDispatcher().interruptMeetingTurn(meetingId, { reason: 'workflow_stop' }); }
      catch (error) { logError('[workflow-engine] interrupt on stop failed:', error); }
    }
    return true;
  }
  function isRunning(meetingId) { return running.has(meetingId); }
  function getStatus(meetingId) {
    const active = running.get(meetingId);
    if (active) return { running: true, mode: active.mode, runId: active.runId, startedAt: active.startedAt };
    const meeting = meetingManager.getMeeting(meetingId);
    const workflow = meeting && meeting.serialWorkflow || {};
    return {
      running: false,
      serialRunState: workflow.serialRunState || null,
      loopState: workflow.loopState || null,
    };
  }

  // Hub boot：扫描所有 meeting，未完成的循环自动续跑
  function resumePending() {
    try {
      const all = (meetingManager.getAllMeetings && meetingManager.getAllMeetings()) || [];
      for (const mt of all) {
        const sw = mt && mt.serialWorkflow; const ls = sw && sw.loopState;
        const serialState = sw && sw.serialRunState;
        if (sw && sw.enabled && !(sw.loop && sw.loop.enabled)
          && serialState && serialState.status === 'running') {
          // 循环工作流有 deadlineTs 兜底，串行没有。没有年龄下限的话，几天前被打断的
          //   一次串行会在下次开 Hub 时静默地重新向 CLI 发指令。超龄的留给用户手点
          //   serial:resume（IPC 已存在），不在启动时自作主张。
          const idleMs = Date.now() - (Number(serialState.updatedAt) || Number(serialState.startedAt) || 0);
          if (idleMs > SERIAL_BOOT_RESUME_MAX_IDLE_MS) {
            logger.log('[workflow-engine] skip stale serial resume for ' + mt.id
              + ' (idle ' + Math.round(idleMs / 3600000) + 'h); use serial:resume to continue manually');
            continue;
          }
          logger.log('[workflow-engine] boot resume serial ' + mt.id + ' from step ' + serialState.nextStepIndex);
          runSerial(mt.id, null, serialState).catch(error => logError('[workflow-engine] boot serial resume failed:', error));
        } else if (sw && sw.loop && sw.loop.enabled && ls && ls.status === 'running' && !(ls.deadlineTs && Date.now() >= ls.deadlineTs)) {
          logger.log('[loop-engine] boot resume ' + mt.id + ' from round ' + ls.round);
          runLoop(mt.id, null, ls).catch(error => logError('[loop-engine] boot loop resume failed:', error)); // 不 await，后台续跑
        }
      }
    } catch (e) { logger.log('[loop-engine] resumePending err: ' + (e && e.message)); }
  }

  return {
    getStatus, isRunning, resumePending, runLoop, runSerial, stopLoop, validateLoop, validateSerial,
    // 仅供单测：裁决取文本这条路径是「代码合对了但引擎判失败」的根因所在，
    // 必须能脱离真实 CLI 会话单独验证。见 unit-loop-verdict-capture.test.js。
    __test: { awaitVerdictText, awaitStepText, hasVerdict, hasProgressCard,
              persistedTurnText, bestTextSoFar, VERDICT_QUIET_MS, VERDICT_WAIT_CAP_MS },
  };
}

module.exports = { createLoopEngine };
