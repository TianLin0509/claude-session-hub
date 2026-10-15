'use strict';
// 无线 Tab · SuperRAN 助理（2026-10-14 田哥拍板）：常驻在 Hub 里，定时查看 SuperRAN 协作台，
// 已推进、没人接手的提案全部由它接手；每个提案新开一个干净会话（避免上下文互相污染），
// 同时最多跑 2 个。默认 GPT-6 Astra · 最高思考 · 标准速度，开会话或发提示词失败、或会话停下
// 却始终没接手时，换替补 Opus 5.5 · 最高思考重来一次。
// 2026-10-15 田哥拍板：审批合入也交给助理——人只在协作台点「批准合入」。提出人验收通过后，助理
// 另开会话、换一个与实现不同的模型独立审查；审查通过且已批准，助理直接跑合并脚本（完整测试、合入、
// 同步阿里云，不调用模型）。审查没通过、主干已更新时，协作台把提案退回，由助理按原 PR 返工。
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID, createHash } = require('node:crypto');
const { AssistantStore } = require('../hub-assistant/store');
const { claimTimers, ownsTimers } = require('../hub-assistant/timer-owner');
const profiles = require('../hub-assistant/profiles');
const portal = require('./portal');
const merger = require('./merger');
const { buildExecutionPrompt, buildReviewPrompt } = require('./prompt');
const { scanProposal } = require('./risk');

const PURPOSE = 'wireless-proposal';
const KINDS = ['codex', 'claude'];
const DEFAULT_SETTINGS = Object.freeze({
  enabled: true, maxParallel: 2, pollMinutes: 10,
  primary: { kind: 'codex', model: 'gpt-6-astra', effort: 'max', speed: 'standard' },
  fallback: { kind: 'claude', model: 'claude-opus-5-5', effort: 'max' },
});
const ACTIVE = ['dispatching', 'working'];
const WAITING = ['queued', 'held'];
// 派发后这么久会话已停下、提案却还没被接手：判定没起来（多半是额度或环境问题），换替补。
const STALL_MS = 30 * 60000;
// 已接手的提案，会话停下这么久还没交付：提醒田哥去看一眼（可能在等人判断）。
const IDLE_ATTENTION_MS = 20 * 60000;
const STATE_LABELS = { submitted: '待推进', accepted: '已推进', implementing: '实现中', reported: '待提出人验收', deferred: '暂缓', withdrawn: '已撤回', needs_info: '待补充', approved: '已批准', merged: '已合入' };
// 协作台代码交付记录（PR）的状态。
const REVIEWABLE = ['submitted', 'reviewing'];
const MERGEABLE = ['approved', 'merging', 'cloud_pending'];
const TASK_LABELS = { doing: '草稿', submitted: '待审查', reviewing: '审查中', awaiting_approval: '审查通过、待批准', approved: '已批准、待合入', merging: '合入中', cloud_pending: '同步阿里云中', completed: '已合入', review_failed: '审查没通过', returned: '已退回', stale: '主干已更新', merge_failed: '合入未完成' };
const REVIEW_OUTCOME = {
  awaiting_approval: '审查通过，等审批人批准；批准后自动合入',
  approved: '审查通过，审批人已批准，开始合入', merging: '审查通过，正在合入', cloud_pending: '审查通过，正在同步阿里云', completed: '审查通过，已合入',
  review_failed: '审查没通过，已退回常驻助理按意见返工', returned: '已被审批人退回返工', stale: '主干已更新，已退回常驻助理基于新主干重做',
};

function jobKey(p) {
  const result = p.result ? createHash('sha256').update(String(p.result)).digest('hex').slice(0, 8) : 'r0';
  return p.id + ':' + String(p.content_sha || '').slice(0, 12) + ':' + result;
}
// 「已推进」本身就表示没有有效接手（claim 后是「实现中」）。v2.6 的协作台退回时不清旧执行席位，
// 所以这里只看状态，不看 executor 字段，旧数据里退回的提案也能被接手返工。
const unclaimedAccepted = p => !!p && p.state === 'accepted';
const acceptedByProposer = p => !!p && p.state === 'reported' && !!p.pr_number && p.acceptance_view?.state === 'lead';
const typeOf = job => job.type || 'implement';
const short = (s, n = 28) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; };

