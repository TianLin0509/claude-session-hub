const { ipcRenderer, clipboard, nativeImage, shell, webFrame } = require('electron');
const fs = require('fs');
const path = require('path');
const { isClaudeFamily, isAiKind, isPasteSensitive, isCodexSessionKind: isCodexKind, isKimiCliKind } = require('../core/ai-kinds.js');
const { buildSessionResumeMeta, supportsForkSession } = require('../core/session-capabilities.js');
const { formatAbsoluteTime } = require('./format-time.js');
const { marked } = require('marked');
const DOMPurify = require('dompurify');
const { fileURLToPath } = require('url');
const { extractVisibleCardText } = require('./visible-card-text.js');
const { applyCardDisplaySettings } = require('./card-display-settings.js');
const {
  GC_WORKING_FRESH_MS,
  isGroupChatMemberRunning,
} = require('../core/groupchat-running-state.js');
const applyHubCardDisplaySettings = (config) => applyCardDisplaySettings(document, config);
applyHubCardDisplaySettings();
ipcRenderer.invoke('get-hub-config-raw')
  .then(applyHubCardDisplaySettings)
  .catch(() => {});
// ── Bug 修复（2026-06-21 道雪）：marked 默认透传裸 HTML，AI/用户消息正文里的字面
//    <script>/<style>/未闭合 <tag>（含数学 a<b、泛型 List<String>）会被浏览器 HTML
//    解析器当成元素、把后续内容当作其文本吞掉，再被 DOMPurify 整段删除 → 消息正文
//    静默截断/丢失（群聊真实消息 u4 实测 615 字只剩 152 字，丢 75%）。
//    这里把裸 HTML token 统一转义为可见文本：代码块/粗体/链接/列表等正常 markdown 不受
//    影响，DOMPurify 仍作安全兜底。marked 单例被群聊(meeting-room)、会话卡片
//    (turn-card-renderer)、文件预览共用，一处配置即全覆盖。已用真实 marked+DOMPurify
//    管线做 before/after 实测（tools/_gc_render_test）：修复后内容零丢失。
marked.use({
  renderer: {
    html(token) {
      const raw = typeof token === 'string' ? token : (token && (token.text ?? token.raw)) || '';
      return String(raw)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    },
  },
});
const { installScrollDebug } = require('./scroll-debug.js');
const { createMemoPanel } = require('./memo-panel.js');
const { createTerminalSearch } = require('./terminal-search.js');
const {
  createSessionContextMenuController,
  createTerminalContextMenuController,
  supportsRecoverableSessionKind,
} = require('./context-menus.js');
const { createPathLinkContextMenuController } = require('./path-link-context-menu.js');
const { XTERM_THEMES, createThemeController } = require('./theme-controller.js');
const { createTerminalInputController } = require('./terminal-input-controller.js');
const { createAccountUsageController } = require('./account-usage-controller.js');
const { createMemoryPanel } = require('./memory-panel.js');
const { modelClass, modelShort, createModelUiController } = require('./model-ui.js');
const { createTerminalLinkRegistrar } = require('./terminal-link-provider.js');
const { createPreviewPanelController } = require('./preview-panel-controller.js');
const { createTerminalActivityMonitor } = require('./terminal-activity-monitor.js');
const { classifyTerminalRuntime } = require('../core/terminal-runtime-state.js');
const { createPastSessionModals, collapseDormantNativeDuplicates } = require('./past-session-modals.js');
const { createKeyboardShortcuts } = require('./keyboard-shortcuts.js');
const { createShellController } = require('./shell-controller.js');
const { createHomeWorkbench } = require('./home-workbench.js');
const { createRenderCoalescer } = require('./render-coalescer.js');
const {
  applyPromptSubmitted,
  applyReplyCompleted,
  applyTurnAborted,
  clearSessionAttention,
  markSessionNeedsUserInput,
  normalizeEventTime,
  sessionHasCompletedUnread,
  sessionNeedsUserInput,
} = require('../core/session-attention-state.js');
const {
  PREVIEW_PATH_RE,
  HUB_IMG_PATH_RE,
  collectPathCandidates,
  classifyLocalPathHref,
  _cleanPathCandidate,
  _normalizeLocalPathForOpen,
  _isDirectoryPath,
} = require('./path-candidates.js');
const { modelOptionsFor } = require('../core/model-options.js');
const {
  isStableSessionTitle,
  migrateLegacyBranchSessionMeta,
  normalizeLegacyBranchSessionTitle,
  shouldAcceptExternalSessionTitle,
} = require('../core/session-title-guards.js');
const RENDER_STARTUP_TRACE = process.env.HUB_STARTUP_TRACE === '1';
const RENDER_STARTUP_T0 = performance.now();
function traceRendererStartup(msg) {
  if (!RENDER_STARTUP_TRACE) return;
  console.log(`[renderer-startup +${Math.round(performance.now() - RENDER_STARTUP_T0)}ms] ${msg}`);
}
traceRendererStartup('renderer.js start');
const { Terminal } = require('@xterm/xterm');

// DEBUG ONLY. Toggle in DevTools: __scrollDebug.on() / .off().
installScrollDebug(window, __dirname);

const { FitAddon } = require('@xterm/addon-fit');
const { Unicode11Addon } = require('@xterm/addon-unicode11');
const { SearchAddon } = require('@xterm/addon-search');
const { WebLinksAddon } = require('@xterm/addon-web-links');
const { WebglAddon } = require('@xterm/addon-webgl');
const { CanvasAddon } = require('@xterm/addon-canvas');

// --- Shared transcript patterns ---
// Claude Code's user-input prompt line, e.g. "❯ text", "│ ❯ text │", or "> text".
// Includes ASCII '>' because Claude Code v2.1.119 switched the prompt prefix
// from '❯' to plain '>'. Trade-off: assistant markdown blockquotes ("> ...")
// also match — accepted as a known false-positive (rare in practice; AI_MARKERS_RE
// filters reply lines that contain progress glyphs).
const PROMPT_LINE_RE = /^[\s│╭─╮╰╯]*[❯›>]\s+(.+?)(?:\s*[│╯╰╭╮]+\s*)?$/;
// Just the prompt prefix — no capture group. Used when we only need to skip
// prompt lines rather than parse them.
const PROMPT_PREFIX_RE = /^[\s│╭─╮╰╯]*[❯›>]\s+/;
// Emoji Claude Code uses at the start of an AI-reply block. A safety net: if
// we ever mis-match a user prompt line, this filters out lines that are
// clearly assistant output.
const AI_MARKERS_RE = /[⏺●◉◐◑◒◓◔◕]/;
// --- State ---
const sessions = new Map();
let activeSessionId = null;
let completionNotificationToggle = null;
let systemResourceUsage = null;
let homeWorkbench = null;
// 侧栏常驻显示海外代理 + 国产直连的真实公网出口。
// proxy 仍保留配置值，egress 由 main 进程强制分别经代理/直连探测。
let hubProxyInfo = null;
// 2026-05-24 道雪：DeepSeek 自动命名启用标志。启用时让 DeepSeek 中文标题独占 Claude family
//   session，OSC title（"Greeting in Chinese" 这种 Claude 自带英文摘要）仅作影子记录、不落地。
//   在启动 get-hub-config-raw 回调里根据 cfg.deepseekApiKey 设置。
let _deepseekAutoTitleEnabled = false;
let _cardHistoryHydratedSid = null; // 已完成全量历史卡片加载的 sessionId
const _turnCompleteBackfillTimers = new Map(); // sid -> Promise; in-flight guard 防止并发 backfill (2026-05-24 道雪：原 timer-debounce 改为立即 trigger)
const terminalCache = new Map();
// xterms are created lazily, then live for exactly as long as their live Hub
// sessions. Switching sessions must not dispose a still-running CLI: doing so
// turns ordinary navigation into a snapshot-replay path and can lose the
// authoritative full-screen TUI frame. Dormant/closed sessions already call
// disposeCachedTerminal, so automatic suspend remains the resource boundary.
const TERMINAL_CACHE_POLICY = 'session-lifecycle';
const MAX_PENDING_TERMINAL_BYTES = 64 * 1024;
const terminalInputController = createTerminalInputController({
  document,
  window,
  ipcRenderer,
  clipboard,
  terminalCache,
});
const handlePasteForSession = terminalInputController.handlePasteForSession;
const attachContenteditablePasteImage = terminalInputController.attachContenteditablePasteImage;
const setupImageHover = terminalInputController.setupImageHover;
const getTerminalCoords = terminalInputController.getTerminalCoords;
const getInputLineSelection = terminalInputController.getInputLineSelection;
const deleteInputSelection = terminalInputController.deleteInputSelection;
const floatingInputDrafts = new Map();
const floatingInputPresetDrafts = new Map();
const CODEX_BOTTOM_LOCK_EPSILON = 24;
const CODEX_SCROLL_INTENT_MS = 1500;
const CODEX_PROGRAMMATIC_SCROLL_SUPPRESS_MS = 120;
const AI_PTY_FALLBACK_ARM_MS = 45 * 60 * 1000;
const AI_PTY_FALLBACK_COOLDOWN_MS = 5 * 1000;
const PTY_RUNTIME_SUBMIT_PENDING_MS = 15 * 1000;

function isTranscriptCliKind(kind) {
  return isCodexKind(kind) || isKimiCliKind(kind);
}

function isLegacyDeepSeekSession(session) {
  return !!(session && session.kind === 'deepseek' && session.ccSessionId && !session.codexSid);
}

function isClaudeRuntimeSession(session) {
  return !!(session && (isClaudeFamily(session.kind) || isLegacyDeepSeekSession(session)));
}

function isAiRuntimeSession(session) {
  return !!(session && (
    isAiKind(session.kind)
    || isPasteSensitive(session.kind)
    || isClaudeRuntimeSession(session)
  ));
}

// PTY bytes are a last-resort running signal for AI CLIs. Arm that fallback
// only when Hub has evidence that the user really submitted a prompt; idle TUI
// animations and layout repaints otherwise cannot move a session to 运行中.
function armPtyBurstFallback(sessionId, submittedAt = Date.now()) {
  const session = sessions.get(sessionId);
  if (!isAiRuntimeSession(session)) return;
  const at = Number(submittedAt) || Date.now();
  session._ptyFallbackArmedAt = at;
  session._ptyFallbackArmedUntil = at + AI_PTY_FALLBACK_ARM_MS;
  session._ptyBurstCooldownUntil = 0;
  session._ptyRuntimeSawRunning = false;
  session._ptyRuntimeState = null;
  session._ptyRuntimeReason = null;
  session._ptyRuntimeEvidence = null;
  if (session._ptyRuntimePendingTimer) clearTimeout(session._ptyRuntimePendingTimer);
  session._ptyRuntimePendingTimer = setTimeout(() => {
    session._ptyRuntimePendingTimer = null;
    const latest = sessions.get(sessionId);
    if (!latest || latest !== session || latest.status !== 'running' || latest._ptyRuntimeSawRunning) return;
    if (typeof terminalActivityMonitor !== 'undefined') {
      terminalActivityMonitor.observeRuntimeState(sessionId, Date.now());
    }
  }, PTY_RUNTIME_SUBMIT_PENDING_MS);
}

function disarmPtyBurstFallback(sessionOrId, settledAt = Date.now()) {
  const session = typeof sessionOrId === 'string' ? sessions.get(sessionOrId) : sessionOrId;
  if (!isAiRuntimeSession(session)) return;
  // Delayed transcript/hook delivery may carry an older completion timestamp;
  // cooldown starts when Hub actually observes the transition, not in the past.
  const at = Math.max(Number(settledAt) || 0, Date.now());
  if (session._ptyRuntimePendingTimer) {
    clearTimeout(session._ptyRuntimePendingTimer);
    session._ptyRuntimePendingTimer = null;
  }
  session._ptyFallbackArmedUntil = 0;
  session._ptyFallbackArmedAt = 0;
  session._ptyBurstCooldownUntil = at + AI_PTY_FALLBACK_COOLDOWN_MS;
  session._ptyRuntimeSawRunning = false;
  if (session._ptyRuntimeState === 'running') {
    session._ptyRuntimeState = null;
    session._ptyRuntimeReason = null;
    session._ptyRuntimeEvidence = null;
  }
}

function canUsePtyBurstFallback(session, now = Date.now()) {
  if (!isAiRuntimeSession(session)) return true;
  const at = Number(now) || Date.now();
  return at >= (Number(session._ptyBurstCooldownUntil) || 0)
    && at <= (Number(session._ptyFallbackArmedUntil) || 0);
}

function trackPtyPromptInput(sessionId, data) {
  const session = sessions.get(sessionId);
  if (!isAiRuntimeSession(session)) return;
  const chunk = String(data || '');
  const printable = chunk
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|O.)/g, '')
    .replace(/[\x00-\x1f\x7f]/g, '');
  if (printable.trim()) session._ptyDraftInputSeen = true;
  // Newlines inside a bracketed/multiline paste are draft content, not the
  // user's submit key. xterm emits the actual Enter key as its own CR/LF chunk.
  if (/^(?:\r|\n|\r\n)$/.test(chunk)) {
    if (session._ptyDraftInputSeen) armPtyBurstFallback(sessionId);
    session._ptyDraftInputSeen = false;
  }
}

function readContenteditablePlainText(el) {
  if (!el) return '';
  return typeof el.innerText === 'string' ? el.innerText : (el.textContent || '');
}

// contenteditable 的撤销栈只认 execCommand / 用户输入这类"编辑动作"。
// 以前发送后直接 `inputBox.textContent = ''`，那是纯 DOM 赋值，浏览器不记账，
// 撤销栈当场清空 —— 按 Ctrl+Z 什么也回不来。误发 / 发完想改的时候只能重打一遍。
// 走 selectAll + insertText/delete 就能让原生 Ctrl+Z / Ctrl+Y 正常工作，
// 不用自己维护一套 undo 栈（自己写的那套还得处理 IME、粘贴、拼写纠正）。
function replaceContenteditableText(el, text) {
  if (!el) return;
  const next = String(text == null ? '' : text);
  let applied = false;
  try {
    el.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
    applied = next
      ? document.execCommand('insertText', false, next)
      : document.execCommand('delete');
  } catch {
    applied = false;
  }
  // 兜底比撤销栈重要得多：清空失败会让下一次回车把同一条消息再发一遍。
  const after = readContenteditablePlainText(el);
  const wrong = next === '' ? after !== '' : after.trim() !== next.trim();
  if (!applied || wrong) el.textContent = next;
}

function placeCaretAtContenteditableEnd(el) {
  if (!el) return;
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  } catch {}
}

// ↑ 是"召回上一条"还是"在多行里上移一行"，取决于光标是不是已经在最开头。
function isCaretAtContenteditableStart(el) {
  if (!el) return true;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return true;
  const caret = selection.getRangeAt(0);
  if (!selection.isCollapsed) return false;
  if (!el.contains(caret.startContainer)) return false;
  try {
    const before = document.createRange();
    before.selectNodeContents(el);
    before.setEnd(caret.startContainer, caret.startOffset);
    return before.toString().length === 0;
  } catch {
    return false;
  }
}

function saveFloatingInputDraft(sessionId, inputBox) {
  if (!sessionId || !inputBox) return;
  const text = readContenteditablePlainText(inputBox);
  if (text) floatingInputDrafts.set(sessionId, text);
  else floatingInputDrafts.delete(sessionId);
}

function clearFloatingInputDraft(sessionId) {
  if (sessionId) floatingInputDrafts.delete(sessionId);
}

function getTerminalViewport(cached) {
  return cached && cached.container ? cached.container.querySelector('.xterm-viewport') : null;
}

function isTerminalViewportAtBottom(cached, epsilon = CODEX_BOTTOM_LOCK_EPSILON) {
  const vp = getTerminalViewport(cached);
  if (!vp) return true;
  return (vp.scrollHeight - vp.scrollTop - vp.clientHeight) <= epsilon;
}

function shouldAutoPinCodexTerminal(sessionId, cached) {
  const session = sessions.get(sessionId);
  if (!session || !isCodexKind(session.kind) || !cached || !cached.opened) return false;
  if (!cached.container || !cached.container.offsetWidth) return false;
  if (cached._codexUserScrollIntentUntil && performance.now() < cached._codexUserScrollIntentUntil && cached._codexFollowBottom === false) return false;
  return cached._codexFollowBottom !== false;
}

function pinTerminalViewportToBottom(cached) {
  if (!cached || !cached.terminal) return;
  cached._codexProgrammaticScrollUntil = performance.now() + CODEX_PROGRAMMATIC_SCROLL_SUPPRESS_MS;
  try { cached.terminal.scrollToBottom(); } catch {}
  const vp = getTerminalViewport(cached);
  if (vp) vp.scrollTop = vp.scrollHeight;
}

function scheduleCodexBottomPin(sessionId, cached) {
  if (!shouldAutoPinCodexTerminal(sessionId, cached)) return;
  if (cached._codexBottomPinRaf) return;
  pinTerminalViewportToBottom(cached);
  cached._codexBottomPinRaf = requestAnimationFrame(() => {
    cached._codexBottomPinRaf = 0;
    if (shouldAutoPinCodexTerminal(sessionId, cached)) pinTerminalViewportToBottom(cached);
  });
}

function updateCodexFollowBottomFromUserScroll(sessionId, cached) {
  const session = sessions.get(sessionId);
  if (!session || !isCodexKind(session.kind) || !cached) return;
  requestAnimationFrame(() => {
    const now = performance.now();
    // This helper is only scheduled from a real wheel gesture. User intent
    // must win even if an automatic pin happened in the preceding 120 ms;
    // otherwise a streaming Codex TUI can keep the suppression window alive
    // and make upward scrolling feel as if it hits an invisible wall.
    if (!cached._codexUserScrollIntentUntil || now > cached._codexUserScrollIntentUntil) return;
    cached._codexFollowBottom = isTerminalViewportAtBottom(cached);
  });
}

function markCodexUserScrollIntent(sessionId, cached, opts = {}) {
  const session = sessions.get(sessionId);
  if (!session || !isCodexKind(session.kind) || !cached) return;
  cached._codexUserScrollIntentUntil = performance.now() + CODEX_SCROLL_INTENT_MS;
  if (opts.detachFromBottom) cached._codexFollowBottom = false;
  if (opts.attachToBottom) cached._codexFollowBottom = true;
}

function setupCodexViewportScrollTracker(sessionId, cached) {
  const session = sessions.get(sessionId);
  if (!session || !isCodexKind(session.kind) || !cached) return;
  const vp = getTerminalViewport(cached);
  if (!vp || cached._codexTrackedViewport === vp) return;
  if (cached._codexTrackedViewport && cached._codexViewportScrollHandler) {
    try { cached._codexTrackedViewport.removeEventListener('scroll', cached._codexViewportScrollHandler); } catch {}
  }
  cached._codexTrackedViewport = vp;
  cached._codexViewportScrollHandler = () => {
    const now = performance.now();
    if (!cached._codexUserScrollIntentUntil || now > cached._codexUserScrollIntentUntil) return;
    // A pointer-down followed by a viewport scroll is a real scrollbar drag.
    // Do not discard it merely because a streaming write just performed an
    // automatic scrollToBottom. The user's resulting viewport position is the
    // source of truth; subsequent writes stay detached until they return to
    // the bottom or explicitly click the sidebar item again.
    cached._codexFollowBottom = isTerminalViewportAtBottom(cached);
  };
  vp.addEventListener('scroll', cached._codexViewportScrollHandler, { passive: true });
}

function fitAndResizeTerminal(sessionId, cached, opts = {}) {
  if (!sessionId || !cached || !cached.opened || !cached.container) return false;
  const rect = cached.container.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4 || !cached.container.offsetWidth) return false;
  // 之前只有 Codex 会话在 fit 之后回到底部（shouldAutoPinCodexTerminal 里就写死了
  // isCodexKind），而 showTerminal 的 pinOnShow 又恰好把 Codex 排除掉 —— 两条置底路径
  // 互补但都不覆盖"Claude 会话被 resize"。结果是：只要终端行数变过，xterm 重排后
  // 视口可能停在旧位置，正文上方留一大片空白，而且再也不会自己回正。
  // 这里补上与 CLI 无关的通用规则：fit 之前贴着底的终端，fit 之后必须还贴着底。
  const wasAtBottom = isTerminalViewportAtBottom(cached);
  const pinAfterFit = shouldAutoPinCodexTerminal(sessionId, cached);
  const boxSig = [
    Math.round(rect.width),
    Math.round(rect.height),
    currentFontSize,
    currentZoom,
  ].join('x');
  if (!opts.force && cached._lastFitBoxSig === boxSig) return false;
  cached._lastFitBoxSig = boxSig;
  try { cached.fitAddon.fit(); } catch (_) { return false; }
  // 注意：这里曾试过对 PTY resize 做防抖（拖窗口时 rAF 节流后仍是每秒 ~60 次
  // terminal-resize，每次都让 TUI 收到 SIGWINCH 并 \x1b[2J 清屏重画）。改动已回退——
  // Windows 上无法用合成 TUI 验证：经 .cmd 包一层的 node 子进程收不到 PTY 的
  // SIGWINCH，process.stdout.on('resize') 从不触发，对照组和实验组读数都是 0。
  // 未经验证就上防抖的风险是吞掉收尾那次 resize，让 CLI 永久停在错误宽度，
  // 比现状更糟。要动这里必须先有能真正接收 SIGWINCH 的验证手段。
  const resizeSig = `${cached.terminal.cols}x${cached.terminal.rows}`;
  const forcePtyResize = opts.forcePtyResize === true;
  // A newly created xterm is empty while its main-process snapshot is being
  // replayed. Sending PTY resizes during that window makes a full-screen CLI
  // redraw concurrently with the old ANSI stream; the two streams can be
  // interleaved/deduplicated into a half frame or a completely blank surface.
  // Fit the local xterm now, but defer the live PTY resize until hydration has
  // reached its exact sequence barrier. hydrateTerminalFromSnapshot then sends
  // one forced final-size resize so Codex/Kimi/Claude paints a fresh frame.
  if (cached._hydrating && !forcePtyResize) {
    cached._deferredResizeSig = resizeSig;
  } else if (forcePtyResize || cached._lastResizeSig !== resizeSig) {
    cached._lastResizeSig = resizeSig;
    cached._deferredResizeSig = null;
    // Full-screen CLIs repaint after SIGWINCH. Mark renderer-originated resize
    // output so the activity monitor does not mistake that repaint for a new
    // AI turn (for example when a multiline floating draft changes height).
    cached._lastPtyResizeAt = Date.now();
    ipcRenderer.send('terminal-resize', {
      sessionId,
      cols: cached.terminal.cols,
      rows: cached.terminal.rows,
      force: forcePtyResize,
    });
  }
  if (cached._minimap) cached._minimap.invalidate();
  if (pinAfterFit) scheduleCodexBottomPin(sessionId, cached);
  else if (wasAtBottom) {
    // xterm 的 reflow 在下一帧才落定，隔一帧再贴一次才稳。
    pinTerminalViewportToBottom(cached);
    requestAnimationFrame(() => {
      if (cached.opened && cached.container && cached.container.offsetWidth) {
        pinTerminalViewportToBottom(cached);
      }
    });
  }
  return true;
}

function scheduleFitAndResizeTerminal(sessionId, cached, opts = {}) {
  if (!sessionId || !cached) return;
  if (cached._fitRaf) cancelAnimationFrame(cached._fitRaf);
  cached._fitRaf = requestAnimationFrame(() => {
    cached._fitRaf = 0;
    fitAndResizeTerminal(sessionId, cached, opts);
  });
}

function refreshTerminalRendererSurface(cached) {
  if (!cached || !cached.opened || !cached.terminal) return false;
  const lastRow = Math.max(0, Number(cached.terminal.rows || 1) - 1);
  try {
    // Moving a cached xterm through display:none or into a new parent does not
    // necessarily resize it. In that case FitAddon is a no-op and Canvas/WebGL
    // keeps the old (or partially evicted) frame. Force a complete repaint so
    // a restored PTY cannot come back as a black surface with scattered glyphs.
    cached.terminal.refresh(0, lastRow);
    cached._surfaceRefreshCount = (cached._surfaceRefreshCount || 0) + 1;
    return true;
  } catch (_) {
    return false;
  }
}

// A cached xterm can keep a complete logical buffer while Chromium discards
// its Canvas/WebGL pixels after card view, display:none, DOM re-parenting, or a
// resumed session being opened behind another surface. FitAddon only renders
// when geometry changes, so an unchanged grid can remain black forever.
// Recover on two visible animation frames: the first restores geometry and
// paints, the second covers delayed layout/compositor attachment.
function scheduleVisibleTerminalRecovery(sessionId, cached, opts = {}) {
  if (!sessionId || !cached) return;
  if (cached._surfaceRecoveryRaf) cancelAnimationFrame(cached._surfaceRecoveryRaf);
  const recover = (secondPass = false) => {
    cached._surfaceRecoveryRaf = 0;
    if (terminalCache.get(sessionId) !== cached || !cached.opened || !cached.container) return;
    if (!cached.container.isConnected) return;
    if (!cached.container.offsetWidth || !cached.container.offsetHeight) {
      if (!secondPass) {
        cached._surfaceRecoveryRaf = requestAnimationFrame(() => recover(true));
      }
      return;
    }
    fitAndResizeTerminal(sessionId, cached, { force: true });
    refreshTerminalRendererSurface(cached);
    if (opts.pinBottom) {
      try { cached.terminal.scrollToBottom(); } catch {}
      const viewport = getTerminalViewport(cached);
      if (viewport) viewport.scrollTop = viewport.scrollHeight;
    }
    if (!secondPass) {
      cached._surfaceRecoveryRaf = requestAnimationFrame(() => recover(true));
    }
  };
  cached._surfaceRecoveryRaf = requestAnimationFrame(() => recover(false));
}

// --- DOM refs ---
const sessionListEl = document.getElementById('session-list');
const terminalPanelEl = document.getElementById('terminal-panel');
const emptyStateEl = document.getElementById('empty-state');

// Spec 2 preserve helper — both showTerminal AND session-closed handler clear
// terminalPanelEl.innerHTML, which would obliterate spec 1/2 elements (view-toggle,
// notification toggle, msg-overlay) declared statically in index.html. Without preserve they vanish forever
// after the first session close → no card view + no view toggle button.
function preserveAndClearTerminalPanel() {
  const preserved = [
    document.getElementById('msg-overlay'),
    document.getElementById('card-question-nav'),
    document.querySelector('.view-toggle'),
    document.getElementById('completion-notification-toggle'),
    document.getElementById('recent-turn-copy'),
  ].filter(Boolean);
  terminalPanelEl.innerHTML = '';
  preserved.forEach(el => terminalPanelEl.appendChild(el));
}
const btnNew = document.getElementById('btn-new');
const menuEl = document.getElementById('new-session-menu');
const wrapperEl = document.getElementById('new-session-wrapper');
const btnResume = document.getElementById('btn-resume');
const resumeMenuEl = document.getElementById('resume-picker-menu');
const resumeWrapperEl = document.getElementById('resume-picker-wrapper');
const btnHome = document.getElementById('btn-home');
const contextMenuEl = document.getElementById('context-menu');
const termCtxMenuEl = document.getElementById('terminal-context-menu');
const appContainerEl = document.getElementById('app-container');
// btn-collapse-sidebar 已删除 (v0.8.4) — 用 Ctrl+B 折叠;展开按钮 btn-expand-sidebar 在折叠态仍提供
const btnExpandEl = document.getElementById('btn-expand-sidebar');

const modelUi = createModelUiController({
  document,
  ipcRenderer,
  sessions,
  terminalPanelEl,
  getActiveSessionId: () => activeSessionId,
  escapeHtml,
});
const attachModelPickerHandler = modelUi.attachModelPickerHandler;
const updateActiveModelBadge = modelUi.updateActiveModelBadge;

// Font size — shared across all terminals, persisted
const FONT_SIZE_KEY = 'claude-hub-font-size';
const FONT_SIZE_MIN = 10;
const FONT_SIZE_MAX = 28;
let currentFontSize = parseInt(localStorage.getItem(FONT_SIZE_KEY), 10);
if (!currentFontSize || isNaN(currentFontSize)) currentFontSize = 16;

function setFontSize(size) {
  size = Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, size));
  if (size === currentFontSize) return;
  currentFontSize = size;
  localStorage.setItem(FONT_SIZE_KEY, String(size));
  // 2026-05-09 主区 zoom 联动：卡片视图 / 启动器 / AI 群聊 fullscreen 等通过 CSS calc(... * --main-zoom) 跟随
  // 写到 :root（documentElement），让 AI 群聊（#meeting-room-panel，#terminal-panel 的兄弟节点）也能继承
  document.documentElement.style.setProperty('--main-zoom', (size / 16).toFixed(3));
  for (const [sid, c] of terminalCache) {
    c.terminal.options.fontSize = size;
    if (c.opened) {
      scheduleFitAndResizeTerminal(sid, c, { force: true });
    }
  }
}

// 启动时初始化 --main-zoom（首次 setFontSize 才设变量，启动时手动设一次到 :root）
document.documentElement.style.setProperty('--main-zoom', (currentFontSize / 16).toFixed(3));

// --- Global UI zoom (Electron webFrame) ---
// Scales the entire renderer: sidebar, buttons, xterm cells, modals. Used
// mainly to bump everything up for dense displays vs. shrink for
// desktop. Distinct from setFontSize, which only touches the xterm font.
// Level is an integer; each step is ~20% per Electron's zoom curve. 0 = 100%.
const ZOOM_KEY = 'claude-hub-zoom-level';
const ZOOM_MIN = -3;
const ZOOM_MAX = 5;
let currentZoom = parseInt(localStorage.getItem(ZOOM_KEY), 10);
if (isNaN(currentZoom)) currentZoom = 0;

function applyZoom(level) {
  level = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level));
  currentZoom = level;
  webFrame.setZoomLevel(level);
  localStorage.setItem(ZOOM_KEY, String(level));
  // Re-fit the active xterm so terminal cols/rows match the new render size.
  const active = activeSessionId && terminalCache.get(activeSessionId);
  if (active && active.opened) {
    scheduleFitAndResizeTerminal(activeSessionId, active, { force: true });
  }
}

// Restore persisted zoom on boot.
applyZoom(currentZoom);

