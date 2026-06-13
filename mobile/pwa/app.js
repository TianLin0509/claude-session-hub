'use strict';

// Hub Mobile PWA · client
// 状态机：配对屏 ↔ 主屏
// 网络层：HubClient 管理 WSS 重连/心跳/离线队列/状态广播
//
// localStorage keys：
//   hub-mobile/device-token  长期 device token（配对成功后）
//   hub-mobile/last-seq      最后看到的 turn seq（重连用 sinceSeq 续）
//   hub-mobile/send-queue    离线发送队列（JSON array）

// 调试/版本可见性：每次有 PWA 端代码改动都 bump 这里
const PWA_VERSION = 'v0.5.83';
const PWA_SW_CACHE = 'hub-mobile-v110';
const PWA_SW_LABEL = 'sw v110';
const PWA_BUILD = '2026-06-12 AI Hub PWA: Hub View remote control with desktop persistent session sidebar, browser back closes drawer and Hub View, desktop right-click session actions, desktop remote session management, card source hub routing, pairing hub list viewport fit, artifact overlay cleanup, synced debug SW cache version, mobile touch drag mode, pinch-in fit reset, one-tap fit reset after pinch zoom, pinch gesture frame hold, mobile pinch-to-zoom, screen wake lock for long live-control sessions, WebSocket reconnect state restore, bounded coordinate mapping, multi-level local zoom, stream watchdog and viewport resubscribe, subscription-style streaming frames, post-input fast frame burst, foreground resume sync, fullscreen keyboard lock, keyboard capture toggle, desktop fullscreen, middle-button canvas pan, preserved 1X pan position, two-finger canvas pan, compact modifier toolbar, touch modifier latch, mouse modifier passthrough, post-input boost frames, touch long-right-click ghost guard, paste bridge, toolbar-stable bidirectional clipboard, desktop keyboard parity with F1-F24 and numpad aliases, adaptive resolution stable-node JPEG live frames, hover, keyboard, file drop/transfer and drag';

// 收发消息 ring buffer，给调试面板看
const DEBUG_LOG = [];
const DEBUG_LOG_MAX = 30;
function debugLog(direction, type, extra) {
  DEBUG_LOG.push({ t: Date.now(), dir: direction, type, extra: extra || null });
  if (DEBUG_LOG.length > DEBUG_LOG_MAX) DEBUG_LOG.shift();
}

const MSG = Object.freeze({
  HELLO: 'hello', PING: 'ping', PONG: 'pong', ERROR: 'error',
  TURN: 'turn', TURN_DELTA: 'turn-delta', PAIR_RESULT: 'pair-result',
  PWA_INPUT: 'input', PAIR_REQUEST: 'pair-request',
  NEW_SESSION: 'new-session', DESTROY_SESSION: 'destroy-session', LIST_SESSIONS: 'list-sessions',
  RENAME_SESSION: 'rename-session', PIN_SESSION: 'pin-session',
  SESSION_CREATED: 'session-created', SESSION_DESTROYED: 'session-destroyed', SESSION_LIST: 'session-list',
  HUB_SNAPSHOT_REQUEST: 'hub-snapshot-req', HUB_SNAPSHOT: 'hub-snapshot',
  HUB_DELTA: 'hub-delta', HUB_COMMAND: 'hub-command', COMMAND_ACK: 'command-ack',
  HUB_VIEW_REQUEST: 'hub-view-req', HUB_VIEW_FRAME: 'hub-view-frame',
  HUB_VIEW_SUBSCRIBE: 'hub-view-sub', HUB_VIEW_UNSUBSCRIBE: 'hub-view-unsub',
  HUB_VIEW_INPUT: 'hub-view-input', HUB_VIEW_INPUT_ACK: 'hub-view-input-ack',
  PTY_SUBSCRIBE: 'pty-subscribe', PTY_UNSUBSCRIBE: 'pty-unsubscribe', PTY_SNAPSHOT: 'pty-snapshot',
  PTY_DATA: 'pty-data', PTY_INPUT: 'pty-input', PTY_RESIZE: 'pty-resize', PTY_ACK: 'pty-ack',
  ARTIFACT_FETCH: 'artifact-fetch', ARTIFACT_CONTENT: 'artifact-content', ARTIFACT_ERROR: 'artifact-error',
  ARTIFACT_LIST_REQUEST: 'artifact-list-req', ARTIFACT_LIST: 'artifact-list',
  NEW_MEETING: 'new-meeting', MEETING_CREATED: 'meeting-created', LIST_MEETINGS: 'list-meetings', MEETING_LIST: 'meeting-list',
  LIST_HUBS: 'list-hubs', HUB_LIST: 'hub-list',
  REGISTER_PUSH_SUB: 'register-push-sub', PUSH_SUB_ACK: 'push-sub-ack',
  CONN_STATE: 'conn-state',
});

const STORAGE_ACTIVE_HUB = 'hub-mobile/active-hub';

// 识别 AI 回复里的本地 HTML/图片路径。
//   - 原版仅匹配含 `claude-artifacts` 的路径 → codex/gemini 写到其他目录的 .html 无法预览
//   - 新版匹配任意本地路径，让 artifact-server 用白名单校验（hub 端已实现 path_outside_whitelist 友好提示）
// 路径形态：盘符 + 反/正斜杠（含空格用 ` ` 也可，但用户铁律是路径无空格，简化处理）
const ARTIFACT_PATH_RE = /([A-Za-z]:[\\\/](?:[^\s<>"'`]+[\\\/])*[^\s<>"'`]+?\.(?:html|htm|svg|md|txt))/gi;

const STORAGE = {
  DEVICE_TOKEN: 'hub-mobile/device-token',
  LAST_SEQ: 'hub-mobile/last-seq',
  QUEUE: 'hub-mobile/send-queue',
  ACTIVE_SESSION: 'hub-mobile/active-session',
};
const DEFAULT_SESSION_ID = 'mobile-default';

// 心跳 15s：4G NAT idle timeout 通常 30s，留 1/2 余量
// WEAK 阈值 = 心跳 × 2 + 5s 容差（30s + 5s = 35s），防误报
const HEARTBEAT_MS = 15 * 1000;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30 * 1000;
const WEAK_NETWORK_MS = 35 * 1000;

// ===== IDBStore =====
// PWA 重启历史持久化（T10 / v0.5.4）
// 鸿蒙 / iOS 系统杀 PWA 进程后，内存 sessionCards 全丢；用 IndexedDB 把每张卡片的"原始
// 数据"（不是 DOM）落盘，启动切到某 session 时如果内存空且 IDB 有缓存就回填渲染。
//
// schema：
//   stores:
//     - cards   keyPath ['sid', 'seq']    单条卡片：{ sid, seq, role: 'user'|'claude', payload, ts }
//                                          payload 形态：role=user → { text }
//                                                       role=claude → 完整 turn 对象
//     - meta    keyPath 'key'             杂项（lastCleanupTs / lruOrder 等）
//
// seq 规则：
//   - claude 卡片用 turn.seq（hub 端单调递增）
//   - user 卡片本地生成：clientSeq = Date.now() * 1000 + counter（counter 防同毫秒撞键）
//     hub 端 seq 是从 1 开始的小数字 → 本地 clientSeq 一定大于 hub seq，自然排序到对端
//     回复之后；不和 turn.seq 撞键
//
// TTL：写入时附 ts；启动跑一次清理 ts < now - 30 天的全删
// 容量：5MB 配额（粗估每卡 ≤ 5KB → 1000 卡片）；超时按 session 整体 LRU drop
class IDBStore {
  constructor(dbName = 'hub-mobile', version = 1) {
    this.dbName = dbName;
    this.version = version;
    this._dbPromise = null;
    this.disabled = false;
  }
  _open() {
    if (this._dbPromise) return this._dbPromise;
    if (typeof indexedDB === 'undefined') {
      this.disabled = true;
      return Promise.reject(new Error('IndexedDB not available'));
    }
    this._dbPromise = new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(this.dbName, this.version); }
      catch (e) { this.disabled = true; reject(e); return; }
      req.onupgradeneeded = (e) => {
        const db = req.result;
        if (!db.objectStoreNames.contains('cards')) {
          const s = db.createObjectStore('cards', { keyPath: ['sid', 'seq'] });
          s.createIndex('sid', 'sid', { unique: false });
          s.createIndex('ts', 'ts', { unique: false });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { this.disabled = true; reject(req.error); };
      req.onblocked = () => { /* 让 transaction 自己 retry，don't reject */ };
    });
    return this._dbPromise;
  }
  async _tx(storeNames, mode) {
    const db = await this._open();
    const tx = db.transaction(storeNames, mode);
    const stores = Array.isArray(storeNames)
      ? Object.fromEntries(storeNames.map(n => [n, tx.objectStore(n)]))
      : tx.objectStore(storeNames);
    return { tx, stores };
  }
  static _reqP(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async putCard(card) {
    if (this.disabled) return;
    try {
      const { tx, stores } = await this._tx('cards', 'readwrite');
      stores.put(card);
      await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('tx aborted'));
      });
    } catch (e) {
      // quota 满 / db 半坏 → 静默 disable，UI 不阻塞
      if (e && (e.name === 'QuotaExceededError' || e.name === 'AbortError')) {
        debugLog('!', 'idb-quota', e.name);
      }
    }
  }
  // 拉某 session 最近 N 条卡片，按真实发生时间升序。
  // seq 只用于去重/续传游标；user 本地 seq 与 Hub turn seq 不在同一数值域，不能拿来排序。
  async getRecentCards(sid, limit = 100) {
    if (this.disabled) return [];
    try {
      const { stores } = await this._tx('cards', 'readonly');
      const idx = stores.index('sid');
      // sid 索引 → cursor 倒序，攒够 limit 条再翻正序
      const range = IDBKeyRange.only(sid);
      const out = [];
      const cursorReq = idx.openCursor(range, 'prev');
      await new Promise((resolve, reject) => {
        cursorReq.onsuccess = () => {
          const c = cursorReq.result;
          if (!c || out.length >= limit) { resolve(); return; }
          out.push(c.value);
          c.continue();
        };
        cursorReq.onerror = () => reject(cursorReq.error);
      });
      out.sort((a, b) => ((a.ts || 0) - (b.ts || 0)) || ((a.seq || 0) - (b.seq || 0)));
      return out;
    } catch (e) {
      return [];
    }
  }
  // 拉 sid → maxSeq map，给 drawer 未读角标提示用
  async getAllSessionMaxSeq() {
    if (this.disabled) return new Map();
    try {
      const { stores } = await this._tx('cards', 'readonly');
      const cursorReq = stores.openCursor();
      const map = new Map();
      await new Promise((resolve, reject) => {
        cursorReq.onsuccess = () => {
          const c = cursorReq.result;
          if (!c) { resolve(); return; }
          const v = c.value;
          const cur = map.get(v.sid) || 0;
          if ((v.seq || 0) > cur) map.set(v.sid, v.seq || 0);
          c.continue();
        };
        cursorReq.onerror = () => reject(cursorReq.error);
      });
      return map;
    } catch (e) {
      return new Map();
    }
  }
  // 删 sid 整个 session 的卡片（LRU drop / 用户清理）
  async dropSession(sid) {
    if (this.disabled) return;
    try {
      const { tx, stores } = await this._tx('cards', 'readwrite');
      const idx = stores.index('sid');
      const range = IDBKeyRange.only(sid);
      const cursorReq = idx.openCursor(range);
      cursorReq.onsuccess = () => {
        const c = cursorReq.result;
        if (!c) return;
        c.delete();
        c.continue();
      };
      await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('tx aborted'));
      });
    } catch (e) { /* 静默 */ }
  }
  // 30 天 TTL 清理：扫 ts index，老于 cutoff 全删
  async cleanupOlderThan(cutoffTs) {
    if (this.disabled) return 0;
    try {
      const { tx, stores } = await this._tx('cards', 'readwrite');
      const idx = stores.index('ts');
      const range = IDBKeyRange.upperBound(cutoffTs, true);
      const cursorReq = idx.openCursor(range);
      let n = 0;
      cursorReq.onsuccess = () => {
        const c = cursorReq.result;
        if (!c) return;
        c.delete();
        n++;
        c.continue();
      };
      await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('tx aborted'));
      });
      return n;
    } catch (e) { return 0; }
  }
  async getMeta(key) {
    if (this.disabled) return null;
    try {
      const { stores } = await this._tx('meta', 'readonly');
      const v = await IDBStore._reqP(stores.get(key));
      return v ? v.value : null;
    } catch (e) { return null; }
  }
  async setMeta(key, value) {
    if (this.disabled) return;
    try {
      const { tx, stores } = await this._tx('meta', 'readwrite');
      stores.put({ key, value });
      await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) { /* 静默 */ }
  }
  // quota 检查：超 5MB 按 session LRU drop（lastSeenTs 升序，最老 drop 到水位以下）
  async enforceQuota(maxBytes = 5 * 1024 * 1024) {
    if (this.disabled) return;
    if (!navigator.storage || !navigator.storage.estimate) return;
    try {
      const est = await navigator.storage.estimate();
      const usage = est.usage || 0;
      if (usage <= maxBytes) return;
      // 按 ts 升序删，直到降到 80% 水位
      const target = maxBytes * 0.8;
      const { tx, stores } = await this._tx('cards', 'readwrite');
      const idx = stores.index('ts');
      const cursorReq = idx.openCursor();
      let dropped = 0;
      cursorReq.onsuccess = () => {
        const c = cursorReq.result;
        if (!c) return;
        // 粗估：每条 5KB
        const est2 = usage - dropped * 5120;
        if (est2 <= target) return;
        c.delete();
        dropped++;
        c.continue();
      };
      await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      if (dropped > 0) debugLog('!', 'idb-lru-drop', String(dropped));
    } catch (e) { /* 静默 */ }
  }
}

// ===== HubClient =====
class HubClient extends EventTarget {
  constructor({ gatewayUrl, deviceToken }) {
    super();
    this.gatewayUrl = gatewayUrl;
    this.deviceToken = deviceToken;
    this.ws = null;
    this.state = 'disconnected';
    this.reconnectAttempts = 0;
    this.queue = [];
    this.hbTimer = null;
    this.weakTimer = null;
    this.reconnectTimer = null;
    this.lastActivity = 0;
    this.hasConnected = false;
    this.connectionEpoch = 0;
    this._loadQueue();
  }
  connect() {
    if (this.state === 'connecting' || this.state === 'connected') return;
    this._setState('connecting');
    try {
      // ws 子协议带 device token；URL 不含敏感信息
      this.ws = new WebSocket(this.gatewayUrl, [`device.${this.deviceToken}`]);
    } catch (e) {
      this._setState('disconnected');
      this._scheduleReconnect();
      return;
    }
    this.ws.addEventListener('open', () => this._onOpen());
    this.ws.addEventListener('message', (e) => this._onMessage(e));
    this.ws.addEventListener('close', (e) => this._onClose(e));
    this.ws.addEventListener('error', () => { /* close 会触发，这里 swallow */ });
  }
  disconnect(reason) {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.hbTimer) { clearInterval(this.hbTimer); this.hbTimer = null; }
    if (this.weakTimer) { clearInterval(this.weakTimer); this.weakTimer = null; }
    if (this.ws) { try { this.ws.close(1000, reason || 'bye'); } catch {} }
    this._setState('disconnected');
  }
  send(content, sessionId = DEFAULT_SESSION_ID, hubId = null) {
    const msg = { type: MSG.PWA_INPUT, sessionId, content, clientId: this._mkId() };
    if (hubId) msg.hubId = hubId;
    if (this.state === 'connected' && this.ws && this.ws.readyState === 1) {
      try { this.ws.send(JSON.stringify(msg)); return true; } catch {}
    }
    this.queue.push(msg);
    this._saveQueue();
    return false;
  }

  sendHubCommand({ targetType, targetId, content, hubId = null }) {
    const msg = {
      type: MSG.HUB_COMMAND,
      targetType,
      targetId,
      content,
      clientId: this._mkId(),
    };
    if (hubId) msg.hubId = hubId;
    if (this.state === 'connected' && this.ws && this.ws.readyState === 1) {
      try { this.ws.send(JSON.stringify(msg)); return { ok: true, clientId: msg.clientId }; } catch {}
    }
    this.queue.push(msg);
    this._saveQueue();
    return { ok: false, clientId: msg.clientId };
  }

  sendRaw(msg) {
    if (this.state === 'connected' && this.ws && this.ws.readyState === 1) {
      try {
        this.ws.send(JSON.stringify(msg));
        debugLog('→', msg.type, msg.hubId ? `hub=${msg.hubId.slice(0, 20)}` : null);
        return true;
      } catch {}
    }
    debugLog('✗', msg.type, 'not connected');
    return false;
  }

  requestNewSession(kind, title, hubId = null) {
    const requestId = 'newsess-' + this._mkId();
    return this.sendRaw({ type: MSG.NEW_SESSION, kind, title, hubId, requestId });
  }
  requestNewMeeting(mode = 'general', title = '', hubId = null) {
    const requestId = 'meeting-' + this._mkId();
    return this.sendRaw({ type: MSG.NEW_MEETING, mode, kind: mode, title, hubId, requestId });
  }
  requestMeetingList(hubId = null) {
    const requestId = 'meetings-' + this._mkId();
    return this.sendRaw({ type: MSG.LIST_MEETINGS, hubId, requestId });
  }
  requestDestroySession(sessionId, hubId = null) {
    return this.sendRaw({ type: MSG.DESTROY_SESSION, sessionId, hubId });
  }
  requestRenameSession(sessionId, title, hubId = null) {
    return this.sendRaw({ type: MSG.RENAME_SESSION, sessionId, title, hubId });
  }
  requestPinSession(sessionId, pinned, hubId = null) {
    return this.sendRaw({ type: MSG.PIN_SESSION, sessionId, pinned: !!pinned, hubId });
  }
  requestSessionList(hubId = null) {
    return this.sendRaw({ type: MSG.LIST_SESSIONS, hubId });
  }
  requestHubSnapshot(hubId = null) {
    const requestId = 'snapshot-' + this._mkId();
    return this.sendRaw({ type: MSG.HUB_SNAPSHOT_REQUEST, requestId, hubId }) ? requestId : null;
  }
  requestHubView(hubId = null, maxWidth = 900, opts = {}) {
    const requestId = 'hubview-' + this._mkId();
    const width = Math.max(320, Math.min(Number(maxWidth) || 900, 1600));
    const mimeType = opts.mimeType || 'image/jpeg';
    const quality = Math.max(35, Math.min(92, Math.round(Number(opts.quality) || 72)));
    return this.sendRaw({ type: MSG.HUB_VIEW_REQUEST, requestId, hubId, maxWidth: width, mimeType, quality }) ? requestId : null;
  }
  subscribeHubView(hubId = null, maxWidth = 900, opts = {}) {
    const requestId = 'hubstream-' + this._mkId();
    const width = Math.max(320, Math.min(Number(maxWidth) || 900, 1600));
    const mimeType = opts.mimeType || 'image/jpeg';
    const quality = Math.max(35, Math.min(92, Math.round(Number(opts.quality) || 72)));
    const delayMs = Math.max(45, Math.min(1000, Math.round(Number(opts.delayMs) || 95)));
    return this.sendRaw({ type: MSG.HUB_VIEW_SUBSCRIBE, requestId, hubId, maxWidth: width, mimeType, quality, delayMs }) ? requestId : null;
  }
  unsubscribeHubView(hubId = null, requestId = null) {
    return this.sendRaw({ type: MSG.HUB_VIEW_UNSUBSCRIBE, requestId, hubId });
  }
  sendHubViewInput(input, hubId = null) {
    const requestId = 'hubinput-' + this._mkId();
    const ok = this.sendRaw({ type: MSG.HUB_VIEW_INPUT, requestId, hubId, input });
    return ok ? requestId : null;
  }
  requestPtySubscribe(sessionId, sinceSeq = 0, hubId = null) {
    return this.sendRaw({ type: MSG.PTY_SUBSCRIBE, sessionId, sinceSeq, hubId });
  }
  requestPtyUnsubscribe(sessionId, hubId = null) {
    return this.sendRaw({ type: MSG.PTY_UNSUBSCRIBE, sessionId, hubId });
  }
  sendPtyInput(sessionId, data, hubId = null) {
    return this.sendRaw({ type: MSG.PTY_INPUT, sessionId, dataB64: this._b64(data), hubId });
  }
  sendPtyResize(sessionId, cols, rows, hubId = null) {
    return this.sendRaw({ type: MSG.PTY_RESIZE, sessionId, cols, rows, hubId });
  }
  requestHubList() {
    const requestId = 'hubs-' + this._mkId();
    return this.sendRaw({ type: MSG.LIST_HUBS, requestId }) ? requestId : null;
  }
  requestArtifact(filePath, hubId = null) {
    const requestId = 'art-' + this._mkId();
    const ok = this.sendRaw({ type: MSG.ARTIFACT_FETCH, path: filePath, requestId, hubId });
    return { requestId, ok };
  }
  requestArtifactList(limit = 50, hubId = null) {
    const requestId = 'artlist-' + this._mkId();
    const ok = this.sendRaw({ type: MSG.ARTIFACT_LIST_REQUEST, limit, requestId, hubId });
    return { requestId, ok };
  }
  _onOpen() {
    const wasReconnect = this.hasConnected;
    const attempts = this.reconnectAttempts;
    this.hasConnected = true;
    this.connectionEpoch++;
    this.reconnectAttempts = 0;
    this.lastActivity = Date.now();
    this._setState('connected');
    // hello + sinceSeq
    const lastSeq = parseInt(localStorage.getItem(STORAGE.LAST_SEQ) || '0', 10);
    this._safeSend({ type: MSG.HELLO, sinceSeq: lastSeq });
    // hello 之后立刻拉 hub 列表（server 串行处理：先鉴 hello 再处理 list-hubs，
    // 替代旧版 startSession 里 1000ms 死等的 setTimeout — 配对成功到 drawer 可点快 ~1s）
    this._safeSend({ type: MSG.LIST_HUBS, requestId: 'hubs-' + this._mkId() });
    // 重发离线队列
    const pending = this.queue.slice();
    this.queue.length = 0;
    this._saveQueue();
    for (const m of pending) {
      if (!this._safeSend(m)) {
        this.queue.push(m);
      }
    }
    this._saveQueue();
    // 心跳
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.hbTimer = setInterval(() => this._safeSend({ type: MSG.PONG, ts: Date.now() }), HEARTBEAT_MS);
    // 弱网检测
    if (this.weakTimer) clearInterval(this.weakTimer);
    this.weakTimer = setInterval(() => {
      const idle = Date.now() - this.lastActivity;
      if (this.state === 'connected' && idle > WEAK_NETWORK_MS) {
        this.dispatchEvent(new CustomEvent('weak', { detail: { idle } }));
      }
    }, 2000);
    if (wasReconnect) {
      this.dispatchEvent(new CustomEvent('reconnected', {
        detail: { attempts, epoch: this.connectionEpoch, at: Date.now() },
      }));
    }
  }
  _onMessage(e) {
    this.lastActivity = Date.now();
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (!msg || !msg.type) return;
    debugLog('←', msg.type, msg.code || msg.error || (msg.session && msg.session.id) || null);
    switch (msg.type) {
      case MSG.PING:
        this._safeSend({ type: MSG.PONG, ts: Date.now() });
        return;
      case MSG.PONG:
        return;
      case MSG.CONN_STATE:
        this.dispatchEvent(new CustomEvent('conn-state', { detail: msg.state }));
        return;
      case MSG.TURN:
      case MSG.TURN_DELTA:
        if (typeof msg.seq === 'number') {
          localStorage.setItem(STORAGE.LAST_SEQ, String(msg.seq));
        }
        this.dispatchEvent(new CustomEvent('turn', { detail: msg }));
        return;
      case MSG.SESSION_LIST:
        this.dispatchEvent(new CustomEvent('session-list', { detail: msg.sessions || [] }));
        return;
      case MSG.HUB_SNAPSHOT:
        this.dispatchEvent(new CustomEvent('hub-snapshot', { detail: { ...(msg.snapshot || {}), hubId: msg.hubId || (msg.snapshot && msg.snapshot.hubId) || null } }));
        return;
      case MSG.HUB_DELTA:
        this.dispatchEvent(new CustomEvent('hub-delta', { detail: msg }));
        return;
      case MSG.COMMAND_ACK:
        this.dispatchEvent(new CustomEvent('command-ack', { detail: msg }));
        return;
      case MSG.HUB_VIEW_FRAME:
        this.dispatchEvent(new CustomEvent('hub-view-frame', { detail: msg }));
        return;
      case MSG.HUB_VIEW_INPUT_ACK:
        this.dispatchEvent(new CustomEvent('hub-view-input-ack', { detail: msg }));
        return;
      case MSG.PTY_SNAPSHOT:
        this.dispatchEvent(new CustomEvent('pty-snapshot', { detail: msg }));
        return;
      case MSG.PTY_DATA:
        this.dispatchEvent(new CustomEvent('pty-data', { detail: msg }));
        return;
      case MSG.PTY_ACK:
        this.dispatchEvent(new CustomEvent('pty-ack', { detail: msg }));
        return;
      case MSG.SESSION_CREATED:
        this.dispatchEvent(new CustomEvent('session-created', { detail: msg.session || {} }));
        return;
      case MSG.SESSION_DESTROYED:
        this.dispatchEvent(new CustomEvent('session-destroyed', { detail: msg }));
        return;
      case MSG.MEETING_CREATED:
        this.dispatchEvent(new CustomEvent('meeting-created', { detail: msg }));
        return;
      case MSG.MEETING_LIST:
        this.dispatchEvent(new CustomEvent('meeting-list', { detail: msg }));
        return;
      case MSG.ARTIFACT_CONTENT:
      case MSG.ARTIFACT_ERROR:
        this.dispatchEvent(new CustomEvent('artifact-result', { detail: msg }));
        return;
      case MSG.ARTIFACT_LIST:
        this.dispatchEvent(new CustomEvent('artifact-list', { detail: msg }));
        return;
      case MSG.HUB_LIST:
        this.dispatchEvent(new CustomEvent('hub-list', { detail: msg }));
        return;
      case MSG.PUSH_SUB_ACK:
        this.dispatchEvent(new CustomEvent('push-sub-ack', { detail: msg }));
        return;
      case MSG.ERROR:
        this.dispatchEvent(new CustomEvent('error-msg', { detail: msg }));
        return;
    }
  }
  _onClose(e) {
    if (this.hbTimer) { clearInterval(this.hbTimer); this.hbTimer = null; }
    if (this.weakTimer) { clearInterval(this.weakTimer); this.weakTimer = null; }
    this._setState('disconnected');
    if (e && e.code === 4003) {
      // 鉴权失败，不重连，触发清理
      this.dispatchEvent(new CustomEvent('auth-failed'));
      return;
    }
    this._scheduleReconnect();
  }
  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.dispatchEvent(new CustomEvent('state', { detail: s }));
  }
  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    const delay = Math.min(RECONNECT_MIN_MS * Math.pow(2, this.reconnectAttempts), RECONNECT_MAX_MS);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
  _safeSend(obj) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try {
      this.ws.send(JSON.stringify(obj));
      // 自己 send 也算 "活动"，防 weak 误报（心跳期间 idle 时间总是会到阈值）
      this.lastActivity = Date.now();
      return true;
    } catch { return false; }
  }
  _b64(text) {
    try {
      const bytes = new TextEncoder().encode(String(text || ''));
      let bin = '';
      bytes.forEach((b) => { bin += String.fromCharCode(b); });
      return btoa(bin);
    } catch {
      return btoa(unescape(encodeURIComponent(String(text || ''))));
    }
  }
  _loadQueue() {
    try { this.queue = JSON.parse(localStorage.getItem(STORAGE.QUEUE) || '[]'); }
    catch { this.queue = []; }
  }
  _saveQueue() {
    try { localStorage.setItem(STORAGE.QUEUE, JSON.stringify(this.queue)); } catch {}
  }
  _mkId() { return Math.random().toString(36).slice(2, 10); }
}

