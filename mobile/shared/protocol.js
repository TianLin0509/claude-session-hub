'use strict';

// 协议消息类型 — Hub ↔ VPS ↔ PWA 三方共享。
// 为啥放在 shared 而不是 hub-bridge：vps-gateway 也要用，避免常量散落两份。
// PWA 端是浏览器 <script> 加载，会重复定义一份（见 pwa/app.js 顶部），
// 改协议时两份必须同步——后续若 PWA 走 build 工具可统一来源。

const MSG = Object.freeze({
  // 三方通用
  HELLO: 'hello',
  PING: 'ping',
  PONG: 'pong',
  ERROR: 'error',

  // Hub → VPS → PWA
  TURN: 'turn',                     // 一次 assistant turn 完成（含工具调用 + 文本）
  TURN_DELTA: 'turn-delta',         // 流式 delta（V1+ 才用，MVP 不用）
  PAIR_RESULT: 'pair-result',       // Hub 返回的 PIN 校验结果

  // PWA → VPS → Hub
  PWA_INPUT: 'input',               // PWA 用户发送的文本输入（含 sessionId）
  PAIR_REQUEST: 'pair-request',     // VPS 转发 PWA 提交的 PIN
  NEW_SESSION: 'new-session',       // PWA 请求新建 mobile session（含 kind）
  DESTROY_SESSION: 'destroy-session', // PWA 请求关闭 session
  LIST_SESSIONS: 'list-sessions',   // PWA 请求当前 mobile session 列表
  RENAME_SESSION: 'rename-session', // PWA → Hub: { sessionId, title } 改 mobile-sessions.json title
  PIN_SESSION: 'pin-session',       // PWA → Hub: { sessionId, pinned } 改 mobile-sessions.json pinned

  // Hub → VPS → PWA
  SESSION_CREATED: 'session-created',   // 新 session 创建成功，含 id / kind / title
  SESSION_DESTROYED: 'session-destroyed',
  SESSION_LIST: 'session-list',         // mobile sessions 元数据数组

  // AI Hub MVP：同步桌面 Hub 的真实 session / meeting 卡片，并允许手机定向投递 prompt。
  // 这条链路和 mobile sessions 并行：mobile sessions 仍用于“手机自己的会话”，
  // desktop snapshot 则用于“手机查看/控制电脑 Hub 当前卡片”。
  HUB_SNAPSHOT_REQUEST: 'hub-snapshot-req', // PWA → Hub: { requestId }
  HUB_SNAPSHOT: 'hub-snapshot',             // Hub → PWA: { requestId, snapshot }
  HUB_DELTA: 'hub-delta',                   // Hub → PWA: { op, card?, turn?, seq }
  HUB_COMMAND: 'hub-command',               // PWA → Hub: { clientId, targetType, targetId, content }
  COMMAND_ACK: 'command-ack',               // Hub → PWA: { clientId, ok, queued?, error? }
  HUB_VIEW_REQUEST: 'hub-view-req',         // PWA → Hub: { requestId, maxWidth? }
  HUB_VIEW_FRAME: 'hub-view-frame',         // Hub → PWA: { requestId, ok, imageBase64, mimeType, width, height }
  HUB_VIEW_SUBSCRIBE: 'hub-view-sub',       // PWA -> Hub: { requestId, maxWidth?, delayMs? }
  HUB_VIEW_UNSUBSCRIBE: 'hub-view-unsub',   // PWA -> Hub: { requestId? }
  HUB_VIEW_INPUT: 'hub-view-input',         // PWA → Hub: { requestId, input: { kind, x, y, width, height } }
  HUB_VIEW_INPUT_ACK: 'hub-view-input-ack', // Hub → PWA: { requestId, ok, error? }

  // PTY remote mirror：PWA 像远程桌面一样订阅桌面 Hub 真实终端字节流。
  PTY_SUBSCRIBE: 'pty-subscribe',     // PWA → Hub: { sessionId, sinceSeq? }
  PTY_UNSUBSCRIBE: 'pty-unsubscribe', // PWA → Hub: { sessionId }
  PTY_SNAPSHOT: 'pty-snapshot',       // Hub → PWA: { sessionId, seq, dataB64, truncated? }
  PTY_DATA: 'pty-data',               // Hub → PWA: { sessionId, seq, dataB64 }
  PTY_INPUT: 'pty-input',             // PWA → Hub: { sessionId, dataB64 }
  PTY_RESIZE: 'pty-resize',           // PWA → Hub: { sessionId, cols, rows }
  PTY_ACK: 'pty-ack',                 // Hub → PWA: { sessionId, ok, action, error? }

  // PWA → Hub: 请求拉取本地 artifact 文件（HTML 预览）
  ARTIFACT_FETCH: 'artifact-fetch',     // { path, requestId }
  // Hub → PWA: 返回 artifact 内容
  ARTIFACT_CONTENT: 'artifact-content', // { requestId, path, contentBase64, mimeType, size }
  ARTIFACT_ERROR: 'artifact-error',     // { requestId, path, error }
  // PWA → Hub: 列出最近 artifact（历史浏览面板）
  ARTIFACT_LIST_REQUEST: 'artifact-list-req',  // { requestId, limit? }
  // Hub → PWA: 返回历史列表 [{ name, path, mtimeMs, size }]
  ARTIFACT_LIST: 'artifact-list',              // { requestId, items }
  // P3: 群聊（meeting / multi-AI）
  NEW_MEETING: 'new-meeting',             // PWA → Hub: { kind: 'general'|'research'|'dev', title?, members?: [{kind, model}] }
  MEETING_CREATED: 'meeting-created',     // Hub → PWA: { meeting: { id, title, scene, subSessions: [...] } }
  LIST_MEETINGS: 'list-meetings',         // PWA → Hub
  MEETING_LIST: 'meeting-list',           // Hub → PWA: { meetings: [...] }

  // Multi-hub: PWA 端可选 hub。消息含 hubId 字段指定路由目标 hub
  LIST_HUBS: 'list-hubs',                 // PWA → VPS gateway: { requestId }
  HUB_LIST: 'hub-list',                   // VPS → PWA: { requestId, hubs: [{hubId, pid, hostname, version, startedAt, friendlyName, connectedAt, isLegacy}] }

  // T11 Web Push：PWA 后台/锁屏时通过 OS 通知告知 "Claude 回了"
  // 走 VAPID + Push Service（Firefox/Chrome/Safari iOS16.4+ standalone）
  // PWA → Hub: 上报 push subscription，Hub 端 sendNotification 时用
  REGISTER_PUSH_SUB: 'register-push-sub', // { sub: { endpoint, keys: { p256dh, auth } }, ua? }
  PUSH_SUB_ACK: 'push-sub-ack',           // Hub → PWA: { ok, error? }

  // VPS → PWA
  CONN_STATE: 'conn-state',         // 连接状态变化（hub 离线/恢复）
});

const ERR = Object.freeze({
  INVALID_TOKEN: 'invalid_token',
  INVALID_PIN: 'invalid_pin',
  PIN_EXPIRED: 'pin_expired',
  PIN_LOCKED: 'pin_locked',
  AGENT_OFFLINE: 'agent_offline',
  RATE_LIMITED: 'rate_limited',
  BAD_PAYLOAD: 'bad_payload',
  HUB_TIMEOUT: 'hub_timeout',
});

const CONN = Object.freeze({
  OK: 'ok',
  WEAK: 'weak',
  HUB_OFF: 'hub-off',
  VPS_OFF: 'vps-off',
});

module.exports = { MSG, ERR, CONN };
