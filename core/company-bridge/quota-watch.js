'use strict';
// 额度感知的「看」（2026-10-18，公司一端）：定时被动读取开着的 CodeAgent 会话（通道会话、号池与个人账号上的会话都算），
// 识别「额度用完 / 限流 / 余额不足」类报错，把对应的号标「避让中」（core/codeagent-quota.js）；顺带读 Stats 面板的 Credit。
//
// 来源（田哥 2026-10-18：卡片视图读的是原生记录，报错就在原生记录里）：
//   1. 原生记录（为主）：只看 API 错误消息——结构化标记（isApiErrorMessage、带 error 字段、模型是 <synthetic> 的回答）
//      或正文以「API Error」开头的回答/系统消息。用户消息（问题里可能引用报错原文）和普通回答正文不看。
//   2. 终端屏幕（补充）：同 diag.js 读法（会话缓冲 → @xterm/headless 渲染），只看去掉框线、圆点后以「API Error」开头的行；
//      同一行一直留在屏幕上只算一次，滚走后再出现才再算。Credit 读数也从这里来（codeagent-screen-stats.js）。
// 底线：只读缓冲和记录文件，绝不往会话发按键或命令；识别到的报错原文脱敏后留最近 50 条，供直查 errors 段取回核对规则。
const fs = require('node:fs');
const crypto = require('node:crypto');
const Q = require('../codeagent-quota');

const SCAN_MS = 20000;
const MAX_SESSIONS = 16;
const FIRST_TAIL_BYTES = 128 * 1024;
const READ_MAX_BYTES = 2 * 1024 * 1024;
const KEEP_ERRORS = 50;
const API_ERROR_HEAD = /^\s*(?:[│┃|⎿●•*>·-]\s*)*API\s*Error/i;
const ERROR_HEAD = /^\s*(?:[│┃|⎿●•*>·-]\s*)*(?:API\s*Error|Error\b|错误|请求失败)/i;
const hash = s => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);

// 一条原生记录（Claude 格式 jsonl 的一行）是不是 API 错误消息；是就返回 { text, structured, at }。
function apiErrorEntry(o) {
  if (!o || typeof o !== 'object' || o.type === 'user') return null;
  const c = o.message && o.message.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b && b.type === 'text').map(b => String(b.text || '')).join('\n')
    : typeof o.content === 'string' ? o.content : typeof o.error === 'string' && !o.message ? o.error : '';
  const structured = o.isApiErrorMessage === true || (o.type === 'assistant' && !!o.error) || (o.message && o.message.model === '<synthetic>' && API_ERROR_HEAD.test(text))
    || (o.type === 'system' && /error/i.test(String(o.level || o.subtype || '')));
  if (!structured && !((o.type === 'assistant' || o.type === 'system') && API_ERROR_HEAD.test(text))) return null;
  if (!String(text).trim()) return null;
  return { text: String(text), structured, at: Date.parse(o.timestamp) || 0, uuid: o.uuid || null };
}

class QuotaWatch {
  constructor(bridge) {
    this.bridge = bridge;
    this.lastScanAt = 0;
    this.offsets = new Map();   // 会话 → 原生记录已读到的位置
    this.visible = new Map();   // 会话 → 上一次屏幕上命中的行（同一行留在屏幕上只算一次）
    this.screenSig = new Map(); // 会话 → 上一次缓冲的指纹（没变就不重新渲染）
    this.hits = new Map();      // 会话 → 最近一次识别到的额度报错 { at, key, ruleId, kind, text, resetAt }
  }
  get deps() { return this.bridge.deps; }
  get dataDir() { return this.deps.dataDir; }
  now() { return this.bridge.now(); }
  settings() {
    const s = this.bridge.settings();
    return { on: s.quotaGuard !== false, floor: Number(s.creditFloor) || 0, retryMs: Math.max(5, Number(s.quotaRetryMinutes) || 60) * 60000 };
  }
  sessionKey(s) { return s && s.codeagentPoolAccount ? String(s.codeagentPoolAccount) : 'personal'; }

