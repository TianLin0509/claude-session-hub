'use strict';
// 群聊 CLI ready 判定（2026-05-03 道雪精测重构）
//
// 抽离动机：原 cli-ready 判定逻辑内联在 main.js 中，但本质是群聊专属功能
//   （非群聊会话不需要"启动期检测"），混在 main.js 里跟其他 IPC/启动逻辑纠缠。
//   独立模块后 main.js 只管 IPC 转发 + sessionManager 桥接。
//
// 判定模型（双门 + monotonic guard）：
//   - 必要条件 1：PTY buffer 末尾含 kind 对应的 marker 字符串
//     （Claude Code 输入框就绪后才出现的状态栏字串如 'shift+tab'）
//   - 必要条件 2：PTY buffer 总长 ≥ MIN_BUF_LEN，且连续 STABLE_MS 无新增
//     （TUI 屏幕真稳定，OAuth/初始化已完成）
//   - 一旦判 true → 加入 onceTrue Set 永久锁，防 PTY 心跳/光标重绘触发回退
//
// Historical 3-Claude debug design notes were removed during slimdown.

// kind → marker 字符串数组。空数组表示 "无 marker，仅靠 buffer 静默兜底"。
const MARKERS = {
  // Claude Code TUI 输入框就绪后状态栏稳定含 'shift+tab to cycle' 字符串
  // Newer Claude-family TUI can render
  // "? for shortcuts" without the old shift+tab footer in the ring buffer.
  claude: ['shift+tab', '? for shortcuts', 'bypass permissions', 'Try "edit'],
  gemini: ['Type your message', 'YOLO', 'gemini-'],
  // Do not use model ids such as "gpt-5.6-sol" here: the PowerShell launch
  // command itself contains "--model gpt-5.6-sol", which can falsely mark Codex
  // ready before the TUI input box exists.
  codex: ['Context '],
  deepseek: ['shift+tab', '? for shortcuts', 'bypass permissions', 'Try "edit'],
  // Kimi Code 官方 TUI 状态栏稳定显示小写 `context:`。不能设为强 marker：
  // 未登录启动也会短暂渲染状态栏，随后才显示 OAuth login expired。
  kimi: ['context:'],
};

const BLOCKERS = {
  codex: [/Do you trust the contents of this directory/i, /Booting MCP server/i, /esc to interrupt/i],
  kimi: [
    /OAuth login expired/i,
    /No active session\. Send \/login to login/i,
    /requires login/i,
    /Run \/login or \/provider to get started/i,
    /Model:\s+not set/i,
  ],
};

// 可以「过期」的阻断词：它们描述的是**瞬态**——启动中、正在跑，会自己结束。
// PTY 是追加流、清屏只是控制序列，所以这两句会永远留在 buffer 里；
// 一旦输入框标记出现在它们之后，就说明那一段已经被新画面盖掉了，不该再算数。
//
// 其余阻断词（Kimi 未登录、Codex 的信任弹窗）是**终态**：它们不会自己好，
// 而且登录页上本来就同时渲染着状态栏 marker —— 用「谁更新」判会直接放行，所以不许过期。
const STALEABLE_BLOCKERS = {
  codex: [/Booting MCP server/i, /esc to interrupt/i],
};

const MIN_BUF_LEN = 500;
const STABLE_MS = 1500;

// 2026-05-04 gemini-equiv Bug 1 修复：强 marker kind 跳过静默期。
//   gemini 0.40.1 Ink TUI 在 PTY 下持续重渲染（spinner / cursor blink / token 计数刷新），
//   buffer 长度持续变化 → 永远不进入 STABLE_MS 静默 → 卡片永久卡"创建中"。
//   gemini 的 marker（'Type your message' / 'YOLO' / 'gemini-'）只在主输入框就绪后
//   才出现，是已 ready 的强信号；命中即应判 ready，不强制静默期。
//   claude/codex 的 marker 较 generic（'shift+tab' / 'send'）容易在加载阶段假命中，
//   仍保留静默期保护。
const _STRONG_MARKER_KINDS = new Set(['gemini']);

const _stableState = new Map(); // sid → { lastBufLen, lastChangeTs }
const _onceTrue = new Set();    // sid → 一旦 true 永久锁