class WirelessAssistant {
  constructor(deps) {
    this.deps = deps;
    this.store = new AssistantStore(path.join(deps.dataDir, 'wireless'));
    this.store.db.exec('CREATE TABLE IF NOT EXISTS wireless_jobs(id TEXT PRIMARY KEY,proposal TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,updated INTEGER NOT NULL)');
    this.proposals = new Map();
    this.tasks = new Map(); this.tasksLoaded = false;
    this.last = this.store.get('lastPoll') || { at: null, error: null, total: 0, candidates: 0 };
    this.nextPollAt = Date.now() + (deps.firstPollDelayMs ?? 15000);
    this.polling = null; this.dispatching = null; this.timer = null; this.mergeRun = null; this.mergeChild = null;
    if (!deps.noTimer) claimTimers(this.store);
  }

  now() { return this.deps.now ? this.deps.now() : Date.now(); }
  ownsTimers() { return ownsTimers(this.store); }
  script() { return this.deps.reviewMergeScript || merger.defaultScript(this.deps.home); }
  settings() {
    const s = this.store.get('settings') || {};
    return { ...DEFAULT_SETTINGS, ...s, primary: { ...DEFAULT_SETTINGS.primary, ...(s.primary || {}) }, fallback: { ...DEFAULT_SETTINGS.fallback, ...(s.fallback || {}) } };
  }
  setSettings(patch = {}) {
    const next = this.settings();
    if ('enabled' in patch) next.enabled = patch.enabled === true;
    if ('maxParallel' in patch) { const n = Number(patch.maxParallel); if (!Number.isInteger(n) || n < 1 || n > 4) throw new Error('同时处理的提案数只能是 1–4'); next.maxParallel = n; }
    if ('pollMinutes' in patch) { const n = Number(patch.pollMinutes); if (!Number.isInteger(n) || n < 2 || n > 120) throw new Error('检查间隔只能是 2–120 分钟'); next.pollMinutes = n; }
    for (const route of ['primary', 'fallback']) {
      if (!patch[route]) continue;
      const r = { ...next[route], ...patch[route] };
      if (!KINDS.includes(r.kind)) throw new Error('后端只能是 Codex 或 Claude');
      const picked = profiles.pick(r.kind, { model: r.model, effort: r.effort }, {});
      next[route] = { kind: r.kind, model: picked.model, effort: picked.effort, ...(r.kind === 'codex' ? { speed: r.speed === 'fast' ? 'fast' : 'standard' } : {}) };
    }
    this.store.set('settings', next); this.changed();
    if (next.enabled) void this.dispatchQueued();
    return next;
  }

  jobs() {
    return this.store.db.prepare('SELECT payload FROM wireless_jobs ORDER BY updated DESC LIMIT 200').all().map(r => JSON.parse(r.payload));
  }
  job(id) { const r = this.store.db.prepare('SELECT payload FROM wireless_jobs WHERE id=?').get(id); return r ? JSON.parse(r.payload) : null; }
  saveJob(job) {
    job.updatedAt = this.now();
    this.store.db.prepare('INSERT INTO wireless_jobs VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,state=excluded.state,updated=excluded.updated')
      .run(job.id, job.proposalId, JSON.stringify(job), job.state, job.updatedAt);
    return job;
  }

