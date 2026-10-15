'use strict';
// 家里 Hub 一端（2026-10-15 田哥拍板）：家里的 Agent 通过 MCP 工具「问公司」或 company-ask 命令把问题发到公司 Hub，
// 公司的 CodeAgent 新开会话去办（读代码、查本机文件与环境，不改动公司电脑），写成 Markdown 回执（不含源码）。回执到了，Hub 把它作为一条新消息发回提问的会话：
// 会话停着就直接唤醒，开着在忙就等它停下，已关闭就先恢复再发。追问进同一个公司会话，次数不限，由 Agent 自己判断。
//
// 只在自用版里启用（社区版、公司版导出时删掉本文件）。通道地址取自公司收件箱的本机配置。
// 本机接口按会话发通行证（HMAC(本机密钥, 会话编号)）：会话只能以自己的身份提问、追问和查看。
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomBytes, createHmac, timingSafeEqual, randomUUID } = require('node:crypto');
const { AssistantStore } = require('../hub-assistant/store');
const { claimTimers, ownsTimers } = require('../hub-assistant/timer-owner');
const { BridgeLink } = require('./link');

const ACTIVE_POLL_MS = 10000;
const IDLE_POLL_MS = 3 * 60000;
const DEFAULT_SETTINGS = Object.freeze({ attach: 'wireless' });
const short = (s, n = 28) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const STATE_LABEL = { sent: '已发出', received: '公司已收到', running: '公司在处理', replied: '已回执', error: '公司报错', cancelled: '已作废' };

function replyMessage(t, r) {
  if (r.error) {
    return [`【公司回执 ${t.id} · 第 ${r.round} 轮 · 没答上】`, '', r.error, '', '——', '公司那边这一轮没有给出回答。可以用 followup_company 换个问法重问，或先按现有证据继续，并在汇报里写明待公司核实的点。'].join('\n');
  }
  return [`【公司回执 ${t.id} · 第 ${r.round} 轮】`, '', r.reply, '', '——',
    '以上是公司 CodeAgent 的回执（不含源码）。请核对：可信就据此继续；把握程度低、没读到关键部分或与家里证据矛盾时，用 followup_company 追问（同一个公司会话，它记得上一轮读过的内容），次数不限。'].join('\n');
}
// 线程状态由各轮推导：最后一轮决定结果。
function deriveState(t) {
  if (t.state === 'cancelled') return 'cancelled';
  const last = t.rounds[t.rounds.length - 1] || {};
  if (last.reply) return 'replied';
  if (last.error) return 'error';
  return last.status === 'running' ? 'running' : last.status === 'received' ? 'received' : 'sent';
}
// 需要后台继续跟进：还有没回执的轮次，或回执还没送进会话。
const needsWork = t => t.state !== 'cancelled' && t.rounds.some(r => (!r.reply && !r.error) || ((r.reply || r.error) && !r.delivered));

// 早期版本的表没有 open 列：补上并按内容回填（只有开发期的数据目录会遇到）。
function ensureOpenColumn(db, needsWork) {
  const cols = db.prepare('PRAGMA table_info(bridge_threads)').all().map(c => c.name);
  if (cols.includes('open')) return;
  db.exec('ALTER TABLE bridge_threads ADD COLUMN open INTEGER NOT NULL DEFAULT 0');
  for (const row of db.prepare('SELECT id,payload FROM bridge_threads').all()) {
    let t = null; try { t = JSON.parse(row.payload); } catch {}
    if (t) db.prepare('UPDATE bridge_threads SET open=? WHERE id=?').run(needsWork(t) ? 1 : 0, row.id);
  }
}