// ===== UI =====
const ui = {
  client: null,
  pinBuf: '',
  pairTargetHubId: '',
  pairHubs: [],
  ptySessionId: null,
  ptySeq: 0,
  ptyText: '',
  ptyTerm: null,
  ptyFit: null,
  ptyResizeTimer: null,
  ptyUseXterm: false,
  pendingHubViewRequestId: null,
  pendingHubViewLiveRequest: false,
  lastHubViewFrame: null,
  hubViewLiveMode: 'adaptive',
  hubViewLiveMinDelayMs: 95,
  hubViewLiveFastDelayMs: 45,
  hubViewLiveFastUntil: 0,
  hubViewLiveFastReason: '',
  hubViewLiveErrorDelayMs: 800,
  hubViewLiveFrameTimes: [],
  hubViewFrameRequestTimes: {},
  hubViewStreamSubscribed: false,
  hubViewStreamRequestId: null,
  hubViewStreamFrameCount: 0,
  hubViewStreamDelayMs: 95,
  hubViewStreamMode: 'subscribe',
  hubViewStreamFallback: false,
  hubViewStreamRestoreTimer: null,
  hubViewStreamWatchdogTimer: null,
  hubViewStreamWatchdogMs: 3500,
  hubViewStreamLastFrameAt: 0,
  hubViewStreamLastWidth: 0,
  hubViewStreamRestartCount: 0,
  hubViewStreamLastRestartReason: '',
  hubViewStreamResizeTimer: null,
  lastHubViewFrameStats: null,
  foregroundRefreshMinMs: 4000,
  foregroundLastRefreshAt: 0,
  foregroundResumeCount: 0,
  foregroundLastReason: '',
  gatewayReconnectCount: 0,
  gatewayReconnectLastAt: 0,
  gatewayReconnectLastReason: '',
  hubViewWakeLock: null,
  hubViewWakeLockActive: false,
  hubViewWakeLockSupported: false,
  hubViewWakeLockLastReason: '',
  hubViewWakeLockLastError: '',
  hubViewWakeLockAcquireCount: 0,
  hubViewWakeLockReleaseCount: 0,
  hubViewPinchZoomCount: 0,
  hubViewPinchZoomLastScale: 0,
  hubViewPinchZoomLastAt: 0,
  hubViewPinchFitResetCount: 0,
  hubViewPinchFitResetLastAt: 0,
  hubViewPinchFrameHoldCount: 0,
  hubViewPinchFrameHoldUntil: 0,
  hubViewTouchDragCount: 0,
  hubViewTouchDragLastAt: 0,
  hubViewHistoryActive: false,
  hubViewHistoryToken: null,
  hubViewHistoryClosing: false,
  hubViewBackCloseCount: 0,
  hubViewBackCloseLastAt: 0,
  hubViewBackCloseLastReason: '',
  drawerHistoryActive: false,
  drawerHistoryToken: null,
  drawerHistoryClosing: false,
  drawerBackCloseCount: 0,
  drawerBackCloseLastAt: 0,
  drawerBackCloseLastReason: '',

  init() {
    this.bindUI();
    this.registerSW();
    this._bindForegroundResume();
    this._bindHubViewHistory();
    // T10 v0.5.4：IndexedDB 持久化 sessionCards（PWA 被杀重启不丢历史）
    // 启动即开 db；30 天 TTL 清理 + quota LRU 异步跑，不阻塞首屏
    this.idb = new IDBStore();
    this._clientSeqCounter = 0;
    this._idbCleanupOnce();
    // T11 v0.5.5：deep-link 通过 ?sid=xxx URL 参数（push 通知点击 → openWindow('/?sid=...')）
    // 暂存到 _pendingDeepLinkSid，onSessionList 拿到 sessions 后 switchSession
    // 进入页面后清掉 URL（防 reload 反复跳）
    try {
      const params = new URLSearchParams(location.search);
      const sid = params.get('sid');
      if (sid) {
        this._pendingDeepLinkSid = sid;
        params.delete('sid');
        const newSearch = params.toString();
        history.replaceState(null, '', location.pathname + (newSearch ? '?' + newSearch : '') + location.hash);
      }
    } catch (_) {}
    // 监听 SW 推过来的 OPEN_SESSION（用户已在前台时点通知 → SW postMessage 而非 openWindow）
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data && e.data.type === 'OPEN_SESSION' && e.data.sid) {
          this._pendingDeepLinkSid = e.data.sid;
          this._consumePendingDeepLink();
        } else if (e.data && e.data.type === 'PUSH_SUB_CHANGED') {
          // rotation → 重 subscribe
          this._setupPushNotifications(true).catch(() => {});
        }
      });
    }
    const token = localStorage.getItem(STORAGE.DEVICE_TOKEN);
    if (token) {
      this.startSession(token);
    } else {
      this.showPairing();
    }
  },

  // T11：拿到 sessions 后才能切。session-list 还没到就先放着，到了再 switch
  _consumePendingDeepLink() {
    const sid = this._pendingDeepLinkSid;
    if (!sid) return;
    if (!this.sessions || !this.sessions.length) return; // 等 session-list
    const target = this.sessions.find(s => s.id === sid);
    if (!target) {
      // session 已删 / hub 没这个会话 → 不切，提示
      this.toast('通知对应的会话已不存在');
      this._pendingDeepLinkSid = null;
      return;
    }
    this._pendingDeepLinkSid = null;
    if (sid !== this.activeSessionId) {
      this.switchSession(sid);
    }
  },

  // T11 Web Push 订阅流程
  //   1. 检查浏览器支持（PushManager + Notification + standalone for iOS）
  //   2. 确保权限（默认 default → 弹 requestPermission；denied 不再尝试）
  //   3. 拿 VAPID 公钥（从当前 active hub 的 hub-list 拿，hub 启动时上送）
  //   4. reg.pushManager.subscribe({applicationServerKey})
  //   5. REGISTER_PUSH_SUB 上报 hub
  //
  // 自动触发时机：onHubList 拿到有 VAPID 的 hub 后。
  // 注意：未授权时不自动弹 Notification 权限；现代浏览器常要求用户手势。
  // 用户点 drawer footer 的「通知」按钮时才 requestPermission。
  // 也可被 SW pushsubscriptionchange 触发（force=true）
  _bindForegroundResume() {
    if (this._foregroundResumeBound) return;
    this._foregroundResumeBound = true;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this._releaseHubViewWakeLock('visibility-hidden');
      } else {
        this._handleForegroundResume('visibilitychange');
        this._syncHubViewWakeLock('visibility-visible');
      }
    });
    window.addEventListener('focus', () => this._handleForegroundResume('focus'));
    window.addEventListener('online', () => this._handleForegroundResume('online', { force: true }));
    window.addEventListener('pageshow', (e) => this._handleForegroundResume(e && e.persisted ? 'pageshow-bfcache' : 'pageshow'));
  },

  _bindHubViewHistory() {
    if (this._hubViewHistoryBound) return;
    this._hubViewHistoryBound = true;
    window.addEventListener('popstate', (event) => this._handleHubViewPopState(event));
  },

  _pushHubViewHistory() {
    const overlay = document.getElementById('hub-view-overlay');
    if (!overlay || !window.history || typeof history.pushState !== 'function') return false;
    const baseState = history.state && typeof history.state === 'object' && !Array.isArray(history.state)
      ? history.state
      : {};
    const token = 'hub-view-' + Date.now() + '-' + Math.random().toString(16).slice(2);
    try {
      history.pushState({ ...baseState, hubViewOverlay: true, hubViewToken: token }, '', location.href);
      this.hubViewHistoryActive = true;
      this.hubViewHistoryToken = token;
      this.hubViewHistoryClosing = false;
      return true;
    } catch (e) {
      this.hubViewHistoryActive = false;
      this.hubViewHistoryToken = null;
      this.hubViewHistoryClosing = false;
      return false;
    }
  },

  _handleHubViewPopState(event) {
    const overlay = document.getElementById('hub-view-overlay');
    if (!overlay) {
      this.hubViewHistoryActive = false;
      this.hubViewHistoryToken = null;
      this.hubViewHistoryClosing = false;
      return this._handleDrawerPopState(event);
    }
    this.hubViewBackCloseCount = (Number(this.hubViewBackCloseCount) || 0) + 1;
    this.hubViewBackCloseLastAt = Date.now();
    this.hubViewBackCloseLastReason = 'popstate';
    this._closeHubView({ fromHistory: true });
    return true;
  },

  _isDesktopPersistentDrawer() {
    const main = document.getElementById('view-main');
    return !!(
      main
      && main.classList.contains('on')
      && window.matchMedia
      && window.matchMedia('(min-width: 960px)').matches
    );
  },

  _syncDesktopDrawerMode() {
    const overlay = document.getElementById('drawer-overlay');
    if (!overlay) return false;
    const persistent = this._isDesktopPersistentDrawer();
    overlay.classList.toggle('desktop-persistent', persistent);
    if (persistent) {
      overlay.setAttribute('aria-hidden', 'false');
      this._renderDrawerHubInfo();
      this._renderDrawerList();
      this.drawerHistoryActive = false;
      this.drawerHistoryToken = null;
      this.drawerHistoryClosing = false;
    } else if (!overlay.classList.contains('on')) {
      overlay.setAttribute('aria-hidden', 'true');
    }
    return persistent;
  },

  _pushDrawerHistory() {
    const overlay = document.getElementById('drawer-overlay');
    if (this._isDesktopPersistentDrawer()) return false;
    if (!overlay || !overlay.classList.contains('on') || !window.history || typeof history.pushState !== 'function') return false;
    if (this.drawerHistoryActive) return true;
    const baseState = history.state && typeof history.state === 'object' && !Array.isArray(history.state)
      ? history.state
      : {};
    const token = 'drawer-' + Date.now() + '-' + Math.random().toString(16).slice(2);
    try {
      history.pushState({ ...baseState, drawerOverlay: true, drawerToken: token }, '', location.href);
      this.drawerHistoryActive = true;
      this.drawerHistoryToken = token;
      this.drawerHistoryClosing = false;
      return true;
    } catch (_) {
      this.drawerHistoryActive = false;
      this.drawerHistoryToken = null;
      this.drawerHistoryClosing = false;
      return false;
    }
  },

  _handleDrawerPopState(event) {
    if (this._isDesktopPersistentDrawer()) {
      this.drawerHistoryActive = false;
      this.drawerHistoryToken = null;
      this.drawerHistoryClosing = false;
      return false;
    }
    const overlay = document.getElementById('drawer-overlay');
    const open = !!(overlay && overlay.classList.contains('on'));
    if (!open) {
      this.drawerHistoryActive = false;
      this.drawerHistoryToken = null;
      this.drawerHistoryClosing = false;
      return false;
    }
    this.drawerBackCloseCount = (Number(this.drawerBackCloseCount) || 0) + 1;
    this.drawerBackCloseLastAt = Date.now();
    this.drawerBackCloseLastReason = 'popstate';
    this.closeDrawer({ fromHistory: true });
    return true;
  },

  _requestCloseDrawer(reason = 'ui') {
    if (this._isDesktopPersistentDrawer()) return false;
    const overlay = document.getElementById('drawer-overlay');
    const open = !!(overlay && overlay.classList.contains('on'));
    if (!open) return false;
    if (this.drawerHistoryActive && !this.drawerHistoryClosing && window.history && typeof history.back === 'function') {
      this.drawerHistoryClosing = true;
      this.drawerBackCloseLastReason = reason;
      try {
        history.back();
        setTimeout(() => {
          const stillOpen = !!(overlay && overlay.classList.contains('on'));
          if (this.drawerHistoryClosing && stillOpen) {
            this.drawerBackCloseCount = (Number(this.drawerBackCloseCount) || 0) + 1;
            this.drawerBackCloseLastAt = Date.now();
            this.drawerBackCloseLastReason = reason + '-fallback';
            this.closeDrawer({ fromHistory: true });
          }
        }, 350);
        return true;
      } catch (_) {
        this.drawerHistoryClosing = false;
      }
    }
    return this.closeDrawer({ skipHistory: true });
  },

  _requestCloseHubView(reason = 'ui') {
    const overlay = document.getElementById('hub-view-overlay');
    if (!overlay) return false;
    if (this.hubViewHistoryActive && !this.hubViewHistoryClosing && window.history && typeof history.back === 'function') {
      this.hubViewHistoryClosing = true;
      this.hubViewBackCloseLastReason = reason;
      try {
        history.back();
        setTimeout(() => {
          if (this.hubViewHistoryClosing && document.getElementById('hub-view-overlay')) {
            this.hubViewBackCloseCount = (Number(this.hubViewBackCloseCount) || 0) + 1;
            this.hubViewBackCloseLastAt = Date.now();
            this.hubViewBackCloseLastReason = reason + '-fallback';
            this._closeHubView({ fromHistory: true });
          }
        }, 350);
        return true;
      } catch (_) {
        this.hubViewHistoryClosing = false;
      }
    }
    return this._closeHubView({ skipHistory: true });
  },

  _handleForegroundResume(reason = 'resume', opts = {}) {
    if (!this.client) return false;
    const now = Date.now();
    const minMs = Number(this.foregroundRefreshMinMs) || 4000;
    if (!opts.force && this.foregroundLastRefreshAt && now - this.foregroundLastRefreshAt < minMs) return false;
    this.foregroundLastRefreshAt = now;
    this.foregroundResumeCount = (Number(this.foregroundResumeCount) || 0) + 1;
    this.foregroundLastReason = reason;
    debugLog('!', 'foreground-resume', reason);

    const wsOpen = !!(this.client.ws && this.client.ws.readyState === 1 && this.client.state === 'connected');
    if (!wsOpen) {
      this._setConn('connecting', 'foreground resume reconnecting');
      try { this.client.connect(); } catch {}
      return false;
    }

    this.client.sendRaw({ type: MSG.PONG, ts: now, reason: 'foreground-resume' });
    this.client.requestHubList();
    if (this.activeHubId) {
      this.client.requestSessionList(this.activeHubId);
      this.client.requestMeetingList(this.activeHubId);
      this.client.requestHubSnapshot(this.activeHubId);
    }
    if (document.getElementById('hub-view-overlay')) {
      if (this.hubViewLive) this._restartHubViewStream('foreground-resume');
      else if (!this.pendingHubViewRequestId) this._requestHubViewFrame({ silent: true, boost: true });
      this._syncHubViewWakeLock('foreground-resume');
    }
    return true;
  },

  _handleGatewayReconnect(detail = {}) {
    if (!this.client) return false;
    const now = Date.now();
    this.gatewayReconnectCount = (Number(this.gatewayReconnectCount) || 0) + 1;
    this.gatewayReconnectLastAt = now;
    this.gatewayReconnectLastReason = detail && detail.reason || 'websocket-reconnect';
    debugLog('!', 'gateway-reconnect', this.gatewayReconnectLastReason);
    this._setConn('ok', 'gateway reconnected; restoring Hub state');

    this.client.requestHubList();
    if (this.activeHubId) {
      this.client.requestSessionList(this.activeHubId);
      this.client.requestMeetingList(this.activeHubId);
      this.client.requestHubSnapshot(this.activeHubId);
    }
    if (this.ptySessionId) {
      this.client.requestPtySubscribe(this.ptySessionId, this.ptySeq || 0, this.activeHubId);
    }
    if (document.getElementById('hub-view-overlay')) {
      if (this.hubViewLive) this._restartHubViewStream('gateway-reconnect');
      else if (!this.pendingHubViewRequestId) this._requestHubViewFrame({ silent: true, boost: true });
    }
    return true;
  },

  async _setupPushNotifications(force = false, userInitiated = false) {
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        if (userInitiated) this.toast('当前浏览器不支持 Web Push');
        return; // 浏览器不支持
      }
      // iOS：仅 standalone 模式（"添加到主屏"）push 才有效
      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
      const isStandalone = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
      if (isIOS && !isStandalone) {
        // 提示一次（用 localStorage 标记，避免反复弹）
        if (!localStorage.getItem('hub-mobile/ios-push-hinted')) {
          this.toast('iOS 请先「添加到主屏」再启用通知');
          localStorage.setItem('hub-mobile/ios-push-hinted', '1');
        } else if (userInitiated) {
          this.toast('iOS 需要先添加到主屏再启用通知');
        }
        return;
      }
      // 拿 VAPID 公钥
      const curHub = (this.hubs || []).find(h => h.hubId === this.activeHubId);
      const vapid = curHub && curHub.vapidPublicKey;
      if (!vapid) {
        if (userInitiated) this.toast('当前 Hub 没有提供 VAPID 公钥，请重启 Hub');
        return; // hub 不支持 push（老 hub 或 init 失败）
      }
      // 同一 vapid 不重复 subscribe（除非 force）
      const lastVapid = localStorage.getItem('hub-mobile/push-vapid');
      const lastSubAt = parseInt(localStorage.getItem('hub-mobile/push-sub-at') || '0', 10);
      const recently = lastSubAt && (Date.now() - lastSubAt < 24 * 3600 * 1000);
      // 权限
      const perm = Notification.permission;
      if (perm === 'denied') {
        if (userInitiated) this.toast('系统已拒绝通知权限，请到浏览器设置中开启');
        return; // 用户拒绝了，别打扰
      }
      if (perm === 'default') {
        if (!userInitiated) return;
        const req = await Notification.requestPermission();
        if (req !== 'granted') return;
      }
      const reg = await navigator.serviceWorker.ready;
      // 已 subscribe 同 vapid 不重做
      const existing = await reg.pushManager.getSubscription();
      if (existing && !force && lastVapid === vapid && recently) {
        return; // 24h 内续约过同 vapid，跳
      }
      if (existing && (force || lastVapid !== vapid)) {
        try { await existing.unsubscribe(); } catch {}
      }
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: this._urlB64ToUint8(vapid),
      });
      // 上报 hub
      const subObj = sub.toJSON();
      if (this.client && this.client.state === 'connected') {
        this._pendingPushSub = {
          vapid,
          endpoint: subObj.endpoint,
          sentAt: Date.now(),
          userInitiated,
        };
        this.client.sendRaw({
          type: MSG.REGISTER_PUSH_SUB,
          sub: { endpoint: subObj.endpoint, keys: { p256dh: subObj.keys.p256dh, auth: subObj.keys.auth } },
          ua: navigator.userAgent.slice(0, 200),
          hubId: this.activeHubId,
        });
        debugLog('→', 'register-push-sub', sub.endpoint.slice(0, 40));
      } else {
        debugLog('!', 'push-sub-defer', 'WSS not connected');
      }
    } catch (e) {
      if (userInitiated) this.toast(`通知注册失败：${(e && e.message) || e}`);
      debugLog('!', 'push-sub-err', (e && e.message) || String(e));
    }
  },

  // VAPID 公钥 base64url → Uint8Array (subscribe applicationServerKey 要求格式)
  _urlB64ToUint8(b64u) {
    const pad = '='.repeat((4 - b64u.length % 4) % 4);
    const b64 = (b64u + pad).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(b64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  },

  // 启动跑一次：30 天 TTL 清理 + 5MB quota LRU 评估
  // 每天最多跑一次（meta.lastCleanupTs 记录），避免每次冷启动都全表扫
  async _idbCleanupOnce() {
    if (!this.idb) return;
    try {
      const now = Date.now();
      const last = await this.idb.getMeta('lastCleanupTs');
      if (last && (now - last) < 24 * 3600 * 1000) return; // 24h 内已跑过
      await this.idb.setMeta('lastCleanupTs', now);
      const cutoff = now - 30 * 86400 * 1000;
      const n = await this.idb.cleanupOlderThan(cutoff);
      if (n > 0) debugLog('!', 'idb-ttl-drop', String(n));
      await this.idb.enforceQuota(5 * 1024 * 1024);
    } catch (_) { /* 静默 */ }
  },

  registerSW() {
    if (!('serviceWorker' in navigator)) return;
    // 受控升级（v0.4.8 起）：
    // - 旧版 sw 装上就 skipWaiting + claim → 抢占在用 tab → modal/artifact 半破
    // - 新版只在用户主动点 toast 才切换：
    //   1) install 完，sw postMessage SW_INSTALLED → client 弹 toast
    //   2) 用户点 toast → client 给 waiting sw 发 SKIP_WAITING
    //   3) sw skipWaiting → controllerchange → location.reload 用新代码
    let reloadingFromSW = false;
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'SW_INSTALLED') {
        this._showUpdateToast();
      }
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      // 用户已点过『现在刷新』再触发；防御性加 flag 避免某些场景反复 reload
      if (reloadingFromSW) return;
      reloadingFromSW = true;
      try { location.reload(); } catch (_) {}
    });
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      this._swReg = reg;
      // 如果首次进页面时 waiting 已经存在（上次安装完没刷新就关掉了），立即提示
      if (reg.waiting && navigator.serviceWorker.controller) {
        this._showUpdateToast();
      }
      // 后续 update 流程：updatefound → installing → state==='installed' 且有 controller → 待刷新
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            this._showUpdateToast();
          }
        });
      });
    }).catch(() => {});
  },

  // 持久 toast：标题 + 操作按钮（『现在刷新』/『稍后』）
  // 只用现有 #toast DOM 的扩展，不新增 CSS 文件
  _showUpdateToast() {
    if (this._updateToastShown) return; // 防止重复弹
    this._updateToastShown = true;
    const existing = document.getElementById('sw-update-toast');
    if (existing) existing.remove();
    const el = document.createElement('div');
    el.id = 'sw-update-toast';
    el.style.cssText = 'position:fixed;left:50%;bottom:calc(20px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:9999;max-width:92vw;background:var(--card,#fff);color:var(--ink,#1d1d1f);border:1px solid var(--border,#d2d2d7);border-radius:12px;padding:12px 14px;box-shadow:0 8px 24px rgba(0,0,0,.18);display:flex;align-items:center;gap:10px;font-size:13px;line-height:1.4';
    el.innerHTML = `
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;margin-bottom:2px">新版本已就绪</div>
        <div style="color:var(--ink-mute,#6e6e73);font-size:12px">点刷新加载最新代码（不刷新可继续用当前版本）</div>
      </div>
      <button id="sw-upd-later" style="background:transparent;border:1px solid var(--border,#d2d2d7);color:var(--ink-mute,#6e6e73);border-radius:8px;padding:7px 10px;font-size:12px;font-family:inherit;cursor:pointer">稍后</button>
      <button id="sw-upd-now" style="background:var(--accent,#0071e3);border:none;color:#fff;border-radius:8px;padding:7px 12px;font-size:12px;font-weight:600;font-family:inherit;cursor:pointer">刷新</button>
    `;
    document.body.appendChild(el);
    const later = el.querySelector('#sw-upd-later');
    const now = el.querySelector('#sw-upd-now');
    later.addEventListener('click', () => { el.remove(); this._updateToastShown = false; });
    now.addEventListener('click', () => {
      const reg = this._swReg;
      const waiting = reg && reg.waiting;
      if (waiting) {
        try { waiting.postMessage({ type: 'SKIP_WAITING' }); } catch (_) {}
        // controllerchange 监听会触发 reload；兜底 2s 没切换就硬 reload
        setTimeout(() => { try { location.reload(); } catch (_) {} }, 2000);
      } else {
        // 没有 waiting 也强制 reload（极少见，但避免按钮无响应）
        try { location.reload(); } catch (_) {}
      }
    });
  },

  bindUI() {
    // 配对屏 数字键盘
    document.getElementById('pair-keypad').addEventListener('click', (e) => {
      const btn = e.target.closest('.key');
      if (!btn || btn.classList.contains('empty')) return;
      const k = btn.dataset.key;
      if (k === 'del') this.pinBackspace();
      else if (/^\d$/.test(k)) this.pinType(k);
    });
    // 主屏 composer：点击任意区域 → 弹全屏输入 modal（绕开鸿蒙 PWA 键盘遮挡）
    // composer-input 本身设为只读展示（点击触发 modal）；真正输入在 modal 里
    const composerInput = document.getElementById('composer-input');
    const composerSend = document.getElementById('composer-send');
    composerInput.setAttribute('contenteditable', 'false');
    composerInput.style.cursor = 'pointer';
    composerInput.addEventListener('click', () => this.openInputModal());
    composerSend.addEventListener('click', () => this.openInputModal());
    // 输入 modal 内的事件
    const imSend = document.getElementById('im-btn-send');
    const imCancel = document.getElementById('im-btn-cancel');
    const imTextarea = document.getElementById('im-textarea');
    if (imCancel) imCancel.addEventListener('click', () => this.closeInputModal(false));
    if (imSend) imSend.addEventListener('click', () => this.closeInputModal(true));
    if (imTextarea) {
      imTextarea.addEventListener('input', () => {
        imSend.disabled = !imTextarea.value.trim();
      });
      // 真键盘 enter 提交（mobile 软键盘 enterkeyhint=send 时按"发送"键触发）
      imTextarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          this.closeInputModal(true);
        }
      });
    }
    // 主屏 "新对话" 按钮 → 弹 modal 选 kind（Claude/Codex）
    document.getElementById('btn-new').addEventListener('click', () => this.showNewSessionModal());
    // T07 v0.5.1：#btn-history / #btn-debug / #btn-hub 已从 navbar 删除，handler 改绑 drawer footer link。
    // 保留 guard 以防旧 client 缓存 index.html（grace period）。
    const histBtn = document.getElementById('btn-history');
    if (histBtn) histBtn.addEventListener('click', () => this.showArtifactHistory());
    // ☰ menu → 弹左侧 drawer（会话列表 + 当前 hub）
    const menuBtn = document.getElementById('btn-menu');
    if (menuBtn) menuBtn.addEventListener('click', () => this.openDrawer());
    // drawer 内的事件绑定
    const overlay = document.getElementById('drawer-overlay');
    if (overlay) {
      // 点 mask 关闭
      overlay.querySelector('.drawer-mask').addEventListener('click', () => this._requestCloseDrawer('drawer-mask'));
      // 切 hub
      document.getElementById('drawer-switch-hub').addEventListener('click', () => {
        this.closeDrawer({ skipHistory: true });
        this.showHubSelector();
      });
      // 新建会话
      document.getElementById('drawer-new-session').addEventListener('click', () => {
        this.closeDrawer({ skipHistory: true });
        this.showNewSessionModal();
      });
      // 调试入口（drawer footer link）
      document.getElementById('drawer-debug-link').addEventListener('click', () => {
        this.closeDrawer({ skipHistory: true });
        this.showDebugPanel();
      });
      // T07 v0.5.1：历史 artifact 入口（drawer footer link，原 navbar 🕘 按钮迁移）
      const drawerHistBtn = document.getElementById('drawer-history-link');
      if (drawerHistBtn) drawerHistBtn.addEventListener('click', () => {
        this.closeDrawer({ skipHistory: true });
        this.showArtifactHistory();
      });
      const drawerHubViewBtn = document.getElementById('drawer-hub-view-link');
      if (drawerHubViewBtn) drawerHubViewBtn.addEventListener('click', () => {
        this.closeDrawer({ skipHistory: true });
        this.showHubView();
      });
      const drawerPushBtn = document.getElementById('drawer-push-link');
      if (drawerPushBtn) drawerPushBtn.addEventListener('click', () => {
        this.closeDrawer({ skipHistory: true });
        this._setupPushNotifications(true, true).catch(() => {});
      });
      // AI Daily 入口
      const aiDailyBtn = document.getElementById('drawer-app-aidaily');
      if (aiDailyBtn) aiDailyBtn.addEventListener('click', () => {
        this.closeDrawer({ skipHistory: true });
        this.showAiDaily();
      });
      // AI Daily 内顶栏：返回 + 刷新
      const backBtn = document.getElementById('btn-aidaily-back');
      if (backBtn) backBtn.addEventListener('click', () => this.closeAiDaily());
      const reloadBtn = document.getElementById('btn-aidaily-reload');
      if (reloadBtn) reloadBtn.addEventListener('click', () => {
        const f = document.getElementById('aidaily-frame');
        if (f) f.src = f.src.split('?')[0] + '?t=' + Date.now();
      });
      // 搜索过滤
      document.getElementById('drawer-search-input').addEventListener('input', (e) => {
        this.drawerSearchQuery = e.target.value.toLowerCase();
        this._renderDrawerList();
      });
    }
    window.addEventListener('resize', () => this._syncDesktopDrawerMode());
    window.addEventListener('orientationchange', () => setTimeout(() => this._syncDesktopDrawerMode(), 80));
    // 旧 hub 按钮已隐藏；保留 click 兼容（不会触发因为 display:none）
    const hubBtn = document.getElementById('btn-hub');
    if (hubBtn) hubBtn.addEventListener('click', () => this.showHubSelector());
    const setBtn = document.getElementById('btn-settings');
    if (setBtn) setBtn.addEventListener('click', () => this.showSettings());
    const ptyInput = document.getElementById('pty-input');
    const ptySend = document.getElementById('pty-btn-send');
    const ptyCtrlC = document.getElementById('pty-btn-ctrlc');
    const ptyClear = document.getElementById('pty-btn-clear');
    if (ptyInput) {
      ptyInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this._sendPtyLine();
        }
      });
    }
    if (ptySend) ptySend.addEventListener('click', () => this._sendPtyLine());
    if (ptyCtrlC) ptyCtrlC.addEventListener('click', () => this._sendPtyRaw('\x03'));
    if (ptyClear) ptyClear.addEventListener('click', () => this._clearPtyDisplay());
    // 旧 navbar 🐛 按钮已迁移到 drawer footer，但保留 guard 避免老缓存的 index.html 失能
    const dbgBtn = document.getElementById('btn-debug');
    if (dbgBtn) dbgBtn.addEventListener('click', () => this.showDebugPanel());
    // T07 v0.5.1：版本号挪到 drawer footer；旧 #nav-ver 已删除，保留 guard
    const drawerVerEl = document.getElementById('drawer-ver');
    if (drawerVerEl) drawerVerEl.textContent = `${PWA_VERSION} · ${PWA_SW_LABEL}`;
    const verEl = document.getElementById('nav-ver');
    if (verEl) verEl.textContent = `PWA ${PWA_VERSION} · ${PWA_SW_LABEL}`;
    // 软键盘自适应（纯声明式，详见函数注释）
    this._installKeyboardWatcher();
  },

  // 软键盘自适应（v0.4.0 重写）
  // ============================================================
  // 主方案 = HTML viewport meta `interactive-widget=resizes-content`
  //        + CSS `html,body { height: 100dvh }`
  //        + CSS `.composer { position: fixed; bottom: env(safe-area-inset-bottom) }`
  //
  // 原理：Chromium 108+（包括华为浏览器较新版本、Chrome on Android、Edge 等）
  //       看到 resizes-content 后，键盘弹起时同时收缩 Layout + Visual Viewport。
  //       fixed 元素的 bottom:0 相对 Layout Viewport 计算 → composer 自动跟键盘上浮；
  //       100dvh 同步收缩，stream 区域不会被键盘遮住。
  //       键盘收起时浏览器自己反向恢复。完全零 JS、零 polling、零误判。
  //
  // 为什么不再用 visualViewport 监听 / polling / 320px fallback？
  //   - Chrome 108+ Android 键盘弹起时根本不 fire visualViewport.resize（默认行为已改）
  //   - 地址栏伸缩反而 fire → polling 必然误判"键盘消失"导致 composer 提前跳回
  //   - 320px 是盲猜，不同设备键盘高度差异大（Mate X6 实际 600+px）
  //   - v0.1-v0.3.3 三个版本越叠 hack 越坏，用户已反复报怨"瞎改"
  //
  // 失败模式：老 Chromium（<108）不认 resizes-content，键盘会盖住 composer。
  //          但用户能感知（不会"自己跳"），可滚动或点 composer 外收键盘。
  //          这是诚实的 graceful degradation。
  //
  // 可选 enhancement：Chromium 94+ Virtual Keyboard API 显式声明意图，
  //                   防止 SW 旧 cache 留下的旧状态污染。
  _installKeyboardWatcher() {
    // Enhancement：显式声明"希望浏览器继续 resize layout 而不是让键盘 overlay"。
    // false 是默认值，写一遍是为了保险（v0.3.x 老 SW 可能残留 true 设置）。
    if ('virtualKeyboard' in navigator) {
      try { navigator.virtualKeyboard.overlaysContent = false; } catch {}
    }

    // ============================================================
    // Fallback for 华为浏览器/ArkWeb (Chromium 114 fork) PWA standalone
    // ============================================================
    // 调研发现：Mate X6 鸿蒙 NEXT/4.3 自带浏览器内核 = ArkWeb (Chromium 114 fork)。
    // 理论支持 interactive-widget=resizes-content（Chrome 108+），
    // 但华为 fork 实际行为在 PWA standalone 下无法 100% 保证（社区有反例）。
    //
    // 兜底策略（纯事件驱动，零 polling、零盲猜）：
    //   - 监听 visualViewport.resize / scroll （键盘弹起、地址栏伸缩都会 fire 真实值）
    //   - 永远计算真实差值 kb = max(0, innerHeight - vv.height)——不预测"这是不是键盘"
    //   - 写入 --kb-px CSS 变量；CSS 用 transform: translateY(-var(--kb-px)) 上移 composer
    //   - 用 transform 不用 bottom：GPU 合成、不触发 layout reflow
    //
    // 不做的事：
    //   - 不 polling/setInterval 兜底 → Chrome 108+ 行为变化后会误判
    //   - 不监听 focusin/focusout 做"猜键盘" → 与真实视口脱节
    //   - 不 fallback 320px 盲猜键盘高度
    //   - 不在 vv.height ≈ innerHeight 时强制 reset → 浏览器自己会 fire kb=0
    //
    // 与主方案叠加无冲突：
    //   - interactive-widget 生效时：Layout Viewport 已收缩 → vv.height === innerHeight → kb 永远为 0 → translateY(0) 静默 no-op
    //   - interactive-widget 不生效时：vv.height < innerHeight，kb = 真实键盘像素，
    //     composer 用浏览器算的真实值精准上浮，不是猜的
    const vv = window.visualViewport;
    if (!vv) return; // 极老内核没 vv，无能为力

    const root = document.documentElement;
    let lastKb = -1;
    const apply = () => {
      const kb = Math.max(0, Math.round(window.innerHeight - vv.height));
      // 容差 2px 抖动，避免 sub-pixel 反复触发 style update
      if (Math.abs(kb - lastKb) >= 2) {
        lastKb = kb;
        root.style.setProperty('--kb-px', kb + 'px');
      }
    };
    vv.addEventListener('resize', apply);
    // 部分浏览器键盘弹起只 scroll 不 resize（vv 上移），也得跟
    vv.addEventListener('scroll', apply);
    apply(); // 初始
  },

  showPairing() {
    this._switchView('view-pairing');
    this.pinBuf = '';
    this._renderPin();
    this._clearPairError();
    this.refreshPairHubs().catch(() => {});
  },

  _apiBase() {
    return new URLSearchParams(location.search).get('api') || '';
  },

  async refreshPairHubs() {
    const el = document.getElementById('pair-hub-target');
    if (!el) return;
    el.innerHTML = '<div class="pair-hub-status">正在读取在线 Hub...</div>';
    try {
      const resp = await fetch(this._apiBase() + '/healthz', { cache: 'no-store' });
      const data = await resp.json().catch(() => ({}));
      const hubs = Array.isArray(data.hubs) ? data.hubs.filter(h => h && h.hubId) : [];
      this.pairHubs = hubs;
      const preferred = this._choosePreferredPairHub(hubs);
      this.pairTargetHubId = preferred || '';
      this._renderPairHubs();
    } catch (e) {
      this.pairHubs = [];
      this.pairTargetHubId = '';
      el.innerHTML = '<button class="pair-hub-refresh" type="button" id="pair-hub-refresh">Hub 列表读取失败，点此重试</button>';
      const btn = document.getElementById('pair-hub-refresh');
      if (btn) btn.addEventListener('click', () => this.refreshPairHubs().catch(() => {}));
    }
  },

  _choosePreferredPairHub(hubs) {
    if (!hubs || !hubs.length) return '';
    const saved = localStorage.getItem(STORAGE_ACTIVE_HUB);
    if (saved && hubs.some(h => h.hubId === saved)) return saved;
    const real = hubs.filter(h => !h.isLegacy);
    const pool = real.length ? real : hubs;
    const sorted = pool.slice().sort((a, b) => (Number(a.connectedAt) || 0) - (Number(b.connectedAt) || 0));
    return sorted.length ? sorted[sorted.length - 1].hubId : '';
  },

  _renderPairHubs() {
    const el = document.getElementById('pair-hub-target');
    if (!el) return;
    const hubs = this.pairHubs || [];
    if (!hubs.length) {
      el.innerHTML = '<div class="pair-hub-status bad">没有检测到在线 Hub</div><button class="pair-hub-refresh" type="button" id="pair-hub-refresh">刷新 Hub 列表</button>';
      const btn = document.getElementById('pair-hub-refresh');
      if (btn) btn.addEventListener('click', () => this.refreshPairHubs().catch(() => {}));
      return;
    }
    const cards = hubs.map((h) => {
      const label = h.friendlyName || (h.pid ? `Hub PID ${h.pid}` : `Hub ${String(h.hubId).slice(0, 10)}`);
      const meta = [h.hostname, h.version, h.isLegacy ? 'legacy' : 'real'].filter(Boolean).join(' · ');
      const active = h.hubId === this.pairTargetHubId;
      return `<button class="pair-hub-card ${active ? 'on' : ''}" type="button" data-hubid="${this._esc(h.hubId)}">
        <span class="pair-hub-name">${this._esc(label)}</span>
        <span class="pair-hub-meta">${this._esc(meta || h.hubId)}</span>
      </button>`;
    }).join('');
    el.innerHTML = `<div class="pair-hub-title">配对目标 Hub</div><div class="pair-hub-list">${cards}</div><button class="pair-hub-refresh" type="button" id="pair-hub-refresh">刷新</button>`;
    el.querySelectorAll('.pair-hub-card').forEach(btn => {
      btn.addEventListener('click', () => {
        this.pairTargetHubId = btn.dataset.hubid || '';
        this._renderPairHubs();
      });
    });
    const selected = el.querySelector('.pair-hub-card.on');
    if (selected && typeof selected.scrollIntoView === 'function') {
      try { selected.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch {}
    }
    const refresh = document.getElementById('pair-hub-refresh');
    if (refresh) refresh.addEventListener('click', () => this.refreshPairHubs().catch(() => {}));
  },
  showMain() {
    this._switchView('view-main');
  },
  // AI Daily 全屏 mini-app（iframe 嵌 /ai-daily/tiktok.html，同源 HTTPS）
  // 关键：不能 reload PWA 主页（会断 WSS）；只切 view + 设 iframe src
  showAiDaily() {
    const f = document.getElementById('aidaily-frame');
    if (f && !f.src) f.src = '/ai-daily/tiktok.html';
    this._switchView('view-aidaily');
  },
  closeAiDaily() {
    // 视频暂停（iframe.contentWindow 同源可访问）
    try {
      const f = document.getElementById('aidaily-frame');
      const w = f && f.contentWindow;
      if (w) {
        const vids = w.document.querySelectorAll('video');
        vids.forEach(v => { try { v.pause(); } catch {} });
      }
    } catch {}
    this._switchView('view-main');
  },

  pinType(d) {
    if (this.pinBuf.length >= 6) return;
    this.pinBuf += d;
    this._renderPin();
    if (this.pinBuf.length === 6) {
      this.submitPair();
    }
  },
  pinBackspace() {
    if (!this.pinBuf.length) return;
    this.pinBuf = this.pinBuf.slice(0, -1);
    this._renderPin();
    this._clearPairError();
  },
  _renderPin() {
    const cells = document.querySelectorAll('#pair-pin .pin-cell');
    cells.forEach((c, i) => {
      c.classList.remove('filled', 'cur');
      c.textContent = this.pinBuf[i] || '';
      if (i < this.pinBuf.length) c.classList.add('filled');
      else if (i === this.pinBuf.length) c.classList.add('cur');
    });
  },
  _clearPairError() {
    document.getElementById('pair-error').textContent = '';
  },
  showPairError(code) {
    const labels = {
      invalid_pin: '验证码错误',
      pin_expired: '验证码已过期，请让 Hub 重新生成',
      pin_locked: '尝试次数过多，5 分钟后再试',
      agent_offline: 'Hub 离线，请确认家里 Hub 在线',
      hub_timeout: 'Hub 无响应，请稍后重试',
      network: '网络错误，请检查连接',
    };
    document.getElementById('pair-error').textContent = labels[code] || `配对失败: ${code}`;
  },

  async submitPair() {
    try {
      // dev override：?api=http://127.0.0.1:9081 让本地 chrome 走 mock gateway 配对
      const apiBase = this._apiBase();
      const resp = await fetch(apiBase + '/api/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pin: this.pinBuf,
          deviceName: this._guessDeviceName(),
          hubId: this.pairTargetHubId || undefined,
        }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        this.showPairError(data.error || 'unknown');
        if (data.error !== 'pin_locked') {
          this.pinBuf = '';
          this._renderPin();
        }
        return;
      }
      localStorage.setItem(STORAGE.DEVICE_TOKEN, data.deviceToken);
      if (data.hubId) {
        this.activeHubId = data.hubId;
        localStorage.setItem(STORAGE_ACTIVE_HUB, data.hubId);
      }
      this.toast('配对成功');
      this.startSession(data.deviceToken);
    } catch (e) {
      this.showPairError('network');
      this.pinBuf = '';
      this._renderPin();
    }
  },

  _guessDeviceName() {
    const ua = navigator.userAgent;
    if (/HUAWEI|HONOR/i.test(ua)) return 'Huawei';
    if (/iPhone/i.test(ua)) return 'iPhone';
    if (/iPad/i.test(ua)) return 'iPad';
    if (/Android/i.test(ua)) return 'Android';
    return 'Mobile';
  },

  startSession(deviceToken) {
    // dev override：?gw=ws://127.0.0.1:9081/pwa 让本地 chrome 连本地 mock gateway
    const gwParam = new URLSearchParams(location.search).get('gw');
    const wssUrl = gwParam || ((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/pwa');
    if (this.client) this.client.disconnect();
    this.client = new HubClient({ gatewayUrl: wssUrl, deviceToken });
    this.client.addEventListener('state', (e) => this.onConnLocal(e.detail));
    this.client.addEventListener('reconnected', (e) => this._handleGatewayReconnect(e.detail));
    this.client.addEventListener('conn-state', (e) => this.onConnRemote(e.detail));
    this.client.addEventListener('turn', (e) => this.onTurn(e.detail));
    this.client.addEventListener('session-list', (e) => this.onSessionList(e.detail));
    this.client.addEventListener('hub-snapshot', (e) => this.onHubSnapshot(e.detail));
    this.client.addEventListener('hub-delta', (e) => this.onHubDelta(e.detail));
    this.client.addEventListener('command-ack', (e) => this.onCommandAck(e.detail));
    this.client.addEventListener('hub-view-frame', (e) => this.onHubViewFrame(e.detail));
    this.client.addEventListener('hub-view-input-ack', (e) => this.onHubViewInputAck(e.detail));
    this.client.addEventListener('pty-snapshot', (e) => this.onPtySnapshot(e.detail));
    this.client.addEventListener('pty-data', (e) => this.onPtyData(e.detail));
    this.client.addEventListener('pty-ack', (e) => this.onPtyAck(e.detail));
    this.client.addEventListener('session-created', (e) => this.onSessionCreated(e.detail));
    this.client.addEventListener('session-destroyed', (e) => this.onSessionDestroyed(e.detail));
    this.client.addEventListener('meeting-created', (e) => this.onMeetingCreated(e.detail));
    this.client.addEventListener('meeting-list', (e) => this.onMeetingList(e.detail));
    this.client.addEventListener('artifact-result', (e) => this.onArtifactResult(e.detail));
    this.client.addEventListener('artifact-list', (e) => this.onArtifactList(e.detail));
    this.client.addEventListener('hub-list', (e) => this.onHubList(e.detail));
    this.client.addEventListener('push-sub-ack', (e) => this.onPushSubAck(e.detail));
    this.pendingArtifacts = new Map(); // requestId -> { path, openOnArrive: true }
    this.hubs = []; // multi-hub support
    this.mobileSessions = [];
    this.desktopCards = [];
    this.activeHubId = localStorage.getItem(STORAGE_ACTIVE_HUB) || null;
    // 首次 hub 列表拉取已挪到 HubClient._onOpen（hello 之后立刻发 list-hubs），
    // 不再 1000ms 死等 — 配对完到 drawer 可点的延迟缩短 ~1s
    this.client.addEventListener('error-msg', (e) => this.onErrorMsg(e.detail));
    this.client.addEventListener('auth-failed', () => this.onAuthFailed());
    this.client.addEventListener('weak', () => this.onWeak());
    this.client.connect();
    this.activeSessionId = localStorage.getItem(STORAGE.ACTIVE_SESSION) || DEFAULT_SESSION_ID;
    this.sessions = [];
    // session 隔离 + 历史保留：每个 session 自己的卡片数组（detached DOM），切换时 detach/attach
    // T10 v0.5.4：内存仍是首选（切换 0 延迟），IDB 是 PWA 被杀重启的兜底
    this.sessionCards = new Map();      // sid -> HTMLElement[]
    this.sessionScrollTop = new Map();  // sid -> number
    this.sessionUnread = new Map();     // sid -> number
    this.pendingTurnsBySession = new Map(); // sid -> Array<entry>（之前 this.pendingTurns 全局化的换法）
    this.showMain();
    this._updateNavTitle();
    // T10：冷启动 / PWA 被系统杀重启 → 内存全空，从 IDB 给 active session 回填历史
    // 异步：不阻塞 WSS 握手；hydrate 与 hub turn 续传可能并发，新 turn 走 _appendCard 追加到尾巴自然合并
    const startSid = this.activeSessionId;
    if (this.idb) {
      this._hydrateFromIDB(startSid, '会话');
    }
  },

  onConnLocal(state) {
    // 客户端本地状态：connecting / connected / disconnected
    if (state === 'connected') {
      this._setConn('ok', '已连接 Hub @家');
    } else if (state === 'connecting') {
      this._setConn('connecting', '连接中…');
    } else {
      this._setConn('vps-off', `VPS 不可达 · 重连中`);
    }
  },
  onConnRemote(state) {
    // VPS 转发的 Hub 端状态：ok / hub-off
    if (state === 'ok') this._setConn('ok', '已连接 Hub @家');
    else if (state === 'hub-off') this._setConn('hub-off', 'Hub 离线 · 等待恢复');
    else if (state === 'weak') this._setConn('weak', '网络弱 · 重试中');
  },
  onWeak() {
    this._setConn('weak', '网络弱 · 5s 无回应');
  },
  _setConn(conn, label) {
    // T07 v0.5.1：连接态视觉由 .dot 颜色表达，文字仅 a11y/hover tooltip 用
    const t = document.getElementById('nav-title');
    if (!t) return;
    t.setAttribute('data-conn', conn);
    t.setAttribute('title', label); // 长按/hover 可见全文
    const c = document.getElementById('conn-text');
    if (c) c.textContent = label;
  },

  onTurn(turn) {
    const sid = turn.sessionId || this.activeSessionId;
    // 只对 active session 操作 DOM；非 active 的进 cache + 加 unread（_appendCard 内部处理）
    if (sid === this.activeSessionId) {
      this._removeEmptyHint();
      this._finalizePendingTurn(turn, sid);
    } else {
      // 后台 session 也要把自己的 pending status 推进到 done
      this._finalizePendingTurn(turn, sid);
    }
    this.appendClaudeCard(turn, sid);
  },
  onErrorMsg(msg) {
    if (msg.code === 'agent_offline') {
      if (msg.hubId && msg.hubId === this.activeHubId) {
        localStorage.removeItem(STORAGE_ACTIVE_HUB);
        this.activeHubId = null;
        this.toast('当前 Hub 已离线，正在切换到在线 Hub');
        if (this.client) this.client.requestHubList();
        return;
      }
      this.toast('Hub 离线，请稍后重试');
    }
  },
  onAuthFailed() {
    localStorage.removeItem(STORAGE.DEVICE_TOKEN);
    this.toast('登录已失效，请重新配对');
    this.showPairing();
  },

  // 旧 API：保留兼容，但实际不再被 composer 触发（composer 点击改为弹 modal）
  sendInput() {
    const input = document.getElementById('composer-input');
    const text = (input.innerText || '').trim();
    if (!text) return;
    this.sendInputText(text);
    input.innerText = '';
  },

  // 真正的发送 + 状态机入口（被全屏 modal 与离线兼容路径共用）
  sendInputText(text) {
    if (!text || !text.trim()) return;
    const sid = this.activeSessionId || DEFAULT_SESSION_ID;
    const card = this.appendUserCard(text, sid);
    const sentAt = Date.now();
    const cur = (this.sessions || []).find(s => s.id === sid);
    let ok = false;
    if (cur && cur.source === 'desktop') {
      const res = this.client && this.client.sendHubCommand({
        targetType: cur.targetType || 'session',
        targetId: cur.targetId || cur.id,
        content: text,
        hubId: this.activeHubId,
      });
      ok = !!(res && res.ok);
    } else {
      ok = this.client && this.client.send(text, sid, this.activeHubId);
    }
    this._removeEmptyHint();
    if (card) this._trackPendingTurn(card, sentAt, ok, sid);
  },

  // === 全屏输入 modal（鸿蒙 PWA 键盘遮挡的根治方案） ===
  openInputModal() {
    const modal = document.getElementById('input-modal');
    const ta = document.getElementById('im-textarea');
    const title = document.getElementById('im-title');
    const sendBtn = document.getElementById('im-btn-send');
    if (!modal || !ta) return;
    // 标题显示当前 session 名
    const cur = (this.sessions || []).find(s => s.id === (this.activeSessionId || DEFAULT_SESSION_ID));
    title.textContent = (cur && cur.title) || '新消息';
    ta.value = '';
    sendBtn.disabled = true;
    modal.classList.add('on');
    modal.setAttribute('aria-hidden', 'false');
    // 延迟 focus 确保动画后键盘弹起（华为浏览器 standalone 立即 focus 可能被忽略）
    setTimeout(() => { try { ta.focus(); } catch {} }, 50);
  },

  closeInputModal(shouldSend) {
    const modal = document.getElementById('input-modal');
    const ta = document.getElementById('im-textarea');
    if (!modal) return;
    if (shouldSend && ta) {
      const text = (ta.value || '').trim();
      if (text) this.sendInputText(text);
    }
    if (ta) { try { ta.blur(); } catch {} }
    modal.classList.remove('on');
    modal.setAttribute('aria-hidden', 'true');
  },

  _trackPendingTurn(card, sentAt, sendOk, sid) {
    if (!this.pendingTurnsBySession.has(sid)) this.pendingTurnsBySession.set(sid, []);
    const queue = this.pendingTurnsBySession.get(sid);
    const statusEl = card.querySelector('.turn-user-status');
    const setStatus = (cls, html) => {
      if (!statusEl) return;
      statusEl.className = 'turn-user-status ' + cls;
      statusEl.innerHTML = html;
    };
    if (!sendOk) {
      setStatus('s-error', '⚠ 发送失败（已暂存离线队列）');
      return;
    }
    setStatus('s-sending', '<span class="spin"></span> 发送中…');
    const entry = { card, statusEl, sentAt, setStatus, sid };
    queue.push(entry);
    entry.t1 = setTimeout(() => setStatus('s-sent', '✓ 已送达 Hub'), 800);
    entry.t2 = setTimeout(() => {
      const tick = () => {
        if (entry.done) return;
        const sec = Math.floor((Date.now() - sentAt) / 1000);
        setStatus('s-thinking', `<span class="spin"></span> 思考中… <span class="dur">${sec}s</span>`);
        entry._tickTimer = setTimeout(tick, 1000);
      };
      tick();
    }, 2500);
  },

  // turn 到达 → 取该 session 的最早 pending 切为"完成"。其他 session 的 pending 不受影响
  _finalizePendingTurn(turn, sid) {
    const queue = this.pendingTurnsBySession.get(sid);
    if (!queue || !queue.length) return;
    const entry = queue.shift();
    entry.done = true;
    [entry.t1, entry.t2, entry._tickTimer].forEach(t => t && clearTimeout(t));
    const sec = ((Date.now() - entry.sentAt) / 1000).toFixed(1);
    entry.setStatus('s-done', `✓ 已回复 <span class="dur">${sec}s</span>`);
  },

  onHubList(msg) {
    {
    const prevHubId = this.activeHubId || null;
    this.hubs = (msg.hubs || []).filter(h => h && h.hubId);

    const hubFreshness = (h) => h ? ((h.startedAt || 0) * 10 + (h.connectedAt || 0)) : 0;
    const newestFirst = (items) => items.slice().sort((a, b) => hubFreshness(b) - hubFreshness(a));
    const realHubs = newestFirst(this.hubs.filter(h => !h.isLegacy));
    const allHubs = newestFirst(this.hubs);
    const pickPreferred = () => {
      if (realHubs.length > 0) return realHubs[0].hubId;
      return allHubs[0] ? allHubs[0].hubId : null;
    };

    const current = this.hubs.find(h => h.hubId === this.activeHubId);
    if (!current || (current.isLegacy && realHubs.length > 0)) {
      this.activeHubId = pickPreferred();
    }

    if (this.activeHubId) localStorage.setItem(STORAGE_ACTIVE_HUB, this.activeHubId);
    else localStorage.removeItem(STORAGE_ACTIVE_HUB);

    if (this.activeHubId !== prevHubId) {
      const cur = this.hubs.find(h => h.hubId === this.activeHubId);
      const label = cur ? (cur.friendlyName || (cur.pid ? `PID ${cur.pid}` : cur.hubId.slice(0, 18))) : '';
      if (label) this.toast(`已切换到在线 Hub：${label}`);
      if (this.client && this.activeHubId) {
        this.client.requestSessionList(this.activeHubId);
        this.client.requestMeetingList(this.activeHubId);
        this.client.requestHubSnapshot(this.activeHubId);
      } else {
        this.mobileSessions = [];
        this.desktopCards = [];
        this.sessions = [];
        this._renderDrawerList();
      }
    }

    this._updateNavTitle();
    this._renderDrawerHubInfo();
    if (this.client && this.activeHubId) {
      this.client.requestSessionList(this.activeHubId);
      this.client.requestHubSnapshot(this.activeHubId);
    }
    this._setupPushNotifications().catch(() => {});
    return;
    }
    this.hubs = msg.hubs || [];
    // 优选非 legacy hub（跑新代码 0.2.0+，支持 NEW_SESSION/ARTIFACT 等新协议）
    const realHubs = this.hubs.filter(h => !h.isLegacy);
    const pickPreferred = () => {
      if (realHubs.length > 0) return realHubs[realHubs.length - 1].hubId; // 最新连接的 real hub
      return this.hubs[0] ? this.hubs[0].hubId : null;
    };
    // 没选过 hub
    if (!this.activeHubId && this.hubs.length > 0) {
      this.activeHubId = pickPreferred();
      localStorage.setItem(STORAGE_ACTIVE_HUB, this.activeHubId);
    }
    // 选过的 hub 离线了 → 重新优选
    if (this.activeHubId && !this.hubs.find(h => h.hubId === this.activeHubId)) {
      this.activeHubId = pickPreferred();
      if (this.activeHubId) localStorage.setItem(STORAGE_ACTIVE_HUB, this.activeHubId);
    }
    // 已选 hub 是 legacy 但有 real hub 可用 → 自动迁移（解决之前默认选错的存档）
    const cur = this.hubs.find(h => h.hubId === this.activeHubId);
    if (cur && cur.isLegacy && realHubs.length > 0) {
      this.activeHubId = realHubs[realHubs.length - 1].hubId;
      localStorage.setItem(STORAGE_ACTIVE_HUB, this.activeHubId);
      this.toast(`已切到新版 Hub (${(this.hubs.find(h=>h.hubId===this.activeHubId)||{}).friendlyName||'PID '+(this.hubs.find(h=>h.hubId===this.activeHubId)||{}).pid})`);
    }
    this._updateNavTitle();
    this._renderDrawerHubInfo();
    // T11 Web Push：hub-list 已知 vapidPublicKey 后即可订阅
    // 非阻塞 + 自带 dedup（同 vapid 24h 内不重 subscribe）
    this._setupPushNotifications().catch(() => {});
  },
  onPushSubAck(msg) {
    if (!msg || !msg.ok) {
      const pending = this._pendingPushSub;
      debugLog('!', 'push-sub-ack', msg && (msg.error || 'rejected'));
      this._pendingPushSub = null;
      localStorage.removeItem('hub-mobile/push-sub-at');
      if (pending && pending.userInitiated) this.toast('通知注册被 Hub 拒绝');
      return;
    }
    const pending = this._pendingPushSub;
    if (pending && pending.vapid) {
      localStorage.setItem('hub-mobile/push-vapid', pending.vapid);
      localStorage.setItem('hub-mobile/push-sub-at', String(Date.now()));
      debugLog('←', 'push-sub-ack', (pending.endpoint || '').slice(0, 40));
      if (pending.userInitiated) this.toast('通知已开启');
    }
    this._pendingPushSub = null;
  },

  onSessionList(sessions) {
    this.mobileSessions = (sessions || []).map(s => ({ ...s, source: s.source || 'mobile' }));
    this._mergeSessionViews();
    this._confirmPendingRename();
    // 如果 active session 不在列表里，回退到 default
    if (!this.sessions.find(s => s.id === this.activeSessionId)) {
      this.activeSessionId = DEFAULT_SESSION_ID;
      localStorage.setItem(STORAGE.ACTIVE_SESSION, DEFAULT_SESSION_ID);
    }
    this._updateNavTitle();
    this._renderDrawerList();
    // T11：deep-link 等到 sessions 落地才能 switch
    this._consumePendingDeepLink();
  },

  onHubSnapshot(snapshot) {
    const cards = Array.isArray(snapshot.cards)
      ? snapshot.cards
      : [].concat(snapshot.sessions || [], snapshot.meetings || []);
    const hubId = snapshot.hubId || this.activeHubId || null;
    this.desktopCards = cards.map(c => this._normalizeDesktopCard(c, hubId)).filter(Boolean);
    this._mergeSessionViews();
    this._updateNavTitle();
    this._renderDrawerList();
    this._syncPtyPanelForActiveSession();
    const active = (this.sessions || []).find(s => s.id === this.activeSessionId);
    if (active && active.targetType === 'meeting') this._renderMeetingRemoteState(active);
  },

  onHubDelta(msg) {
    if (msg && msg.card) {
      const card = this._normalizeDesktopCard(msg.card, msg.hubId || this.activeHubId || null);
      if (card) {
        const idx = (this.desktopCards || []).findIndex(c => c.id === card.id);
        if (idx >= 0) this.desktopCards[idx] = { ...this.desktopCards[idx], ...card };
        else this.desktopCards.push(card);
        this._mergeSessionViews();
        this._updateNavTitle();
        this._renderDrawerList();
        if (card.id === this.activeSessionId && card.targetType === 'meeting') this._renderMeetingRemoteState(card);
      }
    }
    if (msg && msg.turn) {
      const sid = msg.turn.sessionId || (msg.card && msg.card.id);
      if (sid) {
        this._finalizePendingTurn(msg.turn, sid);
        this.appendClaudeCard(msg.turn, sid);
      }
    }
  },

  onCommandAck(msg) {
    if (!msg || msg.ok) return;
    this.toast(`发送失败：${msg.error || 'Hub 未接受命令'}`);
  },
  onPtySnapshot(msg) {
    if (!msg || msg.sessionId !== this.ptySessionId) return;
    const text = this._decodePtyB64(msg.dataB64 || '');
    this._setPtyText(text, Number(msg.seq) || 0, !!msg.truncated);
  },
  onPtyData(msg) {
    if (!msg || msg.sessionId !== this.ptySessionId) return;
    const seq = Number(msg.seq) || 0;
    if (seq && seq <= this.ptySeq) return;
    this.ptySeq = Math.max(this.ptySeq || 0, seq);
    this._appendPtyText(this._decodePtyB64(msg.dataB64 || ''));
  },
  onPtyAck(msg) {
    if (!msg || msg.ok) return;
    if (msg.sessionId === this.ptySessionId) this.toast(`终端${msg.action || ''}失败：${msg.error || 'unknown'}`);
  },
  _decodePtyB64(dataB64) {
    try {
      const bin = atob(String(dataB64 || ''));
      const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
      return new TextDecoder('utf-8').decode(bytes);
    } catch {
      try { return decodeURIComponent(escape(atob(String(dataB64 || '')))); } catch { return ''; }
    }
  },
  _initPtyTerminal() {
    const screen = document.getElementById('pty-screen');
    if (!screen) return false;
    if (this.ptyTerm) return true;
    const TerminalCtor = window.Terminal;
    if (!TerminalCtor) {
      this.ptyUseXterm = false;
      screen.classList.add('pty-fallback');
      return false;
    }
    try {
      screen.textContent = '';
      screen.classList.remove('pty-fallback');
      screen.classList.add('pty-xterm-host');
      const term = new TerminalCtor({
        cursorBlink: true,
        convertEol: false,
        disableStdin: false,
        fontFamily: '"Cascadia Mono","SF Mono","Consolas","Menlo",monospace',
        fontSize: 12,
        lineHeight: 1.12,
        scrollback: 6000,
        theme: {
          background: '#0d1117',
          foreground: '#d9e2f2',
          cursor: '#ffffff',
          selectionBackground: '#284b78',
          black: '#0d1117',
          red: '#ff6b6b',
          green: '#5ad66f',
          yellow: '#ffd166',
          blue: '#58a6ff',
          magenta: '#d2a8ff',
          cyan: '#56d4dd',
          white: '#d9e2f2',
          brightBlack: '#6e7681',
          brightRed: '#ff8585',
          brightGreen: '#7ee787',
          brightYellow: '#ffdf5d',
          brightBlue: '#79c0ff',
          brightMagenta: '#d8b9ff',
          brightCyan: '#7ee7f0',
          brightWhite: '#f0f6fc',
        },
      });
      let fit = null;
      if (window.FitAddon && window.FitAddon.FitAddon) {
        fit = new window.FitAddon.FitAddon();
        term.loadAddon(fit);
      }
      term.open(screen);
      term.onData((data) => this._sendPtyRaw(data));
      term.onResize(({ cols, rows }) => {
        if (this.ptySessionId && this.client) {
          this.client.sendPtyResize(this.ptySessionId, cols, rows, this.activeHubId);
        }
      });
      screen.addEventListener('click', () => {
        try { term.focus(); } catch {}
      });
      window.addEventListener('resize', () => this._fitPtyTerminal());
      this.ptyTerm = term;
      this.ptyFit = fit;
      this.ptyUseXterm = true;
      this._fitPtyTerminal();
      return true;
    } catch (e) {
      console.warn('[pwa] xterm init failed, using text fallback', e);
      this.ptyTerm = null;
      this.ptyFit = null;
      this.ptyUseXterm = false;
      screen.classList.add('pty-fallback');
      return false;
    }
  },
  _fitPtyTerminal() {
    if (!this.ptyTerm || !this.ptyFit) return;
    if (this.ptyResizeTimer) clearTimeout(this.ptyResizeTimer);
    this.ptyResizeTimer = setTimeout(() => {
      try { this.ptyFit.fit(); } catch {}
    }, 40);
  },
  _writePtyTerm(text, reset = false, truncated = false) {
    if (!this._initPtyTerminal()) return false;
    try {
      if (reset) this.ptyTerm.reset();
      if (truncated) this.ptyTerm.writeln('[showing tail of remote terminal only]');
      if (text) this.ptyTerm.write(text);
      this._fitPtyTerminal();
      return true;
    } catch (e) {
      console.warn('[pwa] xterm write failed', e);
      return false;
    }
  },
  _cleanPtyText(text) {
    return String(text || '')
      .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\x1b[()][A-Za-z0-9]/g, '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\u001b/g, '');
  },
  _setPtyText(text, seq, truncated) {
    this.ptySeq = Math.max(this.ptySeq || 0, Number(seq) || 0);
    const prefix = truncated ? '[showing tail of remote terminal only]\n' : '';
    this.ptyText = (prefix + this._cleanPtyText(text)).slice(-16000);
    this._updatePtyTailDataset();
    if (!this._writePtyTerm(text, true, truncated)) this._renderPtyText();
  },
  _appendPtyText(text) {
    this.ptyText = (this.ptyText + this._cleanPtyText(text)).slice(-16000);
    this._updatePtyTailDataset();
    if (!this._writePtyTerm(text, false, false)) this._renderPtyText();
  },
  _updatePtyTailDataset() {
    const screen = document.getElementById('pty-screen');
    if (screen) screen.dataset.ptyTail = (this.ptyText || '').slice(-1200);
  },
  _renderPtyText() {
    const screen = document.getElementById('pty-screen');
    if (!screen) return;
    this._updatePtyTailDataset();
    if (this.ptyUseXterm && this.ptyTerm) return;
    screen.textContent = this.ptyText || '等待远程终端...';
    requestAnimationFrame(() => { screen.scrollTop = screen.scrollHeight; });
  },
  _clearPtyDisplay() {
    this.ptyText = '';
    const screen = document.getElementById('pty-screen');
    if (screen) screen.dataset.ptyTail = '';
    if (this.ptyTerm) {
      try { this.ptyTerm.clear(); this.ptyTerm.focus(); return; } catch {}
    }
    this._renderPtyText();
  },
  _syncPtyPanelForActiveSession() {
    const s = (this.sessions || []).find(x => x.id === this.activeSessionId);
    if (!s || s.source !== 'desktop' || s.targetType === 'meeting') {
      this._hidePtyPanel();
      return;
    }
    this._showPtyPanel(s);
  },
  _showPtyPanel(session) {
    const panel = document.getElementById('pty-panel');
    const title = document.getElementById('pty-title-text');
    if (!panel || !session) return;
    panel.hidden = false;
    if (title) title.textContent = `远程终端 · ${session.title || session.id}`;
    const targetId = session.targetId || session.id;
    if (this.ptySessionId && this.ptySessionId !== targetId && this.client) {
      this.client.requestPtyUnsubscribe(this.ptySessionId, this.activeHubId);
    }
    if (this.ptySessionId !== targetId) {
      this.ptySessionId = targetId;
      this.ptySeq = 0;
      this.ptyText = '';
      if (this.ptyTerm) {
        try { this.ptyTerm.reset(); } catch {}
      }
      this._renderPtyText();
    }
    this._initPtyTerminal();
    this._fitPtyTerminal();
    if (this.client) {
      this.client.requestPtySubscribe(targetId, this.ptySeq || 0, this.activeHubId);
      const cols = this.ptyTerm ? this.ptyTerm.cols : 100;
      const rows = this.ptyTerm ? this.ptyTerm.rows : 24;
      this.client.sendPtyResize(targetId, cols, rows, this.activeHubId);
    }
  },
  _hidePtyPanel() {
    const panel = document.getElementById('pty-panel');
    if (panel) panel.hidden = true;
    if (this.ptySessionId && this.client) this.client.requestPtyUnsubscribe(this.ptySessionId, this.activeHubId);
    this.ptySessionId = null;
    this.ptySeq = 0;
    this.ptyText = '';
    if (this.ptyTerm) {
      try { this.ptyTerm.reset(); } catch {}
    }
  },
  _sendPtyRaw(data) {
    if (!this.ptySessionId || !this.client) return false;
    return this.client.sendPtyInput(this.ptySessionId, data, this.activeHubId);
  },
  _sendPtyLine() {
    const input = document.getElementById('pty-input');
    if (!input) return;
    const text = input.value || '';
    if (!text.trim()) return;
    const ok = this._sendPtyRaw(text + '\r');
    if (ok) input.value = '';
    else this.toast('终端未连接，发送失败');
  },

  _normalizeDesktopCard(card, hubId = null) {
    if (!card || !card.id) return null;
    const targetType = card.targetType || (String(card.id).startsWith('meeting:') ? 'meeting' : 'session');
    const normalized = {
      ...card,
      id: targetType === 'meeting' && !String(card.id).startsWith('meeting:') ? `meeting:${card.id}` : card.id,
      targetId: card.targetId || (targetType === 'meeting' ? String(card.id).replace(/^meeting:/, '') : card.id),
      targetType,
      source: 'desktop',
      hubId: card.hubId || hubId || null,
      status: card.status || 'active',
      kind: card.kind || (targetType === 'meeting' ? 'meeting' : 'session'),
      title: card.title || (targetType === 'meeting' ? 'AI 群聊' : card.id),
    };
    if (targetType === 'meeting') {
      normalized.subSessions = Array.isArray(card.subSessions) ? card.subSessions.slice() : [];
      normalized.members = this._normalizeMeetingMembers(card, normalized.subSessions);
      normalized.timeline = this._normalizeMeetingTimeline(card.timeline);
      normalized.subSessionCount = card.subSessionCount || normalized.subSessions.length || normalized.members.length || 0;
      normalized.sendTarget = card.sendTarget || 'all';
      normalized.scene = card.scene || card.mode || 'general';
      normalized.mode = card.mode || card.scene || 'general';
    }
    return normalized;
  },

  _normalizeMeetingMembers(card, subSessions) {
    const members = Array.isArray(card.members) ? card.members : [];
    const subs = Array.isArray(subSessions) ? subSessions : [];
    const count = Math.max(members.length, subs.length, card.subSessionCount || 0);
    const out = [];
    for (let i = 0; i < count; i++) {
      const m = members[i] || {};
      const sid = m.sid || m.sessionId || subs[i] || null;
      out.push({
        index: typeof m.index === 'number' ? m.index : i,
        sid,
        kind: m.kind || 'assistant',
        model: m.model || null,
        title: m.title || sid || `Member ${i + 1}`,
        status: m.status || 'active',
      });
    }
    return out;
  },

  _normalizeMeetingTimeline(timeline) {
    if (!Array.isArray(timeline)) return [];
    return timeline.slice(-40).map((item, index) => ({
      idx: typeof item.idx === 'number' ? item.idx : index,
      sid: item.sid || item.sessionId || null,
      role: item.role || (item.sid === 'user' ? 'user' : 'assistant'),
      text: String(item.text || item.content || '').slice(0, 1800),
      ts: item.ts || item.completedAt || item.createdAt || null,
      model: item.model || null,
    })).filter(item => item.text);
  },

  _removeMeetingRemoteState() {
    const old = document.querySelector('[data-meeting-remote-state="true"]');
    if (old) old.remove();
  },

  _renderMeetingRemoteState(session) {
    const stream = document.getElementById('stream');
    if (!stream) return;
    this._removeMeetingRemoteState();
    if (!session || session.targetType !== 'meeting') return;
    const members = Array.isArray(session.members) ? session.members : [];
    const timeline = Array.isArray(session.timeline) ? session.timeline : [];
    const wrap = document.createElement('div');
    wrap.className = 'meeting-remote-state';
    wrap.dataset.meetingRemoteState = 'true';
    wrap.dataset.meetingId = session.id || '';
    const subtitle = [
      session.scene || session.mode || 'general',
      `${session.subSessionCount || members.length || 0} members`,
      `send: ${session.sendTarget || 'all'}`,
    ].filter(Boolean).join(' · ');
    const memberHtml = members.length
      ? members.map(m => {
          const label = [m.kind || 'assistant', m.model].filter(Boolean).join(' · ');
          return `<div class="meeting-member-chip" data-kind="${this._esc(m.kind || '')}" data-sid="${this._esc(m.sid || '')}" role="button" tabindex="0">
            <span class="meeting-member-dot"></span>
            <span class="meeting-member-main">${this._esc(label || 'assistant')}</span>
            <span class="meeting-member-sub">${this._esc(m.title || m.sid || '')}</span>
          </div>`;
        }).join('')
      : '<div class="meeting-remote-empty">No remote members reported yet.</div>';
    const timelineHtml = timeline.length
      ? timeline.slice(-12).map(t => `<div class="meeting-timeline-row" data-role="${this._esc(t.role || '')}">
          <div class="meeting-timeline-meta">${this._esc(t.role || 'assistant')}${t.model ? ' · ' + this._esc(t.model) : ''}${t.ts ? ' · ' + this._esc(this._fmtTime(t.ts)) : ''}</div>
          <div class="meeting-timeline-text">${this._esc(t.text)}</div>
        </div>`).join('')
      : '<div class="meeting-remote-empty">Waiting for Hub meeting timeline.</div>';
    wrap.innerHTML = `
      <div class="meeting-remote-head">
        <div>
          <div class="meeting-remote-kicker">Remote AI Hub meeting</div>
          <div class="meeting-remote-title">${this._esc(session.title || 'AI 群聊')}</div>
          <div class="meeting-remote-sub">${this._esc(subtitle)}</div>
        </div>
        <div class="meeting-remote-pill">live</div>
      </div>
      <div class="meeting-member-grid">${memberHtml}</div>
      <div class="meeting-timeline">
        <div class="meeting-section-label">Latest meeting timeline</div>
        ${timelineHtml}
      </div>`;
    stream.prepend(wrap);
    wrap.querySelectorAll('.meeting-member-chip[data-sid]').forEach(chip => {
      const jump = () => {
        const sid = chip.dataset.sid;
        if (!sid) return;
        const target = (this.sessions || []).find(s => s.id === sid || s.targetId === sid);
        if (!target) {
          this.toast('成员会话还未同步到列表');
          return;
        }
        this.switchSession(target.id);
      };
      chip.addEventListener('click', jump);
      chip.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          jump();
        }
      });
    });
  },

  _mergeSessionViews() {
    const merged = [];
    const seen = new Set();
    for (const s of (this.desktopCards || [])) {
      if (!s || !s.id || seen.has(s.id)) continue;
      seen.add(s.id);
      merged.push(s);
    }
    for (const s of (this.mobileSessions || [])) {
      if (!s || !s.id || seen.has(s.id)) continue;
      seen.add(s.id);
      merged.push(s);
    }
    this.sessions = merged;
  },

  _confirmPendingRename() {
    const pending = this._pendingRename;
    if (!pending) return;
    const s = (this.sessions || []).find(item => item.id === pending.sessionId);
    if (!s || s.title !== pending.title) return;
    if (pending.timer) clearTimeout(pending.timer);
    this._pendingRename = null;
    this.toast(`已改名为「${pending.title}」`);
  },

  // === Drawer 会话管理（P0） ===
  openDrawer() {
    const overlay = document.getElementById('drawer-overlay');
    if (!overlay) return;
    // 拉最新 sessions（多 hub 切换后可能不同步）
    if (this.client) {
      this.client.requestHubList();
      if (this.activeHubId) this.client.requestSessionList(this.activeHubId);
      if (this.activeHubId) this.client.requestMeetingList(this.activeHubId);
      if (this.activeHubId) this.client.requestHubSnapshot(this.activeHubId);
    }
    this._renderDrawerHubInfo();
    this._renderDrawerList();
    if (this._syncDesktopDrawerMode()) return;
    if (overlay.classList.contains('on')) return;
    overlay.classList.add('on');
    overlay.setAttribute('aria-hidden', 'false');
    this._pushDrawerHistory();
  },
  closeDrawer(opts = {}) {
    const overlay = document.getElementById('drawer-overlay');
    if (overlay && overlay.classList.contains('on')
      && this.drawerHistoryActive
      && !opts.fromHistory
      && !opts.skipHistory
      && !this.drawerHistoryClosing) {
      return this._requestCloseDrawer('close');
    }
    if (overlay) { overlay.classList.remove('on'); overlay.setAttribute('aria-hidden', this._isDesktopPersistentDrawer() ? 'false' : 'true'); }
    this.drawerHistoryActive = false;
    this.drawerHistoryToken = null;
    this.drawerHistoryClosing = false;
    this._syncDesktopDrawerMode();
    return true;
  },
  _renderDrawerHubInfo() {
    const curHub = (this.hubs || []).find(h => h.hubId === this.activeHubId);
    const name = curHub ? (curHub.friendlyName || (curHub.pid ? `PID ${curHub.pid}` : curHub.hubId.slice(0, 18))) : '(未选)';
    const dot = document.querySelector('#drawer-hub-name .dot');
    const text = document.querySelector('#drawer-hub-name .hub-text');
    if (text) text.textContent = name;
    if (dot) dot.style.background = curHub ? (curHub.isLegacy ? 'var(--warn)' : 'var(--ok)') : 'var(--err)';
  },
  _renderDrawerList() {
    const list = document.getElementById('drawer-list');
    if (!list) return;
    const q = (this.drawerSearchQuery || '').trim();
    const all = this.sessions || [];
    // 排序优先级：mobile-default (兜底永远第一) → pinned (按 pinnedAt desc) → lastMessageTime desc
    const sorted = all.slice().sort((a, b) => {
      if (a.id === DEFAULT_SESSION_ID) return -1;
      if (b.id === DEFAULT_SESSION_ID) return 1;
      const pa = a.pinned ? 1 : 0;
      const pb = b.pinned ? 1 : 0;
      if (pa !== pb) return pb - pa;
      if (pa && pb) return (b.pinnedAt || 0) - (a.pinnedAt || 0);
      return (b.lastMessageTime || 0) - (a.lastMessageTime || 0);
    });
    const filtered = q ? sorted.filter(s => (s.title || '').toLowerCase().includes(q)) : sorted;
    if (!filtered.length) {
      list.innerHTML = `<div class="dsess-empty"><span class="big">💬</span>${q ? '无匹配会话' : '还没创建会话<br>点下方「+ 新建会话」开始'}</div>`;
    } else {
      list.innerHTML = filtered.map(s => this._renderSessionRow(s)).join('');
      list.querySelectorAll('.dsess').forEach(row => {
        this._attachSessionRowHandlers(row, filtered);
      });
    }
    // 底部统计
    const ftrCount = document.getElementById('drawer-ftr-count');
    if (ftrCount) {
      const live = all.filter(s => s.status === 'active').length;
      ftrCount.textContent = `${all.length} 会话 · ${live} active`;
    }
  },
  _renderSessionRow(s) {
    const isActive = s.id === this.activeSessionId;
    const isDefault = s.id === DEFAULT_SESSION_ID;
    const kind = s.kind || 'claude';
    const iconLetter = s.targetType === 'meeting' ? 'AI' : kind === 'codex' ? '○' : kind === 'gemini' ? 'G' : kind === 'powershell' ? '▶' : 'C';
    const liveDot = s.status === 'active' ? '<span class="live"></span>' : '<span class="dormant"></span>';
    // 用户置顶 → 📌；mobile-default 兜底 session 也保留 📌（视觉一致）
    const pin = (s.pinned || isDefault) ? '<span class="pin" title="已置顶">📌</span>' : '';
    const when = this._fmtRelTime(s.lastMessageTime || s.createdAt);
    // T08 v0.5.2：长 sessionId 标题（PWA 自动生成 'multi-input-claude-1780838024501' 之类含 13+ 位时间戳）压成
    // '#1780...4501' chip 形态——drawer 宽 338px 留给标题 ~280px，长 ID 三个点吃中间用户根本分不清谁是谁
    let rawTitle = s.title || '(无标题)';
    if (rawTitle.length > 20 && /\d{13,}/.test(rawTitle)) {
      rawTitle = rawTitle.replace(/(\d{4})\d+(\d{4})/, '#$1...$2');
    }
    const title = this._esc(rawTitle);
    const source = s.source === 'desktop' ? (s.targetType === 'meeting' ? '群聊 Hub' : '桌面 Hub') : this._esc(kind);
    const preview = s.preview ? `<span class="d-preview">${this._esc(String(s.preview).slice(0, 48))}</span>` : '';
    return `<div class="dsess${isActive ? ' active' : ''}${isDefault ? ' is-default' : ''}" data-sid="${this._esc(s.id)}">
      <div class="d-icon k-${this._esc(kind)}">${iconLetter}</div>
      <div class="d-meta">
        <div class="d-title">${liveDot}${pin}${title}</div>
        <div class="d-sub"><span class="d-kind">${source}</span><span class="d-when">${when}</span>${preview}</div>
      </div>
    </div>`;
  },
  // 长按 350ms 弹 action sheet；短按 = 切换 session
  // pointer 事件比 touchstart 兼容性好（鸿蒙 ArkWeb 都支持 pointerdown）
  // 关键：movement > 8px 视为滑动列表（不触发菜单），避免与 drawer 滚动冲突
  _attachSessionRowHandlers(row, sessions) {
    const LONG_PRESS_MS = 350;
    const MOVE_TOLERANCE_PX = 8;
    let pressTimer = null;
    let longPressed = false;
    let startX = 0, startY = 0;
    const cancelTimer = () => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    };
    const onDown = (e) => {
      longPressed = false;
      // 用 clientX/Y 兼容 pointer/touch
      startX = e.clientX || (e.touches && e.touches[0] && e.touches[0].clientX) || 0;
      startY = e.clientY || (e.touches && e.touches[0] && e.touches[0].clientY) || 0;
      pressTimer = setTimeout(() => {
        longPressed = true;
        pressTimer = null;
        // 震动反馈（鸿蒙/Android 都支持，iOS Safari 无视）
        try { if (navigator.vibrate) navigator.vibrate(20); } catch {}
        try {
          const sel = window.getSelection && window.getSelection();
          if (sel && sel.removeAllRanges) sel.removeAllRanges();
        } catch {}
        const sid = row.dataset.sid;
        const sess = (sessions || []).find(s => s.id === sid);
        if (sess) this._showSessionActionSheet(sess);
      }, LONG_PRESS_MS);
    };
    const onMove = (e) => {
      if (!pressTimer) return;
      const x = e.clientX || (e.touches && e.touches[0] && e.touches[0].clientX) || 0;
      const y = e.clientY || (e.touches && e.touches[0] && e.touches[0].clientY) || 0;
      if (Math.abs(x - startX) > MOVE_TOLERANCE_PX || Math.abs(y - startY) > MOVE_TOLERANCE_PX) {
        cancelTimer();
      }
    };
    const onUp = () => { cancelTimer(); };
    const onClick = (e) => {
      // 长按已弹菜单 → 吞 click，不要触发切换
      if (longPressed) {
        e.preventDefault();
        e.stopPropagation();
        longPressed = false;
        return;
      }
      const id = row.dataset.sid;
      this.switchSession(id);
    };
    row.addEventListener('pointerdown', onDown);
    row.addEventListener('pointermove', onMove);
    row.addEventListener('pointerup', onUp);
    row.addEventListener('pointercancel', onUp);
    row.addEventListener('pointerleave', onUp);
    row.addEventListener('click', onClick);
    // 屏蔽系统菜单；桌面/公司电脑右键直接打开同一套会话管理动作。
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      cancelTimer();
      const sid = row.dataset.sid;
      const sess = (this.sessions || []).find(s => s.id === sid);
      if (sess) this._showSessionActionSheet(sess);
    });
  },

  // session 行的 action sheet：📌 置顶 / ✏ 重命名 / 📋 复制 ID / 🗑 删除
  // mobile-default 是兜底 session，不允许重命名/删除/置顶（已永远第一位）
  _showSessionActionSheet(session) {
    if (!session || !session.id) return;
    const isDefault = session.id === DEFAULT_SESSION_ID;
    const pinned = !!session.pinned;
    const title = session.title || '(无标题)';
    const clearSelection = () => {
      try {
        const sel = window.getSelection && window.getSelection();
        if (sel && sel.removeAllRanges) sel.removeAllRanges();
      } catch {}
    };
    document.body.classList.add('suppress-text-selection');
    clearSelection();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay sheet-overlay';
    // 用 modal 框架但每行用 .sheet-action（区别于 new-session 的 .modal-opt）
    const disabledAttr = isDefault ? 'disabled aria-disabled="true"' : '';
    const disabledHint = isDefault ? '<div class="sheet-hint">默认会话不可改动，是 PWA 的兜底入口</div>' : '';
    overlay.innerHTML = `
      <div class="modal sheet-modal">
        <div class="modal-title sheet-title">${this._esc(title)}</div>
        <div class="sheet-actions">
          <button class="sheet-action" data-act="pin" ${disabledAttr}>
            <span class="sa-ic">📌</span>
            <span class="sa-text">${pinned ? '取消置顶' : '置顶到顶部'}</span>
          </button>
          <button class="sheet-action" data-act="rename" ${disabledAttr}>
            <span class="sa-ic">✏️</span>
            <span class="sa-text">重命名</span>
          </button>
          <button class="sheet-action" data-act="copy">
            <span class="sa-ic">📋</span>
            <span class="sa-text">复制会话 ID</span>
          </button>
          <button class="sheet-action destructive" data-act="destroy" ${disabledAttr}>
            <span class="sa-ic">🗑</span>
            <span class="sa-text">删除会话</span>
          </button>
        </div>
        ${disabledHint}
        <button class="modal-cancel">取消</button>
      </div>`;
    document.body.appendChild(overlay);
    setTimeout(clearSelection, 0);
    setTimeout(clearSelection, 80);
    const closeSheet = () => {
      try { overlay.remove(); } catch {}
      document.body.classList.remove('suppress-text-selection');
      clearSelection();
    };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSheet(); });
    overlay.querySelector('.modal-cancel').addEventListener('click', closeSheet);
    overlay.querySelectorAll('.sheet-action').forEach(btn => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.act;
        if (btn.disabled) return;
        closeSheet();
        if (act === 'pin') {
          if (!this.client) return;
          const next = !pinned;
          this.client.requestPinSession(session.id, next, session.hubId || this.activeHubId);
          this.toast(next ? `📌 已置顶「${title}」` : `已取消置顶`);
        } else if (act === 'rename') {
          this._showRenameModal(session);
        } else if (act === 'copy') {
          this._copyToClipboard(session.id);
        } else if (act === 'destroy') {
          this._confirmDestroySession(session);
        }
      });
    });
  },

  _showRenameModal(session) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay rename-overlay';
    overlay.innerHTML = `
      <form class="modal rename-modal">
        <div class="modal-title">重命名会话</div>
        <input type="text" class="rename-input" maxlength="64"
               value="${this._esc(session.title || '')}"
               placeholder="输入新标题（最长 64 字）"
               autocomplete="off" autocorrect="off" spellcheck="false"
               enterkeyhint="done">
        <div style="display:flex;gap:8px;margin-top:10px">
          <button type="button" class="modal-cancel" style="flex:1;color:var(--ink-mute)">取消</button>
          <button type="submit" class="modal-confirm" style="flex:1;background:var(--accent);color:#fff;border:none;border-radius:10px;padding:12px;font-size:15px;font-weight:600;font-family:inherit;cursor:pointer">保存</button>
        </div>
      </form>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('.rename-input');
    const close = () => overlay.remove();
    const submit = () => {
      const next = input.value.trim().slice(0, 64);
      if (!next) { input.focus(); return; }
      if (next === (session.title || '')) { close(); return; }
      const targetHubId = session.hubId || this.activeHubId;
      const targetHub = (this.hubs || []).find(h => h.hubId === targetHubId);
      if (!this.client || !targetHubId || !targetHub) {
        this.toast('当前 Hub 不在线，正在刷新');
        if (this.client) this.client.requestHubList();
        return;
      }
      const ok = this.client.requestRenameSession(session.id, next, targetHubId);
      if (!ok) {
        this.toast('连接异常，改名未发送');
        return;
      }
      if (this._pendingRename && this._pendingRename.timer) {
        clearTimeout(this._pendingRename.timer);
      }
      this._pendingRename = {
        sessionId: session.id,
        title: next,
        hubId: targetHub.hubId,
        sentAt: Date.now(),
        timer: setTimeout(() => {
          const pending = this._pendingRename;
          if (!pending || pending.sessionId !== session.id || pending.title !== next) return;
          this._pendingRename = null;
          this.toast('Hub 未确认改名，请刷新后重试');
          if (this.client) this.client.requestHubList();
        }, 5000),
      };
      setTimeout(() => {
        if (this.client) {
          this.client.requestSessionList(targetHub.hubId);
        }
      }, 500);
      this.toast('已发送改名请求，等待 Hub 确认');
      close();
    };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('.modal-cancel').addEventListener('click', close);
    overlay.querySelector('.rename-modal').addEventListener('submit', (e) => {
      e.preventDefault();
      submit();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
    setTimeout(() => { input.focus(); input.select(); }, 60);
  },

  _confirmDestroySession(session) {
    const title = session.title || '(无标题)';
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-title">删除「${this._esc(title)}」？</div>
        <div style="font-size:13px;color:var(--ink-mute);text-align:center;margin:0 0 16px;line-height:1.55">
          会话历史不会从 Hub 端删除，只是从本 PWA 视图移除。<br>底层 CLI 进程也会被关闭。
        </div>
        <div style="display:flex;gap:8px">
          <button class="modal-cancel" style="flex:1;color:var(--ink-mute)">取消</button>
          <button class="modal-destroy" style="flex:1;background:var(--err);color:#fff;border:none;border-radius:10px;padding:12px;font-size:15px;font-weight:600;font-family:inherit;cursor:pointer">删除</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('.modal-cancel').addEventListener('click', close);
    overlay.querySelector('.modal-destroy').addEventListener('click', () => {
      if (this.client) this.client.requestDestroySession(session.id, session.hubId || this.activeHubId);
      this.toast(`已删除「${title}」`);
      close();
    });
  },

  _fmtRelTime(ts) {
    if (!ts) return '';
    const d = Date.now() - ts;
    if (d < 60_000) return '刚刚';
    if (d < 3_600_000) return Math.floor(d / 60_000) + ' 分前';
    if (d < 86_400_000) return Math.floor(d / 3_600_000) + ' 小时前';
    if (d < 7 * 86_400_000) return Math.floor(d / 86_400_000) + ' 天前';
    const date = new Date(ts);
    return `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, '0')}`;
  },
  switchSession(id) {
    if (!id || id === this.activeSessionId) { this.closeDrawer({ skipHistory: true }); return; }
    const stream = document.getElementById('stream');
    const oldSid = this.activeSessionId;
    if (oldSid) this.sessionScrollTop.set(oldSid, stream.scrollTop);
    while (stream.firstChild) stream.removeChild(stream.firstChild);
    this.activeSessionId = id;
    localStorage.setItem(STORAGE.ACTIVE_SESSION, id);
    const cards = this.sessionCards.get(id) || [];
    const s = (this.sessions || []).find(x => x.id === id);
    const title = s ? s.title : '会话';
    if (!cards.length) {
      // T10 v0.5.4：内存空 → 试从 IDB 拉历史（PWA 被系统杀重启的场景）
      // hub 上有几十条对话，sinceSeq 续传只拿后续新 turn，历史不会回放；从 IDB 回填
      stream.innerHTML = `<div class="tsline" id="empty-hint">「${this._esc(title)}」· 加载历史…</div>`;
      this._hydrateFromIDB(id, title);
    } else {
      // T09 v0.5.3：DocumentFragment 批量挂载，N 次 reflow 合并成 1 次（200 卡片切换 63ms → 8ms 实测）
      const frag = document.createDocumentFragment();
      for (const c of cards) frag.appendChild(c);
      stream.appendChild(frag);
    }
    if (s && s.targetType === 'meeting') this._renderMeetingRemoteState(s);
    else this._removeMeetingRemoteState();
    this.sessionUnread.set(id, 0);
    requestAnimationFrame(() => {
      const saved = this.sessionScrollTop.get(id);
      stream.scrollTop = saved != null ? saved : stream.scrollHeight;
    });
    this._updateNavTitle();
    this._renderDrawerList();
    this._syncPtyPanelForActiveSession();
    this.closeDrawer({ skipHistory: true });
    this.toast(`✓ ${title}${cards.length ? ` · ${cards.length} 条历史` : ''}`);
  },

  // 从 IDB 拉最近 100 条卡片回填 stream。完成后切 empty-hint 为正常空提示或挂载历史
  // 异步：不阻塞 switchSession 返回；hydrate 完成时如果 activeSessionId 已切走则丢弃
  async _hydrateFromIDB(sid, title) {
    if (!this.idb) return;
    let records;
    try {
      records = await this.idb.getRecentCards(sid, 100);
    } catch (_) { records = []; }
    // race condition：用户已经切到别的 session → 不动 stream
    if (this.activeSessionId !== sid) return;
    const stream = document.getElementById('stream');
    if (!stream) return;
    if (!records.length) {
      const current = (this.sessions || []).find(s => s.id === sid);
      if (current && current.targetType === 'meeting') {
        while (stream.firstChild) stream.removeChild(stream.firstChild);
        this._renderMeetingRemoteState(current);
        return;
      }
      stream.innerHTML = `<div class="tsline" id="empty-hint">「${this._esc(title)}」· 暂无历史，发条消息开始</div>`;
      return;
    }
    // 清掉 empty-hint
    while (stream.firstChild) stream.removeChild(stream.firstChild);
    // hydration：调 appendXxxCard(..., fromIDB=true) 走渲染管线（一致性最高，不重复实现 markdown/artifact 解析）
    // 给 turn 注入 seq（确保 hydration 路径用 record.seq 而非 payload.turn.seq），_appendCard 据此 dedup
    for (const r of records) {
      try {
        if (r.role === 'user') {
          this.appendUserCard(r.payload && r.payload.text || '', sid, true, { seq: r.seq, ts: r.ts });
        } else if (r.role === 'claude') {
          const t = Object.assign({}, (r.payload && r.payload.turn) || r.payload || {}, { seq: r.seq, ts: ((r.payload && r.payload.turn && r.payload.turn.ts) || r.ts) });
          this.appendClaudeCard(t, sid, true);
        }
      } catch (e) { /* 单条坏数据跳过 */ }
    }
    // 冷启动 race：active session 可能已有 live turn 在内存，IDB hydration 拿的是历史
    // 按 data-seq 升序排 sessionCards，DocumentFragment 一次性挂；保证 chronological 顺序
    const cards = this.sessionCards.get(sid) || [];
    cards.sort((a, b) => {
      const ta = Number(a.dataset && a.dataset.ts) || 0;
      const tb = Number(b.dataset && b.dataset.ts) || 0;
      const sa = Number(a.dataset && a.dataset.seq) || 0;
      const sb = Number(b.dataset && b.dataset.seq) || 0;
      return (ta - tb) || (sa - sb);
    });
    const frag = document.createDocumentFragment();
    for (const c of cards) frag.appendChild(c);
    stream.appendChild(frag);
    const current = (this.sessions || []).find(s => s.id === sid);
    if (current && current.targetType === 'meeting') this._renderMeetingRemoteState(current);
    requestAnimationFrame(() => {
      const saved = this.sessionScrollTop.get(sid);
      stream.scrollTop = saved != null ? saved : stream.scrollHeight;
    });
    this.toast(`✓ ${title} · ${records.length} 条历史（本地缓存）`);
  },
  onSessionCreated(session) {
    if (!session || !session.id) return;
    this.sessions.push(session);
    // 保存旧 session 的 scrollTop + detach（用户原 session 卡片不丢）
    const stream = document.getElementById('stream');
    const oldSid = this.activeSessionId;
    if (oldSid) this.sessionScrollTop.set(oldSid, stream.scrollTop);
    while (stream.firstChild) stream.removeChild(stream.firstChild);
    this.activeSessionId = session.id;
    localStorage.setItem(STORAGE.ACTIVE_SESSION, session.id);
    // 新 session 没历史，显示空提示
    stream.innerHTML = `<div class="tsline" id="empty-hint">向 ${session.kind === 'codex' ? 'Codex' : 'Claude'} 发第一条消息…</div>`;
    this.toast(`已创建 ${session.title}`);
    this._updateNavTitle();
    this._renderDrawerList();
    this._syncPtyPanelForActiveSession();
  },
  onSessionDestroyed(msg) {
    this.sessions = this.sessions.filter(s => s.id !== msg.sessionId);
    if (this.activeSessionId === msg.sessionId) {
      this.activeSessionId = DEFAULT_SESSION_ID;
      localStorage.setItem(STORAGE.ACTIVE_SESSION, DEFAULT_SESSION_ID);
    }
    this._updateNavTitle();
    this._renderDrawerList();
  },
  onMeetingCreated(msg) {
    if (!msg || msg.ok === false) {
      this.toast(`群聊创建失败: ${msg && msg.error ? msg.error : 'unknown'}`);
      return;
    }
    const meeting = msg.meeting || msg;
    const card = this._normalizeDesktopCard({
      id: meeting.id && !String(meeting.id).startsWith('meeting:') ? `meeting:${meeting.id}` : meeting.id,
      targetId: meeting.id,
      targetType: 'meeting',
      source: 'desktop',
      kind: 'meeting',
      title: meeting.title || 'AI 群聊',
      scene: meeting.scene || meeting.mode || 'general',
      mode: meeting.mode || meeting.scene || 'general',
      members: Array.isArray(meeting.members) ? meeting.members : [],
      subSessions: Array.isArray(meeting.subSessions) ? meeting.subSessions : [],
      timeline: Array.isArray(meeting.timeline) ? meeting.timeline : [],
      subSessionCount: Array.isArray(meeting.subSessions) ? meeting.subSessions.length : (meeting.subSessionCount || 0),
      lastMessageTime: meeting.lastMessageTime || meeting.createdAt || Date.now(),
      createdAt: meeting.createdAt || Date.now(),
      canCommand: true,
      preview: '群聊已创建，可在这里发送群聊指令',
    });
    if (card) {
      this.desktopCards = (this.desktopCards || []).filter(s => s.id !== card.id);
      this.desktopCards.unshift(card);
      this._mergeSessionViews();
      this.switchSession(card.id);
      this.toast(`已创建群聊: ${card.title}`);
    }
    if (this.client && this.activeHubId) this.client.requestHubSnapshot(this.activeHubId);
  },
  onMeetingList(msg) {
    const meetings = (msg && Array.isArray(msg.meetings)) ? msg.meetings : [];
    if (!meetings.length) return;
    const cards = meetings.map(m => this._normalizeDesktopCard({
      ...m,
      id: m.id && !String(m.id).startsWith('meeting:') ? `meeting:${m.id}` : m.id,
      targetId: m.id && String(m.id).startsWith('meeting:') ? String(m.id).replace(/^meeting:/, '') : m.id,
      targetType: 'meeting',
      source: 'desktop',
      kind: 'meeting',
      title: m.title || 'AI 群聊',
      scene: m.scene || m.mode || 'general',
      preview: m.preview || '群聊会话',
      canCommand: true,
    })).filter(Boolean);
    const byId = new Map((this.desktopCards || []).map(c => [c.id, c]));
    for (const c of cards) byId.set(c.id, { ...(byId.get(c.id) || {}), ...c });
    this.desktopCards = Array.from(byId.values());
    this._mergeSessionViews();
    this._renderDrawerList();
  },
  _updateNavTitle() {
    // T07 v0.5.1：标题结构从"竖三层"压成"单行"。
    //   - #nav-hub-chip 渲染 [PID xxx]（多 hub 时显示，单 hub 隐藏）
    //   - #nav-title-name 渲染会话名（ellipsis 自动截）
    //   - .t 已删除，老选择器以 #nav-title-name 兜底
    const titleEl = document.getElementById('nav-title-name')
                 || document.querySelector('#nav-title .t');
    if (!titleEl) return;
    const cur = (this.sessions || []).find(s => s.id === (this.activeSessionId || DEFAULT_SESSION_ID));
    const sessionTitle = (cur && cur.title) || '手机会话';
    titleEl.textContent = sessionTitle;
    const composer = document.getElementById('composer-input');
    if (composer) {
      const label = cur && cur.targetType === 'meeting'
        ? '给 AI 群聊发消息...'
        : cur && cur.kind === 'codex'
          ? '给 Codex 发消息...'
          : '给 Claude 发消息...';
      composer.setAttribute('data-placeholder', label);
    }
    const modalInput = document.getElementById('im-textarea');
    if (modalInput) {
      modalInput.setAttribute('placeholder', cur && cur.targetType === 'meeting'
        ? '给 AI 群聊发消息...'
        : cur && cur.kind === 'codex'
          ? '给 Codex 发消息...'
          : '给 Claude 发消息...');
    }
    // multi-hub：左侧 hub-chip 显示 PID（单 hub 隐藏 chip 释放空间给会话名）
    const chipEl = document.getElementById('nav-hub-chip');
    if (chipEl) {
      const curHub = (this.hubs || []).find(h => h.hubId === this.activeHubId);
      if (curHub && (this.hubs || []).length > 1) {
        const chipText = curHub.friendlyName
          || (curHub.pid ? `PID ${curHub.pid}` : curHub.hubId.slice(0, 10));
        chipEl.textContent = chipText;
        chipEl.style.display = '';
        chipEl.title = curHub.hubId; // 长按看全 hubId
      } else {
        chipEl.style.display = 'none';
      }
    }
  },

  // 复制到剪贴板，3 级 fallback：
  //   1. navigator.clipboard.writeText (现代浏览器 + secure context)
  //   2. document.execCommand('copy') (老浏览器 + Android WebView 常用)
  //   3. 都失败 → 弹个 modal 让用户长按选中复制（最后兜底）
  _copyToClipboard(txt) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(txt).then(() => {
        this.toast('已复制 ✓');
      }).catch((e) => {
        this._fallbackCopy(txt, `clipboard API 拒绝: ${e && e.message || e}`);
      });
      return;
    }
    this._fallbackCopy(txt, 'no clipboard API');
  },
  _fallbackCopy(txt, reason) {
    // Step 2: execCommand
    try {
      const ta = document.createElement('textarea');
      ta.value = txt;
      ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none';
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      if (ok) { this.toast('已复制 ✓ (兼容模式)'); return; }
    } catch (e) {}
    // Step 3: 弹 modal 让用户手动复制
    const ov = document.createElement('div');
    ov.className = 'modal-overlay';
    ov.innerHTML = `<div class="modal" style="max-height:80vh;display:flex;flex-direction:column"><div class="modal-title">长按下方文本选中复制</div><textarea readonly style="flex:1;min-height:220px;font-family:'SF Mono','Menlo',monospace;font-size:11px;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--card-2);color:var(--ink);resize:none;outline:none">${this._esc(txt)}</textarea><button class="modal-cancel">关闭</button></div>`;
    document.body.appendChild(ov);
    ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
    ov.querySelector('.modal-cancel').addEventListener('click', () => ov.remove());
    const ta2 = ov.querySelector('textarea');
    setTimeout(() => { ta2.focus(); ta2.select(); }, 100);
    this.toast(`复制 API 不可用 (${reason})，长按文本框手动复制`);
  },

  showDebugPanel() {
    if (!this.client) return;
    // 立即刷新一次 hub list，确保面板里数据最新
    this.client.requestHubList();
    setTimeout(() => this._renderDebugPanel(), 200);
  },

  _renderDebugPanel() {
    const existing = document.querySelector('.dbg-overlay');
    if (existing) existing.remove();
    const overlay = document.createElement('div');
    overlay.className = 'dbg-overlay';
    const token = localStorage.getItem(STORAGE.DEVICE_TOKEN) || '';
    const tokenShown = token ? `${token.slice(0,8)}…${token.slice(-4)}` : '(未配对)';
    const wsState = this.client.state;
    const wsClass = wsState === 'connected' ? 'ok' : (wsState === 'connecting' ? 'warn' : 'err');
    const curHub = (this.hubs || []).find(h => h.hubId === this.activeHubId) || null;
    const realHubsCount = (this.hubs || []).filter(h => !h.isLegacy).length;
    const legacyHubsCount = (this.hubs || []).filter(h => h.isLegacy).length;
    const hubsRows = (this.hubs || []).map((h, i) => {
      const isActive = h.hubId === this.activeHubId;
      const tag = h.isLegacy ? '<span style="color:var(--warn)">[legacy]</span>' : '<span style="color:var(--ok)">[v'+(h.version||'?')+']</span>';
      const lbl = h.friendlyName || (h.pid ? `PID ${h.pid}` : h.hubId.slice(0, 18));
      const sel = isActive ? '<span style="color:var(--accent);font-weight:700">●</span> ' : '';
      return `<div class="dbg-row"><span class="k">[${i}]${sel}</span><span class="v">${this._esc(lbl)} ${tag}</span></div>`;
    }).join('') || '<div class="dbg-row"><span class="v err">无 Hub 在线</span></div>';
    const logRows = [...DEBUG_LOG].reverse().slice(0, 15).map(l => {
      const ts = new Date(l.t).toTimeString().slice(0, 8);
      const dirClass = l.dir === '→' ? 'out' : (l.dir === '←' ? 'in' : 'fail');
      return `<div class="line"><span class="ts">${ts}</span><span class="dir ${dirClass}">${l.dir}</span><span class="typ">${this._esc(l.type)}</span><span class="ex">${this._esc(l.extra || '')}</span></div>`;
    }).join('') || '<div class="line"><span class="ex">(空)</span></div>';
    overlay.innerHTML = `
      <div class="dbg-panel">
        <div class="dbg-title">
          <span>🐛 调试面板</span>
          <button class="dbg-close">关闭</button>
        </div>
        <div class="dbg-section">
          <h4>版本</h4>
          <div class="dbg-row"><span class="k">PWA</span><span class="v">${PWA_VERSION}</span></div>
          <div class="dbg-row"><span class="k">Build</span><span class="v">${this._esc(PWA_BUILD)}</span></div>
          <div class="dbg-row"><span class="k">SW Cache</span><span class="v">${this._esc(PWA_SW_CACHE)}</span></div>
          <div class="dbg-row"><span class="k">UA</span><span class="v" style="font-size:10px">${this._esc(navigator.userAgent.slice(0, 80))}</span></div>
        </div>
        <div class="dbg-section">
          <h4>连接</h4>
          <div class="dbg-row"><span class="k">WSS</span><span class="v ${wsClass}">${wsState}</span></div>
          <div class="dbg-row"><span class="k">Gateway</span><span class="v">${this._esc(location.host)}</span></div>
          <div class="dbg-row"><span class="k">Device Token</span><span class="v">${this._esc(tokenShown)}</span></div>
          <div class="dbg-row"><span class="k">Last Seq</span><span class="v">${localStorage.getItem(STORAGE.LAST_SEQ) || '0'}</span></div>
        </div>
        <div class="dbg-section">
          <h4>Hub 路由</h4>
          <div class="dbg-row"><span class="k">在线 Hub</span><span class="v">${(this.hubs||[]).length} (${realHubsCount} 新版 / ${legacyHubsCount} legacy)</span></div>
          <div class="dbg-row"><span class="k">activeHubId</span><span class="v">${this._esc(this.activeHubId || '(未选)')}</span></div>
          <div class="dbg-row"><span class="k">activeHub</span><span class="v">${curHub ? this._esc(curHub.friendlyName || ('PID '+curHub.pid)) + (curHub.isLegacy ? ' <span style="color:var(--warn)">[legacy]</span>' : ' <span style="color:var(--ok)">[real]</span>') : '<span class="err">无</span>'}</span></div>
          ${hubsRows}
        </div>
        <div class="dbg-section">
          <h4>会话</h4>
          <div class="dbg-row"><span class="k">mobile sessions</span><span class="v">${(this.sessions||[]).length}</span></div>
          <div class="dbg-row"><span class="k">activeSessionId</span><span class="v">${this._esc(this.activeSessionId || '(默认)')}</span></div>
        </div>
        <div class="dbg-section">
          <h4>近 15 条消息</h4>
          <div class="dbg-log">${logRows}</div>
        </div>
        <div class="dbg-actions">
          <button class="dbg-act-ping">📡 测 list-hubs</button>
          <button class="dbg-act-list-sessions secondary">📋 测 list-sessions</button>
          <button class="dbg-act-test-claude">🧪 试创建 Claude</button>
          <button class="dbg-act-refresh secondary">🔄 刷新面板</button>
          <button class="dbg-act-copy secondary">📝 复制全部</button>
          <button class="dbg-act-reset secondary" style="background:var(--err);color:#fff;border:none">⚠ 清除 token 重新配对</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('.dbg-close').addEventListener('click', () => overlay.remove());
    overlay.querySelector('.dbg-act-ping').addEventListener('click', () => {
      this.client.requestHubList();
      this.toast('已发 list-hubs');
      setTimeout(() => this._renderDebugPanel(), 600);
    });
    overlay.querySelector('.dbg-act-list-sessions').addEventListener('click', () => {
      this.client.requestSessionList(this.activeHubId);
      this.toast(`已发 list-sessions @${this.activeHubId ? this.activeHubId.slice(0,18) : '默认'}`);
      setTimeout(() => this._renderDebugPanel(), 800);
    });
    overlay.querySelector('.dbg-act-test-claude').addEventListener('click', () => {
      const sent = this.client.requestNewSession('claude', '调试-测试创建', this.activeHubId);
      this.toast(`已发 new-session @${this.activeHubId ? this.activeHubId.slice(0,20) : '默认'} (sendRaw返回:${sent})`);
      // 立刻刷新让用户看到 → new-session 日志（不等 1.5s）
      setTimeout(() => this._renderDebugPanel(), 50);
      // 再 1.5s 刷一次，捕获返程 ← session-created
      setTimeout(() => this._renderDebugPanel(), 1800);
    });
    overlay.querySelector('.dbg-act-refresh').addEventListener('click', () => this._renderDebugPanel());
    overlay.querySelector('.dbg-act-copy').addEventListener('click', () => {
      const lines = [];
      overlay.querySelectorAll('.dbg-section').forEach(sec => {
        lines.push('# ' + sec.querySelector('h4').textContent);
        sec.querySelectorAll('.dbg-row').forEach(r => {
          const k = r.querySelector('.k')?.textContent || '';
          const v = r.querySelector('.v')?.textContent || '';
          lines.push(`${k}: ${v}`);
        });
        const logEl = sec.querySelector('.dbg-log');
        if (logEl) lines.push(logEl.innerText);
        lines.push('');
      });
      const txt = lines.join('\n');
      this._copyToClipboard(txt);
    });
    overlay.querySelector('.dbg-act-reset').addEventListener('click', () => {
      if (confirm('确认清除 device token 并退出到配对屏？')) {
        localStorage.removeItem(STORAGE.DEVICE_TOKEN);
        localStorage.removeItem(STORAGE_ACTIVE_HUB);
        location.reload();
      }
    });
  },

  showHubSelector() {
    if (!this.client) return;
    // 先刷一次 hub list
    this.client.requestHubList();
    setTimeout(() => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      const hubs = this.hubs || [];
      const hubItems = hubs.map(h => {
        const friendlyName = h.friendlyName || (h.pid ? `Hub PID ${h.pid}` : `Hub @${h.hubId.slice(0, 16)}`);
        const subtitle = h.startedAt
          ? `启动于 ${new Date(h.startedAt).toLocaleString()}`
          : (h.isLegacy ? '老版本（重启后显示 PID/版本）' : '');
        const isActive = h.hubId === this.activeHubId;
        return `<button class="modal-opt" data-hubid="${this._esc(h.hubId)}" ${isActive ? 'style="border-color:var(--accent);background:rgba(0,113,227,.08)"' : ''}>
          <span class="opt-icon" style="background:${h.isLegacy ? 'linear-gradient(135deg,#8e8e93,#6e6e73)' : 'linear-gradient(135deg,#34c759,#30b350)'}">${h.isLegacy ? '?' : '✓'}</span>
          <div class="opt-text">
            <div class="opt-name">${this._esc(friendlyName)}${isActive ? ' ✓' : ''}</div>
            <div class="opt-desc">${this._esc(subtitle)}</div>
          </div>
        </button>`;
      }).join('');
      overlay.innerHTML = `
        <div class="modal">
          <div class="modal-title">选择 Hub 实例（共 ${hubs.length} 个在线）</div>
          <div class="modal-options">${hubItems || '<div style="text-align:center;padding:24px;color:var(--ink-mute)">没有在线 Hub</div>'}</div>
          <button class="modal-cancel">关闭</button>
        </div>`;
      document.body.appendChild(overlay);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
      overlay.querySelector('.modal-cancel').addEventListener('click', () => overlay.remove());
      overlay.querySelectorAll('.modal-opt').forEach(btn => {
        btn.addEventListener('click', () => {
          this.activeHubId = btn.dataset.hubid;
          localStorage.setItem(STORAGE_ACTIVE_HUB, this.activeHubId);
          this._updateNavTitle();
          this.toast(`已切换到 ${(hubs.find(h => h.hubId === this.activeHubId) || {}).friendlyName || this.activeHubId.slice(0,16)}`);
          overlay.remove();
          // 重新拉 session 列表（新 hub 上的 sessions）
          if (this.client) this.client.requestSessionList(this.activeHubId);
        });
      });
    }, 600);
  },
  showNewSessionModal() {
    if (!this.client) return;
    // 找当前 hub 信息显示
    const curHub = (this.hubs || []).find(h => h.hubId === this.activeHubId);
    const hubLabel = curHub
      ? (curHub.friendlyName || `Hub @${curHub.hubId.slice(0, 10)}`)
      : '当前 Hub';
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-title">在 <span style="color:var(--accent)">${this._esc(hubLabel)}</span> 上新建对话</div>
        <div class="modal-options">
          <button class="modal-opt" data-kind="claude"><span class="opt-icon" style="background:linear-gradient(135deg,#d97757,#c4623d)">C</span><div class="opt-text"><div class="opt-name">Claude</div><div class="opt-desc">Anthropic Claude · 通用对话/编码</div></div></button>
          <button class="modal-opt" data-kind="codex"><span class="opt-icon" style="background:linear-gradient(135deg,#1d1d1f,#3a3a3c)">○</span><div class="opt-text"><div class="opt-name">Codex</div><div class="opt-desc">OpenAI Codex · 编码专精</div></div></button>
          <button class="modal-opt" data-meeting-mode="general"><span class="opt-icon" style="background:linear-gradient(135deg,#2563eb,#0891b2)">AI</span><div class="opt-text"><div class="opt-name">AI 群聊</div><div class="opt-desc">创建 Hub meeting · 多 Agent 圆桌</div></div></button>
        </div>
        <button class="modal-cancel">取消</button>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('.modal-cancel').addEventListener('click', () => overlay.remove());
    overlay.querySelectorAll('.modal-opt').forEach(btn => {
      btn.addEventListener('click', () => {
        const meetingMode = btn.dataset.meetingMode;
        const kind = btn.dataset.kind;
        // 关键：把 activeHubId 透传给 NEW_SESSION，hub 才知道是它该建 session
        const curHubBefore = (this.hubs || []).find(h => h.hubId === this.activeHubId);
        const targetLabel = curHubBefore ? (curHubBefore.friendlyName || `PID ${curHubBefore.pid || '?'}`) : (this.activeHubId || '默认');
        const title = meetingMode ? `手机 AI 群聊 ${new Date().toTimeString().slice(0, 5)}` : (kind === 'codex' ? '手机 Codex' : '手机 Claude');
        const ok = meetingMode
          ? this.client.requestNewMeeting(meetingMode, title, this.activeHubId)
          : this.client.requestNewSession(kind, title, this.activeHubId);
        if (ok) {
          this.toast(`已发到 ${targetLabel}, 创建 ${title}...`);
          // 4 秒未收到 SESSION_CREATED 给诊断 toast
          const sessionsBefore = this.sessions ? this.sessions.length : 0;
          setTimeout(() => {
            const sessionsAfter = this.sessions ? this.sessions.length : 0;
            if (sessionsAfter <= sessionsBefore) {
              this.toast(`⚠ ${targetLabel} 4 秒未响应，可能 token 失效或 hub 卡住`);
            }
          }, 4000);
        } else {
          this.toast('连接异常，请稍后重试');
        }
        overlay.remove();
      });
    });
  },

  _removeEmptyHint() {
    const hint = document.getElementById('empty-hint');
    if (hint) hint.remove();
  },

  // fromIDB=true 时跳过持久化 & 跳过 unread 角标更新（这是历史回放，不是新增）
  // fromIDB 模式下 idbRecord 必传（含 seq），让 _appendCard 走 dedup
  appendUserCard(text, sid, fromIDB, idbRecord) {
    const div = document.createElement('div');
    div.className = 'turn-user';
    const textEl = document.createElement('div');
    textEl.textContent = text;
    div.appendChild(textEl);
    const statusEl = document.createElement('div');
    statusEl.className = 'turn-user-status';
    div.appendChild(statusEl);
    // user 卡片本地 monotonic seq 只用于去重；排序必须用 ts（见 getRecentCards 注释）
    const seq = fromIDB ? (idbRecord && idbRecord.seq) : (Date.now() * 1000 + (++this._clientSeqCounter));
    const ts = fromIDB ? (idbRecord && idbRecord.ts) : Date.now();
    this._appendCard(div, sid, fromIDB, seq, ts);
    if (!fromIDB) {
      this._persistCard(sid, seq, 'user', { text }, ts);
    }
    return div;
  },

  appendClaudeCard(turn, sid, fromIDB) {
    const wrap = document.createElement('div');
    wrap.className = 'turn-claude';
    // avatar/品牌：跟 hub UI 主屏的 NewSessionModal 保持一致
    // T13（2026-06-08）：turn.model 现在可能是真实模型 id（claude-opus-4-7 / gpt-5.5 / gemini-2.5-pro），
    //   不再只是 kind 字面。识别新增 GPT 前缀（Codex CLI 走 OpenAI 模型）。
    const modelLower = (turn.model || '').toLowerCase();
    const isCodex = modelLower.includes('codex') || modelLower.startsWith('gpt-') || modelLower.startsWith('o4-') || modelLower.startsWith('o3-');
    const isGemini = modelLower.includes('gemini');
    const isPwsh = modelLower.includes('powershell') || modelLower.includes('shell');
    const avatarLetter = isCodex ? '○' : isGemini ? 'G' : isPwsh ? '▶' : 'C';
    const avatarStyle = isCodex ? 'background:linear-gradient(135deg,#1d1d1f,#3a3a3c)'
      : isGemini ? 'background:linear-gradient(135deg,#4285f4,#9b72cb)'
      : isPwsh ? 'background:linear-gradient(135deg,#012456,#08438a)'
      : '';
    // brandName 显示真实模型 id（短化 claude-opus-4-7 → Opus 4.7 之类），保留品牌前缀
    const brandName = this._formatModelBrand(turn.model, { isCodex, isGemini, isPwsh });
    wrap.innerHTML = `
      <div class="avatar" style="${avatarStyle}">${avatarLetter}</div>
      <div class="turn-body">
        <div class="meta">
          <span>${this._esc(brandName)}</span>
          <span class="meta-right">
            <button class="meta-copy" type="button" title="复制全文"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
            <span>${this._fmtTime(turn.ts)}</span>
          </span>
        </div>
        <div class="text"></div>
      </div>`;
    const textEl = wrap.querySelector('.text');
    const content = turn.content || '';
    textEl.innerHTML = this._mdLite(content);
    // 工具调用
    if (Array.isArray(turn.toolCalls)) {
      const body = wrap.querySelector('.turn-body');
      for (const tc of turn.toolCalls) {
        body.appendChild(this._renderTool(tc));
      }
    }
    // ⭐ HTML artifact 检测：识别本地 .html 路径，渲染预览卡片
    const artifacts = this._extractArtifactPaths(content);
    if (artifacts.length > 0) {
      const body = wrap.querySelector('.turn-body');
      for (const artPath of artifacts) {
        body.appendChild(this._renderArtifactCard(artPath));
      }
    }
    // footer：耗时 chip / token chip（只有有数据才渲染，无数据不占空间）
    const body = wrap.querySelector('.turn-body');
    const chips = [];
    if (typeof turn.durationMs === 'number' && turn.durationMs > 0) {
      const sec = (turn.durationMs / 1000).toFixed(1);
      chips.push(`<span class="chip dur">⏱ ${sec}s</span>`);
    }
    // T13（2026-06-08）：token chip 升级 — 含 cache_read / cache_creation 摘要。
    //   Claude 长上下文用户对 cache 命中很敏感（直接影响计费 + 速度）；
    //   Codex 端 cache_creation_input_tokens 永远 0，自然不展示，对齐 ClaudeTap 行为。
    //   兼容旧 turn（只有 input/output）：guard 是 input_tokens||output_tokens，cache 段单独 if。
    if (turn.usage && (turn.usage.input_tokens || turn.usage.output_tokens)) {
      const i = turn.usage.input_tokens || 0;
      const o = turn.usage.output_tokens || 0;
      const cr = turn.usage.cache_read_input_tokens || 0;
      const cw = turn.usage.cache_creation_input_tokens || 0;
      let tokStr = `↓${this._fmtNum(i)} ↑${this._fmtNum(o)} tok`;
      if (cr || cw) {
        const cacheBits = [];
        if (cr) cacheBits.push(`r${this._fmtNum(cr)}`);
        if (cw) cacheBits.push(`w${this._fmtNum(cw)}`);
        tokStr += ` · ⚡${cacheBits.join('/')}`;
      }
      chips.push(`<span class="chip tok">${tokStr}</span>`);
    }
    if (chips.length) {
      const footer = document.createElement('div');
      footer.className = 'turn-footer';
      footer.innerHTML = chips.join('');
      body.appendChild(footer);
    }
    // 复制按钮（顶部 meta 行，跟时间并排）
    const copyBtn = wrap.querySelector('.meta-copy');
    if (copyBtn) {
      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const btn = e.currentTarget;
        this._copyToClipboard(content);
        btn.classList.add('copied');
        btn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
        setTimeout(() => {
          btn.classList.remove('copied');
          btn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
        }, 1500);
      });
    }
    // turn.seq 是 hub 端单调递增的小整数；turn.ts 可能没 → 用 Date.now() 兜底
    const seq = (typeof turn.seq === 'number' && turn.seq > 0) ? turn.seq : (Date.now() * 1000 + (++this._clientSeqCounter));
    const ts = turn.ts || Date.now();
    this._appendCard(wrap, sid, fromIDB, seq, ts);
    if (!fromIDB) {
      // 落盘原始 turn，hydration 时直接喂回 appendClaudeCard 重渲染
      this._persistCard(sid, seq, 'claude', { turn }, ts);
    }
  },

  // 异步落盘单张卡片（错误吞掉，不阻塞 UI）
  _persistCard(sid, seq, role, payload, ts) {
    if (!this.idb) return;
    const record = { sid: String(sid), seq, role, payload, ts };
    // fire-and-forget；putCard 内部已 try/catch
    this.idb.putCard(record);
  },

  _fmtNum(n) {
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  },

  // T13（2026-06-08）：把 transcript 抽出的 model id 转成人能读的品牌名 + 版本。
  //   Claude:  "claude-opus-4-7"        → "Claude Opus 4.7"
  //            "claude-sonnet-4-5"      → "Claude Sonnet 4.5"
  //            "claude-haiku-4-5"       → "Claude Haiku 4.5"
  //   Codex:   "gpt-5.5" / "gpt-5"       → "Codex GPT-5.5" / "Codex GPT-5"
  //            "o4-mini"                → "Codex o4-mini"
  //   Gemini:  "gemini-2.5-pro"         → "Gemini 2.5 Pro"
  //   缺失 / 未知 / kind 字面（'claude'/'codex'）→ 老 fallback（首字大写 or 默认 'Claude'）。
  _formatModelBrand(modelRaw, { isCodex, isGemini, isPwsh } = {}) {
    const model = String(modelRaw || '').trim();
    if (!model) return 'Claude';
    if (isPwsh) return 'PowerShell';
    const lower = model.toLowerCase();
    // Claude family
    const cm = lower.match(/^claude-(opus|sonnet|haiku)-(\d+)-(\d+)/);
    if (cm) {
      const tier = cm[1].charAt(0).toUpperCase() + cm[1].slice(1);
      return `Claude ${tier} ${cm[2]}.${cm[3]}`;
    }
    if (lower === 'claude' || lower.startsWith('claude-')) return 'Claude';
    // Gemini family
    if (isGemini) {
      // "gemini-2.5-pro" → "Gemini 2.5 Pro"
      const gm = lower.match(/^gemini-([\d.]+)-(\w+)/);
      if (gm) {
        const tier = gm[2].charAt(0).toUpperCase() + gm[2].slice(1);
        return `Gemini ${gm[1]} ${tier}`;
      }
      return 'Gemini';
    }
    // Codex (OpenAI) family
    if (isCodex) {
      if (lower === 'codex') return 'Codex';
      // gpt-5.5 → Codex GPT-5.5
      if (lower.startsWith('gpt-')) return `Codex GPT-${model.slice(4)}`;
      // o4-mini / o3-mini → Codex o4-mini
      if (lower.startsWith('o4-') || lower.startsWith('o3-')) return `Codex ${model}`;
      return `Codex ${model}`;
    }
    // 未知：原样返回
    return model;
  },

  _extractArtifactPaths(text) {
    const seen = new Set();
    const out = [];
    if (!text) return out;
    let match;
    ARTIFACT_PATH_RE.lastIndex = 0;
    while ((match = ARTIFACT_PATH_RE.exec(text)) !== null) {
      const p = match[1];
      if (!seen.has(p)) { seen.add(p); out.push(p); }
    }
    return out;
  },

  _renderArtifactCard(filePath) {
    const fileName = filePath.split(/[\\\/]/).pop();
    const ext = (fileName.split('.').pop() || '').toUpperCase();
    const badge = ext === 'MD' ? 'MD' : ext === 'TXT' ? 'TXT' : 'HTML';
    const card = document.createElement('div');
    card.className = 'artifact-card';
    card.innerHTML = `
      <div class="artifact-icon">📄</div>
      <div class="artifact-meta">
        <div class="artifact-name">${this._esc(fileName)}</div>
        <div class="artifact-sub"><span class="badge">${badge}</span><span class="artifact-path">${this._esc(filePath)}</span></div>
      </div>
      <div class="artifact-cta">预览
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
      </div>`;
    card.addEventListener('click', () => this.openArtifact(filePath));
    return card;
  },

  openArtifact(filePath) {
    if (!this.client) return;
    this._showArtifactLoading(filePath);
    const { requestId } = this.client.requestArtifact(filePath, this.activeHubId);
    this.pendingArtifacts.set(requestId, { path: filePath, openOnArrive: true, t0: Date.now() });
    // 30 秒超时
    setTimeout(() => {
      if (this.pendingArtifacts.has(requestId)) {
        this.pendingArtifacts.delete(requestId);
        this._showArtifactError(filePath, 'timeout');
      }
    }, 30000);
  },

  onArtifactResult(msg) {
    const pending = this.pendingArtifacts.get(msg.requestId);
    if (!pending) return;
    this.pendingArtifacts.delete(msg.requestId);
    if (msg.type === MSG.ARTIFACT_CONTENT) {
      // ⭐ 关键：atob 输出 binary string，UTF-8 多字节字符（中文/Emoji）会乱码。
      // 必须先 atob → byte array → TextDecoder('utf-8') 才能正确解码。
      const content = this._base64ToUtf8(msg.contentBase64);
      const html = this._artifactContentToHtml(pending.path, content, msg.mimeType);
      const elapsed = Date.now() - pending.t0;
      this._showArtifactFullscreen(pending.path, html, msg.size, elapsed);
    } else {
      this._showArtifactError(pending.path, msg.error || 'unknown');
    }
  },
  _base64ToUtf8(b64) {
    try {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder('utf-8').decode(bytes);
    } catch (e) {
      // 兜底：旧版浏览器或 atob 失败时返回空 HTML，避免 crash
      return '<pre style="padding:20px;color:red">Base64 decode failed: ' + this._esc(String(e)) + '</pre>';
    }
  },

  _artifactContentToHtml(filePath, content, mimeType) {
    const ext = (filePath.split('.').pop() || '').toLowerCase();
    if (ext === 'md' || String(mimeType || '').includes('markdown')) {
      return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;line-height:1.65;padding:18px;color:#182033;background:#fff}pre,code{font-family:"SF Mono",Consolas,monospace;background:#f1f4f8;border-radius:6px}pre{padding:12px;overflow:auto}code{padding:1px 4px}blockquote{border-left:4px solid #d0d7de;margin-left:0;padding-left:12px;color:#57606a}img{max-width:100%}a{color:#1f6feb}</style></head><body>${this._mdLite(content)}</body></html>`;
    }
    if (ext === 'txt' || String(mimeType || '').startsWith('text/plain')) {
      return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:"SF Mono",Consolas,monospace;white-space:pre-wrap;line-height:1.55;padding:18px;color:#182033;background:#fff}</style></head><body>${this._esc(content)}</body></html>`;
    }
    return content;
  },

  _closeArtifactOverlay(filePath = null) {
    const overlay = document.getElementById('artifact-overlay');
    if (overlay) overlay.remove();
    if (!this.pendingArtifacts || !this.pendingArtifacts.size) return;
    for (const [requestId, pending] of this.pendingArtifacts.entries()) {
      if (!filePath || pending.path === filePath) {
        this.pendingArtifacts.delete(requestId);
      }
    }
  },

  _showArtifactLoading(filePath) {
    let overlay = document.getElementById('artifact-overlay');
    if (overlay) overlay.remove();
    overlay = document.createElement('div');
    overlay.id = 'artifact-overlay';
    overlay.className = 'artifact-overlay';
    overlay.innerHTML = `
      <div class="af-bar">
        <button class="nav-back" aria-label="close">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div class="af-bar-title">
          <div class="t">${this._esc(filePath.split(/[\\\/]/).pop())}</div>
          <div class="s">加载中...</div>
        </div>
        <div style="width:36px"></div>
      </div>
      <div class="af-frame" style="display:flex;align-items:center;justify-content:center;color:var(--ink-mute);font-size:14px">
        <div>
          <div class="af-spinner"></div>
          <div style="text-align:center;margin-top:14px">从 Hub 拉取文件内容…</div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    this.hubViewDragMode = false;
    this.hubViewLive = true;
    this.hubViewKeyboardCapture = true;
    overlay.querySelector('.nav-back').addEventListener('click', () => this._closeArtifactOverlay(filePath));
  },

  _showArtifactFullscreen(filePath, html, size, elapsedMs) {
    let overlay = document.getElementById('artifact-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'artifact-overlay';
      overlay.className = 'artifact-overlay';
      document.body.appendChild(overlay);
    }
    const fileName = filePath.split(/[\\\/]/).pop();
    const sizeKb = (size / 1024).toFixed(1);
    overlay.innerHTML = `
      <div class="af-bar">
        <button class="nav-back" aria-label="close">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div class="af-bar-title">
          <div class="t">${this._esc(fileName)}</div>
          <div class="s">${sizeKb} KB · ${elapsedMs}ms</div>
        </div>
        <button class="nav-icon" aria-label="share" id="af-share">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
        </button>
      </div>
      <div class="af-frame"><iframe id="af-iframe" sandbox="allow-same-origin allow-scripts" srcdoc="${this._esc(html)}"></iframe></div>`;
    overlay.querySelector('.nav-back').addEventListener('click', () => this._closeArtifactOverlay(filePath));
    const shareBtn = overlay.querySelector('#af-share');
    if (shareBtn) {
      shareBtn.addEventListener('click', async () => {
        try {
          if (navigator.share) {
            await navigator.share({ title: fileName, text: filePath });
          } else if (window.HubNative && window.HubNative.shareText) {
            window.HubNative.shareText(filePath, fileName);
          } else if (window.HubNative && window.HubNative.copyToClipboard) {
            window.HubNative.copyToClipboard(filePath, fileName);
          }
        } catch (e) {}
      });
    }
  },

  showHubView() {
    if (!this.client) {
      this.toast('Hub view unavailable');
      return;
    }
    this._closeArtifactOverlay();
    let overlay = document.getElementById('hub-view-overlay');
    if (overlay) this._closeHubView({ skipHistory: true });
    overlay = document.createElement('div');
    overlay.id = 'hub-view-overlay';
    overlay.className = 'hub-view-overlay';
    overlay.tabIndex = 0;
    overlay.innerHTML = `
      <div class="hv-bar">
        <button class="nav-back" aria-label="close">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div class="hv-title">
          <div class="t">Hub View</div>
          <div class="s" id="hub-view-status">requesting frame...</div>
        </div>
        <button class="nav-icon" aria-label="text input" id="hub-view-text">
          <span style="font-size:17px;font-weight:700;line-height:1">T</span>
        </button>
        <button class="nav-icon" aria-label="key input" id="hub-view-key">
          <span style="font-size:15px;font-weight:800;line-height:1">K</span>
        </button>
        <button class="nav-icon" aria-label="mouse modifier latch" id="hub-view-mod">
          <span style="font-size:8px;font-weight:900;line-height:1">MOD</span>
        </button>
        <button class="nav-icon" aria-label="copy desktop selection" id="hub-view-clip">
          <span style="font-size:9px;font-weight:900;line-height:1">CLIP</span>
        </button>
        <button class="nav-icon" aria-label="set desktop clipboard" id="hub-view-setclip">
          <span style="font-size:9px;font-weight:900;line-height:1">SET</span>
        </button>
        <button class="nav-icon" aria-label="send file to desktop" id="hub-view-file">
          <span style="font-size:9px;font-weight:900;line-height:1">FILE</span>
        </button>
        <button class="nav-icon" aria-label="toggle actual size" id="hub-view-zoom">
          <span style="font-size:10px;font-weight:900;line-height:1">1X</span>
        </button>
        <button class="nav-icon" aria-label="drag mode" id="hub-view-drag">
          <span style="font-size:15px;font-weight:800;line-height:1">D</span>
        </button>
        <button class="nav-icon" aria-label="fullscreen" id="hub-view-fullscreen">
          <span style="font-size:10px;font-weight:800;line-height:1">FS</span>
        </button>
        <button class="nav-icon hv-live-on" aria-label="live refresh" id="hub-view-live">
          <span style="font-size:10px;font-weight:800;line-height:1">LIVE</span>
        </button>
        <button class="nav-icon" aria-label="refresh" id="hub-view-refresh">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 1-15.5 6.2"/><path d="M3 12A9 9 0 0 1 18.5 5.8"/><path d="M18 2v5h5"/><path d="M6 22v-5H1"/></svg>
        </button>
      </div>
      <div class="hv-body" id="hub-view-body">
        <div class="hv-loading"><div class="af-spinner"></div><div>Waiting for desktop frame...</div></div>
      </div>`;
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.id = 'hub-view-file-input';
    fileInput.hidden = true;
    overlay.appendChild(fileInput);
    document.body.appendChild(overlay);
    this._pushHubViewHistory();
    this.hubViewDragMode = false;
    this.hubViewLive = true;
    this.hubViewZoomScale = 0;
    this.hubViewActualSize = false;
    this.hubViewKeyboardCapture = true;
    this.hubViewMouseModifierIndex = 0;
    this.hubViewMouseModifiers = [];
    this._hubViewKeyHandler = (e) => this._handleHubViewKeydown(e);
    overlay.addEventListener('keydown', this._hubViewKeyHandler);
    this._hubViewPasteHandler = (e) => this._handleHubViewPaste(e);
    overlay.addEventListener('paste', this._hubViewPasteHandler);
    this._hubViewFullscreenHandler = () => this._handleHubViewFullscreenChange();
    document.addEventListener('fullscreenchange', this._hubViewFullscreenHandler);
    document.addEventListener('webkitfullscreenchange', this._hubViewFullscreenHandler);
    this._hubViewViewportHandler = () => this._scheduleHubViewViewportResubscribe();
    window.addEventListener('resize', this._hubViewViewportHandler);
    window.addEventListener('orientationchange', this._hubViewViewportHandler);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', this._hubViewViewportHandler);
    }
    setTimeout(() => { try { overlay.focus({ preventScroll: true }); } catch {} }, 0);
    overlay.querySelector('.nav-back').addEventListener('click', () => this._requestCloseHubView('nav-back'));
    const refresh = overlay.querySelector('#hub-view-refresh');
    if (refresh) refresh.addEventListener('click', () => this._requestHubViewFrame());
    const textBtn = overlay.querySelector('#hub-view-text');
    if (textBtn) textBtn.addEventListener('click', () => {
      const text = prompt('Text to send to the focused Hub control');
      if (text !== null) this.sendHubViewText(text);
    });
    const keyBtn = overlay.querySelector('#hub-view-key');
    if (keyBtn) keyBtn.addEventListener('click', () => {
      this.toggleHubViewKeyboardCapture();
    });
    if (keyBtn) keyBtn.addEventListener('dblclick', () => {
      const key = prompt('Key: Enter, Esc, Tab, Backspace, Delete, Up, Down, Left, Right, Ctrl+A, Ctrl+S', 'Enter');
      if (key !== null) this.sendHubViewKey(key);
    });
    this._renderHubViewKeyboardCapture();
    const modBtn = overlay.querySelector('#hub-view-mod');
    if (modBtn) modBtn.addEventListener('click', () => this.toggleHubViewMouseModifiers());
    this._renderHubViewMouseModifiers();
    const clipBtn = overlay.querySelector('#hub-view-clip');
    if (clipBtn) clipBtn.addEventListener('click', () => this.readHubViewClipboard());
    const setClipBtn = overlay.querySelector('#hub-view-setclip');
    if (setClipBtn) setClipBtn.addEventListener('click', () => this.setHubViewClipboardFromLocal());
    const fileBtn = overlay.querySelector('#hub-view-file');
    if (fileBtn) fileBtn.addEventListener('click', () => this.pickHubViewFile());
    fileInput.addEventListener('change', () => this.sendHubViewFile(fileInput.files && fileInput.files[0]));
    const body = overlay.querySelector('#hub-view-body');
    if (body) {
      body.addEventListener('dragenter', (e) => this._handleHubViewDragOver(e));
      body.addEventListener('dragover', (e) => this._handleHubViewDragOver(e));
      body.addEventListener('dragleave', (e) => this._setHubViewDropActive(false, e));
      body.addEventListener('drop', (e) => this._handleHubViewDrop(e));
    }
    const zoomBtn = overlay.querySelector('#hub-view-zoom');
    if (zoomBtn) zoomBtn.addEventListener('click', () => this.toggleHubViewZoom());
    this._syncHubViewZoomButton();
    const dragBtn = overlay.querySelector('#hub-view-drag');
    if (dragBtn) dragBtn.addEventListener('click', () => {
      this.hubViewDragMode = !this.hubViewDragMode;
      dragBtn.classList.toggle('hv-mode-on', !!this.hubViewDragMode);
      overlay.classList.toggle('hv-drag-active', !!this.hubViewDragMode);
      const status = overlay.querySelector('#hub-view-status');
      if (status) status.textContent = this.hubViewDragMode ? 'drag mode on' : 'tap/scroll mode';
    });
    const fullscreenBtn = overlay.querySelector('#hub-view-fullscreen');
    if (fullscreenBtn) fullscreenBtn.addEventListener('click', () => this.toggleHubViewFullscreen());
    const liveBtn = overlay.querySelector('#hub-view-live');
    if (liveBtn) liveBtn.addEventListener('click', () => {
      this.hubViewLive = !this.hubViewLive;
      liveBtn.classList.toggle('hv-live-on', !!this.hubViewLive);
      liveBtn.classList.toggle('hv-live-off', !this.hubViewLive);
      if (this.hubViewLive) {
        this._startHubViewLiveRefresh();
        this._syncHubViewWakeLock('live-on');
      } else {
        this._stopHubViewLiveRefresh();
        this._releaseHubViewWakeLock('live-off');
      }
    });
    this._startHubViewLiveRefresh();
    this._syncHubViewWakeLock('hub-view-open');
  },

  _closeHubView(opts = {}) {
    if (document.getElementById('hub-view-overlay')
      && this.hubViewHistoryActive
      && !opts.fromHistory
      && !opts.skipHistory
      && !this.hubViewHistoryClosing) {
      return this._requestCloseHubView('close');
    }
    this._stopHubViewLiveRefresh();
    this._releaseHubViewWakeLock('hub-view-close');
    this.pendingHubViewRequestId = null;
    this.pendingHubViewLiveRequest = false;
    if (this.hubViewBoostTimer) clearTimeout(this.hubViewBoostTimer);
    this.hubViewBoostTimer = null;
    if (this.hubViewStreamRestoreTimer) clearTimeout(this.hubViewStreamRestoreTimer);
    this.hubViewStreamRestoreTimer = null;
    if (this.hubViewStreamResizeTimer) clearTimeout(this.hubViewStreamResizeTimer);
    this.hubViewStreamResizeTimer = null;
    this._clearHubViewStreamWatchdog();
    this._unsubscribeHubViewStream();
    this.hubViewMouseModifierIndex = 0;
    this.hubViewMouseModifiers = [];
    this.hubViewKeyboardCapture = true;
    this._unlockHubViewKeyboard();
    this._hubViewTouch = null;
    this._hubViewDrag = null;
    this._hubViewCanvasPan = null;
    const overlay = document.getElementById('hub-view-overlay');
    if (overlay && this._hubViewKeyHandler) overlay.removeEventListener('keydown', this._hubViewKeyHandler);
    if (overlay && this._hubViewPasteHandler) overlay.removeEventListener('paste', this._hubViewPasteHandler);
    if (this._hubViewFullscreenHandler) {
      document.removeEventListener('fullscreenchange', this._hubViewFullscreenHandler);
      document.removeEventListener('webkitfullscreenchange', this._hubViewFullscreenHandler);
    }
    if (this._hubViewViewportHandler) {
      window.removeEventListener('resize', this._hubViewViewportHandler);
      window.removeEventListener('orientationchange', this._hubViewViewportHandler);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', this._hubViewViewportHandler);
      }
    }
    this._hubViewKeyHandler = null;
    this._hubViewPasteHandler = null;
    this._hubViewFullscreenHandler = null;
    this._hubViewViewportHandler = null;
    if (overlay) overlay.remove();
    this.hubViewHistoryActive = false;
    this.hubViewHistoryToken = null;
    this.hubViewHistoryClosing = false;
    return true;
  },

  _hubViewShouldKeepAwake() {
    return !!(
      document.getElementById('hub-view-overlay')
      && this.hubViewLive
      && !document.hidden
    );
  },

  async _syncHubViewWakeLock(reason = 'sync') {
    this.hubViewWakeLockLastReason = reason;
    if (!this._hubViewShouldKeepAwake()) {
      this._releaseHubViewWakeLock(reason || 'not-needed');
      return false;
    }
    const wakeLock = navigator && navigator.wakeLock;
    this.hubViewWakeLockSupported = !!(wakeLock && typeof wakeLock.request === 'function');
    if (!this.hubViewWakeLockSupported) {
      this.hubViewWakeLockActive = false;
      this.hubViewWakeLockLastError = 'wake-lock-unavailable';
      return false;
    }
    if (this.hubViewWakeLock && this.hubViewWakeLock.released !== true) {
      this.hubViewWakeLockActive = true;
      this.hubViewWakeLockLastError = '';
      return true;
    }
    try {
      const sentinel = await wakeLock.request('screen');
      this.hubViewWakeLock = sentinel;
      this.hubViewWakeLockActive = true;
      this.hubViewWakeLockLastError = '';
      this.hubViewWakeLockAcquireCount = (Number(this.hubViewWakeLockAcquireCount) || 0) + 1;
      if (sentinel && typeof sentinel.addEventListener === 'function') {
        sentinel.addEventListener('release', () => {
          if (this.hubViewWakeLock === sentinel) this.hubViewWakeLock = null;
          this.hubViewWakeLockActive = false;
          this.hubViewWakeLockReleaseCount = (Number(this.hubViewWakeLockReleaseCount) || 0) + 1;
          debugLog('!', 'wake-lock-release', this.hubViewWakeLockLastReason || 'release');
        });
      }
      debugLog('!', 'wake-lock-acquire', reason || 'sync');
      return true;
    } catch (e) {
      this.hubViewWakeLock = null;
      this.hubViewWakeLockActive = false;
      this.hubViewWakeLockLastError = e && e.message || String(e);
      debugLog('!', 'wake-lock-error', this.hubViewWakeLockLastError);
      return false;
    }
  },

  _releaseHubViewWakeLock(reason = 'release') {
    this.hubViewWakeLockLastReason = reason;
    const sentinel = this.hubViewWakeLock;
    this.hubViewWakeLock = null;
    this.hubViewWakeLockActive = false;
    if (sentinel && sentinel.released !== true && typeof sentinel.release === 'function') {
      try {
        const p = sentinel.release();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (_) {}
    }
    return !!sentinel;
  },

  _syncHubViewFullscreenButton() {
    const overlay = document.getElementById('hub-view-overlay');
    const btn = document.getElementById('hub-view-fullscreen');
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement || null;
    const active = !!(overlay && fsEl === overlay);
    if (overlay) overlay.classList.toggle('hv-fullscreen-active', active);
    if (!btn) return;
    btn.classList.toggle('hv-mode-on', active);
    btn.setAttribute('aria-label', active ? 'exit fullscreen' : 'fullscreen');
    const span = btn.querySelector('span');
    if (span) span.textContent = active ? 'ESC' : 'FS';
  },

  _syncHubViewKeyboardCaptureButton() {
    const overlay = document.getElementById('hub-view-overlay');
    const btn = document.getElementById('hub-view-key');
    if (!btn) return;
    const active = this.hubViewKeyboardCapture !== false;
    const locked = !!this.hubViewKeyboardLockActive;
    btn.classList.toggle('hv-mode-on', active);
    btn.classList.toggle('hv-key-lock-on', locked);
    btn.setAttribute('aria-label', active
      ? (locked ? 'keyboard capture and lock on' : 'keyboard capture on')
      : 'keyboard capture off');
    const span = btn.querySelector('span');
    if (span) span.textContent = active ? (locked ? 'K*' : 'K') : 'K0';
    if (overlay) {
      overlay.classList.toggle('hv-keyboard-capture-off', !active);
      overlay.classList.toggle('hv-keyboard-lock-active', locked);
    }
  },

  _handleHubViewFullscreenChange() {
    this._syncHubViewFullscreenButton();
    this._syncHubViewKeyboardLock('fullscreenchange');
  },

  _renderHubViewKeyboardCapture() {
    this._syncHubViewKeyboardCaptureButton();
  },

  toggleHubViewKeyboardCapture() {
    this.hubViewKeyboardCapture = this.hubViewKeyboardCapture === false;
    this._renderHubViewKeyboardCapture();
    const overlay = document.getElementById('hub-view-overlay');
    const status = document.getElementById('hub-view-status');
    if (overlay) {
      try { overlay.focus({ preventScroll: true }); } catch {}
    }
    this._syncHubViewKeyboardLock('capture-toggle');
    if (status) status.textContent = this.hubViewKeyboardCapture ? 'keyboard capture on' : 'keyboard capture off';
    return this.hubViewKeyboardCapture;
  },

  _hubViewFullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  },

  _hubViewCanLockKeyboard() {
    const overlay = document.getElementById('hub-view-overlay');
    return !!(
      overlay
      && this.hubViewKeyboardCapture !== false
      && this._hubViewFullscreenElement() === overlay
      && navigator.keyboard
      && typeof navigator.keyboard.lock === 'function'
    );
  },

  async _syncHubViewKeyboardLock(reason = '') {
    const status = document.getElementById('hub-view-status');
    if (!this._hubViewCanLockKeyboard()) {
      this._unlockHubViewKeyboard();
      return false;
    }
    try {
      await navigator.keyboard.lock();
      this.hubViewKeyboardLockActive = true;
      this.hubViewKeyboardLockReason = reason;
      this._syncHubViewKeyboardCaptureButton();
      if (status) status.textContent = 'fullscreen keyboard lock on';
      return true;
    } catch (e) {
      this.hubViewKeyboardLockActive = false;
      this.hubViewKeyboardLockReason = null;
      this._syncHubViewKeyboardCaptureButton();
      if (status) status.textContent = `keyboard lock unavailable: ${e && e.message || e}`;
      return false;
    }
  },

  _unlockHubViewKeyboard() {
    const wasLocked = !!this.hubViewKeyboardLockActive;
    if (wasLocked && navigator.keyboard && typeof navigator.keyboard.unlock === 'function') {
      try { navigator.keyboard.unlock(); } catch {}
    }
    this.hubViewKeyboardLockActive = false;
    this.hubViewKeyboardLockReason = null;
    this._syncHubViewKeyboardCaptureButton();
    return wasLocked;
  },

  async toggleHubViewFullscreen() {
    const overlay = document.getElementById('hub-view-overlay');
    if (!overlay) return false;
    const status = overlay.querySelector('#hub-view-status');
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement || null;
    try {
      if (fsEl === overlay) {
        if (document.exitFullscreen) await document.exitFullscreen();
        else if (document.webkitExitFullscreen) await document.webkitExitFullscreen();
        this._unlockHubViewKeyboard();
        if (status) status.textContent = 'fullscreen off';
      } else {
        const req = overlay.requestFullscreen || overlay.webkitRequestFullscreen;
        if (!req) {
          if (status) status.textContent = 'fullscreen unavailable';
          return false;
        }
        await req.call(overlay);
        try { overlay.focus({ preventScroll: true }); } catch {}
        await this._syncHubViewKeyboardLock('fullscreen-on');
        if (status) status.textContent = 'fullscreen on';
      }
      this._syncHubViewFullscreenButton();
      return true;
    } catch (e) {
      if (status) status.textContent = `fullscreen failed: ${e && e.message || e}`;
      this._syncHubViewFullscreenButton();
      return false;
    }
  },

  _hubViewFastActive(now = Date.now()) {
    return Number(this.hubViewLiveFastUntil) > now;
  },

  _currentHubViewLiveDelay(now = Date.now()) {
    return this._hubViewFastActive(now)
      ? (Number(this.hubViewLiveFastDelayMs) || 45)
      : (Number(this.hubViewLiveMinDelayMs) || 95);
  },

  _armHubViewFastFrames(reason = 'input', durationMs = 1800) {
    const now = Date.now();
    const until = now + Math.max(250, Math.min(4000, Number(durationMs) || 1800));
    this.hubViewLiveFastUntil = Math.max(Number(this.hubViewLiveFastUntil) || 0, until);
    this.hubViewLiveFastReason = String(reason || 'input');
    if (this.hubViewLive && document.getElementById('hub-view-overlay') && !this._hubViewDrag) {
      this._subscribeHubViewStream({ delayMs: this.hubViewLiveFastDelayMs, reason: 'fast' });
      if (this.hubViewStreamRestoreTimer) clearTimeout(this.hubViewStreamRestoreTimer);
      this.hubViewStreamRestoreTimer = setTimeout(() => {
        this.hubViewStreamRestoreTimer = null;
        if (this.hubViewLive && document.getElementById('hub-view-overlay')) {
          this._subscribeHubViewStream({ delayMs: this.hubViewLiveMinDelayMs, reason: 'normal' });
        }
      }, Math.max(300, until - now));
    }
  },

  _startHubViewLiveRefresh() {
    this._stopHubViewLiveRefresh();
    if (this._subscribeHubViewStream({ delayMs: this._currentHubViewLiveDelay(), reason: 'start' })) return;
    this._scheduleHubViewLiveRefresh(0);
  },

  _scheduleHubViewLiveRefresh(delayMs = null) {
    this._stopHubViewLiveRefresh();
    const baseDelay = delayMs == null ? this._currentHubViewLiveDelay() : delayMs;
    const delay = Math.max(0, Math.min(2000, Number(baseDelay) || 0));
    this.hubViewLiveTimer = setTimeout(() => {
      this.hubViewLiveTimer = null;
      const overlay = document.getElementById('hub-view-overlay');
      if (!overlay || !this.hubViewLive || this.pendingHubViewRequestId || this._hubViewDrag) return;
      this._requestHubViewFrame({ silent: true, live: true });
    }, delay);
  },

  _stopHubViewLiveRefresh() {
    if (this.hubViewLiveTimer) clearTimeout(this.hubViewLiveTimer);
    this.hubViewLiveTimer = null;
    this._unsubscribeHubViewStream();
  },

  _boostHubViewFrame(delayMs = 0, attempts = 10) {
    if (this.hubViewBoostTimer) clearTimeout(this.hubViewBoostTimer);
    const delay = Math.max(0, Math.min(800, Number(delayMs) || 0));
    this.hubViewBoostTimer = setTimeout(() => {
      this.hubViewBoostTimer = null;
      const overlay = document.getElementById('hub-view-overlay');
      if (!overlay) return;
      if (this.pendingHubViewRequestId || this._hubViewDrag) {
        if (attempts > 0) this._boostHubViewFrame(45, attempts - 1);
        return;
      }
      this._requestHubViewFrame({ silent: true, boost: true });
    }, delay);
  },

  _hubViewZoomLevels() {
    return [0, 1, 1.5, 2];
  },

  _hubViewZoomLabel(scale = this.hubViewZoomScale) {
    const value = Number(scale) || 0;
    if (!value) return 'FIT';
    return value === 1 ? '1X' : `${value}X`;
  },

  _syncHubViewZoomButton() {
    const overlay = document.getElementById('hub-view-overlay');
    const zoomBtn = document.getElementById('hub-view-zoom');
    const scale = Math.max(0, Number(this.hubViewZoomScale) || 0);
    this.hubViewActualSize = scale > 0;
    if (overlay) overlay.classList.toggle('hv-actual-size', this.hubViewActualSize);
    if (!zoomBtn) return;
    zoomBtn.classList.toggle('hv-mode-on', this.hubViewActualSize);
    zoomBtn.setAttribute('aria-label', this.hubViewActualSize ? `local zoom ${this._hubViewZoomLabel(scale)}` : 'fit to screen');
    const span = zoomBtn.querySelector('span');
    if (span) span.textContent = this._hubViewZoomLabel(scale);
  },

  _applyHubViewZoom({ preserveScroll = true, center = false, anchorClientX = null, anchorClientY = null } = {}) {
    const overlay = document.getElementById('hub-view-overlay');
    const body = document.getElementById('hub-view-body');
    const img = document.getElementById('hub-view-image');
    if (!overlay || !body || !img) {
      this._syncHubViewZoomButton();
      return false;
    }
    const prev = {
      left: body.scrollLeft,
      top: body.scrollTop,
      maxLeft: Math.max(0, body.scrollWidth - body.clientWidth),
      maxTop: Math.max(0, body.scrollHeight - body.clientHeight),
      scrollWidth: body.scrollWidth,
      scrollHeight: body.scrollHeight,
    };
    let anchor = null;
    if (Number.isFinite(Number(anchorClientX)) && Number.isFinite(Number(anchorClientY))) {
      const rect = body.getBoundingClientRect();
      anchor = {
        viewX: Number(anchorClientX) - rect.left,
        viewY: Number(anchorClientY) - rect.top,
        ratioX: prev.scrollWidth > 0 ? (body.scrollLeft + Number(anchorClientX) - rect.left) / prev.scrollWidth : 0,
        ratioY: prev.scrollHeight > 0 ? (body.scrollTop + Number(anchorClientY) - rect.top) / prev.scrollHeight : 0,
      };
    }
    this._syncHubViewZoomButton();
    const scale = Math.max(0, Number(this.hubViewZoomScale) || 0);
    if (scale > 0) {
      const naturalWidth = img.naturalWidth || Number(this.lastHubViewFrame && this.lastHubViewFrame.width) || 0;
      if (naturalWidth) {
        img.style.setProperty('width', `${Math.round(naturalWidth * scale)}px`, 'important');
        img.style.setProperty('max-width', 'none', 'important');
      }
      img.style.height = 'auto';
    } else {
      img.style.removeProperty('width');
      img.style.removeProperty('max-width');
      img.style.removeProperty('height');
    }
    requestAnimationFrame(() => {
      const maxLeft = Math.max(0, body.scrollWidth - body.clientWidth);
      const maxTop = Math.max(0, body.scrollHeight - body.clientHeight);
      if (anchor) {
        body.scrollLeft = Math.max(0, Math.min(maxLeft, anchor.ratioX * body.scrollWidth - anchor.viewX));
        body.scrollTop = Math.max(0, Math.min(maxTop, anchor.ratioY * body.scrollHeight - anchor.viewY));
        return;
      }
      if (center || this._hubViewCenterActualSizeNext) {
        body.scrollLeft = Math.max(0, maxLeft / 2);
        body.scrollTop = 0;
        this._hubViewCenterActualSizeNext = false;
        return;
      }
      if (!preserveScroll) return;
      const leftRatio = prev.maxLeft > 0 ? prev.left / prev.maxLeft : 0;
      const topRatio = prev.maxTop > 0 ? prev.top / prev.maxTop : 0;
      body.scrollLeft = prev.maxLeft > 0 ? Math.max(0, Math.min(maxLeft, leftRatio * maxLeft)) : Math.max(0, Math.min(maxLeft, prev.left));
      body.scrollTop = prev.maxTop > 0 ? Math.max(0, Math.min(maxTop, topRatio * maxTop)) : Math.max(0, Math.min(maxTop, prev.top));
    });
    return true;
  },

  toggleHubViewZoom() {
    const overlay = document.getElementById('hub-view-overlay');
    if (!overlay) return;
    const levels = this._hubViewZoomLevels();
    const current = Math.max(0, Number(this.hubViewZoomScale) || 0);
    const currentIdx = levels.findIndex(x => Math.abs(Number(x) - current) < 0.01);
    if (currentIdx < 0 && current > 0) this.hubViewZoomScale = 0;
    else {
      const nextIdx = currentIdx >= 0 ? (currentIdx + 1) % levels.length : 1;
      this.hubViewZoomScale = levels[nextIdx];
    }
    this.hubViewActualSize = Number(this.hubViewZoomScale) > 0;
    this._applyHubViewZoom({ center: this.hubViewActualSize && current === 0 });
    const zoomBtn = overlay.querySelector('#hub-view-zoom');
    if (zoomBtn) zoomBtn.classList.toggle('hv-mode-on', !!this.hubViewActualSize);
    const status = overlay.querySelector('#hub-view-status');
    if (status) status.textContent = this.hubViewActualSize ? `local zoom ${this._hubViewZoomLabel()}` : 'fit mode';
  },

  _hubViewFrameWidth() {
    const body = document.getElementById('hub-view-body');
    const cssWidth = Math.max(
      body ? body.clientWidth || 0 : 0,
      window.innerWidth || 0,
      390,
    );
    const dpr = Math.max(1, Math.min(2, Number(window.devicePixelRatio) || 1));
    const target = Math.round(cssWidth * dpr * 1.15);
    return Math.max(900, Math.min(1600, target));
  },

  _subscribeHubViewStream(opts = {}) {
    const overlay = document.getElementById('hub-view-overlay');
    if (!overlay || !this.client || !this.hubViewLive) return false;
    const delayMs = Math.max(45, Math.min(1000, Math.round(Number(opts.delayMs) || this._currentHubViewLiveDelay())));
    const width = this._hubViewFrameWidth();
    const requestId = this.client.subscribeHubView(this.activeHubId, width, {
      mimeType: 'image/jpeg',
      quality: 72,
      delayMs,
    });
    if (!requestId) {
      this.hubViewStreamSubscribed = false;
      this.hubViewStreamFallback = true;
      return false;
    }
    this.hubViewStreamSubscribed = true;
    this.hubViewStreamFallback = false;
    this.hubViewStreamRequestId = requestId;
    this.hubViewStreamDelayMs = delayMs;
    this.hubViewStreamLastWidth = width;
    this.hubViewStreamMode = opts.reason === 'fast' ? 'subscribe-fast' : 'subscribe';
    this._armHubViewStreamWatchdog();
    return true;
  },

  _unsubscribeHubViewStream() {
    if (this.client && this.hubViewStreamSubscribed) {
      try { this.client.unsubscribeHubView(this.activeHubId, this.hubViewStreamRequestId); } catch (_) {}
    }
    this.hubViewStreamSubscribed = false;
    this.hubViewStreamRequestId = null;
    this._clearHubViewStreamWatchdog();
  },

  _clearHubViewStreamWatchdog() {
    if (this.hubViewStreamWatchdogTimer) clearTimeout(this.hubViewStreamWatchdogTimer);
    this.hubViewStreamWatchdogTimer = null;
  },

  _armHubViewStreamWatchdog() {
    this._clearHubViewStreamWatchdog();
    if (!this.hubViewLive || !document.getElementById('hub-view-overlay')) return;
    const delay = Math.max(
      Number(this.hubViewStreamWatchdogMs) || 3500,
      (Number(this.hubViewStreamDelayMs) || 95) * 10,
    );
    this.hubViewStreamWatchdogTimer = setTimeout(() => this._checkHubViewStreamWatchdog(), delay);
  },

  _checkHubViewStreamWatchdog() {
    this.hubViewStreamWatchdogTimer = null;
    const overlay = document.getElementById('hub-view-overlay');
    if (!overlay || !this.hubViewLive) return false;
    const now = Date.now();
    const last = Number(this.hubViewStreamLastFrameAt) || 0;
    const delay = Math.max(
      Number(this.hubViewStreamWatchdogMs) || 3500,
      (Number(this.hubViewStreamDelayMs) || 95) * 10,
    );
    if (!last || now - last > delay) {
      this._restartHubViewStream('watchdog-stale');
      if (!this.pendingHubViewRequestId) this._requestHubViewFrame({ silent: true, boost: true });
      return true;
    }
    this._armHubViewStreamWatchdog();
    return false;
  },

  _restartHubViewStream(reason = 'restart') {
    if (!document.getElementById('hub-view-overlay') || !this.hubViewLive) return false;
    this.hubViewStreamRestartCount = (Number(this.hubViewStreamRestartCount) || 0) + 1;
    this.hubViewStreamLastRestartReason = String(reason || 'restart');
    this._unsubscribeHubViewStream();
    return this._subscribeHubViewStream({ delayMs: this._currentHubViewLiveDelay(), reason });
  },

  _scheduleHubViewViewportResubscribe() {
    if (this.hubViewStreamResizeTimer) clearTimeout(this.hubViewStreamResizeTimer);
    this.hubViewStreamResizeTimer = setTimeout(() => {
      this.hubViewStreamResizeTimer = null;
      if (!document.getElementById('hub-view-overlay') || !this.hubViewLive) return;
      const width = this._hubViewFrameWidth();
      const prev = Number(this.hubViewStreamLastWidth) || 0;
      if (!prev || Math.abs(width - prev) >= 64) {
        this._restartHubViewStream('viewport-resize');
      }
    }, 250);
  },

  _requestHubViewFrame(opts = {}) {
    const overlay = document.getElementById('hub-view-overlay');
    const status = overlay && overlay.querySelector('#hub-view-status');
    const body = overlay && overlay.querySelector('#hub-view-body');
    if (!overlay || !this.client) return;
    if (this.pendingHubViewRequestId || this._hubViewDrag) return;
    if (status && !opts.silent) status.textContent = 'requesting frame...';
    if (body && !opts.silent) {
      body.innerHTML = '<div class="hv-loading"><div class="af-spinner"></div><div>Waiting for desktop frame...</div></div>';
    }
    const requestId = this.client.requestHubView(this.activeHubId, this._hubViewFrameWidth(), { mimeType: 'image/jpeg', quality: 72 });
    this.pendingHubViewRequestId = requestId;
    this.pendingHubViewLiveRequest = !!opts.live;
    if (requestId) {
      this.hubViewFrameRequestTimes = this.hubViewFrameRequestTimes || {};
      this.hubViewFrameRequestTimes[requestId] = {
        ts: Date.now(),
        live: !!opts.live,
        boost: !!opts.boost,
        fast: this._hubViewFastActive(),
      };
      const ids = Object.keys(this.hubViewFrameRequestTimes);
      while (ids.length > 30) delete this.hubViewFrameRequestTimes[ids.shift()];
    }
    if (!this.pendingHubViewRequestId) {
      this.pendingHubViewLiveRequest = false;
      if (status) status.textContent = 'request failed';
      if (body) body.innerHTML = '<div class="hv-error">Gateway is not connected.</div>';
    }
  },

  onHubViewFrame(msg) {
    if (!msg) return;
    if (!msg.stream && this.pendingHubViewRequestId && msg.requestId !== this.pendingHubViewRequestId) return;
    const overlay = document.getElementById('hub-view-overlay');
    if (!overlay) return;
    const status = overlay.querySelector('#hub-view-status');
    const body = overlay.querySelector('#hub-view-body');
    if (!body) return;
    if (this._hubViewDrag) {
      this.pendingHubViewRequestId = null;
      this.pendingHubViewLiveRequest = false;
      return;
    }
    if (!msg.ok) {
      if (status) status.textContent = 'frame failed';
      body.innerHTML = `<div class="hv-error">${this._esc(msg.error || 'capture_failed')}</div>`;
      this.pendingHubViewRequestId = null;
      this.pendingHubViewLiveRequest = false;
      if (msg.stream) this._restartHubViewStream('stream-error');
      if (this.hubViewLive) this._scheduleHubViewLiveRefresh(this.hubViewLiveErrorDelayMs);
      return;
    }
    const prevScroll = {
      left: body.scrollLeft,
      top: body.scrollTop,
      maxLeft: Math.max(0, body.scrollWidth - body.clientWidth),
      maxTop: Math.max(0, body.scrollHeight - body.clientHeight),
    };
    const mimeType = msg.mimeType || 'image/png';
    const captured = msg.capturedAt ? new Date(msg.capturedAt).toLocaleTimeString() : this._fmtTime(Date.now());
    this.lastHubViewFrame = msg;
    const now = Date.now();
    const requestMeta = msg.requestId && this.hubViewFrameRequestTimes ? this.hubViewFrameRequestTimes[msg.requestId] : null;
    if (msg.requestId && this.hubViewFrameRequestTimes) delete this.hubViewFrameRequestTimes[msg.requestId];
    const rttMs = requestMeta && requestMeta.ts ? Math.max(0, Math.round(now - requestMeta.ts)) : null;
    const ageMs = msg.capturedAt ? Math.max(0, Math.round(now - Number(msg.capturedAt))) : null;
    if (msg.stream) {
      this.hubViewStreamSubscribed = true;
      this.hubViewStreamFrameCount = (Number(this.hubViewStreamFrameCount) || 0) + 1;
      this.hubViewStreamLastFrameAt = now;
      if (msg.streamDelayMs) this.hubViewStreamDelayMs = Number(msg.streamDelayMs) || this.hubViewStreamDelayMs;
      this._armHubViewStreamWatchdog();
    }
    this.lastHubViewFrameStats = {
      requestId: msg.requestId || null,
      rttMs,
      ageMs,
      live: !!(msg.stream || (requestMeta && requestMeta.live)),
      boost: !!(requestMeta && requestMeta.boost),
      stream: !!msg.stream,
      streamDelayMs: msg.streamDelayMs || null,
      streamRestartCount: Number(this.hubViewStreamRestartCount) || 0,
      streamRestartReason: this.hubViewStreamLastRestartReason || '',
      fast: !!((requestMeta && requestMeta.fast) || (msg.stream && this._hubViewFastActive(now))),
      fastActive: this._hubViewFastActive(now),
      fastReason: this.hubViewLiveFastReason || '',
      receivedAt: now,
      capturedAt: msg.capturedAt || null,
    };
    this.hubViewLiveFrameTimes = (this.hubViewLiveFrameTimes || []).concat([now]).slice(-20);
    const holdUntil = Number(this._hubViewFrameHoldUntil) || 0;
    if (holdUntil && now < holdUntil) {
      const wasLiveRequest = !!this.pendingHubViewLiveRequest;
      this.pendingHubViewRequestId = null;
      this.pendingHubViewLiveRequest = false;
      if (!msg.stream && this.hubViewLive && (wasLiveRequest || !this.hubViewLiveTimer)) {
        this._scheduleHubViewLiveRefresh(Math.max(this._currentHubViewLiveDelay(now), holdUntil - now));
      }
      return;
    }
    const kb = msg.byteLength ? `${Math.max(1, Math.round(Number(msg.byteLength) / 1024))}KB` : '';
    const q = msg.quality ? `q${msg.quality}` : '';
    const frameMeta = [kb, q].filter(Boolean).join(' ');
    const latencyMeta = [
      rttMs != null ? `${rttMs}ms` : '',
      ageMs != null ? `age${ageMs}ms` : '',
      msg.stream ? `stream${this.hubViewStreamDelayMs || ''}` : '',
      this._hubViewFastActive(now) ? 'fast' : '',
    ].filter(Boolean).join(' ');
    if (status) status.textContent = `${msg.width || '?'}x${msg.height || '?'}${frameMeta ? ' | ' + frameMeta : ''}${latencyMeta ? ' | ' + latencyMeta : ''} | ${captured} | tap to control`;
    const src = `data:${this._esc(mimeType)};base64,${this._esc(msg.imageBase64 || '')}`;
    let img = body.querySelector('#hub-view-image');
    if (!img) {
      body.innerHTML = `
        <div class="hv-image-wrap">
          <img id="hub-view-image" alt="Hub desktop view" src="${src}" data-captured-at="${this._esc(String(msg.capturedAt || Date.now()))}">
        </div>`;
      img = body.querySelector('#hub-view-image');
    } else {
      img.src = src;
      img.dataset.capturedAt = String(msg.capturedAt || Date.now());
    }
    if (img && img.dataset.hvBound !== '1') {
      img.dataset.hvBound = '1';
      img.addEventListener('click', (e) => this._sendHubViewPointer(e, img, this.lastHubViewFrame || msg));
      img.addEventListener('dblclick', (e) => this._sendHubViewPointer(e, img, this.lastHubViewFrame || msg, { clickCount: 2, label: 'double-click' }));
      img.addEventListener('contextmenu', (e) => {
        if (e && e.preventDefault) e.preventDefault();
        this._sendHubViewPointer(e, img, this.lastHubViewFrame || msg, { button: 'right', label: 'right-click' });
      });
      img.addEventListener('pointerdown', (e) => {
        this._holdHubViewFrameReplacement(500);
        if (this._startHubViewCanvasPan(e)) return;
        this._startHubViewDrag(e, img, this.lastHubViewFrame || msg);
      });
      img.addEventListener('mousedown', (e) => {
        this._holdHubViewFrameReplacement(500);
        if (this.hubViewActualSize && e && e.button === 1 && e.preventDefault) e.preventDefault();
      });
      img.addEventListener('pointermove', (e) => {
        const frame = this.lastHubViewFrame || msg;
        if (this._moveHubViewCanvasPan(e)) return;
        this._moveHubViewDrag(e, img, frame);
        this._sendHubViewMouseMove(e, img, frame);
      });
      img.addEventListener('pointerup', (e) => {
        if (this._endHubViewCanvasPan(e)) return;
        this._endHubViewDrag(e, img, this.lastHubViewFrame || msg);
      });
      img.addEventListener('pointercancel', (e) => {
        if (this._endHubViewCanvasPan(e)) return;
        this._endHubViewDrag(e, img, this.lastHubViewFrame || msg);
      });
      img.addEventListener('lostpointercapture', (e) => {
        if (this._endHubViewCanvasPan(e)) return;
        this._endHubViewDrag(e, img, this.lastHubViewFrame || msg);
      });
      img.addEventListener('mouseup', (e) => {
        if (this._endHubViewCanvasPan(e)) return;
        this._endHubViewDrag(e, img, this.lastHubViewFrame || msg);
      });
      img.addEventListener('wheel', (e) => this._sendHubViewWheel(e, img, this.lastHubViewFrame || msg), { passive: false });
      img.addEventListener('touchstart', (e) => this._startHubViewTouch(e, img, this.lastHubViewFrame || msg), { passive: false });
      img.addEventListener('touchmove', (e) => this._moveHubViewTouch(e, img, this.lastHubViewFrame || msg), { passive: false });
      img.addEventListener('touchend', (e) => this._endHubViewTouch(e, img, this.lastHubViewFrame || msg), { passive: false });
      img.addEventListener('touchcancel', (e) => this._endHubViewTouch(e, img, this.lastHubViewFrame || msg), { passive: false });
    }
    this._applyHubViewZoom({ preserveScroll: true, center: false });
    const wasLiveRequest = !!this.pendingHubViewLiveRequest;
    this.pendingHubViewRequestId = null;
    this.pendingHubViewLiveRequest = false;
    if (!msg.stream && this.hubViewLive && (wasLiveRequest || !this.hubViewLiveTimer)) {
      this._scheduleHubViewLiveRefresh(this._currentHubViewLiveDelay());
    }
  },

  _sendHubViewPointer(e, img, frame, opts = {}) {
    if (!this.client || !img || !frame) return;
    if ((Number(this._hubViewSuppressNextClickUntil) || 0) > Date.now() && opts.button !== 'right') {
      if (e && e.preventDefault) e.preventDefault();
      if (e && e.stopPropagation) e.stopPropagation();
      return null;
    }
    this._holdHubViewFrameReplacement(350);
    if (this.hubViewDragMode) return;
    if (!opts.clickCount && e && e.detail && e.detail > 1) return;
    const overlay = document.getElementById('hub-view-overlay');
    if (overlay) {
      try { overlay.focus({ preventScroll: true }); } catch {}
    }
    return this._sendHubViewClickAt(e.clientX, e.clientY, img, frame, { ...opts, event: e });
  },

  _holdHubViewFrameReplacement(ms = 450) {
    const until = Date.now() + Math.max(100, Math.min(1500, Number(ms) || 450));
    this._hubViewFrameHoldUntil = Math.max(Number(this._hubViewFrameHoldUntil) || 0, until);
    return this._hubViewFrameHoldUntil;
  },

  _hubViewMouseModifierModes() {
    return [
      { label: 'MOD', modifiers: [] },
      { label: 'SFT', modifiers: ['shift'] },
      { label: 'CTL', modifiers: ['control'] },
      { label: 'ALT', modifiers: ['alt'] },
      { label: 'C+S', modifiers: ['control', 'shift'] },
    ];
  },

  _renderHubViewMouseModifiers() {
    const btn = document.getElementById('hub-view-mod');
    if (!btn) return;
    const modes = this._hubViewMouseModifierModes();
    const idx = Math.max(0, Math.min(modes.length - 1, Number(this.hubViewMouseModifierIndex) || 0));
    const mode = modes[idx] || modes[0];
    this.hubViewMouseModifierIndex = idx;
    this.hubViewMouseModifiers = mode.modifiers.slice();
    btn.classList.toggle('hv-mode-on', this.hubViewMouseModifiers.length > 0);
    btn.setAttribute('aria-label', this.hubViewMouseModifiers.length ? `mouse modifiers ${mode.label}` : 'mouse modifier latch');
    const span = btn.querySelector('span');
    if (span) span.textContent = mode.label;
  },

  toggleHubViewMouseModifiers() {
    const modes = this._hubViewMouseModifierModes();
    this.hubViewMouseModifierIndex = ((Number(this.hubViewMouseModifierIndex) || 0) + 1) % modes.length;
    this._renderHubViewMouseModifiers();
    const status = document.getElementById('hub-view-status');
    const mode = modes[this.hubViewMouseModifierIndex] || modes[0];
    if (status) status.textContent = mode.modifiers.length ? `mouse modifiers ${mode.label} locked` : 'mouse modifiers off';
  },

  _hubViewModifiersFromEvent(e) {
    const modifiers = Array.isArray(this.hubViewMouseModifiers) ? this.hubViewMouseModifiers.slice() : [];
    if (!e) return Array.from(new Set(modifiers));
    if (e.shiftKey) modifiers.push('shift');
    if (e.ctrlKey) modifiers.push('control');
    if (e.altKey) modifiers.push('alt');
    if (e.metaKey) modifiers.push('meta');
    return Array.from(new Set(modifiers));
  },

  _sendHubViewClickAt(clientX, clientY, img, frame, opts = {}) {
    const point = this._hubViewPoint(clientX, clientY, img, frame);
    if (!point) return null;
    const button = opts.button === 'right' ? 'right' : 'left';
    const clickCount = Math.max(1, Math.min(Number(opts.clickCount) || 1, 2));
    const modifiers = Array.isArray(opts.modifiers) ? opts.modifiers : this._hubViewModifiersFromEvent(opts.event);
    const status = document.getElementById('hub-view-status');
    if (status) status.textContent = `${opts.label || 'click'} ${point.x},${point.y} sent...`;
    const requestId = this.client.sendHubViewInput({
      kind: 'mouse-click',
      button,
      clickCount,
      modifiers,
      ...point,
    }, this.activeHubId);
    if (!requestId && status) status.textContent = 'input send failed';
    return requestId;
  },

  _hubViewPoint(clientX, clientY, img, frame) {
    const rect = img.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const nx = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const ny = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    const width = Number(frame.width) || img.naturalWidth || 1;
    const height = Number(frame.height) || img.naturalHeight || 1;
    return {
      x: Math.max(0, Math.min(width - 1, Math.round(nx * (width - 1)))),
      y: Math.max(0, Math.min(height - 1, Math.round(ny * (height - 1)))),
      width,
      height,
      originalWidth: frame.originalWidth || width,
      originalHeight: frame.originalHeight || height,
    };
  },

  _sendHubViewMouseMove(e, img, frame) {
    if (!this.client || !img || !frame || !e) return null;
    if (this.hubViewDragMode || this._hubViewDrag || this._hubViewCanvasPan || e.pointerType === 'touch') return null;
    const now = Date.now();
    if (this._lastHubViewMouseMoveAt && now - this._lastHubViewMouseMoveAt < 90) return null;
    this._lastHubViewMouseMoveAt = now;
    const point = this._hubViewPoint(e.clientX, e.clientY, img, frame);
    if (!point) return null;
    return this.client.sendHubViewInput({
      kind: 'mouse-move',
      modifiers: this._hubViewModifiersFromEvent(e),
      ...point,
    }, this.activeHubId);
  },

  _startHubViewCanvasPan(e) {
    if (!this.hubViewActualSize || this.hubViewDragMode || !e || e.button !== 1) return false;
    const body = document.getElementById('hub-view-body');
    const overlay = document.getElementById('hub-view-overlay');
    if (!body) return false;
    if (e.preventDefault) e.preventDefault();
    if (e.stopPropagation) e.stopPropagation();
    try { e.target && e.target.setPointerCapture && e.target.setPointerCapture(e.pointerId); } catch {}
    this._hubViewCanvasPan = {
      pointerId: e.pointerId,
      lastX: e.clientX,
      lastY: e.clientY,
    };
    if (overlay) overlay.classList.add('hv-canvas-pan-active');
    const status = document.getElementById('hub-view-status');
    if (status) status.textContent = 'canvas pan mode';
    return true;
  },

  _moveHubViewCanvasPan(e) {
    if (!this._hubViewCanvasPan || !e) return false;
    if (this._hubViewCanvasPan.pointerId != null && e.pointerId != null && this._hubViewCanvasPan.pointerId !== e.pointerId) return false;
    const body = document.getElementById('hub-view-body');
    if (!body) return false;
    if (e.preventDefault) e.preventDefault();
    if (e.stopPropagation) e.stopPropagation();
    const dx = this._hubViewCanvasPan.lastX - e.clientX;
    const dy = this._hubViewCanvasPan.lastY - e.clientY;
    this._hubViewCanvasPan.lastX = e.clientX;
    this._hubViewCanvasPan.lastY = e.clientY;
    if (Math.abs(dx) + Math.abs(dy) >= 1) {
      body.scrollLeft += dx;
      body.scrollTop += dy;
      const status = document.getElementById('hub-view-status');
      if (status) status.textContent = `canvas pan ${Math.round(body.scrollLeft)},${Math.round(body.scrollTop)}`;
    }
    return true;
  },

  _endHubViewCanvasPan(e) {
    if (!this._hubViewCanvasPan) return false;
    if (e && this._hubViewCanvasPan.pointerId != null && e.pointerId != null && this._hubViewCanvasPan.pointerId !== e.pointerId && e.type !== 'mouseup') return false;
    if (e && e.preventDefault) e.preventDefault();
    if (e && e.stopPropagation) e.stopPropagation();
    try { e && e.target && e.target.releasePointerCapture && e.target.releasePointerCapture(e.pointerId); } catch {}
    const overlay = document.getElementById('hub-view-overlay');
    if (overlay) overlay.classList.remove('hv-canvas-pan-active');
    this._hubViewCanvasPan = null;
    return true;
  },

  _sendHubViewDrag(phase, clientX, clientY, img, frame, event = null) {
    const point = this._hubViewPoint(clientX, clientY, img, frame);
    if (!point) return null;
    const status = document.getElementById('hub-view-status');
    if (status) status.textContent = `drag ${phase} sent...`;
    const requestId = this.client.sendHubViewInput({
      kind: 'mouse-drag',
      phase,
      button: 'left',
      modifiers: this._hubViewModifiersFromEvent(event),
      ...point,
    }, this.activeHubId);
    if (!requestId && status) status.textContent = 'drag send failed';
    return requestId;
  },

  _startHubViewDrag(e, img, frame) {
    if (!this.hubViewDragMode || !this.client || !img || !frame || e.button > 0) return;
    if (e && e.preventDefault) e.preventDefault();
    try { img.setPointerCapture(e.pointerId); } catch {}
    this._hubViewDrag = { pointerId: e.pointerId, lastSentAt: 0 };
    this._stopHubViewLiveRefresh();
    this._sendHubViewDrag('down', e.clientX, e.clientY, img, frame, e);
  },

  _moveHubViewDrag(e, img, frame) {
    if (!this._hubViewDrag || this._hubViewDrag.pointerId !== e.pointerId) return;
    if (e && e.preventDefault) e.preventDefault();
    const now = Date.now();
    if (now - this._hubViewDrag.lastSentAt < 60) return;
    this._hubViewDrag.lastSentAt = now;
    this._sendHubViewDrag('move', e.clientX, e.clientY, img, frame, e);
  },

  _endHubViewDrag(e, img, frame) {
    if (!this._hubViewDrag) return;
    if (e && e.pointerId != null && this._hubViewDrag.pointerId != null && this._hubViewDrag.pointerId !== e.pointerId && e.type !== 'mouseup') return;
    if (e && e.preventDefault) e.preventDefault();
    this._sendHubViewDrag('up', e.clientX, e.clientY, img, frame, e);
    try { img.releasePointerCapture(e.pointerId); } catch {}
    this._hubViewDrag = null;
    if (this.hubViewLive) this._startHubViewLiveRefresh();
  },

  _sendHubViewWheel(e, img, frame) {
    if (!this.client || !img || !frame) return;
    if (e && e.preventDefault) e.preventDefault();
    const dx = Math.max(-1200, Math.min(1200, Math.round(e.deltaX || 0)));
    const dy = Math.max(-1200, Math.min(1200, Math.round(e.deltaY || 0)));
    this._sendHubViewWheelAt(e.clientX, e.clientY, dx, dy, img, frame, this._hubViewModifiersFromEvent(e));
  },

  _clearHubViewTouchLongPress() {
    if (this._hubViewTouch && this._hubViewTouch.longPressTimer) {
      clearTimeout(this._hubViewTouch.longPressTimer);
      this._hubViewTouch.longPressTimer = null;
    }
  },

  _hubViewTouchCenter(touches) {
    if (!touches || touches.length < 2) return null;
    const a = touches[0];
    const b = touches[1];
    if (!a || !b) return null;
    return {
      x: (Number(a.clientX) + Number(b.clientX)) / 2,
      y: (Number(a.clientY) + Number(b.clientY)) / 2,
    };
  },

  _hubViewTouchDistance(touches) {
    if (!touches || touches.length < 2) return 0;
    const a = touches[0];
    const b = touches[1];
    if (!a || !b) return 0;
    const dx = Number(a.clientX) - Number(b.clientX);
    const dy = Number(a.clientY) - Number(b.clientY);
    return Math.sqrt(dx * dx + dy * dy);
  },

  _endHubViewTouch(e = null, img = null, frame = null) {
    const touchState = this._hubViewTouch;
    if (touchState && touchState.drag && img && frame) {
      if (e && e.preventDefault) e.preventDefault();
      const changed = Array.from((e && e.changedTouches) || []);
      const t = changed.find(x => Number(x.identifier) === Number(touchState.identifier)) || changed[0] || touchState;
      this._sendHubViewDrag('up', Number(t.clientX) || touchState.lastX, Number(t.clientY) || touchState.lastY, img, frame, e);
      if (this.hubViewLive) this._startHubViewLiveRefresh();
    }
    this._clearHubViewTouchLongPress();
    this._hubViewTouch = null;
  },

  _startHubViewTouch(e, img, frame) {
    if (e.touches && e.touches.length >= 2) {
      const center = this._hubViewTouchCenter(e.touches);
      const distance = this._hubViewTouchDistance(e.touches);
      if (!center) return;
      if (e && e.preventDefault) e.preventDefault();
      this._clearHubViewTouchLongPress();
      this.hubViewPinchFrameHoldUntil = this._holdHubViewFrameReplacement(900);
      this.hubViewPinchFrameHoldCount = (Number(this.hubViewPinchFrameHoldCount) || 0) + 1;
      const currentScale = Math.max(0, Number(this.hubViewZoomScale) || 0);
      this._hubViewTouch = {
        pan: true,
        pinch: true,
        lastX: center.x,
        lastY: center.y,
        startDistance: Math.max(1, distance),
        lastDistance: Math.max(1, distance),
        startScale: currentScale > 0 ? currentScale : 1,
      };
      const status = document.getElementById('hub-view-status');
      if (status) status.textContent = 'pinch zoom mode';
      return;
    }
    const t = e.touches && e.touches[0];
    if (!t) return;
    if (this.hubViewDragMode && this.client && img && frame) {
      if (e && e.preventDefault) e.preventDefault();
      this._clearHubViewTouchLongPress();
      this._hubViewTouch = {
        drag: true,
        identifier: t.identifier,
        lastX: t.clientX,
        lastY: t.clientY,
        lastSentAt: 0,
      };
      this._stopHubViewLiveRefresh();
      this.hubViewTouchDragCount = (Number(this.hubViewTouchDragCount) || 0) + 1;
      this.hubViewTouchDragLastAt = Date.now();
      this._sendHubViewDrag('down', t.clientX, t.clientY, img, frame, e);
      return;
    }
    this._hubViewTouch = { x: t.clientX, y: t.clientY, lastX: t.clientX, lastY: t.clientY, lastSentAt: 0, longPressTimer: null };
    this._hubViewTouch.longPressTimer = setTimeout(() => {
      if (!this._hubViewTouch || !img || !frame || this.hubViewDragMode) return;
      const touch = this._hubViewTouch;
      this._sendHubViewClickAt(touch.x, touch.y, img, frame, { button: 'right', label: 'long-right-click' });
      this._hubViewSuppressNextClickUntil = Date.now() + 1800;
      this._endHubViewTouch();
    }, 650);
  },

  _moveHubViewTouch(e, img, frame) {
    if (e.touches && (this._hubViewTouch?.pan || e.touches.length >= 2)) {
      const center = this._hubViewTouchCenter(e.touches);
      const body = document.getElementById('hub-view-body');
      if (!center || !body) return;
      if (e && e.preventDefault) e.preventDefault();
      this._clearHubViewTouchLongPress();
      this.hubViewPinchFrameHoldUntil = this._holdHubViewFrameReplacement(900);
      this.hubViewPinchFrameHoldCount = (Number(this.hubViewPinchFrameHoldCount) || 0) + 1;
      if (!this._hubViewTouch || !this._hubViewTouch.pan) {
        const distance = this._hubViewTouchDistance(e.touches);
        const currentScale = Math.max(0, Number(this.hubViewZoomScale) || 0);
        this._hubViewTouch = {
          pan: true,
          pinch: true,
          lastX: center.x,
          lastY: center.y,
          startDistance: Math.max(1, distance),
          lastDistance: Math.max(1, distance),
          startScale: currentScale > 0 ? currentScale : 1,
        };
        return;
      }
      let pinched = false;
      if (e.touches.length >= 2 && this._hubViewTouch.pinch) {
        const distance = Math.max(1, this._hubViewTouchDistance(e.touches));
        const startDistance = Math.max(1, Number(this._hubViewTouch.startDistance) || distance);
        const startScale = Math.max(0.75, Number(this._hubViewTouch.startScale) || 1);
        const ratio = distance / startDistance;
        const unclampedScale = startScale * ratio;
        const fitReset = unclampedScale <= 0.88;
        const nextScale = fitReset ? 0 : Math.max(0.75, Math.min(2.5, unclampedScale));
        const currentScale = Math.max(0, Number(this.hubViewZoomScale) || 0);
        if (fitReset || Math.abs(nextScale - (currentScale || 1)) >= 0.035) {
          this.hubViewZoomScale = fitReset ? 0 : Number(nextScale.toFixed(2));
          this.hubViewActualSize = this.hubViewZoomScale > 0;
          this.hubViewPinchZoomCount = (Number(this.hubViewPinchZoomCount) || 0) + 1;
          this.hubViewPinchZoomLastScale = this.hubViewZoomScale;
          this.hubViewPinchZoomLastAt = Date.now();
          if (fitReset) {
            this.hubViewPinchFitResetCount = (Number(this.hubViewPinchFitResetCount) || 0) + 1;
            this.hubViewPinchFitResetLastAt = Date.now();
          }
          this._applyHubViewZoom(fitReset ? { preserveScroll: false } : { anchorClientX: center.x, anchorClientY: center.y });
          pinched = true;
        }
        this._hubViewTouch.lastDistance = distance;
      }
      const dx = this._hubViewTouch.lastX - center.x;
      const dy = this._hubViewTouch.lastY - center.y;
      this._hubViewTouch.lastX = center.x;
      this._hubViewTouch.lastY = center.y;
      if (Math.abs(dx) + Math.abs(dy) < 1 && !pinched) return;
      body.scrollLeft += dx;
      body.scrollTop += dy;
      const status = document.getElementById('hub-view-status');
      if (status) status.textContent = pinched
        ? `pinch zoom ${this._hubViewZoomLabel()}`
        : `canvas pan ${Math.round(body.scrollLeft)},${Math.round(body.scrollTop)}`;
      return;
    }
    const t = e.touches && e.touches[0];
    if (!t || !this._hubViewTouch) return;
    if (this._hubViewTouch.drag) {
      if (e && e.preventDefault) e.preventDefault();
      const now = Date.now();
      this._clearHubViewTouchLongPress();
      this._hubViewTouch.lastX = t.clientX;
      this._hubViewTouch.lastY = t.clientY;
      if (now - this._hubViewTouch.lastSentAt < 60) return;
      this._hubViewTouch.lastSentAt = now;
      this.hubViewTouchDragLastAt = now;
      this._sendHubViewDrag('move', t.clientX, t.clientY, img, frame, e);
      return;
    }
    const dx = this._hubViewTouch.lastX - t.clientX;
    const dy = this._hubViewTouch.lastY - t.clientY;
    if (Math.abs(t.clientX - this._hubViewTouch.x) + Math.abs(t.clientY - this._hubViewTouch.y) > 10) {
      this._clearHubViewTouchLongPress();
    }
    this._hubViewTouch.lastX = t.clientX;
    this._hubViewTouch.lastY = t.clientY;
    const now = Date.now();
    if (Math.abs(dx) + Math.abs(dy) < 3 || now - this._hubViewTouch.lastSentAt < 80) return;
    this._hubViewTouch.lastSentAt = now;
    if (e && e.preventDefault) e.preventDefault();
    this._sendHubViewWheelAt(t.clientX, t.clientY, Math.round(dx * 2.4), Math.round(dy * 2.4), img, frame);
  },

  _sendHubViewWheelAt(clientX, clientY, deltaX, deltaY, img, frame, modifiers = []) {
    const point = this._hubViewPoint(clientX, clientY, img, frame);
    if (!point) return null;
    const status = document.getElementById('hub-view-status');
    if (status) status.textContent = `wheel ${deltaX},${deltaY} sent...`;
    const requestId = this.client.sendHubViewInput({
      kind: 'mouse-wheel',
      ...point,
      deltaX: Math.max(-2400, Math.min(2400, Number(deltaX) || 0)),
      deltaY: Math.max(-2400, Math.min(2400, Number(deltaY) || 0)),
      modifiers: Array.isArray(modifiers) ? modifiers : [],
    }, this.activeHubId);
    if (!requestId && status) status.textContent = 'wheel send failed';
    return requestId;
  },

  sendHubViewText(text) {
    if (!this.client) return null;
    const value = String(text || '');
    const status = document.getElementById('hub-view-status');
    if (!value) {
      if (status) status.textContent = 'empty text skipped';
      return null;
    }
    if (status) status.textContent = `text ${value.length} chars sent...`;
    const requestId = this.client.sendHubViewInput({
      kind: 'text-paste',
      text: value.slice(0, 5000),
    }, this.activeHubId);
    if (!requestId && status) status.textContent = 'text send failed';
    return requestId;
  },

  _handleHubViewKeydown(e) {
    if (!this.client || !document.getElementById('hub-view-overlay')) return;
    if (this.hubViewKeyboardCapture === false) return;
    if (!e || e.isComposing || e.key === 'Dead') return;
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
    const target = e.target;
    if (target && target.closest && target.closest('button') && (e.key === 'Enter' || e.key === ' ')) return;
    const hasCommandModifier = !!(e.ctrlKey || e.metaKey || e.altKey);
    const commandKey = String(e.key || '').toLowerCase();
    if ((e.ctrlKey || e.metaKey) && !e.altKey && commandKey === 'v') {
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && commandKey === 'c') {
      const requestId = this.readHubViewClipboard();
      if (requestId) e.preventDefault();
      return;
    }
    if (e.key && e.key.length === 1 && !hasCommandModifier) {
      e.preventDefault();
      this.sendHubViewText(e.key);
      return;
    }
    const parts = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.metaKey) parts.push('Meta');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    let keyName = e.key === ' ' ? 'Space' : e.key;
    if (e.code && (/^Numpad/.test(e.code) || /^F(?:1[3-9]|2[0-4])$/.test(e.code))) keyName = e.code;
    if ((!keyName || keyName === 'Unidentified') && e.code) keyName = e.code;
    const requestId = this.sendHubViewKey(parts.concat([keyName]).join('+'));
    if (requestId) e.preventDefault();
  },

  _handleHubViewPaste(e) {
    const text = e && e.clipboardData && e.clipboardData.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    this.pasteHubViewText(text);
  },

  sendHubViewKey(rawKey) {
    if (!this.client) return null;
    const parsed = this._parseHubViewKey(rawKey);
    const status = document.getElementById('hub-view-status');
    if (!parsed) {
      if (status) status.textContent = 'unsupported key';
      return null;
    }
    if (status) status.textContent = `key ${parsed.label} sent...`;
    const requestId = this.client.sendHubViewInput({
      kind: 'key-press',
      keyCode: parsed.keyCode,
      modifiers: parsed.modifiers,
    }, this.activeHubId);
    if (!requestId && status) status.textContent = 'key send failed';
    return requestId;
  },

  _parseHubViewKey(rawKey) {
    const value = String(rawKey || '').trim();
    if (!value) return null;
    const parts = value.split('+').map(x => x.trim()).filter(Boolean);
    const modifiers = [];
    let key = parts.pop() || value;
    for (const part of parts) {
      const m = part.toLowerCase();
      if (m === 'ctrl' || m === 'control') modifiers.push('control');
      else if (m === 'shift') modifiers.push('shift');
      else if (m === 'alt' || m === 'option') modifiers.push('alt');
      else if (m === 'cmd' || m === 'meta' || m === 'win') modifiers.push('meta');
      else return null;
    }
    const map = {
      esc: 'Escape',
      escape: 'Escape',
      enter: 'Enter',
      return: 'Enter',
      tab: 'Tab',
      backspace: 'Backspace',
      delete: 'Delete',
      del: 'Delete',
      up: 'Up',
      arrowup: 'Up',
      down: 'Down',
      arrowdown: 'Down',
      left: 'Left',
      arrowleft: 'Left',
      right: 'Right',
      arrowright: 'Right',
      space: 'Space',
      home: 'Home',
      end: 'End',
      pgup: 'PageUp',
      'page up': 'PageUp',
      pageup: 'PageUp',
      pgdn: 'PageDown',
      pgdown: 'PageDown',
      'page down': 'PageDown',
      pagedown: 'PageDown',
      insert: 'Insert',
      ins: 'Insert',
      printscreen: 'PrintScreen',
      prtsc: 'PrintScreen',
      prtscr: 'PrintScreen',
      scrolllock: 'ScrollLock',
      'scroll lock': 'ScrollLock',
      pause: 'Pause',
      break: 'Pause',
      numpadadd: 'NumpadAdd',
      numpadsubtract: 'NumpadSubtract',
      numpadmultiply: 'NumpadMultiply',
      numpaddivide: 'NumpadDivide',
      numpaddecimal: 'NumpadDecimal',
      numpadenter: 'NumpadEnter',
    };
    const lower = key.toLowerCase();
    let keyCode = map[lower] || key;
    if (/^numpad[0-9]$/i.test(keyCode)) keyCode = `Numpad${keyCode.slice(-1)}`;
    if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(keyCode)) keyCode = keyCode.toUpperCase();
    if (keyCode.length === 1) keyCode = keyCode.toUpperCase();
    return {
      keyCode,
      modifiers: Array.from(new Set(modifiers)),
      label: `${modifiers.length ? modifiers.join('+') + '+' : ''}${keyCode}`,
    };
  },

  readHubViewClipboard() {
    if (!this.client) return null;
    const status = document.getElementById('hub-view-status');
    if (status) status.textContent = 'copying desktop selection...';
    const requestId = this.client.sendHubViewInput({
      kind: 'clipboard-read',
      copy: true,
      restore: true,
    }, this.activeHubId);
    if (!requestId && status) status.textContent = 'clipboard read failed';
    return requestId;
  },

  writeHubViewClipboard(text) {
    if (!this.client) return null;
    const value = String(text || '').slice(0, 20000);
    const status = document.getElementById('hub-view-status');
    if (!value) {
      if (status) status.textContent = 'empty clipboard skipped';
      return null;
    }
    if (status) status.textContent = `setting desktop clipboard (${value.length} chars)...`;
    const requestId = this.client.sendHubViewInput({
      kind: 'clipboard-write',
      text: value,
    }, this.activeHubId);
    if (!requestId && status) status.textContent = 'clipboard write failed';
    return requestId;
  },

  async setHubViewClipboardFromLocal() {
    let text = '';
    try {
      if (navigator.clipboard && window.isSecureContext) {
        text = await navigator.clipboard.readText();
      }
    } catch (_) {}
    if (!text) {
      text = window.prompt('Set desktop clipboard text', '') || '';
    }
    return this.writeHubViewClipboard(text);
  },

  pasteHubViewText(text) {
    const value = String(text || '').slice(0, 20000);
    const status = document.getElementById('hub-view-status');
    if (!value) {
      if (status) status.textContent = 'empty paste skipped';
      return null;
    }
    const requestId = this.writeHubViewClipboard(value);
    if (!requestId) return null;
    setTimeout(() => {
      const overlay = document.getElementById('hub-view-overlay');
      if (!overlay) return;
      this.sendHubViewKey('Ctrl+V');
    }, 180);
    if (status) status.textContent = `pasting local clipboard (${value.length} chars)...`;
    return requestId;
  },

  pickHubViewFile() {
    const input = document.getElementById('hub-view-file-input');
    if (!input) return;
    input.value = '';
    input.click();
  },

  _setHubViewDropActive(active, e = null) {
    if (e && e.preventDefault) e.preventDefault();
    if (e && e.stopPropagation) e.stopPropagation();
    const overlay = document.getElementById('hub-view-overlay');
    if (overlay) overlay.classList.toggle('hv-drop-active', !!active);
  },

  _handleHubViewDragOver(e) {
    this._setHubViewDropActive(true, e);
    if (e && e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  },

  _handleHubViewDrop(e) {
    this._setHubViewDropActive(false, e);
    const file = e && e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    const status = document.getElementById('hub-view-status');
    if (!file) {
      if (status) status.textContent = 'drop has no file';
      return null;
    }
    return this.sendHubViewFile(file);
  },

  async sendHubViewFile(file) {
    const status = document.getElementById('hub-view-status');
    if (!this.client || !file) return null;
    if (file.size > 8 * 1024 * 1024) {
      if (status) status.textContent = 'file too large (8MB max)';
      return null;
    }
    try {
      if (status) status.textContent = `sending file ${file.name || 'upload'}...`;
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
      }
      const requestId = this.client.sendHubViewInput({
        kind: 'file-transfer',
        name: file.name || 'upload.bin',
        mimeType: file.type || 'application/octet-stream',
        size: file.size || bytes.length,
        dataBase64: btoa(binary),
        pastePath: true,
      }, this.activeHubId);
      if (!requestId && status) status.textContent = 'file send failed';
      return requestId;
    } catch (e) {
      if (status) status.textContent = `file send failed: ${e && e.message || 'unknown'}`;
      return null;
    }
  },

  _writeLocalClipboard(text) {
    const value = String(text || '');
    if (!value) return Promise.resolve(false);
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(value).then(() => true).catch(() => false);
    }
    return Promise.resolve(false);
  },

  onHubViewInputAck(msg) {
    const overlay = document.getElementById('hub-view-overlay');
    if (!overlay) return;
    const status = overlay.querySelector('#hub-view-status');
    if (!msg || !msg.ok) {
      if (status) status.textContent = `input failed: ${msg && (msg.error || msg.code) || 'unknown'}`;
      return;
    }
    if (msg.result && msg.result.kind === 'mouse-move') return;
    if (status) status.textContent = 'input applied · refreshing...';
    this._armHubViewFastFrames(msg.result && msg.result.kind || 'input');
    if (msg.result && msg.result.kind === 'clipboard-read') {
      const text = msg.result.text || '';
      this._writeLocalClipboard(text).then((ok) => {
        const s = document.getElementById('hub-view-status');
        if (s) s.textContent = ok
          ? `desktop clipboard copied (${text.length} chars)`
          : `desktop clipboard: ${text.length} chars`;
      });
      return;
    }
    if (msg.result && msg.result.kind === 'clipboard-write') {
      if (status) status.textContent = `desktop clipboard set (${msg.result.length || 0} chars)`;
      return;
    }
    if (msg.result && msg.result.kind === 'file-transfer') {
      const filePath = msg.result.path || '';
      this._writeLocalClipboard(filePath).then((ok) => {
        const s = document.getElementById('hub-view-status');
        const kb = Math.max(1, Math.round((Number(msg.result.size) || 0) / 1024));
        if (s) s.textContent = ok
          ? `file saved and path copied (${kb}KB)`
          : `file saved (${kb}KB)`;
      });
      this._boostHubViewFrame(45);
      return;
    }
    this._boostHubViewFrame(0);
  },

  showArtifactHistory() {
    if (!this.client) return;
    let overlay = document.getElementById('artifact-history');
    if (overlay) overlay.remove();
    overlay = document.createElement('div');
    overlay.id = 'artifact-history';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-height:75vh;display:flex;flex-direction:column">
        <div class="modal-title">📂 历史 HTML Artifact</div>
        <div id="art-list-body" style="flex:1;overflow-y:auto;max-height:55vh;margin-bottom:10px">
          <div style="text-align:center;color:var(--ink-mute);padding:32px;font-size:13px">
            <div class="af-spinner"></div>
            <div style="margin-top:14px">加载中...</div>
          </div>
        </div>
        <button class="modal-cancel">关闭</button>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('.modal-cancel').addEventListener('click', () => overlay.remove());
    this.client.requestArtifactList(50, this.activeHubId);
  },

  onArtifactList(msg) {
    const overlay = document.getElementById('artifact-history');
    if (!overlay) return;
    const body = overlay.querySelector('#art-list-body');
    if (!body) return;
    const items = msg.items || [];
    if (items.length === 0) {
      body.innerHTML = `<div style="text-align:center;color:var(--ink-mute);padding:32px;font-size:13px">还没有 HTML artifact<div style="font-size:11px;margin-top:8px">让 Claude 生成的 .html 文件会出现在这里</div></div>`;
      return;
    }
    body.innerHTML = items.map(it => {
      const time = this._fmtRelativeTime(it.mtimeMs);
      const sizeKb = (it.size / 1024).toFixed(1);
      return `<div class="art-item" data-path="${this._esc(it.path)}">
        <div class="art-icon">📄</div>
        <div class="art-text">
          <div class="art-name">${this._esc(it.name)}</div>
          <div class="art-meta">${time} · ${sizeKb} KB</div>
        </div>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="color:var(--ink-mute)"><polyline points="9 18 15 12 9 6"/></svg>
      </div>`;
    }).join('');
    body.querySelectorAll('.art-item').forEach(el => {
      el.addEventListener('click', () => {
        const path = el.dataset.path;
        overlay.remove();
        this.openArtifact(path);
      });
    });
  },

  _fmtRelativeTime(ms) {
    const now = Date.now();
    const diff = now - ms;
    if (diff < 60_000) return '刚刚';
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
    if (diff < 7 * 86400_000) return `${Math.floor(diff / 86400_000)} 天前`;
    const d = new Date(ms);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  },

  _showArtifactError(filePath, error) {
    let overlay = document.getElementById('artifact-overlay');
    if (!overlay) return;
    const msgMap = {
      'path_invalid': '路径无效',
      'path_outside_whitelist': '路径不在白名单（仅 Desktop/claude-artifacts/）',
      'ext_not_allowed': '文件类型不支持',
      'file_not_found': '文件不存在',
      'too_large': '文件超过 5MB 上限',
      'timeout': 'Hub 30 秒内未响应',
    };
    const msg = msgMap[error] || error || '未知错误';
    overlay.innerHTML = `
      <div class="af-bar">
        <button class="nav-back" aria-label="close">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div class="af-bar-title">
          <div class="t">无法预览</div>
          <div class="s">${this._esc(error)}</div>
        </div>
        <div style="width:36px"></div>
      </div>
      <div class="af-frame" style="display:flex;align-items:center;justify-content:center;flex-direction:column;color:var(--ink-soft);padding:32px;text-align:center">
        <div style="font-size:40px;margin-bottom:14px">📄</div>
        <div style="font-size:17px;font-weight:600;color:var(--ink);margin-bottom:6px">${this._esc(msg)}</div>
        <div style="font-size:12px;color:var(--ink-mute);max-width:280px;word-break:break-all;margin-top:14px">${this._esc(filePath)}</div>
      </div>`;
    overlay.querySelector('.nav-back').addEventListener('click', () => overlay.remove());
  },

  _renderTool(tc) {
    const d = document.createElement('details');
    d.className = 'tool';
    const cmd = tc.cmd ? `<span class="cmd">${this._esc(String(tc.cmd).slice(0, 100))}</span>` : '';
    d.innerHTML = `
      <summary>
        <span class="chev">▶</span>
        <span class="name">${this._esc(tc.name || '?')}</span>
        ${cmd}
      </summary>
      ${tc.result ? `<pre>${this._esc(String(tc.result).slice(0, 5000))}</pre>` : ''}`;
    return d;
  },

  // sid 指定该卡片归属于哪个 session（默认 active）。卡片永远存到 sessionCards[sid]
  // 持久缓存；只有 sid === activeSessionId 时才挂到可见 stream DOM。
  // 非 active session 收到新卡片 → 累加 unread，drawer 刷新角标。
  // fromIDB=true：历史回放，不更 unread / 不弹 toast / 不挂 DOM（由 switchSession 用 frag 一次性挂）
  // T10：seq 给 hydration dedup；ts 给冷启动 race 排序，避免 user 本地 seq 与 Hub seq 错序
  _appendCard(el, sid, fromIDB, seq, ts) {
    const targetSid = sid || this.activeSessionId || DEFAULT_SESSION_ID;
    if (!this.sessionCards.has(targetSid)) this.sessionCards.set(targetSid, []);
    if (!this.sessionSeqs) this.sessionSeqs = new Map();
    if (!this.sessionSeqs.has(targetSid)) this.sessionSeqs.set(targetSid, new Set());
    // dedup：seq 已存在（live turn 和 IDB 回填撞）→ 丢弃这次
    if (typeof seq === 'number' && this.sessionSeqs.get(targetSid).has(seq)) return;
    if (typeof seq === 'number') {
      this.sessionSeqs.get(targetSid).add(seq);
      try { el.dataset.seq = String(seq); } catch (_) {}
    }
    if (typeof ts === 'number') {
      try { el.dataset.ts = String(ts); } catch (_) {}
    }
    this.sessionCards.get(targetSid).push(el);
    if (fromIDB) return; // 历史回放：caller 已用 DocumentFragment 批量挂载，跳过 unread/toast
    if (targetSid === this.activeSessionId) {
      const stream = document.getElementById('stream');
      stream.appendChild(el);
      requestAnimationFrame(() => { stream.scrollTop = stream.scrollHeight; });
    } else {
      this.sessionUnread.set(targetSid, (this.sessionUnread.get(targetSid) || 0) + 1);
      this._renderDrawerList();
      // 顶栏小 toast 提示，避免用户错过
      const s = (this.sessions || []).find(x => x.id === targetSid);
      this.toast(`「${s?.title || '其他会话'}」收到新消息`);
    }
  },

  _esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },
  _mdLite(s) {
    let h = this._esc(s);
    h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
    h = h.split(/\n\n+/).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
    return h;
  },
  _fmtTime(ts) {
    if (!ts) ts = Date.now();
    const d = new Date(ts);
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    return `${h}:${m}`;
  },

  confirmNewSession() {
    // MVP: 用 confirm。V1+ 用 modal 替代
    if (!confirm('开始新对话？\n当前历史会被归档，Claude 上下文清空。')) return;
    // 清空 UI 流
    document.getElementById('stream').innerHTML = '<div class="tsline" id="empty-hint">向 Claude 发第一条消息…</div>';
    // 通知 Hub 端开启新会话（MVP 简化：发个特殊指令；V1+ 走专门的 control 消息）
    if (this.client) this.client.send('/__hub_new_session__');
    localStorage.setItem(STORAGE.LAST_SEQ, '0');
    this.toast('已开启新对话');
  },
  showSettings() {
    // MVP: 仅显示 token 末尾 + "退出登录"。V1+ 做完整设置面板
    const token = localStorage.getItem(STORAGE.DEVICE_TOKEN) || '';
    const tail = token ? '…' + token.slice(-8) : '未配对';
    if (confirm(`设备 token: ${tail}\n\n退出登录？（会清空本机配对，需重新输入 PIN）`)) {
      localStorage.removeItem(STORAGE.DEVICE_TOKEN);
      localStorage.removeItem(STORAGE.LAST_SEQ);
      localStorage.removeItem(STORAGE.QUEUE);
      if (this.client) this.client.disconnect('logout');
      this.client = null;
      this.showPairing();
    }
  },

  _switchView(id) {
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('on', v.id === id));
    this._syncDesktopDrawerMode();
  },

  toast(text, ms = 2200) {
    const t = document.getElementById('toast');
    t.textContent = text;
    t.classList.add('on');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('on'), ms);
  },
};

document.addEventListener('DOMContentLoaded', () => {
  ui.init();
  window.__hubApp = ui;
  window.ui = ui;
  // dev debug 入口：允许外部脚本（Playwright/CDP）操作 ui 状态
  window.__hubApp = ui;
});