  start() {
    if (this.deps.noTimer || this.timer) return;
    // 每分钟看一眼本机会话状态并补派；按设置的间隔（默认 10 分钟）才去协作台拉一次列表。
    this.timer = setInterval(() => { void this.tick().catch(e => console.warn('[wireless] tick', e.message)); }, 60000);
    this.timer.unref?.();
    this.firstTimer = setTimeout(() => { void this.tick().catch(() => {}); }, Math.max(0, this.nextPollAt - Date.now()) + 50);
    this.firstTimer.unref?.();
  }
  async tick() {
    if (!this.ownsTimers()) return;
    if (this.now() >= this.nextPollAt) return this.poll().catch(() => {});
    this.watch(); await this.dispatchQueued();
  }

  // 拉协作台提案和代码交付记录 → 登记新任务 → 跟进在办 → 补派。手动「立即检查」也走这里。
  poll() {
    if (this.polling) return this.polling;
    this.polling = (async () => {
      const startedAt = this.now();
      try {
        const install = this.install();
        const value = await portal.listProposals(install, { run: this.deps.run });
        this.proposals = new Map(value.proposals.map(p => [p.id, p]));
        this.reconcile(value.proposals);
        // 代码交付记录读不到时不影响自动实现，只是暂停审查与合入，并在页面写明原因。
        let taskError = null;
        try {
          const code = await merger.listTasks({ python: install.python, script: this.script(), run: this.deps.runTasks || this.deps.run });
          this.tasks = new Map(code.tasks.filter(t => t.pr).map(t => [t.pr, t])); this.tasksLoaded = true;
          this.reconcileCode();
        } catch (error) { this.tasksLoaded = false; taskError = error.message; }
        this.last = { at: startedAt, error: null, total: value.proposals.length, candidates: value.proposals.filter(unclaimedAccepted).length,
          reviews: [...this.tasks.values()].filter(t => this.reviewable(t)).length, merges: [...this.tasks.values()].filter(t => this.mergeable(t)).length, taskError };
      } catch (error) {
        this.last = { ...this.last, at: startedAt, error: error.message };
      } finally {
        this.store.set('lastPoll', this.last);
        this.nextPollAt = this.now() + this.settings().pollMinutes * 60000;
      }
      this.watch();
      // 先让页面显示新发现的任务，再逐个开会话（每个要等 CLI 就绪，约十几秒）。
      this.changed();
      await this.dispatchQueued();
      this.changed();
      return this.status();
    })().finally(() => { this.polling = null; });
    return this.polling;
  }
  install() { return portal.readInstallation({ home: this.deps.home }); }
  proposalOfPr(pr) { for (const p of this.proposals.values()) if (p.pr_number === pr) return p; return null; }
  // 只处理提案带来的 PR；本机同步的 PR 由发起它的会话自己审查合入。
  reviewable(t) { return REVIEWABLE.includes(t.state) && acceptedByProposer(this.proposalOfPr(t.pr)); }
  mergeable(t) { return MERGEABLE.includes(t.state) && !!this.proposalOfPr(t.pr); }

  reconcile(list) {
    const now = this.now();
    for (const [order, p] of list.entries()) {
      if (!unclaimedAccepted(p)) continue;
      const id = jobKey(p);
      const existing = this.job(id);
      if (existing) { if (WAITING.includes(existing.state) && existing.title !== p.title) this.saveJob({ ...existing, title: p.title }); continue; }
      const risks = scanProposal(p);
      const job = this.saveJob({ id, type: 'implement', proposalId: p.id, title: p.title, author: p.author, contentSha: p.content_sha, contentRevision: p.content_revision,
        returned: !!p.result, prNumber: p.pr_number || null, state: risks.length ? 'held' : 'queued', risks, createdAt: now, order, attempts: [] });
      if (risks.length) this.notify(job, '待你放行', `提案「${short(p.title)}」里有${risks.map(r => r.why).join('、')}，已停下等你看过再交给 Agent。`);
    }
    // 排队中的提案被别人接手、被撤回或改了版本：不再自动处理。
    for (const job of this.jobs().filter(j => typeOf(j) === 'implement' && WAITING.includes(j.state))) {
      const p = this.proposals.get(job.proposalId);
      if (unclaimedAccepted(p) && jobKey(p) === job.id) continue;
      const note = !p ? '提案已不在协作台' : p.state === 'implementing' && p.executor ? `已由 ${p.executor} 接手` : jobKey(p) !== job.id && unclaimedAccepted(p) ? '提案改了版本，按新版本重新排队' : '提案状态变为「' + (STATE_LABELS[p.state] || p.state) + '」';
      this.saveJob({ ...job, state: 'skipped', note, finishedAt: now });
    }
  }