// --- Global Memo Panel ---
const memoPanel = createMemoPanel({
  baseDir: __dirname,
  clipboard,
  document,
  getActiveSessionId: () => activeSessionId,
  getActiveTerminal: () => activeSessionId && terminalCache.get(activeSessionId),
  localStorage,
  scheduleRefit: scheduleFitAndResizeTerminal,
});
memoPanel.init();
// --- Helpers ---
// 2026-07-20 道雪：侧栏时间显示规则——2h 内显示具体时刻（HH:MM），
//   24h 内显示「N 小时前」，更早显示「N 天前」（N 小时前超过 24 可读性差）。
function formatTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 2 * 3600000) {
    return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  if (diff < 24 * 3600000) return `${Math.floor(diff / 3600000)}小时前`;
  return `${Math.floor(diff / 86400000)}天前`;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function normalizeMarkdownPathBreaks(text) {
  if (typeof window !== 'undefined' && typeof window.normalizeWrappedPathBreaks === 'function') {
    return window.normalizeWrappedPathBreaks(text);
  }
  return String(text || '');
}

const { createSessionListRenderer } = require('./session-list-renderer.js');
const sessionListRenderer = createSessionListRenderer({
  document,
  localStorage,
  sessionListEl,
  getSessions: () => sessions,
  getMeetings: () => meetings,
  getActiveSessionId: () => activeSessionId,
  getActiveMeetingId: () => activeMeetingId,
  isAiKind,
  modelShort,
  modelClass,
  escapeHtml,
  formatTime,
  pctClass: (pct) => pctClass(pct),
  getResourceUsage: () => systemResourceUsage,
  getProxyInfo: () => hubProxyInfo,
  acknowledgeNetworkChange: async () => {
    try {
      const result = await ipcRenderer.invoke('acknowledge-network-egress-change');
      if (result && result.status) {
        hubProxyInfo = { ...(hubProxyInfo || {}), egress: result.status };
        renderSidebarStrip();
        if (homeWorkbench) homeWorkbench.render();
      }
      return result;
    } catch {
      return { ok: false };
    }
  },
  selectSession: (id, opts) => selectSession(id, opts),
  selectMeeting: (id, opts) => selectMeeting(id, opts),
  openContextMenu: (id, x, y) => openContextMenu(id, x, y),
  afterRender: () => { updateFloatingBarState(); updateRespondPill(); },
});
const renderSessionListNow = sessionListRenderer.renderSessionList;
const renderSidebarStrip = sessionListRenderer.renderSidebarStrip;
function renderSessionSurfacesNow() {
  renderSessionListNow();
  if (homeWorkbench) homeWorkbench.render();
}
const sidebarRenderCoalescer = createRenderCoalescer(renderSessionSurfacesNow, { delayMs: 75 });
function renderSessionList() {
  sidebarRenderCoalescer.cancel();
  renderSessionSurfacesNow();
}
function scheduleSessionListRender() {
  sidebarRenderCoalescer.schedule();
}

async function refreshSystemResourceUsage() {
  try {
    const next = await ipcRenderer.invoke('get-system-resource-usage');
    if (!next || (!Number.isFinite(next.cpuPct) && !Number.isFinite(next.memoryPct))) return;
    systemResourceUsage = next;
    renderSidebarStrip();
    if (homeWorkbench) homeWorkbench.render();
  } catch {}
}

// 配置与真实出口一起刷新。main 进程对外网探测有缓存，renderer
// 可以频繁读 IPC 而不会频繁请求地理服务。
async function refreshHubProxyInfo(options = {}) {
  try {
    const [configResult, egressResult, notificationHealthResult] = await Promise.allSettled([
      ipcRenderer.invoke('get-hub-config-raw'),
      ipcRenderer.invoke('get-network-egress-status', { force: options.force === true }),
      ipcRenderer.invoke('get-completion-notification-health'),
    ]);
    const cfg = configResult.status === 'fulfilled' ? configResult.value : null;
    const egress = egressResult.status === 'fulfilled' ? egressResult.value : null;
    const notificationHealth = notificationHealthResult.status === 'fulfilled'
      ? notificationHealthResult.value
      : null;
    const next = {
      proxy: (cfg && cfg.proxy) || (hubProxyInfo && hubProxyInfo.proxy) || (egress && egress.proxyEndpoint) || '',
      serverchanSendKeySet: cfg
        ? !!(cfg.serverchanSendKeySet || String(cfg.serverchanSendKey || '').trim())
        : !!(hubProxyInfo && hubProxyInfo.serverchanSendKeySet),
      deepseekApiKeySet: cfg
        ? !!String(cfg.deepseekApiKey || '').trim()
        : !!(hubProxyInfo && hubProxyInfo.deepseekApiKeySet),
      egress: egress || (hubProxyInfo && hubProxyInfo.egress) || null,
      notificationHealth: notificationHealth || (hubProxyInfo && hubProxyInfo.notificationHealth) || null,
    };
    if (hubProxyInfo
        && hubProxyInfo.proxy === next.proxy
        && hubProxyInfo.serverchanSendKeySet === next.serverchanSendKeySet
        && hubProxyInfo.deepseekApiKeySet === next.deepseekApiKeySet
        && Number(hubProxyInfo.egress && hubProxyInfo.egress.checkedAt) === Number(next.egress && next.egress.checkedAt)
        && String(hubProxyInfo.egress && hubProxyInfo.egress.alert && hubProxyInfo.egress.alert.type || '')
          === String(next.egress && next.egress.alert && next.egress.alert.type || '')
        && Number(hubProxyInfo.notificationHealth && hubProxyInfo.notificationHealth.lastDelivery && hubProxyInfo.notificationHealth.lastDelivery.timestamp)
          === Number(next.notificationHealth && next.notificationHealth.lastDelivery && next.notificationHealth.lastDelivery.timestamp)
        && String(hubProxyInfo.notificationHealth && hubProxyInfo.notificationHealth.lastDelivery && hubProxyInfo.notificationHealth.lastDelivery.status || '')
          === String(next.notificationHealth && next.notificationHealth.lastDelivery && next.notificationHealth.lastDelivery.status || '')) return;
    hubProxyInfo = next;
    renderSidebarStrip();
    if (homeWorkbench) homeWorkbench.render();
  } catch {}
}
let activeMeetingId = null;
let meetings = {};

function formatRelativeTime(ts) {
  if (!ts) return '';
  const now = Math.floor(Date.now() / 1000);
  const diff = now - parseInt(ts);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + '分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + '小时前';
  if (diff < 604800) return Math.floor(diff / 86400) + '天前';
  const d = new Date(parseInt(ts) * 1000);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}


async function selectMeeting(meetingId, opts = {}) {
  await savePreviewState();
  activeSessionId = null;
  suspendInactiveTerminalRenderers(null);
  if (typeof recentTurnCopyController !== 'undefined') recentTurnCopyController.setVisible(false);
  activeMeetingId = meetingId;
  if (completionNotificationToggle) completionNotificationToggle.refreshTarget();
  // Stop background meeting PTY redraws at the main-process boundary. The room
  // renders transcript/card state, not xterm output; an individual member shell
  // will set focus again via selectSession when the user explicitly opens it.
  ipcRenderer.send('focus-session', { sessionId: null });

  if (terminalPanelEl) terminalPanelEl.style.display = 'none';
  if (terminalPanelEl) terminalPanelEl.classList.remove('home-active');
  if (window.__chuxinHide) window.__chuxinHide(); // 2026-07-23 投研面板互斥
  if (emptyStateEl) emptyStateEl.style.display = 'none';
  clearPreviewUI();

  const meeting = meetings[meetingId];
  // 2026-05-05 道雪 修3：清 unread —— 用户点进 AI 群聊即"看过"，跟普通 session 一致。
  // 2026-05-31 道雪：新语义清"本轮已答 sid 集合"；_lastUnreadTurnNum 保留，避免离开后同一轮再答完又从 1 起跳。
  if (meeting) {
    meeting.unreadCount = 0;
    if (meeting.unreadAnswered instanceof Set) meeting.unreadAnswered.clear();
  }
  if (meeting && typeof MeetingRoom !== 'undefined') {
    if (meeting.status === 'dormant') {
      meeting.status = 'idle';
      // 2026-07-20 道雪 [修#2]：唤醒状态同步落后端——否则下一次 meeting-updated
      //   （发消息/auto-title 必触发）又把 dormant 覆盖回来，侧栏"等你 N"与
      //   respond pill 对该会议永久失声。后端 updateMeeting 的 allowed 字段含 status。
      ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { status: 'idle' } });
      const workflow = meeting.serialWorkflow;
      const usesLazySerialWake = !!(
        workflow && workflow.enabled && !workflow.loop?.enabled
        && Array.isArray(workflow.steps) && workflow.steps.length
      );
      // 普通群聊保持历史行为；纯串行工作流由 runSerialWorkflow 在每一步前
      // 只唤醒本步成员，避免“打开房间”就同时拉起所有 CLI/MCP。
      if (!usesLazySerialWake) {
        for (const sid of meeting.subSessions) {
          const s = sessions.get(sid);
          if (s && s.status === 'dormant') {
            resumeDormantSession(sid);
          }
        }
      }
    }
    MeetingRoom.openMeeting(meetingId, meeting, {
      forceScrollBottom: opts.forceScrollBottom === true,
    });
  }

  renderSessionList();
  await restorePreviewForContext(`meeting:${meetingId}`);
}

// --- Terminal management ---
// Load GPU renderer. Default is Canvas (stable + GPU-accelerated 2D). WebGL
// is faster but on some GPU/driver combos it leaves cursor ghosting artifacts
// in Claude Code's TUI redraw, so it's opt-in only.
// Override via localStorage: setItem('hub.renderer', 'canvas' | 'webgl' | 'dom')
function _loadCanvasRenderer(cached) {
  try {
    const canvas = new CanvasAddon();
    cached.terminal.loadAddon(canvas);
    cached._rendererAddon = canvas;
    cached._rendererMode = 'canvas';
    cached._gpuLoaded = true;
    return true;
  } catch (_) {
    cached._rendererAddon = null;
    cached._rendererMode = null;
    cached._gpuLoaded = false;
    return false;
  }
}

function loadGpuRenderer(cached) {
  if (cached._gpuLoaded) return;
  const pref = localStorage.getItem('hub.renderer') || 'canvas';
  if (pref === 'dom') {
    cached._rendererAddon = null;
    cached._rendererMode = 'dom';
    cached._gpuLoaded = true;
    return;
  }
  if (pref === 'webgl') {
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        if (cached._rendererAddon !== webgl) return;
        try { webgl.dispose(); } catch {}
        cached._rendererAddon = null;
        cached._rendererMode = null;
        cached._gpuLoaded = false;
        // Only recreate a surface for the visible terminal. Hidden xterms keep
        // parsing into their buffers without holding compositor resources.
        if (cached.container && cached.container.style.display !== 'none') {
          _loadCanvasRenderer(cached);
        }
      });
      cached.terminal.loadAddon(webgl);
      cached._rendererAddon = webgl;
      cached._rendererMode = 'webgl';
      cached._gpuLoaded = true;
      return;
    } catch (_) { /* fall through to canvas */ }
  }
  _loadCanvasRenderer(cached);
}

function unloadGpuRenderer(cached) {
  if (!cached) return false;
  const addon = cached._rendererAddon;
  if (addon) {
    try { addon.dispose(); } catch {}
  }
  const changed = !!addon || !!cached._gpuLoaded;
  cached._rendererAddon = null;
  cached._rendererMode = null;
  cached._gpuLoaded = false;
  return changed;
}

function suspendInactiveTerminalRenderers(activeId) {
  for (const [sessionId, cached] of terminalCache) {
    if (activeId && sessionId === activeId) continue;
    if (cached && cached.container) cached.container.style.display = 'none';
    unloadGpuRenderer(cached);
  }
}

function disposeCachedTerminal(sessionId) {
  const cached = terminalCache.get(sessionId);
  if (!cached) return false;
  if (cached._ro) cached._ro.disconnect();
  if (cached._resizeHandler) window.removeEventListener('resize', cached._resizeHandler);
  if (cached._overflowDocHandler) document.removeEventListener('click', cached._overflowDocHandler);
  if (cached._fitRaf) cancelAnimationFrame(cached._fitRaf);
  if (cached._surfaceRecoveryRaf) cancelAnimationFrame(cached._surfaceRecoveryRaf);
  if (cached._codexBottomPinRaf) cancelAnimationFrame(cached._codexBottomPinRaf);
  if (cached._minimap) { try { cached._minimap.dispose(); } catch {} cached._minimap = null; }
  if (cached._navButtons) { try { cached._navButtons.dispose(); } catch {} cached._navButtons = null; }
  if (cached._floatingInput) { try { cached._floatingInput.dispose(); } catch {} cached._floatingInput = null; }
  if (typeof _cursorDebounce !== 'undefined' && _cursorDebounce.has(sessionId)) {
    clearTimeout(_cursorDebounce.get(sessionId));
    _cursorDebounce.delete(sessionId);
  }
  unloadGpuRenderer(cached);
  try { cached.terminal.dispose(); } catch {}
  try { cached.container.remove(); } catch {}
  terminalCache.delete(sessionId);
  return true;
}

async function closeSessionAsSleep(sessionId) {
  try {
    const result = await ipcRenderer.invoke('close-session', sessionId);
    if (!result || !result.ok) {
      window.alert((result && result.message) || '关闭休眠失败，请稍后重试。');
    }
    return result || null;
  } catch (error) {
    window.alert(`关闭休眠失败：${error && error.message ? error.message : String(error)}`);
    return null;
  }
}

function getOrCreateTerminal(sessionId) {
  if (terminalCache.has(sessionId)) {
    return terminalCache.get(sessionId);
  }
  const terminal = new Terminal({
    theme: XTERM_THEMES.default,
    fontSize: currentFontSize,
    fontFamily: "'Cascadia Code', 'Consolas', 'Courier New', monospace",
    cursorBlink: true,
    scrollback: 10000,
    allowProposedApi: true,
    // Tells xterm the PTY backend is conpty so it parses native wrap sequences
    // (Windows 11 build >= 21376) and sets isWrapped correctly. Without this
    // xterm sees conpty's already-laid-out lines as separate explicit lines
    // and our path-link wrap-stitching breaks on long paths.
    ...(process.platform === 'win32' ? {
      windowsPty: {
        backend: 'conpty',
        buildNumber: parseInt(require('os').release().split('.').pop(), 10) || 0,
      },
    } : {}),
  });

  const fitAddon = new FitAddon();
  const searchAddon = new SearchAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new Unicode11Addon());
  terminal.loadAddon(searchAddon);
  terminal.loadAddon(new WebLinksAddon((e, uri) => { openPreviewPanel(uri); }));
  const localPathLinkProvider = registerLocalPathLinks(terminal, sessionId);
  terminal.unicode.activeVersion = '11';

  terminal.onData((data) => {
    if (data) clearSessionWaitingState(sessionId);
    trackPtyPromptInput(sessionId, data);
    ipcRenderer.send('terminal-input', { sessionId, data });
  });
  terminal.onBinary((data) => { ipcRenderer.send('terminal-input', { sessionId, data }); });

  // Claude Code emits an OSC set-title escape sequence once near the start of a
  // conversation with an AI-generated short summary (e.g. "Greeting in Chinese").
  // xterm fires onTitleChange for it. We capture that as the session title
  // unless the user already renamed in Hub (userRenamed wins). Only for Claude
  // kinds — PowerShell emits title sequences on every prompt, which we don't want.
  // Migration-only DeepSeek sessions still run on Claude CLI. New DeepSeek
  // sessions use Codex and are titled by Hub's transcript-based auto-title path.
  const session = sessions.get(sessionId);
  const isClaudeKind = isClaudeRuntimeSession(session);
  if (isClaudeKind) {
    terminal.onTitleChange((newTitle) => {
      const s = sessions.get(sessionId);
      if (!s) return;
      if (s.userRenamed || s.autoTitleGenerated) return; // user's Hub rename / Hub auto-title is authoritative
      // slot 化（2026-05-03 道雪）：AI 群聊 sub session title 永久绑定 slot 名
      //   （Pikachu/Charmander/Squirtle），不接受 OSC 自动覆盖。
      //   主桌单 session（meetingId === null）仍走 OSC 自动命名（Claude 给的简短摘要）。
      if (s.meetingId) return;
      const clean = String(newTitle || '').trim();
      if (!shouldAcceptExternalSessionTitle(s, clean)) return;
      // 2026-05-24 道雪：DeepSeek 中文自动命名启用时，OSC 是抢跑赛道（PTY 同步、~ms 内到达），
      //   会先于 DeepSeek HTTP（~数百 ms—秒）落地 s.title，导致 auto-title-manager 的
      //   isGenericAutoSessionTitle 检查失败、DeepSeek 中文结果被丢弃 → 用户全英文。
      //   解决：DeepSeek 启用时 OSC 仅记影子字段不动 s.title；让 DeepSeek 独占主标题。
      //   DeepSeek API 失败时 auto-title-manager 自己有 fallbackSessionTitleFromPrompt 兜底（中文）。
      if (_deepseekAutoTitleEnabled && s.kind === 'deepseek') {
        s.claudeAutoTitle = clean;
        return;
      }
      if (clean === s.title) return;
      s.title = clean;
      s.claudeAutoTitle = clean;
      // Persist server-side so reloads / session-updated echoes stay consistent.
      ipcRenderer.invoke('rename-session', { sessionId, title: clean, userRenamed: false });
    });
  }

  // Intercept Ctrl/Cmd+V ourselves (both text and image) — Electron's Chromium
  // doesn't fire paste events on xterm's helper textarea for real keystrokes.
  terminal.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    if (['PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) {
      markCodexUserScrollIntent(sessionId, terminalCache.get(sessionId), {
        detachFromBottom: e.key === 'PageUp' || e.key === 'Home',
        attachToBottom: e.key === 'End',
      });
    }

    // --- Word-like selection editing on the input line ---
    if (terminal.hasSelection()) {
      const inputSel = getInputLineSelection(terminal);
      if (inputSel && inputSel.text.length > 0) {
        if (e.key === 'Backspace' || e.key === 'Delete') {
          e.preventDefault();
          deleteInputSelection(terminal, sessionId);
          return false;
        }
        if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'x' || e.key === 'X')) {
          e.preventDefault();
          clipboard.writeText(inputSel.text);
          deleteInputSelection(terminal, sessionId);
          return false;
        }
        if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'v' || e.key === 'V')) {
          e.preventDefault();
          deleteInputSelection(terminal, sessionId);
          handlePasteForSession(sessionId);
          return false;
        }
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          deleteInputSelection(terminal, sessionId, e.key);
          return false;
        }
      }
    }

    const mod = e.ctrlKey || e.metaKey;
    if (!mod || e.altKey) return true;

    // Ctrl+Up / Ctrl+Down — jump between user prompts
    if (!e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const c = terminalCache.get(sessionId);
      if (!c || !c._minimap) return true;
      const moved = e.key === 'ArrowUp' ? c._minimap.navPrev() : c._minimap.navNext();
      if (moved) {
        e.preventDefault();
        return false;
      }
      return true;
    }

    // Ctrl+V — paste (text or image)
    if (!e.shiftKey && (e.key === 'v' || e.key === 'V')) {
      e.preventDefault();
      handlePasteForSession(sessionId);
      return false;
    }
    // Ctrl+Shift+C — always copy selection (VSCode/Windows Terminal style)
    if (e.shiftKey && (e.key === 'C' || e.key === 'c')) {
      if (terminal.hasSelection()) {
        clipboard.writeText(terminal.getSelection());
        e.preventDefault();
        return false;
      }
      return true;
    }
    // Ctrl+C — copy if there's a selection, else pass through as SIGINT
    if (!e.shiftKey && (e.key === 'c' || e.key === 'C')) {
      if (terminal.hasSelection()) {
        clipboard.writeText(terminal.getSelection());
        e.preventDefault();
        return false;
      }
      return true;
    }
    return true;
  });

  const container = document.createElement('div');
  container.style.cssText = 'width:100%;height:100%;display:none';

  // Drag-and-drop: dropping a file/folder into the terminal inserts its path(s).
  container.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  container.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length === 0) return;
    const quoted = files.map(f => {
      const p = f.path;
      return /\s/.test(p) ? `"${p}"` : p;
    }).join(' ');
    terminal.paste(quoted);
  });

  // Ctrl+wheel zoom — passive so xterm's own wheel-scroll stays on the
  // compositor thread. Chromium still lets us observe the event; we just
  // can't preventDefault. The browser's page-zoom on Ctrl+wheel is already
  // disabled globally in Electron for non-text areas.
  container.addEventListener('wheel', (e) => {
    if (window.__scrollDebug && window.__scrollDebug.isOn()) {
      window.__scrollDebug.log('wheel:before', { deltaY: e.deltaY, mode: e.deltaMode, ctrl: !!e.ctrlKey, ...window.__scrollDebug.snap(terminal, sessionId) });
      requestAnimationFrame(() => {
        window.__scrollDebug.log('wheel:after-raf', window.__scrollDebug.snap(terminal, sessionId));
      });
    }
    if (!e.ctrlKey && !e.metaKey) {
      const c = terminalCache.get(sessionId);
      markCodexUserScrollIntent(sessionId, c, { detachFromBottom: e.deltaY < 0 });
      updateCodexFollowBottomFromUserScroll(sessionId, c);
      return;
    }
    const delta = e.deltaY < 0 ? 1 : -1;
    setFontSize(currentFontSize + delta);
  }, { passive: true });

  container.addEventListener('pointerdown', () => {
    markCodexUserScrollIntent(sessionId, terminalCache.get(sessionId));
  }, { passive: true });

  container.addEventListener('mousedown', () => {
    markCodexUserScrollIntent(sessionId, terminalCache.get(sessionId));
  }, { passive: true });

  container.addEventListener('touchstart', () => {
    markCodexUserScrollIntent(sessionId, terminalCache.get(sessionId));
  }, { passive: true });

  // Click-to-position: clicking on the cursor's row sends arrow-key
  // sequences so the PTY moves the cursor to the clicked column.
  // We track where we last sent the cursor so rapid successive clicks
  // don't misfire when the PTY is still redrawing the input line
  // (cursorX briefly passes through 0 during redraws).
  let sentCursorCol = null;
  let sentCursorTimer = null;

  container.addEventListener('click', (e) => {
    if (terminal.hasSelection()) return;
    const coords = getTerminalCoords(terminal, container, e);
    if (!coords) return;

    const buf = terminal.buffer.active;
    const cursorAbsRow = buf.baseY + buf.cursorY;
    if (coords.row !== cursorAbsRow) return;

    const cursorCol = sentCursorCol ?? buf.cursorX;
    const diff = coords.col - cursorCol;
    if (diff === 0) { sentCursorCol = null; return; }

    sentCursorCol = coords.col;
    clearTimeout(sentCursorTimer);
    sentCursorTimer = setTimeout(() => { sentCursorCol = null; }, 300);

    const arrow = diff > 0 ? '\x1b[C' : '\x1b[D';
    const seq = arrow.repeat(Math.abs(diff));
    ipcRenderer.send('terminal-input', { sessionId, data: seq });
  });

  // Right-click: show "Preview" option when text is selected
  container.addEventListener('contextmenu', (e) => {
    const sel = terminal.getSelection().trim();
    if (!sel) return;
    e.preventDefault();
    openTerminalContextMenu(sel, e.clientX, e.clientY);
  });

  const cached = {
    terminal, fitAddon, searchAddon, container, opened: false,
    _codexFollowBottom: true,
    _hydrated: false,
    _hydrating: false,
    _hydratedSeq: 0,
    _pendingOutput: [],
    _pendingOutputBytes: 0,
    _localPathLinkProvider: localPathLinkProvider,
    _deferredResizeSig: null,
    _needsPtyRedraw: false,
  };
  terminalCache.set(sessionId, cached);
  return cached;
}

function showTerminal(sessionId, opts = { focus: true }) {
  suspendInactiveTerminalRenderers(sessionId);

  const session = sessions.get(sessionId);
  if (!session) return;

  const cached = getOrCreateTerminal(sessionId);
  const mountTarget = opts && opts.mountTarget ? opts.mountTarget : terminalPanelEl;
  const embedded = mountTarget !== terminalPanelEl;
  if (!embedded) terminalPanelEl.classList.remove('home-active');

  // Preserve spec 1/2 elements that live inside #terminal-panel (view-toggle, msg-overlay)
  // before innerHTML clear obliterates them; re-attach after.
  if (embedded) mountTarget.replaceChildren();
  else preserveAndClearTerminalPanel();

  const header = document.createElement('div');
  header.className = 'terminal-header';

  const titleRow = document.createElement('div');
  titleRow.className = 'terminal-title-row';

  const titleSection = document.createElement('div');
  titleSection.className = 'terminal-title-section';

  const titleSpan = document.createElement('span');
  titleSpan.className = 'terminal-title';
  titleSpan.textContent = session.title;
  titleSpan.title = session.readOnly ? '只读会话' : 'Click to rename';
  if (!session.readOnly) titleSpan.addEventListener('click', () => startRename(sessionId, titleSpan));

  const statusSpan = document.createElement('span');
  statusSpan.className = `terminal-status ${session.status}`;
  statusSpan.textContent = session.status === 'running' ? '\u25cf running' : '\u25cb idle';

  titleSection.append(titleSpan, statusSpan);

  if (session.currentModel) {
    const modelSpan = document.createElement('span');
    modelSpan.className = 'terminal-model-badge ' + modelClass(session.currentModel.id);
    modelSpan.textContent = session.currentModel.displayName || modelShort(session.currentModel);
    modelSpan.title = session.currentModel.id + ' — click to switch model';
    attachModelPickerHandler(modelSpan, sessionId);
    titleSection.appendChild(modelSpan);
  }

  // 2026-07-19 道雪 · 方案C：A−/A+ 低频缩放折叠进 ⋯ 溢出菜单（顶栏 8 控件 → 5 个）
  const overflowWrap = document.createElement('div');
  overflowWrap.className = 'header-overflow-wrap';
  const overflowBtn = document.createElement('button');
  overflowBtn.className = 'btn-zoom';
  overflowBtn.textContent = '⋯';
  overflowBtn.title = '更多（界面缩放）';
  overflowBtn.setAttribute('aria-label', '更多操作');
  const overflowMenu = document.createElement('div');
  overflowMenu.className = 'header-overflow-menu';
  overflowMenu.style.display = 'none';
  const mkOverflowItem = (label, key, fn) => {
    const b = document.createElement('button');
    const lbl = document.createElement('span');
    lbl.textContent = label;
    const kbd = document.createElement('span');
    kbd.className = 'ho-key';
    kbd.textContent = key;
    b.append(lbl, kbd);
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      overflowMenu.style.display = 'none';
      fn();
    });
    return b;
  };
  overflowMenu.append(
    mkOverflowItem('放大界面', 'A+', () => applyZoom(currentZoom + 1)),
    mkOverflowItem('缩小界面', 'A−', () => applyZoom(currentZoom - 1)),
    mkOverflowItem('重置缩放', '1:1', () => applyZoom(0)),
  );
  overflowBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    overflowMenu.style.display = overflowMenu.style.display === 'none' ? 'block' : 'none';
  });
  if (cached._overflowDocHandler) document.removeEventListener('click', cached._overflowDocHandler);
  cached._overflowDocHandler = () => { overflowMenu.style.display = 'none'; };
  document.addEventListener('click', cached._overflowDocHandler);
  overflowWrap.append(overflowBtn, overflowMenu);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn-close-session';
  const closeLabel = supportsRecoverableSessionKind(session) ? '关闭并休眠' : '关闭';
  closeBtn.title = `${closeLabel}（Ctrl+W）`;
  closeBtn.setAttribute('aria-label', closeLabel);
  closeBtn.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/></svg>';
  closeBtn.addEventListener('click', () => { void closeSessionAsSleep(sessionId); });

  // Metrics (cwd + api time) live inline with the title now — single-row header.
  const metricsRow = document.createElement('div');
  metricsRow.className = 'terminal-metrics-row inline';
  renderMetricsRow(metricsRow, session);
  titleSection.appendChild(metricsRow);

  const headerActions = document.createElement('div');
  headerActions.className = 'terminal-header-actions';

  const canForkSession = supportsForkSession(session);
  let forkBtn = null;
  if (canForkSession) {
    forkBtn = document.createElement('button');
    forkBtn.className = 'btn-zoom btn-fork-session';
    forkBtn.textContent = '分支';
    forkBtn.title = '创建继承当前上下文的独立会话 (Ctrl+Shift+B)';
    forkBtn.setAttribute('aria-label', '创建当前会话分支');
    forkBtn.addEventListener('click', () => {
      void keyboardShortcuts.forkSession(sessionId);
    });
  }

  const memoBtn = document.createElement('button');
  memoBtn.className = 'btn-zoom btn-memo-toggle';
  memoBtn.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M2 3.5A1.5 1.5 0 013.5 2h9A1.5 1.5 0 0114 3.5v9a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12.5v-9zM4 5h8M4 8h8M4 11h5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none"/></svg>';
  memoBtn.title = 'Toggle memo panel';
  if (memoPanel.isOpen()) memoBtn.classList.add('active');
  memoBtn.addEventListener('click', () => memoPanel.toggle());

  if (forkBtn) headerActions.appendChild(forkBtn);
  headerActions.append(memoBtn, overflowWrap, closeBtn);

  titleRow.append(titleSection, headerActions);

  header.append(titleRow);

  const termContainer = document.createElement('div');
  termContainer.className = 'terminal-container';
  termContainer.addEventListener('click', () => cached.terminal.focus());

  mountTarget.append(header, termContainer);
  if (!embedded) emptyStateEl.style.display = 'none';

  if (!termContainer.contains(cached.container)) {
    termContainer.appendChild(cached.container);
  }
  cached.container.style.display = 'block';

  if (!cached.opened) {
    cached.terminal.open(cached.container);
    cached.opened = true;
    setupImageHover(cached.terminal, cached.container);
    void hydrateTerminalFromSnapshot(sessionId, cached);
  }
  loadGpuRenderer(cached);
  setupCodexViewportScrollTracker(sessionId, cached);

  requestAnimationFrame(() => {
    const dbg = window.__scrollDebug;
    if (dbg && dbg.isOn()) dbg.log('show:raf-enter', { focus: opts.focus, ...dbg.snap(cached.terminal, sessionId) });
    const forcePtyResize = cached._hydrated && cached._needsPtyRedraw;
    fitAndResizeTerminal(sessionId, cached, { force: true, forcePtyResize });
    if (forcePtyResize) cached._needsPtyRedraw = false;
    refreshTerminalRendererSurface(cached);
    if (dbg && dbg.isOn()) dbg.log('show:after-fit', dbg.snap(cached.terminal, sessionId));
    const isCodexSession = isCodexKind(session.kind);
    const pinOnShow = !!opts.forceScrollBottom || (!isCodexSession && !!opts.focus);
    if (pinOnShow || opts.focus) {
      if (opts.forceScrollBottom) cached._codexFollowBottom = true;
      if (pinOnShow) cached.terminal.scrollToBottom();
      if (dbg && dbg.isOn()) dbg.log('show:after-stb', dbg.snap(cached.terminal, sessionId));
      if (opts.focus) cached.terminal.focus();
      const vp = cached.container.querySelector('.xterm-viewport');
      if (pinOnShow && vp) vp.scrollTop = vp.scrollHeight;
      if (dbg && dbg.isOn()) dbg.log('show:after-vp1', dbg.snap(cached.terminal, sessionId));

      // Ask xterm's Viewport to sync its inner .xterm-scroll-area height with
      // the buffer length. Without this, a session that grew while display:none
      // can have a stale (short) scrollHeight, causing wheel to max out before
      // the real buffer tail. The instance lives at `_core.viewport` in xterm
      // 5.5 (the previous attempt used `_viewport` which doesn't exist).
      // Do NOT manually set .xterm-scroll-area's height — _charSizeService.height
      // is character height, not line height (line-height multiplier missing),
      // so manual recomputation undershoots and breaks scrollHeight further.
      try {
        const vpInst = cached.terminal && cached.terminal._core && cached.terminal._core.viewport;
        if (vpInst && typeof vpInst.syncScrollArea === 'function') {
          vpInst.syncScrollArea(true);
        }
      } catch {}
      if (dbg && dbg.isOn()) dbg.log('show:after-refresh', dbg.snap(cached.terminal, sessionId));
      requestAnimationFrame(() => {
        if (pinOnShow && vp) vp.scrollTop = vp.scrollHeight;
        // Re-pin xterm's logical viewport too (scrollToBottom may have been
        // a no-op the first time when scrollArea was still stale).
        if (pinOnShow) {
          try { cached.terminal.scrollToBottom(); } catch {}
        }
        if (dbg && dbg.isOn()) dbg.log('show:raf2-final', dbg.snap(cached.terminal, sessionId));
      });
    }
  });
  scheduleVisibleTerminalRecovery(sessionId, cached, {
    pinBottom: !!opts.forceScrollBottom,
  });

  if (cached._ro) cached._ro.disconnect();
  if (cached._resizeHandler) window.removeEventListener('resize', cached._resizeHandler);
  const handleResize = () => {
    // Guard: ResizeObserver/resize can fire while the terminal's parent panel
    // is display:none (e.g. another workspace panel is active). Fitting against a zero-width
    // container collapses xterm to the minimum 1 col and the canvas stays
    // squeezed even after the panel re-opens.
    scheduleFitAndResizeTerminal(sessionId, cached);
  };
  cached._resizeHandler = handleResize;
  window.addEventListener('resize', handleResize);
  cached._ro = new ResizeObserver(handleResize);
  cached._ro.observe(cached.container);

  // Previous minimap (from a prior showTerminal call on any session) gets
  // disposed so xterm onScroll/onRender listeners don't pile up. The new
  // minimap's DOM was already removed when terminalPanelEl.innerHTML cleared.
  if (cached._minimap) { try { cached._minimap.dispose(); } catch {} cached._minimap = null; }
  if (cached._navButtons) { try { cached._navButtons.dispose(); } catch {} cached._navButtons = null; }
  cached._minimap = mountMinimap(sessionId, termContainer, cached.terminal);
  cached._navButtons = mountPromptNavButtons(sessionId, termContainer, cached._minimap);
  if (cached._floatingInput) { try { cached._floatingInput.dispose(); } catch {} cached._floatingInput = null; }
  cached._floatingInput = session.readOnly
    ? null
    : mountFloatingInput(sessionId, termContainer, cached.terminal);
  updateFloatingBarState();

  // === Spec 2 · S7: 切换 session 时加载真实历史卡片 ===
  if (!embedded && currentView === 'card') {
    // loadSessionHistoryToOverlay handles its own clear + Map.clear + placeholder
    // for empty/error/non-Claude cases. Don't pre-clear here.
    _cardHistoryHydratedSid = null; // 切 session 重置，等 loadSessionHistoryToOverlay 成功后再设
    if (typeof loadSessionHistoryToOverlay === 'function') {
      // 卡片视图切换 session 时也跳到最新对话，与上方 PTY 的 pinOnShow focus 兜底对称：
      // 切到不同 session 时靠 opts.focus；重复点击当前侧栏项时靠显式 forceScrollBottom。
      // view 切换（PTY↔卡片）走 applyViewMode 不经此处、不传 forceScrollBottom，保持阅读位置不受影响。
      loadSessionHistoryToOverlay(sessionId, { forceScrollBottom: !!opts.forceScrollBottom || !!opts.focus }).catch(err => {
        console.warn('[showTerminal] loadSessionHistoryToOverlay failed:', err);
      });
    }
  } else if (!embedded) {
    // PTY view: just clear msg-overlay (don't load cards user can't see)
    const overlay = document.getElementById('msg-overlay');
    if (overlay) {
      overlay.innerHTML = '';
      if (window._sessionTurns) window._sessionTurns.clear();
    }
    _cardHistoryHydratedSid = null;
  }
  // Spec 3 · W15：切 session 时清旧 indicator + 按新 active session 状态重建
  if (typeof _updateStreamingIndicator === 'function') {
    _updateStreamingIndicator(sessionId);
  }
}

