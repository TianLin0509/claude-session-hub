'use strict';
// 公司 Hub 一端的常驻助理（2026-10-15）：像脚本一样定时去通道里取家里的问题，
// 每个问题新开一个 CodeAgent 会话只读代码作答，答完自动发回；同一问题的追问送进同一个会话，
// 它记得上一轮读过什么。家里一个 Agent 对应这里一个 CodeAgent 会话，不同问题之间上下文互不干扰。
//
// 底线写在给 CodeAgent 的说明里（页面上可以改）：只读不运行、不回传源码。发回前再查一遍：
// 有大段代码块就请它改写成文字，改完仍有就把那几段换成「已省略」再发。
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { AssistantStore } = require('../hub-assistant/store');
const { claimTimers, ownsTimers } = require('../hub-assistant/timer-owner');
const { BridgeLink } = require('./link');

const PURPOSE = 'company-bridge';
const DEFAULT_INSTRUCTIONS = [
  '你是公司电脑上的代码阅读助手，替家里的 Agent 回答关于公司代码的问题。请遵守：',
  '1. 只读代码：可以打开、搜索、阅读文件；不运行程序或测试，不修改、新建、删除任何文件，不提交。',
  '2. 不回传源码：用文字和简短伪代码讲清逻辑，不成段粘贴源码。可以写函数名、文件相对路径和行号，方便对方追问。',
  '3. 先写结论，再逐条说明；分清「读到了」和「推测」。',
  '4. 末尾写「把握程度」（高 / 中 / 低及原因）和「没读到的部分」。',
  '5. 篇幅控制在 2 万字以内。',
].join('\n');
const DEFAULT_SETTINGS = Object.freeze({ enabled: true, codeRoots: [], instructions: DEFAULT_INSTRUCTIONS, model: '', effort: 'high', maxParallel: 2, pollSeconds: 30 });
const EFFORTS = ['low', 'medium', 'high', 'max'];
const MAX_REPLY_CHARS = 40000;
const BIG_BLOCK_LINES = 15;
// 发出后会话停下、却一直没读到回答：判定没答上，告诉家里。
const NO_ANSWER_MS = 10 * 60000;
const short = (s, n = 28) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