  // 代码交付记录：提出人验收通过、待审查的 PR 排进审查；已批准且审查通过的 PR 排进合入。
  reconcileCode() {
    const now = this.now();
    for (const t of this.tasks.values()) {
      const p = this.proposalOfPr(t.pr);
      if (this.reviewable(t)) {
        const id = `review:${t.pr}:${t.candidate.slice(0, 12)}:${t.base.slice(0, 12)}`;
        if (!this.job(id)) this.saveJob({ id, type: 'review', proposalId: p.id, pr: t.pr, candidate: t.candidate, base: t.base, title: p.title, author: p.author, state: 'queued', createdAt: now, order: t.pr, attempts: [] });
      }
      if (this.mergeable(t)) {
        const id = `merge:${t.pr}:${t.candidate.slice(0, 12)}`;
        if (!this.job(id)) this.saveJob({ id, type: 'merge', proposalId: p.id, pr: t.pr, candidate: t.candidate, base: t.base, title: p.title, author: p.author, state: 'queued', createdAt: now, order: t.pr, attempts: [] });
      }
    }
    for (const job of this.jobs().filter(j => typeOf(j) !== 'implement' && j.state === 'queued')) {
      const t = this.tasks.get(job.pr);
      const ok = t && t.candidate === job.candidate && (typeOf(job) === 'review' ? this.reviewable(t) && t.base === job.base : this.mergeable(t));
      if (ok) continue;
      this.saveJob({ ...job, state: 'skipped', note: !t ? 'PR 已不在协作台' : t.candidate !== job.candidate ? '候选已更新，按新版本重新排队' : '交付状态变为「' + (TASK_LABELS[t.state] || t.state) + '」', finishedAt: now });
    }
  }

  sessionBusy(id) {
    const s = id && this.deps.getSession(id);
    if (!s) return false;
    return !!this.deps.isAgentTurnActive?.(id) || require('../session-runtime-truth').sessionRuntimeIsActive(s) || ['running'].includes(s.status) || !!this.deps.hasPendingPrompt?.(id);
  }