// 初心投研复用同一套 xterm/PTY，不创建镜像终端。研究 Session 只改变挂载位置，
// 生命周期、输入、工具调用与 transcript 仍由 Hub 原生 SessionManager 管理。
window.__chuxinSessionBridge = {
  async mount(sessionId, hostEl) {
    if (!hostEl) return { ok: false, error: 'host-missing' };
    const session = sessions.get(sessionId);
    if (!session) return { ok: false, error: 'session-missing' };
    activeMeetingId = null;
    activeSessionId = sessionId;
    clearSessionAttention(session, { clearUnread: true });
    ipcRenderer.send('focus-session', { sessionId });
    hostEl.classList.add('terminal-panel', 'cx-native-terminal-mounted');
    showTerminal(sessionId, { focus: false, forceScrollBottom: true, mountTarget: hostEl });
    renderSessionList();
    return { ok: true, session };
  },
  clear(hostEl) {
    if (!hostEl) return;
    hostEl.replaceChildren();
    const empty = document.createElement('div');
    empty.className = 'cx-terminal-empty';
    empty.textContent = '选择已有 Session，或发起任务后在这里查看原生 CLI。';
    hostEl.appendChild(empty);
  },
  list() {
    return Array.from(sessions.values()).filter((row) => row && row.purpose === 'chuxin-research');
  },
};

const { createTerminalMinimapFactory } = require('./terminal-minimap.js');
const terminalMinimapFactory = createTerminalMinimapFactory({
  document,
  getTerminalCache: (sessionId) => terminalCache.get(sessionId),
  promptLineRe: PROMPT_LINE_RE,
  aiMarkersRe: AI_MARKERS_RE,
  flashPromptLine: (terminal, lineNumber) => flashPromptLine(terminal, lineNumber),
  requestAnimationFrame: (fn) => requestAnimationFrame(fn),
});
const { mountMinimap, mountPromptNavButtons } = terminalMinimapFactory;
const { createTurnCardRenderer } = require('./turn-card-renderer.js');
const turnCardRenderer = createTurnCardRenderer({
  document,
  window,
  navigator,
  CSS,
  marked,
  DOMPurify,
  formatAbsoluteTime,
  normalizeMarkdownPathBreaks,
  escapeHtml,
  wrapPathLinksInElement: (rootEl, opts) => wrapPathLinksInElement(rootEl, opts),
  getActiveSessionId: () => activeSessionId,
  updateStreamingIndicator: (sessionId) => _updateStreamingIndicator(sessionId),
  renderMathInElement: window.renderMathInElement,
});
const {
  renderTurnCard,
  mountTurnCard,
  mountOptimisticUserCard,
  turnRenderSignature,
  mountSessionTurnCard,
  isCardOverlayAtBottom: _isCardOverlayAtBottom,
} = turnCardRenderer;
const { createRecentTurnCopyController, formatRecentConversation } = require('./recent-turn-copy.js');
const recentTurnCopyController = createRecentTurnCopyController({
  document,
  window,
  navigator,
  storage: localStorage,
  getActiveSessionId: () => activeSessionId,
  getTurnById: (turnId) => window._sessionTurns && window._sessionTurns.get(turnId),
  extractVisibleCardText,
});
recentTurnCopyController.init();

async function copyRecentTurnsForSession(sessionId, count = 3) {
  const session = sessions.get(sessionId);
  if (!session) return { text: '', copiedRounds: 0, availableRounds: 0, requestedRounds: count };
  const result = await ipcRenderer.invoke('parse-session-transcript', {
    hubSessionId: sessionId,
    ccSessionId: session.ccSessionId || null,
    transcriptPath: session.transcriptPath || null,
    kind: session.kind || null,
    opts: { limit: 30, fromTail: true },
  });
  const entries = result && Array.isArray(result.turns)
    ? result.turns.map(turn => ({
      role: turn.role,
      text: turn.text,
      kind: turn.kind || session.kind,
      model: turn.model,
    }))
    : [];
  const formatted = formatRecentConversation(entries, count);
  if (!formatted.text) return formatted;
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    await navigator.clipboard.writeText(formatted.text);
  } else {
    clipboard.writeText(formatted.text);
  }
  return formatted;
}

function recordSessionArtifacts(session, text, timestamp = Date.now()) {
  if (!session || !text) return false;
  const existing = Array.isArray(session.recentArtifacts) ? session.recentArtifacts.slice(-8) : [];
  const additions = [];
  const normalized = normalizeMarkdownPathBreaks(String(text).slice(-120_000));
  const pathCandidates = collectPathCandidates(normalized, session.cwd || null, { includeDirectories: false }).slice(-24);
  for (const candidate of pathCandidates) {
    if (!candidate || candidate.isUrl || !candidate.openPath) continue;
    try {
      if (!fs.statSync(candidate.openPath).isFile()) continue;
    } catch {
      continue;
    }
    additions.push({ path: candidate.openPath, timestamp: Number(timestamp) || Date.now() });
  }
  if (!additions.length) return false;
  const byPath = new Map();
  for (const artifact of existing.concat(additions)) {
    if (!artifact || !artifact.path) continue;
    let key;
    try { key = path.resolve(artifact.path).toLowerCase(); }
    catch { key = String(artifact.path).toLowerCase(); }
    byPath.set(key, artifact);
  }
  session.recentArtifacts = Array.from(byPath.values())
    .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0))
    .slice(-8);
  return true;
}
function scheduleCodexHistoryRetry(sessionId, attempt = 0, opts = {}) {
  if (!sessionId || attempt >= 6) return;
  if (!window._codexHistoryRetryState) window._codexHistoryRetryState = new Map();
  const prev = window._codexHistoryRetryState.get(sessionId);
  if (prev && prev.timer) {
    try { clearTimeout(prev.timer); } catch {}
  }
  const delay = Math.min(1000 + attempt * 500, 3000);
  const timer = setTimeout(() => {
    window._codexHistoryRetryState.delete(sessionId);
    if (sessionId !== activeSessionId || currentView !== 'card') return;
    loadSessionHistoryToOverlay(sessionId, {
      codexRetryAttempt: attempt + 1,
      incremental: opts.incremental === true,
    }).catch(err => {
      console.warn('[codex-history-retry] reload failed:', err);
    });
  }, delay);
  window._codexHistoryRetryState.set(sessionId, { timer, attempt });
}

// === Spec 2 v1.0.0 · S5 loadSessionHistoryToOverlay ===
// Load historical turns for a session and mount them as cards into #msg-overlay.
//
// Used by:
//   - showTerminal (S7) when switching to a Claude/Codex/Kimi session in card view
//   - User explicit "reload history" action (future)
//
// Workflow:
//   1. Resolve container = #msg-overlay; missing → warn + bail
//   2. Clear container + clear _sessionTurns Map (multi-session safety)
//   3. Look up session via existing `sessions` Map (showTerminal pattern, line ~1080)
//   4. unsupported kind (outside Claude/Codex/Kimi families) → friendly placeholder, skip IPC
//   5. invoke('parse-session-transcript', { hubSessionId, ccSessionId, opts })
//   6. Handle result:
//      - turns.length === 0 → placeholder ("会话尚未产生历史" or error text)
//      - turns.length > 0   → loop mountSessionTurnCard, then ONE bottom-scroll
//        (don't autoScroll per mount — would jitter and force N reflows)
//   7. Return { mounted, error }
//
// Boundary notes:
//   * Does NOT touch showTerminal — S7 will integrate
//   * Does NOT register IPC listeners for turn-complete-event — that's S6
//   * Falls back to ipcRenderer.invoke even if `sessions.get` returns null;
//     main.js handler does its own session lookup and returns
//     'transcript not found' for unknown ids — we display that as the error.
async function loadSessionHistoryToOverlay(sessionId, opts = {}) {
  // Spec 3 · B1 增量 mount：opts.incremental=true 时不清 container/Map，
  // 依赖 mountSessionTurnCard 内的 turnId dedup 自动跳过已 mount 的 turn。
  // 用于 throttle reload（同 sessionId 反复）— 把"全清重建"压成"只 append 新增"。
  // 切 session 时调用方传默认（incremental=false）走全量。
  const incremental = opts.incremental === true;
  const forceScrollBottom = opts.forceScrollBottom === true;

  // 1. resolve container
  const container = document.getElementById('msg-overlay');
  if (!container) {
    console.warn('[loadSessionHistoryToOverlay] container not found (msg-overlay missing)');
    return { mounted: 0, error: 'container missing' };
  }
  const overlayScrollBeforeLoad = {
    top: container.scrollTop,
    wasAtBottom: forceScrollBottom || _isCardOverlayAtBottom(container),
  };

  // 2. clear container + Map (avoid stale turns from previous session)
  if (!incremental) {
    container.innerHTML = '';
    if (!window._sessionTurns) window._sessionTurns = new Map();
    window._sessionTurns.clear();
    turnCardRenderer.clearTurnRenderSignatures();
  } else if (!window._sessionTurns) {
    window._sessionTurns = new Map();
  }

  // helper: render a placeholder line inside the cleared container.
  // Incremental refreshes must never call this: a transient empty/error result
  // is not evidence that already-rendered authoritative turns disappeared.
  const showPlaceholder = (html) => {
    container.innerHTML =
      '<div class="msg-overlay-placeholder">' + html + '</div>';
  };

  // 3. look up session info — same pattern as showTerminal (line ~1080)
  let session = null;
  try {
    if (typeof sessions !== 'undefined' && sessions && typeof sessions.get === 'function') {
      session = sessions.get(sessionId) || null;
    }
  } catch (err) {
    console.warn('[loadSessionHistoryToOverlay] sessions.get threw:', err);
  }
  const ccSessionId = session ? (session.ccSessionId || null) : null;
  const transcriptPath = session ? (session.transcriptPath || null) : null;
  const kind = session ? (session.kind || null) : null;

  // 4. kind gate — all transcript-backed coding CLIs share the card experience.
  const supportsCardHistory = kind && (isClaudeFamily(kind) || isCodexKind(kind) || isKimiCliKind(kind));
  if (kind && !supportsCardHistory) {
    showPlaceholder(
      '卡片视图当前支持 Claude、Codex 与 Kimi session — '
      + '<a href="#" data-action="switch-to-pty">切到 PTY 视图</a>'
    );
    return { mounted: 0, error: null };
  }

  // Full hydration and streaming incremental refreshes are independent lanes.
  // A terminal-data refresh can start while the initial full-history parse is
  // still running. If both lanes share one generation, the cheap limit:1
  // refresh invalidates the authoritative full result and leaves the overlay
  // stuck at "loading" with only the newest assistant card. Keep newest-wins
  // semantics within each lane while preserving the session/view ownership
  // guards shared by both.
  const loadLane = incremental ? 'incremental' : 'full';
  const loadSeq = Date.now() + ':' + Math.random().toString(36).slice(2);
  if (!window._cardLoadSeqBySid) window._cardLoadSeqBySid = new Map();
  const previousLoadSeqs = window._cardLoadSeqBySid.get(sessionId);
  const loadSeqs = previousLoadSeqs && typeof previousLoadSeqs === 'object'
    ? { ...previousLoadSeqs }
    : {};
  loadSeqs[loadLane] = loadSeq;
  window._cardLoadSeqBySid.set(sessionId, loadSeqs);
  const isStaleLoad = () => (
    sessionId !== activeSessionId
    || currentView !== 'card'
    || !window._cardLoadSeqBySid.get(sessionId)
    || window._cardLoadSeqBySid.get(sessionId)[loadLane] !== loadSeq
  );
  if (!incremental) {
    showPlaceholder('正在加载历史卡片…');
  }

  // 5. invoke IPC (let main.js apply default opts: limit:50, fromTail:true)
  let result;
  try {
    result = await ipcRenderer.invoke('parse-session-transcript', {
      hubSessionId: sessionId,
      ccSessionId,
      transcriptPath,
      kind,
      opts: opts.parseOpts,
    });
  } catch (err) {
    if (isStaleLoad()) return { mounted: 0, error: 'stale load' };
    const msg = (err && err.message) ? err.message : String(err);
    console.warn('[loadSessionHistoryToOverlay] IPC invoke threw:', err);
    if (!incremental) {
      showPlaceholder(
        '加载历史失败：' + msg + ' — '
        + '<a href="#" data-action="switch-to-pty">切到 PTY 视图查看终端</a>'
      );
    }
    return { mounted: 0, error: msg };
  }
  if (isStaleLoad()) return { mounted: 0, error: 'stale load' };
  if (result && result.transcriptPath && session && session.transcriptPath !== result.transcriptPath) {
    session.transcriptPath = result.transcriptPath;
    if (typeof schedulePersist === 'function') schedulePersist();
  }
  if (result && typeof result.parseMs === 'number' && result.parseMs > 150) {
    console.warn('[loadSessionHistoryToOverlay] slow parse', {
      sessionId,
      parseMs: result.parseMs,
      transcriptPath: result.transcriptPath || transcriptPath || null,
      incremental,
    });
  }

  const turns = (result && Array.isArray(result.turns)) ? result.turns : [];
  const ipcError = (result && result.error) ? result.error : null;
  // A streaming incremental result can land while this full parse is in
  // flight. Those cards are newer than the full snapshot and must survive the
  // authoritative history rebuild even when that snapshot does not contain
  // them yet.
  const concurrentFullCards = !incremental
    ? Array.from(container.querySelectorAll(':scope > .turn-card'))
    : [];
  const removeLoadingPlaceholder = () => {
    const placeholder = container.querySelector(':scope > .msg-overlay-placeholder');
    if (placeholder) placeholder.remove();
  };

  // 6a. error AND no turns → friendly placeholder (don't silent fail)
  if (turns.length === 0 && ipcError) {
    // Spec 3 · W11：transcript not found 通常是 session 创建后从未发过消息（无 ccSessionId 写入）。
    // 不是 bug，是 expected。文案明示让 user 不再误以为"卡片视图坏了"。
    let txt;
    if (ipcError === 'transcript not found') {
      const ccSid = ccSessionId || (session && session.ccSessionId);
      txt = ccSid
        ? `会话尚未产生历史（transcript 文件可能已被移走或删除：${ccSid.slice(0, 8)}…）`
        : '此会话从未发送过消息，无对话历史可显示';
    } else if (isCodexKind(kind) && ipcError === 'codex rollout not found') {
      const attempt = Number.isInteger(opts.codexRetryAttempt) ? opts.codexRetryAttempt : 0;
      if (attempt < 6) {
        scheduleCodexHistoryRetry(sessionId, attempt, { incremental });
        txt = '正在绑定 Codex 历史（resume 后通常需要几秒）';
      } else {
        txt = '加载历史失败：Codex rollout 尚未绑定或已被移动';
      }
    } else {
      txt = '加载历史失败：' + ipcError;
    }
    if (!incremental && concurrentFullCards.length === 0) {
      showPlaceholder(
        txt + ' — '
        + '<a href="#" data-action="switch-to-pty">切到 PTY 视图查看终端</a>'
      );
    } else if (!incremental) {
      removeLoadingPlaceholder();
    }
    return { mounted: 0, error: ipcError };
  }

  // 6b. no turns, no error → fresh session
  if (turns.length === 0) {
    if (window._codexHistoryRetryState) {
      const st = window._codexHistoryRetryState.get(sessionId);
      if (st && st.timer) { try { clearTimeout(st.timer); } catch {} }
      window._codexHistoryRetryState.delete(sessionId);
    }
    if (!incremental) {
      if (concurrentFullCards.length === 0) {
        showPlaceholder(
          '新会话，发首条消息试试看 — '
          + '<a href="#" data-action="switch-to-pty">切到 PTY 视图</a>'
        );
      } else {
        removeLoadingPlaceholder();
      }
    }
    // 空 session 也算 hydrated:已经确认"历史为空",后续 turn-complete 走增量
    // 挂卡 + 250ms 补全 reload 即可,不必再触发全量。否则首条消息发出后,
    // mountOptimisticUserCard 把 placeholder 隐藏,turn-complete 又看到 hydrated=null
    // 反而触发全量 reload → 闪烁。
    if (!incremental) _cardHistoryHydratedSid = sessionId;
    return { mounted: concurrentFullCards.length, error: null };
  }

  // 6c. mount each turn; pass kind through opts so renderTurnCard picks it up.
  if (window._codexHistoryRetryState) {
    const st = window._codexHistoryRetryState.get(sessionId);
    if (st && st.timer) { try { clearTimeout(st.timer); } catch {} }
    window._codexHistoryRetryState.delete(sessionId);
  }
  // Use a default kind 'claude' if session lookup failed but main.js still
  // returned turns — they came from a Claude transcript by definition.
  const mountKind = kind || 'claude';
  const fullTurnIds = !incremental ? new Set(turns.map(turn => turn && turn.id).filter(Boolean)) : null;
  const concurrentExtraCards = !incremental
    ? concurrentFullCards.filter(card => !fullTurnIds.has(card.dataset.turnId))
    : [];
  if (!incremental) {
    removeLoadingPlaceholder();
  }
  // 2026-05-06 道雪 scroll-respect-user (Codex 多方审查发现):
  //   incremental=true 路径(streaming partial-update throttle)反复触发本函数,
  //   末尾的 batch scrollIntoView 没 guard → 用户上翻历史时仍被拍回底部。
  //   incremental=false(切 session): line 2179 已清 container.innerHTML='' →
  //     scrollTop=0/scrollHeight=0 → helper 自然返回 true → 初次加载行为不退化。
  //   incremental=true(throttle reload): container 保留旧内容 → 反映用户真实位置。
  const _batchWasAtBottom = forceScrollBottom || (incremental ? _isCardOverlayAtBottom(container) : overlayScrollBeforeLoad.wasAtBottom);
  let mounted = 0;
  let lastCardEl = null;
  for (const turn of turns) {
    const cardEl = mountSessionTurnCard(sessionId, turn, { kind: mountKind });
    if (cardEl) {
      mounted++;
      lastCardEl = cardEl;
    }
  }

  if (!incremental) {
    // Mounting dedups existing concurrent cards but may leave them ahead of old
    // history. Reorder the authoritative full snapshot first, then append only
    // genuinely newer concurrent cards. Cards removed by optimistic/provisional
    // dedup are intentionally skipped here.
    const streamingTail = container.querySelector(':scope > .streaming-indicator');
    const placeBeforeStreamingTail = (card) => {
      if (!card || card.parentNode !== container) return;
      if (streamingTail && streamingTail.parentNode === container) {
        container.insertBefore(card, streamingTail);
      } else {
        container.appendChild(card);
      }
    };
    for (const turn of turns) {
      if (!turn || !turn.id) continue;
      placeBeforeStreamingTail(container.querySelector(
        `:scope > .turn-card[data-turn-id="${CSS.escape(turn.id)}"]`
      ));
    }
    let lastConcurrentCard = null;
    for (const card of concurrentExtraCards) {
      placeBeforeStreamingTail(card);
      if (card.parentNode === container) lastConcurrentCard = card;
    }
    if (lastConcurrentCard) lastCardEl = lastConcurrentCard;
  }

  // Single bottom-scroll AFTER loop (don't autoScroll per mount — N reflows = jitter)
  // — 仅当 batch 开始前用户在底部才滚(scroll-respect-user)
  if (lastCardEl && _batchWasAtBottom) {
    try {
      lastCardEl.scrollIntoView({ behavior: 'auto', block: 'end' });
    } catch {
      container.scrollTop = container.scrollHeight;
    }
    // scrollIntoView(block:end) 会把最后一张卡对齐，却不包含 overlay 的底部 padding，
    // 显式侧栏导航仍会留下约 20px 缝隙。强制请求要贴到真正的 scrollHeight 尾端；
    // 下一帧再钉一次，覆盖 markdown/KaTeX 在首帧完成后的轻微高度变化。
    if (forceScrollBottom) {
      const pinOverlayToBottom = () => { container.scrollTop = container.scrollHeight; };
      pinOverlayToBottom();
      requestAnimationFrame(pinOverlayToBottom);
    }
  } else if (!incremental && !_batchWasAtBottom) {
    container.scrollTop = Math.min(
      overlayScrollBeforeLoad.top,
      Math.max(0, container.scrollHeight - container.clientHeight),
    );
  }

  // Mark history as hydrated for this session (non-incremental full load only)
  if (!incremental && mounted > 0) {
    _cardHistoryHydratedSid = sessionId;
  }

  return { mounted, error: null };
}
window._loadSessionHistoryToOverlay = loadSessionHistoryToOverlay;

ipcRenderer.on('prompt-submitted-event', (_event, payload) => {
  onPromptSubmittedFromTranscriptEvent(payload);
});

ipcRenderer.on('turn-started-event', (_event, payload) => {
  // Reuse the ordered prompt/completion reducer, but keep the transport event
  // distinct: task_started may represent an automatic /goal continuation and
  // therefore has no user-authored preview text.
  onPromptSubmittedFromTranscriptEvent({
    ...(payload || {}),
    text: '',
    submittedAt: payload && payload.startedAt,
  });
});

ipcRenderer.on('turn-aborted-event', (_event, payload) => {
  const { hubSessionId, abortedAt, turnId, kind } = payload || {};
  if (!hubSessionId || !isTranscriptCliKind(kind)) return;
  const session = sessions.get(hubSessionId);
  if (!session || session.status === 'dormant') return;
  const transition = applyTurnAborted(session, { abortedAt, turnId });
  if (!transition.applied) return;
  clearCodexCardWorking(hubSessionId);
  session.status = 'idle';
  if (typeof _updateStreamingIndicator === 'function') _updateStreamingIndicator(hubSessionId);
  scheduleSessionListRender();
  schedulePersist();
});

ipcRenderer.on('background-work-event', (_event, payload) => {
  onKimiBackgroundWorkEvent(payload);
});

// === Spec 2 v1.0.0 · S6 turn-complete-event listener ===
// main.js (S3) broadcasts 'turn-complete-event' whenever an assistant turn
// finishes streaming. Append the just-completed turn as a card to #msg-overlay
// for the active Claude/Codex session in card view.
//
// Skip conditions (each is a multi-instance / multi-view safety guard):
//   - meetingId truthy → AI 群聊 has its own card pipeline (renderer/meeting-room.js)
//   - hubSessionId !== activeSessionId → other sessions' new turns shouldn't pop
//     up under the active session's overlay
//   - currentView !== 'card' → PTY view doesn't use the overlay; building DOM
//     nobody sees is wasteful
//
// Why re-invoke parse-session-transcript instead of trusting payload.text:
//   The S3 payload only carries plain text. The structured turn (thinking,
//   toolCalls, model, stopReason, usage, id, ts) lives in the JSONL transcript
//   and is parsed by S1's parse-session-transcript. Calling it with limit:1
//   fromTail:true returns the just-completed turn fully structured. Fallback to
//   payload-only turn on IPC error keeps the user from seeing nothing.
ipcRenderer.on('turn-complete-event', async (_event, payload) => {
  const {
    hubSessionId,
    transcriptPath,
    text,
    completedAt,
    meetingId,
    kind,
  } = payload || {};

  onReplyCompleteFromTranscriptEvent(payload);

  if (!meetingId && window.WorkspaceController) {
    void window.WorkspaceController.maybePromptSessionArchive(hubSessionId);
  }

  // 1. AI 群聊 path — meeting-room.js handles its own card rendering
  if (meetingId) return;

  // 2. multi-session safety — only render for currently active session
  if (hubSessionId !== activeSessionId) return;

  // 3. only render in card view (PTY view doesn't use msg-overlay)
  if (currentView !== 'card') return;

  // 4. If history was never fully hydrated for this session, trigger backfill
  //    before appending the single new turn. Use explicit state flag instead of
  //    DOM placeholder detection — placeholder can be removed by optimistic card
  //    (mountOptimisticUserCard) before we get here, breaking the old check.
  if (_cardHistoryHydratedSid !== hubSessionId) {
    if (typeof loadSessionHistoryToOverlay === 'function') {
      try {
        const r = await loadSessionHistoryToOverlay(hubSessionId);
        if (r && r.mounted > 0) {
          _cardHistoryHydratedSid = hubSessionId;
          // 全量 reload 已经把最新 turn 也挂上去了(fromTail+limit:50 含末条),
          // 不必再走下面的 limit:1 IPC + mount(dedup 会跳过,但浪费一次 IPC)。
          return;
        }
      } catch (err) {
        console.warn('[turn-complete-event] history backfill failed:', err);
      }
    }
  }

  // 5. 挂完 limit:1 增量卡后,立即 trigger incremental reload 兜底:
  //    2026-05-24 道雪 — 原版 setTimeout 350ms debounce 被 race 失效（隔离 Hub
  //    stress-3 实测：禁用 setTimeout 后 cards 卡在残缺数量持久化）。改成立即
  //    触发 + Promise 级 in-flight guard：每 turn-complete 至多 1 个 backfill
  //    在跑且必定执行，不再被 timer cancel/clear 取消。incremental=true 时
  //    mountSessionTurnCard 内 dedup 保证不重复挂卡,只把增量分支漏掉的旧 turn
  //    补回来。
  const scheduleBackfill = () => {
    if (_turnCompleteBackfillTimers.has(hubSessionId)) return; // in-flight guard
    if (hubSessionId !== activeSessionId || currentView !== 'card') return;
    if (typeof loadSessionHistoryToOverlay !== 'function') return;
    const p = loadSessionHistoryToOverlay(hubSessionId, { incremental: true })
      .catch(err => console.warn('[turn-complete backfill] incremental reload failed:', err))
      .finally(() => _turnCompleteBackfillTimers.delete(hubSessionId));
    _turnCompleteBackfillTimers.set(hubSessionId, p);
  };

  try {
    const r = await ipcRenderer.invoke('parse-session-transcript', {
      hubSessionId,
      transcriptPath,
      opts: { limit: 1, fromTail: true },
    });
    if (hubSessionId !== activeSessionId || currentView !== 'card') return;

    if (r && !r.error && Array.isArray(r.turns) && r.turns.length > 0) {
      // got the structured turn from S1 parser
      const turn = r.turns[0];
      // turn-complete should always be assistant; defend against future broadcast scope changes
      if (turn.role !== 'assistant') return;
      // Dedup: skip if turn already mounted (race with loadSessionHistoryToOverlay)
      if (window._sessionTurns && window._sessionTurns.has(turn.id)) {
        scheduleBackfill();
        return;
      }
      if (document.querySelector('.turn-card[data-turn-id="' + CSS.escape(turn.id) + '"]')) {
        scheduleBackfill();
        return;
      }
      mountSessionTurnCard(hubSessionId, turn, { kind, autoScroll: true });
      scheduleBackfill();
      return;
    }

    // transcript 还没落盘（Codex rollout 尤其常见）时的兜底卡。
    // 它的 id 是合成的 `turn-<时间戳>`，与 transcript 里真实 turn 的 id 毫无关系——
    // 紧接着 scheduleBackfill 重新解析、用真实 id 再挂一次，dedup 拦不住，
    // 于是同一条回答出现两遍（用户反馈的"回答卡片重复"）。
    // 解法与 optimistic user card 同款：打上 provisional 标记，真卡到达时顶掉它。
    const fallbackTurn = {
      id: 'turn-' + (completedAt || Date.now()),
      role: 'assistant',
      text: text || '',
      ts: completedAt || Date.now(),
      kind,
    };
    // Dedup: skip if turn already mounted (race with loadSessionHistoryToOverlay)
    if (window._sessionTurns && window._sessionTurns.has(fallbackTurn.id)) {
      scheduleBackfill();
      return;
    }
    if (document.querySelector('.turn-card[data-turn-id="' + CSS.escape(fallbackTurn.id) + '"]')) {
      scheduleBackfill();
      return;
    }
    const fallbackEl = mountSessionTurnCard(hubSessionId, fallbackTurn, { kind, autoScroll: true });
    if (fallbackEl) {
      fallbackEl.dataset.provisional = 'true';
      fallbackEl.dataset.provisionalText = fallbackTurn.text || '';
    }
    scheduleBackfill();
  } catch (err) {
    console.warn('[turn-complete-event] failed to render new turn:', err);
  }
});

function wrapPathLinksInElement(rootEl, opts = {}) {
  if (!rootEl) return;
  const cwd = opts.cwd || getSessionCwd(opts.sessionId || activeSessionId) || null;
  // marked 已经生成的 <a> 过去会被下面的 TreeWalker 故意跳过，因此
  // [报告](C:\path\report.md) 只剩“报告”文字，且点击绕过 Hub。本地 href
  // 先升级成统一 rt-file-link；网页 URL 仍保持标准 Markdown 链接语义。
  for (const a of rootEl.querySelectorAll('a[href]:not(.rt-file-link)')) {
    const local = classifyLocalPathHref(a.getAttribute('href') || '', cwd);
    if (!local) continue;
    a.classList.add('rt-file-link');
    a.setAttribute('data-path', local.openPath);
    a.setAttribute('href', '#');
    a.title = local.openPath === local.displayPath
      ? local.openPath
      : `打开 ${local.openPath}（CLI 原文：${local.displayPath}）`;
    // 本地路径不能像网页 URL 那样只显示描述文字，否则卡片会丢失 CLI 中
    // 真正的路径信息。显示原始 destination，data-path 则使用纠错后的路径。
    a.textContent = local.displayPath;
  }
  const SKIP_TAGS = new Set(['A', 'SCRIPT', 'STYLE']);
  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      let p = node.parentNode;
      while (p && p !== rootEl) {
        if (p.nodeType === 1 && SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
        p = p.parentNode;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const targets = [];
  let node;
  while ((node = walker.nextNode())) {
    const text = normalizeMarkdownPathBreaks(node.nodeValue);
    const candidates = collectPathCandidates(text, cwd);
    if (candidates.length > 0) targets.push({ textNode: node, text, candidates });
  }
  for (const { textNode, text, candidates } of targets) {
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const c of candidates) {
      if (c.start < last) continue;
      if (c.start > last) frag.appendChild(document.createTextNode(text.slice(last, c.start)));
      const a = document.createElement('a');
      a.className = 'rt-file-link';
      a.setAttribute('data-path', c.openPath);
      a.title = c.openPath;
      a.textContent = text.slice(c.start, c.end + 1);
      frag.appendChild(a);
      last = c.end + 1;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    textNode.parentNode.replaceChild(frag, textNode);
  }
}
window.wrapPathLinksInElement = wrapPathLinksInElement;

// rt-file-link click → openPreviewPanel (only for cards inside .msg-overlay,
// don't conflict with meeting-room.js handler which targets its own scope)
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a.rt-file-link');
  if (!a) return;
  if (!a.closest('.msg-overlay')) return;
  e.preventDefault();
  e.stopPropagation();
  const path = a.dataset.path;
  if (path) openPathInHub(path, { cwd: getSessionCwd(activeSessionId), requireExistsForRel: false });
}, true);

