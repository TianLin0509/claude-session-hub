'use strict';

// SessionBinder：把 mobile session 集合绑到 Hub 内部 SessionManager。
//
// 支持 multi-session：手机可同时存在多个 Claude / Codex session。
// 持久化 mobile session ID 列表到 ${dataDir}/mobile-sessions.json，
// Hub 重启时按 ID 找 session-manager 恢复（自动检测 dormant 重建 PTY）。
//
// 与现有 Hub 代码的最小耦合面：
//   - sessionManager.createSession(kind, opts)
//   - sessionManager.writeToSession(id, data)
//   - sessionManager.closeSession(id)
//   - sessionManager.getSession(id)
//   - transcriptTap.on('turn-complete', ev)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MSG } = require('../shared/protocol');

const MOBILE_SESSION_ID = 'mobile-default';
const MOBILE_SESSION_TITLE = '手机 Claude';

class SessionBinder {
  constructor({ sessionManager, transcriptTap, outbound, logger = console, dataDir, pair = null, webPush = null }) {
    this.sessionManager = sessionManager;
    this.transcriptTap = transcriptTap;
    this.outbound = outbound;
    this.logger = logger;
    this.dataDir = dataDir;
    // T11 Web Push：pair 用来查设备 pushSub；webPush 用来发推
    // 两者任一为 null 都退化成"只走 WSS turn"，push 静默禁用
    this.pair = pair;
    this.webPush = webPush;
    this.mobileSessionsPath = dataDir ? path.join(dataDir, 'mobile-sessions.json') : null;
    this.turnHistoryPath = dataDir ? path.join(dataDir, 'mobile-turn-history.json') : null;
    this.mobileSessionIds = new Set();
    this.sessionMeta = new Map(); // id -> { kind, title, createdAt }
    this.seqBySession = new Map();
    this.globalSeq = 0;
    this.turnHistory = [];
    // 每个 session 的订阅设备集合 — turn 只推给订阅者，不广播给所有 device。
    // 设备发 input 时自动订阅；ListSessions / NewSession 操作不订阅 turn。
    this.sessionSubscribers = new Map(); // sessionId -> Set<deviceToken>
    this._loadMobileSessions();
    this._loadTurnHistory();
  }

  start() {
    // 旧逻辑：启动时批量 _activateOrCreate 所有历史 mobile session → N 个 pty.spawn 并发 →
    // Windows ConPTY race 导致所有 PTY hang 在初始 CSR query（[6n），Claude 永不启动。
    // 新逻辑：纯 lazy 创建——只维护 in-memory ids+meta，等用户在 PWA 发首条 input 时
    // handlePwaInput 走 _activateOrCreate 单独 spawn（一次只一个 PTY，无 race）。
    // 同时满足用户诉求：进入 Hub 不自动创建任何 Claude 会话。
    if (!this.mobileSessionIds.has(MOBILE_SESSION_ID)) {
      this.mobileSessionIds.add(MOBILE_SESSION_ID);
      this.sessionMeta.set(MOBILE_SESSION_ID, { kind: 'claude', title: MOBILE_SESSION_TITLE, createdAt: Date.now() });
      this._saveMobileSessions();
    }
    this._subscribeTurnComplete();
  }

  _loadMobileSessions() {
    if (!this.mobileSessionsPath) return;
    try {
      if (fs.existsSync(this.mobileSessionsPath)) {
        const raw = JSON.parse(fs.readFileSync(this.mobileSessionsPath, 'utf8'));
        if (Array.isArray(raw.sessions)) {
          for (const entry of raw.sessions) {
            if (typeof entry === 'string') {
              this.mobileSessionIds.add(entry);
            } else if (entry && entry.id) {
              this.mobileSessionIds.add(entry.id);
              this.sessionMeta.set(entry.id, {
                kind: entry.kind || 'claude',
                title: entry.title || '手机会话',
                createdAt: entry.createdAt || Date.now(),
                pinned: !!entry.pinned,
                pinnedAt: entry.pinnedAt || null,
              });
            }
          }
        }
      }
    } catch (e) {
      this.logger.warn(`[mobile-bridge] failed to load mobile-sessions.json: ${e.message}`);
    }
  }

