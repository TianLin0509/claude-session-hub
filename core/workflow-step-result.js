'use strict';
/**
 * 「这一步现在到底有没有可用回答？」—— 工作流步骤结果的唯一判据（纯函数，不碰 IO）。
 *
 * 2026-09-07 维护者报的现象：agent 中途断了、后来自己好了并且答完了，用户点「重提」
 * 把答案同步进群聊，再点状态栏那个「已暂停 · 继续」，**同一个 agent 又被问了一遍**。
 *
 * 根因不是恢复入口写错了，是**两份证据不一致**：
 *   - `loop-engine.evidenceIsSuccessful()` 读 `turn.meta.workflowSteps[].results`
 *     —— 那是结算那一刻拍下的**快照**，之后永不更新；
 *   - `loop-engine.dispatchResultFromEvidence()` 取正文却读 `turn.by[sid]`
 *     —— 那是**活状态**，重提/手动粘贴写的正是这里。
 * 而重提的写入口 `orchestrator.patchTurnResult()` 只更新活状态，从不回头改快照。
 * 于是答案就摆在旁边，闸门没往那儿看，判「这一步没成功」→ 重新派发。
 *
 * 修法是**收敛到一个数据源**，而不是双写快照。双写只会制造第二次分叉，
 * 而第一次分叉正是这么来的。所以：
 *   快照只用来**定位**（runId + stepIndex 是身份，这部分它是对的）；
 *   活状态用来**判定**（有没有可用回答）。本模块就是那个判定。
 *
 * 判断逻辑全部放这里、引擎和 UI 共用同一个函数，是为了不再出现
 * 「卡片说好了、流程说没好」这种两套说法。
 */

// 能被当成「这一席位交货了」的状态。
//   completed        provider 自己宣布完成
//   manual_extracted 用户点「同步回答」，Hub 从转录里读回来
//   manual_paste     用户直接把 CLI 里的正文粘进来（人就是判据）
// 三种来源、同一个终点，这是「一个结果入口」在数据层的体现。
const ADOPTED_STATUSES = new Set(['completed', 'manual_extracted', 'manual_paste']);

// 明确表示「这一席位没交货」的状态。列出来只为可读，判定一律走白名单。
const UNUSABLE_STATUSES = new Set(['errored', 'failed', 'absent', 'interrupted', 'superseded', 'timeout']);

function normalizeStatus(status) {
  return status == null ? '' : String(status).trim();
}

/** 老数据可能没有 status 字段：有正文就按完成算，这与 loop-engine 既有的宽松判据一致。 */
function isAdoptedStatus(status) {
  const value = normalizeStatus(status);
  if (!value) return true;
  return ADOPTED_STATUSES.has(value);
}

function textOf(value) {
  return String(value == null ? '' : value);
}

/**
 * 从**活状态**里取某个席位这一轮的结果。
 * turn 优先（全员结算后才有 turn）；turn 还没建时退回消息列表 ——
 * 中断轮只有 u{n} 和零散的 assistant 消息，`patchTurnResult` 的 pending 分支正是写在那里。
 */
function liveResultFor({ turn, messages, turnNum, sid } = {}) {
  const by = (turn && turn.by) || null;
  const byStatus = (turn && turn.byStatus) || {};
  if (by && Object.prototype.hasOwnProperty.call(by, sid)) {
    const text = textOf(by[sid]);
    return { sid, status: normalizeStatus(byStatus[sid]) || null, text, textLength: text.trim().length };
  }
  const list = Array.isArray(messages) ? messages : [];
  const msg = list.find(m => m
    && m.role === 'assistant'
    && m.sid === sid
    && (turnNum == null || Number(m.turnNum) === Number(turnNum)));
  if (!msg) return { sid, status: null, text: '', textLength: 0 };
  const text = textOf(msg.content);
  return { sid, status: normalizeStatus(msg.status) || null, text, textLength: text.trim().length };
}

function resultIsUsable(result) {
  return !!(result && result.textLength > 0 && isAdoptedStatus(result.status));
}

/**
 * 这份活结果是**什么时候**写进去的。
 * patchTurnResult（重提 / 手动粘贴的写入口）每次都会盖 patchedAt；
 * completeTurn 则会更新 turn.lastUpdatedAt。用它和步骤的结算时刻比大小，
 * 就能判断「这段正文是不是这一步结算之后才补进来的」。
 */
function liveWrittenAt({ turn, messages, turnNum, sid } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const msg = list.find(m => m
    && m.role === 'assistant'
    && m.sid === sid
    && (turnNum == null || Number(m.turnNum) === Number(turnNum)));
  const candidates = [
    msg && msg.patchedAt,
    turn && turn.lastPatchedAt,
    turn && turn.lastUpdatedAt,
  ].map(Number).filter(v => Number.isFinite(v) && v > 0);
  return candidates.length ? Math.max(...candidates) : 0;
}