// === Spec 1 v0.9.0 · D5 操作按钮 click ===
function getTurnFromCard(cardEl) {
  if (!cardEl || !window._sessionTurns) return null;
  return window._sessionTurns.get(cardEl.dataset.turnId);
}

// 卡片上的操作必须作用于「这张卡片所属的会话」，而不是全局激活的那个。
//
// 2026-07-28 串台事故：用户在群聊 A 里单独打开 Kimi 的卡片视图、对着一张历史
// 卡片重发提问，消息却发到了群聊 B 的 Claude —— 因为 resend / regen /
// prompt-inspect 三处都直接取全局 activeSessionId。只要用户上一次交互把焦点
// 落在别的会话上，卡片操作就会打到错误的 CLI，而且两边界面都看不出异常。
//
// turn-card-renderer 早就把 sessionId 存进了 cardEl.dataset.sessionId
// （见该文件 rerenderTurn 附近的注释），这里以它为准；只有实在拿不到才退回
// 全局值。
function getCardSessionId(cardEl) {
  const own = cardEl && cardEl.dataset && cardEl.dataset.sessionId;
  if (own) return own;
  return (typeof activeSessionId !== 'undefined' && activeSessionId)
    || (typeof currentSessionId !== 'undefined' && currentSessionId)
    || null;
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.ta-btn');
  if (!btn) return;
  const card = btn.closest('.turn-card');
  if (!card || !card.closest('.msg-overlay')) return;
  const turn = getTurnFromCard(card);
  if (!turn) return;
  const action = btn.dataset.action;

  if (action === 'copy') {
    // 复制用户实际看到的回答正文，不复制 markdown 围栏、toolCalls 原始块，
    // 也不把 hover 出来的 Copy/Bash/展开按钮混进剪贴板。
    const visibleText = extractVisibleCardText(card.querySelector('.turn-body'));
    navigator.clipboard.writeText(visibleText).then(() => {
      const orig = btn.textContent;
      btn.textContent = '✓';
      setTimeout(() => { btn.textContent = orig; }, 1500);
    }).catch(() => {});
    return;
  }

  if (action === 'prompt-inspect') {
    const sid = getCardSessionId(card);
    if (typeof window.togglePromptInspector === 'function') {
      window.togglePromptInspector(card, sid);
    }
    return;
  }

  if (action === 'resend' || action === 'regen') {
    // Resend = same user prompt; regen = find prior user prompt then resend
    let promptText = null;
    if (action === 'resend') {
      promptText = turn.text;
    } else {
      // regen: walk DOM up looking for prior user .turn-card
      const cards = [...document.querySelectorAll('.msg-overlay .turn-card')];
      const myIdx = cards.indexOf(card);
      for (let i = myIdx - 1; i >= 0; i--) {
        if (cards[i].classList.contains('user')) {
          const userTurn = getTurnFromCard(cards[i]);
          if (userTurn) promptText = userTurn.text;
          break;
        }
      }
    }
    if (!promptText) return;
    // 复用 terminal-input IPC，不新增 channel。
    // sid 必须取自这张卡片（getCardSessionId），不能用全局 activeSessionId ——
    // 否则在 A 会话的卡片上点重发，消息会打进当时恰好激活的 B 会话。
    const sid = getCardSessionId(card);
    if (sid && typeof ipcRenderer !== 'undefined') {
      armPtyBurstFallback(sid);
      ipcRenderer.send('terminal-input', { sessionId: sid, data: promptText + '\r' });
    }
    const orig = btn.textContent;
    btn.textContent = '↺';
    setTimeout(() => { btn.textContent = orig; }, 1500);
    return;
  }

  if (action === 'edit-resend') {
    // Hub uses contenteditable div for input (not textarea):
    // - Single session: `<div class="floating-input-box" contenteditable>`
    // - Group chat: `<div id="mr-input-box" contenteditable>`
    // 输入框是按会话挂载的（mountFloatingInput 闭包绑定 sessionId），而这里用
    // document.querySelector 全局取第一个 —— 命中的很可能是另一个会话的框，
    // 文本填进去、用户一回车就发去了错误的 CLI。卡片不属于当前激活会话时直接
    // 拒绝，宁可少一次便利也不要串台（2026-07-28）。
    const cardSid = getCardSessionId(card);
    const liveSid = (typeof activeSessionId !== 'undefined' && activeSessionId) || null;
    if (cardSid && liveSid && String(cardSid) !== String(liveSid)) {
      console.warn('[edit-resend] 卡片属于会话', cardSid, '，当前激活的是', liveSid,
        '——已跳过填入，避免把内容写进别的会话的输入框');
      return;
    }
    const inputEl = document.querySelector('.floating-input-box')
      || document.getElementById('mr-input-box');
    if (inputEl) {
      // 2026-05-09 道雪：用户原则 — 输入框只能由"发送 / 手动编辑"改动；
      // 已有内容时 edit-resend 不再覆盖（避免吞掉用户正在写的内容）。
      const cur = (inputEl.innerText || '').trim();
      if (cur) {
        console.warn('[edit-resend] 输入框已有内容，跳过自动填入历史消息');
        return;
      }
      inputEl.textContent = turn.text || '';
      inputEl.focus();
      // Place cursor at end (contenteditable doesn't have setSelectionRange)
      try {
        const range = document.createRange();
        range.selectNodeContents(inputEl);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } catch {}
    }
    return;
  }
});

// === Spec 1 v0.9.0 · 视图切换 ===
// 默认 PTY（卡片视图作为可选第二视图，不破坏 PTY 主流程）— 2026-05-04 用户反馈
let currentView = 'pty'; // 'card' | 'pty'
const { createCardQuestionNavigator } = require('./card-question-navigator.js');
const cardQuestionNavigator = createCardQuestionNavigator({
  document,
  window,
  overlay: document.getElementById('msg-overlay'),
  root: document.getElementById('card-question-nav'),
  getCurrentView: () => currentView,
  getActiveSessionId: () => activeSessionId,
  getTurnById: (turnId) => window._sessionTurns && window._sessionTurns.get(turnId),
  requestAnimationFrame: callback => requestAnimationFrame(callback),
  cancelAnimationFrame: handle => cancelAnimationFrame(handle),
});
cardQuestionNavigator.init();

// === Spec 3 · W15+W16: streaming indicator ===
// session.status === 'running' 表示 PTY 最近有数据（>200 byte burst within silence window）。
// 卡片视图下 active session 跑 running 时在 overlay 末尾显示三个跳动的紫色点 + 文案，
// 让用户瞬间感知"agent 还在干活"，不必盯 PTY 视图。
//
// W16 改进：
// (1) 防 flash 延迟移除：assistant 一轮完成（end_turn）→ 短暂 silence → status=idle，
//     接着可能又有下一轮 → status=running。中间 gap 让 indicator 闪烁，不友好。
//     status idle 时延迟 1.5s 才移除（gap < 1.5s 时 indicator 视觉上保持显示）。
// (2) 文案动态：0 卡时显示"Claude 正在思考…"（首响应等待）；
//     ≥1 卡时显示"Claude 还在生成更多回复…"（暗示后续还有，user 关心的核心）。
const _W16_DELAYED_REMOVE_MS = 1500;
const _w16RemoveTimers = new Map(); // sessionId → setTimeout id
const _codexSubmitPendingTimers = new Map(); // sessionId -> setTimeout id
const _kimiBackgroundFinishTimers = new Map(); // sessionId -> setTimeout id
const _CODEX_CARD_SUBMIT_PENDING_MS = 15 * 1000;
const _CODEX_CARD_WORK_MAX_MS = 45 * 60 * 1000;
const _KIMI_BACKGROUND_FINISH_GRACE_MS = 30 * 1000;

function markCodexCardWorking(sessionId, source = 'prompt') {
  const session = sessions.get(sessionId);
  if (!session || !isTranscriptCliKind(session.kind) || session.status === 'dormant') return;
  if (_codexSubmitPendingTimers.has(sessionId)) {
    clearTimeout(_codexSubmitPendingTimers.get(sessionId));
    _codexSubmitPendingTimers.delete(sessionId);
  }
  if (source === 'floating_input') {
    applyPromptSubmitted(session, { submittedAt: Date.now() });
  } else {
    clearSessionAttention(session);
  }
  session.cardWorkingSince = Date.now();
  if (!session.runStartedAt) session.runStartedAt = session.cardWorkingSince;
  session.cardWorkingSource = source;
  session.status = 'running';
  session._agentWorking = 'card';
  session._runSource = 'semantic';
  session._lastOutputTs = Date.now();
  if (typeof _updateStreamingIndicator === 'function') _updateStreamingIndicator(sessionId);
  if (source === 'floating_input') {
    const timer = setTimeout(() => {
      _codexSubmitPendingTimers.delete(sessionId);
      const latest = sessions.get(sessionId);
      if (!latest || latest.cardWorkingSource !== 'floating_input') return;
      latest.cardWorkingSince = null;
      latest.cardWorkingSource = null;
      latest._agentWorking = null;
      latest._runSource = null;
      latest.runStartedAt = null;
      latest.status = 'idle';
      disarmPtyBurstFallback(latest);
      if (typeof _updateStreamingIndicator === 'function') _updateStreamingIndicator(sessionId);
      scheduleSessionListRender();
    }, _CODEX_CARD_SUBMIT_PENDING_MS);
    _codexSubmitPendingTimers.set(sessionId, timer);
  }
}

function clearCodexCardWorking(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (_codexSubmitPendingTimers.has(sessionId)) {
    clearTimeout(_codexSubmitPendingTimers.get(sessionId));
    _codexSubmitPendingTimers.delete(sessionId);
  }
  session.cardWorkingSince = null;
  session.cardWorkingSource = null;
  session._agentWorking = null;
  session._runSource = null;
  disarmPtyBurstFallback(session);
}

function hasKimiBackgroundWork(session) {
  return !!(
    session
    && session._kimiBackgroundJobs instanceof Set
    && session._kimiBackgroundJobs.size > 0
  );
}

function clearKimiBackgroundFinishTimer(sessionId) {
  const timer = _kimiBackgroundFinishTimers.get(sessionId);
  if (!timer) return;
  clearTimeout(timer);
  _kimiBackgroundFinishTimers.delete(sessionId);
}

function onKimiBackgroundWorkEvent(payload) {
  const { hubSessionId, phase, jobId } = payload || {};
  if (!hubSessionId || !jobId) return;
  const session = sessions.get(hubSessionId);
  if (!session || !isKimiCliKind(session.kind) || session.status === 'dormant') return;
  if (!(session._kimiBackgroundJobs instanceof Set)) session._kimiBackgroundJobs = new Set();

  if (phase === 'started') {
    clearKimiBackgroundFinishTimer(hubSessionId);
    session._kimiBackgroundJobs.add(String(jobId));
    markCodexCardWorking(hubSessionId, 'kimi_background_agent');
    scheduleSessionListRender();
    schedulePersist();
    return;
  }

  if (phase !== 'finished') return;
  session._kimiBackgroundJobs.delete(String(jobId));
  if (hasKimiBackgroundWork(session)) {
    markCodexCardWorking(hubSessionId, 'kimi_background_agent');
    scheduleSessionListRender();
    return;
  }

  // tool.result is normally followed by Kimi's final step.end, which clears the
  // working state through the existing turn-complete path. If that record is
  // missing, stop showing a stale green light after a short grace period.
  clearKimiBackgroundFinishTimer(hubSessionId);
  const timer = setTimeout(() => {
    _kimiBackgroundFinishTimers.delete(hubSessionId);
    const latest = sessions.get(hubSessionId);
    if (!latest || hasKimiBackgroundWork(latest)) return;
    if (latest.cardWorkingSource !== 'kimi_background_agent') return;
    clearCodexCardWorking(hubSessionId);
    if (latest.status === 'running') latest.status = 'idle';
    if (typeof _updateStreamingIndicator === 'function') _updateStreamingIndicator(hubSessionId);
    scheduleSessionListRender();
    schedulePersist();
  }, _KIMI_BACKGROUND_FINISH_GRACE_MS);
  _kimiBackgroundFinishTimers.set(hubSessionId, timer);
}

function hasSemanticCardWorking(session) {
  if (!session) return false;
  if (!isTranscriptCliKind(session.kind) || sessionNeedsUserInput(session) || !session.cardWorkingSince) return false;
  const maxAge = session.cardWorkingSource === 'floating_input'
    ? _CODEX_CARD_SUBMIT_PENDING_MS
    : _CODEX_CARD_WORK_MAX_MS;
  if (Date.now() - session.cardWorkingSince > maxAge) {
    session.cardWorkingSince = null;
    session.cardWorkingSource = null;
    return false;
  }
  return true;
}

function isSessionCardWorking(session) {
  if (!session) return false;
  return session.status === 'running' || hasSemanticCardWorking(session);
}

function cardWorkingLabel(session) {
  if (!session) return 'AI';
  const base = isCodexKind(session.kind) ? 'Codex' : isKimiCliKind(session.kind) ? 'Kimi' : (session.kind || 'AI');
  return base.charAt(0).toUpperCase() + base.slice(1).replace(/-resume$/i, '');
}

function _updateStreamingIndicator(sessionId) {
  if (sessionId !== activeSessionId) return;
  const overlay = document.getElementById('msg-overlay');
  if (!overlay) return;
  const sess = sessions.get(sessionId);
  const isRunning = isSessionCardWorking(sess);
  // 多方审查 P1 (DeepSeek + Claude 共识)：querySelector 不带 dataset 过滤会拿到
  // 别 session 残留的 indicator（1.5s 延迟移除期间），快速切 session 时新 session
  // 会"接管"旧 indicator 导致显示错乱或 timer 触发时误删新 session 的 indicator。
  // 加 [data-session-id] 过滤强 session 隔离。
  const sidStr = String(sessionId);
  let indicator = overlay.querySelector(`.streaming-indicator[data-session-id="${CSS.escape(sidStr)}"]`);
  // 任何状态变化先取消 pending 延迟移除（如 idle→running 在 gap 期间，要立刻取消移除）
  if (_w16RemoveTimers.has(sessionId)) {
    clearTimeout(_w16RemoveTimers.get(sessionId));
    _w16RemoveTimers.delete(sessionId);
  }
  if (isRunning && currentView === 'card') {
    // W15 v2 (2026-05-10): 优先把 spinner 挂到最后一个 assistant turn-card 的
    // turn-head 末尾（视觉不打扰），cardCount=0 时 fallback 到 overlay 顶部。
    const allAssistantCards = overlay.querySelectorAll('.turn-card[data-turn-id]:not(.user)');
    const lastAssistantCard = allAssistantCards[allAssistantCards.length - 1];
    const lastAssistantHead = lastAssistantCard ? lastAssistantCard.querySelector('.turn-head') : null;
    const targetParent = lastAssistantHead || overlay;

    if (!indicator) {
      // 2026-05-06 道雪 scroll-respect-user:append 前记录是否在底部,仅满足条件才滚
      //   (status running↔idle 反复切换时频繁触发的强制 scroll 是历史 bug 主因之一)
      const wasAtBottom = _isCardOverlayAtBottom(overlay);
      indicator = document.createElement('span');
      indicator.className = 'streaming-indicator';
      indicator.dataset.sessionId = String(sessionId);
      indicator.innerHTML = '<span class="spinner-icon" aria-hidden="true"></span>';
      targetParent.appendChild(indicator);
      if (wasAtBottom && targetParent === overlay) {
        try { overlay.scrollTop = overlay.scrollHeight; } catch {}
      }
    } else if (indicator.parentElement !== targetParent) {
      // 已有 indicator 但目标 parent 变了（新 turn-card 渲染出来）→ 迁移过去
      targetParent.appendChild(indicator);
    }
    // 文案放 title 属性 hover 显示（不占视觉空间）
    const cardCount = overlay.querySelectorAll('.turn-card[data-turn-id]').length;
    const label = cardWorkingLabel(sess);
    const pendingSubmit = sess && sess.cardWorkingSource === 'floating_input';
    indicator.title = pendingSubmit
      ? `${label} 正在接收输入…`
      : (cardCount === 0 ? `${label} 正在工作…` : `${label} 仍在工作，可能还会更新卡片`);
    indicator.setAttribute('aria-label', indicator.title);
    indicator.dataset.label = cardCount === 0 ? indicator.title : '';
  } else if (!isRunning && indicator) {
    // 延迟 1.5s 移除（防 silence gap 闪烁）
    const timer = setTimeout(() => {
      _w16RemoveTimers.delete(sessionId);
      const ov = document.getElementById('msg-overlay');
      if (!ov) return;
      // 多方审查 P1：同样按 data-session-id 过滤，只 remove 自己 session 的 indicator
      const cur = ov.querySelector(`.streaming-indicator[data-session-id="${CSS.escape(sidStr)}"]`);
      if (!cur) return;
      // 二次确认：1.5s 后状态仍非 running 才真正移除
      const sess2 = sessions.get(sessionId);
      if (sessionId !== activeSessionId || !sess2 || sess2.status !== 'running' || currentView !== 'card') {
        cur.remove();
      }
    }, _W16_DELAYED_REMOVE_MS);
    _w16RemoveTimers.set(sessionId, timer);
  } else if (currentView !== 'card' && indicator) {
    // 不在卡片视图 → 立即移除（不延迟，因为根本看不见）
    indicator.remove();
  }
}

function applyViewMode(mode) {
  currentView = mode;
  const overlay = document.getElementById('msg-overlay');
  if (overlay) overlay.classList.toggle('hidden', mode !== 'card');
  cardQuestionNavigator.refresh();
  recentTurnCopyController.setVisible(mode === 'card' && !!activeSessionId);
  document.querySelectorAll('.view-toggle-btn').forEach(b => {
    if (!b.dataset.view) return;
    b.classList.toggle('active', b.dataset.view === mode);
  });
  // 切到 PTY 时 refit xterm
  if (mode === 'pty' && typeof terminalCache !== 'undefined') {
    const cached = terminalCache.get(activeSessionId);
    if (cached && cached.fitAddon) {
      scheduleVisibleTerminalRecovery(activeSessionId, cached, { pinBottom: false });
    }
  }
  // Spec 3 · W3 resume bug fix (b)：切到卡片时若历史从未全量加载过，
  // 主动 trigger load — 用 _cardHistoryHydratedSid 状态标记而非 DOM 检测，
  // 因为 turn-complete-event 可能已在 overlay 留了单张卡但历史并未 hydrate。
  if (mode === 'card' && overlay && typeof loadSessionHistoryToOverlay === 'function' && activeSessionId) {
    if (_cardHistoryHydratedSid !== activeSessionId) {
      loadSessionHistoryToOverlay(activeSessionId).then(r => {
        if (r && r.mounted > 0) _cardHistoryHydratedSid = activeSessionId;
      }).catch(err => {
        console.warn('[applyViewMode card] auto-load failed:', err);
      });
    }
  }
  // Spec 3 · W15：切到 card 立即 sync streaming indicator（active session 可能正在 running）；
  // 切到 PTY 立即移除（_updateStreamingIndicator 内部 currentView !== 'card' 分支处理）。
  if (activeSessionId && typeof _updateStreamingIndicator === 'function') {
    _updateStreamingIndicator(activeSessionId);
  }
}

function recoverVisibleActiveTerminalSurface() {
  // Chromium can evict an xterm Canvas/WebGL surface while the Hub window is
  // hidden without changing the terminal's geometry. ResizeObserver therefore
  // has nothing to report when the window returns, even though the logical
  // buffer is still complete. Repaint only the visible PTY; do not move the
  // user's scroll position.
  if (currentView !== 'pty' || activeMeetingId || !activeSessionId) return false;
  const cached = terminalCache.get(activeSessionId);
  if (!cached || !cached.fitAddon) return false;
  scheduleVisibleTerminalRecovery(activeSessionId, cached, { pinBottom: false });
  return true;
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.view-toggle-btn');
  if (btn && btn.dataset.view) applyViewMode(btn.dataset.view);
});

// T10 placeholder: "切到 PTY 视图" link
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('[data-action="switch-to-pty"]');
  if (!a) return;
  e.preventDefault();
  if (typeof applyViewMode === 'function') applyViewMode('pty');
});

// 卡片层要按 header / 输入栏的**实测**高度让位，不能写死常量。
// 详见 styles/card-view.css 里 .msg-overlay 的注释。
function measureFloatingBarVisualHeight(bar) {
  if (!bar) return 0;
  const barRect = bar.getBoundingClientRect();
  let top = barRect.top;
  let bottom = barRect.bottom;
  for (const child of bar.children) {
    if (getComputedStyle(child).display === 'none') continue;
    const rect = child.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    top = Math.min(top, rect.top);
    bottom = Math.max(bottom, rect.bottom);
  }
  return Math.ceil(Math.max(0, bottom - top));
}

function lockFloatingInputBarGeometry(bar) {
  if (!bar) return 0;
  const height = Math.ceil(bar.getBoundingClientRect().height || bar.offsetHeight || 0);
  if (height <= 0) return 0;
  bar.style.setProperty('--fi-layout-h', `${height}px`);
  bar.classList.add('geometry-locked');
  return height;
}

function observeTerminalPanelChrome(panel, bar) {
  if (!panel) return null;
  const header = panel.querySelector('.terminal-header');
  const apply = () => {
    // offsetHeight 含 border，正是 overlay 需要让开的实际占位。
    // 输入栏 display:none（只读会话）时自然是 0，overlay 就能铺到底。
    panel.style.setProperty('--term-header-h', `${header ? header.offsetHeight : 0}px`);
    panel.style.setProperty('--fi-bar-h', `${measureFloatingBarVisualHeight(bar)}px`);
  };
  apply();
  if (typeof ResizeObserver !== 'function') return { disconnect() {} };
  const observer = new ResizeObserver(apply);
  if (header) observer.observe(header);
  if (bar) {
    observer.observe(bar);
    for (const child of bar.children) observer.observe(child);
  }
  return observer;
}

function mountFloatingInput(sessionId, termContainer, terminal) {
  const bar = document.createElement('div');
  bar.className = 'floating-input-bar';

  // ↑/↓ 召回发过的消息。模块缺席（脚本没加载）时整块功能静默关闭，
  // 输入框其余行为一字不变 —— 历史是增强，不该成为新的单点故障。
  const historyApi = (typeof window !== 'undefined' && window.FloatingInputHistory) || null;
  const inputHistory = historyApi
    ? historyApi.createFloatingInputHistory({ storage: window.localStorage })
    : null;
  const historyCursor = inputHistory
    ? inputHistory.createCursor(sessionId)
    : { isBrowsing: () => false, older: () => null, newer: () => null, reset() {}, invalidate() {} };
  let applyingHistory = false;
  function applyHistoryText(text) {
    applyingHistory = true;
    try {
      replaceContenteditableText(inputBox, text);
      placeCaretAtContenteditableEnd(inputBox);
      saveFloatingInputDraft(sessionId, inputBox);
    } finally {
      applyingHistory = false;
    }
  }

  const inputBox = document.createElement('div');
  inputBox.className = 'floating-input-box';
  inputBox.contentEditable = 'true';
  inputBox.setAttribute('data-placeholder', '输入消息…');
  if (floatingInputDrafts.has(sessionId)) {
    inputBox.textContent = floatingInputDrafts.get(sessionId);
  }

  const presetApi = window.TaskPresets;
  const presetSession = (typeof sessions !== 'undefined' && sessions && typeof sessions.get === 'function')
    ? sessions.get(sessionId) : null;
  // AI kind 含 -resume 变体（claude-resume / codex-resume / kimi-resume）：
  // 恢复的旧会话恰恰最需要「续跑」预设，口径与下方休眠 session 白名单一致。
  const presetKind = presetSession && presetSession.kind;
  const presetEnabled = !!(
    presetApi && Array.isArray(presetApi.PRESETS) && presetApi.PRESETS.length
    && presetKind && (isAiKind(presetKind) || (typeof presetKind === 'string' && presetKind.endsWith('-resume')))
  );
  const presetToolbar = document.createElement('div');
  presetToolbar.className = 'fi-preset-toolbar';
  presetToolbar.hidden = !presetEnabled;
  presetToolbar.setAttribute('aria-label', '任务预设');
  const presetToolbarLabel = document.createElement('span');
  presetToolbarLabel.className = 'fi-preset-label';
  presetToolbarLabel.textContent = '任务预设';
  presetToolbar.appendChild(presetToolbarLabel);

  const presetPreview = document.createElement('div');
  presetPreview.className = 'fi-preset-preview';
  presetPreview.hidden = true;
  const presetPreviewName = document.createElement('strong');
  const presetPreviewText = document.createElement('div');
  presetPreviewText.className = 'fi-preset-preview-text';
  presetPreviewText.contentEditable = 'true';
  presetPreviewText.setAttribute('role', 'textbox');
  presetPreviewText.setAttribute('aria-label', '本次任务预设约束，可编辑');
  const presetRemoveBtn = document.createElement('button');
  presetRemoveBtn.type = 'button';
  presetRemoveBtn.className = 'fi-preset-remove';
  presetRemoveBtn.title = '取消本次任务预设';
  presetRemoveBtn.setAttribute('aria-label', '取消本次任务预设');
  presetRemoveBtn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  presetPreview.append(presetPreviewName, presetPreviewText, presetRemoveBtn);

  function clearPresetSelection() {
    floatingInputPresetDrafts.delete(sessionId);
    presetPreview.hidden = true;
    presetPreviewName.textContent = '';
    presetPreviewText.textContent = '';
    presetToolbar.querySelectorAll('.fi-preset-chip').forEach(btn => btn.setAttribute('aria-pressed', 'false'));
  }

  function selectPreset(presetId) {
    if (!presetEnabled) return;
    const preset = presetApi.getPreset(presetId);
    if (!preset) return;
    const current = floatingInputPresetDrafts.get(sessionId);
    if (current && current.id === presetId) {
      clearPresetSelection();
      inputBox.focus();
      return;
    }
    floatingInputPresetDrafts.set(sessionId, { id: preset.id, constraint: preset.constraint });
    presetPreview.hidden = false;
    presetPreviewName.textContent = preset.name;
    presetPreviewText.textContent = preset.constraint;
    presetToolbar.querySelectorAll('.fi-preset-chip').forEach(btn => {
      btn.setAttribute('aria-pressed', String(btn.dataset.presetId === preset.id));
    });
    inputBox.focus();
  }

  if (presetEnabled) {
    presetApi.PRESETS.forEach(preset => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'fi-preset-chip';
      button.dataset.presetId = preset.id;
      button.textContent = preset.label;
      button.title = `${preset.name} · ${preset.hint}`;
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        selectPreset(preset.id);
      });
      presetToolbar.appendChild(button);
    });
    const savedPreset = floatingInputPresetDrafts.get(sessionId);
    if (savedPreset && presetApi.getPreset(savedPreset.id)) {
      const preset = presetApi.getPreset(savedPreset.id);
      presetPreview.hidden = false;
      presetPreviewName.textContent = preset.name;
      // 如实恢复草稿：用户清空过的约束（空串）必须原样恢复成空，
      // 不能用 || 回退成默认文案——否则 UI 显示有约束、实际发送却是纯原文。
      presetPreviewText.textContent = savedPreset.constraint != null ? savedPreset.constraint : preset.constraint;
      presetToolbar.querySelectorAll('.fi-preset-chip').forEach(btn => {
        btn.setAttribute('aria-pressed', String(btn.dataset.presetId === preset.id));
      });
    }
  }

  // 与主输入框同款粘贴处理（terminal-input-controller）：文本粘贴转纯文本，
  // 避免富文本格式混入约束草稿；图片粘贴插入本地路径。
  if (typeof attachContenteditablePasteImage === 'function') attachContenteditablePasteImage(presetPreviewText);

  presetPreviewText.addEventListener('input', () => {
    const current = floatingInputPresetDrafts.get(sessionId);
    if (!current) return;
    floatingInputPresetDrafts.set(sessionId, {
      id: current.id,
      constraint: readContenteditablePlainText(presetPreviewText),
    });
  });
  presetRemoveBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    clearPresetSelection();
    inputBox.focus();
  });

  // 2026-07-19 道雪 · 方案C：ctx chip（发送前看到成本）+ 运行中红色中断钮（发 \x03=SIGINT）
  const ctxChip = document.createElement('span');
  ctxChip.className = 'fi-ctx';
  ctxChip.style.display = 'none';

  const stopBtn = document.createElement('button');
  stopBtn.className = 'floating-input-stop';
  stopBtn.title = '中断当前 AI（发送 Ctrl+C）';
  stopBtn.setAttribute('aria-label', '中断当前 AI');
  stopBtn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
  stopBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    ipcRenderer.send('terminal-input', { sessionId, data: '\x03' });
    terminal.focus();
  });

  const sendBtn = document.createElement('button');
  sendBtn.className = 'floating-input-send';
  sendBtn.title = '发送 (Enter) · Shift+Enter 换行';
  sendBtn.setAttribute('aria-label', '发送');
  sendBtn.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M12 4l7 7h-4v9h-6v-9H5z"/></svg>';

  const composerRow = document.createElement('div');
  composerRow.className = 'fi-composer-row';
  composerRow.append(inputBox, ctxChip, stopBtn, sendBtn);
  const contentStack = document.createElement('div');
  contentStack.className = 'fi-content-stack';
  contentStack.append(presetToolbar, composerRow, presetPreview);
  bar.append(contentStack);
  bar.classList.add('visible');

  const panel = termContainer.closest('.terminal-panel');
  if (panel) panel.appendChild(bar);
  else termContainer.appendChild(bar);

  // The external composer is not part of the CLI terminal. Lock its flex
  // footprint at the collapsed height, then let multiline/preset content grow
  // upward as a visual overlay. Otherwise every draft line changes xterm rows,
  // sends ConPTY resize, and makes full-screen CLIs clear/repaint from row 1.
  lockFloatingInputBarGeometry(bar);

  // 卡片层（.msg-overlay）是 absolute + z-index:50 + 不透明底色，靠 top/bottom 给
  // header 和输入栏让位。这两个值以前写死 43px/60px，而输入栏随任务预设 chips、
  // 预设预览、输入框增高能长到 220px —— 超出 60px 的部分就被卡片层盖住且点不到，
  // 用户看到的就是"卡片视图下输入框只剩两行"。这里把实测高度写回 CSS 变量。
  const chromeObserver = observeTerminalPanelChrome(panel, bar);

  // paste-sensitive TUI（claude/gemini/codex 等 9 家 AI CLI）会把紧贴到达的字符
  //   当成 paste 事件 — 紧贴的 \r 被当作 paste 内容吞掉，消息卡在输入框不提交
  //   （2026-05-10 用户反馈：按 Enter 后内容进了 shell 输入框但不发送）。
  //   修复参考 group-chat-watcher.js 1A fast-path：claude 家族用 BP marker 显式
  //   标记 paste 结束 + 500ms 间隔后单独发 \r；gemini/codex 不识别 BP，靠静默期
  //   触发 paste-detect 完成（≥400ms）；普通 shell 无 paste-detect，保持原行为。
  const BP_START = '\x1b[200~';
  const BP_END = '\x1b[201~';

  function sendInput() {
    const userText = readContenteditablePlainText(inputBox);
    if (!userText || !userText.trim()) return;
    const selectedPreset = floatingInputPresetDrafts.get(sessionId);
    const text = selectedPreset && presetApi && typeof presetApi.composePrompt === 'function'
      ? presetApi.composePrompt(userText, selectedPreset.id, selectedPreset.constraint)
      : userText;

    // 立即清 UI + scroll + 还焦给终端，让用户立刻感知"已发送"。后续异步往 PTY 写。
    // 清空必须走 replaceContenteditableText（execCommand）：直接赋 textContent 会
    // 清掉原生撤销栈，误发之后 Ctrl+Z 拿不回原文。
    if (inputHistory) {
      inputHistory.push(sessionId, userText);
      historyCursor.reset();
    }
    replaceContenteditableText(inputBox, '');
    clearFloatingInputDraft(sessionId);
    clearPresetSelection();
    terminal.scrollToBottom();
    terminal.focus();

    const session = (typeof sessions !== 'undefined' && sessions && typeof sessions.get === 'function')
      ? sessions.get(sessionId) : null;
    const kind = session && session.kind ? session.kind : null;
    clearSessionWaitingState(sessionId);
    armPtyBurstFallback(sessionId);
    if (isTranscriptCliKind(kind)) markCodexCardWorking(sessionId, 'floating_input');

    // optimistic user-card：卡片视图下立即弹气泡，不等 transcript 写盘 + 250ms throttle reload。
    //   2026-05-10 用户反馈：在卡片视图按 Enter 后约 5 秒才看到自己的气泡卡。根因是 user 气泡
    //   也走 transcript reload 路径，但 Claude CLI 通常等 LLM call 启动才把 user entry append
    //   到 JSONL（实测 1-3s 滞后）。聊天 app 标准做法是发出即 mount，待权威 entry 到时 dedup。
    if (currentView === 'card' && kind && (isClaudeFamily(kind) || isCodexKind(kind) || isKimiCliKind(kind)) && typeof mountOptimisticUserCard === 'function') {
      try {
        mountOptimisticUserCard(sessionId, text.trim(), kind);
      } catch (err) {
        console.warn('[optimistic user-card] mount failed:', err);
      }
    }

    if (isClaudeRuntimeSession(session)) {
      ipcRenderer.send('terminal-input', { sessionId, data: BP_START + text + BP_END });
      // belt-and-suspenders（2026-05-11 用户反馈：BP+500ms+1×\r 仍偶发"消息进输入框但没提交"）：
      //   BP_END 后 Ink paste-detect 仍有 debounce 窗口，紧贴的 \r 被并入 paste 内容吞掉。
      //   多发 \r：首个被吞 → 后续落到正常 prompt 触发提交；多余 \r 落空输入框被 CLI 忽略，
      //   无副作用。首个 \r delay 拉到 700ms 让 paste 窗口尽量先关，再 200ms × 2 兜底。
      //   参考 core/group-chat-watcher.js zero-echo 兜底策略（已工程验证）。
      setTimeout(() => ipcRenderer.send('terminal-input', { sessionId, data: '\r' }), 700);
      setTimeout(() => ipcRenderer.send('terminal-input', { sessionId, data: '\r' }), 900);
      setTimeout(() => ipcRenderer.send('terminal-input', { sessionId, data: '\r' }), 1100);
    } else if (kind && isPasteSensitive(kind)) {
      ipcRenderer.send('terminal-input', { sessionId, data: text });
      // 同 belt-and-suspenders 思路（gemini/codex 不识别 BP marker，但 paste-detect 同病）。
      setTimeout(() => ipcRenderer.send('terminal-input', { sessionId, data: '\r' }), 500);
      setTimeout(() => ipcRenderer.send('terminal-input', { sessionId, data: '\r' }), 700);
    } else {
      ipcRenderer.send('terminal-input', { sessionId, data: text + '\r' });
    }
  }

  inputBox.addEventListener('keydown', (e) => {
    // IME composition (中/日/韩) 中, 回车是给候选词用的, 不是给应用层。
    // 不放行就会出现:中文按回车选词被当作"发送"+清空输入框,数字纯 ASCII 不受影响。
    // ↑/↓ 同理：候选词翻页也用方向键，抢过来会让中文输入没法选词。
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendInput();
      return;
    }
    if (inputHistory) {
      const hasModifier = e.ctrlKey || e.metaKey || e.altKey || e.shiftKey;
      const ctx = {
        key: e.key,
        hasModifier,
        isBrowsing: historyCursor.isBrowsing(),
        isEmpty: !readContenteditablePlainText(inputBox).trim(),
        caretAtStart: isCaretAtContenteditableStart(inputBox),
      };
      const hit = historyApi.shouldRecallOlder(ctx)
        ? historyCursor.older(readContenteditablePlainText(inputBox))
        : (historyApi.shouldRecallNewer(ctx) ? historyCursor.newer() : null);
      // hit 为 null（已经翻到底）时什么都不做，让 ↑/↓ 保持原生行为，别把草稿吃掉。
      if (hit) {
        e.preventDefault();
        applyHistoryText(hit.text);
        return;
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      // 浏览历史时 Esc 先退出浏览态并还原草稿，第二下才把焦点交回终端。
      if (inputHistory && historyCursor.isBrowsing()) {
        let restored = historyCursor.newer();
        while (restored && !restored.restoredDraft) restored = historyCursor.newer();
        if (restored) applyHistoryText(restored.text);
        historyCursor.reset();
        return;
      }
      terminal.focus();
    }
  });

  inputBox.addEventListener('input', () => {
    // 用户自己动手改了内容就退出浏览态：下一次 ↑ 从最新一条重新开始，
    // 而不是接着上次的下标往上翻（那样会跳过刚改出来的这条）。
    // 历史召回本身也是 execCommand，同样会触发 input —— 用 applyingHistory 挡掉，
    // 否则连按两下 ↑ 只会在第一条上原地打转。
    if (inputHistory && !applyingHistory && historyCursor.isBrowsing()) historyCursor.reset();
    saveFloatingInputDraft(sessionId, inputBox);
  });

  // 卡片优化（2026-05-03）：粘贴图片到浮动输入框 → save-clipboard-image
  //   IPC 取得绝对路径 → execCommand('insertText') 插入到 caret 位置。
  //   语义与 xterm 的 handlePasteForSession 一致（用户粘图后路径文字流到 PTY）。
  attachContenteditablePasteImage(inputBox);

  sendBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    sendInput();
  });

  bar.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) return;

    const targetInput = e.target && e.target.closest && e.target.closest('.floating-input-box');
    if (targetInput && targetInput.scrollHeight > targetInput.clientHeight) {
      const maxTop = Math.max(0, targetInput.scrollHeight - targetInput.clientHeight);
      const canScrollInput = (e.deltaY < 0 && targetInput.scrollTop > 0)
        || (e.deltaY > 0 && targetInput.scrollTop < maxTop);
      if (canScrollInput) return;
    }

    const cached = terminalCache.get(sessionId);
    const vp = getTerminalViewport(cached);
    if (!vp) return;

    e.preventDefault();
    markCodexUserScrollIntent(sessionId, cached, { detachFromBottom: e.deltaY < 0 });
    vp.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      deltaMode: e.deltaMode,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
    }));
    updateCodexFollowBottomFromUserScroll(sessionId, cached);
  }, { passive: false });

  bar.addEventListener('click', (e) => e.stopPropagation());
  bar.addEventListener('mousedown', (e) => e.stopPropagation());

  return {
    dispose() {
      saveFloatingInputDraft(sessionId, inputBox);
      if (chromeObserver) chromeObserver.disconnect();
      // 输入栏拆掉后变量必须归零，否则卡片层会一直给一条不存在的栏留空白。
      if (panel) panel.style.setProperty('--fi-bar-h', '0px');
      if (bar.parentNode) bar.parentNode.removeChild(bar);
    },
  };
}