class HomeBridge {
  constructor(deps) {
    this.deps = deps;
    this.dir = path.join(deps.dataDir, 'company-bridge');
    this.store = new AssistantStore(this.dir);
    this.store.db.exec('CREATE TABLE IF NOT EXISTS bridge_threads(id TEXT PRIMARY KEY,session TEXT,payload TEXT NOT NULL,state TEXT NOT NULL,open INTEGER NOT NULL DEFAULT 0,updated INTEGER NOT NULL)');
    ensureOpenColumn(this.store.db, needsWork);
    this.link = new BridgeLink({ side: 'home', store: this.store, fetchImpl: deps.fetchImpl, now: () => this.now() });
    this.endpointFile = path.join(this.dir, 'mcp-endpoint.json');
    let master = this.store.get('localMaster');
    if (!master) { master = randomBytes(32).toString('hex'); this.store.set('localMaster', master); }
    this.master = master;
    this.busy = null; this.deliverBusy = null; this.timer = null; this.nextPullAt = 0; this.server = null;
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

  // ---- 本机接口：MCP 与命令行都经它调用，凭会话通行证认身份 ----
  passFor(sessionId) { return createHmac('sha256', this.master).update('session:' + String(sessionId)).digest('hex'); }
  checkPass(sessionId, pass) {
    if (!sessionId) return false;
    const a = Buffer.from(String(pass || '')), b = Buffer.from(this.passFor(sessionId));
    return a.length === b.length && timingSafeEqual(a, b);
  }
  async start() {
    this.server = http.createServer((req, res) => {
      const sessionId = String(req.headers['x-hub-bridge-session'] || '');
      const pass = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (req.method !== 'POST' || req.url !== '/tool' || !this.checkPass(sessionId, pass)) { res.writeHead(403); res.end(); return; }
      req.setEncoding('utf8');
      let body = '';
      req.on('data', chunk => { body += chunk; if (body.length > 200000) req.destroy(); });
      req.on('end', async () => {
        try { const request = JSON.parse(body); const result = await this.invoke({ ...request, callerSessionId: sessionId }); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, result })); }
        catch (error) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: error.message })); }
      });
    });
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve); });
    this.server.unref();
    const tmp = this.endpointFile + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ url: `http://127.0.0.1:${this.server.address().port}/tool` }), { mode: 0o600 });
    fs.renameSync(tmp, this.endpointFile);
    if (this.deps.noTimer || this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(e => console.warn('[company-bridge] tick', e.message)); }, 5000);
    this.timer.unref?.();
  }

  // ---- 挂到会话上：配对后所有 Codex / Claude 会话都拿到通行证（命令行可用）；SuperRAN 相关会话另外挂 MCP ----
  sessionPlan({ kind, opts = {}, id }) {
    if (!this.link.paired() || !id) return null;
    const k = String(kind || '').replace(/-resume$/, '');
    if (!(k === 'claude' || require('../ai-kinds').isCodexCliKind(k))) return null;
    if (['hub-assistant', 'hub-photo-assistant'].includes(opts.purpose)) return null;
    const env = { HUB_BRIDGE_SESSION_ID: id, HUB_BRIDGE_SESSION_PASS: this.passFor(id), HUB_BRIDGE_ENDPOINT_FILE: this.endpointFile,
      HUB_BRIDGE_CLI: this.deps.cliScript || path.resolve(__dirname, '../../scripts/company-ask.js') };
    return { env, mcp: this.wantsMcp({ kind, opts }) ? this.getMcpEntry(id) : null };
  }
  getMcpEntry(sessionId) {
    return { name: 'company_bridge', command: this.deps.nodeExecutable || 'node', args: [this.deps.mcpScript || path.resolve(__dirname, '../../scripts/company-bridge-mcp.js')],
      env: { HUB_BRIDGE_ENDPOINT_FILE: this.endpointFile, HUB_BRIDGE_SESSION_ID: sessionId || '', HUB_BRIDGE_SESSION_PASS: this.passFor(sessionId || '') },
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

  threads(limit = 200) { return this.store.db.prepare('SELECT payload FROM bridge_threads ORDER BY updated DESC LIMIT ?').all(limit).map(r => JSON.parse(r.payload)); }
  openThreads() { return this.store.db.prepare('SELECT payload FROM bridge_threads WHERE open=1 ORDER BY updated').all().map(r => JSON.parse(r.payload)); }
  thread(id) { const r = this.store.db.prepare('SELECT payload FROM bridge_threads WHERE id=?').get(id); return r ? JSON.parse(r.payload) : null; }
  saveThread(t) {
    t.updatedAt = this.now(); t.state = deriveState(t);
    this.store.db.prepare('INSERT INTO bridge_threads(id,session,payload,state,open,updated) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET session=excluded.session,payload=excluded.payload,state=excluded.state,open=excluded.open,updated=excluded.updated')
      .run(t.id, t.sessionId, JSON.stringify(t), t.state, needsWork(t) ? 1 : 0, t.updatedAt);
    return t;
  }
  nextThreadId() {
    const d = new Date(this.now() + 8 * 3600000);
    const day = String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0');
    const counter = this.store.get('threadCounter') || {};
    let n = counter.day === day ? counter.n + 1 : 1;
    while (this.thread(`Q-${day}-${String(n).padStart(2, '0')}`)) n += 1;
    this.store.set('threadCounter', { day, n });
    return `Q-${day}-${String(n).padStart(2, '0')}`;
  }

  // ---- 工具 ----
  async invoke(request) {
    const sessionId = String(request.callerSessionId || '');
    const args = request.arguments || {};
    if (!sessionId) throw new Error('无法识别提问的会话');
    if (!this.link.paired()) throw new Error('家里和公司还没配对：请田哥在 Hub「无线」页的「公司联动」里先配对');
    if (!this.deps.getSession(sessionId) && !this.deps.getSessionMetadata?.(sessionId)) throw new Error('提问的会话已不在 Hub 里，回执无处投递');
    if (request.name === 'ask_company') return this.ask(sessionId, args);
    if (request.name === 'followup_company') return this.followup(sessionId, args);
    if (request.name === 'company_thread') return this.view(sessionId, args);
    throw new Error('未知工具');
  }
  meta(sessionId) { const s = this.deps.getSession(sessionId) || this.deps.getSessionMetadata?.(sessionId); return s || {}; }
  async ask(sessionId, { question, title }) {
    question = String(question || '').trim();
    if (question.length < 10) throw new Error('问题太短：请写清目的、要它做的事或要问的点、已知的线索和回复要求');
    if (question.length > 50000) throw new Error('问题超过 5 万字，请精简');
    const id = this.nextThreadId(), m = this.meta(sessionId), gen = this.link.gen();
    const t = { id, sessionId, sessionTitle: m.title || null, title: short(title || question, 40), gen, createdAt: this.now(),
      rounds: [{ round: 1, question, sentAt: this.now(), status: 'sent' }] };
    await this.link.send('ask', { thread: id, gen, round: 1, title: t.title, question, from: { title: m.title || null, kind: m.kind || null } });
    this.saveThread(t);
    this.nextPullAt = Math.min(this.nextPullAt, this.now() + ACTIVE_POLL_MS);
    this.changed();
    return { thread: id, status: '已发出', ...this.peer(),
      next: '等待回执时每 10 秒检查一次，处理时长取决于公司 Agent 的任务。回执到了会作为一条新消息自动发到本会话，现在请结束本轮（或先做不依赖回执的工作），不要循环等待。' };
  }
  async followup(sessionId, { thread, question }) {
    const t = this.thread(String(thread || ''));
    if (!t || t.sessionId !== sessionId) throw new Error(t ? '这个编号属于另一个会话，不能在这里追问' : '找不到编号 ' + thread);
    if (t.state === 'cancelled' || t.gen !== this.link.gen()) throw new Error('这个编号属于上一次配对，已作废；请用 ask_company 重新提问');
    question = String(question || '').trim();
    if (question.length < 4) throw new Error('追问内容太短');
    if (question.length > 50000) throw new Error('追问超过 5 万字，请精简');
    const pending = t.rounds.find(r => !r.reply && !r.error);
    if (pending) throw new Error(`第 ${pending.round} 轮还没回执，等它回来再追问`);
    const round = t.rounds.length + 1;
    await this.link.send('followup', { thread: t.id, gen: t.gen, round, question });
    this.saveThread({ ...t, rounds: [...t.rounds, { round, question, sentAt: this.now(), status: 'sent' }] });
    this.nextPullAt = Math.min(this.nextPullAt, this.now() + ACTIVE_POLL_MS);
    this.changed();
    return { thread: t.id, round, status: '已发出', ...this.peer(), next: '回执到了会作为新消息自动发到本会话，现在请结束本轮。' };
  }
  view(sessionId, { thread }) {
    let list;
    if (thread) {
      const t = this.thread(String(thread));
      if (!t || t.sessionId !== sessionId) throw new Error('找不到本会话的编号 ' + thread);
      list = [t];
    } else list = this.store.db.prepare('SELECT payload FROM bridge_threads WHERE session=? ORDER BY updated DESC LIMIT 10').all(sessionId).map(r => JSON.parse(r.payload));
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
  baseUrl() {
    const direct = this.deps.bridgeApiUrl?.();
    if (direct) return direct.replace(/\/+$/, '');
    const url = this.deps.relayBaseUrl?.();
    if (!url) throw new Error('没找到公司收件箱的配置，无法确定通道地址');
    return url.replace(/\/+$/, '') + '/api';
  }
  createPairing() { this.cancelOpen('重新配对'); const code = this.link.createPairing(this.baseUrl()); this.store.set('pairingCode', code); this.nextPullAt = 0; this.changed(); return { code, ...this.status() }; }
  async sendPairingToInbox() {
    const code = this.store.get('pairingCode');
    if (!code || this.link.config().state !== 'pending') throw new Error('先生成配对码');
    if (!this.deps.relayPush) throw new Error('本机没有公司收件箱的发送工具');
    await this.deps.relayPush(code, 'AI特战队专用功能配对码（在对应设置项里粘贴）');
    return { ok: true };
  }
  unpair() { this.cancelOpen('已解除配对'); this.link.unpair(); this.store.set('pairingCode', null); this.changed(); return this.status(); }
  // 解除或重新配对：还没回执的问题作废，旧回执也不再投递（下一个对端不会收到旧任务）。
  cancelOpen(why) {
    for (const t of this.openThreads()) this.saveThread({ ...t, state: 'cancelled', cancelNote: why, rounds: t.rounds.map(r => (r.reply || r.error) ? r : { ...r, status: 'cancelled' }) });
  }

  // ---- 轮询与投递 ----
  polling() {
    const state = this.link.config().state;
    if (!state || state === 'none') return { intervalSeconds: 0, active: false, activeUntil: null };
    const active = state === 'pending' || this.openThreads().length > 0;
    return { intervalSeconds: (active ? ACTIVE_POLL_MS : IDLE_POLL_MS) / 1000, active, activeUntil: null };
  }
  async tick({ force = false } = {}) {
    if (!force && !this.deps.noTimer && !ownsTimers(this.store)) return;
    // 恢复/唤醒一个会话时，继续收其他任务的回执；每轮回执仍只有一个投递者。
    if (!this.busy) this.busy = (async () => {
      const state = this.link.config().state;
      if (!state || state === 'none') return;
      if (this.link.pairingExpired()) { this.link.unpair(); this.store.set('pairingCode', null); this.notify('配对码已过期', '24 小时内公司没有粘贴，这个配对码作废了；需要时重新生成。'); this.changed(); return; }
      if (force || this.now() >= this.nextPullAt) {
        this.nextPullAt = this.now() + this.polling().intervalSeconds * 1000;
        try { await this.link.pull(message => this.receive(message)); } catch {}
        try {
          if (await this.link.checkPairingConflict()) {
            this.cancelOpen('配对码被另一台设备用过'); this.link.unpair();
            this.notify('已解除配对', '配对码被另一台设备用过（出现了第二个配对请求）。为安全起见已解除，请重新生成配对码再配。');
          }
        } catch {}
        this.changed();
      }
    })().finally(() => { this.busy = null; });
    await this.busy;
    if (this.link.paired()) {
      if (!this.deliverBusy) this.deliverBusy = this.deliver().finally(() => { this.deliverBusy = null; });
      await this.deliverBusy;
    }
  }
  checkNow() { this.nextPullAt = 0; return this.tick({ force: true }).then(() => this.status()); }

  async receive(message) {
    if (message.type === 'hello') {
      if (this.link.completeAsHome(message)) {
        this.store.set('pairingCode', null);
        await this.link.flush().catch(() => {});
        this.notify('已和公司接通', '配对完成。之后新开的 SuperRAN 相关会话会带上「问公司」工具，其他会话可用 company-ask 命令。');
      }
      return;
    }
    const t = this.thread(String(message.thread || ''));
    if (!t || t.state === 'cancelled' || (message.gen && t.gen && message.gen !== t.gen)) return;
    const round = Number(message.round) || 0;
    let changed = false;
    const rounds = t.rounds.map(r => {
      if (r.round !== round) return r;
      if (message.type === 'status') {
        if (r.reply) return r;
        changed = true;
        if (message.state === 'error') return { ...r, status: 'error', error: String(message.note || '公司报错'), errorAt: this.now(), delivered: false, nextTryAt: null };
        // 公司重试了失败的这一轮：清掉上次的报错，等新的回执。
        return { ...r, status: message.state === 'running' ? 'running' : 'received', note: message.note || null, error: null };
      }
      if (message.type === 'reply') {
        // 同一轮只收第一份回执（发件箱重发、服务端重放都不会让它再投递一次）。
        if (r.reply) return r;
        changed = true;
        return { ...r, status: 'replied', reply: String(message.text || ''), replyMid: message.mid, replyAt: this.now(), meta: message.meta || null, error: null, delivered: false, nextTryAt: null };
      }
      return r;
    });
    if (!changed) return;
    this.saveThread({ ...t, rounds });
    if (message.type === 'reply') this.notify('回执到了', `${t.id} 第 ${round} 轮：${short(message.text, 60)}`, t.sessionId);
  }

  sessionBusy(id) {
    const s = id && this.deps.getSession(id);
    if (!s) return false;
    return !!this.deps.isAgentTurnActive?.(id) || require('../session-runtime-truth').sessionRuntimeIsActive(s) || ['running', 'waiting'].includes(s.status) || !!this.deps.hasPendingPrompt?.(id);
  }
  // 把回执送回提问的会话：停着就发，在忙就等，关着就先恢复。
  async deliver() {
    for (const t of this.openThreads()) {
      if (t.state === 'cancelled') continue;
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
          const receipt = await this.deps.sendPrompt(t.sessionId, replyMessage(t, r), randomUUID());
          // 明确没发进去才算失败；确认迟到、结果未知都按已送达，不重发（重发会让 Agent 收到两遍）。
          if (!receipt || receipt.notSent || (receipt.ok === false && !receipt.unconfirmed && receipt.sendStatus !== 'stuck')) throw new Error(receipt?.error || '没有发进会话');
          this.markDelivery(t, r, { delivered: true, deliveredAt: this.now(), deliveryError: null, deliveryUncertain: receipt.ok === false || null });
        } catch (error) {
          this.markDelivery(t, r, { deliveryError: error.message }, false);
        }
      }
    }
  }
  markDelivery(t, r, patch, final = true) {
    const fresh = this.thread(t.id) || t;
    const rounds = fresh.rounds.map(x => x.round === r.round
      ? { ...x, ...patch, ...(final && !patch.delivered ? { delivered: true, deliveredAt: null } : {}), nextTryAt: final ? null : this.now() + 60000 } : x);
    this.saveThread({ ...fresh, rounds }); this.changed();
  }

  status() {
    const c = this.link.config(), st = this.link.status();
    let baseUrl = null; try { baseUrl = this.baseUrl(); } catch {}
    return {
      ok: true, role: 'home', settings: this.settings(), baseUrl,
      link: { state: c.state || 'none', pairedAt: c.pairedAt || null, pairingCode: c.state === 'pending' ? this.store.get('pairingCode') : null, outbox: this.link.pendingOutbox() },
      net: { lastOkAt: st.lastOkAt || null, lastError: st.lastError || null, gate: st.gate || null, peerSeen: st.peerSeen || null }, peer: this.peer(),
      now: this.now(), nextPullAt: this.nextPullAt, polling: this.polling(),
      threads: this.threads(60).map(t => ({ ...t, session: { open: !!this.deps.getSession(t.sessionId), title: this.meta(t.sessionId).title || t.sessionTitle || null } })),
    };
  }
  notify(title, text, sessionId = null) { try { this.deps.onNotify?.({ title: '公司联动 · ' + title, text, sessionId }); } catch {} }
  changed() { try { this.deps.onChanged?.(); } catch {} }
  close() { clearInterval(this.timer); this.timer = null; try { this.server?.close(); } catch {} try { this.store.close(); } catch {} }
}

module.exports = { HomeBridge, replyMessage, deriveState };
