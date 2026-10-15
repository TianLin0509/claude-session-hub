'use strict';
// 无线 Tab · SuperRAN 助理（2026-10-14 田哥拍板）：常驻在 Hub 里，定时查看 SuperRAN 协作台，
// 已推进、没人接手的提案全部由它接手；每个提案新开一个干净会话（避免上下文互相污染），
// 同时最多跑 2 个。默认 GPT-6 Astra · 最高思考 · 标准速度，开会话或发提示词失败、或会话停下
// 却始终没接手时，换替补 Opus 5.5 · 最高思考重来一次。
// 2026-10-15 田哥拍板：审批合入也交给助理——人只在协作台点「批准合入」。提出人验收通过后，助理
// 另开会话、换一个与实现不同的模型独立审查；审查通过且已批准，助理直接跑合并脚本（完整测试、合入、
// 同步阿里云，不调用模型）。审查没通过、主干已更新时，协作台把提案退回，由助理按原 PR 返工。
// v2.7.2（田哥「都按推荐来」）：主干前进后合并脚本三档判定——没冲突就并入新主干合入（改到同一批文件先自动
// 换模型重审合并结果），只有真冲突才退回返工；派实现任务前把在途 PR 正在改的红档文件写进提示词，
// 必须改同一处的提案释放并写「等 PR #N 合入」，助理在那个 PR 合入后自动重新派它。
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
// 等别的 PR 合入再开工的提案：超过这么久只提醒，不永久卡住（田哥规则：不加会把自己卡死的硬闸门）。
const WAIT_REMIND_MS = 24 * 3600000;
const WAIT_RE = /等\s*PR\s*#?\s*(\d+)\s*合入/;
// 在途（还会改代码）的交付记录状态；提案状态是这些时也算在途。
const INFLIGHT_TASK = ['submitted', 'reviewing', 'awaiting_approval', 'approved', 'merging', 'cloud_pending'];
const INFLIGHT_PROPOSAL = ['accepted', 'implementing', 'reported'];
// 派发后这么久会话已停下、提案却还没被接手：判定没起来（多半是额度或环境问题），换替补。
const STALL_MS = 30 * 60000;
// 已接手的提案，会话停下这么久还没交付：提醒田哥去看一眼（可能在等人判断）。
const IDLE_ATTENTION_MS = 20 * 60000;
// 一次合入（完整测试闸门 + 推送）的时限。
const MERGE_TIMEOUT_MS = 90 * 60000;
const STATE_LABELS = { submitted: '待推进', accepted: '已推进', implementing: '实现中', reported: '待提出人验收', deferred: '暂缓', withdrawn: '已撤回', needs_info: '待补充', approved: '已批准', merged: '已合入' };
// 协作台代码交付记录（PR）的状态。
const REVIEWABLE = ['submitted', 'reviewing'];
const MERGEABLE = ['approved', 'merging', 'cloud_pending'];
const TASK_LABELS = { doing: '草稿', submitted: '待审查', reviewing: '审查中', awaiting_approval: '审查通过、待批准', approved: '已批准、待合入', merging: '合入中', cloud_pending: '同步阿里云中', completed: '已合入', review_failed: '审查没通过', returned: '已退回', stale: '和主干冲突', merge_failed: '合入未完成' };
const REVIEW_OUTCOME = {
  awaiting_approval: '审查通过，等审批人批准；批准后自动合入',
  approved: '审查通过，审批人已批准，开始合入', merging: '审查通过，正在合入', cloud_pending: '审查通过，正在同步阿里云', completed: '审查通过，已合入',
  review_failed: '审查没通过，已退回常驻助理按意见返工', returned: '已被审批人退回返工', stale: '和主干有冲突，已退回常驻助理并入新主干、解决冲突后重交',
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
    this.tasks = new Map(); this.tasksLoaded = false; this.tasksAt = 0;
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
          // 缺字段的记录逐条跳过，不让一条坏记录停掉整轮审查与合入。
          this.tasks = new Map(code.tasks.filter(t => t.pr && /^[0-9a-f]{40}$/.test(t.candidate || '') && /^[0-9a-f]{40}$/.test(t.base || '')).map(t => [t.pr, t]));
          this.tasksLoaded = true; this.tasksAt = this.now();
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
      // 同一候选同时只留一条在办的审查 / 合入；B 档自动重审（rereview）和在新主干上审过（reviewed_trunk）各算新的一轮。
      const busy = type => this.jobs().some(j => typeOf(j) === type && j.pr === t.pr && j.candidate === t.candidate && [...WAITING, ...ACTIVE, 'running', 'detached'].includes(j.state));
      if (this.reviewable(t)) {
        const id = `review:${t.pr}:${t.candidate.slice(0, 12)}:${t.base.slice(0, 12)}` + (t.rereview ? ':' + t.rereview.slice(0, 12) : '');
        if (!this.job(id) && !busy('review')) this.saveJob({ id, type: 'review', proposalId: p.id, pr: t.pr, candidate: t.candidate, base: t.base, rereview: t.rereview || '', title: p.title, author: p.author, state: 'queued', createdAt: now, order: t.pr, attempts: [] });
      }
      if (this.mergeable(t)) {
        const round = t.reviewed_trunk && t.reviewed_trunk !== t.base ? ':' + t.reviewed_trunk.slice(0, 12) : '';
        const id = `merge:${t.pr}:${t.candidate.slice(0, 12)}` + round;
        if (!this.job(id) && !busy('merge')) this.saveJob({ id, type: 'merge', proposalId: p.id, pr: t.pr, candidate: t.candidate, base: t.base, title: p.title, author: p.author, state: 'queued', createdAt: now, order: t.pr, attempts: [] });
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
    // 合入由本进程跑脚本。Hub 退出时不杀它（杀在半路会把合并机目录留在试合并中），所以重启后
    // 「合入中」的记录可能还在后台跑：先标「后台核对中」，按协作台状态收尾，超过合入时限才算没合完。
    if (!this.mergeRun) for (const job of this.jobs().filter(j => typeOf(j) === 'merge' && j.state === 'running')) {
      this.saveJob({ ...job, state: 'detached', note: 'Hub 重启前已开始合入，脚本可能仍在后台跑：按协作台状态核对' });
    }
    if (this.tasksLoaded) for (const job of this.jobs().filter(j => typeOf(j) === 'merge' && j.state === 'detached')) {
      const t = this.tasks.get(job.pr);
      if (t?.state === 'completed') this.finish(job, 'done', '已合入 develop（Hub 重启期间在后台完成）', true, '已合入');
      else if (!t || t.candidate !== job.candidate || ['merge_failed', 'stale', 'returned'].includes(t.state)) this.finish(job, 'failed', '交付状态变为「' + (TASK_LABELS[t?.state] || t?.state || '不在协作台') + '」，请审批人在协作台第 4 步看原因', true, '合入未完成');
      else if (now - (job.startedAt || now) > MERGE_TIMEOUT_MS) this.finish(job, 'failed', 'Hub 重启前开始的合入超过时限仍没完成：网络或环境问题修好后点「重来」（脚本从中断处接着做，不会重复合并）', true, '合入未完成');
    }
    this.watchWaiting(now);
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
        const waitFor = unclaimedAccepted(p) && next.claimed && WAIT_RE.exec(String(p.note || ''));
        if (waitFor) {
          const why = String(p.note).replace(WAIT_RE, '').replace(/^[\s：:，,]+/, '');
          this.saveJob({ ...next, state: 'waiting', waitPr: Number(waitFor[1]), waitSince: now, waitReminded: false, note: '等 PR #' + waitFor[1] + ' 合入后再开工' + (why ? '：' + short(why, 80) : '') });
          this.notify(next, '等别的 PR 合入', `提案「${short(job.title)}」要改的地方正被 PR #${waitFor[1]} 修改，助理会在它合入后自动重新开工。`);
          continue;
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
  // 等别的 PR 合入的提案：那个 PR 合入、不在协作台或它的提案已撤回 / 暂缓，就重新排队；提案自己被别人接手或改了版本就不再处理。
  watchWaiting(now) {
    for (const job of this.jobs().filter(j => j.state === 'waiting')) {
      const p = this.proposals.get(job.proposalId);
      if (!unclaimedAccepted(p) || jobKey(p) !== job.id) { this.saveJob({ ...job, state: 'skipped', note: !p ? '提案已不在协作台' : '提案状态变为「' + (STATE_LABELS[p.state] || p.state) + '」', finishedAt: now }); continue; }
      if (!this.tasksLoaded) continue;
      const t = this.tasks.get(job.waitPr);
      const owner = t && this.proposalOfPr(t.pr);
      const gone = !t || t.state === 'completed' || (owner && ['withdrawn', 'deferred'].includes(owner.state));
      if (gone) { this.saveJob({ ...job, state: 'queued', note: 'PR #' + job.waitPr + (t?.state === 'completed' ? ' 已合入' : ' 已不在途') + '，重新派发', wantRoute: null }); continue; }
      if (!job.waitReminded && now - (job.waitSince || now) > WAIT_REMIND_MS) {
        this.saveJob({ ...job, waitReminded: true, attention: 'PR #' + job.waitPr + ' 等了 24 小时还没合入（' + (TASK_LABELS[t.state] || t.state) + '）：可以点「重来」直接开工' });
        this.notify(job, '等得有点久', `提案「${short(job.title)}」在等 PR #${job.waitPr} 合入，已经 24 小时；可以在「无线」页点「重来」直接开工。`);
      }
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
      // 判卡住前必须有一次在会话停下之后读回的交付记录：审查常常超过半小时，交完结论一停下，
      // 手上的还是上一轮读到的「待审查」，不能据此误报。
      if (!busy && next.idleSince && this.tasksAt > next.idleSince && now - (job.startedAt || now) > STALL_MS) { this.finish(next, 'stalled', this.deps.getSession(job.sessionId) ? '会话停下了，但审查结论没有回写到协作台' : '会话已关闭，审查结论没有回写', true); return; }
    }
    this.saveJob(next);
  }
  finish(job, state, note, notify = false, title) {
    this.saveJob({ ...job, state, note, finishedAt: this.now(), attention: null });
    if (notify) this.notify(job, title || (state === 'done' ? '已交付' : state === 'released' ? '已释放' : '没跑起来'), `${typeOf(job) === 'implement' ? '提案' : 'PR #' + job.pr + ' · 提案'}「${short(job.title)}」${note}`);
  }

  async dispatchQueued() {
    if (this.dispatching) return this.dispatching;
    // 先起合入：合入在跑时审查要排着（见下），反过来会让审查撞上试合并中的合并机目录。
    void this.runMerges();
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
          // 合入在跑时合并机主目录处于试合并中，prepare 会失败：审查等合入结束再派。
          if (this.mergeRun || this.mergeBusy()) continue;
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
    try {
      const defaults = await this.deps.getDefaults?.(r.kind) || {};
      const picked = profiles.pick(r.kind, { model: r.model, effort: r.effort }, defaults);
      const opts = { ...profiles.withModel(r.kind, defaults, picked), id: sessionId, cwd: install.root || this.deps.fallbackCwd,
        title, purpose: PURPOSE, autonomous: true, noInheritCursor: true, mcpProfile: 'none',
        wirelessProposal: { id: job.proposalId, slot, role: typeOf(job) } };
      if (r.kind === 'codex') opts.codexSpeedTier = r.speed || 'standard';
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

  // 开工前避撞：在途 PR（还没合入、仍会改代码）的候选改到的红档文件。读不到就不写这一段，不挡派发。
  async collisions(p) {
    if (!this.tasksLoaded) return [];
    try {
      const install = this.install();
      const value = await merger.inflight({ python: install.python, script: this.script(), run: this.deps.runTasks || this.deps.run });
      return value.tasks.filter(t => t.red_files?.length && t.pr !== p?.pr_number).filter(t => {
        const owner = this.proposalOfPr(t.pr);
        return INFLIGHT_TASK.includes(t.state) || (owner && INFLIGHT_PROPOSAL.includes(owner.state));
      }).map(t => ({ pr: t.pr, title: this.proposalOfPr(t.pr)?.title || t.title, files: t.red_files }));
    } catch (error) { console.warn('[wireless] inflight', error.message); return []; }
  }

  async dispatch(job, route) {
    const r = this.settings()[route];
    const p = this.proposals.get(job.proposalId);
    const slot = this.nextSlot('wx-' + job.proposalId.slice(0, 8) + '-', j => typeOf(j) === 'implement' && j.proposalId === job.proposalId, p?.executor);
    const collisions = await this.collisions(p);
    const opened = await this.openSession({ ...job, route, collisions: collisions.map(c => c.pr) }, r, { slot, title: '无线 · ' + short(job.title, 24),
      text: install => buildExecutionPrompt(p, { install, slot, worktreeRoot: this.deps.worktreeRoot || 'D:/AIWork', collisions }) });
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
  mergeBusy() { return this.jobs().some(j => typeOf(j) === 'merge' && j.state === 'detached'); }
  runMerges() {
    if (this.mergeRun) return this.mergeRun;
    if (this.mergeBusy()) return null;
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
    this.mergeRun = merger.runMerge({ python: install.python, script: this.script(), pr: job.pr, candidate: job.candidate, logFile, spawnFn: this.deps.spawn, timeoutMs: MERGE_TIMEOUT_MS, onChild: c => { this.mergeChild = c; } })
      .then(async res => {
        const current = this.job(job.id) || job;
        if (res.ok && res.result?.state === 'completed') this.finish(current, 'done', `已合入 develop（${String(res.result.merged || '').slice(0, 8)}），阿里云已读回`, true, '已合入');
        else {
          // 下一步找谁，看协作台此刻的真实状态（脚本的报错常常只有「python 未通过」，看不出原因）。
          let state = res.result?.state;
          try {
            const code = await merger.listTasks({ python: install.python, script: this.script(), run: this.deps.runTasks || this.deps.run });
            state = code.tasks.find(t => t.pr === job.pr)?.state || state;
          } catch { /* 读不到就按脚本输出判断 */ }
          const why = (res.ok ? '合并脚本结束，但交付状态是「' + (TASK_LABELS[state] || state || '未知') + '」' : String(res.error || '').replace(/^合入未完成：/, '')).replace(/[。；;\s]+$/, '');
          if (state === 'submitted') {
            this.finish(current, 'done', (res.result?.rereview?.length ? '主干在审查后又改到这份 PR 也改的文件（' + res.result.rereview.slice(0, 4).join('、') + '）' : '主干在审查后又改到这份 PR 也改的文件') + '，已自动回到审查：换模型重审合并结果，批准保留', true, '回到审查');
            this.nextPollAt = Math.min(this.nextPollAt, this.now() + 30000);
            return;
          }
          const next = state === 'stale' || /主干已变化|候选或主干已经更新|冲突/.test(why) ? '和主干有冲突，协作台会把提案退回常驻助理并入新主干后重交'
            : state === 'returned' ? '审批人已在协作台退回，常驻助理会按意见返工'
            : state === 'merge_failed' || /合并已停止/.test(why) ? '协作台已标「合入未完成」：请审批人在第 4 步看原因，代码问题点「退回修改」交常驻助理返工'
            : '网络或环境问题修好后点「重来」（脚本从中断处接着做，不会重复合并）';
          this.finish(current, 'failed', why + '。' + next + '。日志 ' + logFile, true, '合入未完成');
        }
        this.nextPollAt = Math.min(this.nextPollAt, this.now() + 30000);
      })
      .finally(() => { this.mergeRun = null; this.mergeChild = null; this.changed(); void this.runMerges(); void this.dispatchQueued(); });
    return this.mergeRun;
  }

  // 「待你放行」→ 排队；失败 / 没跑起来 / 已释放 → 重新排队；不处理 → 移出队列。
  act(id, action) {
    const job = this.job(id);
    if (!job) throw new Error('找不到这条记录');
    if (action === 'approve') { if (job.state !== 'held') throw new Error('这条不在「待你放行」'); this.saveJob({ ...job, state: 'queued', note: '你已放行' }); }
    else if (action === 'retry') { if (!['failed', 'stalled', 'released', 'skipped', 'dismissed', 'waiting'].includes(job.state)) throw new Error('这条正在处理，不能重来'); this.saveJob({ ...job, state: 'queued', note: job.state === 'waiting' ? '你要求不等 PR #' + job.waitPr + '，直接开工' : '你要求重来', wantRoute: null, attention: null }); }
    else if (action === 'dismiss') { if ([...ACTIVE, 'running', 'detached'].includes(job.state)) throw new Error('正在处理的任务请到会话里停下'); this.saveJob({ ...job, state: 'dismissed', note: '你选择不处理', finishedAt: this.now() }); }
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

module.exports = { WirelessAssistant, DEFAULT_SETTINGS, PURPOSE, jobKey, STALL_MS, IDLE_ATTENTION_MS, WAIT_REMIND_MS };