/**
 * 这一步的成交盘点 —— **带步骤身份**。
 *
 * 2026-09-07 合并位 B3：只按 turnNum + sid 判「这位答过了」是不够的。
 * 串行工作流的所有步骤复用同一个可见 turn，而 turn.by 只按 sid 存；于是
 * A1 → A2 → A1 这种流程里，第三步会把第一步 A1 的正文当成自己的答案，
 * 直接被记成 recovered 跳过 —— 第三步「根据评审修订」根本没跑。
 *
 * 所以判据必须锚在**这一步自己的记录**上（stepEntry，即 workflowSteps 里
 * runId + stepIndex 那一条）：
 *   ① 这一条自己就记着这位成功了            → 成交（这就是老判据，保持不变）
 *   ② 这一条记着这位失败，但活状态现在有可用正文，
 *      且那段正文是**这一步结算之后**才写进去的 → 成交（人后来补的）
 *   ③ 压根没有这一条 / 这一条里没有这位     → 不成交
 * ③ 是关键：这一步从没为这位跑过，就绝不能拿别的步骤的答案顶上。
 *
 * 不传 stepEntry 时退回「只看活状态」的宽松判据 —— 那是给状态栏这类
 * 没有步骤上下文的只读展示用的，引擎一律要传。
 */
/**
 * 尝试台账里属于「这一步、这一位」的那条记录。
 * recordTurnPrompt 在派发那一刻就把 workflowRun{runId, stepIndex} 写进 attempt，
 * 而三种采用来源（自动完成 / 重提 / 粘贴）都经 settleAttempt 更新它的 status 与
 * resultTextLength。所以它同时带着**步骤身份**和**最新状态**，是最可靠的归属来源。
 */
function stepAttemptFor(attempts, { runId, stepIndex, sid } = {}) {
  const all = attempts && typeof attempts === 'object' ? Object.values(attempts) : [];
  const rank = x => Number(x && (x.updatedAt || x.createdAt || x.dispatchAt)) || 0;
  const mine = all.filter(a => a
    && a.sid === sid
    && a.workflowRun
    && String(a.workflowRun.runId) === String(runId)
    && Number(a.workflowRun.stepIndex) === Number(stepIndex));
  if (!mine.length) return null;
  return mine.reduce((best, a) => (best === null || rank(a) >= rank(best) ? a : best), null);
}

function inspectStepResults({
  turn, messages, turnNum, targetSids, stepEntry, attempts, runId, stepIndex,
  requireStepIdentity = false,
} = {}) {
  const sids = (Array.isArray(targetSids) ? targetSids : []).filter(Boolean);
  const snapshotResults = (stepEntry && Array.isArray(stepEntry.results)) ? stepEntry.results : null;
  const settledAt = Number(stepEntry && stepEntry.completedAt) || 0;
  const canUseLedger = !!(attempts && runId != null && stepIndex != null);
  const results = sids.map(sid => {
    const live = liveResultFor({ turn, messages, turnNum, sid });
    if (!requireStepIdentity) return live;
    // ① 台账优先。这一步这一位有自己的 attempt，它说了算 —— 而 A1 → A2 → A1 的
    //    第三步压根找不到自己的 attempt，也就不会拿第一步的答案顶上。
    if (canUseLedger) {
      const attempt = stepAttemptFor(attempts, { runId, stepIndex, sid });
      if (attempt) {
        const ok = isAdoptedStatus(attempt.status) && Number(attempt.resultTextLength) > 0;
        return { ...live, stepAttributed: ok, why: ok ? undefined : 'step_attempt_not_settled_with_text' };
      }
    }
    // ② 退回快照。老数据的 attempt 没有 workflowRun，只能靠这一步自己那条记录。
    const snap = snapshotResults ? snapshotResults.find(r => r && r.sid === sid) : null;
    const snapOk = !!(snap && isAdoptedStatus(snap.status) && Number(snap.textLength) > 0);
    if (snapOk) return { ...live, stepAttributed: true };
    if (!snap) return { ...live, stepAttributed: false, why: 'step_never_ran_for_member' };
    const writtenAt = liveWrittenAt({ turn, messages, turnNum, sid });
    const adoptedAfterSettle = resultIsUsable(live) && writtenAt > 0 && writtenAt >= settledAt;
    return { ...live, stepAttributed: adoptedAfterSettle, why: adoptedAfterSettle ? undefined : 'live_result_predates_step' };
  });
  const usable = r => resultIsUsable(r) && (!requireStepIdentity || r.stepAttributed === true);
  const missingSids = results.filter(r => !usable(r)).map(r => r.sid);
  return {
    total: sids.length,
    results,
    missingSids,
    // 全员都有可用回答才算这一步成交。少一个都不算 —— 否则评审只答了一个人
    // 也会被当成审完了，那是把「没审」伪装成「审过」。
    complete: sids.length > 0 && missingSids.length === 0,
    partial: missingSids.length > 0 && missingSids.length < sids.length,
  };
}

/**
 * 「同步回答」按下去会发生什么 —— 状态栏文案与引擎行为共用这一个判据。
 *
 * 刻意**不返回 redispatch**：重发是有副作用的动作，只能由那个明确写着
 * 「重新让本成员回答」的入口发起。同步永远不发 prompt。
 */