  // 跟进在办的任务：交付了、释放了、被别人接手了，或会话停下没接手（换替补）；审查回写了没有；合入是否被打断。
  watch() {
    const now = this.now();
    // 派发到一半 Hub 退出：会话或接手记录在就接着跟进，否则标「没跑起来」由田哥点重来，不自动重发。
    if (!this.dispatching) for (const job of this.jobs().filter(j => j.state === 'dispatching' && now - (j.startedAt || 0) > 3 * 60000)) {
      const p = this.proposals.get(job.proposalId);
      if (this.deps.getSession(job.sessionId) || (typeOf(job) === 'implement' && p && p.executor === job.slot)) this.saveJob({ ...job, state: 'working', note: '已交给 Agent' });
      else this.finish(job, 'failed', '上次派发没有确认结果（Hub 中途退出？），点「重来」再派', true);
    }
    // 合入由本进程跑脚本；Hub 重启后「合入中」的记录没有对应进程，交给田哥点重来（脚本会从中断处接着做）。
    if (!this.mergeRun) for (const job of this.jobs().filter(j => typeOf(j) === 'merge' && j.state === 'running')) {
      this.finish(job, 'failed', '上次合入被 Hub 重启打断：点「重来」继续（脚本从中断处接着做，不会重复合并）', true, '合入被打断');
    }
    for (const job of this.jobs().filter(j => j.state === 'working')) {
      if (typeOf(job) === 'review') { this.watchReview(job, now); continue; }
      const p = this.proposals.get(job.proposalId);
      const session = this.deps.getSession(job.sessionId);
      const busy = this.sessionBusy(job.sessionId);
      const next = { ...job, idleSince: busy ? null : job.idleSince || now };
      // 会话刚停下（交付、释放或卡住）：半分钟后就去协作台核对，排队的提案不用等满检查间隔。
      if (!busy && !job.idleSince) this.nextPollAt = Math.min(this.nextPollAt, now + 30000);
      if (p) {
        if (p.executor && p.executor === job.slot) next.claimed = true;
        if (p.state === 'implementing' && p.executor && p.executor !== job.slot) { this.finish(next, 'skipped', `已由 ${p.executor} 接手`); continue; }
        if (!['accepted', 'implementing'].includes(p.state)) {
          next.outcome = p.outcome || ''; next.prNumber = p.pr_number || null;
          const what = p.outcome === 'modified' ? `已提交候选 PR #${p.pr_number || '?'}，等提出人验收` : p.outcome === 'no_change' ? '不修改，已回传运行证据' : '提案状态变为「' + (STATE_LABELS[p.state] || p.state) + '」';
          this.finish(next, 'done', what, true); continue;
        }
        if (unclaimedAccepted(p) && next.claimed) { this.finish(next, 'released', '已释放：' + short(p.note || '见提案讨论', 80), true); continue; }
        if (unclaimedAccepted(p) && !busy && now - (job.startedAt || now) > STALL_MS) {
          if (job.route === 'primary') { this.saveJob({ ...next, state: 'queued', note: '主力会话停下但没接手，改用替补重来', wantRoute: 'fallback' }); continue; }
          this.finish(next, 'stalled', session ? '会话停下了，但始终没接手提案' : '会话已关闭，提案没被接手', true); continue;
        }
      }
      // 已接手、会话停下很久：可能在等人判断。只提醒一次。
      if (next.claimed && !busy && next.idleSince && now - next.idleSince > IDLE_ATTENTION_MS && !next.attention) {
        next.attention = session ? '会话停下了，还没交付：可能在等你判断' : '会话没开着：在左侧会话栏打开它继续';
        this.notify(next, '需要你看一眼', `提案「${short(job.title)}」${next.attention}。`);
      } else if (busy && next.attention) next.attention = null;
      this.saveJob(next);
    }
  }
  watchReview(job, now) {
    const busy = this.sessionBusy(job.sessionId);
    const next = { ...job, idleSince: busy ? null : job.idleSince || now };
    if (!busy && !job.idleSince) this.nextPollAt = Math.min(this.nextPollAt, now + 30000);
    if (this.tasksLoaded) {
      const t = this.tasks.get(job.pr);
      if (!t || t.candidate !== job.candidate) { this.finish(next, 'skipped', '候选已更新或 PR 不在协作台，本次审查作废'); return; }
      if (!REVIEWABLE.includes(t.state)) { this.finish(next, 'done', REVIEW_OUTCOME[t.state] || '交付状态变为「' + (TASK_LABELS[t.state] || t.state) + '」', true, t.state === 'review_failed' ? '审查没通过' : '审查完成'); return; }
      if (!busy && now - (job.startedAt || now) > STALL_MS) { this.finish(next, 'stalled', this.deps.getSession(job.sessionId) ? '会话停下了，但审查结论没有回写到协作台' : '会话已关闭，审查结论没有回写', true); return; }
    }
    this.saveJob(next);
  }
  finish(job, state, note, notify = false, title) {
    this.saveJob({ ...job, state, note, finishedAt: this.now(), attention: null });
    if (notify) this.notify(job, title || (state === 'done' ? '已交付' : state === 'released' ? '已释放' : '没跑起来'), `${typeOf(job) === 'implement' ? '提案' : 'PR #' + job.pr + ' · 提案'}「${short(job.title)}」${note}`);
  }

