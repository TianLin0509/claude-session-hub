'use strict';
// 家里 Hub 一端（2026-10-15 田哥拍板）：家里的 Agent 通过 MCP 工具「问公司」把问题发到公司 Hub，
// 公司的 CodeAgent 只读代码、写成 Markdown 回执（不含源码）。回执到了，Hub 把它作为一条新消息发回提问的会话，
// 会话停着就直接唤醒，开着在忙就等它停下，已关闭就先恢复再发。追问进同一个公司会话，次数不限，由 Agent 自己判断。
//
// 只在自用版里启用（社区版、公司版导出时删掉本文件）。通道地址取自公司收件箱的本机配置。
const fs = require('node:fs');
const path = require('node:path');
const { AssistantStore } = require('../hub-assistant/store');
const { claimTimers, ownsTimers } = require('../hub-assistant/timer-owner');
const { AssistantBridge } = require('../hub-assistant/bridge');
const { BridgeLink } = require('./link');

const ACTIVE_POLL_MS = 30000;
const IDLE_POLL_MS = 3 * 60000;
const DEFAULT_SETTINGS = Object.freeze({ attach: 'wireless' });
const short = (s, n = 28) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const STATE_LABEL = { sent: '已发出', received: '公司已收到', running: '公司在读代码', replied: '已回执', error: '公司报错' };

function replyMessage(t, r) {
  if (r.error) {
    return [`【公司回执 ${t.id} · 第 ${r.round} 轮 · 没答上】`, '', r.error, '', '——', '公司那边这一轮没有给出回答。可以用 followup_company 换个问法重问，或先按现有证据继续。'].join('\n');
  }
  return [`【公司回执 ${t.id} · 第 ${r.round} 轮】`, '', r.reply, '', '——',
    '以上是公司 CodeAgent 读代码后的回执（不含源码）。请核对：可信就据此继续；把握程度低、没读到关键部分或与家里证据矛盾时，用 followup_company 追问（同一个公司会话，它记得上一轮读过的内容），次数不限。'].join('\n');
}

class HomeBridge {
  constructor(deps) {
    this.deps = deps;
    this.dir = path.join(deps.dataDir, 'company-bridge');
    this.store = new AssistantStore(this.dir);
    this.store.db.exec('CREATE TABLE IF NOT EXISTS bridge_threads(id TEXT PRIMARY KEY,session TEXT,payload TEXT NOT NULL,state TEXT NOT NULL,updated INTEGER NOT NULL)');
    this.link = new BridgeLink({ side: 'home', store: this.store, fetchImpl: deps.fetchImpl, now: () => this.now() });
    this.endpointFile = path.join(this.dir, 'mcp-endpoint.json');
    this.bridge = new AssistantBridge(request => this.invoke(request), { identityHeader: 'x-hub-bridge-session' });
    this.busy = null; this.timer = null; this.nextPullAt = 0;
    if (!deps.noTimer) claimTimers(this.store);
  }
  now() { return this.deps.now ? this.deps.now() : Date.now(); }
  settings() { return { ...DEFAULT_SETTINGS, ...(this.store.get('settings') || {}) }; }
  setSettings(patch = {}) {
    const next = this.settings();
    if ('attach' in patch) { if (!['wireless', 'all'].includes(patch.attach)) throw new Error('挂载范围只能是 wireless 或 all'); next.attach = patch.attach; }
    this.store.set('settings', next); this.changed();
    return next;
  }