function decideResumeAction({
  turn, messages, turnNum, targetSids, stepEntry, attempts, runId, stepIndex,
  requireStepIdentity = false, stopped = false, discussing = false,
} = {}) {
  if (stopped) return { action: 'blocked', why: 'user_stopped', missingSids: [] };
  if (discussing) return { action: 'blocked', why: 'discussing', missingSids: [] };
  const view = inspectStepResults({
    turn, messages, turnNum, targetSids, stepEntry, attempts, runId, stepIndex, requireStepIdentity,
  });
  if (!view.total) return { action: 'wait', why: 'no_target', missingSids: [], view };
  if (view.complete) return { action: 'advance', why: 'all_results_present', missingSids: [], view };
  return {
    action: 'wait',
    why: view.partial ? 'partial_results' : 'no_result_yet',
    missingSids: view.missingSids,
    view,
  };
}

/**
 * 状态栏那个 chip 的文案。今天它直读 loopState.status，是出事那一刻写下的字，
 * 后来收到答案也不会变 —— 用户看到「已暂停」，不知道点下去是推进还是重跑。
 * 改成从同一个判据派生，标签和行为就不可能再对不上。
 */
function describeResumeAction(decision, { stepLabel = '当前步骤', nextLabel = '' } = {}) {
  if (!decision) return { tone: 'warn', label: '已暂停 · 继续', hint: '' };
  if (decision.action === 'blocked') {
    return decision.why === 'user_stopped'
      ? { tone: '', label: '已停止', hint: '你已经停止过这条流程，不会再自动推进' }
      : { tone: '', label: '讨论中不可恢复', hint: '回到实现阶段后才能继续' };
  }
  if (decision.action === 'advance') {
    return {
      tone: 'ok',
      label: '可继续 · 已收到回答',
      hint: `${stepLabel}已有全部回答，点击后直接${nextLabel ? `交给${nextLabel}` : '进入下一步'}，不会再问一遍`,
    };
  }
  const missing = Array.isArray(decision.missingSids) ? decision.missingSids.length : 0;
  return {
    tone: 'warn',
    label: '同步回答',
    hint: missing > 0
      ? `${stepLabel}还差 ${missing} 位的回答；点击只会再找一次，找不到就继续等，可用「手动粘贴」直接给`
      : `${stepLabel}还没有可用回答；点击只会再找一次，不会重发`,
  };
}

/**
 * 手动粘贴弹窗的「过期」判定。
 * 弹窗打开那一刻绑定任务/步骤/席位/结果版本；提交时拿当前状态再核一次。
 * 目的只有一个：A1 的弹窗还开着、流程已经自动走到 A2 了，那段正文不许灌进 A2。
 */
function validateAdoptionToken(token, current) {
  const t = token || {};
  const c = current || {};
  if (!t.meetingId || String(t.meetingId) !== String(c.meetingId || '')) {
    return { ok: false, reason: 'meeting_mismatch' };
  }
  if (!t.sid || String(t.sid) !== String(c.sid || '')) {
    return { ok: false, reason: 'member_mismatch' };
  }
  if (c.stopped === true) return { ok: false, reason: 'user_stopped' };
  if (t.runId && c.runId && String(t.runId) !== String(c.runId)) {
    return { ok: false, reason: 'run_superseded' };
  }
  if (t.turnNum != null && c.turnNum != null && Number(t.turnNum) !== Number(c.turnNum)) {
    return { ok: false, reason: 'turn_advanced' };
  }
  if (t.stepIndex != null && c.stepIndex != null && Number(t.stepIndex) !== Number(c.stepIndex)) {
    return { ok: false, reason: 'step_advanced' };
  }
  // 这一席位在弹窗打开之后已经有可用回答了 —— 自动完成、或者另一条来源先到。
  // 不覆盖、不重启；正文交回给用户，由他决定要不要另行处理。
  if (c.alreadyAdopted === true) return { ok: false, reason: 'already_adopted' };
  return { ok: true };
}

function describeAdoptionRejection(reason) {
  const map = {
    meeting_mismatch: '这个窗口属于另一条群聊，已失效',
    member_mismatch: '这个窗口绑定的成员和当前步骤对不上，已失效',
    user_stopped: '流程已被你停止，不再采用新回答',
    run_superseded: '这条任务已经被新的任务取代，窗口内容不会被采用',
    turn_advanced: '流程已经推进到新的一轮，这段正文不会灌进新步骤',
    step_advanced: '流程已经推进到下一步，这段正文不会灌进新步骤',
    already_adopted: '本步已经有回答了，不覆盖也不重启',
    empty_text: '正文是空的，没有采用',
  };
  return map[reason] || '窗口已失效，未采用';
}

module.exports = {
  ADOPTED_STATUSES,
  UNUSABLE_STATUSES,
  isAdoptedStatus,
  liveResultFor,
  liveWrittenAt,
  stepAttemptFor,
  resultIsUsable,
  inspectStepResults,
  decideResumeAction,
  describeResumeAction,
  validateAdoptionToken,
  describeAdoptionRejection,
};
