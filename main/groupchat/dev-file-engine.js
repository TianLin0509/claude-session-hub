'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const F = require('../../core/dev-file-workflow');
const Settings = require('../../core/workflow-settings');

function createDevFileEngine({ meetingManager, sessionManager, getHubDataDir, getDispatcher, ensureMemberReady, getMembers, isWorkflowRunning = () => false,
  sendToRenderer = () => {}, onChanged = () => {}, logger = console }) {
  const preparing = new Set(), active = new Map(), snapshots = new Map(), stopped = new Set();
  const reservations = new Map();
  let timer = null;
  const get = id => meetingManager.getMeeting(id);
  const members = m => getMembers ? getMembers(m) : getDispatcher().groupMembersForMeeting?.(m, { includeDormant: true }) || [];
  async function ensureReservation(id) {
    if (reservations.has(id)) return reservations.get(id);
    const reservationId = `dev-file:${id}`;
    const held = [];
    try {
      for (const sid of new Set((get(id)?.subSessions || []).filter(Boolean))) {
        const native = sessionManager?.getNativeSession?.(sid) || sessionManager?.getNativeCodex?.(sid);
        if (!native || typeof native.reserveWorkflow !== 'function') continue;
        await native.reserveWorkflow(reservationId, '文件开发工作流');
        held.push(native);
      }
      const value = { reservationId, held };
      reservations.set(id, value);
      return value;
    } catch (error) {
      await Promise.allSettled(held.map(native => native.releaseWorkflow(reservationId)));
      throw error;
    }
  }
  async function releaseReservation(id) {
    const value = reservations.get(id);
    if (!value) return;
    reservations.delete(id);
    const results = await Promise.allSettled(value.held.map(native => native.releaseWorkflow(value.reservationId)));
    for (const result of results) if (result.status === 'rejected') logger.warn('[dev-file] release Codex control reservation:', result.reason?.message || result.reason);
  }
  function save(id, fields) {
    const m = get(id);
    if (!F.enabled(m)) throw new Error('文件工作流不可用');
    meetingManager.updateMeeting(id, { serialWorkflow: { ...m.serialWorkflow,
      fileFlow: { ...m.serialWorkflow.fileFlow, ...fields } } });
  }
  function status(id) {
    const m = get(id);
    if (!F.enabled(m)) return null;
    const dir = F.directory(getHubDataDir(), id), runtime = m.serialWorkflow.fileFlow || {};
    const progress = F.isSolo(m) ? { phase: 'discuss', key: 'solo', label: '独立开发 · 同一位负责实现与合并', done: false, error: null } : F.scan(dir);
    const inferred = progress.done ? progress.round * 2 + 1 : progress.phase === 'build' ? progress.round * 2 - 1 : progress.phase === 'merge' ? progress.round * 2 : progress.phase === 'kickoff' ? 1 : 0;
    const executedRounds = Math.max(Number(runtime.executedRounds) || 0, inferred);
    const limitReached = !F.isSolo(m) && !progress.done && executedRounds - (Number(runtime.budgetStart) || 0) >= Settings.LIMIT;
    const recovering = m.serialWorkflow.settingsVersion === 1 && runtime.lastDispatch?.settled === false && !preparing.has(id) && !active.get(id)?.size;
    return { ...progress, dir, executedRounds, limitReached, recovering, paused: stopped.has(id) || !!runtime.paused || recovering || (limitReached && !active.get(id)?.size), dispatchError: runtime.error || (recovering ? '上次派工回执尚未确认，请核对现场后明确继续' : ''),
      running: preparing.has(id) || !!active.get(id)?.size, participants: m.participants };
  }
  function emit(id) {
    const s = status(id);
    const json = JSON.stringify(s);
    if (snapshots.get(id) === json) return;
    snapshots.set(id, json);
    sendToRenderer('dev-file:changed', { meetingId: id, ...s });
    onChanged(id);
  }
  function executor(m, s) {
    const index = s.phase === 'merge' ? 1 : 0;
    const id = m.serialWorkflow.steps?.[index]?.[0];
    const specs = m.slotSpecs || [];
    let slot = specs.findIndex((p, i) => (p?.memberId || `m${i + 1}`) === id);
    if (slot < 0 && /^m[1-9]\d*$/.test(id)) slot = Number(id.slice(1)) - 1;
    if (!id || !m.subSessions?.[slot]) throw new Error('当前执行席位缺失，请恢复群聊成员');
    return { id, slot };
  }
  function select(id, member) {
    meetingManager.setParticipants(id, [member.slot]);
    sendToRenderer('meeting-updated', { meeting: get(id) });
  }
  function targets(m, s) {
    const owner = executor(m, s);
    const ids = m.serialWorkflow.fileStages?.find(r => r.phase === s.phase)?.members || [owner.id];
    if (ids.length < 1 || ids.length > 3 || ids[0] !== owner.id || new Set(ids).size !== ids.length) throw new Error('本阶段文件负责人或参与人数无效');
    return ids.map(id => {
      const slot = (m.slotSpecs || []).findIndex((p,i) => (p.memberId || `m${i+1}`) === id);
      if (slot < 0 || !m.subSessions?.[slot]) throw new Error('工作流成员缺失，请恢复原成员');
      return {id,slot};
    });
  }
  function track(id, promise, token, key) {
    if (!active.has(id)) active.set(id, new Set());
    active.get(id).add(token);
    emit(id);
    return Promise.resolve(promise).then(result => {
      let failure = result?.status === 'error' || result?.status === 'no_subs'
        ? result.reason || result.status
        : result?.results?.find(r => ['errored', 'failed', 'absent', 'timed_out'].includes(r.status));
      if (failure && typeof failure === 'object') failure = failure.reason || failure.status;
      const runtime = get(id)?.serialWorkflow.fileFlow;
      if (get(id)?.serialWorkflow.settingsVersion === 1 && runtime?.lastDispatch?.token === token) {
        const expected = (runtime.lastDispatch.memberIds || []).map(mid => {
          const m=get(id), slot=(m.slotSpecs||[]).findIndex((p,i)=>(p.memberId||`m${i+1}`)===mid); return m.subSessions?.[slot];
        });
        if (result?.status !== 'completed' || expected.some(sid => !result.results?.some(r=>r.sid===sid && (!r.status || ['completed','manual_extracted'].includes(r.status))))) failure ||= '同轮成员交付回执不完整，请核对后继续';
        save(id,{lastDispatch:{...runtime.lastDispatch,settled:true}});
      }
      if (failure && get(id)?.serialWorkflow.fileFlow?.lastDispatch?.token === token) {
        save(id, { error: String(failure), paused: true });
      }
      return result;
    }, error => {
      logger.error('[dev-file] dispatch failed:', error);
      if (F.enabled(get(id)) && get(id).serialWorkflow.fileFlow?.lastDispatch?.token === token) save(id, { error: error.message, paused: true });
      throw error;
    }).finally(() => {
      active.get(id)?.delete(token);
      if (!active.get(id)?.size) active.delete(id);
      if (F.enabled(get(id))) emit(id);
      const current = F.enabled(get(id)) ? status(id) : null;
      if (!current || current.paused || current.error || current.done) void releaseReservation(id);
    });
  }
  async function dispatchStage(id, userArgs = null) {
    if (preparing.has(id)) return { status: 'error', reason: '正在准备派工，请稍后继续' };
    preparing.add(id);
    let released = false;
    try {
      let s = status(id), m = get(id);
      if (!s || s.error || s.done || s.limitReached || (m.serialWorkflow.settingsVersion === 1 && active.get(id)?.size) || (s.paused && !userArgs)) return { status: 'error', reason: s?.error || '任务未处于可执行阶段' };
      if (s.phase === 'discuss') {
        return { status: 'error', reason: '尚未开题，请输入任务后点开题并发送' };
      }
      if (!userArgs && m.serialWorkflow.fileFlow?.lastDispatch?.key === s.key) return null;
      const stageMembers = targets(m, s), member = stageMembers[0], token = crypto.randomUUID(), key = s.key;
      save(id, { lastDispatch: { key, token, memberId: member.id }, error: '' });
      for (const target of stageMembers) await ensureMemberReady(m, target.id);
      await ensureReservation(id);
      s = status(id);
      // A stop or a rename during session wake must win over this scheduled send.
      if (!s || s.paused || s.key !== key || s.error || s.done) return { status: 'error', reason: '现场已变化，取消本次派工' };
      select(id, member);
      meetingManager.setParticipants(id, stageMembers.map(t => t.slot));
      m = get(id);
      const prompt = F.phasePrompt(m, s.dir, s, members(m));
      save(id, { executedRounds: s.executedRounds + 1, lastDispatch: { key, token, memberId: member.id, memberIds: stageMembers.map(t => t.id), settled:false } });
      const args = { ...(userArgs || {}), userInput: userArgs ? `${userArgs.userInput}\n\n${prompt}` : prompt,
        targetMemberIds: stageMembers.map(t => t.id), appendUserMessage: true, dispatchMode: 'serial',
        turnTimeoutMs: 30 * 60_000, allowActiveExtend: true, fileHandoff: !userArgs,
        shouldDispatch: () => { const now = status(id); return !!now && !stopped.has(id) && !get(id)?.serialWorkflow.fileFlow?.paused && !now.error && !now.done && now.key === key; },
        workflowRun: { runId: token, kind: 'dev-file', stepIndex: s.phase === 'kickoff' ? 0 : s.round * 2 - (s.phase === 'build' ? 1 : 0), attempt: 1 } };
      const promise = getDispatcher().dispatchGroupChatTurn(id, args);
      // Do not hold the phase mutex while waiting for a chat reply. The rename advances independently.
      preparing.delete(id);
      released = true;
      return await track(id, promise, token, key);
    } catch (error) {
      if (!released && F.enabled(get(id))) save(id, { error: error.message });
      if (!released) await releaseReservation(id);
      throw error;
    } finally {
      if (!released) { preparing.delete(id); if (!active.get(id)?.size) await releaseReservation(id); }
      if (F.enabled(get(id))) emit(id);
    }
  }
  function stop(id) {
    if (!F.enabled(get(id))) return false;
    stopped.add(id);
    save(id, { paused: true });
    void releaseReservation(id);
    emit(id);
    return true;
  }
  function interruptSids(id) {
    const m = get(id), s = status(id);
    if (!s || s.done || s.phase === 'discuss') return [];
    const memberId = m.serialWorkflow.fileFlow?.lastDispatch?.memberId;
    const specs = m.slotSpecs || [];
    const memberIds = m.serialWorkflow.fileFlow?.lastDispatch?.memberIds;
    if (memberIds?.length) return memberIds.map(id=>m.subSessions[specs.findIndex((p,i)=>(p?.memberId || `m${i+1}`)===id)]).filter(Boolean);
    const slot = memberId ? specs.findIndex((p, i) => (p?.memberId || `m${i + 1}`) === memberId) : -1;
    const index = slot >= 0 ? slot : executor(m, s).slot;
    return [m.subSessions[index]].filter(Boolean);
  }
  async function userTurn(id, args) {
    if (!F.enabled(get(id))) return getDispatcher().dispatchGroupChatTurn(id, args);
    const s = status(id);
    // A user-authored kickoff is the first actual execution round. Plain
    // discussion does not spend a round or clear a previous stop.
    const kickoff = !F.isSolo(get(id)) && String(args.userInput || '').includes(F.PRESET_START) && ['discuss','kickoff'].includes(s.phase);
    if (kickoff && (active.get(id)?.size || preparing.has(id))) return {status:'error',reason:'当前轮次尚未交付'};
    if (F.isResume(args.userInput) && !s.error && !F.isSolo(get(id)) && get(id).serialWorkflow.settingsVersion === 1) {
      if (active.get(id)?.size || preparing.has(id)) return {status:'error',reason:'当前轮次仍在执行'};
      stopped.delete(id);
      save(id, { paused:false, error:'', ...(s.limitReached ? {budgetStart:s.executedRounds} : {}) });
      return dispatchStage(id,args);
    }
    if (kickoff) preparing.add(id);
    try {
    await ensureReservation(id);
    if (kickoff && (stopped.has(id) || status(id)?.paused || status(id)?.key !== s.key)) return {status:'error',reason:'现场已变化，取消本次开题'};
    if (F.isResume(args.userInput) && !s.error) {
      // Resume is the user's message, not another phase prompt or a change
      // of recipient. Latch this phase so the scanner cannot race it with
      // automatic dispatch; only a later file handoff advances the workflow.
      const m = get(id), selected = (m.participants || [0])[0];
      save(id, { paused: false, error: '', ...(!F.isSolo(m) ? {executedRounds:s.executedRounds+1,...(s.limitReached?{budgetStart:s.executedRounds}:{})} : {}), lastDispatch: { key: s.key, token: crypto.randomUUID(),
        memberId: args.targetMemberIds?.[0] || m.slotSpecs?.[selected]?.memberId || `m${selected + 1}` } });
      stopped.delete(id);
    }
    // A normal question is still a normal group message; it must not clear stop intent.
    const token = crypto.randomUUID();
    if (kickoff) {
      if (s.limitReached) return {status:'error',reason:'已达 6 轮，请明确继续当前任务'};
      const m = get(id), stageMembers = targets(m,F.spec('kickoff'));
      args = {...args,targetMemberIds:stageMembers.map(t=>t.id)};
      save(id,{executedRounds:s.executedRounds + (s.phase === 'kickoff' && !m.serialWorkflow.fileFlow?.executedRounds ? 0 : 1),lastDispatch:{key:'kickoff:0',token,memberId:stageMembers[0].id,memberIds:stageMembers.map(t=>t.id),settled:false}});
    }
      const promise = getDispatcher().dispatchGroupChatTurn(id, args);
      const tracked = track(id, promise, token, s.key);
      if (kickoff) preparing.delete(id);
      return await tracked;
    } catch (error) {
      await releaseReservation(id);
      throw error;
    } finally { if (kickoff) {preparing.delete(id); if(!active.get(id)?.size) await releaseReservation(id); if(F.enabled(get(id)))emit(id);} }
  }
  function tick() {
    for (const m of meetingManager.getAllMeetings()) {
      if (!F.enabled(m) || F.isSolo(m)) continue;
      try {
        const s = status(m.id);
        emit(m.id);
        if (s.paused || s.error || s.dispatchError || s.done) { void releaseReservation(m.id); continue; }
        if (m.serialWorkflow.settingsVersion === 1 && active.get(m.id)?.size) continue;
        if (!['build', 'merge'].includes(s.phase) || preparing.has(m.id)) continue;
        if (m.serialWorkflow.fileFlow?.lastDispatch?.key === s.key) continue;
        void dispatchStage(m.id).catch(error => logger.error('[dev-file] automatic dispatch:', error));
      } catch (error) { logger.error('[dev-file] scan failed:', error); }
    }
  }
  function kickoffPreset(id) {
    const m = get(id);
    if (!F.enabled(m)) throw new Error('文件工作流不可用');
    if (F.isSolo(m)) throw new Error('单 Agent 请使用独立开工');
    const s = status(id);
    if (s.error || !['discuss', 'kickoff'].includes(s.phase)) throw new Error(s.error || '本任务已经开题，请用普通消息继续');
    // No mkdir, no phase change, no dispatch. The button only prepares editable composer text.
    return { prompt: F.phasePrompt(m, s.dir, F.spec('kickoff'), members(m)), slot: executor(m, F.spec('kickoff')).slot };
  }
  function independentPreset(id) {
    const m = get(id);
    if (!F.isSolo(m)) throw new Error('独立开工仅用于单 Agent 开发群聊');
    return { prompt: F.independentPrompt(m, F.directory(getHubDataDir(), id), members(m)), slot: executor(m, F.spec('kickoff')).slot };
  }
  function registerIpc(ipcMain, shell) {
    ipcMain.handle('workflow:configure', (_e, {meetingId, draft, expectedRevision} = {}) => {
      try {
        const m = get(meetingId);
        if (!m?.groupChat) throw new Error('群聊不存在');
        const wf = m.serialWorkflow || {}, fileStatus = status(meetingId);
        if (fileStatus?.error) throw new Error('任务目录状态无法确认，保留原设置：'+fileStatus.error);
        if (isWorkflowRunning(meetingId) || preparing.has(meetingId) || active.get(meetingId)?.size || wf.loopState?.status === 'running' || wf.serialRunState?.status === 'running') throw new Error('工作流运行中，停止并等待本轮结束后再修改');
        if ((wf.settingsRevision || 0) !== expectedRevision) throw new Error('设置已被更新，请关闭后重新打开');
        const ids = (m.slotSpecs || []).map((p,i)=>p.memberId || `m${i+1}`);
        const next = Settings.toConfig(wf,draft,ids);
        if (fileStatus?.files?.length && (draft.kind !== 'file' || JSON.stringify(next.steps) !== JSON.stringify(wf.steps))) throw new Error('已有任务文件，不能切换协议或负责人；请为新任务创建群聊');
        next.settingsRevision = (wf.settingsRevision || 0) + 1;
        meetingManager.updateMeeting(meetingId,{serialWorkflow:next});
        sendToRenderer('meeting-updated',{meeting:get(meetingId)});
        emit(meetingId);
        return {ok:true,config:next};
      } catch(error) { return {ok:false,reason:error.message}; }
    });
    ipcMain.handle('dev-file:status', (_e, { meetingId }) => status(meetingId));
    ipcMain.handle('dev-file:kickoff-preset', (_e, { meetingId }) => kickoffPreset(meetingId));
    ipcMain.handle('dev-file:independent-preset', (_e, { meetingId }) => independentPreset(meetingId));
    ipcMain.handle('dev-file:open-docs', async (_e, { meetingId }) => {
      const s = status(meetingId);
      if (!s) throw new Error('文件工作流不可用');
      fs.mkdirSync(s.dir, { recursive: true });
      const error = await shell.openPath(s.dir);
      if (error) throw new Error(error);
      return { ok: true };
    });
  }
  return { status, userTurn, stop, interruptSids, tick, kickoffPreset, independentPreset, registerIpc,
    start() { if (!timer) { tick(); timer = setInterval(tick, 1000); timer.unref?.(); } },
    dispose() { if (timer) clearInterval(timer); timer = null; for (const id of reservations.keys()) void releaseReservation(id); } };
}
module.exports = { createDevFileEngine };