  async start() {
    await this.bridge.start();
    const tmp = this.endpointFile + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ url: this.bridge.url, token: this.bridge.secret }), { mode: 0o600 });
    fs.renameSync(tmp, this.endpointFile);
    if (this.deps.noTimer || this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(e => console.warn('[company-bridge] tick', e.message)); }, 5000);
    this.timer.unref?.();
  }

  // ---- MCP：哪些会话挂上「问公司」，挂什么 ----
  getMcpEntry(sessionId) {
    return { name: 'company_bridge', command: this.deps.nodeExecutable || 'node', args: [this.deps.mcpScript || path.resolve(__dirname, '../../scripts/company-bridge-mcp.js')],
      env: { HUB_BRIDGE_ENDPOINT_FILE: this.endpointFile, HUB_BRIDGE_SESSION_ID: sessionId || '' },
      toolApprovalModes: { ask_company: 'approve', followup_company: 'approve', company_thread: 'approve' } };
  }
  wantsMcp({ kind, opts = {} }) {
    if (!this.link.paired()) return false;
    const k = String(kind || '').replace(/-resume$/, '');
    if (!(k === 'claude' || require('../ai-kinds').isCodexCliKind(k))) return false;
    if (['hub-assistant', 'hub-photo-assistant'].includes(opts.purpose)) return false;
    if (this.settings().attach === 'all') return true;
    if (opts.purpose === 'wireless-proposal') return true;
    const cwd = String(opts.cwd || '');
    return /superran/i.test(cwd) || (this.deps.isWirelessWorkspace ? this.deps.isWirelessWorkspace(cwd) : false);
  }

  threads() { return this.store.db.prepare('SELECT payload FROM bridge_threads ORDER BY updated DESC LIMIT 200').all().map(r => JSON.parse(r.payload)); }
  thread(id) { const r = this.store.db.prepare('SELECT payload FROM bridge_threads WHERE id=?').get(id); return r ? JSON.parse(r.payload) : null; }
  saveThread(t) {
    t.updatedAt = this.now();
    this.store.db.prepare('INSERT INTO bridge_threads VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET session=excluded.session,payload=excluded.payload,state=excluded.state,updated=excluded.updated').run(t.id, t.sessionId, JSON.stringify(t), t.state, t.updatedAt);
    return t;
  }
  nextThreadId() {
    const d = new Date(this.now() + 8 * 3600000);
    const day = String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0');
    const counter = this.store.get('threadCounter') || {};
    const n = counter.day === day ? counter.n + 1 : 1;
    this.store.set('threadCounter', { day, n });
    return `Q-${day}-${String(n).padStart(2, '0')}`;
  }

  // ---- MCP 工具 ----
  async invoke(request) {
    const sessionId = String(request.callerSessionId || '');
    const args = request.arguments || {};
    if (!sessionId) throw new Error('无法识别提问的会话');
    if (!this.link.paired()) throw new Error('家里和公司还没配对：请田哥在 Hub「无线」页的「公司联动」里先配对');
    if (request.name === 'ask_company') return this.ask(sessionId, args);
    if (request.name === 'followup_company') return this.followup(sessionId, args);
    if (request.name === 'company_thread') return this.view(sessionId, args);
    throw new Error('未知工具');
  }
  meta(sessionId) { const s = this.deps.getSession(sessionId) || this.deps.getSessionMetadata?.(sessionId); return s || {}; }
  async ask(sessionId, { question, title }) {
    question = String(question || '').trim();
    if (question.length < 10) throw new Error('问题太短：请写清目的、要问的点、家里现在的做法和建议去看的模块');
    if (question.length > 50000) throw new Error('问题超过 5 万字，请精简');
    const id = this.nextThreadId(), m = this.meta(sessionId);
    const t = this.saveThread({ id, sessionId, sessionTitle: m.title || null, title: short(title || question, 40), state: 'sent', createdAt: this.now(),
      rounds: [{ round: 1, question, sentAt: this.now(), status: 'sent' }] });
    await this.link.send('ask', { thread: id, round: 1, title: t.title, question, from: { title: m.title || null, kind: m.kind || null } });
    this.nextPullAt = Math.min(this.nextPullAt, this.now() + ACTIVE_POLL_MS);
    this.changed();
    return { thread: id, status: '已发出', ...this.peer(),
      next: '公司一个来回通常 10 分钟以上。回执到了会作为一条新消息自动发到本会话，现在请结束本轮（或先做不依赖回执的工作），不要循环等待。' };
  }
  async followup(sessionId, { thread, question }) {
    const t = this.thread(String(thread || ''));
    if (!t) throw new Error('找不到编号 ' + thread);
    if (t.sessionId !== sessionId) throw new Error('这个编号属于另一个会话，不能在这里追问');
    question = String(question || '').trim();
    if (question.length < 4) throw new Error('追问内容太短');
    if (question.length > 50000) throw new Error('追问超过 5 万字，请精简');
    const pending = t.rounds.find(r => !r.reply && !r.error);
    if (pending) throw new Error(`第 ${pending.round} 轮还没回执，等它回来再追问`);
    const round = t.rounds.length + 1;
    const next = this.saveThread({ ...t, state: 'sent', rounds: [...t.rounds, { round, question, sentAt: this.now(), status: 'sent' }] });
    await this.link.send('followup', { thread: t.id, round, question });
    this.nextPullAt = Math.min(this.nextPullAt, this.now() + ACTIVE_POLL_MS);
    this.changed();
    return { thread: next.id, round, status: '已发出', ...this.peer(), next: '回执到了会作为新消息自动发到本会话，现在请结束本轮。' };
  }
  view(sessionId, { thread }) {
    const list = thread ? [this.thread(String(thread))].filter(Boolean) : this.threads().filter(t => t.sessionId === sessionId).slice(0, 10);
    if (thread && !list.length) throw new Error('找不到编号 ' + thread);
    return { ...this.peer(), threads: list.map(t => ({ thread: t.id, title: t.title, state: STATE_LABEL[t.state] || t.state,
      rounds: t.rounds.map(r => ({ round: r.round, question: r.question, status: STATE_LABEL[r.status] || r.status, reply: r.reply || null, error: r.error || null })) })) };
  }
  peer() {
    const st = this.link.status();
    const seen = st.peerSeen ? Date.parse(st.peerSeen) : null;
    const minutes = seen ? Math.max(0, Math.round((this.now() - seen) / 60000)) : null;
    return { companyOnline: minutes != null && minutes <= 3, companyLastSeen: minutes == null ? '还没在线过' : minutes <= 1 ? '刚刚在线' : `${minutes} 分钟前在线` };
  }

  // ---- 配对 ----
  baseUrl() { const url = this.deps.relayBaseUrl?.(); if (!url) throw new Error('没找到公司收件箱的配置，无法确定通道地址'); return url.replace(/\/+$/, '') + '/api'; }
  createPairing() { const code = this.link.createPairing(this.baseUrl()); this.store.set('pairingCode', code); this.nextPullAt = 0; this.changed(); return { code, ...this.status() }; }
  async sendPairingToInbox() {
    const code = this.store.get('pairingCode');
    if (!code || this.link.config().state !== 'pending') throw new Error('先生成配对码');
    if (!this.deps.relayPush) throw new Error('本机没有公司收件箱的发送工具');
    await this.deps.relayPush(code, '家里联动配对码（在公司 Hub「家里联动」里粘贴）');
    return { ok: true };
  }
  unpair() { this.link.unpair(); this.store.set('pairingCode', null); this.changed(); return this.status(); }

  // ---- 轮询与投递 ----
  hasOpenWork() { return this.link.config().state === 'pending' || this.threads().some(t => t.rounds.some(r => !r.reply && !r.error || (r.reply || r.error) && !r.delivered)); }
  async tick({ force = false } = {}) {
    if (!force && !this.deps.noTimer && !ownsTimers(this.store)) return;
    if (this.busy) return this.busy;
    this.busy = (async () => {
      const state = this.link.config().state;
      if (!state || state === 'none') return;
      if (force || this.now() >= this.nextPullAt) {
        this.nextPullAt = this.now() + (this.hasOpenWork() ? ACTIVE_POLL_MS : IDLE_POLL_MS);
        try { await this.link.pull(message => this.receive(message)); } catch {}
        this.changed();
      }
      await this.deliver();
    })().finally(() => { this.busy = null; });
    return this.busy;
  }
  checkNow() { this.nextPullAt = 0; return this.tick({ force: true }).then(() => this.status()); }

  async receive(message) {
    if (message.type === 'hello') {
      const c = this.link.config();
      if (c.state !== 'pending') return;
      const secret = String(message.secret || '');
      require('./crypto').derive(secret);
      this.link.saveConfig({ state: 'paired', baseUrl: c.baseUrl, secret, cursor: 0, pairedAt: this.now(), peerInfo: message.info || null });
      this.store.set('pairingCode', null);
      await this.link.send('welcome', {});
      this.notify('已和公司接通', '配对完成。之后新开的 SuperRAN 相关会话会带上「问公司」工具。');
      return;
    }
    const t = this.thread(String(message.thread || ''));
    if (!t) return;
    const round = Number(message.round) || 0;
    const rounds = t.rounds.map(r => {
      if (r.round !== round) return r;
      if (message.type === 'status') {
        if (r.reply) return r;
        if (message.state === 'error') return { ...r, status: 'error', error: String(message.note || '公司报错'), errorAt: this.now(), delivered: false };
        return { ...r, status: message.state === 'running' ? 'running' : 'received', note: message.note || null };
      }
      if (message.type === 'reply') return { ...r, status: 'replied', reply: String(message.text || ''), replyAt: this.now(), meta: message.meta || null, error: null, delivered: false };
      return r;
    });
    const last = rounds[rounds.length - 1];
    this.saveThread({ ...t, rounds, state: last.status === 'replied' ? 'replied' : last.status });
    if (message.type === 'reply') this.notify('回执到了', `${t.id} 第 ${round} 轮：${short(message.text, 60)}`, t.sessionId);
  }

  sessionBusy(id) {
    const s = id && this.deps.getSession(id);
    if (!s) return false;
    return !!this.deps.isAgentTurnActive?.(id) || require('../session-runtime-truth').sessionRuntimeIsActive(s) || ['running', 'waiting'].includes(s.status) || !!this.deps.hasPendingPrompt?.(id);
  }
  // 把回执送回提问的会话：停着就发，在忙就等，关着就先恢复。
  async deliver() {
    for (const t of this.threads()) {
      for (const r of t.rounds.filter(x => (x.reply || x.error) && !x.delivered && !(x.nextTryAt > this.now()))) {
        try {
          let session = this.deps.getSession(t.sessionId);
          if (!session) {
            const stored = this.deps.getSessionMetadata?.(t.sessionId);
            if (!stored || !this.deps.resumeSession) { this.markDelivery(t, r, { deliveryError: '提问的会话已不存在，回执留在「公司联动」列表里' }); continue; }
            await this.deps.resumeSession(t.sessionId);
            session = this.deps.getSession(t.sessionId);
            if (!session) { this.markDelivery(t, r, { deliveryError: '提问的会话没能恢复，稍后重试' }, false); continue; }
          }
          if (this.sessionBusy(t.sessionId)) continue;
          const receipt = await this.deps.sendPrompt(t.sessionId, replyMessage(t, r), require('node:crypto').randomUUID());
          if (!receipt || receipt.ok === false || receipt.notSent) throw new Error(receipt?.error || '没有发进会话');
          this.markDelivery(t, r, { delivered: true, deliveredAt: this.now(), deliveryError: null });
        } catch (error) {
          this.markDelivery(t, r, { deliveryError: error.message }, false);
        }
      }
    }
  }
  markDelivery(t, r, patch, final = true) {
    const fresh = this.thread(t.id) || t;
    const rounds = fresh.rounds.map(x => x.round === r.round ? { ...x, ...patch, ...(final && !patch.delivered ? { delivered: true, deliveredAt: null } : {}), nextTryAt: final ? null : this.now() + 60000 } : x);
    this.saveThread({ ...fresh, rounds }); this.changed();
  }

  status() {
    const c = this.link.config(), st = this.link.status();
    let baseUrl = null; try { baseUrl = this.baseUrl(); } catch {}
    return {
      ok: true, role: 'home', settings: this.settings(), baseUrl,
      link: { state: c.state || 'none', pairedAt: c.pairedAt || null, pairingCode: c.state === 'pending' ? this.store.get('pairingCode') : null, outbox: this.link.pendingOutbox() },
      net: { lastOkAt: st.lastOkAt || null, lastError: st.lastError || null, gate: st.gate || null, peerSeen: st.peerSeen || null }, peer: this.peer(),
      now: this.now(), nextPullAt: this.nextPullAt,
      threads: this.threads().map(t => ({ ...t, session: { open: !!this.deps.getSession(t.sessionId), title: this.meta(t.sessionId).title || t.sessionTitle || null } })),
    };
  }
  notify(title, text, sessionId = null) { try { this.deps.onNotify?.({ title: '公司联动 · ' + title, text, sessionId }); } catch {} }
  changed() { try { this.deps.onChanged?.(); } catch {} }
  close() { clearInterval(this.timer); this.timer = null; this.bridge.close(); try { this.store.close(); } catch {} }
}

module.exports = { HomeBridge, replyMessage };