  _saveMobileSessions() {
    if (!this.mobileSessionsPath) return;
    try {
      const sessions = Array.from(this.mobileSessionIds).map((id) => {
        const meta = this.sessionMeta.get(id) || {};
        return {
          id,
          kind: meta.kind || 'claude',
          title: meta.title || '',
          createdAt: meta.createdAt || Date.now(),
          pinned: !!meta.pinned,
          pinnedAt: meta.pinnedAt || null,
        };
      });
      const tmp = this.mobileSessionsPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ sessions }, null, 2), 'utf8');
      fs.renameSync(tmp, this.mobileSessionsPath);
    } catch (e) {
      this.logger.warn(`[mobile-bridge] failed to save mobile-sessions.json: ${e.message}`);
    }
  }

  _loadTurnHistory() {
    if (!this.turnHistoryPath) return;
    try {
      if (!fs.existsSync(this.turnHistoryPath)) return;
      const raw = JSON.parse(fs.readFileSync(this.turnHistoryPath, 'utf8'));
      this.globalSeq = Number(raw.globalSeq || 0);
      this.turnHistory = Array.isArray(raw.turns)
        ? raw.turns.filter((t) => t && typeof t.seq === 'number')
        : [];
      for (const t of this.turnHistory) {
        if (t.seq > this.globalSeq) this.globalSeq = t.seq;
      }
    } catch (e) {
      this.logger.warn(`[mobile-bridge] failed to load mobile-turn-history.json: ${e.message}`);
      this.globalSeq = 0;
      this.turnHistory = [];
    }
  }

  _saveTurnHistory() {
    if (!this.turnHistoryPath) return;
    try {
      const tmp = this.turnHistoryPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({
        globalSeq: this.globalSeq,
        turns: this.turnHistory,
      }, null, 2), 'utf8');
      fs.renameSync(tmp, this.turnHistoryPath);
    } catch (e) {
      this.logger.warn(`[mobile-bridge] failed to save mobile-turn-history.json: ${e.message}`);
    }
  }

  _nextSeq(sessionId) {
    this.globalSeq += 1;
    this.seqBySession.set(sessionId, this.globalSeq);
    return this.globalSeq;
  }

  _rememberTurn(turn) {
    if (!turn || typeof turn.seq !== 'number') return;
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const clean = {
      type: turn.type,
      sessionId: turn.sessionId,
      seq: turn.seq,
      role: turn.role,
      content: turn.content || '',
      ts: turn.ts || Date.now(),
      durationMs: turn.durationMs || null,
      model: turn.model || null,
      usage: turn.usage || null,
    };
    this.turnHistory.push(clean);
    this.turnHistory = this.turnHistory
      .filter((t) => (t.ts || 0) >= cutoff)
      .slice(-1000);
    this._saveTurnHistory();
  }

  replayTurnsSince(deviceToken, sinceSeq = 0) {
    if (!deviceToken) return 0;
    const cursor = Number.isFinite(Number(sinceSeq)) ? Number(sinceSeq) : 0;
    const turns = this.turnHistory
      .filter((t) => typeof t.seq === 'number' && t.seq > cursor)
      .sort((a, b) => a.seq - b.seq);
    for (const turn of turns) {
      this.outbound.send({ ...turn, deviceToken });
    }
    if (turns.length) {
      this.logger.log(`[mobile-bridge] replayed ${turns.length} mobile turns since seq=${cursor} to device=${deviceToken.slice(0,8)}`);
    }
    return turns.length;
  }

  // Hub 启动时调：保证 mobile-default 存在且 live（PTY 真正起来）。
  // 同时把之前持久化的 mobile session 全部"激活"——dormant 的强制重建 PTY。
  _ensureDefaultSession() {
    // 注册 mobile-default 到 set（如果还没）
    if (!this.mobileSessionIds.has(MOBILE_SESSION_ID)) {
      this.mobileSessionIds.add(MOBILE_SESSION_ID);
      this.sessionMeta.set(MOBILE_SESSION_ID, { kind: 'claude', title: MOBILE_SESSION_TITLE, createdAt: Date.now() });
    }
    // 激活全部
    for (const id of this.mobileSessionIds) {
      const meta = this.sessionMeta.get(id) || { kind: 'claude', title: MOBILE_SESSION_TITLE };
      this._activateOrCreate(id, meta.kind, meta.title);
    }
    this._saveMobileSessions();
  }

  // 关键：dormant 检测 → close + create（让 PTY + Claude/Codex CLI 真正启动）
  _activateOrCreate(id, kind, title) {
    const existing = this.sessionManager.getSession(id);
    if (existing && this._isLive(existing, id)) {
      this.logger.log(`[mobile-bridge] reused live session ${id} (kind=${existing.kind})`);
      return existing;
    }
    if (existing) {
      this.logger.log(`[mobile-bridge] dormant ${id} detected → recreating PTY (kind=${kind})`);
      try { this.sessionManager.closeSession(id); } catch {}
    }
    const s = this.sessionManager.createSession(kind, { id, title });
    this._postCreateRegister(s);
    this.logger.log(`[mobile-bridge] created session ${id} kind=${kind} title=${title}`);
    return s;
  }

  createNewSession(kind = 'claude', title) {
    const safeKind = ['claude', 'codex', 'gemini', 'powershell'].includes(kind) ? kind : 'claude';
    const id = crypto.randomUUID();
    const sessionTitle = title || (safeKind === 'codex' ? '手机 Codex' : safeKind === 'gemini' ? '手机 Gemini' : '手机 Claude');
    const s = this.sessionManager.createSession(safeKind, { id, title: sessionTitle });
    this._postCreateRegister(s);
    this.mobileSessionIds.add(id);
    this.sessionMeta.set(id, { kind: safeKind, title: sessionTitle, createdAt: Date.now(), pinned: false, pinnedAt: null });
    this._saveMobileSessions();
    this.logger.log(`[mobile-bridge] new mobile session ${id} kind=${safeKind} title=${sessionTitle}`);
    return { id, kind: safeKind, title: sessionTitle, createdAt: Date.now() };
  }

  // 模仿 GUI 路径（main.js registerSessionForTap + sendToRenderer），让 mobile session
  // 能被 transcriptTap watch + 在 Hub UI 上显示。否则 mobile session 创建出来仅在
  // sessionManager.sessions Map 里，Hub UI 看不到，且没人监听 transcript turn-complete。
  _postCreateRegister(s) {
    if (!s || !s.id) return;
    try {
      if (this.transcriptTap && typeof this.transcriptTap.registerSession === 'function') {
        this.transcriptTap.registerSession(s.id, s.kind, {
          cwd: s.cwd,
          transcriptPath: s.transcriptPath || undefined,
          sessionsRoot: s.codexSessionsRoot || undefined,
          codexSid: s.codexSid || undefined,
          allowMtimeFallback: !!s.codexAllowMtimeFallback,
        });
      }
    } catch (e) {
      this.logger.warn(`[mobile-bridge] transcriptTap register failed for ${s.id.slice(0,8)}: ${e && e.message}`);
    }
    // sendToRenderer: 让 Hub UI 知道有这个新 session（GUI 显示）
    try {
      const { BrowserWindow } = require('electron');
      const win = BrowserWindow.getAllWindows()[0];
      if (win && win.webContents && !win.webContents.isDestroyed()) {
        win.webContents.send('session-created', { session: s });
      }
    } catch (e) {
      this.logger.warn(`[mobile-bridge] sendToRenderer failed for ${s.id.slice(0,8)}: ${e && e.message}`);
    }
  }

  destroySession(sessionId) {
    if (!this.mobileSessionIds.has(sessionId)) return false;
    if (sessionId === MOBILE_SESSION_ID) return false; // 默认 session 不可销毁（保兜底）
    try { this.sessionManager.closeSession(sessionId); } catch {}
    this.mobileSessionIds.delete(sessionId);
    this.sessionMeta.delete(sessionId);
    this.seqBySession.delete(sessionId);
    this._saveMobileSessions();
    return true;
  }

  listSessions() {
    const result = [];
    for (const id of this.mobileSessionIds) {
      const s = this.sessionManager.getSession(id);
      const meta = this.sessionMeta.get(id) || {};
      // 改名后用 meta.title（持久化层）优先于 sessionManager.title
      // sessionManager 是运行时 spawn 来的，不知道用户改过名
      result.push({
        id,
        kind: (s && s.kind) || meta.kind || 'claude',
        title: meta.title || (s && s.title) || '',
        status: this._isLive(s, id) ? 'active' : 'dormant',
        lastMessageTime: s ? s.lastMessageTime : null,
        createdAt: meta.createdAt || null,
        isDefault: id === MOBILE_SESSION_ID,
        pinned: !!meta.pinned,
        pinnedAt: meta.pinnedAt || null,
      });
    }
    return result;
  }

  // PWA → Hub: 重命名 session（只改持久化 title，不影响底层 PTY）
  handleRename(sessionId, newTitle) {
    if (!sessionId || !this.mobileSessionIds.has(sessionId)) return false;
    const title = String(newTitle || '').trim().slice(0, 64);
    if (!title) return false;
    const meta = this.sessionMeta.get(sessionId) || { kind: 'claude', createdAt: Date.now() };
    meta.title = title;
    this.sessionMeta.set(sessionId, meta);
    this._saveMobileSessions();
    this.logger.log(`[mobile-bridge] renamed ${sessionId.slice(0,8)} → "${title}"`);
    return true;
  }

  // PWA → Hub: 置顶/取消置顶
  handlePin(sessionId, pinned) {
    if (!sessionId || !this.mobileSessionIds.has(sessionId)) return false;
    const meta = this.sessionMeta.get(sessionId) || { kind: 'claude', title: '', createdAt: Date.now() };
    meta.pinned = !!pinned;
    meta.pinnedAt = pinned ? Date.now() : null;
    this.sessionMeta.set(sessionId, meta);
    this._saveMobileSessions();
    this.logger.log(`[mobile-bridge] ${pinned ? 'pinned' : 'unpinned'} ${sessionId.slice(0,8)}`);
    return true;
  }

  handlePwaInput(sessionId, content, deviceToken) {
    const text = String(content || '').trim();
    if (!text) return;
    const targetId = (sessionId && this.mobileSessionIds.has(sessionId)) ? sessionId : MOBILE_SESSION_ID;
    // 订阅：让该 session 的 turn 只推给本设备（避免回复广播给所有 device）
    if (deviceToken) {
      if (!this.sessionSubscribers.has(targetId)) this.sessionSubscribers.set(targetId, new Set());
      this.sessionSubscribers.get(targetId).add(deviceToken);
    }
    if (text === '/__hub_new_session__') {
      this._resetSession(targetId);
      return;
    }
    // 防御：如果 session 不存在 / dormant，重新激活
    // 旧 bug：existing == undefined 时直接 writeToSession 进死代码，PTY 根本没 spawn。
    // lazy 模式下 hub 重启后所有 mobile session 都是这种状态（PTY 不存在但 mobileSessionIds 还在）。
    const existing = this.sessionManager.getSession(targetId);
    if (!existing || !this._isLive(existing, targetId)) {
      const meta = this.sessionMeta.get(targetId) || {};
      this._activateOrCreate(
        targetId,
        (existing && existing.kind) || meta.kind || 'claude',
        (existing && existing.title) || meta.title || MOBILE_SESSION_TITLE
      );
    }
    // Codex 多 session 同 cwd 时 rollout 绑定撞车：transcriptTap.notePrompt 让
    // CodexTap 用 expectedPrompt 精确匹配候选 rollout 文件。Claude session 调
    // 也无副作用（_claude 没消费该接口）。
    try {
      const meta = this.sessionMeta.get(targetId) || {};
      const kind = (existing && existing.kind) || meta.kind || 'claude';
      if (this.transcriptTap && typeof this.transcriptTap.notePrompt === 'function') {
        this.transcriptTap.notePrompt(targetId, kind, text);
      }
    } catch (e) {
      this.logger.warn(`[mobile-bridge] notePrompt failed: ${e.message}`);
    }
    // _activateOrCreate 同步返回时 PTY 刚 spawn 但 Claude/Codex/Gemini CLI 还没启动好。
    // 等 ringBuffer 出现对应 CLI 的 prompt 标记才 write，否则 user input 会被 PS 当
    // 命令解析。T12（2026-06-08）：ready() 现在按 kind 分发（claude/codex/gemini 各自
    // 的输入框标记），deadline 从 12s 降到 6s。Codex 首条不再卡 12s 兜底。
    // 关键 bug fix（2026-06-07）：codex/gemini 不支持 prompt+\r 一次性发；codex
    // 把 \r 当 paste 末尾吃掉，prompt 留输入框永不提交。需要双写。
    const meta2 = this.sessionMeta.get(targetId) || {};
    const kind2 = (existing && existing.kind) || meta2.kind || 'claude';
    this._writeWhenReady(targetId, text, kind2);
  }

  _writeWhenReady(sessionId, text, kind, deadline = Date.now() + 6000) {
    const isDoubleWrite = kind === 'codex' || kind === 'gemini';
    const ready = () => {
      const buf = this.sessionManager.getSessionBuffer(sessionId) || '';
      // T12（2026-06-08）：按 kind 分发 ready 探测。原版只识别 Claude 的 'Try ' /
      // 'bypass\x1b[1Cpermissions' 标记，Codex/Gemini 永不命中 → 每次首发都走 12s 兜底。
      if (kind === 'codex') {
        // Codex CLI 启动后画输入框含 '▌' 光标 + 'Send a message' / 'to send' 提示
        // 也兜底匹配状态栏 'tokens' 关键词
        return buf.includes('▌')
          || buf.includes('Send a message')
          || buf.includes('to send')
          || buf.includes('⏵')
          || /\btokens\b/i.test(buf);
      }
      if (kind === 'gemini') {
        // Gemini CLI 启动后画 '╭─' 框线 + 'Type your message' 提示
        return buf.includes('Type your message')
          || buf.includes('╭─')
          || buf.includes('│ >')
          || /\bgemini\b/i.test(buf);
      }
      // claude 默认：底部框线 + 'Try' 提示 + 光标
      return buf.includes('Try ') || buf.includes('bypass[1Cpermissions');
    };
    const doWrite = () => {
      if (!isDoubleWrite) {
        this.logger.log(`[mobile-bridge] single-write → ${sessionId.slice(0,8)} kind=${kind}`);
        try { this.sessionManager.writeToSession(sessionId, text + '\r'); }
        catch (e) { this.logger.warn(`[mobile-bridge] writeToSession failed: ${e.message}`); }
        return;
      }
      // codex/gemini 双写：先 prompt 不带 CR -> 等 PTY 静默 250ms -> 再 CR 提交
      this.logger.log(`[mobile-bridge] double-write step1 → ${sessionId.slice(0,8)}`);
      try { this.sessionManager.writeToSession(sessionId, text); } catch {}
      const writeAt = Date.now();
      const checkQuiet = () => {
        const buf = this.sessionManager.getSessionBuffer(sessionId) || '';
        const len0 = buf.length;
        setTimeout(() => {
          const buf2 = this.sessionManager.getSessionBuffer(sessionId) || '';
          if (buf2.length === len0 || Date.now() - writeAt > 2500) {
            this.logger.log(`[mobile-bridge] double-write step2 CR → ${sessionId.slice(0,8)}`);
            try { this.sessionManager.writeToSession(sessionId, '\r'); } catch {}
            setTimeout(() => {
              try { this.sessionManager.writeToSession(sessionId, '\r'); } catch {}
            }, 150);
          } else {
            checkQuiet();
          }
        }, 250);
      };
      checkQuiet();
    };
    const tryWrite = () => {
      if (ready()) return doWrite();
      if (Date.now() > deadline) {
        this.logger.warn(`[mobile-bridge] timeout, force write kind=${kind} → ${sessionId.slice(0,8)}`);
        return doWrite();
      }
      setTimeout(tryWrite, 300);
    };
    tryWrite();
  }

  // 设备主动取消订阅（如关闭/切到别的 session）
  unsubscribeDevice(sessionId, deviceToken) {
    if (!sessionId || !deviceToken) return;
    const subs = this.sessionSubscribers.get(sessionId);
    if (subs) subs.delete(deviceToken);
  }
  // 清理某 device 的所有订阅（设备永久撤销时调）
  cleanupDevice(deviceToken) {
    if (!deviceToken) return;
    for (const subs of this.sessionSubscribers.values()) subs.delete(deviceToken);
  }

  _resetSession(targetId) {
    const s = this.sessionManager.getSession(targetId);
    const meta = this.sessionMeta.get(targetId) || {};
    const kind = (s && s.kind) || meta.kind || 'claude';
    const title = (s && s.title) || meta.title || MOBILE_SESSION_TITLE;
    try { this.sessionManager.closeSession(targetId); } catch {}
    this.seqBySession.set(targetId, 0);
    setTimeout(() => {
      this.sessionManager.createSession(kind, { id: targetId, title });
    }, 1500);
  }

  _subscribeTurnComplete() {
    this.transcriptTap.on('turn-complete', (ev) => {
      if (!ev) return;
      if (!this.mobileSessionIds.has(ev.hubSessionId)) return;
      const seq = this._nextSeq(ev.hubSessionId);
      const session = this.sessionManager.getSession(ev.hubSessionId);
      // T13（2026-06-08）：真实 model 名 + usage 透传到 PWA。
      //   ev.modelId 由 transcript-tap.js 从 transcript JSONL 抽出（Claude 取 message.model
      //   如 "claude-opus-4-7"；Codex 取 turn_context.model 如 "gpt-5.5"）。
      //   缺失时 fallback 到 session.kind（'claude'/'codex'）保持向后兼容。
      //   ev.usage 形如 { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }
      //   为 null 时 PWA 卡片自动不渲染 token chip（app.js:1990 已有 guard）。
      const turn = {
        type: MSG.TURN,
        sessionId: ev.hubSessionId,
        seq,
        role: 'assistant',
        content: ev.text || '',
        ts: ev.completedAt || Date.now(),
        durationMs: ev.durationMs || null,
        model: ev.modelId || (session ? session.kind : 'unknown'),
        usage: ev.usage || null,
      };
      this._rememberTurn(turn);
      // ⭐ 只推给订阅该 session 的设备（之前 bug：广播给所有 device 导致回复"互串")
      const subs = this.sessionSubscribers.get(ev.hubSessionId);
      if (subs && subs.size > 0) {
        const subList = Array.from(subs);
        this.logger.log(`[mobile-bridge] turn → session ${ev.hubSessionId.slice(0,8)} subs=[${subList.map(t=>t.slice(0,8)).join(',')}] textLen=${(ev.text||'').length}`);
        for (const dt of subList) {
          this.outbound.send({ ...turn, deviceToken: dt });
        }
        // T11 Web Push：同步发系统通知给每台已注册 pushSub 的设备
        // PWA 在前台时 WSS turn 走 normal handler；后台/锁屏时 OS notification 救场
        // sw.js 收到 push event → showNotification → 用户点击 → openWindow('/?sid=...')
        this._sendPushToSubscribers(subList, turn, ev);
      } else {
        this.logger.log(`[mobile-bridge] turn → session ${ev.hubSessionId.slice(0,8)} NO subscribers, broadcasting`);
        this.outbound.send(turn);
      }
    });
  }

  // T11：给一组 device token 发 Web Push 系统通知
  // 失败不抛错也不重试（push service 自己有 TTL 队列；用户解锁打开 PWA 会 sinceSeq 拉增量补齐）
  _sendPushToSubscribers(deviceTokens, turn, ev) {
    if (!this.webPush || !this.pair) return;
    if (!Array.isArray(deviceTokens) || !deviceTokens.length) return;
    const text = String(turn.content || '').slice(0, 80);
    const session = this.sessionManager.getSession(ev.hubSessionId);
    const sessionTitle = (session && session.title) || '手机会话';
    const kind = (session && session.kind) || 'claude';
    const titleLabel = kind === 'codex' ? 'Codex 回复了' : kind === 'gemini' ? 'Gemini 回复了' : 'Claude 回复了';
    const payload = JSON.stringify({
      title: `${titleLabel} · ${sessionTitle.slice(0, 24)}`,
      body: text || '(空回复)',
      sid: ev.hubSessionId,
      seq: turn.seq,
      ts: turn.ts || Date.now(),
      durationMs: turn.durationMs || null,
    });
    for (const dt of deviceTokens) {
      const sub = this.pair.getPushSub(dt);
      if (!sub) continue;
      this.webPush.send(sub, payload, { ttl: 60, urgency: 'high' }).then((r) => {
        if (r.ok) {
          this.logger.log(`[mobile-bridge] push sent device=${dt.slice(0,8)} status=${r.status}`);
        } else {
          this.logger.warn(`[mobile-bridge] push failed device=${dt.slice(0,8)} status=${r.status} err=${r.error || r.body || ''}`);
          // 410 Gone / 404 Not Found → push subscription 失效，清理
          if (r.status === 410 || r.status === 404) {
            try { this.pair.setPushSub(dt, null); } catch {}
            this.logger.log(`[mobile-bridge] cleared stale push-sub device=${dt.slice(0,8)}`);
          }
        }
      }).catch((e) => {
        this.logger.warn(`[mobile-bridge] push send threw: ${e && e.message}`);
      });
    }
  }

  // 注意：sessionManager.getSession(id) 返回 { ...info } 浅拷贝，**没有 pty 字段**。
  // 必须直接访问 sessionManager.sessions Map 拿 entry 检查真实 PTY 状态。
  _isLive(s, id) {
    const realId = id || (s && s.id);
    if (!realId) return false;
    const entry = this.sessionManager.sessions && this.sessionManager.sessions.get(realId);
    if (!entry || !entry.pty) return false;
    const pty = entry.pty;
    if (typeof pty.pid !== 'number' || pty.pid <= 0) return false;
    if (pty.killed === true) return false;
    return true;
  }
}

module.exports = { SessionBinder, MOBILE_SESSION_ID, MOBILE_SESSION_TITLE };