// 2026-07-19 道雪 · 方案C：刷新浮动输入栏的 ctx chip 与中断钮（跟随 active session 状态）。
//   调用时机：mountFloatingInput 后 + 每次 renderSessionList（status 事件驱动）。
function updateFloatingBarState() {
  if (!activeSessionId) return;
  const s = sessions.get(activeSessionId);
  if (!s) return;

  // The header used to be a one-time snapshot from showTerminal(), while the
  // sidebar and composer followed live state. Keep all three surfaces aligned.
  const status = terminalPanelEl && terminalPanelEl.querySelector('.terminal-header .terminal-status');
  if (status) {
    const running = s.status === 'running';
    status.className = `terminal-status ${running ? 'running' : 'idle'}`;
    status.textContent = running ? '\u25cf running' : '\u25cb idle';
  }

  const bar = document.querySelector('.terminal-panel .floating-input-bar');
  if (!bar) return;
  const chip = bar.querySelector('.fi-ctx');
  if (chip) {
    if (typeof s.contextPct === 'number') {
      chip.style.display = '';
      chip.textContent = `ctx ${s.contextPct}%`;
      chip.className = 'fi-ctx ' + pctClass(s.contextPct);
      chip.title = `当前会话上下文占用 ${s.contextPct}%`;
    } else {
      chip.style.display = 'none';
    }
  }
  const stop = bar.querySelector('.floating-input-stop');
  if (stop) {
    const aiSession = isAiRuntimeSession(s);
    const authoritativeAiWork = s._runSource === 'semantic'
      || s._runSource === 'pty-semantic'
      || s._agentWorking === 'hook'
      || s._agentWorking === 'card'
      || s.gcWorking === true;
    // PTY byte bursts remain a useful status fallback, but are not strong
    // enough evidence to expose a destructive Ctrl+C button for an AI session.
    stop.classList.toggle('visible', s.status === 'running' && (!aiSession || authoritativeAiWork));
  }
}

// 2026-07-21 道雪 [修进行中误判]：周期性兜底回收"卡死的进行中"。
//   此前回收路径都有洞：hook 系（claude）stop hook 丢失/hook server 掉线/事件错过时
//   无任何回收 → 实测卡在运行中 4 小时；card 系的 45min maxAge 只在静默计时器里
//   检查（完全无输出时永远不会触发）；gcWorking 在 watcher 卡死且无 turn-complete 时
//   永久置位。规则：
//   - card 系：hasSemanticCardWorking 的 45min maxAge（每次扫都真正执行）
//   - hook 系：45min 无任何 PTY 输出判卡死（_lastOutputTs 由 onTerminalOutput/语义起点维护）
//   - gcWorking：8s 无任何 partial-update（活着的 watcher 每 1.5s 必有 streaming）
function sweepStaleRunning() {
  const now = Date.now();
  let dirty = false;
  for (const s of sessions.values()) {
    if (s.status === 'running' && (s._runSource === 'semantic' || s._runSource === 'pty-semantic')) {
      if (s._agentWorking === 'card' && !hasSemanticCardWorking(s)) {
        s.status = 'idle';
        s._runSource = null;
        s._agentWorking = null;
        dirty = true;
      } else if (s._agentWorking === 'hook' && s._lastOutputTs && now - s._lastOutputTs > 45 * 60 * 1000) {
        s.status = 'idle';
        s._runSource = null;
        s._agentWorking = null;
        dirty = true;
      } else if (s._agentWorking === 'pty' && s._lastOutputTs && now - s._lastOutputTs > 45 * 60 * 1000) {
        s.status = 'idle';
        s._runSource = null;
        s._agentWorking = null;
        dirty = true;
      }
    }
    if (s.gcWorking && s._gcWorkingLastTs && now - s._gcWorkingLastTs > GC_WORKING_FRESH_MS) {
      s.gcWorking = false;
      dirty = true;
    }
  }
  if (dirty) scheduleSessionListRender();
}
setInterval(sweepStaleRunning, 60 * 1000);
function updateRespondPill() {
  const pill = document.getElementById('respond-pill');
  if (!pill) return;
  // The home workbench already owns a full "等你输入 / 完成未读" surface.
  // Keeping the floating pill there duplicates the same signal and can cover
  // the model trend card at shorter window heights.
  if (terminalPanelEl && terminalPanelEl.classList.contains('home-active')) {
    pill.style.display = 'none';
    return;
  }
  const items = [];
  for (const s of sessions.values()) {
    if (s.meetingId || s.id === activeSessionId || s.status === 'dormant'
        || s.hiddenFromSidebar || s.purpose === 'chuxin-research') continue;
    if (sessionNeedsUserInput(s)) items.push({ id: s.id, meeting: false, wait: true, t: s.lastMessageTime || 0 });
    else if (sessionHasCompletedUnread(s)) items.push({ id: s.id, meeting: false, wait: false, t: s.lastMessageTime || 0 });
  }
  for (const m of Object.values(meetings || {})) {
    if (m.id === activeMeetingId || m.status === 'dormant') continue;
    const n = m.unreadAnswered instanceof Set ? m.unreadAnswered.size : 0;
    if (n > 0) items.push({ id: m.id, meeting: true, wait: false, t: m.lastMessageTime || 0 });
  }
  if (!items.length) { pill.style.display = 'none'; return; }
  const waitN = items.filter(i => i.wait).length;
  const unreadN = items.length - waitN;
  let txt = '';
  if (waitN && unreadN) {
    txt = `⏸ <b>${items.length}</b> 个待处理（${waitN} 等你输入 · <span class="rp-unread">${unreadN} 完成未读</span>）`;
  } else if (waitN) {
    txt = `⏸ <b>${waitN}</b> 个会话等你响应`;
  } else {
    txt = `✓ <b>${unreadN}</b> 个会话已完成未读`;
  }
  txt += ' · 点击跳转 →';
  pill.innerHTML = txt;
  pill.style.display = 'flex';
  pill.onclick = () => {
    items.sort((a, b) => b.t - a.t);
    const top = items[0];
    if (top.meeting) selectMeeting(top.id, { forceScrollBottom: true });
    else selectSession(top.id, { forceScrollBottom: true });
  };
}

function flashPromptLine(terminal, lineNumber) {
  const container = terminal.element && terminal.element.closest('.terminal-container');
  if (!container) return;
  const renderer = terminal._core._renderService;
  if (!renderer || !renderer.dimensions) return;
  const cellH = renderer.dimensions.css.cell.height;
  const viewY = terminal.buffer.active.viewportY;
  const padTop = parseFloat(getComputedStyle(container).paddingTop) || 0;
  const topPx = (lineNumber - viewY) * cellH + padTop;
  let highlight = container.querySelector('.prompt-highlight');
  if (!highlight) {
    highlight = document.createElement('div');
    highlight.className = 'prompt-highlight';
    container.appendChild(highlight);
  }
  highlight.style.top = topPx + 'px';
  highlight.style.height = cellH + 'px';
  highlight.style.display = 'block';
  highlight.style.animation = 'none';
  highlight.offsetHeight;
  highlight.style.animation = 'prompt-flash 0.8s ease-out forwards';
}

// Hub → Claude /rename sync. Only fires for Claude sessions after the user
// renames in the Hub UI. We inject the /rename command into the PTY; to keep
// it clean we require the session to be idle (prompt is empty). If the user
// is mid-reply we stash it and flush on the next Stop hook. Title is sanitized
// to strip newlines and cap length so a pasted string can't inject extra input.
function syncRenameToClaude(sessionId, title) {
  const session = sessions.get(sessionId);
  if (!session) return;
  const clean = String(title).replace(/[\r\n]/g, ' ').trim().slice(0, 80);
  if (!clean) return;
  if (session.status === 'idle') {
    ipcRenderer.send('terminal-input', { sessionId, data: '/rename ' + clean + '\r' });
    session._pendingRename = null;
  } else {
    session._pendingRename = clean;
  }
}

// --- Inline rename ---
function startRename(sessionId, titleSpan) {
  const session = sessions.get(sessionId);
  if (!session) return;

  const input = document.createElement('input');
  input.className = 'terminal-title-input';
  input.value = session.title;

  const finish = async () => {
    const trimmed = input.value.trim();
    const changed = !!trimmed && trimmed !== session.title;
    if (changed) {
      // 本地必须自己落地，不能等 session-updated 的回声：那个 handler 的守卫是
      // `if (!local.userRenamed && session.title) local.title = session.title`，
      // 用来挡自动改名（OSC / auto-title）覆盖用户手动改的名字。但我们上一行刚把
      // userRenamed 置成 true，回声就被自己的守卫挡掉了 —— 改名于是只落到主进程，
      // 侧栏和顶栏还是旧名字，看起来像「点了没反应」。
      // 只有 dormant 分支原本歪打正着写了本地 title，所以休眠会话改名一直是好的，
      // 活着的会话（codex / codex-resume / 分支都属此列）一直是坏的。
      session.userRenamed = true;
      session.title = trimmed;
      // titleSpan 是进入改名前捕获的那个节点，下面会被放回 DOM。不同步刷新它，
      // 顶栏就会一直显示旧标题，直到切走再切回来触发 showTerminal 重建。
      titleSpan.textContent = trimmed;
    }
    input.replaceWith(titleSpan);
    if (!changed) return;
    renderSessionList();
    schedulePersist();
    // 休眠会话没有 PTY，也没有主进程侧的 session 对象要同步，到此为止。
    if (session.status === 'dormant') return;
    await ipcRenderer.invoke('rename-session', { sessionId, title: trimmed, userRenamed: true });
    if (session.kind === 'claude' || session.kind === 'claude-resume') {
      syncRenameToClaude(sessionId, trimmed);
    }
  };

  input.addEventListener('blur', finish);
  input.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { input.value = session.title; input.blur(); }
  });

  titleSpan.replaceWith(input);
  input.focus();
  input.select();
}

// --- Session selection ---
async function selectSession(id, opts = {}) {
  await savePreviewState();
  activeMeetingId = null;
  // Hiding the meeting DOM alone leaves meeting-room.js believing the room is
  // still active (pollers, draft state, and event guards keep running).  This
  // matters especially for avatar -> child-session navigation, but the same
  // lifecycle cleanup is required for every sidebar session switch.
  if (typeof MeetingRoom !== 'undefined'
      && typeof MeetingRoom.getActiveMeetingId === 'function'
      && MeetingRoom.getActiveMeetingId()
      && typeof MeetingRoom.closeMeetingPanel === 'function') {
    MeetingRoom.closeMeetingPanel();
  }
  if (window.__chuxinHide) window.__chuxinHide(); // 2026-07-23 投研面板互斥
  const mrp = document.getElementById('meeting-room-panel');
  if (mrp) mrp.style.display = 'none';
  clearPreviewUI();
  const tp = document.getElementById('terminal-panel');
  if (tp) tp.style.display = '';

  const session = sessions.get(id);
  // Dormant session: clicking wakes it via resume-session IPC. Don't render
  // terminal now — session-created handler below will take over once PTY is up.
  if (session && session.status === 'dormant') {
    void resumeDormantSession(id, opts).catch((error) => {
      console.warn('[resume-session] dormant wake failed:', error);
      alert(`会话恢复失败：${error && error.message ? error.message : String(error)}`);
    });
    return;
  }
  const switching = activeSessionId !== id;
  const cachedBeforeSelect = terminalCache.get(id);
  const requestedBottomPin = opts && opts.forceScrollBottom === true;
  // 左侧栏的显式“跳到最新”适用于所有 CLI；Codex 仍保留首次打开自动置底，
  // 修复卡片视图里重复点击当前 Claude/Kimi 会话时请求被 kind 过滤掉的问题。
  const forceScrollBottom = requestedBottomPin
    || !!(session && isCodexKind(session.kind) && (!cachedBeforeSelect || !cachedBeforeSelect.opened));
  const shouldFocusTerminal = switching || currentView === 'pty';
  activeSessionId = id;
  if (completionNotificationToggle) completionNotificationToggle.refreshTarget();
  recentTurnCopyController.setVisible(currentView === 'card' && !!activeSessionId);
  if (session) clearSessionAttention(session, { clearUnread: true });
  ipcRenderer.send('focus-session', { sessionId: id });
  renderSessionList();
  showTerminal(id, { focus: shouldFocusTerminal, forceScrollBottom });
  // Snapshot the current question signature as "read" AFTER showTerminal —
  // on first selection that's when cached.opened flips to true, and
  // getQuestionsSignature needs an opened buffer to read. Calling before
  // showTerminal always returned '' on first click, which then made the very
  // first AI reply after opening the session never bump unread.
  if (session) {
    session.readSignature = getQuestionsSignature(id);
  }
  // auto-focus 浮动输入框 — 与群聊 openMeeting (meeting-room.js IF-C2) 对称：
  //   点进 session 后用户可直接键盘输入，无需先点输入框。defer 50ms 让 xterm
  //   open + robustFit 的 rAF 链先跑完，避免被它抢焦点回去。
  setTimeout(() => {
    if (activeSessionId !== id) return; // 50ms 内用户又切走了
    const inputBox = document.querySelector('.terminal-panel .floating-input-box');
    if (inputBox && document.activeElement !== inputBox) {
      inputBox.focus();
      // caret 移到内容末尾（保留草稿 caret 体验）
      const sel = window.getSelection();
      if (sel) {
        const range = document.createRange();
        range.selectNodeContents(inputBox);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
  }, 50);
  await restorePreviewForContext(`session:${id}`);
}

// --- Dropdown menu ---
btnNew.addEventListener('click', () => {
  if (menuEl.style.display === 'none') window.WorkspaceController.openNewSessionModal();
  else window.WorkspaceController.closeNewSessionModal();
});

document.addEventListener('mousedown', (e) => {
  if (!wrapperEl.contains(e.target)) menuEl.style.display = 'none';
  if (resumeWrapperEl && !resumeWrapperEl.contains(e.target)) resumeMenuEl.style.display = 'none';
});

// v1.5.1：弹窗升级为居中 modal 后，遮罩(::before)铺满 viewport，
// 点击遮罩区会落到弹窗元素本身（e.target === menuEl）→ 关闭。
// 点击内部 option/按钮 → e.target 是子元素，不关闭。
menuEl.addEventListener('mousedown', (e) => {
  if (e.target === menuEl) menuEl.style.display = 'none';
});
resumeMenuEl.addEventListener('mousedown', (e) => {
  if (e.target === resumeMenuEl) resumeMenuEl.style.display = 'none';
});

// ESC 关闭任意打开的侧栏 modal
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  for (const el of [menuEl, resumeMenuEl]) {
    if (el && el.style.display !== 'none') el.style.display = 'none';
  }
});

// --- Resume dropdown ---
btnResume.addEventListener('click', (e) => {
  e.stopPropagation();
  resumeMenuEl.style.display = resumeMenuEl.style.display === 'none' ? 'block' : 'none';
});

for (const btn of document.querySelectorAll('.resume-option')) {
  btn.addEventListener('click', async () => {
    resumeMenuEl.style.display = 'none';
    await ipcRenderer.invoke('create-session', btn.dataset.kind);
  });
}

// --- Launcher (启动面板 v0.8.3 · 三精灵海报) ---
// 主 CTA 召集 AI 群聊;底部超链接 1v1 单聊(走 create-session)。
// 静态 DOM,无最近会话,无磁盘 IO,无 IPC 启动开销。
for (const cta of document.querySelectorAll('.launcher-cta')) {
  cta.addEventListener('click', () => {
    if (cta.dataset.launcherAction === 'group') {
      createMeetingByMode('group');
    }
  });
}
for (const link of document.querySelectorAll('.launcher-link')) {
  link.addEventListener('click', () => {
    const kind = link.dataset.launcherKind;
    if (kind) window.WorkspaceController.openNewSessionModal({ kind });
  });
}

// --- Meeting buttons ---
if (btnHome) {
  btnHome.addEventListener('click', () => escapeToHome());
}
// --- Create Meeting ---
function createMeetingByMode(mode) {
  if (typeof window.openMeetingCreateModal === 'function') {
    window.openMeetingCreateModal('group');
  } else {
    console.error('[createMeetingByMode] meeting-create-modal not loaded');
  }
}

// --- Resume/search past session modals ---
function normalizeSearchHitPath(value) {
  if (!value) return '';
  try { return path.resolve(String(value)).replace(/\\/g, '/').toLowerCase(); }
  catch { return String(value).replace(/\\/g, '/').toLowerCase(); }
}

function findExistingSessionForSearchHit(hit) {
  if (!hit) return null;
  if (hit.hubSessionId && sessions.has(hit.hubSessionId)) return sessions.get(hit.hubSessionId);
  if (!hit.nativeSessionId) return null;
  const matches = [];
  for (const session of sessions.values()) {
    if (!session || session.meetingId) continue;
    if (hit.nativeFamily === 'claude' && session.ccSessionId === hit.nativeSessionId) matches.push(session);
    if (hit.nativeFamily === 'codex' && session.codexSid === hit.nativeSessionId) {
      const hitRoot = normalizeSearchHitPath(hit.codexSessionsRoot);
      const sessionRoot = normalizeSearchHitPath(session.codexSessionsRoot);
      if (!hitRoot || !sessionRoot || hitRoot === sessionRoot) matches.push(session);
    }
  }
  matches.sort((a, b) => {
    const aLive = a.status !== 'dormant' ? 1 : 0;
    const bLive = b.status !== 'dormant' ? 1 : 0;
    if (aLive !== bLive) return bLive - aLive;
    const bAt = Number(b.lastCompletedAt || b.lastMessageTime || b.updatedAt || 0);
    const aAt = Number(a.lastCompletedAt || a.lastMessageTime || a.updatedAt || 0);
    return bAt - aAt;
  });
  return matches[0] || null;
}

async function waitForRendererSession(sessionId, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = sessions.get(sessionId);
    if (session) return session;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  return sessions.get(sessionId) || null;
}

function focusOrdinarySearchHit(hit, preview) {
  const overlay = document.getElementById('msg-overlay');
  if (!overlay) return false;
  const eventId = hit && hit.bestMatch && hit.bestMatch.eventId;
  let card = null;
  if (eventId && eventId !== 'title') {
    try { card = overlay.querySelector(`.turn-card[data-turn-id="${CSS.escape(String(eventId))}"]`); }
    catch {}
  }
  if (card) {
    card.classList.add('global-search-focus');
    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(() => { if (card.isConnected) card.classList.remove('global-search-focus'); }, 1500);
    return true;
  }

  const match = preview && Array.isArray(preview.context)
    ? (preview.context.find(item => item && item.isMatch) || preview.context[0])
    : null;
  const text = match && match.text || hit && hit.bestMatch && hit.bestMatch.text || '';
  if (!text) return false;
  const existing = overlay.querySelector('.global-search-history-focus');
  if (existing) existing.remove();
  const notice = document.createElement('section');
  notice.className = 'global-search-history-focus';
  const title = document.createElement('strong');
  title.textContent = eventId === 'title'
    ? '昨日之我 · 命中会话标题'
    : '昨日之我 · 命中较早历史（当前卡片窗口之外）';
  const body = document.createElement('p');
  body.textContent = text;
  notice.append(title, body);
  overlay.prepend(notice);
  notice.scrollIntoView({ block: 'start', behavior: 'smooth' });
  return true;
}

async function createSessionFromSearchHit(hit) {
  if (!hit || !hit.nativeSessionId) return null;
  const opts = {
    title: hit.title || undefined,
    cwd: hit.cwd || undefined,
    resumeTranscriptPath: hit.transcriptPath || undefined,
    autoTitleGenerated: !!hit.title,
  };
  let kind;
  if (hit.nativeFamily === 'claude') {
    kind = hit.provider === 'deepseek' ? 'deepseek-resume' : 'claude-resume';
    opts.resumeCCSessionId = hit.nativeSessionId;
    if (hit.provider === 'deepseek') opts.deepseekLegacyClaude = true;
  } else if (hit.nativeFamily === 'codex') {
    kind = hit.provider === 'deepseek' ? 'deepseek-resume' : 'codex-resume';
    opts.useResume = true;
    opts.codexSid = hit.nativeSessionId;
    if (hit.codexSessionsRoot) opts.codexSessionsRoot = hit.codexSessionsRoot;
    if (hit.codexProfile) opts.codexProfile = hit.codexProfile;
  } else {
    return null;
  }
  return ipcRenderer.invoke('create-session', { kind, opts });
}

async function openGlobalSearchHit(hit, opts = {}) {
  if (!hit) return null;
  if (hit.provider === 'meeting' || hit.meetingId) {
    const meetingId = hit.meetingId;
    if (!meetingId || !meetings[meetingId]) throw new Error('群聊记录已不存在');
    await selectMeeting(meetingId, { forceScrollBottom: false });
    if (opts.focus && typeof MeetingRoom !== 'undefined' && typeof MeetingRoom.focusSearchHit === 'function') {
      const target = opts.preview && Array.isArray(opts.preview.context)
        ? (opts.preview.context.find(item => item && item.isMatch) || opts.preview.context[0])
        : null;
      requestAnimationFrame(() => MeetingRoom.focusSearchHit({
        eventId: hit.bestMatch && hit.bestMatch.eventId,
        text: target && target.text || hit.bestMatch && hit.bestMatch.text || '',
      }));
    }
    return { type: 'meeting', id: meetingId };
  }

  let target = findExistingSessionForSearchHit(hit);
  if (target && target.status === 'dormant') {
    await resumeDormantSession(target.id, { forceScrollBottom: false });
    target = sessions.get(target.id) || target;
  }
  if (!target) {
    const created = await createSessionFromSearchHit(hit);
    if (!created || !created.id) throw new Error('无法恢复这个原生会话');
    target = await waitForRendererSession(created.id) || created;
  }
  if (!target || !target.id) throw new Error('会话记录已不存在');
  await selectSession(target.id, { forceScrollBottom: !opts.focus });

  if (opts.focus) {
    applyViewMode('card');
    const loaded = await loadSessionHistoryToOverlay(target.id, { forceScrollBottom: false });
    if (loaded && loaded.mounted > 0) _cardHistoryHydratedSid = target.id;
    focusOrdinarySearchHit(hit, opts.preview);
  }
  return { type: 'session', id: target.id };
}

const pastSessionModals = createPastSessionModals({
  document,
  window,
  ipcRenderer,
  clipboard,
  escapeHtml,
  getSessions: () => sessions,
  selectSession: (sessionId, opts) => selectSession(sessionId, opts),
  openSearchHit: (hit, opts) => openGlobalSearchHit(hit, opts),
});
const { openResumeModal, openSearchModal } = pastSessionModals;
// Ctrl+click on a local file path in the terminal → open with OS default app.
// xterm's WebLinksAddon only handles URLs, so we register a separate link
// provider. Scans each line for ABS_PATH_RE (high confidence, no validation)
// and REL_PATH_RE (validated against session.cwd via fs.existsSync to avoid
// false positives on prose mentions). Click routes to openPreviewPanel for
// previewable extensions, otherwise to main via open-path → shell.openPath().
//
async function openPathInHub(filePath, opts = {}) {
  const cwd = opts.cwd || null;
  const raw = _cleanPathCandidate(filePath);
  if (!raw) return;
  if (/^https?:\/\//i.test(raw)) {
    await openPreviewPanel(raw);
    return;
  }
  const fullPath = _normalizeLocalPathForOpen(raw, cwd, opts.requireExistsForRel !== false);
  if (!fullPath) return;
  if (_isDirectoryPath(fullPath)) {
    const err = await ipcRenderer.invoke('open-path', fullPath);
    if (err) console.warn('[hub] open folder failed:', fullPath, '->', err);
    return;
  }
  if (PREVIEW_PATH_RE.test(fullPath)) {
    await openPreviewPanel(fullPath);
    return;
  }
  const err = await ipcRenderer.invoke('open-path', fullPath);
  if (err) console.warn('[hub] open-path failed:', fullPath, '->', err);
}
window.openPathInHub = openPathInHub;

window.collectPathCandidates = collectPathCandidates;

function getSessionCwd(sessionId) {
  try { return (sessions.get(sessionId) || {}).cwd || null; } catch { return null; }
}

const registerLocalPathLinks = createTerminalLinkRegistrar({
  getCwd: getSessionCwd,
  openPathInHub,
  onContextMenu: (rawPath, x, y) => {
    // pathLinkContextMenu is initialized later in this file; callback body
    // runs only when user right-clicks, by then it's been assigned.
    if (typeof pathLinkContextMenu !== 'undefined' && pathLinkContextMenu) {
      pathLinkContextMenu.open(rawPath, x, y);
    }
  },
});