// 找出成段的代码块（``` 围起来、超过 BIG_BLOCK_LINES 行）。
function bigCodeBlocks(text) {
  const blocks = [];
  const re = /```[^\n]*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const lines = m[1].split('\n').filter(l => l.trim()).length;
    if (lines > BIG_BLOCK_LINES) blocks.push({ start: m.index, end: m.index + m[0].length, lines });
  }
  return blocks;
}
function stripBigBlocks(text) {
  let out = String(text || '');
  for (const b of bigCodeBlocks(out).reverse()) out = out.slice(0, b.start) + `（此处原有 ${b.lines} 行代码，按规则不回传）` + out.slice(b.end);
  return out;
}

class CompanyBridge {
  constructor(deps) {
    this.deps = deps;
    this.store = new AssistantStore(path.join(deps.dataDir, 'company-bridge'));
    this.store.db.exec('CREATE TABLE IF NOT EXISTS bridge_threads(id TEXT PRIMARY KEY,payload TEXT NOT NULL,state TEXT NOT NULL,updated INTEGER NOT NULL)');
    this.link = new BridgeLink({ side: 'company', store: this.store, fetchImpl: deps.fetchImpl, now: () => this.now() });
    this.busy = null; this.timer = null; this.nextPullAt = 0;
    if (!deps.noTimer) claimTimers(this.store);
  }
  now() { return this.deps.now ? this.deps.now() : Date.now(); }
  settings() {
    const s = this.store.get('settings') || {};
    return { ...DEFAULT_SETTINGS, ...s, codeRoots: Array.isArray(s.codeRoots) ? s.codeRoots : [] };
  }
  setSettings(patch = {}) {
    const next = this.settings();
    if ('enabled' in patch) next.enabled = patch.enabled === true;
    if ('codeRoots' in patch) {
      const list = (Array.isArray(patch.codeRoots) ? patch.codeRoots : String(patch.codeRoots || '').split(/\r?\n/)).map(s => String(s).trim()).filter(Boolean);
      if (list.length > 20) throw new Error('代码位置最多 20 个');
      next.codeRoots = list;
    }
    if ('instructions' in patch) { const t = String(patch.instructions || '').trim(); if (t.length > 8000) throw new Error('说明太长（上限 8000 字）'); next.instructions = t || DEFAULT_INSTRUCTIONS; }
    if ('model' in patch) next.model = String(patch.model || '').trim().slice(0, 96);
    if ('effort' in patch) { if (!EFFORTS.includes(patch.effort)) throw new Error('思考深度只能是 low / medium / high / max'); next.effort = patch.effort; }
    if ('maxParallel' in patch) { const n = Number(patch.maxParallel); if (!Number.isInteger(n) || n < 1 || n > 4) throw new Error('同时处理的问题数只能是 1–4'); next.maxParallel = n; }
    if ('pollSeconds' in patch) { const n = Number(patch.pollSeconds); if (!Number.isInteger(n) || n < 10 || n > 600) throw new Error('检查间隔只能是 10–600 秒'); next.pollSeconds = n; }
    this.store.set('settings', next); this.changed();
    return next;
  }

  threads() { return this.store.db.prepare('SELECT payload FROM bridge_threads ORDER BY updated DESC LIMIT 200').all().map(r => JSON.parse(r.payload)); }
  thread(id) { const r = this.store.db.prepare('SELECT payload FROM bridge_threads WHERE id=?').get(id); return r ? JSON.parse(r.payload) : null; }
  saveThread(t) {
    t.updatedAt = this.now();
    this.store.db.prepare('INSERT INTO bridge_threads VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,state=excluded.state,updated=excluded.updated').run(t.id, JSON.stringify(t), t.state, t.updatedAt);
    return t;
  }

  start() {
    if (this.deps.noTimer || this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(e => console.warn('[company-bridge] tick', e.message)); }, 5000);
    this.timer.unref?.();
  }
  async tick({ force = false } = {}) {
    if (!force && !this.deps.noTimer && !ownsTimers(this.store)) return;
    if (this.busy) return this.busy;
    this.busy = (async () => {
      const s = this.settings();
      if (!this.link.paired()) return;
      if (force || this.now() >= this.nextPullAt) {
        this.nextPullAt = this.now() + s.pollSeconds * 1000;
        try { await this.link.pull(message => this.receive(message)); } catch {}
        this.changed();
      }
      if (s.enabled) { await this.advance(); }
    })().finally(() => { this.busy = null; });
    return this.busy;
  }
  checkNow() { this.nextPullAt = 0; return this.tick({ force: true }).then(() => this.status()); }

  async pair(code) {
    await this.link.acceptPairing(code, { app: 'company-hub' });
    this.changed();
    return this.status();
  }
  unpair() { this.link.unpair(); this.changed(); return this.status(); }

  receive(message) {
    if (message.type === 'welcome') {
      const c = this.link.config();
      if (c.state === 'waiting-welcome') this.link.saveConfig({ ...c, state: 'paired', pairedAt: this.now() });
      this.notify('已和家里接通', '家里的 Agent 现在可以向这台电脑提问了。');
      return;
    }
    if (message.type !== 'ask' && message.type !== 'followup') return;
    const id = String(message.thread || '').slice(0, 40);
    if (!/^[A-Za-z0-9-]{3,40}$/.test(id)) return;
    const question = String(message.question || '').slice(0, 60000);
    const round = Number(message.round) || 1;
    const existing = this.thread(id);
    if (existing && existing.rounds.some(r => r.round === round)) return; // 重复投递
    const t = existing || { id, title: short(message.title || question, 40), from: message.from || null, state: 'queued', sessionId: null, createdAt: this.now(), rounds: [] };
    t.rounds.push({ round, question, receivedAt: this.now(), mid: message.mid });
    t.state = 'queued';
    this.saveThread(t);
    void this.link.send('status', { thread: id, round, state: 'received', note: '公司已收到' }).catch(() => {});
    this.notify(existing ? '家里追问' : '家里提问', `${id}：${short(question, 60)}`, t.sessionId);
  }

  sessionBusy(id) {
    const s = id && this.deps.getSession(id);
    if (!s) return false;
    return !!this.deps.isAgentTurnActive?.(id) || require('../session-runtime-truth').sessionRuntimeIsActive(s) || s.status === 'running' || !!this.deps.hasPendingPrompt?.(id);
  }
  lastFinal(sessionId) {
    const meta = this.deps.getSession(sessionId) || this.deps.getSessionMetadata?.(sessionId);
    if (!meta) return null;
    const records = this.deps.readFinals ? this.deps.readFinals(meta) : [];
    return records && records.length ? records[records.length - 1] : null;
  }

  // 推进：在办的轮次看有没有答完；排队的轮次按并发上限开会话或续问。
  async advance() {
    const s = this.settings();
    for (const t of this.threads().filter(x => x.state === 'running')) await this.collect(t);
    let free = s.maxParallel - this.threads().filter(x => x.state === 'running').length;
    const queued = this.threads().filter(x => x.state === 'queued').sort((a, b) => a.createdAt - b.createdAt);
    for (const t of queued) {
      if (free <= 0) break;
      // 追问时原会话还在答上一轮（例如改写源码），等它停下。
      if (t.sessionId && this.sessionBusy(t.sessionId)) continue;
      await this.dispatch(t);
      free -= 1;
    }
  }

  promptFor(t, r, s) {
    if (r.rewrite) return '你上一条回答里有成段的源码。按规则不能回传源码：请把整份回答重写一遍，代码部分改成文字说明或几行伪代码，其余内容保持。直接输出重写后的完整回答。';
    const roots = s.codeRoots.length ? s.codeRoots.map(p => '- ' + p).join('\n') : '- （未设置，请在当前目录里找）';
    if (r.round === 1) {
      return [s.instructions, '', '代码位置：', roots, '', `## 家里的问题（编号 ${t.id}）`, '', r.question].join('\n');
    }
    return [`## 家里的追问（编号 ${t.id}，第 ${r.round} 轮）`, '', r.question, '', '（规则同前：只读代码、不回传源码、末尾写把握程度和没读到的部分。）'].join('\n');
  }

  async dispatch(t) {
    const s = this.settings();
    const r = t.rounds.find(x => !x.sentAt && !x.reply);
    if (!r) { this.saveThread({ ...t, state: 'replied' }); return; }
    try {
      let sessionId = t.sessionId;
      if (!sessionId || (!this.deps.getSession(sessionId) && !this.deps.getSessionMetadata?.(sessionId))) {
        sessionId = randomUUID();
        const cwd = s.codeRoots.find(p => this.deps.isDirectory ? this.deps.isDirectory(p) : true) || this.deps.fallbackCwd;
        const opts = { id: sessionId, cwd, title: '家里 · ' + short(t.title, 22), purpose: PURPOSE, autonomous: true, noInheritCursor: true,
          effort: s.effort, ...(s.model ? { model: s.model } : {}), addDirs: s.codeRoots.filter(p => p !== cwd) };
        const created = await this.deps.createSession('codeagent', opts);
        if (!created || created.id !== sessionId) throw new Error('会话创建结果与预留编号不一致');
        t = this.saveThread({ ...t, sessionId });
      } else if (!this.deps.getSession(sessionId)) {
        await this.deps.resumeSession(sessionId);
        if (!this.deps.getSession(sessionId)) throw new Error('原会话没能恢复');
      }
      const before = this.lastFinal(sessionId);
      const receipt = await this.deps.sendPrompt(sessionId, this.promptFor(t, r, s), randomUUID());
      if (!receipt || receipt.ok === false || receipt.notSent) throw new Error(receipt?.error || '问题没有发进会话');
      const rounds = t.rounds.map(x => x.round === r.round ? { ...x, sentAt: this.now(), firstSentAt: x.firstSentAt || this.now(), baseline: before ? before.id : null, error: null } : x);
      this.saveThread({ ...t, rounds, state: 'running' });
      if (!r.rewrite) void this.link.send('status', { thread: t.id, round: r.round, state: 'running', note: '公司 CodeAgent 正在读代码' }).catch(() => {});
    } catch (error) {
      const rounds = t.rounds.map(x => x.round === r.round ? { ...x, error: error.message, failedAt: this.now() } : x);
      this.saveThread({ ...t, rounds, state: 'failed' });
      void this.link.send('status', { thread: t.id, round: r.round, state: 'error', note: '公司这边没能开始：' + short(error.message, 120) }).catch(() => {});
      this.notify('没能开始', `${t.id}：${short(error.message, 80)}`, t.sessionId);
    }
    this.changed();
  }

  async collect(t) {
    const r = t.rounds.find(x => x.sentAt && !x.reply && !x.error);
    if (!r) { this.saveThread({ ...t, state: t.rounds.some(x => !x.sentAt) ? 'queued' : 'replied' }); return; }
    if (this.sessionBusy(t.sessionId)) return;
    const final = this.lastFinal(t.sessionId);
    if (!final || final.id === r.baseline) {
      if (this.now() - r.sentAt > NO_ANSWER_MS && !this.deps.getSession(t.sessionId)) return this.failRound(t, r, '会话已关闭，没有读到回答');
      if (this.now() - r.sentAt > NO_ANSWER_MS * 3) return this.failRound(t, r, '会话停下了，但一直没读到回答');
      return;
    }
    let text = String(final.text || '').trim();
    if (bigCodeBlocks(text).length && !r.rewriteAsked) {
      // 第一次发现成段源码：请它自己改写（同一会话），改写稿出来再发。
      const rounds = t.rounds.map(x => x.round === r.round ? { ...x, rewriteAsked: true, sentAt: null, rewrite: true } : x);
      this.saveThread({ ...t, rounds, state: 'queued' });
      return;
    }
    const removed = bigCodeBlocks(text).length;
    if (removed) text = stripBigBlocks(text);
    if (text.length > MAX_REPLY_CHARS) text = text.slice(0, MAX_REPLY_CHARS) + `\n\n（回答超过 ${MAX_REPLY_CHARS} 字，后面截掉了；需要的话请追问后半部分。）`;
    const session = this.deps.getSession(t.sessionId);
    const meta = { model: session?.currentModel?.id || session?.model || null, elapsedSec: Math.round((this.now() - (r.firstSentAt || r.sentAt)) / 1000), codeBlocksRemoved: removed };
    await this.link.send('reply', { thread: t.id, round: r.round, text, meta });
    const rounds = t.rounds.map(x => x.round === r.round ? { ...x, reply: text, replyAt: this.now(), meta } : x);
    this.saveThread({ ...t, rounds, state: rounds.some(x => !x.sentAt) ? 'queued' : 'replied' });
    this.notify('已回执', `${t.id} 第 ${r.round} 轮：${short(text, 60)}`, t.sessionId);
  }
  failRound(t, r, why) {
    const rounds = t.rounds.map(x => x.round === r.round ? { ...x, error: why, failedAt: this.now() } : x);
    this.saveThread({ ...t, rounds, state: 'failed' });
    void this.link.send('status', { thread: t.id, round: r.round, state: 'error', note: why }).catch(() => {});
    this.notify('没答上', `${t.id}：${why}`, t.sessionId);
  }
  // 页面上点「重试」：失败的那一轮重新排队（同一会话还在就续用）。
  retry(id) {
    const t = this.thread(id);
    if (!t) throw new Error('找不到这个问题');
    const rounds = t.rounds.map(x => x.error ? { ...x, error: null, sentAt: null, failedAt: null } : x);
    this.saveThread({ ...t, rounds, state: 'queued' }); this.changed();
    void this.tick({ force: true });
    return this.status();
  }

  status() {
    const c = this.link.config(), st = this.link.status();
    return {
      ok: true, role: 'company', settings: this.settings(), defaultInstructions: DEFAULT_INSTRUCTIONS,
      link: { state: c.state || 'none', baseUrl: c.baseUrl || null, pairedAt: c.pairedAt || null, outbox: this.link.pendingOutbox() },
      net: { lastOkAt: st.lastOkAt || null, lastError: st.lastError || null, gate: st.gate || null, peerSeen: st.peerSeen || null },
      nextPullAt: this.nextPullAt, now: this.now(),
      threads: this.threads().map(t => ({ ...t, session: t.sessionId ? { open: !!this.deps.getSession(t.sessionId), busy: this.sessionBusy(t.sessionId) } : null })),
      models: this.deps.modelOptions ? this.deps.modelOptions() : [],
    };
  }
  notify(title, text, sessionId = null) { try { this.deps.onNotify?.({ title: '家里联动 · ' + title, text, sessionId }); } catch {} }
  changed() { try { this.deps.onChanged?.(); } catch {} }
  close() { clearInterval(this.timer); this.timer = null; try { this.store.close(); } catch {} }
}

module.exports = { CompanyBridge, DEFAULT_INSTRUCTIONS, PURPOSE, bigCodeBlocks, stripBigBlocks };
