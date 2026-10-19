'use strict';
// 家里 Hub 一端（2026-10-15 田哥拍板）：家里的 Agent 通过 MCP 工具「问公司」或 company-ask 命令把问题发到公司 Hub，
// 公司的 CodeAgent 新开会话去办（读代码、查本机文件与环境，不改动公司电脑），写成 Markdown 回执（不含源码）。回执到了，Hub 把它作为一条新消息发回提问的会话：
// 会话停着就直接唤醒，开着在忙就等它停下，已关闭就先恢复再发。追问进同一个公司会话，次数不限，由 Agent 自己判断。
//
// 只在自用版里启用（社区版、公司版导出时删掉本文件）。通道地址取自公司收件箱的本机配置；
// 特战队同事（2026-10-18）没有收件箱，粘贴组长发的邀请码后改用团队入口的地址（team-link.js），并装上团队版 skill。
// 本机接口按会话发通行证（HMAC(本机密钥, 会话编号)）：会话只能以自己的身份提问、追问和查看。
// 反方向（公司 CodeAgent 用 ask_home 向家里求助）由 home-consult.js 处理，共用这条通道和数据库。
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomBytes, createHmac, timingSafeEqual, randomUUID } = require('node:crypto');
const { AssistantStore } = require('../hub-assistant/store');
const { claimTimers, ownsTimers } = require('../hub-assistant/timer-owner');
const { BridgeLink } = require('./link');
const { HomeConsult, PURPOSE: CONSULT_PURPOSE } = require('./home-consult');
const { MODEL_ID, sanitizeModelTable, describeModels } = require('./model-table-text');
const guard = require('./delivery-guard');
const Q = require('../codeagent-quota');
const { parseInvite, TeamAdmin } = require('./team-link');
const { installTeamSkills } = require('./team-skills');

const ACTIVE_POLL_MS = 10000;
// 空闲也每分钟看一次：公司的求助（ask_home）靠它及时收到（2026-10-15 起，原来 3 分钟）。
const IDLE_POLL_MS = 60000;
// 直查（2026-10-18）：发出后到回报前每 5 秒看一次通道（定时器本身 5 秒一跳）；MCP / 命令行最多等 45 秒；本机留最近 5 份。
const DIAG_POLL_MS = 5000;
const DIAG_WAIT_MS = 45000;
const DIAG_KEEP = 5;
const DEFAULT_SETTINGS = Object.freeze({ attach: 'wireless' });
const short = (s, n = 28) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const STATE_LABEL = { sent: '已发出', received: '公司已收到', running: '公司在处理', replied: '已回执', error: '公司报错', cancelled: '已作废' };

