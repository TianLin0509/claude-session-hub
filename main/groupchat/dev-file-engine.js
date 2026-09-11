'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const F = require('../../core/dev-file-workflow');

function createDevFileEngine({ meetingManager, getHubDataDir, getDispatcher, ensureMemberReady, getMembers,
  sendToRenderer = () => {}, onChanged = () => {}, logger = console }) {
  const preparing = new Set(), active = new Map(), snapshots = new Map(), stopped = new Set();
  let timer = null;
  const get = id => meetingManager.getMeeting(id);
  const members = m => getMembers ? getMembers(m) : getDispatcher().groupMembersForMeeting?.(m, { includeDormant: true }) || [];
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
    return { ...progress, dir, paused: stopped.has(id) || !!runtime.paused, dispatchError: runtime.error || '',
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
  function track(id, promise, token, key) {
    if (!active.has(id)) active.set(id, new Set());
    active.get(id).add(token);
    emit(id);
    return Promise.resolve(promise).then(result => {
      const failure = result?.status === 'error' || result?.status === 'no_subs'
        ? result.reason || result.status
        : result?.results?.find(r => ['errored', 'failed', 'absent', 'timed_out'].includes(r.status))?.reason;
      if (failure && get(id)?.serialWorkflow.fileFlow?.lastDispatch?.token === token && status(id)?.key === key) {
        save(id, { error: String(failure) });
      }
      return result;
    }, error => {
      logger.error('[dev-file] dispatch failed:', error);
      if (F.enabled(get(id)) && get(id).serialWorkflow.fileFlow?.lastDispatch?.token === token) save(id, { error: error.message });
      throw error;
    }).finally(() => {
      active.get(id)?.delete(token);
      if (!active.get(id)?.size) active.delete(id);
      if (F.enabled(get(id))) emit(id);
    });
  }
  async function dispatchStage(id, userArgs = null) {
    if (preparing.has(id)) return { status: 'error', reason: '正在准备派工，请稍后继续' };
    preparing.add(id);
    let released = false;
    try {
      let s = status(id), m = get(id);
      if (!s || s.error || s.done || (s.paused && !userArgs)) return { status: 'error', reason: s?.error || '任务未处于可执行阶段' };
      if (s.phase === 'discuss') {
        return { status: 'error', reason: '尚未开题，请输入任务后点开题并发送' };
      }
      if (!userArgs && m.serialWorkflow.fileFlow?.lastDispatch?.key === s.key) return null;
      const member = executor(m, s), token = crypto.randomUUID(), key = s.key;
      save(id, { lastDispatch: { key, token, memberId: member.id }, error: '' });
      await ensureMemberReady(m, member.id);
      s = status(id);
      // A stop or a rename during session wake must win over this scheduled send.
      if (!s || s.paused || s.key !== key || s.error || s.done) return { status: 'error', reason: '现场已变化，取消本次派工' };
      select(id, member);
      m = get(id);
      const prompt = F.phasePrompt(m, s.dir, s, members(m));
      const args = { ...(userArgs || {}), userInput: userArgs ? `${userArgs.userInput}\n\n${prompt}` : prompt,
        targetMemberIds: [member.id], appendUserMessage: true, dispatchMode: 'serial',
        turnTimeoutMs: 30 * 60_000, allowActiveExtend: true, fileHandoff: !userArgs,
        shouldDispatch: () => { const now = status(id); return !!now && !now.paused && !now.error && !now.done && now.key === key; },
        workflowRun: { runId: token, kind: 'dev-file', stepIndex: s.phase === 'kickoff' ? 0 : s.round * 2 - (s.phase === 'build' ? 1 : 0), attempt: 1 } };
      const promise = getDispatcher().dispatchGroupChatTurn(id, args);
      // Do not hold the phase mutex while waiting for a chat reply. The rename advances independently.
      preparing.delete(id);
      released = true;
      return await track(id, promise, token, key);
    } catch (error) {
      if (!released && F.enabled(get(id))) save(id, { error: error.message });
      throw error;
    } finally { if (!released) preparing.delete(id); if (F.enabled(get(id))) emit(id); }
  }
  function stop(id) {
    if (!F.enabled(get(id))) return false;
    stopped.add(id);
    save(id, { paused: true });
    emit(id);
    return true;
  }
  function interruptSids(id) {
    const m = get(id), s = status(id);
    if (!s || s.done || s.phase === 'discuss') return [];
    const memberId = m.serialWorkflow.fileFlow?.lastDispatch?.memberId;
    const specs = m.slotSpecs || [];
    const slot = memberId ? specs.findIndex((p, i) => (p?.memberId || `m${i + 1}`) === memberId) : -1;
    const index = slot >= 0 ? slot : executor(m, s).slot;
    return [m.subSessions[index]].filter(Boolean);
  }
  async function userTurn(id, args) {
    if (!F.enabled(get(id))) return getDispatcher().dispatchGroupChatTurn(id, args);
    const s = status(id);
    if (F.isResume(args.userInput) && !s.error) {
      // Resume is the user's message, not another phase prompt or a change
      // of recipient. Latch this phase so the scanner cannot race it with
      // automatic dispatch; only a later file handoff advances the workflow.
      const m = get(id), selected = (m.participants || [0])[0];
      save(id, { paused: false, error: '', lastDispatch: { key: s.key, token: crypto.randomUUID(),
        memberId: args.targetMemberIds?.[0] || m.slotSpecs?.[selected]?.memberId || `m${selected + 1}` } });
      stopped.delete(id);
    }
    // A normal question is still a normal group message; it must not clear stop intent.
    const token = crypto.randomUUID();
    return track(id, getDispatcher().dispatchGroupChatTurn(id, args), token, s.key);
  }
  function tick() {
    for (const m of meetingManager.getAllMeetings()) {
      if (!F.enabled(m) || F.isSolo(m)) continue;
      try {
        const s = status(m.id);
        emit(m.id);
        if (s.paused || s.error || s.done || !['build', 'merge'].includes(s.phase) || preparing.has(m.id)) continue;
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
    dispose() { if (timer) clearInterval(timer); timer = null; } };
}
module.exports = { createDevFileEngine };