// Strip artifacts we ourselves injected into the user's prompt before
// forming the sidebar preview. Today that's just clipboard-image paths:
// Ctrl+V on an image calls save-clipboard-image and pastes the resulting
// absolute path into the terminal, so CC's transcript records the path
// immediately before the user's typed text. Without this the 60-char
// preview is pure path and the real question is truncated away.
function buildPreviewFromUserMessage(raw) {
  let clean = String(raw).replace(HUB_IMG_PATH_RE, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > 60 ? clean.substring(0, 58) + '…' : clean;
}

// --- File Preview Panel ---
function refitActiveTerminalFromPreview() {
  const sid = activeSessionId;
  if (!sid) return;
  const cached = terminalCache.get(sid);
  if (!cached || !cached.opened) return;
  requestAnimationFrame(() => {
    if (!cached.container.offsetWidth) return;
    fitAndResizeTerminal(sid, cached, { force: true });
  });
}

const previewPanel = createPreviewPanelController({
  document,
  ipcRenderer,
  shell,
  fs,
  marked,
  DOMPurify,
  getActiveSessionId: () => activeSessionId,
  getActiveMeetingId: () => activeMeetingId,
  refitActiveTerminal: refitActiveTerminalFromPreview,
});
const {
  openPreviewPanel,
  savePreviewState,
  clearPreviewUI,
  restorePreviewForContext,
} = previewPanel;
// P0.6+: 暴露给 meeting-room.js 的"📖 记忆"按钮使用
window.openPreviewPanel = openPreviewPanel;

// main.js 的最后一道导航保护：若某个未接线/第三方生成的 file:// 链接试图替换 Hub
// 主页面，main 会阻止整页导航并把本地路径送回这里，仍按统一规则打开预览面板。
ipcRenderer.on('preview-local-file', (_event, filePath) => {
  openPathInHub(filePath, {
    cwd: getSessionCwd(activeSessionId),
    requireExistsForRel: false,
  });
});

// 2026-05-23 道雪：补全 main.js nav-guard 副作用 — 群聊/会议消息中 marked 渲染
//   出的 <a href="http(s)://..."> 若不在 capture 阶段截走，会触发主 webContents
//   will-navigate / setWindowOpenHandler，被 nav-guard 一律 shell.openExternal
//   弹到系统浏览器，绕过 in-app 预览。preview-body 内由 controller 自己处理，
//   rt-file-link 由 meeting-room.js 处理，其余 http(s) / 原始 file:// 链接统一走预览面板。
document.addEventListener('click', (e) => {
  const a = e.target && e.target.closest && e.target.closest('a[href]');
  if (!a) return;
  if (a.closest('#preview-body')) return;
  if (a.classList.contains('rt-file-link')) return;
  const href = a.getAttribute('href') || '';
  const isWebUrl = /^https?:\/\//i.test(href);
  const isLocalFileUrl = /^file:/i.test(href);
  if (!isWebUrl && !isLocalFileUrl) return;
  e.preventDefault();
  e.stopPropagation();
  if (isLocalFileUrl) {
    try {
      openPathInHub(fileURLToPath(href), {
        cwd: getSessionCwd(activeSessionId),
        requireExistsForRel: false,
      });
    } catch (error) {
      console.warn('[hub] invalid local file link blocked:', href, error && error.message);
    }
    return;
  }
  openPreviewPanel(href);
}, true);

// --- Terminal buffer reading and activity monitor ---
function classifySessionRuntimeFrame(session, lines) {
  if (isClaudeRuntimeSession(session)) return classifyTerminalRuntime('claude', lines);
  if (session && isCodexKind(session.kind)) return classifyTerminalRuntime('codex', lines);
  return { state: 'unknown', confidence: 'none', reason: 'unsupported-runtime', evidence: '' };
}

function applyPtyRuntimeObservation(session, runtime, observedAt = Date.now()) {
  if (!session || !runtime || session.status === 'dormant') return false;
  if (!isClaudeRuntimeSession(session) && !isCodexKind(session.kind)) return false;

  const at = Number(observedAt) || Date.now();
  const wasRunning = session.status === 'running';
  const fallbackArmed = canUsePtyBurstFallback(session, at);
  let changed = false;

  if (runtime.state === 'running') {
    // Do not let an idle TUI animation start a task from nothing. A local Enter
    // arms the PTY fallback, while hook/rollout lifecycle events set running
    // independently. The screen classifier upgrades either weak path once it
    // sees an actual provider running marker.
    if (!wasRunning && !fallbackArmed) return false;
    session._ptyRuntimeSawRunning = true;
    if (session._ptyRuntimePendingTimer) {
      clearTimeout(session._ptyRuntimePendingTimer);
      session._ptyRuntimePendingTimer = null;
    }
    session._ptyRuntimeState = runtime.state;
    session._ptyRuntimeReason = runtime.reason || null;
    session._ptyRuntimeEvidence = runtime.evidence || null;
    session._ptyRuntimeObservedAt = at;
    if (!wasRunning) {
      session.status = 'running';
      changed = true;
    }
    if (!session.runStartedAt) {
      session.runStartedAt = at;
      changed = true;
    }
    if (!session._runSource || session._runSource === 'burst') {
      session._runSource = 'pty-semantic';
      changed = true;
    }
    if (!session._agentWorking) {
      session._agentWorking = 'pty';
      changed = true;
    }
    session._lastOutputTs = at;
  } else if (runtime.state === 'idle' || runtime.state === 'waiting') {
    // An input-ready frame is the missing-completion escape hatch. It does not
    // fabricate transcript text or unread counts; a delayed authoritative Stop
    // hook/task_complete can still enrich the card afterwards.
    if (!wasRunning) return false;
    const runStartedAt = Number(session.runStartedAt) || Number(session._ptyFallbackArmedAt) || 0;
    if (runtime.state === 'idle'
        && !session._ptyRuntimeSawRunning
        && (!runStartedAt || at - runStartedAt < PTY_RUNTIME_SUBMIT_PENDING_MS)) {
      return false;
    }
    if (runStartedAt > 0 && at >= runStartedAt) {
      session.lastRunStartedAt = runStartedAt;
      session.lastRunDurationMs = at - runStartedAt;
    }
    session.runStartedAt = null;
    session.status = 'idle';
    if (runtime.state === 'waiting') {
      // A live confirmation overlay is stronger than transcript silence: the
      // provider has stopped generating and is explicitly blocked on the user.
      // Keep this lightweight so a delayed authoritative Stop/task_complete can
      // still record the completed turn and unread notification exactly once.
      markSessionNeedsUserInput(session, {
        reason: runtime.reason || 'pty-interactive-confirmation',
        text: runtime.evidence || null,
      });
    }
    if (isCodexKind(session.kind)) {
      clearCodexCardWorking(session.id);
    } else {
      session._agentWorking = null;
      session._runSource = null;
      disarmPtyBurstFallback(session, at);
    }
    changed = true;
  }

  if (!changed) return false;
  session._ptyRuntimeState = runtime.state;
  session._ptyRuntimeReason = runtime.reason || null;
  session._ptyRuntimeEvidence = runtime.evidence || null;
  session._ptyRuntimeObservedAt = at;
  if (typeof _updateStreamingIndicator === 'function') _updateStreamingIndicator(session.id);
  scheduleSessionListRender();
  schedulePersist();
  return true;
}

const terminalActivityMonitor = createTerminalActivityMonitor({
  sessions,
  terminalCache,
  getActiveSessionId: () => activeSessionId,
  // PTY output can update preview/running/idle several times in one burst.
  // Route those state changes through the same coalescer as semantic events so
  // a classification change never rebuilds the sidebar for every chunk.
  renderSessionList: scheduleSessionListRender,
  schedulePersist,
  updateStreamingIndicator: (sessionId) => {
    if (typeof _updateStreamingIndicator === 'function') _updateStreamingIndicator(sessionId);
  },
  hasSemanticCardWorking,
  // Only suppress PTY fallback while an authoritative semantic signal is
  // actually active. The old predicate returned true merely because the
  // session *kind* was Claude/Codex/Kimi. When settings.json lost the Hub
  // UserPromptSubmit hook, Claude could work for minutes while status stayed
  // idle because its PTY bytes were permanently ignored. The fallback below
  // remains available, but only after an explicit local prompt arms it.
  hasSemanticWorking: (s) => !!(s && (
    (isClaudeRuntimeSession(s) && s._agentWorking === 'hook' && s.status === 'running')
    || (isTranscriptCliKind(s.kind) && hasSemanticCardWorking(s))
    || (s._runSource === 'pty-semantic' && s._agentWorking === 'pty' && s.status === 'running')
  )),
  canUsePtyBurstFallback,
  onPtyBurstSettled: (session, settledAt) => disarmPtyBurstFallback(session, settledAt),
  classifyRuntimeState: classifySessionRuntimeFrame,
  onRuntimeState: applyPtyRuntimeObservation,
  canObserveRuntimeState: (session) => isClaudeRuntimeSession(session) || !!(session && isCodexKind(session.kind)),
});
const {
  getQuestionsSignature,
  readTerminalPreview,
  extractTailLines,
  isWaitingForUser,
  onTerminalOutput,
  clearSession: clearTerminalActivitySession,
} = terminalActivityMonitor;
// --- IPC event handlers ---
const _cursorDebounce = new Map();

// Codex TUI placeholder filter — the interactive TUI repeatedly redraws
// "› Improve documentation in @filename" as input placeholder text. Due to
// PTY/xterm size mismatch during startup, cursor positioning fails and the
// placeholder leaks into scrollback.  Regex is ANSI-tolerant (handles color
// codes between words).
const _A = '(?:\\x1b\\[[0-9;]*[a-zA-Z])*';
const CODEX_PLACEHOLDER_RE = new RegExp(
  `[›> ]*${_A}I?m?prove${_A}\\s?${_A}documentation${_A}\\s?${_A}in${_A}\\s?${_A}@[^\\s]*`, 'g'
);

function writeTerminalChunk(sessionId, cached, data) {
  if (!cached || !data) return;
  const sess = sessions.get(sessionId);
  if (sess && isCodexKind(sess.kind)) {
    const pinAfterWrite = shouldAutoPinCodexTerminal(sessionId, cached);
    let filtered = data;
    if (filtered.includes('prove documentation')) {
      filtered = filtered.replace(CODEX_PLACEHOLDER_RE, '');
    }
    cached.terminal.write(filtered + '\x1b[?25l');
    clearTimeout(_cursorDebounce.get(sessionId));
    _cursorDebounce.set(sessionId, setTimeout(() => {
      cached.terminal.write('\x1b[?25h');
    }, 150));
    if (pinAfterWrite) scheduleCodexBottomPin(sessionId, cached);
  } else {
    cached.terminal.write(data);
  }
}

// Meeting-room used to switch an embedded xterm tab when an AI avatar was
// clicked. Embedded terminals were removed in v1.6.1, so expose the current
// architecture's equivalent: leave the meeting and open that child session in
// the main session surface. Keep the bridge explicit instead of relying on a
// top-level function accidentally becoming a Window property.
window.openMeetingMemberSession = function openMeetingMemberSession(sessionId) {
  if (!sessionId || !sessions.has(sessionId)) return false;
  void selectSession(sessionId, { forceScrollBottom: true });
  return true;
};

const XTERM_REPLAY_CHUNK_CHARS = 64 * 1024;

async function writeXtermAndWait(terminal, data) {
  if (!terminal || !data) return;
  const source = String(data);
  for (let start = 0; start < source.length;) {
    let end = Math.min(source.length, start + XTERM_REPLAY_CHUNK_CHARS);
    if (end < source.length) {
      const last = source.charCodeAt(end - 1);
      if (last >= 0xD800 && last <= 0xDBFF) end += 1;
    }
    await new Promise((resolve) => {
      try { terminal.write(source.slice(start, end), resolve); } catch { resolve(); }
    });
    start = end;
    // Snapshot hydration is recovery work, not a reason to block input/paint.
    // Yield between chunks while preserving the exact byte/order stream.
    if (start < source.length) await new Promise(resolve => setTimeout(resolve, 0));
  }
}

async function replayTerminalSnapshot(cached, snapshot) {
  if (!cached || !cached.terminal || !snapshot) return;
  const operations = Array.isArray(snapshot.operations) ? snapshot.operations : null;
  const snapshotText = typeof snapshot === 'object'
    ? String(snapshot.text || '')
    : (typeof snapshot === 'string' ? snapshot : '');

  if (!operations) {
    await writeXtermAndWait(cached.terminal, snapshotText);
    return;
  }

  // Structured snapshots preserve resize boundaries without making the main
  // process build a headless framebuffer for every opened/resumed session.
  // Start the serialized base at the geometry it was captured with, then apply
  // ordered writes/resizes. The normal fit pass below restores current UI size.
  const baseCols = Math.max(2, Number(snapshot.baseCols) || cached.terminal.cols);
  const baseRows = Math.max(1, Number(snapshot.baseRows) || cached.terminal.rows);
  try {
    if (cached.terminal.cols !== baseCols || cached.terminal.rows !== baseRows) {
      cached.terminal.resize(baseCols, baseRows);
    }
  } catch {}
  await writeXtermAndWait(cached.terminal, snapshotText);
  for (const operation of operations) {
    if (!operation || typeof operation !== 'object') continue;
    if (operation.type === 'resize') {
      const cols = Math.max(2, Number(operation.cols) || cached.terminal.cols);
      const rows = Math.max(1, Number(operation.rows) || cached.terminal.rows);
      try {
        if (cached.terminal.cols !== cols || cached.terminal.rows !== rows) {
          cached.terminal.resize(cols, rows);
        }
      } catch {}
    } else if (operation.type === 'write') {
      await writeXtermAndWait(cached.terminal, String(operation.data || ''));
    }
  }
}

async function hydrateTerminalFromSnapshot(sessionId, cached) {
  if (!cached || cached._hydrated || cached._hydrating) return;
  cached._hydrating = true;
  let snapshot = null;
  try {
    snapshot = await ipcRenderer.invoke('get-session-buffer-snapshot', sessionId);
  } catch (err) {
    console.warn('[terminal] snapshot hydrate failed:', err && err.message);
  }
  if (terminalCache.get(sessionId) !== cached) return;
  const snapshotSeq = snapshot && Number.isFinite(Number(snapshot.seq)) ? Number(snapshot.seq) : 0;
  await replayTerminalSnapshot(cached, snapshot);
  if (terminalCache.get(sessionId) !== cached) return;
  cached._hydratedSeq = snapshotSeq;

  // Keep live IPC output queued until the snapshot parser has really finished,
  // then drain until stable. Previously `_hydrated` flipped immediately after
  // terminal.write(), while xterm was still parsing a megabyte-scale snapshot;
  // fit/refresh ran against an empty buffer and some Canvas surfaces stayed
  // visually blank even though later data existed.
  while (cached._pendingOutput.length) {
    const pending = cached._pendingOutput.splice(0);
    cached._pendingOutputBytes = 0;
    for (const item of pending) {
      const itemSeq = Number(item.seq);
      if (Number.isFinite(itemSeq) && itemSeq <= cached._hydratedSeq) continue;
      let data = String(item.data || '');
      const sess = sessions.get(sessionId);
      if (sess && isCodexKind(sess.kind) && data.includes('prove documentation')) {
        data = data.replace(CODEX_PLACEHOLDER_RE, '');
      }
      await writeXtermAndWait(cached.terminal, data);
      if (Number.isFinite(itemSeq)) cached._hydratedSeq = Math.max(cached._hydratedSeq, itemSeq);
      onTerminalOutput(sessionId, String(item.data || '').length);
    }
  }
  cached._hydrated = true;
  cached._hydrating = false;
  // Snapshot replay reconstructs history, but the live CLI remains the
  // authority for its current full-screen frame. Force one final-size redraw
  // after the replay barrier. This also self-heals any partial ANSI frame that
  // was captured while a long Codex session was actively painting.
  cached._needsPtyRedraw = true;
  // showTerminal 里 hydrate 是 void 调用，紧跟其后的 rAF 会在快照还没回来时就
  // fitAndResizeTerminal —— 也就是说那次 fit 作用在一个空终端上，而真正的内容是之后
  // 才写进来的，此后再没有任何一次 fit/pin。内容量一变（尤其带绝对定位的 TUI 帧），
  // 布局就可能停在按空终端算出来的状态。回灌完成后补一次 fit + 置底。
  if (sessionId === activeSessionId) {
    fitAndResizeTerminal(sessionId, cached, { force: true, forcePtyResize: true });
    cached._needsPtyRedraw = false;
    refreshTerminalRendererSurface(cached);
    try { cached.terminal.scrollToBottom(); } catch {}
    requestAnimationFrame(() => {
      if (terminalCache.get(sessionId) !== cached) return;
      if (!cached.opened || !cached.container || !cached.container.offsetWidth) return;
      fitAndResizeTerminal(sessionId, cached, { force: true });
      refreshTerminalRendererSurface(cached);
      try { cached.terminal.scrollToBottom(); } catch {}
    });
  }
}

// Tool block folding 已废弃（2026-04-28）：之前 Claude session 的 ● tool 块下方
// 非 tool 行被改写成 "⋯ N lines" + xterm decoration 弹窗，长会话 buffer 滚动 +
// Codex/Gemini 路径不一致会渲染叠字错位。所有 kind 的 terminal-data 现在统一直写。

ipcRenderer.on('terminal-data', (_e, { sessionId, data, seq }) => {
  const cached = terminalCache.get(sessionId);
  if (!cached) return;
  if (!cached._hydrated) {
    const item = { data: String(data || ''), seq };
    cached._pendingOutput.push(item);
    cached._pendingOutputBytes += item.data.length;
    while (cached._pendingOutputBytes > MAX_PENDING_TERMINAL_BYTES && cached._pendingOutput.length > 1) {
      const dropped = cached._pendingOutput.shift();
      cached._pendingOutputBytes -= dropped.data.length;
    }
    return;
  }
  const numericSeq = Number(seq);
  if (Number.isFinite(numericSeq) && numericSeq <= cached._hydratedSeq) return;
  if (Number.isFinite(numericSeq)) cached._hydratedSeq = numericSeq;
  writeTerminalChunk(sessionId, cached, data);
  onTerminalOutput(sessionId, data.length);

  // Spec 2 partial-update workaround + Spec 3 · B1+B3 优化:
  // transcriptTap.emit('turn-complete') only fires on stop_reason ∈ {end_turn, max_tokens, refusal} —
  // assistant turns with stop_reason='tool_use' wait for the next message; card view lags PTY.
  // Throttle (leading edge) reload card while PTY streams. Not debounce — debounce
  // resets timer on every PTY chunk, so during streaming it never fires until full silence.
  // Spec 3 · B1：传 incremental:true → mount dedup 自动跳过已存在 turn id，无需全清重建
  // P1：大 transcript 下 250ms 会造成 UI 卡顿，改为约 1.2s + stream-end final reload。
  if (sessionId === activeSessionId && currentView === 'card' && typeof loadSessionHistoryToOverlay === 'function') {
    if (!window._cardReloadState) window._cardReloadState = new Map();
    let st = window._cardReloadState.get(sessionId);
    const sessForReload = sessions.get(sessionId);
    if (!sessForReload || (!sessForReload.transcriptPath && !sessForReload.ccSessionId)) return;
    if (!st) { st = { lastReloadAt: 0, pendingTimer: null, inProgress: false }; window._cardReloadState.set(sessionId, st); }
    if (!st.pendingTimer && !st.inProgress) {
      const sinceLast = Date.now() - st.lastReloadAt;
      const delay = Math.max(200, 1200 - sinceLast);
      st.pendingTimer = setTimeout(() => {
        st.pendingTimer = null;
        // Spec 3 · W2 throttle race fix：timer 创建时 sessionId === activeSessionId，
        // 但 timer fire 时 user 可能已切到别的 session。incremental:true 会跳过 clear，
        // 直接 append 旧 session 的 turns 到当前 overlay → 跨 session 数据污染。
        // 这里再次比对，不一致就静默跳过（旧 session 的数据要等用户切回才有意义）。
        if (sessionId !== activeSessionId || currentView !== 'card') {
          st.inProgress = false;
          return;
        }
        st.inProgress = true;
        st.lastReloadAt = Date.now();
        loadSessionHistoryToOverlay(sessionId, {
          incremental: true,
          parseOpts: { limit: 1, fromTail: true },
        })
          .catch(err => console.warn('[card auto-reload] failed:', err))
          .finally(() => { st.inProgress = false; });
      }, delay);
    }

    // P0 stream-end fallback (2026-05-10)：250ms throttle 是 leading-edge，PTY 字节静默后
    //   只能再 fire 一次。但 Claude CLI 在 token 流完后才把 end_turn entry append 到 JSONL
    //   （writeback 偶发滞后），最后一次 reload 拿到的可能还是 tool_use 中间态 → 卡片定格。
    //   再叠一层"PTY 静默 800ms 后强制 final reload"，覆盖此 race。stop_hook 走 turn-complete-event
    //   是另一条更快的路径，这里只做兜底。
    if (!window._cardStopFallbackBySid) window._cardStopFallbackBySid = new Map();
    clearTimeout(window._cardStopFallbackBySid.get(sessionId));
    window._cardStopFallbackBySid.set(sessionId, setTimeout(() => {
      window._cardStopFallbackBySid.delete(sessionId);
      if (sessionId === activeSessionId && currentView === 'card') {
        loadSessionHistoryToOverlay(sessionId, {
          incremental: true,
          parseOpts: { limit: 1, fromTail: true },
        })
          .catch(err => console.warn('[card stream-end fallback] failed:', err));
      }
    }, 1000));
  }
});

// Status updates from our custom statusline script.
// Carries contextPct / cwd / api time / session_name per session + account-wide usage5h/usage7d.
const providerModes = {
  claude: 'subscription',
  gemini: 'subscription',
  codex: 'subscription',
  kimi: 'subscription',
  deepseek: 'api',
};
const accountUsageController = createAccountUsageController({
  document,
  ipcRenderer,
  sessions,
  escapeHtml,
});
const renderAccountUsage = accountUsageController.render;
homeWorkbench = createHomeWorkbench({
  document,
  sessions,
  getSessions: () => sessions,
  getMeetings: () => meetings,
  getResourceUsage: () => systemResourceUsage,
  getHubConfig: () => hubProxyInfo,
  getUsageSnapshot: () => accountUsageController.getSnapshot(),
  getTerminalCacheSize: () => terminalCache.size,
  loadWorkspaces: () => ipcRenderer.invoke('workspace:list'),
  selectSession: (sessionId, opts) => selectSession(sessionId, opts),
  selectMeeting: (meetingId, opts) => selectMeeting(meetingId, opts),
  onCopyRecentTurns: (sessionId, count) => copyRecentTurnsForSession(sessionId, count),
  onForkSession: (sessionId) => keyboardShortcuts.forkSession(sessionId),
  onOpenArtifact: (artifactPath) => openPathInHub(artifactPath, { requireExistsForRel: false }),
  onLaunchWorkspace: (workspace) => window.WorkspaceController.openNewSessionModal({ kind: 'claude', workspace }),
  escapeHtml,
  onRefresh: async () => {
    const results = await Promise.allSettled([
      refreshSystemResourceUsage(),
      refreshHubProxyInfo(),
      accountUsageController.refreshUsageNow(),
    ]);
    if (results.every((result) => result.status === 'rejected')) {
      throw new Error('全局状态刷新失败');
    }
  },
});
homeWorkbench.render();
// 记忆系统面板：用量 ticker 的「记忆」按钮打开（按钮监听在面板内走文档级委托，
// 因为 ticker 每次 render 都重建 innerHTML）。
const memoryPanel = createMemoryPanel({
  document,
  ipcRenderer,
  escapeHtml,
  getActiveSessionInfo: () => {
    const s = sessions.get(activeSessionId);
    return s ? { cwd: s.cwd, kind: s.kind, title: s.title } : null;
  },
});
function pctClass(pct) { return accountUsageController.pctClass(pct); }
if (typeof window !== 'undefined') window.pctClass = pctClass;

ipcRenderer.on('status-event', (_e, payload) => {
  const session = sessions.get(payload.sessionId);
  if (session) {
    if (Object.prototype.hasOwnProperty.call(payload, 'contextPct')) session.contextPct = payload.contextPct;
    if (Object.prototype.hasOwnProperty.call(payload, 'contextUsed')) session.contextUsed = payload.contextUsed;
    if (Object.prototype.hasOwnProperty.call(payload, 'contextMax')) session.contextMax = payload.contextMax;
    if (typeof payload.contextUsed === 'number') {
      accountUsageController.recordSessionContextSample(session, payload.contextUsed);
    }
    // cwd is write-once: only record it if we don't have one yet. Statusline
    // fires repeatedly and the user's `cd` during the session would otherwise
    // corrupt the saved cwd, breaking future `claude --resume` (CC scopes
    // resume to the transcript's original project slug = original cwd).
    if (payload.cwd && !session.cwd) session.cwd = payload.cwd;
    if (typeof payload.apiMs === 'number') session.apiMs = payload.apiMs;
    if (typeof payload.linesAdded === 'number') session.linesAdded = payload.linesAdded;
    if (typeof payload.linesRemoved === 'number') session.linesRemoved = payload.linesRemoved;
    if (payload.model && payload.model.id) {
      session.currentModel = payload.model;
      if (payload.sessionId === activeSessionId) updateActiveModelBadge();
    }
    // Claude → Hub title sync: only overlay if user hasn't explicitly renamed in Hub.
    // The /rename we inject comes back via this same field — the guard below prevents loops.
    // Meeting room subs keep their default "Claude N" name — auto-rename produces
    // long titles that clutter the narrow tab headers.
    const cleanSessionName = typeof payload.sessionName === 'string' ? payload.sessionName.trim() : '';
    if (shouldAcceptExternalSessionTitle(session, cleanSessionName) && session.title !== cleanSessionName) {
      session.title = cleanSessionName;
      session.claudeSessionName = cleanSessionName;
      if (payload.sessionId === activeSessionId) {
        const el = terminalPanelEl.querySelector('.terminal-title');
        if (el) el.textContent = cleanSessionName;
      }
    }
    if (payload.sessionId === activeSessionId) updateActiveMetricsRow();
    if (typeof MeetingRoom !== 'undefined' && MeetingRoom.refreshSessionMetrics) {
      MeetingRoom.refreshSessionMetrics(payload.sessionId);
    }
  }
  accountUsageController.recordStatusUsage(payload);
  scheduleSessionListRender();
});

ipcRenderer.on('agent-usage', (_e, totals) => {
  accountUsageController.recordAgentUsage(totals);
  if (homeWorkbench) homeWorkbench.render();
});

// Compact "3m20s" / "1h5m" — used for api duration in the header metrics row.
function formatDuration(ms) {
  if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? (s % 60) + 's' : ''}`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? (m % 60) + 'm' : ''}`;
}

// Render the per-session metrics row (cwd · api time · lines diff). Called on
// session switch + every status-event for the active session.
function renderMetricsRow(el, session) {
  if (!el || !session) return;
  el.innerHTML = '';
  const frags = [];
  if (session.cwd) {
    const a = document.createElement('span');
    a.className = 'metric-cwd';
    a.textContent = '\uD83D\uDCC1 ' + (session.workspaceLabel ? `${session.workspaceLabel} · ` : '') + session.cwd;
    const copyCwd = () => {
      try { clipboard.writeText(session.cwd); } catch {}
    };
    const idleTitle = 'Click to copy · ' + session.cwd;
    // 归档提示挂在 header 这条路径上，与 AI 群聊 header 的 workspace chip 同一套
    // 实现（WorkspaceController.attachArchiveHint）：有归档建议时显示琥珀色轻标记，
    // 点击打开归档框；没有建议就还是原来的「点击复制路径」。
    // 之前这套只在群聊侧存在，独立会话的建议进了没人读的 Map，用户永远看不到提示。
    const attached = !!(window.WorkspaceController
      && typeof window.WorkspaceController.attachArchiveHint === 'function'
      && window.WorkspaceController.attachArchiveHint(a, 'session', session.id, {
        hintTitle: '这个任务还在临时区 · 点击归档到正式项目目录',
        idleTitle,
        onFallback: copyCwd,
      }));
    if (!attached) {
      a.title = idleTitle;
      a.addEventListener('click', copyCwd);
    }
    frags.push(a);
  }
  if (typeof session.apiMs === 'number' && session.apiMs > 0) {
    const s = document.createElement('span');
    s.textContent = '\u23F1 ' + formatDuration(session.apiMs);
    s.title = 'Total API time (AI actually working)';
    frags.push(s);
  }
  frags.forEach((f, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'metric-sep';
      sep.textContent = '\u00b7';
      el.appendChild(sep);
    }
    el.appendChild(f);
  });
}

function updateActiveMetricsRow() {
  const session = activeSessionId ? sessions.get(activeSessionId) : null;
  if (!session) return;
  const row = terminalPanelEl.querySelector('.terminal-metrics-row');
  if (row) renderMetricsRow(row, session);
}

// 归档建议到达时立刻重画 header 上的 📁 路径，否则要等下一个 status-event
// 才看得见提示态。和 AI 群聊那侧的监听对称（meeting-room.js 只处理 meeting scope）。
// 只重画，不弹任何东西——是否归档由用户点 chip 决定。
window.addEventListener('workspace-archive-suggestion', (event) => {
  const detail = event && event.detail;
  if (!detail || detail.scope !== 'session') return;
  if (!activeSessionId || detail.id !== activeSessionId) return;
  updateActiveMetricsRow();
});

// Claude Code hooks drive the session state.
// - 'prompt' (UserPromptSubmit): fires the moment user presses Enter.
//   Immediately flag the session as running — faster & more precise than
//   the 200-byte PTY heuristic.
// - 'stop' (Stop): fires when the agent loop finishes. Triggers unread/time bump.
ipcRenderer.on('hook-event', (_e, { event, eventAt, sessionId, claudeSessionId, cwd, latestUserMessage }) => {
  const s = sessions.get(sessionId);
  if (s) {
    // Persist CC session id + cwd the first time we learn them so resumes work.
    if (claudeSessionId && s.ccSessionId !== claudeSessionId) {
      s.ccSessionId = claudeSessionId;
      const collapsed = collapseDormantNativeDuplicates(sessions);
      if (collapsed.length) scheduleSessionListRender();
      schedulePersist();
    }
    // Only capture cwd ONCE (first hook). Updating on every hook lets a later
    // user `cd` mutate the saved value, which then breaks `claude --resume` on
    // next launch — CC stores transcripts under a project slug derived from
    // the cwd at CREATE time, so resume must spawn in that same cwd.
    if (cwd && !s.cwd) {
      s.cwd = cwd;
      schedulePersist();
    }
    // Authoritative preview: CC's own transcript JSONL. Wins over any regex
    // extraction from the xterm buffer — no more "assistant content misread
    // as user question" false positives.
    if (latestUserMessage) {
      const preview = buildPreviewFromUserMessage(latestUserMessage);
      if (preview && preview !== s.lastOutputPreview) {
        s.lastOutputPreview = preview;
        s._previewFromTranscript = true;
        // Sync lastMessageTime with the preview change. Previously time only
        // updated on Stop (via onReplyCompleteFromHook), so if Stop missed or
        // only UserPromptSubmit fired, the sidebar showed fresh text next to a
        // stale timestamp. Keep text and time in lockstep — a preview change
        // IS a message event regardless of event type.
        s.lastMessageTime = Date.now();
        scheduleSessionListRender();
        schedulePersist();
      }
    }
  }
  if (event === 'stop') {
    onReplyCompleteFromHook(sessionId, eventAt);
    // Flush any queued /rename now that Claude is idle. Small delay so the
    // prompt fully re-renders before we inject the command.
    const s = sessions.get(sessionId);
    if (s && s._pendingRename) {
      const pending = s._pendingRename;
      s._pendingRename = null;
      setTimeout(() => {
        ipcRenderer.send('terminal-input', { sessionId, data: '/rename ' + pending + '\r' });
      }, 400);
    }
    // A new turn landed — ask minimap to rescan for any new prompt ticks.
    const cached = terminalCache.get(sessionId);
    if (cached && cached._minimap) cached._minimap.invalidate();
  }
  else if (event === 'prompt') onPromptSubmittedFromHook(sessionId, eventAt);
});

function onPromptSubmittedFromHook(sessionId, submittedAt = Date.now()) {
  const session = sessions.get(sessionId);
  if (!session) return;
  const transition = applyPromptSubmitted(session, { submittedAt });
  if (!transition.applied) return;
  armPtyBurstFallback(sessionId, transition.at);
  // 2026-07-20 道雪：hook prompt = claude 语义工作开始（与 stop hook 配对收尾）
  session._agentWorking = 'hook';
  session._runSource = 'semantic';
  session._lastOutputTs = transition.at;
  scheduleSessionListRender();
}

// v0.13 · P0 #1: 跟踪窗口最近一次获得 focus 的时间，用于 onReplyCompleteFromHook
// 的 seenByUser 判断加 500ms 缓冲（alt-tab 切回瞬间 document.hasFocus() 还未更新
// 的窗口期会误判 → 错弹红点）。
let _lastWindowFocusAt = Date.now();
window.addEventListener('focus', () => {
  _lastWindowFocusAt = Date.now();
  recoverVisibleActiveTerminalSurface();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') recoverVisibleActiveTerminalSurface();
});