// isReady(sessionId, kind, buf) → boolean
//   非群聊可参与 kind（powershell 等）：默认 ready
//   _STRONG_MARKER_KINDS 含 marker → marker 命中 + buf ≥ MIN 即 ready（无静默期）
//   其他 kind 含 marker → marker 命中 + 静默期双门
//   不含 marker（空数组）→ 仅静默期
function isReady(sessionId, kind, buf) {
  if (!sessionId) return false;
  if (_onceTrue.has(sessionId)) return true;
  const need = MARKERS[kind];
  if (!need) return true; // 未注册 kind（如 powershell）默认 ready
  buf = buf || '';
  const blockers = BLOCKERS[kind] || [];
  // 2026-09-08：PTY 是**追加**的字节流，清屏只是一个控制序列 —— 早先那句
  // `Booting MCP server` / `esc to interrupt` 会一直留在 buffer 里。原来按
  // 「末尾 2000 字里出现过就拦」判，于是缓冲短一点时 Codex 被永久判成未就绪，
  // 真实开题连着两次 cli_not_ready（合并位在真实链路上复现）。
  //
  // 现在分两类：瞬态阻断词（见 STALEABLE_BLOCKERS）在输入框标记出现之后就算过期；
  // 终态阻断词（未登录、信任弹窗）一律拦到底。
  const staleable = STALEABLE_BLOCKERS[kind] || [];
  const absolute = blockers.filter(re => !staleable.some(x => x.source === re.source));
  const markerAt = need.length > 0 ? _lastIncludesIndex(buf, need) : -1;
  const absoluteAt = _lastMatchIndex(buf, absolute);
  const staleableAt = _lastMatchIndex(buf, staleable);
  const staleableIsLive = staleableAt >= 0 && !(markerAt > staleableAt);
  if (absoluteAt >= 0 || staleableIsLive) {
    _stableState.delete(sessionId);
    return false;
  }
  const markerHit = markerAt >= 0;
  const noMarker = need.length === 0;
  if (!(markerHit || noMarker)) return false;
  if (buf.length < MIN_BUF_LEN) return false;
  // gemini 强信号 marker fast-path：marker 命中 + buf ≥ MIN 立即 ready
  if (markerHit && _STRONG_MARKER_KINDS.has(kind)) {
    _onceTrue.add(sessionId);
    return true;
  }
  let st = _stableState.get(sessionId);
  if (!st) {
    _stableState.set(sessionId, { lastBufLen: buf.length, lastChangeTs: Date.now() });
    return false;
  }
  if (buf.length === st.lastBufLen) {
    const ready = (Date.now() - st.lastChangeTs) >= STABLE_MS;
    if (ready) _onceTrue.add(sessionId);
    return ready;
  } else {
    st.lastBufLen = buf.length;
    st.lastChangeTs = Date.now();
    return false;
  }
}

/** 这些正则里，最后一次匹配落在哪个位置；一个都不匹配返回 -1。 */
function _lastMatchIndex(buf, regexes) {
  let last = -1;
  for (const re of regexes) {
    const scan = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let hit = null;
    // eslint-disable-next-line no-cond-assign
    while ((hit = scan.exec(buf)) !== null) {
      last = Math.max(last, hit.index);
      if (hit.index === scan.lastIndex) scan.lastIndex += 1;   // 防零宽匹配死循环
    }
  }
  return last;
}

/** 这些固定字串里，最后一次出现落在哪个位置；一个都没有返回 -1。 */
function _lastIncludesIndex(buf, needles) {
  let last = -1;
  for (const needle of needles) last = Math.max(last, buf.lastIndexOf(needle));
  return last;
}

// markReady(sessionId) — 外部强制锁（如 sessionManager.getGroupChatReady 已 true 时）
function markReady(sessionId) {
  if (sessionId) {
    _stableState.delete(sessionId);
    _onceTrue.add(sessionId);
  }
}

// cleanup(sessionId) — sub session 关闭/relaunch 时调，下次新建同 sid 从零判定
function cleanup(sessionId) {
  _stableState.delete(sessionId);
  _onceTrue.delete(sessionId);
}

module.exports = {
  isReady,
  markReady,
  cleanup,
  MARKERS,
  BLOCKERS,
  STALEABLE_BLOCKERS,
  MIN_BUF_LEN,
  STABLE_MS,
};
