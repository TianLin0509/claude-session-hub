'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');
const Feed = require('../../core/dev-workbench-feed');
const DP = require('../../renderer/dev-progress');

function createDevWorkbench(deps) {
  const { meetingManager, loopEngine, getHubDataDir, sendToRenderer, logger = console } = deps;
  const summaries = new Map(), revisions = new Map(), dirty = new Set(), queued = new Set(), controls = new Set();
  const readQueue = [], reads = new Map();
  let worker = null, timer = null, activeReads = 0, requestId = 0, sequence = 0, disposed = false;
  const epoch = crypto.randomUUID();
  const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,255}$/.test(id);
  const errorText = error => Feed.clean(error && error.message || String(error), 1000);
  const log = error => logger.warn('[dev-workbench]', errorText(error));
  const meeting = id => validId(id) ? (meetingManager.getDevWorkbenchRecord
    ? meetingManager.getDevWorkbenchRecord(id) : meetingManager.getMeeting(id)) : null;

  function runtime(m) {
    if (!loopEngine) return { running: false, unavailable: true };
    try { return loopEngine.getStatus(m.id); }
    catch (error) { return { running: false, unavailable: true, error: errorText(error) }; }
  }
  function token(m, live) {
    const sw = m.serialWorkflow || {}, ls = sw.loopState || {};
    return crypto.createHash('sha256').update(JSON.stringify([
      m.id, m.subSessions, sw.enabled, sw.loop, sw.steps, sw.stepConfigs,
      ls.runId, ls.status, ls.currentStep, ls.round, ls.goal, ls.deadlineTs, !!live.running,
      sw.devWorkbenchManual || null,
    ])).digest('hex').slice(0, 24);
  }
  function memberProblem(m) {
    const steps = m.serialWorkflow?.steps;
    if (!Array.isArray(steps)) return '流程步骤缺失，请进入群聊检查设置';
    for (const memberId of steps.flat()) {
      const match = /^m([1-9]\d*)$/.exec(String(memberId));
      const sid = match && m.subSessions?.[Number(match[1]) - 1];
      if (!sid || (deps.sessionManager && !deps.sessionManager.getSession(sid))) {
        return '流程席位缺失，请进入群聊恢复成员后再继续；也可以手动接管';
      }
    }
    return '';
  }
  function makeRow(m) {
    const sw = m.serialWorkflow && typeof m.serialWorkflow === 'object' ? m.serialWorkflow : {};
    const ls = sw.loopState && typeof sw.loopState === 'object' ? sw.loopState : {};
    const live = runtime(m), saved = summaries.get(m.id) || {};
    const summary = saved.summary || {}, card = summary.card, review = summary.review, update = summary.update;
    let stage = DP.deriveStage(m);
    if (live.unavailable) stage = { ...stage, key: 'unavailable', label: '执行状态暂不可用', tone: 'bad', running: false };
    else if (sw.devWorkbenchManual && !live.running) stage = { ...stage, key: 'manual', label: '手动处理', tone: 'idle', running: false };
    else if (!live.running && ls.status === 'running') stage = { ...stage, key: 'interrupted', label: '运行已中断，可恢复', tone: 'bad', running: false };
    else if (live.running && stage.tone !== 'run') stage = { ...stage, key: 'settling', label: '正在结束当前流程', tone: 'run', running: true };
    if (m.metadataError && !live.running) stage = { ...stage, key: 'damaged', label: '任务信息需要检查', tone: 'bad', running: false };
    const processUpdate = update && (!card || update.index > card.index) ? update : null;
    const progressSource = processUpdate || card;
    const failedReview = review && review.decision === 'fail' ? review : null;
    const reportSource = review && review.report && (!card || !card.report || review.index >= card.index) ? review : card;
    const resumeCandidate = !live.running && !live.unavailable && !sw.devWorkbenchManual && sw.loop && sw.loop.enabled
      && ['paused', 'running', 'stopped_user', 'reviewer_unavailable'].includes(ls.status) && !!ls.goal
      && !(ls.deadlineTs && Date.now() >= ls.deadlineTs);
    const missingMember = resumeCandidate ? memberProblem(m) : '';
    const canResume = resumeCandidate && !missingMember;
    return {
      id: m.id, title: Feed.clean(m.title, 240) || '未命名开发群聊', workspace: Feed.clean(m.workspace, 2048),
      project: Feed.clean(m.workspaceLabel, 240), goal: Feed.clean(ls.goal, 4096), stage,
      progress: progressSource ? (processUpdate ? processUpdate.text : card.progress) : '',
      card: card || null, review: review || null, progressSource: progressSource || null,
      blockers: failedReview ? failedReview.blockers : '', report: reportSource && reportSource.report || '',
      lastError: missingMember || Feed.clean(ls.lastError && (ls.lastError.reason || ls.lastError.message), 1000),
      receivedAt: saved.receivedAt || 0, feedError: m.metadataError || saved.error || '', loading: !summaries.has(m.id),
      truncated: !!summary.truncated, controlToken: token(m, live),
      actions: { stop: !!live.running || ls.status === 'running', resume: !!canResume,
        takeover: !live.unavailable && !sw.devWorkbenchManual && !!(sw.loop && sw.loop.enabled),
        restore: !live.unavailable && !live.running && !!sw.devWorkbenchManual },
    };
  }
  function safeRow(m) {
    try { return makeRow(m); }
    catch (error) {
      log(error);
      return { id: m.id, title: Feed.clean(m.title, 240) || '开发群聊', stage: { key: 'damaged', tone: 'bad', label: '任务数据异常' },
        feedError: '这条任务暂时无法显示：' + errorText(error), actions: {}, controlToken: '' };
    }
  }
  function flush() {
    timer = null;
    if (disposed || !dirty.size) return;
    const ids = [...dirty].slice(0, 100), rows = [], removed = [];
    for (const id of ids) {
      dirty.delete(id);
      const m = meeting(id);
      if (DP.isDevMeeting(m)) rows.push(safeRow(m));
      else { removed.push(id); summaries.delete(id); revisions.delete(id); }
    }
    try { sendToRenderer('dev-workbench:changed', { epoch, sequence: ++sequence, rows, removed }); }
    catch (error) { log(error); } // Renderer reload gets a full snapshot from the same cache.
    if (dirty.size) schedule();
  }
  function schedule() { if (!timer && !disposed) { timer = setTimeout(flush, 60); timer.unref?.(); } }
  function changed(id) { if (validId(id)) { dirty.add(id); schedule(); } }

  function failWorker(error) {
    const old = worker; worker = null;
    for (const pending of reads.values()) { clearTimeout(pending.timer); pending.reject(error); }
    reads.clear();
    if (old) void old.terminate().catch(log);
  }
  function getWorker() {
    if (worker) return worker;
    const instance = new Worker(path.join(__dirname, '../../core/dev-workbench-reader-worker.js'));
    worker = instance;
    instance.on('message', payload => {
      const pending = reads.get(payload.requestId); if (!pending) return;
      reads.delete(payload.requestId); clearTimeout(pending.timer); pending.resolve(payload);
    });
    instance.on('error', error => { if (worker === instance) failWorker(error); });
    instance.on('exit', code => { if (worker === instance) failWorker(new Error('群聊摘要读取进程退出：' + code)); });
    instance.unref();
    return instance;
  }
  function readSummary(id) {
    if (typeof deps.readSummary === 'function') return deps.readSummary(id);
    return new Promise((resolve, reject) => {
      const key = ++requestId;
      try {
        const instance = getWorker();
        const timeout = setTimeout(() => failWorker(new Error('读取该群聊摘要超时，可以重新载入')), 8000);
        timeout.unref?.();
        reads.set(key, { resolve, reject, timer: timeout });
        instance.postMessage({ requestId: key, file: path.join(getHubDataDir(), 'arena-prompts', id + '-groupchat.json') });
      } catch (error) { const pending = reads.get(key); if (pending) clearTimeout(pending.timer); reads.delete(key); reject(error); }
    });
  }
  function pump() {
    while (!disposed && activeReads < 2 && readQueue.length) {
      const id = readQueue.shift(); queued.delete(id);
      if (!DP.isDevMeeting(meeting(id)) || summaries.has(id)) continue;
      const revision = revisions.get(id) || 0; activeReads++;
      Promise.resolve().then(() => readSummary(id)).then(result => {
        if (disposed || (revisions.get(id) || 0) !== revision || !DP.isDevMeeting(meeting(id))) return;
        summaries.set(id, { summary: result.summary || null, error: result.error || '', receivedAt: 0 }); changed(id);
      }).catch(error => {
        if (!disposed && (revisions.get(id) || 0) === revision && DP.isDevMeeting(meeting(id))) {
          summaries.set(id, { error: errorText(error) }); changed(id); log(error);
        }
      }).finally(() => { activeReads--; pump(); });
    }
  }
  function queue(id) { if (!summaries.has(id) && !queued.has(id)) { queued.add(id); readQueue.push(id); } }
  function ingest({ hubDataDir, meetingId, summary }) {
    if (disposed || path.resolve(hubDataDir) !== path.resolve(getHubDataDir()) || !DP.isDevMeeting(meeting(meetingId))) return;
    revisions.set(meetingId, (revisions.get(meetingId) || 0) + 1);
    summaries.set(meetingId, { summary, receivedAt: Date.now(), error: '' }); changed(meetingId);
  }
  const unsubscribe = Feed.subscribe(ingest);
  function snapshot({ retryErrors = false } = {}) {
    const meetings = meetingManager.getDevWorkbenchRecords
      ? meetingManager.getDevWorkbenchRecords() : meetingManager.getAllMeetings();
    if (!Array.isArray(meetings)) throw new Error('开发群聊列表格式无效');
    const devs = meetings.filter(DP.isDevMeeting);
    for (const m of devs) {
      if (retryErrors && summaries.get(m.id)?.error) summaries.delete(m.id);
      queue(m.id);
    }
    pump();
    return { ok: true, epoch, sequence, rows: devs.map(safeRow) };
  }
  function handleEvent(channel, data) {
    if (disposed || !data) return;
    const channels = ['loop:progress', 'workflow:progress', 'meeting-created', 'meeting-updated', 'meeting-closed', 'meeting-created-with-errors'];
    if (!channels.includes(channel)) return;
    const id = data.meetingId || data.meeting?.id;
    if (!validId(id)) return;
    if (DP.isDevMeeting(meeting(id))) { queue(id); pump(); }
    changed(id);
  }

  async function action(args = {}) {
    const { meetingId: id, action: name, controlToken } = args;
    if (!validId(id)) return { ok: false, reason: '任务标识无效' };
    if (controls.has(id)) return { ok: false, reason: '这条任务的上一项操作尚未完成，其他任务可以继续处理' };
    controls.add(id);
    try {
      let m = meeting(id);
      if (!DP.isDevMeeting(m)) return { ok: false, reason: '该开发群聊已关闭或已切换场景' };
      if (!loopEngine) return { ok: false, reason: '执行引擎不可用，请进入群聊处理' };
      const row = makeRow(m);
      if (!controlToken || controlToken !== row.controlToken) return { ok: false, reason: '任务阶段已变化，请查看更新后的状态再操作', stale: true };
      if (!row.actions[name]) return { ok: false, reason: '当前阶段不支持此操作，请进入群聊处理' };
      if (name === 'stop' || name === 'takeover') {
        if (loopEngine.isRunning(id)) {
          const stopped = loopEngine.stopLoop(id, { interrupt: true });
          if (!stopped) return { ok: false, reason: '停止请求未被执行端接受，请进入群聊处理' };
          const until = Date.now() + 1800;
          while (loopEngine.isRunning(id) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50));
          if (loopEngine.isRunning(id)) return { ok: true, pending: true, message: name === 'takeover'
            ? '停止请求已发送，仍等待执行端确认；尚未切换为手动处理。可进入群聊检查。'
            : '停止请求已发送，仍等待执行端确认。可进入群聊检查。' };
        }
        m = meeting(id);
        if (!DP.isDevMeeting(m)) return { ok: false, reason: '任务已关闭' };
        const sw = m.serialWorkflow || {}, ls = sw.loopState || {};
        const next = { ...sw, loopState: ls.status === 'running' ? { ...ls, status: 'stopped_user' } : ls };
        if (name === 'takeover') {
          next.devWorkbenchManual = { enabled: sw.enabled, loopEnabled: sw.loop?.enabled, at: Date.now() };
          next.enabled = false; next.loop = { ...sw.loop, enabled: false };
        }
        const updated = meetingManager.updateMeeting(id, { serialWorkflow: next });
        if (!updated) throw new Error('任务设置保存失败');
        sendToRenderer('meeting-updated', { meeting: updated }); changed(id);
        return { ok: true, message: name === 'takeover' ? '已停止自动流程并切换为手动处理；群聊、成员、工作树和历史均保留。' : '流程已停止，已有成果和群聊记录保留。' };
      }
      if (name === 'restore') {
        const sw = m.serialWorkflow, backup = sw.devWorkbenchManual;
        const next = { ...sw, enabled: backup.enabled, loop: { ...sw.loop, enabled: backup.loopEnabled } };
        delete next.devWorkbenchManual;
        const updated = meetingManager.updateMeeting(id, { serialWorkflow: next });
        if (!updated) throw new Error('自动流程设置恢复失败');
        sendToRenderer('meeting-updated', { meeting: updated }); changed(id);
        return { ok: true, message: '原自动流程设置已恢复；尚未派发任务。可继续中断流程，或回群聊布置新要求。' };
      }
      if (name === 'resume') {
        const validation = loopEngine.validateLoop(id);
        if (!validation.ok) return { ok: false, reason: validation.reason };
        const ls = m.serialWorkflow.loopState;
        const run = loopEngine.runLoop(id, null, { ...ls, status: 'running', stepAttempt: 0, lastError: null });
        Promise.resolve(run).catch(error => { log(error); changed(id); });
        if (!loopEngine.isRunning(id)) return { ok: false, reason: '恢复尚未启动，请进入群聊检查席位和流程配置' };
        changed(id);
        return { ok: true, message: '已按原任务与既有执行记录恢复流程；保留审核历史，不重置返工额度。' };
      }
      return { ok: false, reason: '不支持的任务操作' };
    } catch (error) { log(error); return { ok: false, reason: errorText(error) }; }
    finally { controls.delete(id); changed(id); }
  }
  function registerIpc(ipcMain) {
    ipcMain.handle('dev-workbench:get-snapshot', (_event, args) => {
      try { return snapshot(args && typeof args === 'object' ? args : {}); }
      catch (error) { log(error); return { ok: false, reason: errorText(error) }; }
    });
    ipcMain.handle('dev-workbench:action', (_event, args) => action(args && typeof args === 'object' ? args : {}));
  }
  function dispose() { disposed = true; unsubscribe(); if (timer) clearTimeout(timer); failWorker(new Error('工作台已关闭')); }
  return { snapshot, action, handleEvent, registerIpc, dispose, ingest, flush, _test: { makeRow, summaries, controls } };
}
module.exports = { createDevWorkbench };