  // 定时调用（通道 tick）；force：立即看一次（checkNow / 单测）。返回 { marked, cleared }（号的键）。
  async scan({ force = false } = {}) {
    const now = this.now();
    if (this.scanning || (!force && now - this.lastScanAt < SCAN_MS)) return { marked: [], cleared: [] };
    const cfg = this.settings();
    if (!cfg.on) return { marked: [], cleared: [] };
    this.scanning = true; this.lastScanAt = now;
    const marked = [], cleared = [];
    try {
      const { rules } = Q.loadRules(this.dataDir);
      const ids = (() => { try { return this.deps.listSessionIds?.() || []; } catch { return []; } })();
      const live = ids.map(id => ({ id, s: this.deps.getSession?.(id) }))
        .filter(x => x.s && /^codeagent/.test(String(x.s.kind || '')) && x.s.status !== 'dormant' && x.s.status !== 'closed')
        .map(x => ({ ...x, at: Math.max(Number(x.s.lastMessageTime) || 0, Number(x.s.lastCompletedAt) || 0, Number(this.deps.sessionInputAt?.(x.id)) || 0) }))
        .sort((a, b) => b.at - a.at).slice(0, MAX_SESSIONS);
      const creditSeen = new Set();
      for (const x of live) {
        const key = this.sessionKey(x.s);
        try { this.scanTranscript(x.id, x.s, key, rules, cfg, marked); } catch (error) { this.bridge.bridgeLog?.(`quota transcript ${String(x.id).slice(0, 8)} 读不了：${error.message}`); }
        try { await this.scanScreen(x.id, x.s, key, rules, cfg, marked, cleared, creditSeen); } catch { /* 这个会话的屏幕读不了，看下一个 */ }
      }
      // 所有会话都关了时，到点的自动避让由 activeAvoid 按时间过期，不用这里处理。
    } finally { this.scanning = false; }
    if (marked.length || cleared.length) this.bridge.avoidChanged?.({ marked, cleared });
    return { marked, cleared };
  }

  scanTranscript(id, s, key, rules, cfg, marked) {
    const file = s.transcriptPath;
    if (!file) return;
    let size;
    try { size = (this.deps.statSize || (f => fs.statSync(f).size))(file); } catch { return; }
    let from = this.offsets.has(id) ? this.offsets.get(id) : Math.max(0, size - FIRST_TAIL_BYTES);
    if (size < from) from = 0; // 记录被重写
    if (size === from) return;
    const len = Math.min(size - from, READ_MAX_BYTES);
    const start = size - len > from ? size - len : from;
    const text = (this.deps.readRange || ((f, pos, n) => { const fd = fs.openSync(f, 'r'); try { const b = Buffer.alloc(n); fs.readSync(fd, b, 0, n, pos); return b.toString('utf8'); } finally { fs.closeSync(fd); } }))(file, start, size - start);
    // 只处理完整的行：最后一行没写完的留到下次
    const lastNl = text.lastIndexOf('\n');
    if (lastNl < 0) return;
    const atBoundary = start === 0 || (this.offsets.has(id) && start === from); // 接着上次读到的行尾，或从文件头读
    this.offsets.set(id, start + Buffer.byteLength(text.slice(0, lastNl + 1), 'utf8'));
    const lines = text.slice(0, lastNl).split('\n');
    if (!atBoundary) lines.shift(); // 从中间截的第一行不完整
    for (const line of lines) {
      if (!line.includes('rror')) continue; // 快速跳过：API Error / isApiErrorMessage / error 都含它
      let o = null; try { o = JSON.parse(line); } catch { continue; }
      const e = apiErrorEntry(o);
      if (!e) continue;
      const at = e.at || this.now();
      const hit = Q.matchText(e.text, rules, 'transcript', this.now());
      this.record({ id, s, key, source: 'transcript', structured: e.structured, text: hit ? hit.text : firstLines(e.text), hit, at, dedupe: e.uuid || hash(line) });
      // 太久以前的报错（超过一个重试周期）只留作样本，不再避让
      if (hit && this.now() - at < cfg.retryMs) this.applyHit({ id, key, hit, at, cfg, marked });
    }
  }

