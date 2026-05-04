'use strict';
// 圆桌 CLI ready 判定（2026-05-03 道雪精测重构）
//
// 抽离动机：原 cli-ready 判定逻辑内联在 main.js 中，但本质是圆桌专属功能
//   （非圆桌会话不需要"启动期检测"），混在 main.js 里跟其他 IPC/启动逻辑纠缠。
//   独立模块后 main.js 只管 IPC 转发 + sessionManager 桥接。
//
// 判定模型（双门 + monotonic guard）：
//   - 必要条件 1：PTY buffer 末尾含 kind 对应的 marker 字符串
//     （Claude Code 输入框就绪后才出现的状态栏字串如 'shift+tab'）
//   - 必要条件 2：PTY buffer 总长 ≥ MIN_BUF_LEN，且连续 STABLE_MS 无新增
//     （TUI 屏幕真稳定，OAuth/初始化已完成）
//   - 一旦判 true → 加入 onceTrue Set 永久锁，防 PTY 心跳/光标重绘触发回退
//
// 详见 docs/superpowers/specs/2026-05-03-roundtable-3claude-debug-design.md §3 Bug #1-#3

// kind → marker 字符串数组。空数组表示 "无 marker，仅靠 buffer 静默兜底"。
const MARKERS = {
  // Claude Code TUI 输入框就绪后状态栏稳定含 'shift+tab to cycle' 字符串
  claude: ['shift+tab'],
  gemini: ['Type your message', 'YOLO', 'gemini-'],
  codex: ['gpt-5.5', 'gpt-5.4', 'Context 100%', 'send'],
  // GLM/DeepSeek/GPT/Kimi/Qwen 都跑在 claude CLI 上（CLAUDE_CONFIG_DIR 隔离） — 复用 Claude marker
  glm: ['shift+tab'],
  deepseek: ['shift+tab'],
  gpt: ['shift+tab'],
  kimi: ['shift+tab'],
  qwen: ['shift+tab'],
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
//   非圆桌可参与 kind（powershell 等）：默认 ready
//   _STRONG_MARKER_KINDS 含 marker → marker 命中 + buf ≥ MIN 即 ready（无静默期）
//   其他 kind 含 marker → marker 命中 + 静默期双门
//   不含 marker（空数组）→ 仅静默期
function isReady(sessionId, kind, buf) {
  if (!sessionId) return false;
  if (_onceTrue.has(sessionId)) return true;
  const need = MARKERS[kind];
  if (!need) return true; // 未注册 kind（如 powershell）默认 ready
  buf = buf || '';
  const markerHit = need.length > 0 && need.some(m => buf.includes(m));
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

// markReady(sessionId) — 外部强制锁（如 sessionManager.getRoundtableReady 已 true 时）
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
  MIN_BUF_LEN,
  STABLE_MS,
};
