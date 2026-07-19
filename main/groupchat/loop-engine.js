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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createLoopEngine(deps) {
  const {
    getDispatcher, meetingManager, sessionManager,
    sendToRenderer = () => {}, writeReport = () => null, logger = console,
  } = deps || {};
  const running = new Map(); // meetingId → { abort: bool }

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

  // 进阶①：dormant 成员唤醒（createSession 复用 id + 轮询非 dormant）。简化版：不等 cli-ready，给固定窗口。
  async function ensureMemberReady(meeting, memberId) {
    try {
      const sid = sidOf(meeting, memberId);
      if (!sid || !sessionManager) return;
      const s = sessionManager.getSession(sid);
      if (s && s.status === 'dormant') {
        logger.log('[loop-engine] waking dormant member', sid);
        try { sessionManager.createSession(s.kind, { id: sid, title: s.title }); } catch (e) {}
        for (let i = 0; i < 30; i++) {
          const ss = sessionManager.getSession(sid);
          if (ss && ss.status !== 'dormant') break;
          await sleep(1000);
        }
      }
    } catch (e) { logger.log('[loop-engine] ensureMemberReady err: ' + (e && e.message)); }
  }

  function buildConfig(loopCfg) {
    const c = LC.defaultConfig();
    c.gate = { consecutivePass: (loopCfg && loopCfg.consecutivePass) || 1 };
    c.polish = { enabled: !(loopCfg && loopCfg.polish === false) };
    c.stop = {
      maxRounds: (loopCfg && loopCfg.maxRounds) || 8,
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
            goal: state.goal, status: state.status, phase: state.phase, round: state.round,
            consecutiveGreen: state.consecutiveGreen, suggestionPool: state.suggestionPool,
            history: state.history, _lastBlockerSig: state._lastBlockerSig, _noProgress: state._noProgress,
            deadlineTs: config.stop.deadlineTs, driver: 'main',
          },
        }),
      });
    } catch (e) { logger.log('[loop-engine] persist err: ' + (e && e.message)); }
  }

  async function runLoop(meetingId, userInput, persistedLoopState, runContext = {}) {
    if (running.has(meetingId)) { logger.log('[loop-engine] already running for ' + meetingId); return null; }
    running.set(meetingId, { abort: false });
    try {
      const meeting = meetingManager.getMeeting(meetingId);
      if (!meeting) { logger.log('[loop-engine] meeting not found ' + meetingId); return null; }
      const wf = meeting.serialWorkflow || {};
      const steps = Array.isArray(wf.steps) ? wf.steps : [];
      const builderId = (steps[0] || [])[0];
      const reviewerIds = Array.from(new Set([].concat(...steps.slice(1)).filter(Boolean)));
      if (!builderId || !reviewerIds.length) { logger.log('[loop-engine] need builder + reviewer(s)'); return null; }
      const config = buildConfig(wf.loop);

      let state, prevMerge = null, goal, resuming = false;
      if (persistedLoopState && persistedLoopState.status === 'running') {
        const r = LC.resumeState(persistedLoopState); state = r.state; prevMerge = r.prevMerge; goal = state.goal || (userInput || '').trim(); resuming = true;
      } else { goal = (userInput || '').trim(); state = LC.newLoopState(); state.goal = goal; }

      const dispatcher = getDispatcher();
      const clientGeneration = Number.isInteger(Number(runContext.clientGeneration))
        ? Number(runContext.clientGeneration)
        : undefined;
      const progress = (extra) => { try { sendToRenderer('loop:progress', Object.assign({ meetingId, clientGeneration, round: state.round, phase: state.phase, status: state.status }, extra || {})); } catch (e) {} };
      logger.log('[loop-engine] ' + (resuming ? 'resume' : 'start') + ' meeting=' + meetingId + ' round=' + state.round + ' goal=' + goal);
      persist(meetingId, state, config); progress({ stage: 'start' });

      while (state.status === 'running') {
        if (running.get(meetingId) && running.get(meetingId).abort) { state.status = 'stopped_user'; break; }
        if (state.round > config.stop.maxRounds + 2) { state.status = 'stopped_max'; break; } // 本地兜底

        const taskInfo = LC.builderTaskText(state, prevMerge, config);
        const builderPrompt = LC.PROMPTS.builder({ goal, cwd: config.cwd, firstRound: taskInfo.firstRound, phase: taskInfo.phase, taskText: taskInfo.taskText });
        await ensureMemberReady(meeting, builderId);
        progress({ stage: 'builder', round: state.round + 1 });
        let bRes;
        try { bRes = await dispatcher.dispatchGroupChatTurn(meetingId, { userInput: builderPrompt, targetMemberIds: [builderId], reuseTurnNum: null, appendUserMessage: true, dispatchMode: 'serial', clientGeneration }); }
        catch (e) { state.status = 'stopped_error'; logger.log('[loop-engine] builder turn err: ' + (e && e.message)); break; }
        if (bRes && bRes.superseded) {
          state.status = 'stopped_superseded';
          logger.log('[loop-engine] builder turn superseded by a newer user send');
          break;
        }
        if (!bRes || bRes.status !== 'completed') {
          state.status = (bRes && bRes.status === 'interrupted') || (running.get(meetingId) && running.get(meetingId).abort)
            ? 'stopped_user' : 'stopped_error';
          logger.log('[loop-engine] builder not completed: ' + (bRes && bRes.status));
          break;
        }
        const turnNum = bRes.turnNum;

        const reviewerPrompt = LC.PROMPTS.reviewer({ goal, cwd: config.cwd });
        for (const rid of reviewerIds) await ensureMemberReady(meeting, rid);
        progress({ stage: 'reviewer', round: state.round + 1 });
        let rRes;
        try { rRes = await dispatcher.dispatchGroupChatTurn(meetingId, { userInput: reviewerPrompt, targetMemberIds: reviewerIds, reuseTurnNum: turnNum, appendUserMessage: false, dispatchMode: 'serial', clientGeneration }); }
        catch (e) { state.status = 'stopped_error'; logger.log('[loop-engine] reviewer turn err: ' + (e && e.message)); break; }
        if (rRes && rRes.superseded) {
          state.status = 'stopped_superseded';
          logger.log('[loop-engine] reviewer turn superseded by a newer user send');
          break;
        }
        if (!rRes || rRes.status !== 'completed') {
          state.status = (rRes && rRes.status === 'interrupted') || (running.get(meetingId) && running.get(meetingId).abort)
            ? 'stopped_user' : 'stopped_error';
          logger.log('[loop-engine] reviewer not completed: ' + (rRes && rRes.status));
          break;
        }

        const reviews = reviewerIds.map((rid) => { const sid = sidOf(meeting, rid); return { from: labelOf(meeting, rid), verdict: LC.parseVerdict(textFrom(rRes.results, sid)), raw: textFrom(rRes.results, sid) }; });
        const merge = LC.mergeVerdicts(reviews); prevMerge = merge;
        LC.advanceLoopState(state, merge, config, Date.now());
        logger.log('[loop-engine] round=' + state.round + ' phase=' + state.phase + ' pass=' + merge.pass + ' status=' + state.status);
        persist(meetingId, state, config); progress({ stage: 'advanced' });
      }

      persist(meetingId, state, config);
      try {
        const html = LC.buildReportHtml(goal, state, config, { builderLabel: labelOf(meeting, builderId), reviewerLabels: reviewerIds.map((r) => labelOf(meeting, r)).join('+'), finishedAt: new Date().toLocaleString() });
        const p = writeReport(html); if (p) logger.log('[loop-engine] report → ' + p);
      } catch (e) { logger.log('[loop-engine] report err: ' + (e && e.message)); }
      progress({ stage: 'done', status: state.status });
      logger.log('[loop-engine] finished ' + meetingId + ' status=' + state.status + ' rounds=' + state.round);
      return state;
    } finally {
      running.delete(meetingId);
    }
  }

  function stopLoop(meetingId) { const r = running.get(meetingId); if (r) { r.abort = true; return true; } return false; }
  function isRunning(meetingId) { return running.has(meetingId); }

  // Hub boot：扫描所有 meeting，未完成的循环自动续跑
  function resumePending() {
    try {
      const all = (meetingManager.getAllMeetings && meetingManager.getAllMeetings()) || [];
      for (const mt of all) {
        const sw = mt && mt.serialWorkflow; const ls = sw && sw.loopState;
        if (sw && sw.loop && sw.loop.enabled && ls && ls.status === 'running' && !(ls.deadlineTs && Date.now() >= ls.deadlineTs)) {
          logger.log('[loop-engine] boot resume ' + mt.id + ' from round ' + ls.round);
          runLoop(mt.id, null, ls).catch((e) => logger.log('[loop-engine] boot resume rejected: ' + (e && e.message))); // 不 await，后台续跑
        }
      }
    } catch (e) { logger.log('[loop-engine] resumePending err: ' + (e && e.message)); }
  }

  return { runLoop, stopLoop, isRunning, resumePending };
}

module.exports = { createLoopEngine };