// 回执里注明公司用的模型（2026-10-18 按模型派活）；家里指定了模型、回答里实际出现的却是另一家的，明说出来。
const family = id => { const s = String(id || '').toLowerCase(); return s.includes('deepseek') ? 'deepseek' : s.includes('glm') ? 'glm' : s.includes('minimax') ? 'minimax' : s; };
function modelNote(t, r) {
  const meta = r.meta || {};
  const used = meta.actualModel || meta.model || '';
  const asked = t.model || meta.requestedModel || '';
  if (asked && !meta.requestedModel) return `；指定了模型 ${asked}，但公司 Hub 没有确认按它作答（可能是旧版，不认指定模型）${used ? '，公司会话模型 ' + used : ''}`;
  if (asked && meta.actualModel && family(asked) !== family(meta.actualModel)) return `；指定的模型是 ${asked}，回答里实际出现的是 ${meta.actualModel}`;
  if (asked && !meta.actualModel) return `；指定模型 ${asked}，未从回答里确认实际模型`;
  return used ? `；公司模型 ${used}` : '';
}
// 回执里注明公司用的号（代称）与换号（2026-10-18 额度感知）：撞到额度自动换号重做的，明说从哪个号换过来。
function accountNote(t, r) {
  const meta = r.meta || {};
  const asked = r.account || '';
  const parts = [];
  if (meta.rehomedFrom && meta.rehomeKind === 'model-config') parts.push(`原先的号（${meta.rehomedFrom}）报模型配置有误（请求的模型它没有权限），公司自动换到${meta.accountAlias || '另一个号'}新开会话重做了这一轮`);
  else if (meta.rehomedFrom && meta.rehomeKind === 'quota') parts.push(`原先的号（${meta.rehomedFrom}）撞到额度上限，公司自动换到${meta.accountAlias || '另一个号'}新开会话重做了这一轮`);
  else if (meta.rehomeKind === 'choice') parts.push(`原会话停在一道选择题上，公司新开会话（${meta.accountAlias || '自动挑的号'}）接着做了这一轮，带上了原问题和那道题`);
  else if (meta.rehomedFrom) parts.push(`这一轮从${meta.rehomedFrom}换到${meta.accountAlias || '另一个号'}的新会话作答（带上了前几轮问答）`);
  else if (meta.accountAlias) parts.push(`公司用的号：${meta.accountAlias}`);
  if (asked && !meta.accountAlias) parts.push(`指定了号 ${asked}，但公司 Hub 没有确认（可能是旧版，不认指定号）`);
  else if (asked && meta.accountAlias && meta.accountAlias !== asked) parts.push(`指定的是${asked}`);
  return parts.length ? '；' + parts.join('；') : '';
}
function replyMessage(t, r) {
  if (r.error) {
    return [`【公司回执 ${t.id} · 第 ${r.round} 轮 · 没答上】`, '', r.error, '', '——', '公司那边这一轮没有给出回答。可以用 followup_company 换个问法重问，或先按现有证据继续，并在汇报里写明待公司核实的点。'].join('\n');
  }
  return [`【公司回执 ${t.id} · 第 ${r.round} 轮】`, '', r.reply, '', '——',
    `以上是公司 CodeAgent 的回执（不含源码${modelNote(t, r)}${accountNote(t, r)}）。请核对：可信就据此继续；把握程度低、没读到关键部分或与家里证据矛盾时，用 followup_company 追问（同一个公司会话，它记得上一轮读过的内容），次数不限。`].join('\n');
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
    this.busy = null; this.deliverBusy = null; this.consultBusy = null; this.timer = null; this.nextPullAt = 0; this.server = null;
    this.consult = new HomeConsult({ bridge: this, deps });
    this.images = new (require('./images').BridgeImages)(this);
    this.team = new TeamAdmin({ teamAdmin: deps.teamAdmin, fetchImpl: deps.fetchImpl });
    if (!deps.noTimer) claimTimers(this.store);
  }
  now() { return this.deps.now ? this.deps.now() : Date.now(); }
  // 用邀请码接入的同事没有 SuperRAN 目录：默认挂给所有 Codex / Claude 会话。
  settings() { return { ...DEFAULT_SETTINGS, ...(this.invite() ? { attach: 'all' } : {}), ...(this.store.get('settings') || {}) }; }
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
    this.writeModelsFile(); // MCP 列工具时读它（文件被删了也能补回）
    this.installSkills(); // 只有用邀请码接入的电脑才装；Hub 升级后顺带升级没被改过的
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
      toolApprovalModes: { ask_company: 'approve', followup_company: 'approve', company_thread: 'approve', recollect_company: 'approve', company_hub_update: 'approve', company_diag: 'approve', company_act: 'approve', company_files: 'approve', send_image_company: 'approve', company_images: 'approve' } };
  }
  wantsMcp({ kind, opts = {} }) {
    if (!this.link.paired()) return false;
    const k = String(kind || '').replace(/-resume$/, '');
    if (!(k === 'claude' || require('../ai-kinds').isCodexCliKind(k))) return false;
    if (['hub-assistant', 'hub-photo-assistant'].includes(opts.purpose)) return false;
    if (this.settings().attach === 'all') return true;
    if (opts.purpose === 'wireless-proposal' || opts.purpose === CONSULT_PURPOSE) return true; // 替公司拿主意的会话要能回公司查证据
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
    if (request.name === 'recollect_company') return this.recollect(sessionId, args);
    if (request.name === 'send_image_company') return this.images.send(sessionId, args);
    if (request.name === 'company_images') return { images: this.images.view(sessionId, args.thread) };
    if (request.name === 'company_hub_update') return this.hubAdmin(args);
    if (request.name === 'company_diag') return this.diag({ sections: args.sections, lines: args.lines, errors: args.errors, id: args.id });
    if (request.name === 'company_act') {
      const { action, id, ...params } = args;
      return this.act({ action, id, params });
    }
    if (request.name === 'company_files') {
      const { action, id, ...params } = args;
      return this.files({ action, params, id });
    }
    throw new Error('未知工具');
  }
  meta(sessionId) { const s = this.deps.getSession(sessionId) || this.deps.getSessionMetadata?.(sessionId); return s || {}; }

  // ---- 公司模型表（2026-10-18 按模型派活）：公司汇总的可用模型与忙闲，家里 Agent 发问前据此选模型 ----
  // 存在本机数据库，另写一份 company-models.json 给 MCP 列工具时读（工具描述里带上模型表）。
  companyModels() { const s = this.store.get('companyModels'); return s && s.table ? s : null; }
  receiveModels(raw, gen) {
    if (gen && gen !== this.link.gen()) return;
    const table = sanitizeModelTable(raw);
    if (!table) return;
    const entry = { table, receivedAt: this.now() };
    this.store.set('companyModels', entry);
    this.writeModelsFile(entry);
    this.changed();
  }
  writeModelsFile(entry = this.companyModels()) {
    if (!entry) return;
    try {
      const file = path.join(this.dir, 'company-models.json'), tmp = file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(entry, null, 1), 'utf8');
      fs.renameSync(tmp, file);
    } catch (error) { console.warn('[company-bridge] 模型表写不进文件：' + error.message); }
  }
  // 工具返回里带的简表：每个模型一行字。
  modelsBrief() {
    const entry = this.companyModels();
    if (!entry) return '模型表未知（公司还没报过，或公司 Hub 版本较旧）：可以不指定模型，用公司默认';
    return describeModels(entry.table, entry.receivedAt);
  }
  // 家里 Agent 填的模型名：模型表已知时必须在表里（大小写不敏感，按表里的写法发）；未知时只核对格式，由公司核对。
  resolveModel(value) {
    const model = typeof value === 'string' ? value.trim() : '';
    if (!model) return '';
    const entry = this.companyModels();
    if (entry && entry.table.models.length) {
      const hit = entry.table.models.find(m => m.id.toLowerCase() === model.toLowerCase());
      if (!hit) throw new Error(`公司模型表里没有「${model}」。可选：${entry.table.models.map(m => m.id).join('、')}；不指定 model 则用公司默认`);
      return hit.id;
    }
    if (!MODEL_ID.test(model)) throw new Error('模型名格式不对：只能是字母数字开头、含 . _ : / - 的模型名');
    return model;
  }

  // 家里 Agent 填的号（2026-10-18 额度感知）：只认代称（个人 / 号 1…）。公司报过「号 + 模型」表时核对：没有这个号、或它在避让中，
  // 直接报原因和现在可用的号，不发出；没报过时只核对写法，由公司核对（公司那边同样拒绝避让中的号）。
  resolveAccount(value) {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw) return '';
    const alias = Q.normalizeAlias(raw);
    if (!alias) throw new Error('account 只认代称：「个人」或「号 1」这样的写法；不填 = 交给公司自动路由（会避开额度用完或限流的号）');
    const rows = this.companyModels()?.table?.accountRows;
    if (Array.isArray(rows) && rows.length) {
      const row = rows.find(x => x.alias === alias);
      const free = rows.filter(x => !this.rowAvoided(x)).map(x => x.alias);
      const options = free.length ? `现在可用：${free.join('、')}` : '现在所有号都在避让中';
      if (!row) throw new Error(`公司号表里没有「${alias}」（有：${rows.map(x => x.alias).join('、')}）；没有发出。${options}，或不填 account 交给自动路由`);
      if (this.rowAvoided(row)) throw Object.assign(new Error(`${alias} 在避让中：${row.avoid.reason || '额度用完或限流'}；没有发出。${options}，或不填 account 交给自动路由`), { code: 'account-avoided' });
    }
    return alias;
  }
  rowAvoided(row) { return !!(row && row.avoid && (row.avoid.until == null || row.avoid.until > this.now())); }
  accountCaution(account) {
    if (!account) return {};
    const company = this.adminState().company || {};
    if (company.current && !(company.caps || []).includes('quota')) return { accountNote: `公司 Hub 版本较旧（v${company.current}），不认指定号，会按它自己的方式挑号；回执末尾会注明` };
    if (!this.companyModels()?.table?.accountRows) return { accountNote: '公司号表未知，指定的号由公司核对；回执末尾会注明公司用的号' };
    return {};
  }

  async ask(sessionId, { question, title, model, account }) {
    question = String(question || '').trim();
    if (question.length < 10) throw new Error('问题太短：请写清目的、要它做的事或要问的点、已知的线索和回复要求');
    if (question.length > 50000) throw new Error('问题超过 5 万字，请精简');
    model = this.resolveModel(model);
    account = this.resolveAccount(account);
    const id = this.nextThreadId(), m = this.meta(sessionId), gen = this.link.gen();
    const t = { id, sessionId, sessionTitle: m.title || null, title: short(title || question, 40), gen, createdAt: this.now(),
      ...(model ? { model } : {}), rounds: [{ round: 1, question, sentAt: this.now(), status: 'sent', ...(account ? { account } : {}) }] };
    // 老版本的公司 Hub 不认 model / account：忽略它们，照旧用默认模型、自己挑号（回执里会写实际用的模型和号）。
    await this.link.send('ask', { thread: id, gen, round: 1, title: t.title, question, from: { title: m.title || null, kind: m.kind || null }, ...(model ? { model } : {}), ...(account ? { account } : {}) });
    this.saveThread(t);
    this.nextPullAt = Math.min(this.nextPullAt, this.now() + ACTIVE_POLL_MS);
    this.changed();
    // 模型表未知（公司 Hub 还没报过，多半是旧版）时指定了模型：如实提醒可能不生效（旧版公司忽略 model，照旧用默认）。
    const caution = model && !this.companyModels() ? { modelNote: '公司模型表未知（公司 Hub 可能是旧版），指定的模型可能不生效；回执末尾会注明公司是否按它作答' } : {};
    return { thread: id, status: '已发出', model: model || '公司默认', account: account || '自动路由', ...caution, ...this.accountCaution(account), ...this.peer(),
      next: '等待回执时每 10 秒检查一次，处理时长取决于公司 Agent 的任务。回执到了会作为一条新消息自动发到本会话，现在请结束本轮（或先做不依赖回执的工作），不要循环等待。' };
  }
  async followup(sessionId, { thread, question, account }) {
    const t = this.thread(String(thread || ''));
    if (!t || t.sessionId !== sessionId) throw new Error(t ? '这个编号属于另一个会话，不能在这里追问' : '找不到编号 ' + thread);
    if (t.state === 'cancelled' || t.gen !== this.link.gen()) throw new Error('这个编号属于上一次配对，已作废；请用 ask_company 重新提问');
    question = String(question || '').trim();
    if (question.length < 4) throw new Error('追问内容太短');
    if (question.length > 50000) throw new Error('追问超过 5 万字，请精简');
    const pending = t.rounds.find(r => !r.reply && !r.error);
    if (pending) throw new Error(`第 ${pending.round} 轮还没回执，等它回来再追问`);
    // 指定号（可选）：和原会话不是同一个号时，公司换到那个号新开会话、带上前几轮问答作上下文
    account = this.resolveAccount(account);
    const round = t.rounds.length + 1;
    await this.link.send('followup', { thread: t.id, gen: t.gen, round, question, ...(account ? { account } : {}) });
    this.saveThread({ ...t, rounds: [...t.rounds, { round, question, sentAt: this.now(), status: 'sent', ...(account ? { account } : {}) }] });
    this.nextPullAt = Math.min(this.nextPullAt, this.now() + ACTIVE_POLL_MS);
    this.changed();
    return { thread: t.id, round, status: '已发出', ...(account ? { account } : {}), ...this.accountCaution(account), ...this.peer(), next: '回执到了会作为新消息自动发到本会话，现在请结束本轮。' };
  }
  // 补收（2026-10-16）：上一轮报「没答上」或迟迟没有回执，但公司会话里其实写了回答——请公司直接把它取回，不重答。
  // 今天 Q-1016-02 第 4 轮就是答完了却没送回，只能人去公司电脑上抄。
  async recollect(sessionId, { thread }) {
    const t = this.thread(String(thread || ''));
    if (!t || t.sessionId !== sessionId) throw new Error(t ? '这个编号属于另一个会话' : '找不到编号 ' + thread);
    if (t.state === 'cancelled' || t.gen !== this.link.gen()) throw new Error('这个编号属于上一次配对，已作废');
    const r = t.rounds[t.rounds.length - 1];
    if (!r) throw new Error('这个编号还没有任何一轮');
    // 回执在家里、只是投递标了「可能已送达，未能确认」：补收就是在本机重新投一次（不用麻烦公司），手动重投的出口（复审 2026-10-18）。
    if (r.deliveryUnconfirmed && (r.reply || r.error)) {
      this.saveThread({ ...t, rounds: t.rounds.map(x => x.round === r.round ? { ...x, ...guard.FRESH_DELIVERY } : x) });
      this.changed();
      return { thread: t.id, round: r.round, status: '已重新投递', ...this.peer(), next: '这一轮的回执已在家里，会重新送进本会话；现在请结束本轮。' };
    }
    const waiting = !r.reply && !r.error && this.now() - (r.sentAt || 0) > 20 * 60000;
    if (!r.error && !waiting && !(r.reply && !r.delivered)) throw new Error('最后一轮正常回执了，或发出还不到 20 分钟；补收只用于「没答上」或迟迟没有回执的轮次');
    await this.link.send('recollect', { thread: t.id, gen: t.gen, round: r.round });
    this.saveThread({ ...t, rounds: t.rounds.map(x => x.round === r.round ? { ...x, recollectAt: this.now() } : x) });
    this.nextPullAt = Math.min(this.nextPullAt, this.now() + ACTIVE_POLL_MS);
    this.changed();
    return { thread: t.id, round: r.round, status: '已请公司补收', ...this.peer(),
      next: '公司取回最新回答后会作为新消息自动发到本会话（开头注明是补收）；取不到会回一条说明。现在请结束本轮。' };
  }
  // ---- 远程更新 / 重启公司 Hub（2026-10-17，公司一端见 hub-admin.js）----
  // 只发指令编号和动作；更新到哪个版本由公司 Hub 从发行源自己查（清单校验 + sha256），通道里不带文件或网址。
  adminState() { return this.store.get('hubAdmin') || {}; }
  async hubAdmin({ op = 'update', force = false, sections, lines, errors, action, params } = {}) {
    if (!this.link.paired()) throw new Error('家里和公司还没配对');
    if (!['update', 'restart', 'status', 'diag', 'act', 'files'].includes(op)) throw new Error('op 只能是 update / restart / status / diag / act / files');
    let extra = {};
    if (op === 'diag') {
      // 段落只认白名单（公司那边同样再核一遍）；不认识的直接报错，免得 Agent 以为查了。
      const D = require('./diag');
      const asked = Array.isArray(sections) ? sections : typeof sections === 'string' && sections.trim() ? sections.split(/[,，\s]+/) : [];
      const bad = asked.map(s => String(s).trim().toLowerCase()).filter(s => s && !D.SECTIONS.includes(s));
      if (bad.length) throw new Error(`sections 只能是 ${D.SECTIONS.join(' / ')}，不认识：${bad.join('、')}`);
      extra = { sections: D.parseSections(asked).sections, ...(lines != null ? { lines: D.parseLines(lines) } : {}), ...(errors != null ? { errors: D.parseErrorsLimit(errors) } : {}) };
      // 公司报过版本、却没报「认得直查」：老版本会把指令静默丢掉，直接说明，不白等（2026-10-18 审核）。
      const company = this.adminState().company || {};
      if (company.current && !(company.caps || []).includes('diag')) {
        throw Object.assign(new Error(`公司 Hub 版本过旧（v${company.current}），不支持直查；先让它更新（company_hub_update op=update），或用 ask_company 请公司 CodeAgent 查`), { code: 'diag-unsupported' });
      }
    }
    if (op === 'act') {
      // 远程维护（2026-10-18 三期，公司一端 remote-act.js）：动作白名单、参数先在家里核一遍（公司那边再核）。
      const A = require('./remote-act');
      if (!A.ACTIONS.includes(action)) throw new Error('action 只能是 ' + A.ACTIONS.join(' / '));
      const checked = A.parseParams(action, params || {});
      const company = this.adminState().company || {};
      if (company.current && !(company.caps || []).includes('act')) throw Object.assign(new Error(`公司 Hub 版本过旧（v${company.current}），不支持远程维护；先让它更新（company_hub_update op=update）`), { code: 'act-unsupported' });
      if (['pause-account', 'resume-account'].includes(action) && company.current && !(company.caps || []).includes('quota')) {
        throw Object.assign(new Error(`公司 Hub 版本过旧（v${company.current}），不支持按号暂停 / 恢复；先让它更新（company_hub_update op=update）`), { code: 'act-unsupported' });
      }
      if (action === 'set-personal-model' && company.current && !(company.caps || []).includes('personal-model')) {
        throw Object.assign(new Error(`公司 Hub 版本过旧（v${company.current}），不支持远程修改个人账号默认模型；先让它更新（company_hub_update op=update）`), { code: 'act-unsupported' });
      }
      extra = { action, params: checked };
    }
    if (op === 'files') {
      // 读公司电脑上的文件（2026-10-20 田哥，公司一端 file-query.js）：动作白名单、参数先在家里核一遍（公司那边再核）。
      const F = require('./file-query');
      if (!F.ACTIONS.includes(action)) throw new Error('action 只能是 ' + F.ACTIONS.join(' / '));
      const checked = F.parseParams(action, params || {});
      const company = this.adminState().company || {};
      if (company.current && !(company.caps || []).includes('files')) throw Object.assign(new Error(`公司 Hub 版本过旧（v${company.current}），不支持读文件；先让它更新（company_hub_update op=update）`), { code: 'files-unsupported' });
      extra = { action, params: checked };
    }
    const d = new Date(this.now() + 8 * 3600000);
    const id = 'HA-' + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0') + '-' + randomBytes(3).toString('hex');
    await this.link.send('hub-admin', { id, gen: this.link.gen(), op, force: force === true, ...extra });
    const st = this.adminState();
    this.store.set('hubAdmin', { ...st, commands: [{ id, op, force: force === true, sentAt: this.now(), ...extra }, ...(st.commands || [])].slice(0, 20) });
    this.nextPullAt = Math.min(this.nextPullAt, this.now() + (['diag', 'act', 'files'].includes(op) ? DIAG_POLL_MS : ACTIVE_POLL_MS));
    this.changed();
    if (op === 'files') {
      return { id, op, action, params: extra.params, status: '已发出', ...this.peer(),
        next: '公司 Hub 下一次检查通道时直接读盘回报（秒级，不开 CodeAgent、不排队）；公司检查通道的间隔是 10 秒，空闲时按公司设置，默认 30 秒。用 company_files 带上 id 取结果。' };
    }
    if (op === 'act') {
      return { id, op, action, status: '已发出', ...this.peer(), next: '公司 Hub 下一次检查通道时执行并回报结果和前后对比；用 company_act 带上 id 取结果。' };
    }
    if (op === 'diag') {
      return { id, op, status: '已发出', sections: extra.sections, ...this.peer(),
        next: '公司 Hub 下一次检查通道时直接采集并回报（秒级，不开 CodeAgent、不占并行名额、不排队；公司检查通道的间隔是 10 秒，空闲时按公司设置，默认 30 秒）。用 company_diag 带上 id 取结果。' };
    }
    const label = { update: '更新', restart: '重启', status: '查状态' }[op];
    return { id, op, status: '已发出', ...this.peer(), company: this.companyHub(),
      next: `公司 Hub 收到后会${op === 'status' ? '回报版本与更新状态' : label === '更新' ? '查版本、下载，等手上的任务答完再重启更新' : '等手上的任务答完再重启'}`
        + (op === 'status' ? '' : force ? '（force：不等，在跑的任务先记下、中断，重启后自动接着做）' : '（默认最多等 3 分钟，到时在跑的任务先记下、中断，重启后自动接着做，回执照常发回）') + '；'
        + '进度和结果会以 Hub 通知送达，也可以稍后用 op:"status" 查（返回里的 company.recent 是公司最近的回报）。不要循环等待。' };
  }
  // 公司 Hub 的版本与最近回报（最近 20 条）。
  companyHub() {
    const st = this.adminState();
    const recent = (st.statuses || []).slice(0, 5).map(x => ({ id: x.id, phase: x.phase, note: x.note, at: x.at }));
    return { version: st.company?.current || null, latest: st.company?.latest || null, reportedAt: st.company?.at || null, caps: st.company?.caps || null, recent,
      pending: (st.commands || []).filter(c => !['status', 'diag', 'act', 'files'].includes(c.op) && !this.adminDone(c.id)).map(c => c.id) };
  }
  adminDone(id) { return (this.adminState().statuses || []).some(x => x.id === id && ['up-to-date', 'failed', 'refused', 'busy', 'unsupported', 'updated', 'rolled-back', 'restarted', 'superseded', 'diag', 'status', 'act', 'files'].includes(x.phase)); }
  receiveAdmin(message) {
    if (message.gen && message.gen !== this.link.gen()) return;
    const st = this.adminState();
    if ((st.statuses || []).some(x => x.mid && x.mid === message.mid)) return;
    const entry = { mid: message.mid || null, id: message.id || null, phase: String(message.phase || ''), note: String(message.note || '').slice(0, 600),
      current: message.current || null, latest: message.latest || null, at: this.now(), companyAt: message.at || null, lastResult: message.lastResult || null };
    // 直查回报（2026-10-18，diag.js）：解压存最近几份，不进 statuses 的大字段；不发通知（卡片、命令行、MCP 都在等它）。
    let diags = st.diags || [];
    if (entry.phase === 'diag') {
      let result = null, error = null;
      try { result = require('./diag').decode(message.diag); } catch (e) { error = '回报解不开：' + e.message; }
      diags = [{ id: entry.id, at: this.now(), companyAt: entry.companyAt, note: entry.note, bytes: Number(message.diagBytes) || null, elapsedMs: Number(message.elapsedMs) || null,
        degraded: Array.isArray(message.degraded) ? message.degraded.map(String).slice(0, 10) : [], result, error }, ...diags.filter(x => x.id !== entry.id)].slice(0, DIAG_KEEP);
    }
    // 远程维护结果（2026-10-18 三期）：存最近 10 条，给 company_act / 卡片取
    let acts = st.acts || [];
    if (message.act && typeof message.act === 'object') acts = [{ id: entry.id, at: this.now(), phase: entry.phase, note: entry.note, act: message.act }, ...acts.filter(x => !entry.id || x.id !== entry.id)].slice(0, 10);
    // 读文件结果（2026-10-20，file-query.js）：和直查一样解压后存最近几份，不进 statuses 的大字段。
    let fileResults = st.files || [];
    if (entry.phase === 'files') {
      let result = null, error = null;
      try { result = require('./diag').decode(message.files); } catch (e) { error = '结果解不开：' + e.message; }
      fileResults = [{ id: entry.id, at: this.now(), companyAt: entry.companyAt, note: entry.note, action: message.action || null, bytes: Number(message.filesBytes) || null,
        degraded: Array.isArray(message.degraded) ? message.degraded.map(String).slice(0, 10) : [], result, error }, ...fileResults.filter(x => x.id !== entry.id)].slice(0, DIAG_KEEP);
    }
    this.store.set('hubAdmin', { ...st, statuses: [entry, ...(st.statuses || [])].slice(0, 20), diags, acts, files: fileResults,
      company: { current: entry.current || st.company?.current || null, latest: entry.latest || st.company?.latest || null, at: this.now(),
        // 公司认得的远程指令能力（新版每条回报都带；老版不带 = 不支持直查）
        caps: Array.isArray(message.caps) ? message.caps.map(String).slice(0, 20) : (entry.current && entry.current !== st.company?.current ? null : st.company?.caps || null) } });
    // 「在线」只更新版本，不打扰；直查结果由等它的地方拿；其余都发通知。
    if (entry.phase !== 'online' && entry.phase !== 'diag' && entry.phase !== 'files' && !(entry.phase === 'refused' && (this.isDiag(entry.id) || this.isFiles(entry.id)))) this.notify('公司 Hub', entry.note || entry.phase);
    this.changed();
  }
  isDiag(id) { return (this.adminState().commands || []).some(c => c.id === id && c.op === 'diag'); }
  isFiles(id) { return (this.adminState().commands || []).some(c => c.id === id && c.op === 'files'); }

  // ---- 直查公司电脑与公司 Hub（2026-10-18；公司一端 hub-admin.js diag、diag.js）----
  // MCP / 命令行默认等回报（最多约 45 秒，期间每 2.5 秒看一次通道），到了直接返回结果；超时返回编号，之后带 id 再取。
  async diag({ sections, id, lines, errors, wait = true, waitMs = DIAG_WAIT_MS } = {}) {
    if (id) return this.diagView(String(id));
    const sent = await this.hubAdmin({ op: 'diag', sections, lines, errors });
    if (!wait) return sent;
    const sleep = this.deps.sleep || (ms => new Promise(r => setTimeout(r, ms)));
    const until = Date.now() + Math.max(0, Number(waitMs) || 0);
    for (;;) {
      await this.checkNow().catch(() => {});
      const view = this.diagView(sent.id);
      if (view.status !== '等待回报') return view;
      if (Date.now() + DIAG_POLL_MS / 2 >= until) return { ...view, next: `等了 ${Math.round((Number(waitMs) || 0) / 1000)} 秒公司还没回报（公司空闲时按它的设置检查通道，默认 30 秒一次）；稍后用 company_diag 带 id「${sent.id}」再取，不要循环发新的直查。` };
      await sleep(DIAG_POLL_MS / 2);
    }
  }
  // ---- 远程维护（2026-10-18 三期）：和 diag 一样默认等回报（最多约 45 秒）----
  async act({ action, params, id, wait = true, waitMs = DIAG_WAIT_MS } = {}) {
    if (id) return this.actView(String(id));
    const sent = await this.hubAdmin({ op: 'act', action, params });
    if (!wait) return sent;
    const sleep = this.deps.sleep || (ms => new Promise(r => setTimeout(r, ms)));
    const until = Date.now() + Math.max(0, Number(waitMs) || 0);
    for (;;) {
      await this.checkNow().catch(() => {});
      const view = this.actView(sent.id);
      if (view.status !== '等待回报') return view;
      if (Date.now() + DIAG_POLL_MS / 2 >= until) return { ...view, next: `公司还没回报；稍后用 company_act 带 id「${sent.id}」取结果，不要重复发同一个动作。` };
      await sleep(DIAG_POLL_MS / 2);
    }
  }
  actView(id) {
    const st = this.adminState();
    const cmd = (st.commands || []).find(c => c.id === id && c.op === 'act');
    if (!cmd) throw new Error('找不到远程维护编号 ' + id);
    const entry = (st.acts || []).find(x => x.id === id);
    const base = { id, action: cmd.action, params: cmd.params, sentAt: cmd.sentAt, ...this.peer() };
    if (entry) return { ...base, status: entry.phase === 'refused' ? '公司没处理' : '已执行', receivedAt: entry.at, note: entry.note, act: entry.act };
    const status = (st.statuses || []).find(x => x.id === id);
    if (status) return { ...base, status: status.phase === 'refused' ? '公司没处理' : '公司报错', note: status.note };
    return { ...base, status: '等待回报' };
  }
  diagEntry(id) { return (this.adminState().diags || []).find(x => x.id === id) || null; }
  // 给 Agent / 界面的结果：编号、状态、摘要与完整内容。
  diagView(id) {
    const st = this.adminState();
    const cmd = (st.commands || []).find(c => c.id === id && c.op === 'diag');
    if (!cmd) throw new Error('找不到直查编号 ' + id);
    const entry = this.diagEntry(id);
    const status = (st.statuses || []).find(x => x.id === id && x.phase !== 'diag');
    const base = { id, sections: cmd.sections || null, sentAt: cmd.sentAt, ...this.peer() };
    if (entry) {
      if (entry.error) return { ...base, status: '回报解不开', error: entry.error, note: entry.note };
      return { ...base, status: '已回报', receivedAt: entry.at, waitedSec: Math.round((entry.at - cmd.sentAt) / 1000), elapsedMs: entry.elapsedMs, bytes: entry.bytes,
        degraded: entry.degraded, summary: entry.note, diag: entry.result };
    }
    if (status) return { ...base, status: status.phase === 'refused' ? '公司没处理' : '公司报错', note: status.note };
    return { ...base, status: '等待回报' };
  }
  // 界面用：最近一份直查（没有带 id 时）。
  diagLatest(id) {
    const st = this.adminState();
    const want = id || (st.commands || []).find(c => c.op === 'diag')?.id;
    if (!want) return { status: '还没查过' };
    try { return this.diagView(want); } catch (error) { return { status: '还没查过', error: error.message }; }
  }
  diagPending() { return (this.adminState().commands || []).some(c => ['diag', 'act', 'files'].includes(c.op) && this.now() - c.sentAt < DIAG_WAIT_MS * 2 && !this.adminDone(c.id)); }

  // ---- 读公司电脑上的文件（2026-10-20 田哥；公司一端 file-query.js）----
  // 和直查一样默认等回报（最多约 45 秒，期间每 2.5 秒看一次通道）；到了直接返回内容，超时返回编号，之后带 id 再取。
  async files({ action, params, id, wait = true, waitMs = DIAG_WAIT_MS } = {}) {
    if (id) return this.filesView(String(id));
    const sent = await this.hubAdmin({ op: 'files', action, params });
    if (!wait) return sent;
    const sleep = this.deps.sleep || (ms => new Promise(r => setTimeout(r, ms)));
    const until = Date.now() + Math.max(0, Number(waitMs) || 0);
    for (;;) {
      await this.checkNow().catch(() => {});
      const view = this.filesView(sent.id);
      if (view.status !== '等待回报') return view;
      if (Date.now() + DIAG_POLL_MS / 2 >= until) return { ...view, next: `等了 ${Math.round((Number(waitMs) || 0) / 1000)} 秒公司还没回报（公司空闲时按它的设置检查通道，默认 30 秒一次）；稍后用 company_files 带 id「${sent.id}」再取，不要重复发同一条。` };
      await sleep(DIAG_POLL_MS / 2);
    }
  }
  filesEntry(id) { return (this.adminState().files || []).find(x => x.id === id) || null; }
  filesView(id) {
    const st = this.adminState();
    const cmd = (st.commands || []).find(c => c.id === id && c.op === 'files');
    if (!cmd) throw new Error('找不到读文件编号 ' + id);
    const entry = this.filesEntry(id);
    const status = (st.statuses || []).find(x => x.id === id && x.phase !== 'files');
    const base = { id, action: cmd.action, params: cmd.params, sentAt: cmd.sentAt, ...this.peer() };
    if (entry) {
      if (entry.error) return { ...base, status: '结果解不开', error: entry.error, note: entry.note };
      return { ...base, status: '已回报', receivedAt: entry.at, waitedSec: Math.round((entry.at - cmd.sentAt) / 1000), bytes: entry.bytes, degraded: entry.degraded,
        summary: entry.note, result: entry.result };
    }
    if (status) return { ...base, status: status.phase === 'refused' ? '公司没处理' : '公司报错', note: status.note };
    return { ...base, status: '等待回报' };
  }
  // 界面用：最近一份读文件结果（没有带 id 时）。
  filesLatest(id) {
    const st = this.adminState();
    const want = id || (st.commands || []).find(c => c.op === 'files')?.id;
    if (!want) return { status: '还没读过' };
    try { return this.filesView(want); } catch (error) { return { status: '还没读过', error: error.message }; }
  }
  // 告诉公司哪些问题的发问会话还在活动（2026-10-16，设计第 1 块）：答完的公司会话据此多保温一会儿。
  // 只报最近 3 小时内有回执的线索；集合变了立刻报，没变每 10 分钟报一次，没有就不报。
  async reportAskers() {
    const now = this.now(), gen = this.link.gen();
    const active = [];
    for (const row of this.store.db.prepare('SELECT payload FROM bridge_threads WHERE updated > ? ORDER BY updated DESC LIMIT 100').all(now - 3 * 3600000)) {
      let t; try { t = JSON.parse(row.payload); } catch { continue; }
      if (!t || t.gen !== gen || t.state === 'cancelled' || !t.sessionId) continue;
      const s = this.deps.getSession(t.sessionId);
      if (!s) continue;
      const lastActive = Math.max(Number(s.lastMessageTime) || 0, Number(s.lastCompletedAt) || 0, Number(s.lastRunStartedAt) || 0);
      if (this.sessionBusy(t.sessionId) || now - lastActive < 15 * 60000) active.push(t.id);
    }
    const key = active.sort().join(',');
    const last = this.store.get('askerReport') || {};
    if (!active.length && !last.key) return;
    if (key === last.key && now - (last.at || 0) < 10 * 60000) return;
    await this.link.send('asker', { gen, threads: active });
    this.store.set('askerReport', { key, at: now });
  }
  view(sessionId, { thread }) {
    let list;
    if (thread) {
      const t = this.thread(String(thread));
      if (!t || t.sessionId !== sessionId) throw new Error('找不到本会话的编号 ' + thread);
      list = [t];
    } else list = this.store.db.prepare('SELECT payload FROM bridge_threads WHERE session=? ORDER BY updated DESC LIMIT 10').all(sessionId).map(r => JSON.parse(r.payload));
    return { ...this.peer(), companyModels: this.modelsBrief(), threads: list.map(t => ({ thread: t.id, title: t.title, state: STATE_LABEL[t.state] || t.state, model: t.model || '公司默认',
      rounds: t.rounds.map(r => ({ round: r.round, question: r.question, status: STATE_LABEL[r.status] || r.status,
        ...(r.note && !r.reply && !r.error ? { note: r.note } : {}), ...(r.meta?.actualModel || r.meta?.model ? { usedModel: r.meta.actualModel || r.meta.model } : {}),
        ...(r.meta?.accountAlias ? { usedAccount: r.meta.accountAlias } : {}), ...(r.account ? { account: r.account } : {}), ...(r.meta?.rehomedFrom ? { rehomedFrom: r.meta.rehomedFrom } : {}),
        reply: r.reply || null, error: r.error || null })) })) };
  }
  peer() {
    const st = this.link.status();
    const seen = st.peerSeen ? Date.parse(st.peerSeen) : null;
    const minutes = seen ? Math.max(0, Math.round((this.now() - seen) / 60000)) : null;
    return { companyOnline: minutes != null && minutes <= 3, companyLastSeen: minutes == null ? '还没在线过' : minutes <= 1 ? '刚刚在线' : `${minutes} 分钟前在线` };
  }

  // ---- 特战队邀请码与成员管理（2026-10-18）----
  invite() { const v = this.store.get('teamInvite'); return v && v.url ? v : null; }
  setInvite(code) {
    const next = parseInvite(code);
    const c = this.link.config();
    if ((c.state || 'none') !== 'none' && c.baseUrl !== next.url) throw new Error('已经配对或正在配对：先解除配对（或取消配对码），再换邀请码');
    this.store.set('teamInvite', { ...next, savedAt: this.now() });
    this.installSkills();
    this.changed();
    return this.status();
  }
  clearInvite() {
    if ((this.link.config().state || 'none') !== 'none') throw new Error('先解除配对，再清除邀请码');
    this.store.set('teamInvite', null); this.changed();
    return this.status();
  }
  installSkills() {
    if (!this.invite()) return null;
    try {
      const prev = this.store.get('teamSkills') || {};
      const known = [...new Set([...(prev.known || []), ...(prev.installed || [])])];
      const report = (this.deps.installTeamSkills || installTeamSkills)({ homeDir: this.deps.homeDir, known });
      this.store.set('teamSkills', { ...report, known: [...new Set([...known, ...report.installed])], at: this.now() });
      return report;
    } catch (error) { console.warn('[company-bridge] team skills', error.message); return null; }
  }
  teamMembers() { return this.team.members(); }
  teamCreate(label) { return this.team.create(label); }
  teamRevoke(id) { return this.team.revoke(id); }
  teamStatus() {
    const inv = this.invite();
    let inbox = false; try { inbox = !!this.deps.relayBaseUrl?.(); } catch {}
    const skills = this.store.get('teamSkills');
    return { invite: inv ? { label: inv.label || '', host: new URL(inv.url).host, savedAt: inv.savedAt || null } : null, inbox,
      needsInvite: !inv && !inbox && !this.deps.bridgeApiUrl?.(), admin: this.team.available(),
      skills: skills ? { installed: skills.installed, updated: skills.updated, kept: skills.kept, removed: skills.removed || [], errors: skills.errors, known: skills.known || [], at: skills.at } : null };
  }

  // ---- 配对 ----
  // 通道地址：测试指定的 → 邀请码（特战队同事）→ 公司收件箱配置（组长本机，原样）。
  baseUrl() {
    const direct = this.deps.bridgeApiUrl?.();
    if (direct) return direct.replace(/\/+$/, '');
    const inv = this.invite();
    if (inv) return inv.url.replace(/\/+$/, '');
    const url = this.deps.relayBaseUrl?.();
    if (!url) throw new Error('还没有通道地址：先粘贴组长发的邀请码');
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
    this.consult.cancelOpen(why);
    for (const t of this.openThreads()) this.saveThread({ ...t, state: 'cancelled', cancelNote: why, rounds: t.rounds.map(r => (r.reply || r.error) ? r : { ...r, status: 'cancelled' }) });
  }

  // ---- 轮询与投递 ----
  polling() {
    const state = this.link.config().state;
    if (!state || state === 'none') return { intervalSeconds: 0, active: false, activeUntil: null };
    // 远程更新指令发出 2 小时内还没有结果：加快检查，及时收到进度。
    const adminWaiting = (this.adminState().commands || []).some(c => !['status', 'diag', 'act'].includes(c.op) && this.now() - c.sentAt < 2 * 3600000 && !this.adminDone(c.id));
    if (state === 'paired' && this.diagPending()) return { intervalSeconds: DIAG_POLL_MS / 1000, active: true, activeUntil: null };
    const active = state === 'pending' || adminWaiting || this.openThreads().length > 0 || this.consult.openThreads().length > 0;
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
      // 公司的求助：先把公司回执送进家里会话（上面），再看家里会话答完没有、派发新的求助。
      if (!this.consultBusy) this.consultBusy = this.consult.advance().finally(() => { this.consultBusy = null; });
      await this.consultBusy;
      await this.images.tick();
      try { await this.reportAskers(); } catch { /* 下一轮再报 */ }
    }
  }
  checkNow() { this.nextPullAt = 0; return this.tick({ force: true }).then(() => this.status()); }

  async receive(message) {
    if (await this.images.receive(message)) return;
    if (message.type === 'hello') {
      if (this.link.completeAsHome(message)) {
        this.store.set('pairingCode', null);
        await this.link.flush().catch(() => {});
        this.notify('已和公司接通', '配对完成。之后新开的 SuperRAN 相关会话会带上「问公司」工具，其他会话可用 company-ask 命令。');
      }
      return;
    }
    if (this.consult.receive(message)) return;
    if (message.type === 'hub-admin-status') { this.receiveAdmin(message); return; }
    // 公司的模型表（2026-10-18）：单独推来的，或随回执、随「指定模型没有可用的号」的报错带来的。
    if (message.type === 'models') { this.receiveModels(message.table, message.gen); return; }
    if (message.models) this.receiveModels(message.models, message.gen);
    const t = this.thread(String(message.thread || ''));
    if (!t || t.state === 'cancelled' || (message.gen && t.gen && message.gen !== t.gen)) return;
    const round = Number(message.round) || 0;
    let changed = false;
    const rounds = t.rounds.map(r => {
      if (r.round !== round) return r;
      if (message.type === 'status') {
        if (r.reply) return r;
        changed = true;
        if (message.state === 'error') return { ...r, status: 'error', error: String(message.note || '公司报错'), errorAt: this.now(), ...guard.FRESH_DELIVERY };
        // 公司重试了失败的这一轮：清掉上次的报错，等新的回执。
        // 通道串的进度线（2026-10-16）：记下公司第一次说「已收到」和「开始处理」的时间，算每段耗时。
        const running = message.state === 'running';
        return { ...r, status: running ? 'running' : 'received', note: message.note || null, error: null,
          ackAt: r.ackAt || this.now(), ...(running && !r.startedAt ? { startedAt: this.now() } : {}) };
      }
      if (message.type === 'reply') {
        // 同一轮只收第一份回执（发件箱重发、服务端重放都不会让它再投递一次）。
        if (r.reply) return r;
        changed = true;
        return { ...r, status: 'replied', reply: String(message.text || ''), replyMid: message.mid, replyAt: this.now(), meta: message.meta || null, error: null, ...guard.FRESH_DELIVERY };
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
          // 重投前核对（delivery-guard.js）：这一轮之后会话已经发出更晚的一轮，或原生记录里已有这条回执，就不再投。
          // 标记是回执第一行全文（真回执「…第 N 轮】」、报错「…· 没答上】」），之前投过的「没答上」不会被当成真回执（复审 2026-10-18）。
          const done = guard.alreadyDelivered(this.thread(t.id) || t, r, { meta: session, marker: replyMessage(t, r).split('\n')[0], now: this.now(),
            ...(this.deps.transcriptHasText ? { hasText: this.deps.transcriptHasText } : {}) });
          if (done) { this.markDelivery(t, r, done); continue; }
          const receipt = await this.deps.sendPrompt(t.sessionId, replyMessage(t, r), randomUUID());
          // 明确没发进去才算失败；确认迟到、结果未知都按已送达，不重发（重发会让 Agent 收到两遍）。
          // 发送入口报「只差空白」（content-mismatch）也是内容已进会话（2026-10-18 Q-1018-07：制表符被换成空格，重投了 6 次）。
          if (guard.explicitFailure(receipt)) throw Object.assign(new Error(receipt?.error || receipt?.message || '没有发进会话'), { counted: !!receipt && !receipt.notSent });
          this.markDelivery(t, r, { delivered: true, deliveredAt: this.now(), deliveryError: null, deliveryUncertain: receipt.ok === false || null,
            ...(guard.contentArrivedWithDiff(receipt) ? { deliveryNote: guard.MISMATCH_NOTE } : {}) });
        } catch (error) {
          // 明确失败最多重投 3 次，之后停止并在「公司联动」列表里标「可能已送达，未能确认」。
          const f = guard.failure(this.thread(t.id)?.rounds.find(x => x.round === r.round) || r, error.message, { notSent: !error.counted, now: this.now() });
          this.markDelivery(t, r, f.patch, f.final);
        }
      }
    }
  }
  markDelivery(t, r, patch, final = true) {
    const fresh = this.thread(t.id) || t;
    const rounds = fresh.rounds.map(x => x.round === r.round
      ? { ...x, ...patch, ...(final && !patch.delivered ? { delivered: true, deliveredAt: null } : {}), nextTryAt: final ? null : patch.nextTryAt || this.now() + 60000 } : x);
    this.saveThread({ ...fresh, rounds }); this.changed();
  }

  status() {
    const c = this.link.config(), st = this.link.status();
    let baseUrl = null; try { baseUrl = this.baseUrl(); } catch {}
    return {
      ok: true, role: 'home', settings: this.settings(), baseUrl: baseUrl && baseUrl.replace(/\/hub-link\/[^/]+\//, '/hub-link/…/'), team: this.teamStatus(),
      link: { state: c.state || 'none', pairedAt: c.pairedAt || null, pairingCode: c.state === 'pending' ? this.store.get('pairingCode') : null, outbox: this.link.pendingOutbox() },
      net: { lastOkAt: st.lastOkAt || null, lastError: st.lastError || null, gate: st.gate || null, peerSeen: st.peerSeen || null }, peer: this.peer(),
      now: this.now(), nextPullAt: this.nextPullAt, polling: this.polling(),
      threads: this.threads(60).map(t => ({ ...t, session: { open: !!this.deps.getSession(t.sessionId), title: this.meta(t.sessionId).title || t.sessionTitle || null } })),
      consults: this.consult.view(),
      images: this.images.status(),
      companyHub: this.companyHub(),
      companyModels: this.companyModels(),
      // 直查只给轻量信息（完整内容走 bridge:diag-result）
      companyDiag: (() => { const d = (this.adminState().diags || [])[0]; return { pending: this.diagPending(), latest: d ? { id: d.id, at: d.at, note: d.note, error: d.error || null } : null }; })(),
    };
  }
  notify(title, text, sessionId = null) { try { this.deps.onNotify?.({ title: '公司联动 · ' + title, text, sessionId }); } catch {} }
  changed() { try { this.deps.onChanged?.(); } catch {} }
  close() { clearInterval(this.timer); this.timer = null; try { this.server?.close(); } catch {} try { this.store.close(); } catch {} }
}

module.exports = { HomeBridge, replyMessage, deriveState, IDLE_POLL_MS };
