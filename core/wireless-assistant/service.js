'use strict';
// 无线 Tab · SuperRAN 助理（2026-10-14 田哥拍板）：常驻在 Hub 里，定时查看 SuperRAN 协作台，
// 已推进、没人接手的提案全部由它接手；每个提案新开一个干净会话（避免上下文互相污染），
// 同时最多跑 2 个。默认 GPT-6 Astra · 最高思考 · 标准速度，开会话或发提示词失败、或会话停下
// 却始终没接手时，换替补 Opus 5.5 · 最高思考重来一次。
// 助理只负责到提交候选 PR：验收、批准、合入仍走协作台原流程。
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { AssistantStore } = require('../hub-assistant/store');
const { claimTimers, ownsTimers } = require('../hub-assistant/timer-owner');
const profiles = require('../hub-assistant/profiles');
const portal = require('./portal');
const { buildExecutionPrompt } = require('./prompt');
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

function jobKey(p) {
  const result = p.result ? createHash('sha256').update(String(p.result)).digest('hex').slice(0, 8) : 'r0';
  return p.id + ':' + String(p.content_sha || '').slice(0, 12) + ':' + result;
}
const unclaimedAccepted = p => !!p && p.state === 'accepted' && !p.executor;
const short = (s, n = 28) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; };

class WirelessAssistant {
  constructor(deps) {
    this.deps = deps;
    this.store = new AssistantStore(path.join(deps.dataDir, 'wireless'));
    this.store.db.exec('CREATE TABLE IF NOT EXISTS wireless_jobs(id TEXT PRIMARY KEY,proposal TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,updated INTEGER NOT NULL)');
    this.proposals = new Map();
    this.last = this.store.get('lastPoll') || { at: null, error: null, total: 0, candidates: 0 };
    this.nextPollAt = Date.now() + (deps.firstPollDelayMs ?? 15000);
    this.polling = null; this.dispatching = null; this.timer = null;
    if (!deps.noTimer) claimTimers(this.store);
  }

  now() { return this.deps.now ? this.deps.now() : Date.now(); }
  ownsTimers() { return ownsTimers(this.store); }
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

  // 拉协作台列表 → 登记新提案 → 跟进在办 → 补派。手动「立即检查」也走这里。
  poll() {
    if (this.polling) return this.polling;
    this.polling = (async () => {
      const startedAt = this.now();
      try {
        const install = this.install();
        const value = await portal.listProposals(install, { run: this.deps.run });
        this.proposals = new Map(value.proposals.map(p => [p.id, p]));
        this.reconcile(value.proposals);
        this.last = { at: startedAt, error: null, total: value.proposals.length, candidates: value.proposals.filter(unclaimedAccepted).length };
      } catch (error) {
        this.last = { ...this.last, at: startedAt, error: error.message };
      } finally {
        this.store.set('lastPoll', this.last);
        this.nextPollAt = this.now() + this.settings().pollMinutes * 60000;
      }
      this.watch();
      await this.dispatchQueued();
      this.changed();
      return this.status();
    })().finally(() => { this.polling = null; });
    return this.polling;
  }
  install() { return portal.readInstallation({ home: this.deps.home }); }

  reconcile(list) {
    const now = this.now();
    for (const p of list) {
      if (!unclaimedAccepted(p)) continue;
      const id = jobKey(p);
      const existing = this.job(id);
      if (existing) { if (WAITING.includes(existing.state) && existing.title !== p.title) this.saveJob({ ...existing, title: p.title }); continue; }
      const risks = scanProposal(p);
      const job = this.saveJob({ id, proposalId: p.id, title: p.title, author: p.author, contentSha: p.content_sha, contentRevision: p.content_revision,
        returned: !!p.result, state: risks.length ? 'held' : 'queued', risks, createdAt: now, attempts: [] });
      if (risks.length) this.notify(job, '待你放行', `提案「${short(p.title)}」里有${risks.map(r => r.why).join('、')}，已停下等你看过再交给 Agent。`);
    }
    // 排队中的提案被别人接手、被撤回或改了版本：不再自动处理。
    for (const job of this.jobs().filter(j => WAITING.includes(j.state))) {
      const p = this.proposals.get(job.proposalId);
      if (unclaimedAccepted(p) && jobKey(p) === job.id) continue;
      const note = !p ? '提案已不在协作台' : p.executor ? `已由 ${p.executor} 接手` : jobKey(p) !== job.id && unclaimedAccepted(p) ? '提案改了版本，按新版本重新排队' : '提案状态变为「' + (STATE_LABELS[p.state] || p.state) + '」';
      this.saveJob({ ...job, state: 'skipped', note, finishedAt: now });
    }
  }