function buildReplyReadyPreview(text, fallback = 'Codex 回复完成，等你继续') {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return fallback;
  return raw.length > 120 ? raw.slice(0, 118) + '…' : raw;
}

function clearSessionWaitingState(sessionId, options = {}) {
  const session = sessions.get(sessionId);
  if (!session || !clearSessionAttention(session, options)) return;
  scheduleSessionListRender();
  schedulePersist();
}

function onReplyCompleteFromTranscriptEvent(payload) {
  const { hubSessionId, text, completedAt, meetingId, kind, turnId } = payload || {};
  if (!hubSessionId) return;
  if (!isTranscriptCliKind(kind)) return;

  const session = sessions.get(hubSessionId);
  if (!session) return;
  if (session.status === 'dormant') return;
  const backgroundActive = isKimiCliKind(session.kind) && hasKimiBackgroundWork(session);
  if (isKimiCliKind(session.kind) && !backgroundActive) {
    clearKimiBackgroundFinishTimer(hubSessionId);
  }

  const preview = buildReplyReadyPreview(text);
  const sig = `${turnId || ''}:${completedAt || ''}:${preview}`;
  if (session._lastTranscriptReadySig === sig) return;
  const isActive = hubSessionId === activeSessionId;
  const focusOk = document.hasFocus() || (Date.now() - _lastWindowFocusAt < 500);
  const seenByUser = isActive && focusOk;
  const transition = applyReplyCompleted(session, {
    completedAt,
    turnId,
    text: preview,
    seenByUser: !!meetingId || backgroundActive || seenByUser,
    incrementUnread: !meetingId && !backgroundActive,
    keepRunning: backgroundActive,
  });
  if (!transition.applied) return;
  session._lastTranscriptReadySig = sig;
  session.lastMessageTime = transition.at;
  recordSessionArtifacts(session, text || preview, transition.at);

  // 与 onPromptSubmittedFromTranscriptEvent 的开工标记配对：群聊成员干完活要收尾，
  // 否则状态灯会一直卡在运行中，只能等 45 分钟的 maxAge 兜底。群聊的未读仍由
  // meeting-room 管理；这里只用同一有序 reducer 防旧 completion 覆盖新 prompt。
  if (meetingId) {
    if (backgroundActive) markCodexCardWorking(hubSessionId, 'kimi_background_agent');
    else clearCodexCardWorking(hubSessionId);
    if (typeof _updateStreamingIndicator === 'function') _updateStreamingIndicator(hubSessionId);
    scheduleSessionListRender();
    schedulePersist();
    return;
  }

  if (!backgroundActive) clearCodexCardWorking(hubSessionId);
  session.lastOutputPreview = preview;
  if (backgroundActive) {
    session.status = 'running';
    markCodexCardWorking(hubSessionId, 'kimi_background_agent');
  }
  if (typeof _updateStreamingIndicator === 'function') _updateStreamingIndicator(hubSessionId);
  scheduleSessionListRender();
  schedulePersist();
}

function onPromptSubmittedFromTranscriptEvent(payload) {
  const { hubSessionId, text, submittedAt, meetingId, kind, turnId, signalSource } = payload || {};
  if (!hubSessionId) return;
  if (!isTranscriptCliKind(kind)) return;

  const session = sessions.get(hubSessionId);
  if (!session) return;
  if (session.status === 'dormant') return;

  const transition = applyPromptSubmitted(session, { submittedAt, turnId });
  if (!transition.applied) return;
  armPtyBurstFallback(hubSessionId, transition.at);

  // 2026-07-28 用户反馈：群聊里直接点进 Codex 的 CLI 布置任务，Codex 明明在跑，
  //   状态灯却一直是绿色（就绪），群聊也进不了侧栏的"运行中"分区。
  //   根因就是这里原本第一行就 `if (meetingId) return`——群聊成员的开工信号被整条丢掉。
  //   codex/kimi 的 running 只能由 transcript 事件驱动（byte-burst 对它们是关掉的，
  //   见 terminal-activity-monitor.js），所以这条一早退，就再没有别的东西会标记它在跑。
  //   claude 走 hook 路径本来就没有这层早退，这也是为什么之前只有 codex/kimi 不亮灯。
  // 卡片/预览/未读仍然归 meeting-room.js 那条流水线管，这里只认领"会话自身在不在干活"。
  const workingSource = signalSource === 'task_started'
    ? 'rollout_task_started'
    : 'rollout_user_message';

  if (meetingId) {
    markCodexCardWorking(hubSessionId, workingSource);
    scheduleSessionListRender();
    return;
  }

  const preview = buildPreviewFromUserMessage(text);
  const sig = `${turnId || ''}:${submittedAt || ''}:${preview}`;
  if (preview && session._lastTranscriptPromptSig === sig) return;
  session._lastTranscriptPromptSig = sig;

  if (preview) {
    session.lastOutputPreview = preview;
    session._previewFromTranscript = true;
  }
  markCodexCardWorking(hubSessionId, workingSource);
  session.lastMessageTime = transition.at;
  if (typeof _updateStreamingIndicator === 'function') _updateStreamingIndicator(hubSessionId);
  scheduleSessionListRender();
  schedulePersist();
}

// Hook-server health indicator (banner in sidebar when down)
let hookUp = true;
ipcRenderer.on('hook-status', (_e, { up }) => {
  const wasUp = hookUp;
  hookUp = up;
  renderHookStatus();
  // Hook going down: re-enable the regex-based preview/unread fallback by
  // clearing the "hook is authoritative" flag on every session. Without this
  // the previous successful hook pinned readTerminalPreview into short-circuit
  // forever — so if CC's hook plumbing broke mid-day, the sidebar would go
  // silent with no visible cause. When hook comes back, the next hook-event
  // sets the flag again on the session it touches.
  if (wasUp && !up) {
    for (const s of sessions.values()) {
      if (s._previewFromTranscript) s._previewFromTranscript = false;
    }
  }
});

function renderHookStatus() {
  let banner = document.getElementById('hook-status-banner');
  if (hookUp) {
    if (banner) banner.remove();
    return;
  }
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'hook-status-banner';
    banner.className = 'hook-status-banner';
    banner.textContent = 'Hook server offline — unread notifications may be delayed (silence fallback active)';
    document.querySelector('.session-sidebar').prepend(banner);
  }
}

function onReplyCompleteFromHook(sessionId, completedAt = Date.now()) {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (session.status === 'dormant') return;

  // v0.13 · P1 #5: Stop hook 500ms 去重窗口。CC 在 agent 子任务 / streaming
  // 抖动场景下偶尔会发两次 Stop，无去重导致 unread 计数加倍。
  const now = Date.now();
  if (session._lastStopHookTs && now - session._lastStopHookTs < 500) return;

  // Fallback preview from xterm buffer — only matters when hook didn't supply
  // a transcript-sourced preview (very rare). Primary preview is written by
  // the hook-event handler directly from CC's JSONL.
  readTerminalPreview(sessionId);

  // "Claude is waiting for your input" — classify the tail of the AI's output.
  const w = isWaitingForUser(extractTailLines(sessionId, 40));

  // Stop hook IS the "AI finished replying" signal — fires once per Q&A turn.
  // Bump unread when the user hasn't actually seen the message: either this
  // session isn't the active one, OR the Hub window is unfocused (user alt-
  // tabbed away). The old check `sessionId !== activeSessionId` alone missed
  // the "focus lost, active-session reply lands, user returns with no badge"
  // case — matches the intermittent "有时候不提示" report.
  const isActive = sessionId === activeSessionId;
  // v0.13 · P0 #1: alt-tab 切回 Hub 的 0~500ms 窗口里 hasFocus() 仍是 false，
  // 但用户明明已经在看 → 不应弹红点。用 _lastWindowFocusAt 时间戳补缓冲。
  const focusOk = document.hasFocus() || (Date.now() - _lastWindowFocusAt < 500);
  const seenByUser = isActive && focusOk;
  const preview = buildReplyReadyPreview(
    w.text || session.lastOutputPreview,
    'Claude 回复完成，等你继续',
  );
  const transition = applyReplyCompleted(session, {
    completedAt,
    text: preview,
    seenByUser,
    needsUserInput: !!w.waiting,
    reason: w.reason,
  });
  if (!transition.applied) return;
  session._lastStopHookTs = now;
  recordSessionArtifacts(session, w.text || session.lastOutputPreview || preview, transition.at);

  // 2026-07-20 道雪：stop hook = claude 语义工作结束，与 prompt hook 配对。
  session._agentWorking = null;
  session._runSource = null;
  disarmPtyBurstFallback(session, transition.at);
  session.lastMessageTime = transition.at;
  scheduleSessionListRender();
  schedulePersist();
}

// --- Keyboard shortcuts ---
const keyboardShortcuts = createKeyboardShortcuts({
  document,
  ipcRenderer,
  clipboard,
  sessions,
  terminalCache,
  getActiveSessionId: () => activeSessionId,
  getCurrentFontSize: () => currentFontSize,
  selectSession,
  escapeToHome,
  toggleSidebar,
  openTerminalSearch: () => openTerminalSearch(),
  setFontSize,
  closeSession: closeSessionAsSleep,
  createWorkspaceSession: (kind) => window.WorkspaceController.openNewSessionModal({ kind }),
});
keyboardShortcuts.init();
// --- Context menus ---
const sessionContextMenu = createSessionContextMenuController({
  document,
  window,
  contextMenuEl,
  sessions,
  meetings,
  ipcRenderer,
  getActiveSessionId: () => activeSessionId,
  setActiveSessionId: (value) => { activeSessionId = value; },
  getActiveMeetingId: () => activeMeetingId,
  setActiveMeetingId: (value) => { activeMeetingId = value; },
  closeMeetingPanel: () => { if (typeof MeetingRoom !== 'undefined') MeetingRoom.closeMeetingPanel(); },
  emptyStateEl,
  renderSessionList: scheduleSessionListRender,
  schedulePersist,
  wakeDormantSession: (sessionId) => resumeDormantSession(sessionId, { forceScrollBottom: true }),
});
sessionContextMenu.init();
const openContextMenu = sessionContextMenu.open;
const closeContextMenu = sessionContextMenu.close;

const terminalContextMenu = createTerminalContextMenuController({
  document,
  window,
  termCtxMenuEl,
  openPreviewPanel: (target) => openPreviewPanel(target),
});
terminalContextMenu.init();
const openTerminalContextMenu = terminalContextMenu.open;
const closeTerminalContextMenu = terminalContextMenu.close;

const pathLinkContextMenu = createPathLinkContextMenuController({
  document,
  window,
  menuEl: document.getElementById('path-link-context-menu'),
  clipboard,
  shell,
  ipcRenderer,
  normalizeLocalPathForOpen: _normalizeLocalPathForOpen,
  getSessionCwd,
  getActiveSessionId: () => activeSessionId,
});
pathLinkContextMenu.init();

// --- Terminal in-buffer search (Ctrl+F) ---
const terminalSearch = createTerminalSearch({
  document,
  getActiveSessionId: () => activeSessionId,
  getTerminalCache: () => terminalCache,
});
terminalSearch.init();
const openTerminalSearch = terminalSearch.open;
const closeTerminalSearch = terminalSearch.close;
// --- Sidebar collapse ---
const SIDEBAR_KEY = 'claude-hub-sidebar-collapsed';
function applySidebarCollapsed(collapsed) {
  appContainerEl.classList.toggle('sidebar-collapsed', collapsed);
  // 箭头方向：折叠态 ❯（朝右暗示展开），展开态 ❮（朝左暗示折叠回去）
  if (btnExpandEl) btnExpandEl.textContent = collapsed ? '❯' : '❮';
  // After CSS transition, refit active xterm so it claims the new width.
  setTimeout(() => {
    const cached = terminalCache.get(activeSessionId);
    if (!cached) return;
    scheduleFitAndResizeTerminal(activeSessionId, cached, { force: true });
  }, 200);
}
const initialCollapsed = localStorage.getItem(SIDEBAR_KEY) === '1';
applySidebarCollapsed(initialCollapsed);
function toggleSidebar() {
  const next = !appContainerEl.classList.contains('sidebar-collapsed');
  localStorage.setItem(SIDEBAR_KEY, next ? '1' : '0');
  applySidebarCollapsed(next);
}
btnExpandEl.addEventListener('click', toggleSidebar);

const shellController = createShellController({
  document,
  menuEl,
  resumeMenuEl,
  contextMenuEl,
  termCtxMenuEl,
  terminalCache,
  terminalPanelEl,
  emptyStateEl,
  closeTerminalSearch: () => closeTerminalSearch(),
  closePreviewPanel: () => closePreviewPanel(),
  closeMeetingPanel: () => { if (typeof MeetingRoom !== 'undefined') MeetingRoom.closeMeetingPanel(); },
  setActiveSessionId: (value) => { activeSessionId = value; },
  setActiveMeetingId: (value) => { activeMeetingId = value; },
  applySidebarCollapsed,
  preserveAndClearTerminalPanel,
  applyViewMode,
  renderSessionList,
  suspendTerminalRenderer: (cached) => unloadGpuRenderer(cached),
});
function escapeToHome() {
  if (window.__chuxinHide) window.__chuxinHide();
  shellController.escapeToHome();
  if (completionNotificationToggle) completionNotificationToggle.refreshTarget();
  if (homeWorkbench) homeWorkbench.render({ force: true });
}
// 2026-05-16 道雪：外部 HTTP 救援入口 — main.js POST /api/escape-home 通过这个 IPC 触发
// （右下角可见的 🏠 按钮已于 2026-06-28 移除，仅保留此救援后门 + Ctrl+Alt+Home 快捷键）
ipcRenderer.on('escape-home', escapeToHome);

const { createConfigModalController } = require('./config-modal.js');
function getActiveCompletionNotificationTarget() {
  if (activeSessionId) {
    const session = sessions.get(activeSessionId);
    return session ? { type: 'session', ...session } : null;
  }
  if (activeMeetingId) {
    const meeting = meetings[activeMeetingId];
    return meeting ? { type: 'meeting', ...meeting } : null;
  }
  return null;
}
const configModal = createConfigModalController({
  document,
  ipcRenderer,
  providerModes,
  renderAccountUsage,
  applyCardDisplaySettings: applyHubCardDisplaySettings,
  getNotificationTarget: getActiveCompletionNotificationTarget,
});
const openConfigModal = configModal.open;
const setCodexProfileForm = configModal.setCodexProfileForm;

const { createCompletionNotificationToggle } = require('./completion-notification-toggle.js');
completionNotificationToggle = createCompletionNotificationToggle({
  document,
  ipcRenderer,
  getNotificationTarget: getActiveCompletionNotificationTarget,
  openNotificationSettings: configModal.openNotificationSetup,
});
completionNotificationToggle.init();
ipcRenderer.on('completion-notification-config-changed', () => {
  void refreshHubProxyInfo();
});

const themeController = createThemeController({
  document,
  localStorage,
  terminalCache,
  openConfigModal,
});

const suspendIdleItem = document.getElementById('options-suspend-idle');
if (suspendIdleItem) {
  suspendIdleItem.addEventListener('click', async (event) => {
    event.stopPropagation();
    const optionsMenu = document.getElementById('options-menu');
    if (optionsMenu) optionsMenu.style.display = 'none';
    const confirmed = window.confirm(
      '立即扫描并休眠 5 小时以上无输入输出的 AI 会话？\n\n'
      + '后台也会每 5 分钟自动巡检；会保留会话卡片、未读标记和历史记录。'
      + '自动巡检会保护置顶、当前、正在工作的群聊及初心投研会话；'
      + '本次手动扫描会额外跳过全部群聊成员。',
    );
    if (!confirmed) return;
    suspendIdleItem.setAttribute('aria-busy', 'true');
    try {
      const result = await ipcRenderer.invoke('suspend-idle-sessions', { idleMs: 5 * 60 * 60 * 1000 });
      if (!result || !result.ok) {
        window.alert((result && result.message) || '批量休眠失败，请稍后重试。');
        return;
      }
      window.alert(result.count > 0
        ? `已请求休眠 ${result.count} 个长期闲置会话；内存会在对应 CLI 退出后释放。`
        : '没有符合条件的长期闲置会话。');
    } catch (error) {
      window.alert(`批量休眠失败：${error && error.message ? error.message : String(error)}`);
    } finally {
      suspendIdleItem.removeAttribute('aria-busy');
    }
  });
}

if (typeof MeetingRoom !== 'undefined') {
  MeetingRoom.init(sessions, getOrCreateTerminal);
}

const _pendingDormantResumes = new Map();

ipcRenderer.on('session-created', async (_e, { session }) => {
  // When resuming a dormant session, the hubId matches an existing dormant
  // entry. Merge live PTY info on top of the dormant metadata so title /
  // preview / unread / pinned aren't wiped.
  const existing = sessions.get(session.id);
  const pendingResume = _pendingDormantResumes.get(session.id) || null;
  const wasDormant = !!pendingResume || !!(existing && existing.status === 'dormant');
  if (pendingResume) _pendingDormantResumes.delete(session.id);
  if (wasDormant) {
    sessions.set(session.id, {
      ...existing,
      ...session,
      status: 'idle',
      // preserve persisted UX state
      pinned: existing.pinned,
      unreadCount: existing.unreadCount || 0,
      suspendedAt: null,
      suspendReason: null,
      // Main reconciles provider-native ids/paths during resume.  Its fresh
      // binding must replace stale dormant metadata, not the other way around.
      ccSessionId: session.ccSessionId || existing.ccSessionId,
      transcriptPath: session.transcriptPath || existing.transcriptPath,
      lastOutputPreview: existing.lastOutputPreview,
    });
  } else {
    sessions.set(session.id, session);
  }
  // 原生投研 PTY 由初心投研面板内嵌挂载；不抢占主终端，也不进入左栏。
  if (session.purpose === 'chuxin-research') {
    scheduleSessionListRender();
    window.dispatchEvent(new CustomEvent('chuxin-session-created', { detail: session }));
    return;
  }
  // Meeting room no longer mounts embedded xterms. Keep only the lightweight
  // session metadata here; an xterm is created and hydrated on explicit shell
  // selection, otherwise dozens of invisible 10k-line buffers accumulate.
  if (session.meetingId) {
    scheduleSessionListRender();
    return;
  }
  // 普通会话的唤醒流程会直接把终端展示给用户，此刻才算真正“已读”。群聊成员
  // 的后台/工作流唤醒会在上面的 meeting 分支返回，因此仍保留休眠前的未读标记。
  const activatedSession = sessions.get(session.id);
  if (activatedSession) clearSessionAttention(activatedSession, { clearUnread: true });
  await savePreviewState();
  clearPreviewUI();
  activeSessionId = session.id;
  activeMeetingId = null;
  completionNotificationToggle.refreshTarget();
  const mrp = document.getElementById('meeting-room-panel');
  if (mrp) mrp.style.display = 'none';
  if (terminalPanelEl) terminalPanelEl.style.display = '';
  ipcRenderer.send('focus-session', { sessionId: session.id });
  renderSessionList();
  // 新建 session 默认进 PTY；dormant resume 保留用户当前视图，避免卡片视图被唤醒流程打断。
  applyViewMode(wasDormant ? currentView : 'pty');
  showTerminal(session.id, {
    forceScrollBottom: !!(pendingResume && pendingResume.forceScrollBottom),
  });
  await restorePreviewForContext(`session:${session.id}`);
});

// Spec 3 · W12：transcript-tap session-bound 触发的 IPC，内存 sessions Map 同步
// codex/gemini 的 resume meta（之前只落盘 lastPersistedSessions，renderer 内存
// 拿不到 → reboot 才生效）。Claude/claude-resume 不走这条（ccSessionId 走 hook-event）。
ipcRenderer.on('session-meta-updated', (_e, ev) => {
  if (!ev || !ev.hubSessionId) return;
  const s = sessions.get(ev.hubSessionId);
  if (!s) return;
  if (ev.ccSessionId) s.ccSessionId = ev.ccSessionId;
  if (ev.transcriptPath) s.transcriptPath = ev.transcriptPath;
  if (ev.codexSid) s.codexSid = ev.codexSid;
  if (ev.codexSessionsRoot) s.codexSessionsRoot = ev.codexSessionsRoot;
  if (ev.codexAllowMtimeFallback) s.codexAllowMtimeFallback = true;
  if (ev.geminiChatId) s.geminiChatId = ev.geminiChatId;
  if (ev.geminiProjectHash) s.geminiProjectHash = ev.geminiProjectHash;
  if (ev.geminiProjectRoot) s.geminiProjectRoot = ev.geminiProjectRoot;
  if (ev.kimiSid) s.kimiSid = ev.kimiSid;
  if (ev.kimiSessionDir) s.kimiSessionDir = ev.kimiSessionDir;
  // 归档会搬运整个 workspace：dormant 条目的 cwd 也要跟着走，否则唤醒时指向已不存在的目录。
  if (ev.cwd) s.cwd = ev.cwd;
  const collapsed = (ev.ccSessionId || ev.codexSid || ev.geminiChatId || ev.kimiSid)
    ? collapseDormantNativeDuplicates(sessions)
    : [];
  if (ev.ccSessionId || ev.transcriptPath || ev.codexSid || ev.codexSessionsRoot || ev.codexAllowMtimeFallback || ev.geminiChatId || ev.geminiProjectHash || ev.geminiProjectRoot || ev.kimiSid || ev.kimiSessionDir || ev.cwd) {
    schedulePersist();
  }
  if (collapsed.length) scheduleSessionListRender();
  if (ev.hubSessionId === activeSessionId && currentView === 'card' && typeof loadSessionHistoryToOverlay === 'function') {
    loadSessionHistoryToOverlay(ev.hubSessionId).catch(err => {
      console.warn('[session-meta-updated] card reload failed:', err);
    });
  }
});

// Spec 3 · W13：清理 _cardReloadState 的 session 条目，防 Map 长期累积。
// session-closed 触发，确保即使 inProgress 异常残留也不影响新生命周期同 sessionId 的 session。
ipcRenderer.on('session-suspended', (_e, { sessionId, session }) => {
  const local = sessions.get(sessionId);
  if (!local) return;
  if (window._cardLoadSeqBySid) window._cardLoadSeqBySid.delete(sessionId);
  if (window._cardStopFallbackBySid && window._cardStopFallbackBySid.has(sessionId)) {
    clearTimeout(window._cardStopFallbackBySid.get(sessionId));
    window._cardStopFallbackBySid.delete(sessionId);
  }
  if (window._cardReloadState && window._cardReloadState.has(sessionId)) {
    const state = window._cardReloadState.get(sessionId);
    if (state && state.pendingTimer) { try { clearTimeout(state.pendingTimer); } catch {} }
    window._cardReloadState.delete(sessionId);
  }
  if (window._codexHistoryRetryState && window._codexHistoryRetryState.has(sessionId)) {
    const state = window._codexHistoryRetryState.get(sessionId);
    if (state && state.timer) { try { clearTimeout(state.timer); } catch {} }
    window._codexHistoryRetryState.delete(sessionId);
  }
  if (_codexSubmitPendingTimers.has(sessionId)) {
    clearTimeout(_codexSubmitPendingTimers.get(sessionId));
    _codexSubmitPendingTimers.delete(sessionId);
  }
  if (_turnCompleteBackfillTimers.has(sessionId)) {
    try { clearTimeout(_turnCompleteBackfillTimers.get(sessionId)); } catch {}
    _turnCompleteBackfillTimers.delete(sessionId);
  }
  if (typeof _w16RemoveTimers !== 'undefined' && _w16RemoveTimers.has(sessionId)) {
    try { clearTimeout(_w16RemoveTimers.get(sessionId)); } catch {}
    _w16RemoveTimers.delete(sessionId);
  }
  if (typeof _groupChatWorkingExpiryTimers !== 'undefined' && _groupChatWorkingExpiryTimers.has(sessionId)) {
    try { clearTimeout(_groupChatWorkingExpiryTimers.get(sessionId)); } catch {}
    _groupChatWorkingExpiryTimers.delete(sessionId);
  }
  if (_cardHistoryHydratedSid === sessionId) _cardHistoryHydratedSid = null;

  const pinned = local.pinned;
  const unreadCount = local.unreadCount;
  Object.assign(local, session || {}, {
    id: sessionId,
    status: 'dormant',
    pinned,
    unreadCount,
    _agentWorking: false,
    gcWorking: false,
  });
  clearTerminalActivitySession(sessionId);
  disposeCachedTerminal(sessionId);
  if (activeSessionId === sessionId) {
    activeSessionId = null;
    completionNotificationToggle.refreshTarget();
    recentTurnCopyController.setVisible(false);
    preserveAndClearTerminalPanel();
    terminalPanelEl.appendChild(emptyStateEl);
    emptyStateEl.style.display = '';
    terminalPanelEl.classList.add('home-active');
  }
  renderSessionList();
  schedulePersist();
  window.dispatchEvent(new CustomEvent('hub-session-suspended', { detail: { sessionId, session: local } }));
});

ipcRenderer.on('session-closed', (_e, { sessionId }) => {
  const closing = sessions.get(sessionId);
  const wasChuxinResearch = !!(closing && closing.purpose === 'chuxin-research');
  if (window._cardLoadSeqBySid) window._cardLoadSeqBySid.delete(sessionId);
  if (window._cardStopFallbackBySid && window._cardStopFallbackBySid.has(sessionId)) {
    clearTimeout(window._cardStopFallbackBySid.get(sessionId));
    window._cardStopFallbackBySid.delete(sessionId);
  }
  if (window._cardReloadState && window._cardReloadState.has(sessionId)) {
    const st = window._cardReloadState.get(sessionId);
    if (st && st.pendingTimer) { try { clearTimeout(st.pendingTimer); } catch {} }
    window._cardReloadState.delete(sessionId);
  }
  if (window._codexHistoryRetryState && window._codexHistoryRetryState.has(sessionId)) {
    const st = window._codexHistoryRetryState.get(sessionId);
    if (st && st.timer) { try { clearTimeout(st.timer); } catch {} }
    window._codexHistoryRetryState.delete(sessionId);
  }
  if (_codexSubmitPendingTimers.has(sessionId)) {
    clearTimeout(_codexSubmitPendingTimers.get(sessionId));
    _codexSubmitPendingTimers.delete(sessionId);
  }
  clearFloatingInputDraft(sessionId);
  floatingInputPresetDrafts.delete(sessionId);
  if (_cardHistoryHydratedSid === sessionId) _cardHistoryHydratedSid = null;
  if (_turnCompleteBackfillTimers.has(sessionId)) {
    try { clearTimeout(_turnCompleteBackfillTimers.get(sessionId)); } catch {}
    _turnCompleteBackfillTimers.delete(sessionId);
  }
  // 多方审查 P1 (Claude 共识)：W16 _w16RemoveTimers 也要在 session-closed 时清理，
  // 否则 1.5s 后 timer 触发时 sessions.get(sessionId) === undefined → 走 .remove() 分支，
  // 加上未做 dataset 过滤前会误删别 session 的 indicator。即使加了 dataset 过滤，timer
  // 残留也是 leak。一起清。
  if (typeof _w16RemoveTimers !== 'undefined' && _w16RemoveTimers.has(sessionId)) {
    try { clearTimeout(_w16RemoveTimers.get(sessionId)); } catch {}
    _w16RemoveTimers.delete(sessionId);
  }
  sessions.delete(sessionId);
  clearTerminalActivitySession(sessionId);
  disposeCachedTerminal(sessionId);
  if (activeSessionId === sessionId) {
    activeSessionId = null;
    completionNotificationToggle.refreshTarget();
    recentTurnCopyController.setVisible(false);
    preserveAndClearTerminalPanel();
    terminalPanelEl.appendChild(emptyStateEl);
    emptyStateEl.style.display = '';
    terminalPanelEl.classList.add('home-active');
  }
  renderSessionList();
  if (wasChuxinResearch) {
    window.dispatchEvent(new CustomEvent('chuxin-session-closed', { detail: { sessionId } }));
  }
});

ipcRenderer.on('session-updated', (_e, { session }) => {
  if (!sessions.has(session.id)) return;
  const local = sessions.get(session.id);
  if (local.purpose === 'chuxin-research' || session.purpose === 'chuxin-research') {
    Object.assign(local, session);
    scheduleSessionListRender();
    window.dispatchEvent(new CustomEvent('chuxin-session-updated', { detail: local }));
    return;
  }
  // Merge server updates but keep local preview/status (managed by renderer)
  if (!local.userRenamed && session.title) local.title = session.title;
  if (session.ccSessionId) local.ccSessionId = session.ccSessionId;
  if (session.transcriptPath) local.transcriptPath = session.transcriptPath;
  if (session.codexSid) local.codexSid = session.codexSid;
  if (session.codexSessionsRoot) local.codexSessionsRoot = session.codexSessionsRoot;
  if (session.codexAllowMtimeFallback) local.codexAllowMtimeFallback = true;
  if (session.codexProfile) local.codexProfile = session.codexProfile;
  if (session.codexProfileLabel) local.codexProfileLabel = session.codexProfileLabel;
  if (session.mcpProfile) local.mcpProfile = session.mcpProfile;
  if (session.kimiSid) local.kimiSid = session.kimiSid;
  if (session.kimiSessionDir) local.kimiSessionDir = session.kimiSessionDir;
  if (session.effort) local.effort = session.effort;
  if (session.userRenamed) local.userRenamed = true;
  if (session.autoTitleGenerated) local.autoTitleGenerated = true;
  if (session.branchSourceSessionId !== undefined) local.branchSourceSessionId = session.branchSourceSessionId;
  if (typeof session.branchAutoTitlePending === 'boolean') {
    local.branchAutoTitlePending = session.branchAutoTitlePending;
  }
  if (typeof session.workspaceLabel === 'string') local.workspaceLabel = session.workspaceLabel;
  if (typeof session.contextPct === 'number') local.contextPct = session.contextPct;
  if (typeof session.contextUsed === 'number') local.contextUsed = session.contextUsed;
  if (typeof session.contextMax === 'number') local.contextMax = session.contextMax;
  if (typeof session.lastCompletedAt === 'number'
      && session.lastCompletedAt >= (Number(local.lastCompletedAt) || 0)) {
    local.lastCompletedAt = session.lastCompletedAt;
  }
  if (typeof session.completionNotificationEnabled === 'boolean') {
    local.completionNotificationEnabled = session.completionNotificationEnabled;
  }
  if (session.id === activeSessionId) {
    // Auto-title and external rename updates already refresh the sidebar, but
    // the active terminal header used to keep the placeholder (for example
    // "Codex 1") until the user switched away and back. Keep both views on the
    // same authoritative session title without disturbing an in-progress
    // inline rename (the span is absent while its input is mounted).
    const activeTitle = terminalPanelEl.querySelector('.terminal-title');
    if (activeTitle && activeTitle.textContent !== local.title) activeTitle.textContent = local.title;
    updateActiveMetricsRow();
    completionNotificationToggle.refreshTarget();
  }
  scheduleSessionListRender();
});