  async dispatchQueued() {
    if (this.dispatching) return this.dispatching;
    this.dispatching = (async () => {
      const settings = this.settings();
      if (!settings.enabled || !this.ownsTimers()) return;
      let free = settings.maxParallel - this.jobs().filter(j => ACTIVE.includes(j.state)).length;
      // 先发现的先做；同一轮发现的按协作台列表顺序。实现与审查共用会话名额，合入不占（不开会话）。
      const queued = this.jobs().filter(j => j.state === 'queued' && typeOf(j) !== 'merge').sort((a, b) => a.createdAt - b.createdAt || (a.order ?? 0) - (b.order ?? 0));
      for (const job of queued) {
        if (free <= 0) break;
        if (typeOf(job) === 'review') {
          const t = this.tasks.get(job.pr);
          if (!this.tasksLoaded || !t || !this.reviewable(t) || t.candidate !== job.candidate) continue;
          await this.dispatchReview(job, t);
        } else {
          const p = this.proposals.get(job.proposalId);
          if (!unclaimedAccepted(p) || jobKey(p) !== job.id) continue;
          await this.dispatch(job, job.wantRoute || 'primary');
        }
        free -= 1;
      }
    })().finally(() => { this.dispatching = null; });
    await this.dispatching;
    void this.runMerges();
  }

  // 席位号在同一提案（或同一 PR）的所有任务里递增：返工是新任务，不能和上一轮的席位撞名；
  // 也避开协作台上残留的旧席位（v2.6 退回时不清），否则会把旧记录误认成「已接手」。
  nextSlot(prefix, match, avoid) {
    let n = this.jobs().filter(match).reduce((sum, j) => sum + (j.attempts || []).length, 0) + 1;
    while (avoid && prefix + n === avoid) n += 1;
    return prefix + n;
  }

  async openSession(job, r, { slot, title, text }) {
    const install = this.install();
    const sessionId = randomUUID();
    let current = this.saveJob({ ...job, state: 'dispatching', slot, sessionId, kind: r.kind, model: r.model, effort: r.effort, startedAt: this.now(), claimed: false, idleSince: null, attention: null, wantRoute: null,
      attempts: [...(job.attempts || []), { at: this.now(), route: job.route, kind: r.kind, model: r.model, effort: r.effort, sessionId, slot }] });
    this.changed();
    const defaults = await this.deps.getDefaults?.(r.kind) || {};
    const picked = profiles.pick(r.kind, { model: r.model, effort: r.effort }, defaults);
    const opts = { ...profiles.withModel(r.kind, defaults, picked), id: sessionId, cwd: install.root || this.deps.fallbackCwd,
      title, purpose: PURPOSE, autonomous: true, noInheritCursor: true, mcpProfile: 'none',
      wirelessProposal: { id: job.proposalId, slot, role: typeOf(job) } };
    if (r.kind === 'codex') opts.codexSpeedTier = r.speed || 'standard';
    try {
      const session = await this.deps.createSession(r.kind, opts);
      if (!session || session.id !== sessionId) throw new Error('会话创建结果与预留编号不一致');
      const receipt = await this.deps.sendPrompt(sessionId, text(install), randomUUID());
      if (!receipt || receipt.ok === false || receipt.notSent) throw new Error(receipt?.error || '提示词没有发出去');
      const confirmed = receipt.receipt?.status === 'confirmed';
      current = this.saveJob({ ...current, state: 'working', note: confirmed ? '已交给 Agent' : '已发出，CLI 尚未确认收到；请打开会话看一眼' });
      this.changed();
      return { ok: true, job: current };
    } catch (error) {
      const attempts = current.attempts.map((a, i) => i === current.attempts.length - 1 ? { ...a, error: error.message } : a);
      return { ok: false, job: { ...current, attempts }, error };
    }
  }

