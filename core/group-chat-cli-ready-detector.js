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

// BLOCKERS 条目两种写法：
//   RegExp                      → 老语义：只要出现在 tail 窗口里就判"未就绪"
//   { re, transient: true }     → 瞬时进度行（2026-07-29 道雪 B3 修复）
//
// 为什么需要 transient（真实取证，artifacts/codex-ready-verdict.json）：
//   Codex 冷启动会打一行
//       • Booting MCP server: ai-team (0s • esc to interrupt)
//   这一行同时命中 /Booting MCP server/ 和 /esc to interrupt/ 两条 blocker。MCP 起完之后
//   Codex 只重绘输入框 + 页脚，那行**留在 ring buffer 里不再被冲走**；PTY 随后彻底静默
//   （实测 bufLen 4961 连续 230s 一个字节都不变）。于是 `buf.slice(-2000)` 窗口里永远
//   命中 blocker → isReady 永远 false → 群聊发送阶段等满 60s 后放弃，Codex 被静默跳过。
//
//   实测位置证据：ready 页脚 marker 'Context ' 最后一次出现在 idx=4529，
//   两条 blocker 最后一次出现在 idx=3117 / 3160 —— 页脚是在 blocker **之后**重绘的，
//   说明那行早就是历史残留。所以瞬时进度行的判定必须带"之后有没有再重绘就绪页脚"，
//   而不是无脑扫最近 2000 字符。
//
//   注意不能一刀切把 transient blocker 删掉：codex 真在干活时也打 `esc to interrupt`。
//   但那种情况下秒级刷新的计时器会让 buffer 一直变长，第二道门（STABLE_MS 静默期）
//   自然拦得住 —— 真正只能靠 blocker 拦的是"静止不动的模态框"（trust dialog / OAuth 过期
//   横幅），那些保持老语义。
const BLOCKERS = {
  codex: [
    /Do you trust the contents of this directory/i,
    { re: /Booting MCP server/i, transient: true },
    { re: /esc to interrupt/i, transient: true },
  ],
  kimi: [
    /OAuth login expired/i,
    /No active session\. Send \/login to login/i,
    /requires login/i,
    /Run \/login or \/provider to get started/i,
    /Model:\s+not set/i,
  ],
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

// 末次匹配下标（-1 = 未命中）。RegExp 可能带/不带 g，这里统一新建一个带 g 的副本，
//   避免复用调用方正则的 lastIndex 状态（那是经典的隐蔽 bug 源）。
function _lastMatchIndex(str, re) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m; let last = -1;
  while ((m = g.exec(str)) !== null) {
    last = m.index;
    if (m.index === g.lastIndex) g.lastIndex += 1;   // 防零宽匹配死循环
  }
  return last;
}

// 就绪 marker 在整个 buffer 里最后一次出现的下标（-1 = 从未出现）。
function _lastMarkerIndex(buf, need) {
  let last = -1;
  for (const m of need) {
    const idx = buf.lastIndexOf(m);
    if (idx > last) last = idx;
  }
  return last;
}

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
  const tail = buf.slice(-2000);
  const tailOffset = buf.length - tail.length;
  const blockers = BLOCKERS[kind] || [];
  const markerLastIdx = _lastMarkerIndex(buf, need);
  for (const entry of blockers) {
    const re = (entry && entry.re) ? entry.re : entry;
    const isTransient = !!(entry && entry.transient);
    const hitIdx = _lastMatchIndex(tail, re);
    if (hitIdx < 0) continue;
    // 瞬时进度行：就绪页脚在它之后重绘过 → 它已经是 ring buffer 里的历史残留，不再有效。
    //   （真正还在忙时，秒级刷新的计时器会让下面的静默期门自然拦住。）
    if (isTransient && markerLastIdx > tailOffset + hitIdx) continue;
    _stableState.delete(sessionId);
    return false;
  }
  const markerHit = need.length > 0 && markerLastIdx >= 0;
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
  MIN_BUF_LEN,
  STABLE_MS,
};