// --- Session persistence (dormant restore) ---
// Provider-native AI sessions persist across app restarts; PowerShell remains
// ephemeral. Dormant cards have no PTY and wake through the shared exact-resume
// contract (`ccSessionId`, `codexSid`, `geminiChatId` or `kimiSid`).
let persistDebounceTimer = null;
function schedulePersist() {
  if (persistDebounceTimer) clearTimeout(persistDebounceTimer);
  persistDebounceTimer = setTimeout(() => {
    const list = [];
    for (const s of sessions.values()) {
      // 持久化白名单：AI 群聊会议 + 所有 AI kind（含 -resume 变体）。新增 AI 由 ai-kinds.js 单一真理源覆盖。
      if (!s.meetingId && !isAiKind(s.kind) && s.kind !== 'claude-resume' && !(typeof s.kind === 'string' && s.kind.endsWith('-resume'))) continue;
      list.push({
        hubId: s.id,
        title: s.title,
        kind: s.kind,
        cwd: s.cwd || null,
        cwdFellBackFrom: s.cwdFellBackFrom || null,
        memoryLinkWarning: s.memoryLinkWarning || null,
        workspaceLabel: s.workspaceLabel || null,
        pinned: !!s.pinned,
        ccSessionId: s.ccSessionId || null,
        transcriptPath: s.transcriptPath || null,
        meetingId: s.meetingId || null,
        lastMessageTime: s.lastMessageTime || Date.now(),
        lastOutputPreview: s.lastOutputPreview || '',
        unreadCount: s.unreadCount || 0,
        attentionState: s.attentionState || null,
        needsUserInput: !!s.needsUserInput,
        replyReady: !!s.replyReady,
        waitingReason: s.waitingReason || null,
        waitingText: s.waitingText || null,
        replyReadyText: s.replyReadyText || null,
        runStartedAt: typeof s.runStartedAt === 'number' ? s.runStartedAt : null,
        lastCompletedAt: typeof s.lastCompletedAt === 'number' ? s.lastCompletedAt : null,
        lastRunStartedAt: typeof s.lastRunStartedAt === 'number' ? s.lastRunStartedAt : null,
        lastRunDurationMs: typeof s.lastRunDurationMs === 'number' ? s.lastRunDurationMs : null,
        recentArtifacts: Array.isArray(s.recentArtifacts) ? s.recentArtifacts.slice(-8) : null,
        suspendedAt: s.suspendedAt || null,
        suspendReason: s.suspendReason || null,
        currentModel: s.currentModel || null,
        effort: s.effort || null,
        contextPct: typeof s.contextPct === 'number' ? s.contextPct : null,
        contextUsed: typeof s.contextUsed === 'number' ? s.contextUsed : null,
        contextMax: typeof s.contextMax === 'number' ? s.contextMax : null,
        userRenamed: !!s.userRenamed,
        autoTitleGenerated: !!s.autoTitleGenerated,
        branchSourceSessionId: s.branchSourceSessionId || null,
        branchAutoTitlePending: !!s.branchAutoTitlePending,
        // T10: include resume-meta in persist payload so main.js merge has the latest
        codexSid: s.codexSid || null,
        codexSessionsRoot: s.codexSessionsRoot || null,
        codexAllowMtimeFallback: !!s.codexAllowMtimeFallback,
        codexProfile: s.codexProfile || null,
        codexProfileLabel: s.codexProfileLabel || null,
        mcpProfile: s.mcpProfile || null,
        geminiChatId: s.geminiChatId || null,
        geminiProjectHash: s.geminiProjectHash || null,
        geminiProjectRoot: s.geminiProjectRoot || null,
        kimiSid: s.kimiSid || null,
        kimiSessionDir: s.kimiSessionDir || null,
        purpose: s.purpose || null,
        researchSessionId: s.researchSessionId || null,
        chuxinTaskId: s.chuxinTaskId || null,
        heroIds: Array.isArray(s.heroIds) ? s.heroIds : null,
        promptPolicyVersion: s.promptPolicyVersion || null,
        hiddenFromSidebar: !!s.hiddenFromSidebar,
        completionNotificationEnabled: s.completionNotificationEnabled === true,
      });
    }
        //   slotSpecs/covenantText 全被剥掉 → 写残 state.json → 重启后 restoreMeeting fallback
    //   scene='general'，所有 AI 群聊退化为通用场景（投研 LinDangAgent MCP 不挂入）。
    //   修：补全所有 createMeeting 写入 + setMeetingContext 维护的持久化字段。
    //   main.js persist-sessions handler 端加了 fallback 兜底，但渲染端先把字段补全是第一道防线。
    const meetingList = Object.values(meetings).map(m => ({
      id: m.id, type: 'meeting', title: m.title, subSessions: m.subSessions,
      layout: m.layout, focusedSub: m.focusedSub, syncContext: m.syncContext,
      sendTarget: m.sendTarget, createdAt: m.createdAt, lastMessageTime: m.lastMessageTime,
      lastCompletedAt: typeof m.lastCompletedAt === 'number' ? m.lastCompletedAt : null,
      pinned: m.pinned || false, lastScene: m.lastScene || null,
      scene: m.scene, mode: m.mode,
      userRenamed: !!m.userRenamed,
      autoTitlePending: !!m.autoTitlePending,
      autoTitleGenerated: !!m.autoTitleGenerated,
      workspace: m.workspace || null,
      workspaceLabel: m.workspaceLabel || null,
      participants: Array.isArray(m.participants) ? m.participants : null,
      slotSpecs: Array.isArray(m.slotSpecs) ? m.slotSpecs : null,
      covenantText: m.covenantText || '',
      serialWorkflow: (m.serialWorkflow && typeof m.serialWorkflow === 'object') ? m.serialWorkflow : null,
      completionNotificationEnabled: m.completionNotificationEnabled === true,
    }));
    ipcRenderer.send('persist-sessions', list, meetingList);
  }, 400);
}
// 暴露给 meeting-room.js 等 renderer 子模块：配置变更后可主动落 state.json
window.schedulePersist = schedulePersist;

// Wake a dormant session: call main to spawn PTY with --resume, then wait for
// session-created which will replace the dormant entry.
async function resumeDormantSession(hubId, opts = {}) {
  const existingPending = _pendingDormantResumes.get(hubId);
  if (existingPending) {
    if (opts.forceScrollBottom === true) existingPending.forceScrollBottom = true;
    return existingPending.promise || null;
  }
  const dormant = sessions.get(hubId);
  if (!dormant || dormant.status !== 'dormant') return dormant || null;
  const pendingResume = {
    forceScrollBottom: opts.forceScrollBottom === true,
    promise: null,
  };
  _pendingDormantResumes.set(hubId, pendingResume);
  // Keep title / pinned / preview so UI stays stable through the resume.
  let resumed;
  try {
    // Dormant wake, workspace archive and right-click Restart share one exact
    // provider-native metadata contract.  This prevents Codex-only fields such
    // as profile / MCP policy / rollout root from disappearing on one path.
    pendingResume.promise = ipcRenderer.invoke('resume-session', buildSessionResumeMeta(dormant));
    resumed = await pendingResume.promise;
  } catch (error) {
    if (_pendingDormantResumes.get(hubId) === pendingResume) {
      _pendingDormantResumes.delete(hubId);
    }
    throw error;
  }
  if (resumed && resumed.cwdFellBackFrom) {
    alert(`原工作目录已不存在：\n${resumed.cwdFellBackFrom}\n\n会话已回落到：\n${resumed.cwd}\n\n请先重定位或归档 workspace；不要在聚合根继续写文件。`);
  }
  // v0.13 · P0 #2: 不再反向清零 dormant 累积的 unread。睡前积压的对话用户还
  // 没看 → 应保留到真正进入终端；普通会话由 session-created 展示终端时清零，
  // 群聊成员的后台唤醒则等用户 selectSession 后再清零。
  const s = sessions.get(hubId);
  // ipcRenderer.invoke 的响应与 session-created 推送是两条消息；响应极快时
  // 推送未必已经更新本地 Map。先用返回值做幂等合并，防止紧邻的下一步
  // 仍把同一 hubId 当 dormant 再启动一次 PTY。
  if (s && resumed && s.status === 'dormant') {
    sessions.set(hubId, {
      ...s,
      ...resumed,
      status: 'idle',
      pinned: s.pinned,
      unreadCount: s.unreadCount || 0,
      suspendedAt: null,
      suspendReason: null,
      ccSessionId: resumed.ccSessionId || s.ccSessionId,
      transcriptPath: resumed.transcriptPath || s.transcriptPath,
      lastOutputPreview: s.lastOutputPreview,
    });
  }
  if (s) renderSessionList();
  return resumed || null;
}
window.resumeDormantSession = resumeDormantSession;

// --- Init ---
(async () => {
  traceRendererStartup('init ipc start');
  const [existing, persisted, dormantMeetings] = await Promise.all([
    ipcRenderer.invoke('get-sessions').catch(() => []),
    ipcRenderer.invoke('get-dormant-sessions').catch(() => null),
    ipcRenderer.invoke('get-dormant-meetings').catch(() => null),
  ]);
  traceRendererStartup(`init ipc done existing=${existing.length} persisted=${persisted && Array.isArray(persisted.sessions) ? persisted.sessions.length : 0} meetings=${Array.isArray(dormantMeetings) ? dormantMeetings.length : 0}`);

  let migratedLegacyBranchTitles = 0;
  for (const s of existing) {
    const migrated = migrateLegacyBranchSessionMeta(s);
    if (migrated !== s) migratedLegacyBranchTitles += 1;
    sessions.set(migrated.id, migrated);
  }

  if (persisted && Array.isArray(persisted.sessions)) {
    for (const meta of persisted.sessions) {
      const migratedMeta = migrateLegacyBranchSessionMeta(meta);
      if (migratedMeta !== meta) {
        Object.assign(meta, migratedMeta);
        migratedLegacyBranchTitles += 1;
      }
      if (sessions.has(meta.hubId)) continue;
      // 2026-05-05 dormant 加载 fallback：state.json 里历史 dormant session 的
      // currentModel 大量为 null（main.js:2694 RESUME_META_FIELDS 字段名拼错导致
      // 一旦写入 null 就永久污染，已在同次提交修）。这里给老污染数据按 kind 推断
      // 一个合理默认（model-options.js 清单首项），避免唤醒时 spawn 用最离谱的默认。
      let resolvedModel = meta.currentModel || null;
      if (!resolvedModel || !resolvedModel.id) {
        const opts = modelOptionsFor(meta.kind || 'claude');
        if (opts.length > 0) {
          resolvedModel = { id: opts[0].id, displayName: opts[0].label };
        }
      }
      sessions.set(meta.hubId, {
        id: meta.hubId,
        kind: meta.kind || 'claude',
        title: normalizeLegacyBranchSessionTitle(meta.title) || 'Claude',
        status: 'dormant',
        lastMessageTime: meta.lastMessageTime || Date.now(),
        lastOutputPreview: meta.lastOutputPreview || '',
        unreadCount: meta.unreadCount || 0,
        suspendedAt: meta.suspendedAt || null,
        suspendReason: meta.suspendReason || null,
        createdAt: meta.lastMessageTime || Date.now(),
        cwd: meta.cwd || null,
        cwdFellBackFrom: meta.cwdFellBackFrom || null,
        memoryLinkWarning: meta.memoryLinkWarning || null,
        workspaceLabel: meta.workspaceLabel || null,
        pinned: !!meta.pinned,
        ccSessionId: meta.ccSessionId || null,
        transcriptPath: meta.transcriptPath || null,
        meetingId: meta.meetingId || null,
        currentModel: resolvedModel,
        effort: meta.effort || null,
        contextPct: typeof meta.contextPct === 'number' ? meta.contextPct : null,
        contextUsed: typeof meta.contextUsed === 'number' ? meta.contextUsed : null,
        contextMax: typeof meta.contextMax === 'number' ? meta.contextMax : null,
        runStartedAt: null,
        lastCompletedAt: typeof meta.lastCompletedAt === 'number' ? meta.lastCompletedAt : null,
        lastRunStartedAt: typeof meta.lastRunStartedAt === 'number' ? meta.lastRunStartedAt : null,
        lastRunDurationMs: typeof meta.lastRunDurationMs === 'number' ? meta.lastRunDurationMs : null,
        recentArtifacts: Array.isArray(meta.recentArtifacts) ? meta.recentArtifacts.slice(-8) : [],
        userRenamed: !!meta.userRenamed,
        autoTitleGenerated: !meta.branchAutoTitlePending
          && (!!meta.autoTitleGenerated || isStableSessionTitle(meta.title, meta.kind)),
        branchSourceSessionId: meta.branchSourceSessionId || null,
        branchAutoTitlePending: !!meta.branchAutoTitlePending,
        // T10: preserve resume-meta for precise resume (codex/gemini)
        codexSid: meta.codexSid || null,
        codexSessionsRoot: meta.codexSessionsRoot || null,
        codexAllowMtimeFallback: !!meta.codexAllowMtimeFallback,
        codexProfile: meta.codexProfile || null,
        codexProfileLabel: meta.codexProfileLabel || null,
        mcpProfile: meta.mcpProfile || null,
        geminiChatId: meta.geminiChatId || null,
        geminiProjectHash: meta.geminiProjectHash || null,
        geminiProjectRoot: meta.geminiProjectRoot || null,
        kimiSid: meta.kimiSid || null,
        kimiSessionDir: meta.kimiSessionDir || null,
        purpose: meta.purpose || null,
        researchSessionId: meta.researchSessionId || null,
        chuxinTaskId: meta.chuxinTaskId || null,
        heroIds: Array.isArray(meta.heroIds) ? meta.heroIds : null,
        promptPolicyVersion: meta.promptPolicyVersion || null,
        hiddenFromSidebar: !!meta.hiddenFromSidebar,
        completionNotificationEnabled: meta.completionNotificationEnabled === true,
      });
    }
  }

  if (migratedLegacyBranchTitles > 0) {
    console.info(`[session-title] migrated ${migratedLegacyBranchTitles} legacy branch title(s)`);
    schedulePersist();
  }

  if (Array.isArray(dormantMeetings)) {
    for (const m of dormantMeetings) {
      if (m.layout === 'split') m.layout = 'focus';
      meetings[m.id] = m;
    }
  }

  const collapsedNativeSessions = collapseDormantNativeDuplicates(sessions);
  if (collapsedNativeSessions.length) {
    console.info(`[resume] consolidated ${collapsedNativeSessions.length} duplicate dormant transcript shell(s)`);
    schedulePersist();
  }

  traceRendererStartup('renderSessionList start');
  renderSessionList();
  refreshSystemResourceUsage();
  setInterval(refreshSystemResourceUsage, 3000);
  refreshHubProxyInfo();
  setInterval(refreshHubProxyInfo, 15000);
  traceRendererStartup('renderSessionList done');
  ipcRenderer.send('renderer-sidebar-ready');
  traceRendererStartup('renderer-sidebar-ready sent');

  ipcRenderer.invoke('get-hub-config-raw').then((cfg) => {
    if (!cfg) return;
    _deepseekAutoTitleEnabled = !!cfg.deepseekApiKey;
    providerModes.codex = cfg.codexBackend === 'api' ? 'api' : 'subscription';
    setCodexProfileForm(cfg.codexSubscriptionProfiles, cfg.codexSubscriptionProfile);
    turnCardRenderer.setCodeFoldThreshold(cfg.uiCodeFoldThreshold);
    // Usage rows are rendered from the cache promise below.
    traceRendererStartup('hub config loaded');
  }).catch(() => {});

  ipcRenderer.invoke('get-usage-cache').then((cached) => {
    accountUsageController.applyUsageCache(cached);
    if (homeWorkbench) homeWorkbench.render();
    traceRendererStartup('usage cache loaded');
  }).catch(() => { renderAccountUsage(); });
  applyViewMode('pty');
})();

// Persist on relevant changes — listen at renderer-level for mutations that
// touch persistable fields. Debounced.
for (const ch of ['session-created', 'session-closed', 'session-suspended', 'session-updated', 'meeting-created', 'meeting-updated', 'meeting-closed']) {
  ipcRenderer.on(ch, () => schedulePersist());
}

// --- Meeting Room IPC events ---
const _groupChatWorkingExpiryTimers = new Map();

function _setGroupChatMemberWorking(session, working, now = Date.now()) {
  if (!session) return false;
  const sid = String(session.id || '');
  const oldTimer = _groupChatWorkingExpiryTimers.get(sid);
  if (oldTimer) clearTimeout(oldTimer);
  _groupChatWorkingExpiryTimers.delete(sid);

  const wasRunning = isGroupChatMemberRunning(session, now);
  if (!working) {
    session.gcWorking = false;
    session._gcWorkingLastTs = null;
    return wasRunning !== isGroupChatMemberRunning(session, now);
  }

  session.gcWorking = true;
  session._gcWorkingLastTs = now;
  const heartbeatTs = now;
  const timer = setTimeout(() => {
    _groupChatWorkingExpiryTimers.delete(sid);
    if (!session.gcWorking || session._gcWorkingLastTs !== heartbeatTs) return;
    const beforeExpiry = isGroupChatMemberRunning(session, heartbeatTs);
    session.gcWorking = false;
    session._gcWorkingLastTs = null;
    if (beforeExpiry !== isGroupChatMemberRunning(session, Date.now())) {
      scheduleSessionListRender();
    }
  }, GC_WORKING_FRESH_MS + 50);
  _groupChatWorkingExpiryTimers.set(sid, timer);
  return wasRunning !== isGroupChatMemberRunning(session, now);
}

ipcRenderer.on('meeting-created', (_e, { meeting }) => {
  meetings[meeting.id] = meeting;
  // 2026-05-05 道雪：新 AI 群聊默认折叠（白名单未命中=折叠）。折叠态侧边栏已显示 3 个迷你
  //   slot 头像跳转按钮，用户能直接点头像进 sub session，不必展开看 slot 列表。
  renderSessionList();
});

ipcRenderer.on('meeting-updated', (_e, { meeting }) => {
  meetings[meeting.id] = meeting;
  if (meeting.id === activeMeetingId) completionNotificationToggle.refreshTarget();
  if (typeof MeetingRoom !== 'undefined') {
    MeetingRoom.updateMeetingData(meeting.id, meeting);
  }
  scheduleSessionListRender();
});

// 调度器在 prompt 真正发出后立刻公布本轮目标。先据此点亮目标成员，避免等到
// 第一段 streaming 心跳才显示运行中；没被点名的成员同时清掉上一轮残留。
ipcRenderer.on('groupchat-turn-targets', (_event, { meetingId, sids }) => {
  if (!meetingId || !Array.isArray(sids)) return;
  const meeting = meetings[meetingId];
  const targetSids = new Set(sids.map(String));
  const memberSids = new Set([
    ...((meeting && meeting.subSessions) || []).map(String),
    ...targetSids,
  ]);
  let dirty = false;
  for (const sid of memberSids) {
    const sub = sessions.get(sid);
    if (sub) dirty = _setGroupChatMemberWorking(sub, targetSids.has(sid)) || dirty;
  }
  if (dirty) scheduleSessionListRender();
});

// 2026-05-31 道雪：群聊侧栏"等你 N" 状态机 —— 单个 AI 答完即累加（1-3），跨轮自动清零。
//   partial-update IPC 在终态（completed/manual_extracted）触发；turnNum 与上次记录不同时清空 Set 重新计数；
//   active meeting 不累加（用户正看着，不打扰）。selectMeeting 时 clear（在 selectMeeting 函数内）。
//   meeting-room.js 也监听 partial-update 但职责是渲染抽屉/卡片内容，与本侧栏聚合器互不干扰。
ipcRenderer.on('groupchat-partial-update', (_event, { meetingId, turnNum, sid, status }) => {
  if (!meetingId || !sid) return;
  // 2026-07-21 道雪 [修状态灯]：群聊成员的"运行中"权威信号取 dispatcher 的 watcher
  //   生命周期（streaming=未结算，终态=已结算），不依赖子会话自己的 hook/transcript
  //   running 管线——避免管线未绑定时 AI 明明在跑、状态灯却常绿。
  const sub = sessions.get(sid);
  if (sub) {
    const nextWorking = status === 'streaming' || status === 'thinking' || status === 'soft_alert';
    if (_setGroupChatMemberWorking(sub, nextWorking)) scheduleSessionListRender();
  }
  if (status !== 'completed' && status !== 'manual_extracted') return;
  const meeting = meetings[meetingId];
  if (!meeting) return;
  if (!(meeting.unreadAnswered instanceof Set)) meeting.unreadAnswered = new Set();
  if (meeting._lastUnreadTurnNum !== turnNum) {
    meeting.unreadAnswered.clear();
    meeting._lastUnreadTurnNum = turnNum;
  }
  if (meetingId === activeMeetingId) return;  // 用户正在看，不打扰
  meeting.unreadAnswered.add(sid);
  scheduleSessionListRender();
});

// 2026-05-05 道雪 修3：AI 群聊 turn-complete IPC → 触发侧栏排序刷新（最新答完的 AI 群聊靠前）。
//   2026-05-31 道雪：旧版在这里 unreadCount++ 作"轮粒度未读"，已被 partial-update 聚合的"本轮已答 AI 数"取代。
//   同 IPC 在 meeting-room.js 里也有监听器（cache 同步 + DOM 重渲），与本监听器职责正交。
ipcRenderer.on('groupchat-turn-complete', (_event, { meetingId, completedAt }) => {
  if (!meetingId) return;
  const meeting = meetings[meetingId];
  if (!meeting) return;
  if (window.WorkspaceController) void window.WorkspaceController.maybePromptMeetingArchive(meetingId);
  const answerAt = normalizeEventTime(completedAt, Date.now());
  meeting.lastCompletedAt = Math.max(Number(meeting.lastCompletedAt) || 0, answerAt);
  meeting.lastMessageTime = meeting.lastCompletedAt;
  ipcRenderer.send('update-meeting', {
    meetingId,
    fields: { lastMessageTime: meeting.lastMessageTime, lastCompletedAt: meeting.lastCompletedAt },
  });
  // 2026-07-21 道雪 [修状态灯]：轮次收尾兜底清 gcWorking（覆盖 superseded 等
  //   不经 partial-update 终态的路径，防止状态灯卡在黄灯）。
  for (const sid of meeting.subSessions || []) {
    const s = sessions.get(sid);
    if (s) _setGroupChatMemberWorking(s, false);
  }
  scheduleSessionListRender();
  schedulePersist();
});

ipcRenderer.on('meeting-closed', (_e, { meetingId }) => {
  delete meetings[meetingId];
  if (_expandedMeetings.has(meetingId)) {
    _expandedMeetings.delete(meetingId);
    _persistExpandedMeetings();
  }
  if (activeMeetingId === meetingId) {
    activeMeetingId = null;
    if (typeof MeetingRoom !== 'undefined') MeetingRoom.closeMeetingPanel();
    if (emptyStateEl) emptyStateEl.style.display = '';
    if (terminalPanelEl) terminalPanelEl.classList.add('home-active');
  }
  renderSessionList();
});

if (process && process.env && process.env.CLAUDE_HUB_E2E === '1') {
  const provideTerminalLinksForE2E = (sessionId, lineNumber) => new Promise((resolve) => {
    const cached = terminalCache.get(sessionId);
    const provider = cached && cached._localPathLinkProvider;
    if (!provider || typeof provider.provideLinks !== 'function') { resolve([]); return; }
    provider.provideLinks(lineNumber, links => resolve(Array.isArray(links) ? links : []));
  });
  // Feature modules register their own isolated E2E bridges before this late
  // renderer block. Merge instead of replacing the namespace, otherwise a
  // perfectly working module (for example global session search) disappears
  // only in tests and makes the real UI impossible to drive end-to-end.
  window.__hubE2E = {
    ...(window.__hubE2E || {}),
    selectMeeting: (meetingId, opts) => selectMeeting(meetingId, opts),
    selectSession: (sessionId, opts) => selectSession(sessionId, opts),
    getActiveMeetingId: () => activeMeetingId,
    getMeeting: (meetingId) => meetings[meetingId] || null,
    terminalCacheStats: () => ({
      size: terminalCache.size,
      ids: [...terminalCache.keys()],
      max: null,
      policy: TERMINAL_CACHE_POLICY,
      opened: [...terminalCache.values()].filter(item => item.opened).length,
      rendererSurfaces: [...terminalCache.values()].filter(item => !!item._rendererAddon).length,
      rendererModes: [...terminalCache.values()].reduce((acc, item) => {
        const mode = item._rendererMode || 'suspended';
        acc[mode] = (acc[mode] || 0) + 1;
        return acc;
      }, {}),
    }),
    // Snapshot recovery still needs direct coverage even though production no
    // longer evicts live sessions by count. This hook exists only in isolated
    // CLAUDE_HUB_E2E renderers and cannot affect the production Hub.
    disposeTerminal: (sessionId) => disposeCachedTerminal(sessionId),
    terminalBufferText: (sessionId, maxLines = 120) => {
      const cached = terminalCache.get(sessionId);
      if (!cached || !cached.terminal || !cached.terminal.buffer) return '';
      const buffer = cached.terminal.buffer.active;
      const end = Math.min(buffer.length, buffer.baseY + buffer.cursorY + 1);
      const start = Math.max(0, end - Math.max(1, Number(maxLines) || 120));
      const lines = [];
      for (let index = start; index < end; index += 1) {
        const line = buffer.getLine(index);
        if (line) lines.push(line.translateToString(true));
      }
      return lines.join('\n');
    },
    terminalFindLine: (sessionId, needle) => {
      const cached = terminalCache.get(sessionId);
      if (!cached || !cached.terminal) return 0;
      const buffer = cached.terminal.buffer.active;
      for (let index = 0; index < buffer.length; index += 1) {
        const text = buffer.getLine(index)?.translateToString(true) || '';
        if (text.includes(String(needle || ''))) return index + 1;
      }
      return 0;
    },
    terminalFindLastLine: (sessionId, needle) => {
      const cached = terminalCache.get(sessionId);
      if (!cached || !cached.terminal) return 0;
      const buffer = cached.terminal.buffer.active;
      for (let index = buffer.length - 1; index >= 0; index -= 1) {
        const text = buffer.getLine(index)?.translateToString(true) || '';
        if (text.includes(String(needle || ''))) return index + 1;
      }
      return 0;
    },
    terminalLinks: async (sessionId, lineNumber) => {
      const links = await provideTerminalLinksForE2E(sessionId, lineNumber);
      return links.map(link => ({ text: link.text, range: link.range }));
    },
    activateTerminalLink: async (sessionId, lineNumber, linkIndex = 0) => {
      const links = await provideTerminalLinksForE2E(sessionId, lineNumber);
      const link = links[linkIndex];
      if (!link) return null;
      await link.activate({ button: 0, clientX: 0, clientY: 0 });
      return { text: link.text, range: link.range };
    },
    terminalLinkGeometry: async (sessionId, lineNumber, linkIndex = 0) => {
      const cached = terminalCache.get(sessionId);
      if (!cached || !cached.terminal) return null;
      const links = await provideTerminalLinksForE2E(sessionId, lineNumber);
      const link = links[linkIndex];
      const screen = cached.container.querySelector('.xterm-screen');
      const dimensions = cached.terminal._core?._renderService?.dimensions?.css?.cell;
      if (!link || !screen || !dimensions) return null;
      const rect = screen.getBoundingClientRect();
      const buffer = cached.terminal.buffer.active;
      let viewportY = buffer.viewportY;
      let row = link.range.start.y - 1 - viewportY;
      if (row < 0 || row >= cached.terminal.rows) {
        try { cached.terminal.scrollToLine(link.range.start.y - 1); } catch {}
        viewportY = buffer.viewportY;
        row = link.range.start.y - 1 - viewportY;
      }
      return {
        text: link.text,
        range: link.range,
        viewportY,
        row,
        x: rect.left + (((link.range.start.x + link.range.end.x) / 2) - 0.5) * dimensions.width,
        y: rect.top + (row + 0.5) * dimensions.height,
      };
    },
    terminalLiveScreenText: (sessionId) => terminalActivityMonitor.extractLiveScreenLines(sessionId).join('\n'),
    cardQuestionNavigator: {
      refresh: () => cardQuestionNavigator.refresh(),
      state: () => cardQuestionNavigator.getState(),
      scrollTo: index => cardQuestionNavigator.scrollToQuestion(index),
      mountFixture: ({ sessionId = 'card-question-nav-e2e', start = 1, count = 6, clear = true } = {}) => {
        if (clear) {
          sessions.set(sessionId, {
            id: sessionId,
            kind: 'codex',
            title: '问题导航 E2E',
            status: 'idle',
            createdAt: Date.now(),
            lastMessageTime: Date.now(),
          });
          activeMeetingId = null;
          activeSessionId = sessionId;
          currentView = 'card';
          _cardHistoryHydratedSid = sessionId;
          terminalPanelEl.style.display = '';
          terminalPanelEl.classList.remove('home-active');
          emptyStateEl.style.display = 'none';
          const overlay = document.getElementById('msg-overlay');
          overlay.innerHTML = '';
          overlay.classList.remove('hidden');
          window._sessionTurns.clear();
        }
        const answerParagraph = '这是用于拉开卡片距离的回答段落，保持真实 Markdown 卡片的高度和滚动行为。';
        for (let offset = 0; offset < count; offset += 1) {
          const index = start + offset;
          window._mountSessionTurnCard(sessionId, {
            id: `question-${index}`,
            role: 'user',
            kind: 'codex',
            text: index === 7
              ? '问题 7：这是实时追加的新问题，导航轨应自动出现新节点。'
              : `问题 ${index}：请分析第 ${index} 个方案的收益、风险与下一步。`,
            ts: Date.now() + offset * 2,
          }, { kind: 'codex' });
          window._mountSessionTurnCard(sessionId, {
            id: `answer-${index}`,
            role: 'assistant',
            kind: 'codex',
            text: `### 回答 ${index}\n\n${Array(7).fill(answerParagraph).join('\n\n')}`,
            ts: Date.now() + offset * 2 + 1,
          }, { kind: 'codex' });
        }
        const overlay = document.getElementById('msg-overlay');
        if (clear) overlay.scrollTop = 0;
        const navStartedAt = performance.now();
        const state = cardQuestionNavigator.refresh();
        return {
          sid: sessionId,
          state,
          navRefreshMs: performance.now() - navStartedAt,
          scrollHeight: overlay.scrollHeight,
          clientHeight: overlay.clientHeight,
        };
      },
      setViewMode: mode => applyViewMode(mode),
      preservePanel: () => preserveAndClearTerminalPanel(),
    },
    probeTerminalReplayResponsiveness: async () => {
      const terminal = new Terminal({ cols: 200, rows: 40, scrollback: 10000, allowProposedApi: true });
      const line = `REPLAY-LINE ${'x'.repeat(186)}\r\n`;
      const text = `\x1b[2J\x1b[H${line.repeat(12000)}`;
      const delays = [];
      let expected = performance.now() + 10;
      const timer = setInterval(() => {
        const now = performance.now();
        delays.push(Math.max(0, now - expected));
        expected = now + 10;
      }, 10);
      const startedAt = performance.now();
      try {
        await replayTerminalSnapshot({ terminal }, { text, operations: null });
        await new Promise(resolve => setTimeout(resolve, 40));
        return {
          bytes: text.length,
          elapsedMs: performance.now() - startedAt,
          heartbeatCount: delays.length,
          maxHeartbeatDelayMs: Math.max(0, ...delays),
        };
      } finally {
        clearInterval(timer);
        try { terminal.dispose(); } catch {}
      }
    },
    applyTerminalRuntimeFrame: (sessionId, lines, observedAt = Date.now()) => {
      const session = sessions.get(sessionId);
      if (!session) return null;
      const runtime = classifySessionRuntimeFrame(session, Array.isArray(lines) ? lines : []);
      const changed = applyPtyRuntimeObservation(session, runtime, observedAt);
      return {
        changed,
        runtime,
        status: session.status,
        runSource: session._runSource || null,
        agentWorking: session._agentWorking || null,
      };
    },
    sidebarRenderCoalescerStats: () => sidebarRenderCoalescer.stats(),
    sidebarRenderStats: () => sessionListRenderer.getRenderStats(),
    // 侧栏时间分组 E2E：注入指定 lastMessageTime 的测试会话并重渲，读分组 DOM。
    addFakeSession: (s) => {
      const id = s && s.id; if (!id) return;
      sessions.set(id, Object.assign(
        { id, kind: 'claude', title: id, status: 'idle', lastMessageTime: Date.now(), createdAt: Date.now() }, s));
      renderSessionList();
    },
    addFakeSessions: (items) => {
      for (const s of Array.isArray(items) ? items : []) {
        const id = s && s.id;
        if (!id) continue;
        sessions.set(id, Object.assign(
          { id, kind: 'claude', title: id, status: 'idle', lastMessageTime: Date.now(), createdAt: Date.now() }, s));
      }
      const startedAt = performance.now();
      renderSessionList();
      return { count: sessions.size, renderMs: performance.now() - startedAt };
    },
    clearSessions: () => { sessions.clear(); renderSessionList(); },
    sidebarGroups: () => Array.prototype.map.call(
      document.querySelectorAll('.session-time-group-header'),
      (h) => ({ key: h.dataset.timeGroup, expanded: h.classList.contains('expanded'), count: (h.querySelector('.stg-count') || {}).textContent })),
    sidebarTopItemCount: () => document.querySelectorAll('#session-list .session-item:not(.child)').length,
    clickTimeGroup: (key) => { const h = document.querySelector('.session-time-group-header[data-time-group="' + key + '"]'); if (h) h.click(); },
  };
}