  sessionBusy(id) {
    const s = id && this.deps.getSession(id);
    if (!s) return false;
    return !!this.deps.isAgentTurnActive?.(id) || require('../session-runtime-truth').sessionRuntimeIsActive(s) || ['running'].includes(s.status) || !!this.deps.hasPendingPrompt?.(id);
  }

  // 跟进在办的提案：交付了、释放了、被别人接手了，或会话停下没接手（换替补）。
  watch() {
    const now = this.now();
    // 派发到一半 Hub 退出：会话或接手记录在就接着跟进，否则标「没跑起来」由田哥点重来，不自动重发。
    if (!this.dispatching) for (const job of this.jobs().filter(j => j.state === 'dispatching' && now - (j.startedAt || 0) > 3 * 60000)) {
      const p = this.proposals.get(job.proposalId);
      if (this.deps.getSession(job.sessionId) || (p && p.executor === job.slot)) this.saveJob({ ...job, state: 'working', note: '已交给 Agent' });
      else this.finish(job, 'failed', '上次派发没有确认结果（Hub 中途退出？），点「重来」再派', true);
    }
    for (const job of this.jobs().filter(j => j.state === 'working')) {
      const p = this.proposals.get(job.proposalId);
      const session = this.deps.getSession(job.sessionId);
      const busy = this.sessionBusy(job.sessionId);
      const next = { ...job, idleSince: busy ? null : job.idleSince || now };
      if (p) {
        if (p.executor && p.executor === job.slot) next.claimed = true;
        if (p.executor && p.executor !== job.slot) { this.finish(next, 'skipped', `已由 ${p.executor} 接手`); continue; }
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
  finish(job, state, note, notify = false) {
    this.saveJob({ ...job, state, note, finishedAt: this.now(), attention: null });
    if (notify) this.notify(job, state === 'done' ? '已交付' : state === 'released' ? '已释放' : '没跑起来', `提案「${short(job.title)}」${note}`);
  }

  async dispatchQueued() {
    if (this.dispatching) return this.dispatching;
    this.dispatching = (async () => {
      const settings = this.settings();
      if (!settings.enabled || !this.ownsTimers()) return;
      let free = settings.maxParallel - this.jobs().filter(j => ACTIVE.includes(j.state)).length;
      const queued = this.jobs().filter(j => j.state === 'queued').sort((a, b) => a.createdAt - b.createdAt);
      for (const job of queued) {
        if (free <= 0) break;
        const p = this.proposals.get(job.proposalId);
        if (!unclaimedAccepted(p) || jobKey(p) !== job.id) continue;
        await this.dispatch(job, job.wantRoute || 'primary');
        free -= 1;
      }
    })().finally(() => { this.dispatching = null; });
    return this.dispatching;
  }

  async dispatch(job, route) {
    const settings = this.settings(), r = settings[route], install = this.install();
    const p = this.proposals.get(job.proposalId);
    const attempt = job.attempts.length + 1;
    const slot = 'wx-' + job.proposalId.slice(0, 8) + '-' + attempt;
    const sessionId = randomUUID();
    let current = this.saveJob({ ...job, state: 'dispatching', route, slot, sessionId, kind: r.kind, model: r.model, effort: r.effort, startedAt: this.now(), claimed: false, idleSince: null, attention: null, wantRoute: null,
      attempts: [...job.attempts, { at: this.now(), route, kind: r.kind, model: r.model, effort: r.effort, sessionId, slot }] });
    try {
      const defaults = await this.deps.getDefaults?.(r.kind) || {};
      const picked = profiles.pick(r.kind, { model: r.model, effort: r.effort }, defaults);
      const opts = { ...profiles.withModel(r.kind, defaults, picked), id: sessionId, cwd: install.root || this.deps.fallbackCwd,
        title: '无线 · ' + short(job.title, 24), purpose: PURPOSE, autonomous: true, noInheritCursor: true, mcpProfile: 'none',
        wirelessProposal: { id: job.proposalId, slot } };
      if (r.kind === 'codex') opts.codexSpeedTier = r.speed || 'standard';
      const session = await this.deps.createSession(r.kind, opts);
      if (!session || session.id !== sessionId) throw new Error('会话创建结果与预留编号不一致');
      const text = buildExecutionPrompt(p, { install, slot, worktreeRoot: this.deps.worktreeRoot || 'D:/AIWork' });
      const receipt = await this.deps.sendPrompt(sessionId, text, randomUUID());
      if (!receipt || receipt.ok === false || receipt.notSent) throw new Error(receipt?.error || '提示词没有发出去');
      const confirmed = receipt.receipt?.status === 'confirmed';
      current = this.saveJob({ ...current, state: 'working', note: confirmed ? '已交给 Agent' : '已发出，CLI 尚未确认收到；请打开会话看一眼' });
      this.changed();
      return current;
    } catch (error) {
      const attempts = current.attempts.map((a, i) => i === current.attempts.length - 1 ? { ...a, error: error.message } : a);
      if (route === 'primary') {
        this.saveJob({ ...current, attempts, state: 'queued', note: '主力没开起来（' + short(error.message, 60) + '），改用替补' });
        return this.dispatch(this.job(current.id), 'fallback');
      }
      this.finish({ ...current, attempts }, 'failed', '主力和替补都没开起来：' + short(error.message, 80), true);
      this.changed();
      return this.job(current.id);
    }
  }

  // 「待你放行」→ 排队；失败 / 没跑起来 / 已释放 → 重新排队；不处理 → 移出队列。
  act(id, action) {
    const job = this.job(id);
    if (!job) throw new Error('找不到这条记录');
    if (action === 'approve') { if (job.state !== 'held') throw new Error('这条不在「待你放行」'); this.saveJob({ ...job, state: 'queued', note: '你已放行' }); }
    else if (action === 'retry') { if (!['failed', 'stalled', 'released', 'skipped', 'dismissed'].includes(job.state)) throw new Error('这条正在处理，不能重来'); this.saveJob({ ...job, state: 'queued', note: '你要求重来', wantRoute: null }); }
    else if (action === 'dismiss') { if (ACTIVE.includes(job.state)) throw new Error('正在处理的提案请到会话里停下'); this.saveJob({ ...job, state: 'dismissed', note: '你选择不处理', finishedAt: this.now() }); }
    else throw new Error('未知操作');
    this.changed();
    void this.dispatchQueued().then(() => this.changed());
    return this.status();
  }

  status() {
    const install = this.install(), now = this.now();
    const jobs = this.jobs().map(j => {
      const s = j.sessionId && this.deps.getSession(j.sessionId);
      return { ...j, session: j.sessionId ? { open: !!s, busy: this.sessionBusy(j.sessionId), status: s?.status || null } : null };
    });
    return {
      ok: true, settings: this.settings(), owner: this.ownsTimers(), last: this.last, nextPollAt: this.nextPollAt, polling: !!this.polling, now,
      install: { ready: !!install.executorConfig, user: install.user, kitDir: install.kitDir, kitExpires: install.kitExpires, root: install.root, site: install.site },
      jobs,
      catalog: profiles.phoneCatalog(KINDS),
    };
  }
  notify(job, title, text) { try { this.deps.onNotify?.({ title: 'SuperRAN 助理 · ' + title, text, proposalId: job.proposalId, sessionId: job.sessionId || null }); } catch {} }
  changed() { try { this.deps.onChanged?.(); } catch {} }
  close() { clearInterval(this.timer); clearTimeout(this.firstTimer); this.timer = null; try { this.store.close(); } catch {} }
}

module.exports = { WirelessAssistant, DEFAULT_SETTINGS, PURPOSE, jobKey, STALL_MS, IDLE_ATTENTION_MS };