  async scanScreen(id, s, key, rules, cfg, marked, cleared, creditSeen) {
    if (!this.deps.readTerminalScreen) return;
    const raw = await this.deps.readTerminalScreen(id);
    if (!raw || !raw.text) return;
    const sig = raw.text.length + ':' + hash(raw.text.slice(-400));
    const unchanged = this.screenSig.get(id) === sig;
    this.screenSig.set(id, sig);
    if (unchanged && creditSeen.has(key)) return;
    const rows = await (this.deps.renderRows || require('../hub-phone/session-chat').renderRows)(raw);
    // Credit：每个号取最近活动的那个会话的读数
    if (!creditSeen.has(key)) {
      const reading = require('../codeagent-screen-stats').parseCodeAgentCredit(rows);
      if (reading) {
        creditSeen.add(key);
        const r = Q.recordCredit(this.dataDir, key, reading, { floor: cfg.floor, retryMs: cfg.retryMs, session: id }, this.now());
        if (r.marked) { marked.push(key); this.bridge.bridgeLog?.(`quota credit ${key === 'personal' ? 'personal' : 'pool'} session=${String(id).slice(0, 8)} 剩 ${reading.remaining}，标避让`); }
        if (r.cleared) { cleared.push(key); this.bridge.bridgeLog?.(`quota credit ${key === 'personal' ? 'personal' : 'pool'} 剩 ${reading.remaining}，解除避让`); }
      }
    }
    if (unchanged) return;
    const prev = this.visible.get(id) || new Set();
    const now = new Set();
    for (const row of rows) {
      if (!ERROR_HEAD.test(row)) continue;
      const line = row.replace(/^\s*(?:[│┃|⎿●•*>·-]\s*)*/, '').replace(/\s*[│┃|]\s*$/, '').trim();
      const k = hash(line);
      now.add(k);
      if (prev.has(k)) continue;
      const hit = API_ERROR_HEAD.test(row) ? Q.matchText(line, rules, 'screen', this.now()) : null;
      if (!hit && !Q.isSuspect(line) && !API_ERROR_HEAD.test(row)) continue;
      this.record({ id, s, key, source: 'screen', structured: false, text: hit ? hit.text : line, hit, at: this.now(), dedupe: 'screen:' + id + ':' + k + ':' + this.now() });
      if (hit) this.applyHit({ id, key, hit, at: this.now(), cfg, marked });
    }
    this.visible.set(id, now);
  }

  applyHit({ id, key, hit, at, cfg, marked }) {
    const resetAt = hit.resetAt && hit.resetAt > this.now() ? hit.resetAt : at + cfg.retryMs;
    const sample = Q.redactSnippet(hit.text, { scrub: t => this.bridge.scrubText(t) });
    const r = Q.markAvoid(this.dataDir, key, { source: 'error', kind: hit.rule.kind, reason: `${Q.KINDS[hit.rule.kind] || '额度'}：${sample}`, until: resetAt, ruleId: hit.rule.id, session: id, sample, retryMs: cfg.retryMs }, this.now());
    const prev = this.hits.get(id);
    if (!prev || prev.at < at) this.hits.set(id, { at, key, ruleId: hit.rule.id, kind: hit.rule.kind, text: sample, resetAt: r.entry.until });
    if (r.changed) {
      marked.push(key);
      this.bridge.bridgeLog?.(`quota hit ${key === 'personal' ? 'personal' : 'pool'} session=${String(id).slice(0, 8)} rule=${hit.rule.id} 避让到 ${Q.clock(r.entry.until)}`);
    }
  }

  // 识别到的报错（命中规则的、疑似的）留最近 50 条：直查 errors 段据此把原文带回去核对规则。
  record({ id, s, key, source, structured, text, hit, at, dedupe }) {
    const store = this.bridge.store;
    const list = store.get('quotaErrors') || [];
    if (list.some(x => x.dedupe === dedupe)) return;
    const entry = { at, seenAt: this.now(), key, session: String(id).slice(0, 8), purpose: s.purpose === 'company-bridge' ? 'company-bridge' : 'other', source, structured: !!structured,
      ruleId: hit ? hit.rule.id : null, kind: hit ? hit.rule.kind : null, text: Q.redactSnippet(text, { scrub: t => this.bridge.scrubText(t) }), dedupe };
    store.set('quotaErrors', [entry, ...list].slice(0, KEEP_ERRORS));
  }
  // 这个会话自 since 起有没有撞到额度（通道 collect 用来判断「这一轮是不是因额度中断」）。
  hitFor(sessionId, since) {
    const h = sessionId && this.hits.get(sessionId);
    return h && h.at >= since - 5000 ? h : null;
  }
  errors(limit = 20) { return (this.bridge.store.get('quotaErrors') || []).slice(0, Math.max(1, Math.min(KEEP_ERRORS, Number(limit) || 20))); }
}
function firstLines(text) { return String(text || '').split('\n').filter(l => l.trim()).slice(0, 3).join(' / '); }

module.exports = { QuotaWatch, apiErrorEntry, SCAN_MS, KEEP_ERRORS };