  async dispatch(job, route) {
    const r = this.settings()[route];
    const p = this.proposals.get(job.proposalId);
    const slot = this.nextSlot('wx-' + job.proposalId.slice(0, 8) + '-', j => typeOf(j) === 'implement' && j.proposalId === job.proposalId, p?.executor);
    const opened = await this.openSession({ ...job, route }, r, { slot, title: '无线 · ' + short(job.title, 24),
      text: install => buildExecutionPrompt(p, { install, slot, worktreeRoot: this.deps.worktreeRoot || 'D:/AIWork' }) });
    if (opened.ok) return opened.job;
    if (route === 'primary') {
      this.saveJob({ ...opened.job, state: 'queued', note: '主力没开起来（' + short(opened.error.message, 60) + '），改用替补' });
      return this.dispatch(this.job(job.id), 'fallback');
    }
    this.finish(opened.job, 'failed', '主力和替补都没开起来：' + short(opened.error.message, 80), true);
    this.changed();
    return this.job(job.id);
  }

  // 审查用与实现不同的一家模型：实现是 Codex 就用 Claude 审，反之亦然。实现者不明（组员自己的 Agent）时用替补。
  implementerKind(proposalId) {
    const mine = this.jobs().filter(j => typeOf(j) === 'implement' && j.proposalId === proposalId && j.kind);
    return (mine.find(j => j.claimed) || mine[0])?.kind || null;
  }
  reviewRoute(job, settings) {
    const impl = this.implementerKind(job.proposalId);
    if (!impl) return settings.fallback.kind !== settings.primary.kind ? 'fallback' : 'primary';
    return ['primary', 'fallback'].find(r => settings[r].kind !== impl) || null;
  }
  async dispatchReview(job, task) {
    const settings = this.settings();
    const route = this.reviewRoute(job, settings);
    if (!route) {
      const impl = this.implementerKind(job.proposalId);
      this.finish(job, 'failed', `实现用的是 ${impl === 'codex' ? 'Codex' : 'Claude'}，主力和替补也都是它，没法换模型审查：请在设置里把其中一个换成另一家后点「重来」`, true, '审查没开始');
      return this.job(job.id);
    }
    const r = settings[route];
    const p = this.proposals.get(job.proposalId) || this.proposalOfPr(job.pr);
    const slot = this.nextSlot('wr-' + job.pr + '-', j => typeOf(j) === 'review' && j.pr === job.pr);
    const opened = await this.openSession({ ...job, route }, r, { slot, title: '无线 · 审查 · ' + short(job.title, 20),
      text: install => buildReviewPrompt(task, p ? { ...p, site: install.site } : null, { script: this.script(), slot, reviewer: r.model }) });
    if (opened.ok) return opened.job;
    this.finish(opened.job, 'failed', '审查会话没开起来：' + short(opened.error.message, 80) + '（为保证换模型审查，不改用同一家模型）', true, '审查没开始');
    this.changed();
    return this.job(job.id);
  }

  // 合入：一次只跑一个（完整测试闸门占整机），不开会话、不调用模型。
  runMerges() {
    if (this.mergeRun) return this.mergeRun;
    const settings = this.settings();
    if (!settings.enabled || !this.ownsTimers() || !this.tasksLoaded) return null;
    const job = this.jobs().filter(j => typeOf(j) === 'merge' && j.state === 'queued').sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!job) return null;
    const t = this.tasks.get(job.pr);
    if (!t || !this.mergeable(t) || t.candidate !== job.candidate) { this.saveJob({ ...job, state: 'skipped', note: '交付状态已变化，不再合入', finishedAt: this.now() }); return null; }
    const install = this.install();
    const logFile = path.join(this.deps.dataDir, 'wireless', 'logs', `merge-pr${job.pr}-${job.candidate.slice(0, 8)}.log`);
    this.saveJob({ ...job, state: 'running', startedAt: this.now(), logFile, note: '正在跑完整测试并合入（约 15–30 分钟），完成后同步阿里云',
      attempts: [...(job.attempts || []), { at: this.now(), logFile }] });
    this.changed();
    this.mergeRun = merger.runMerge({ python: install.python, script: this.script(), pr: job.pr, candidate: job.candidate, logFile, spawnFn: this.deps.spawn, onChild: c => { this.mergeChild = c; } })
      .then(res => {
        const current = this.job(job.id) || job;
        if (res.ok && res.result?.state === 'completed') this.finish(current, 'done', `已合入 develop（${String(res.result.merged || '').slice(0, 8)}），阿里云已读回`, true, '已合入');
        else if (res.ok) this.finish(current, 'failed', '合并脚本结束，但交付状态是「' + (TASK_LABELS[res.result?.state] || res.result?.state || '未知') + '」：点「重来」继续，日志 ' + logFile, true, '合入未完成');
        else this.finish(current, 'failed', '合入未完成：' + res.error + '。日志 ' + logFile, true, '合入未完成');
        this.nextPollAt = Math.min(this.nextPollAt, this.now() + 30000);
      })
      .finally(() => { this.mergeRun = null; this.mergeChild = null; this.changed(); void this.runMerges(); });
    return this.mergeRun;
  }

  // 「待你放行」→ 排队；失败 / 没跑起来 / 已释放 → 重新排队；不处理 → 移出队列。
  act(id, action) {
    const job = this.job(id);
    if (!job) throw new Error('找不到这条记录');
    if (action === 'approve') { if (job.state !== 'held') throw new Error('这条不在「待你放行」'); this.saveJob({ ...job, state: 'queued', note: '你已放行' }); }
    else if (action === 'retry') { if (!['failed', 'stalled', 'released', 'skipped', 'dismissed'].includes(job.state)) throw new Error('这条正在处理，不能重来'); this.saveJob({ ...job, state: 'queued', note: '你要求重来', wantRoute: null }); }
    else if (action === 'dismiss') { if ([...ACTIVE, 'running'].includes(job.state)) throw new Error('正在处理的任务请到会话里停下'); this.saveJob({ ...job, state: 'dismissed', note: '你选择不处理', finishedAt: this.now() }); }
    else throw new Error('未知操作');
    this.changed();
    void this.dispatchQueued().then(() => this.changed());
    return this.status();
  }

  status() {
    const install = this.install(), now = this.now();
    const jobs = this.jobs().map(j => {
      const s = j.sessionId && this.deps.getSession(j.sessionId);
      return { ...j, type: typeOf(j), session: j.sessionId ? { open: !!s, busy: this.sessionBusy(j.sessionId), status: s?.status || null } : null };
    });
    let script = null;
    try { script = fs.existsSync(this.script()) ? this.script() : null; } catch { script = null; }
    return {
      ok: true, settings: this.settings(), owner: this.ownsTimers(), last: this.last, nextPollAt: this.nextPollAt, polling: !!this.polling, now,
      install: { ready: !!install.executorConfig, user: install.user, kitDir: install.kitDir, kitExpires: install.kitExpires, root: install.root, site: install.site },
      code: { script, loaded: this.tasksLoaded, merging: !!this.mergeRun },
      jobs,
      catalog: profiles.phoneCatalog(KINDS),
    };
  }
  notify(job, title, text) { try { this.deps.onNotify?.({ title: 'SuperRAN 助理 · ' + title, text, proposalId: job.proposalId, sessionId: job.sessionId || null }); } catch {} }
  changed() { try { this.deps.onChanged?.(); } catch {} }
  close() { clearInterval(this.timer); clearTimeout(this.firstTimer); this.timer = null; try { this.store.close(); } catch {} }
}

module.exports = { WirelessAssistant, DEFAULT_SETTINGS, PURPOSE, jobKey, STALL_MS, IDLE_ATTENTION_MS };
