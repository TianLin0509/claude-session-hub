const { ipcRenderer, clipboard, nativeImage, shell, webFrame } = require('electron');
const fs = require('fs');
const { isClaudeFamily, isAiKind, isPasteSensitive, isCodexSessionKind: isCodexKind } = require('../core/ai-kinds.js');
const { formatAbsoluteTime } = require('./format-time.js');
const { marked } = require('marked');
const DOMPurify = require('dompurify');
const { installScrollDebug } = require('./scroll-debug.js');
const { createMemoPanel } = require('./memo-panel.js');
const { createTerminalSearch } = require('./terminal-search.js');
const { createSessionContextMenuController, createTerminalContextMenuController } = require('./context-menus.js');
const { XTERM_THEMES, createThemeController } = require('./theme-controller.js');
const { createTerminalInputController } = require('./terminal-input-controller.js');
const { createAccountUsageController } = require('./account-usage-controller.js');
const { modelClass, modelShort, createModelUiController } = require('./model-ui.js');
const { createTerminalLinkRegistrar } = require('./terminal-link-provider.js');
const { createPreviewPanelController } = require('./preview-panel-controller.js');
const { createTerminalActivityMonitor } = require('./terminal-activity-monitor.js');
const {
  PREVIEW_PATH_RE,
  HUB_IMG_PATH_RE,
  collectPathCandidates,
  _cleanPathCandidate,
  _normalizeLocalPathForOpen,
  _isDirectoryPath,
} = require('./path-candidates.js');
const { modelOptionsFor } = require('../core/model-options.js');
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
const terminalCache = new Map();
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
const CODEX_BOTTOM_LOCK_EPSILON = 24;
const CODEX_SCROLL_INTENT_MS = 1500;
const CODEX_PROGRAMMATIC_SCROLL_SUPPRESS_MS = 120;

function readContenteditablePlainText(el) {
  if (!el) return '';
  return typeof el.innerText === 'string' ? el.innerText : (el.textContent || '');
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
  pinTerminalViewportToBottom(cached);
  requestAnimationFrame(() => {
    if (shouldAutoPinCodexTerminal(sessionId, cached)) pinTerminalViewportToBottom(cached);
  });
}

function updateCodexFollowBottomFromUserScroll(sessionId, cached) {
  const session = sessions.get(sessionId);
  if (!session || !isCodexKind(session.kind) || !cached) return;
  requestAnimationFrame(() => {
    const now = performance.now();
    if (cached._codexProgrammaticScrollUntil && now < cached._codexProgrammaticScrollUntil) return;
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
    if (cached._codexProgrammaticScrollUntil && now < cached._codexProgrammaticScrollUntil) return;
    if (!cached._codexUserScrollIntentUntil || now > cached._codexUserScrollIntentUntil) return;
    cached._codexFollowBottom = isTerminalViewportAtBottom(cached);
  };
  vp.addEventListener('scroll', cached._codexViewportScrollHandler, { passive: true });
}

function fitAndResizeTerminal(sessionId, cached, opts = {}) {
  if (!sessionId || !cached || !cached.opened || !cached.container) return false;
  const rect = cached.container.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4 || !cached.container.offsetWidth) return false;
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
  const resizeSig = `${cached.terminal.cols}x${cached.terminal.rows}`;
  if (cached._lastResizeSig !== resizeSig) {
    cached._lastResizeSig = resizeSig;
    ipcRenderer.send('terminal-resize', {
      sessionId,
      cols: cached.terminal.cols,
      rows: cached.terminal.rows,
    });
  }
  if (cached._minimap) cached._minimap.invalidate();
  if (pinAfterFit) scheduleCodexBottomPin(sessionId, cached);
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

// --- DOM refs ---
const sessionListEl = document.getElementById('session-list');
const terminalPanelEl = document.getElementById('terminal-panel');
const emptyStateEl = document.getElementById('empty-state');

// Spec 2 preserve helper — both showTerminal AND session-closed handler clear
// terminalPanelEl.innerHTML, which would obliterate spec 1/2 elements (view-toggle,
// msg-overlay) declared statically in index.html. Without preserve they vanish forever
// after the first session close → no card view + no view toggle button.
function preserveAndClearTerminalPanel() {
  const preserved = [
    document.getElementById('msg-overlay'),
    document.querySelector('.view-toggle')
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
const btnGroupChat = document.getElementById('btn-group-chat');
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

// 2026-05-09 简洁模式：手机远程时一键切换的低密度 UI（纯 CSS 通过 body.compact-mode 控制）
const COMPACT_MODE_KEY = 'claude-hub-compact-mode';
let compactMode = localStorage.getItem(COMPACT_MODE_KEY) === '1';
function toggleCompactMode(enabled) {
  compactMode = !!enabled;
  document.body.classList.toggle('compact-mode', compactMode);
  // 同步所有 .compact-toggle-btn（普通 session 视图 + AI 群聊视图各有一个）
  document.querySelectorAll('.compact-toggle-btn').forEach(b => b.classList.toggle('active', compactMode));
  localStorage.setItem(COMPACT_MODE_KEY, compactMode ? '1' : '0');
  // sidebar 联动：简洁模式 ON 默认折叠，OFF 恢复用户偏好（不污染 SIDEBAR_KEY）。
  // 启动 init 时 applySidebarCollapsed 还没定义，typeof 检查跳过 — line 5113 后会兜底。
  if (typeof applySidebarCollapsed === 'function') {
    if (compactMode) {
      applySidebarCollapsed(true);
    } else {
      const userPref = localStorage.getItem('claude-hub-sidebar-collapsed') === '1';
      applySidebarCollapsed(userPref);
    }
  }
  // 侧栏宽度变化要 refit xterm
  if (typeof terminalCache !== 'undefined' && activeSessionId) {
    const cached = terminalCache.get(activeSessionId);
    if (cached && cached.opened) {
      scheduleFitAndResizeTerminal(activeSessionId, cached, { force: true });
    }
  }
}
// 启动应用持久化状态 + 初始化 --main-zoom（首次 setFontSize 才设变量，启动时手动设一次到 :root）
toggleCompactMode(compactMode);
document.documentElement.style.setProperty('--main-zoom', (currentFontSize / 16).toFixed(3));
document.addEventListener('click', (e) => {
  if (e.target.closest('.compact-toggle-btn')) {
    toggleCompactMode(!compactMode);
  }
});

// --- Global UI zoom (Electron webFrame) ---
// Scales the entire renderer: sidebar, buttons, xterm cells, modals. Used
// mainly to bump everything up for remote/phone control vs. shrink for
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
function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
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

// --- Sidebar tree state: which meeting entries are expanded to show their sub-sessions ---
// Persists across reloads. Default = collapsed (白名单未命中即折叠)；用户点 ▶ 后才进
// _expandedMeetings 集合并落盘。2026-05-05 道雪改：新 AI 群聊不再默认展开，折叠态本来
// 就有 3 个迷你头像跳转按钮可用。
const _expandedMeetings = (() => {
  try {
    const raw = localStorage.getItem('hubExpandedMeetings');
    return new Set(raw ? JSON.parse(raw) : []);
  } catch { return new Set(); }
})();
function _persistExpandedMeetings() {
  try {
    localStorage.setItem('hubExpandedMeetings', JSON.stringify([..._expandedMeetings]));
  } catch {}
}
function toggleMeetingExpand(meetingId) {
  if (_expandedMeetings.has(meetingId)) _expandedMeetings.delete(meetingId);
  else _expandedMeetings.add(meetingId);
  _persistExpandedMeetings();
  renderSessionList();
}

// AI mini logo for sidebar sub-session items. Reuses the .ai-logo + .logo-<kind>
// classes already defined in styles.css for the toolbar dropdown.
//   - 'powershell' 不是 AI kind 但侧边栏需展示 logo，在 ALL_AI_KINDS 之外单独保留。
function _aiLogoHtml(kind) {
  let k = String(kind || '').replace(/-resume$/, '');
  // Claude Web 是 Claude 的风格变体，复用同一 logo（卡片视图另叠加 WEB 角标）
  if (k === 'claude-web') k = 'claude';
  if (k === 'codex-web') k = 'codex';
  if (k === 'codex-app') return `<span class="ai-logo logo-codex" aria-hidden="true"></span>`;
  if (k !== 'powershell' && !isAiKind(k)) return '';
  return `<span class="ai-logo logo-${k}" aria-hidden="true"></span>`;
}

// --- Session list rendering ---
// Sort: pinned sessions first (by their own time), then unpinned by lastMessageTime.
// Tree shape: meeting entries optionally expand to show their child sub-sessions.
// Top-level regular sessions (no meetingId) sit alongside meetings in the same sort order.
function renderSessionList() {
  const regularSessions = Array.from(sessions.values()).filter(s => !s.meetingId);

  const meetingItems = Object.values(meetings).map(m => ({
    id: m.id,
    title: m.title,
    lastMessageTime: m.lastMessageTime,
    createdAt: m.createdAt,
    lastOutputPreview: `${m.subSessions.length} 个子会话`,
    status: m.status || 'idle',
    // 2026-05-05 道雪 修3：AI 群聊 item 接入 unread 机制 —— 全员答完且非 active 时累加，
    //   selectMeeting 时清零。替代旧 Web Notification + title 闪烁，统一走 Hub 侧栏哲学。
    unreadCount: m.unreadCount || 0,
    pinned: m.pinned,
    _isMeeting: true,
    _meeting: m,
  }));

  const all = regularSessions.concat(meetingItems);

  const sorted = all.sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return b.lastMessageTime - a.lastMessageTime || b.createdAt - a.createdAt;
  });

  // Hide any leftover legacy background PTY sessions from the removed room path.
  const visible = sorted.filter(s => !s.title || !s.title.startsWith('[Team] '));

  // Preserve scroll position across rebuilds — without this, any re-render
  // (every status-event, silence-timer, or session-updated) snaps the list
  // back to the top, which feels like the sidebar is "fighting" the user.
  const savedScrollTop = sessionListEl.scrollTop;
  sessionListEl.innerHTML = '';

  for (const s of visible) {
    if (s._isMeeting) {
      const isActive = activeMeetingId === s.id;
      const isExpanded = _expandedMeetings.has(s.id);
      const div = document.createElement('div');
      // 2026-05-05 道雪 修3：AI 群聊 item 也应用 has-unread CSS（跟普通 session 一致），
      //   全员答完且非 active 时高亮提醒；用户点进 AI 群聊后清零。
      const isDormantMeeting = s.status === 'dormant';
      const hasUnread = !isDormantMeeting && !isActive && (s.unreadCount > 0);
      div.className = 'session-item meeting' + (isActive ? ' selected' : '')
        + (isExpanded ? ' expanded' : '') + (hasUnread ? ' has-unread' : '')
        + (isDormantMeeting ? ' dormant' : '');
      div.dataset.meetingId = s.id;
      // Phase 8(2026-05-05 道雪): 折叠/展开态都显示 3 个迷你头像跳转按钮(替代旧 "N 个子会话" 文字)。
      //   slot 配色绑定: subSessions[0]=Pikachu(slot1) / [1]=Charmander(slot2) / [2]=Squirtle(slot3),
      //   PNG 图与卡片头像/footer 一致(assets/pokemon/*.png)。
      //   状态点: thinking/streaming(running)=黄, errored=红, idle/completed=绿, 创建中=灰。
      const SLOT_AVATAR_FILES = ['pikachu.png', 'charmander.png', 'squirtle.png'];
      const SLOT_LABELS_M = ['⚡ 皮卡丘', '🔥 小火龙', '💎 杰尼龟'];
      const isGroupChat = !!s._meeting.groupChat;
      const miniSids = isGroupChat ? (s._meeting.subSessions || []) : (s._meeting.subSessions || []).slice(0, 3);
      const miniJumpsHtml = miniSids.map((subId, idx) => {
        const sub = sessions.get(subId);
        const label = isGroupChat
          ? ((sub && (sub.title || sub.kind)) || `AI ${idx + 1}`)
          : (SLOT_LABELS_M[idx] || `Slot ${idx + 1}`);
        const avatarSrc = isGroupChat && sub && sub.kind
          ? `assets/ai-logos/${sub.kind}.svg`
          : `assets/pokemon/${SLOT_AVATAR_FILES[idx]}`;
        const modelLabel = sub && sub.currentModel ? (typeof modelShort === 'function' ? modelShort(sub.currentModel) : sub.currentModel.id) : '';
        // 状态点配色: 复用 sub.status(running/idle/errored), 配合 cliReadyCache 推断 initializing
        let statusCls = 'mini-st-ready';
        if (!sub) statusCls = 'mini-st-init';
        else if (sub.status === 'dormant') statusCls = 'mini-st-dormant';
        else if (sub.status === 'errored' || sub.status === 'error') statusCls = 'mini-st-error';
        else if (sub.status === 'running') statusCls = 'mini-st-thinking';
        const isActiveChild = subId === activeSessionId;
        const tooltip = `${label}${modelLabel ? ' · ' + modelLabel : ''} (点击跳转)`;
        return `<button class="mini-jump-btn slot-${idx + 1}${isGroupChat ? ' group' : ''}${isActiveChild ? ' active' : ''}" data-sub-id="${subId}" title="${escapeHtml(tooltip)}">
          <img src="${avatarSrc}" alt="${escapeHtml(label)}" />
          <span class="mini-jump-status-dot ${statusCls}"></span>
        </button>`;
      }).join('');
      div.innerHTML = `
        <div class="session-item-header">
          <span class="session-title">
            <span class="expand-arrow" data-action="toggle-expand" title="${isExpanded ? '折叠' : '展开'}">▶</span>
            ${s.pinned ? '<span class="pin-icon" title="Pinned">📌</span>' : ''}
            <span class="session-status ${isDormantMeeting ? 'dormant' : 'running'}"></span>${isGroupChat ? '💬' : '🎯'} ${escapeHtml(s.title)}<span class="meeting-badge">${s._meeting.subSessions.length}</span>
          </span>
          <span class="session-header-right">
            ${isDormantMeeting ? `<span class="dormant-badge" title="休眠中，点击唤醒">休眠</span>` : ''}
            ${hasUnread ? `<span class="unread-badge" title="新轮次完成">⏸ 等你</span>` : ''}
            <span class="session-time">${formatTime(s.lastMessageTime)}</span>
          </span>
        </div>
        <div class="session-mini-jumps">${miniJumpsHtml}</div>
      `;
      div.addEventListener('click', (e) => {
        // Phase 8: 迷你跳转按钮 click → 跳转对应子 session, 不冒泡到 selectMeeting
        const jumpBtn = e.target.closest('[data-sub-id]');
        if (jumpBtn) {
          e.stopPropagation();
          const subId = jumpBtn.getAttribute('data-sub-id');
          if (subId) selectSession(subId, { forceScrollBottom: true });
          return;
        }
        if (e.target.closest('[data-action="toggle-expand"]')) {
          e.stopPropagation();
          toggleMeetingExpand(s.id);
        } else {
          selectMeeting(s.id);
        }
      });
      div.addEventListener('contextmenu', (e) => { e.preventDefault(); openContextMenu(s.id, e.clientX, e.clientY); });
      sessionListEl.appendChild(div);

      // Render child sub-sessions if expanded (clicking goes straight to shell view).
      if (isExpanded) {
        for (const subId of s._meeting.subSessions) {
          const sub = sessions.get(subId);
          if (!sub) continue;
          const childDiv = document.createElement('div');
          const isChildActive = subId === activeSessionId;
          const childDormantCls = sub.status === 'dormant' ? ' dormant' : '';
          childDiv.className = 'session-item child' + (isChildActive ? ' selected' : '') + childDormantCls;
          childDiv.dataset.sessionId = subId;
          const modelLabel = sub.currentModel
            ? `<span class="child-model-badge ${modelClass(sub.currentModel.id)}" title="${escapeHtml(sub.currentModel.displayName || sub.currentModel.id)}">${escapeHtml(modelShort(sub.currentModel))}</span>`
            : '';
          childDiv.innerHTML = `
            ${_aiLogoHtml(sub.kind)}
            <span class="child-title">${escapeHtml(sub.title)}</span>
            ${modelLabel}
          `;
          // Use the existing selectSession path: it hides meeting-room-panel,
          // shows terminal-panel, and mounts the cached xterm container.
          // This is exactly the "single-viewer strict switch" the spec calls for.
          childDiv.addEventListener('click', () => selectSession(subId, { forceScrollBottom: true }));
          childDiv.addEventListener('contextmenu', (ev) => { ev.preventDefault(); openContextMenu(subId, ev.clientX, ev.clientY); });
          sessionListEl.appendChild(childDiv);
        }
      }
      continue;
    }

    const isActive = s.id === activeSessionId;
    const div = document.createElement('div');
    const isDormant = s.status === 'dormant';
    const dormantCls = isDormant ? ' dormant' : '';
    const showWaiting = !isDormant && s.isWaiting && !isActive;
    const showUnread = !isDormant && s.unreadCount > 0 && !isActive && !s.isWaiting;
    const waitingCls = showWaiting ? ' is-waiting' : '';
    div.className = 'session-item' + (isActive ? ' selected' : '') + (showUnread ? ' has-unread' : '') + waitingCls + dormantCls;
    const ctxBadge = typeof s.contextPct === 'number'
      ? `<span class="ctx-badge ${pctClass(s.contextPct)}" title="Context ${s.contextPct}%">Ctx ${s.contextPct}%</span>`
      : '';
    const modelBadge = s.currentModel
      ? `<span class="model-badge ${modelClass(s.currentModel.id)}" title="${escapeHtml(s.currentModel.displayName || s.currentModel.id)}">${escapeHtml(modelShort(s.currentModel))}</span>`
      : '';
    // Burn attribution: only show if we have a rate ≥ 0.5%/h; clutter guard.
    const burn = sessionBurnRate(s);
    const burnBadge = (burn && burn.pctPerHour >= 0.5)
      ? `<span class="burn-badge ${burn.pctPerHour >= 5 ? 'danger' : burn.pctPerHour >= 2 ? 'warn' : 'ok'}" title="Est. share of 5h cap / hour at current rate (${Math.round(burn.tokensPerMin).toLocaleString()} tok/min)">🔥 ${burn.pctPerHour.toFixed(1)}%/h</span>`
      : '';
    const statusBadge = isDormant
      ? `<span class="dormant-badge" title="休眠中，点击唤醒">休眠</span>`
      : (showWaiting
        ? `<span class="waiting-badge" title="${escapeHtml(s.waitingText || 'Claude is waiting for your input')}">⏸ 等你</span>`
        : (showUnread
          ? `<span class="unread-badge" title="${escapeHtml(s.lastOutputPreview || 'AI 有新消息')}">⏸ 等你</span>`
          : ''));
    const footerInner = [statusBadge, modelBadge, ctxBadge, burnBadge].filter(Boolean).join('');
    // Claude Web 模式角标：在标题右侧、时间左边附一个小 WEB 标识
    // 复用 .web-badge-inline 样式（在下拉菜单内已使用相同视觉）
    const webBadge = (s.kind === 'claude-web' || s.kind === 'claude-web-resume' || s.kind === 'codex-web' || s.kind === 'codex-web-resume')
      ? '<span class="web-badge-inline" title="Web 模式 — 风格对齐网页端体验">WEB</span>'
      : '';
    div.innerHTML = `
      <div class="session-item-header">
        <span class="session-title">${s.pinned ? '<span class="pin-icon" title="Pinned">📌</span>' : ''}<span class="session-status ${s.status}"></span>${escapeHtml(s.title)}${webBadge}</span>
        <span class="session-header-right">
          <span class="session-time">${formatTime(s.lastMessageTime)}</span>
        </span>
      </div>
      <div class="session-preview">${escapeHtml((!isDormant && s.isWaiting && s.waitingText) || s.lastOutputPreview || 'No output yet')}</div>
      ${footerInner ? `<div class="session-footer">${footerInner}</div>` : ''}
    `;
    div.addEventListener('click', () => selectSession(s.id, { forceScrollBottom: true }));
    div.addEventListener('contextmenu', (e) => { e.preventDefault(); openContextMenu(s.id, e.clientX, e.clientY); });
    sessionListEl.appendChild(div);
  }
  sessionListEl.scrollTop = savedScrollTop;
}

// --- Session card hover light-tracking + click ripple (event delegation) ---
sessionListEl.addEventListener('mousemove', (e) => {
  const item = e.target.closest('.session-item');
  if (!item) return;
  const rect = item.getBoundingClientRect();
  item.style.setProperty('--mx', ((e.clientX - rect.left) / rect.width * 100) + '%');
  item.style.setProperty('--my', ((e.clientY - rect.top) / rect.height * 100) + '%');
});
sessionListEl.addEventListener('mousedown', (e) => {
  const item = e.target.closest('.session-item');
  if (!item) return;
  const rect = item.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height);
  const r = document.createElement('span');
  r.className = 'ripple-fx';
  r.style.width = r.style.height = size + 'px';
  r.style.left = (e.clientX - rect.left - size / 2) + 'px';
  r.style.top = (e.clientY - rect.top - size / 2) + 'px';
  item.appendChild(r);
  setTimeout(() => r.remove(), 450);
});

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


function selectMeeting(meetingId) {
  savePreviewState();
  activeSessionId = null;
  activeMeetingId = meetingId;

  if (terminalPanelEl) terminalPanelEl.style.display = 'none';
  if (emptyStateEl) emptyStateEl.style.display = 'none';
  clearPreviewUI();

  const meeting = meetings[meetingId];
  // 2026-05-05 道雪 修3：清 unread —— 用户点进 AI 群聊即"看过"，跟普通 session 一致。
  if (meeting && meeting.unreadCount) {
    meeting.unreadCount = 0;
  }
  if (meeting && typeof MeetingRoom !== 'undefined') {
    if (meeting.status === 'dormant') {
      meeting.status = 'idle';
      for (const sid of meeting.subSessions) {
        const s = sessions.get(sid);
        if (s && s.status === 'dormant') {
          resumeDormantSession(sid);
        }
      }
    }
    MeetingRoom.openMeeting(meetingId, meeting);
  }

  renderSessionList();
  restorePreviewForContext(`meeting:${meetingId}`);
}

// --- Terminal management ---
// Load GPU renderer. Default is Canvas (stable + GPU-accelerated 2D). WebGL
// is faster but on some GPU/driver combos it leaves cursor ghosting artifacts
// in Claude Code's TUI redraw, so it's opt-in only.
// Override via localStorage: setItem('hub.renderer', 'canvas' | 'webgl' | 'dom')
function loadGpuRenderer(cached) {
  if (cached._gpuLoaded) return;
  cached._gpuLoaded = true;
  const pref = localStorage.getItem('hub.renderer') || 'canvas';
  if (pref === 'dom') return;
  if (pref === 'webgl') {
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
        try { cached.terminal.loadAddon(new CanvasAddon()); } catch (_) {}
      });
      cached.terminal.loadAddon(webgl);
      return;
    } catch (_) { /* fall through to canvas */ }
  }
  try { cached.terminal.loadAddon(new CanvasAddon()); } catch (_) {}
}

function getOrCreateTerminal(sessionId) {
  if (terminalCache.has(sessionId)) return terminalCache.get(sessionId);

  const currentTheme = localStorage.getItem('claude-hub-theme') || 'default';
  const terminal = new Terminal({
    theme: (typeof XTERM_THEMES !== 'undefined' && XTERM_THEMES[currentTheme]) || {
      background: '#0d1117', foreground: '#f0f6fc', cursor: '#58a6ff',
      cursorAccent: '#0d1117', selectionBackground: 'rgba(88, 166, 255, 0.3)',
      black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922',
      blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39d353', white: '#f0f6fc',
      brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364',
      brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff',
      brightCyan: '#56d364', brightWhite: '#ffffff',
    },
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
  registerLocalPathLinks(terminal, sessionId);
  terminal.unicode.activeVersion = '11';

  terminal.onData((data) => {
    if (data) clearSessionWaitingState(sessionId);
    ipcRenderer.send('terminal-input', { sessionId, data });
  });
  terminal.onBinary((data) => { ipcRenderer.send('terminal-input', { sessionId, data }); });

  // Claude Code emits an OSC set-title escape sequence once near the start of a
  // conversation with an AI-generated short summary (e.g. "Greeting in Chinese").
  // xterm fires onTitleChange for it. We capture that as the session title
  // unless the user already renamed in Hub (userRenamed wins). Only for Claude
  // kinds — PowerShell emits title sequences on every prompt, which we don't want.
  // 2026-05-02 修复：DeepSeek/GLM 也跑在 Claude CLI 上、emit 同样的 OSC title
  //   序列，但旧版本 isClaudeKind 只含 'claude'/'claude-resume' 把这两家排除 →
  //   DS/GLM 子 session 永远叫 'Claude' 不能自动获标题。改用 isClaudeFamily helper
  //   （CLAUDE_FAMILY 含 deepseek/glm），单一真理源，未来加新 Claude 衍生家族自动覆盖。
  const session = sessions.get(sessionId);
  const isClaudeKind = session && isClaudeFamily(session.kind);
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
      if (!clean) return;
      if (clean === 'Claude Code') return; // generic startup title — ignore
      // When `claude --resume <id>` fails (stale id, missing transcript), the
      // PTY falls back to a plain PowerShell prompt, which emits OSC sequences
      // setting the title to its own executable path (e.g.
      // "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe") or
      // the current working directory. Any of these would clobber the real
      // conversation title. Reject anything that looks like a file path / exe.
      if (/[\\\/]/.test(clean)) return;
      if (/\.exe$/i.test(clean)) return;
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
  };
  terminalCache.set(sessionId, cached);
  return cached;
}

function showTerminal(sessionId, opts = { focus: true }) {
  for (const [, c] of terminalCache) c.container.style.display = 'none';

  const session = sessions.get(sessionId);
  if (!session) return;

  const cached = getOrCreateTerminal(sessionId);

  // Preserve spec 1/2 elements that live inside #terminal-panel (view-toggle, msg-overlay)
  // before innerHTML clear obliterates them; re-attach after.
  preserveAndClearTerminalPanel();

  const header = document.createElement('div');
  header.className = 'terminal-header';

  const titleRow = document.createElement('div');
  titleRow.className = 'terminal-title-row';

  const titleSection = document.createElement('div');
  titleSection.className = 'terminal-title-section';

  const titleSpan = document.createElement('span');
  titleSpan.className = 'terminal-title';
  titleSpan.textContent = session.title;
  titleSpan.title = 'Click to rename';
  titleSpan.addEventListener('click', () => startRename(sessionId, titleSpan));

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

  // Zoom controls live right next to the close button so they're always at
  // the top-right of whichever session you're in. Buttons are recreated per
  // showTerminal call; no need to worry about stale references.
  const zoomOutBtn = document.createElement('button');
  zoomOutBtn.className = 'btn-zoom';
  zoomOutBtn.textContent = 'A−';
  zoomOutBtn.title = 'Shrink UI (for local screen)';
  zoomOutBtn.addEventListener('click', () => applyZoom(currentZoom - 1));

  const zoomInBtn = document.createElement('button');
  zoomInBtn.className = 'btn-zoom';
  zoomInBtn.textContent = 'A+';
  zoomInBtn.title = 'Enlarge UI (for remote / phone)';
  zoomInBtn.addEventListener('click', () => applyZoom(currentZoom + 1));

  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn-close-session';
  closeBtn.title = 'Close session (Ctrl+W)';
  closeBtn.setAttribute('aria-label', 'Close session');
  closeBtn.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/></svg>';
  closeBtn.addEventListener('click', () => ipcRenderer.invoke('close-session', sessionId));

  // Metrics (cwd + api time) live inline with the title now — single-row header.
  const metricsRow = document.createElement('div');
  metricsRow.className = 'terminal-metrics-row inline';
  renderMetricsRow(metricsRow, session);
  titleSection.appendChild(metricsRow);

  const headerActions = document.createElement('div');
  headerActions.className = 'terminal-header-actions';
  const memoBtn = document.createElement('button');
  memoBtn.className = 'btn-zoom btn-memo-toggle';
  memoBtn.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M2 3.5A1.5 1.5 0 013.5 2h9A1.5 1.5 0 0114 3.5v9a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12.5v-9zM4 5h8M4 8h8M4 11h5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none"/></svg>';
  memoBtn.title = 'Toggle memo panel';
  if (memoPanel.isOpen()) memoBtn.classList.add('active');
  memoBtn.addEventListener('click', () => memoPanel.toggle());

  headerActions.append(memoBtn, zoomOutBtn, zoomInBtn, closeBtn);

  titleRow.append(titleSection, headerActions);

  header.append(titleRow);

  const termContainer = document.createElement('div');
  termContainer.className = 'terminal-container';
  termContainer.addEventListener('click', () => cached.terminal.focus());

  terminalPanelEl.append(header, termContainer);
  emptyStateEl.style.display = 'none';

  if (!termContainer.contains(cached.container)) {
    termContainer.appendChild(cached.container);
  }
  cached.container.style.display = 'block';

  if (!cached.opened) {
    cached.terminal.open(cached.container);
    cached.opened = true;
    loadGpuRenderer(cached);
    setupImageHover(cached.terminal, cached.container);
  }
  setupCodexViewportScrollTracker(sessionId, cached);

  requestAnimationFrame(() => {
    const dbg = window.__scrollDebug;
    if (dbg && dbg.isOn()) dbg.log('show:raf-enter', { focus: opts.focus, ...dbg.snap(cached.terminal, sessionId) });
    fitAndResizeTerminal(sessionId, cached, { force: true });
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
  cached._floatingInput = mountFloatingInput(sessionId, termContainer, cached.terminal);

  // === Spec 2 · S7: 切换 session 时加载真实历史卡片 ===
  if (currentView === 'card') {
    // loadSessionHistoryToOverlay handles its own clear + Map.clear + placeholder
    // for empty/error/non-Claude cases. Don't pre-clear here.
    if (typeof loadSessionHistoryToOverlay === 'function') {
      loadSessionHistoryToOverlay(sessionId, { forceScrollBottom: !!opts.forceScrollBottom }).catch(err => {
        console.warn('[showTerminal] loadSessionHistoryToOverlay failed:', err);
      });
    }
  } else {
    // PTY view: just clear msg-overlay (don't load cards user can't see)
    const overlay = document.getElementById('msg-overlay');
    if (overlay) {
      overlay.innerHTML = '';
      if (window._sessionTurns) window._sessionTurns.clear();
    }
  }
  // Spec 3 · W15：切 session 时清旧 indicator + 按新 active session 状态重建
  if (typeof _updateStreamingIndicator === 'function') {
    _updateStreamingIndicator(sessionId);
  }
}

// Minimap: a narrow strip on the right edge of the terminal that shows prompt
// locations + the viewport window. Scans the xterm buffer on-demand (debounced);
// no line-by-line callbacks, so the terminal.write fast path stays untouched.
function mountMinimap(sessionId, termContainer, terminal) {
  const strip = document.createElement('div');
  strip.className = 'terminal-minimap';
  const viewport = document.createElement('div');
  viewport.className = 'minimap-viewport';
  const ticksLayer = document.createElement('div');
  ticksLayer.className = 'minimap-ticks';
  strip.append(ticksLayer, viewport);
  termContainer.appendChild(strip);

  let ticks = []; // [{line, text}]
  let scanTimer = null;
  let maxDebounceTimer = null;
  let disposed = false;

  function scanBuffer() {
    if (disposed) return;
    const buf = terminal.buffer.active;
    const total = buf.length;
    const found = [];
    for (let i = 0; i < total; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true);
      if (!text) continue;
      if (AI_MARKERS_RE.test(text)) continue;
      const m = text.match(PROMPT_LINE_RE);
      if (!m) continue;
      const q = m[1].trim();
      if (q.length < 2) continue;
      let endLine = i;
      while (endLine + 1 < total) {
        const next = buf.getLine(endLine + 1);
        if (!next || !next.isWrapped) break;
        endLine++;
      }
      found.push({ line: i, endLine, text: q });
      i = endLine;
    }
    ticks = found;
    render();
  }

  function invalidate() {
    if (disposed) return;
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      if (maxDebounceTimer) { clearTimeout(maxDebounceTimer); maxDebounceTimer = null; }
      scanBuffer();
    }, 250);
    // Force a scan within 2s even if writes keep coming (prevents starvation
    // during continuous AI streaming).
    if (!maxDebounceTimer) {
      maxDebounceTimer = setTimeout(() => {
        maxDebounceTimer = null;
        if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
        scanBuffer();
      }, 2000);
    }
  }

  let promptMarkerLayer = null;
  const initCache = terminalCache.get(sessionId);
  let activeLine = (initCache && typeof initCache._activePromptLine === 'number') ? initCache._activePromptLine : -1;

  function ensureMarkerLayer() {
    if (promptMarkerLayer) return promptMarkerLayer;
    promptMarkerLayer = document.createElement('div');
    promptMarkerLayer.className = 'prompt-marker-layer';
    termContainer.appendChild(promptMarkerLayer);
    return promptMarkerLayer;
  }

  function render() {
    if (disposed) return;
    const buf = terminal.buffer.active;
    const total = Math.max(1, buf.length);
    const stripH = strip.clientHeight || 1;
    // Ticks
    ticksLayer.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const t of ticks) {
      const y = (t.line / total) * stripH;
      const el = document.createElement('div');
      el.className = 'minimap-tick';
      el.style.top = Math.round(y) + 'px';
      el.title = t.text.slice(0, 80);
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        try { terminal.scrollToLine(t.line); } catch {}
      });
      frag.appendChild(el);
    }
    ticksLayer.appendChild(frag);
    // Viewport box
    const top = (buf.viewportY / total) * stripH;
    const height = Math.max(6, (terminal.rows / total) * stripH);
    viewport.style.top = Math.round(top) + 'px';
    viewport.style.height = Math.round(height) + 'px';

    // Prompt line markers (left bar + background) for visible ticks
    const layer = ensureMarkerLayer();
    layer.innerHTML = '';
    const ren = terminal._core._renderService;
    if (!ren || !ren.dimensions) return;
    const cellH = ren.dimensions.css.cell.height;
    const viewY = isNaN(buf.viewportY) ? buf.baseY : buf.viewportY;
    const rows = terminal.rows;
    const markerFrag = document.createDocumentFragment();
    for (const t of ticks) {
      const end = t.endLine || t.line;
      if (end < viewY || t.line >= viewY + rows) continue;
      const visStart = Math.max(t.line, viewY);
      const visEnd = Math.min(end, viewY + rows - 1);
      const topPx = (visStart - viewY) * cellH;
      const heightPx = (visEnd - visStart + 1) * cellH;
      const marker = document.createElement('div');
      marker.className = 'prompt-line-marker' + (t.line === activeLine ? ' prompt-line-marker-active' : '');
      marker.style.top = topPx + 'px';
      marker.style.height = heightPx + 'px';
      markerFrag.appendChild(marker);
    }
    layer.appendChild(markerFrag);

    // Notify any external listeners (e.g. nav buttons) that ticks/active changed.
    const cache = terminalCache.get(sessionId);
    if (cache && cache._navButtons && cache._navButtons.refreshState) {
      cache._navButtons.refreshState();
    }
  }

  // Strip click (outside ticks) → scroll to proportional line.
  strip.addEventListener('click', (e) => {
    e.stopPropagation();
    const rect = strip.getBoundingClientRect();
    const rel = (e.clientY - rect.top) / Math.max(1, rect.height);
    const buf = terminal.buffer.active;
    const target = Math.max(0, Math.min(buf.length - 1, Math.round(rel * buf.length)));
    try { terminal.scrollToLine(target); } catch {}
  });

  // xterm listeners. Keep them disposable.
  const scrollSub = terminal.onScroll(() => render());
  const renderSub = terminal.onRender(() => invalidate());

  // Initial scan (wait a frame so buffer is populated).
  requestAnimationFrame(() => { scanBuffer(); render(); });

  // --- nav helpers (shared by Ctrl+Up/Down keyboard and ▲▼ buttons) ---
  function findNavTarget(direction) {
    if (!ticks.length) return null;
    const buf = terminal.buffer.active;
    const hasActive = activeLine >= 0;
    let cur;
    if (hasActive) {
      // If user scrolled far from the last-jumped prompt, fall back to viewport
      // anchor so the next jump starts near where the user is actually looking.
      const viewY = buf.viewportY;
      if (activeLine < viewY || activeLine >= viewY + terminal.rows) {
        cur = direction === 'up' ? viewY + terminal.rows : viewY;
      } else {
        cur = activeLine;
      }
    } else if (direction === 'up') cur = buf.viewportY + terminal.rows;
    else cur = buf.viewportY;
    if (direction === 'up') {
      for (let i = ticks.length - 1; i >= 0; i--) {
        if (ticks[i].line < cur) return ticks[i];
      }
    } else {
      for (let i = 0; i < ticks.length; i++) {
        if (ticks[i].line > cur) return ticks[i];
      }
    }
    return null;
  }

  function navTo(direction) {
    const target = findNavTarget(direction);
    if (!target) return false;
    try { terminal.scrollToLine(target.line); } catch {}
    activeLine = target.line;
    flashPromptLine(terminal, target.line);
    render();
    // Sync external state field (kept for backward compat with any reader)
    const cache = terminalCache.get(sessionId);
    if (cache) cache._activePromptLine = target.line;
    return true;
  }

  return {
    invalidate,
    getTicks() { return ticks; },
    setActiveLine(line) {
      activeLine = line;
      // Mirror to cache so re-mounts after a session-switch see the same state
      // navTo() writes (single source of truth).
      const cache = terminalCache.get(sessionId);
      if (cache) cache._activePromptLine = line;
      render();
    },
    navPrev() { return navTo('up'); },
    navNext() { return navTo('down'); },
    canNavPrev() { return findNavTarget('up') !== null; },
    canNavNext() { return findNavTarget('down') !== null; },
    dispose() {
      disposed = true;
      if (scanTimer) clearTimeout(scanTimer);
      if (maxDebounceTimer) clearTimeout(maxDebounceTimer);
      try { scrollSub.dispose(); } catch {}
      try { renderSub.dispose(); } catch {}
      if (strip.parentNode) strip.parentNode.removeChild(strip);
      if (promptMarkerLayer && promptMarkerLayer.parentNode) promptMarkerLayer.parentNode.removeChild(promptMarkerLayer);
    },
  };
}

// Floating ▲▼ buttons in the terminal's top-right corner. Shares lifecycle
// with mountMinimap: created by attachTerminalToPanel after mountMinimap,
// disposed when the terminalCache entry's _minimap is disposed (we attach
// our dispose to the same chain via the returned object).
//
// `sessionId` is reserved for symmetry with mountMinimap and potential future
// use (e.g., per-session button state); not currently used in the body.
function mountPromptNavButtons(sessionId, termContainer, minimap) {
  const wrap = document.createElement('div');
  wrap.className = 'prompt-nav-buttons';

  const btnUp = document.createElement('button');
  btnUp.className = 'prompt-nav-btn';
  btnUp.setAttribute('data-dir', 'up');
  btnUp.title = '上一个问题 (Ctrl+↑)';
  btnUp.textContent = '▲';

  const btnDown = document.createElement('button');
  btnDown.className = 'prompt-nav-btn';
  btnDown.setAttribute('data-dir', 'down');
  btnDown.title = '下一个问题 (Ctrl+↓)';
  btnDown.textContent = '▼';

  wrap.appendChild(btnUp);
  wrap.appendChild(btnDown);
  termContainer.appendChild(wrap);

  function refreshState() {
    btnUp.disabled = !minimap.canNavPrev();
    btnDown.disabled = !minimap.canNavNext();
  }

  btnUp.addEventListener('click', (e) => {
    // stopPropagation: prevent termContainer's focus-on-click listener from firing
    e.stopPropagation();
    minimap.navPrev();
    refreshState();
    const c = terminalCache.get(sessionId);
    if (c && c.terminal) c.terminal.focus();
  });
  btnDown.addEventListener('click', (e) => {
    e.stopPropagation();
    minimap.navNext();
    refreshState();
    const c = terminalCache.get(sessionId);
    if (c && c.terminal) c.terminal.focus();
  });

  // Initial call: ticks array is empty until the rAF scan in mountMinimap
  // completes, so buttons start disabled. mountMinimap's render() then calls
  // refreshState() after the first scan and will re-enable them.
  refreshState();

  return {
    refreshState,
    dispose() {
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
    },
  };
}

// === Spec 1 v0.9.0 · 工具调用块 + 折叠状态 ===
// _sessionTurns: turnId -> turn object map. Initialized here so rerenderTurn
// works for T5 toggle even before T10 wires real session.turns data.
// T10 will populate this from session.turns[]; for now it's an empty map.
if (!window._sessionTurns) window._sessionTurns = new Map();

const _foldedToolsState = new Map(); // 'turnId:toolIdx' -> bool(expanded)
let _toolFoldThreshold = 15; // 启动时从 config 拉

function setFoldedTool(turnId, idx, expanded) {
  _foldedToolsState.set(`${turnId}:${idx}`, expanded);
}
function getFoldedTool(turnId, idx, defaultExpanded) {
  const key = `${turnId}:${idx}`;
  if (_foldedToolsState.has(key)) return _foldedToolsState.get(key);
  return defaultExpanded;
}

// === Spec 3 · UI 方案 E (CardCluster) — 工具簇 ===
// 多 tool 同 turn 合并显示：1 行 cluster summary 默认折叠，展开后是工具列表。
// 每行 tool 显示 [Name] [cmd-from-input]，因 tool_result 在 parser 跳过故无 stdout
// （留待 spec 3+ 关联 tool_use_id ↔ tool_result 后再展开单 tool 详情）。
// 替代了之前每个 tool 单独渲染成大块的方案（信息密度低）。
const _TOOL_CMD_KEYS = ['file_path', 'command', 'pattern', 'path', 'url', 'query'];
function _toolCmdFromInput(input) {
  if (!input || typeof input !== 'object') return '';
  for (const k of _TOOL_CMD_KEYS) {
    if (typeof input[k] === 'string' && input[k]) {
      return input[k].split('\n')[0].slice(0, 100);
    }
  }
  return '';
}
// Spec 3 · W9：渲染单条 tool row。如果有 result（tool stdout），
// 用 details/summary 折叠；否则纯 div。result 默认折叠，长 result 截断 5KB。
const _TOOL_RESULT_PREVIEW_LIMIT = 5000;
function _renderToolRow(tc) {
  const name = escapeHtml((tc && tc.name) || '?');
  const cmd = escapeHtml(_toolCmdFromInput(tc && tc.input));
  const head = `<span class="tc-row-name">${name}</span>${cmd ? ` <span class="tc-row-cmd">${cmd}</span>` : ''}`;
  const hasResult = tc && typeof tc.result === 'string' && tc.result.length > 0;
  if (!hasResult) {
    return `<div class="tc-row">${head}</div>`;
  }
  const isErr = tc.isError === true;
  const truncated = tc.result.length > _TOOL_RESULT_PREVIEW_LIMIT;
  const preview = truncated
    ? tc.result.slice(0, _TOOL_RESULT_PREVIEW_LIMIT) + '\n…(已截断 ' + (tc.result.length - _TOOL_RESULT_PREVIEW_LIMIT) + ' 字符)'
    : tc.result;
  const errBadge = isErr ? ' <span class="tc-row-errbadge">✗ 错误</span>' : '';
  return `<details class="tc-row tc-row-with-result${isErr ? ' tc-row-err' : ''}">
    <summary class="tc-row-head">${head}${errBadge}</summary>
    <pre class="tc-result${isErr ? ' tc-result-err' : ''}">${escapeHtml(preview)}</pre>
  </details>`;
}

function renderToolCluster(turnId, toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return '';
  const total = toolCalls.length;
  // Spec 3 · W1：单 tool 时简化 summary 为 `▸ Bash command-snippet`
  // 不再写"1 个工具调用 · X"（D3 数据：5196 个 entry 中 55% 是 1-tool，原措辞冗余且填屏）
  if (total === 1) {
    const tc = toolCalls[0] || {};
    const name = escapeHtml(tc.name || '?');
    const cmd = escapeHtml(_toolCmdFromInput(tc.input));
    return `<details class="tc-cluster tc-cluster-single" data-turn="${escapeHtml(turnId)}">
      <summary class="tc-cluster-head"><span class="tc-row-name">${name}</span>${cmd ? ` <span class="tc-row-cmd">${cmd}</span>` : ''}</summary>
      <div class="tc-cluster-list">${_renderToolRow(tc)}</div>
    </details>`;
  }
  const counts = {};
  for (const tc of toolCalls) {
    const name = (tc && tc.name) || '?';
    counts[name] = (counts[name] || 0) + 1;
  }
  const breakdown = Object.entries(counts)
    .map(([n, c]) => c > 1 ? `${n} × ${c}` : n)
    .join(' + ');
  const items = toolCalls.map(_renderToolRow).join('');
  return `<details class="tc-cluster" data-turn="${escapeHtml(turnId)}">
    <summary class="tc-cluster-head">${total} 个工具调用 · ${escapeHtml(breakdown)}</summary>
    <div class="tc-cluster-list">${items}</div>
  </details>`;
}

function renderToolCall(turnId, idx, tc) {
  // tc = { name, cmd, stdout, ok, durationMs, exitCode? }
  const lines = (tc.stdout || '').split('\n').length;
  const isFail = tc.ok === false;
  const shouldFold = lines > _toolFoldThreshold && !isFail;
  const expanded = getFoldedTool(turnId, idx, !shouldFold);
  const status = isFail
    ? `<span class="tc-fail">✗</span>${tc.exitCode != null ? ' exit ' + tc.exitCode : ''}`
    : `<span class="tc-ok">✓</span>`;
  const dur = tc.durationMs != null ? ` · ${(tc.durationMs/1000).toFixed(1)}s` : '';
  const meta = `${lines} line${lines===1?'':'s'}${dur}`;
  return `<div class="tc" data-turn="${escapeHtml(turnId)}" data-idx="${idx}">
    <div class="tc-head">
      <span><span class="tc-name">${escapeHtml(tc.name)}</span> ${escapeHtml(tc.cmd || '')}</span>
      <span class="tc-meta">${status} ${meta}</span>
    </div>
    ${shouldFold && !expanded
      ? `<div class="tc-toggle" data-action="tc-expand">▸ 展开 ${lines} 行(折叠 >${_toolFoldThreshold} 行)</div>`
      : `<pre class="tc-out">${escapeHtml(tc.stdout || '')}</pre>${shouldFold ? '<div class="tc-toggle" data-action="tc-collapse">▾ 折叠</div>' : ''}`}
  </div>`;
}

// 全局 click handler: 工具块展开/折叠
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action="tc-expand"], [data-action="tc-collapse"]');
  if (!btn) return;
  const wrap = btn.closest('.tc');
  const turnId = wrap.dataset.turn;
  const idx = parseInt(wrap.dataset.idx, 10);
  const want = btn.dataset.action === 'tc-expand';
  setFoldedTool(turnId, idx, want);
  rerenderTurn(turnId);
});

function rerenderTurn(turnId) {
  // 重渲染整张 turn 卡片 + 调 postProcessCardCodeBlocks 保留代码块交互
  const card = document.querySelector(`.turn-card[data-turn-id="${turnId}"]`);
  if (!card || !window._sessionTurns) return;
  const turn = window._sessionTurns.get(turnId);
  if (!turn) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = renderTurnCard(turn);
  const newCard = tmp.firstElementChild;
  if (newCard) {
    if (typeof postProcessCardCodeBlocks === 'function') {
      postProcessCardCodeBlocks(newCard);
    }
    const bodyEl = newCard.querySelector('.turn-body');
    if (bodyEl && typeof wrapPathLinksInElement === 'function') wrapPathLinksInElement(bodyEl, { sessionId: card.dataset.sessionId });
    card.replaceWith(newCard);
    // Spec 3 长文本折叠：必须在 DOM 内调（replaceWith 之后），否则 scrollHeight=0
    if (typeof postProcessLongTextFold === 'function') postProcessLongTextFold(newCard);
  }
}

// === Spec 1 v0.9.0 · D4 头像 ===
function sanitizeAssetName(name) {
  // 仅允许字母数字+横线下划线,防止路径遍历
  return String(name || '').replace(/[^a-zA-Z0-9_-]/g, '');
}
function aiLogoSrc(kind) {
  // 已有 logos: claude / codex / 等。其它 kind fallback 到字母。
  // Spec 3 · W6 fix：claude-resume / gemini-resume / codex-resume / deepseek-resume / 等
  // 都共享对应 base kind 的 logo（之前 -resume 后缀漏映射 → 字母 fallback "CL"）。
  const known = ['claude','codex','gemini','deepseek','glm','gpt','kimi','qwen'];
  let k = (kind || '').toLowerCase().replace(/-resume$/, '');
  // Claude Web 复用 Claude logo（kind === 'claude-web' / 'claude-web-resume' → 都映射到 claude）
  if (k === 'claude-web') k = 'claude';
  if (k === 'codex-web') k = 'codex';
  if (k === 'codex-app') return 'assets/ai-logos/codex.svg';
  if (known.includes(k)) return `assets/ai-logos/${k}.svg`;
  return null;
}
function aiLetterFallback(kind) {
  const k = (kind || '?').toUpperCase();
  return k.length >= 2 ? k.slice(0, 2) : k + '?';
}

// === Spec 3 · W7 头部 metadata pills ===
// 给卡片头加 4 个信息 pill：🔧 工具数 / ⇡in/⇣out token / 📊 ctx% / ⏱ 耗时（user 卡片仅 📝 字数）
// model context window 用模糊匹配（实际 model id 多变如 "claude-opus-4-7[1m]"），匹配不到默认 200k。
function _modelCtxWindow(model) {
  if (!model) return 200000;
  const m = String(model).toLowerCase();
  if (m.includes('1m') || m.includes('opus-4')) return 1000000;
  if (m.includes('gemini')) return 1000000;
  if (m.includes('sonnet')) return 200000;
  if (m.includes('haiku')) return 200000;
  if (m.includes('gpt')) return 128000;
  return 200000;
}
function _fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}
function _fmtDuration(ms) {
  const s = ms / 1000;
  if (s >= 60) return (s / 60).toFixed(1) + 'min';
  return s.toFixed(1) + 's';
}
function _renderMetaPills(turn) {
  const isUser = turn.role === 'user';
  if (isUser) {
    const n = (turn.text || '').length;
    if (!n) return '';
    return `<span class="turn-meta-pills"><span class="pill">📝 ${n} 字</span></span>`;
  }
  const pills = [];
  const toolN = (turn.toolCalls && turn.toolCalls.length) || 0;
  if (toolN > 0) pills.push(`<span class="pill pill-tool">🔧 ${toolN} 工具</span>`);
  if (turn.usage && (turn.usage.input_tokens || turn.usage.output_tokens)) {
    pills.push(`<span class="pill pill-token">⇡${_fmtTokens(turn.usage.input_tokens||0)} ⇣${_fmtTokens(turn.usage.output_tokens||0)}</span>`);
  }
  if (turn.usage && turn.usage.input_tokens) {
    const win = _modelCtxWindow(turn.model);
    const pct = Math.min(100, Math.round(turn.usage.input_tokens / win * 100));
    pills.push(`<span class="pill pill-ctx">📊 ${pct}% ctx</span>`);
  }
  if (typeof turn.tsEnd === 'number' && typeof turn.ts === 'number' && turn.tsEnd > turn.ts) {
    pills.push(`<span class="pill pill-time">⏱ ${_fmtDuration(turn.tsEnd - turn.ts)}</span>`);
  }
  if (pills.length === 0) return '';
  return `<span class="turn-meta-pills">${pills.join('')}</span>`;
}

// === Spec 1 v0.9.0 · turn 卡片渲染 ===
function renderTurnCard(turn) {
  // turn = { id, role: 'user'|'assistant', text, ts, model?, kind?, slotPokemon?, toolCalls? }
  const isUser = turn.role === 'user';
  const cls = isUser ? 'turn-card user' : 'turn-card';
  const who = isUser ? '你' : (turn.model || turn.kind || 'Claude');
  const ts = turn.ts ? formatAbsoluteTime(turn.ts) : '';

  // 头像分支
  let avatarHtml;
  if (isUser) {
    // Spec 3 · W6：用户头像用皮卡丘（与 AI 群聊 slot 体系视觉一致，复用 .av-poke 黄色背景）
    avatarHtml = `<span class="turn-avatar av-poke"><img src="assets/pokemon/pikachu.png" alt="你"></span>`;
  } else if (turn.slotPokemon) {
    // AI 群聊 slot 体系
    const safe = sanitizeAssetName(turn.slotPokemon);
    if (safe) {
      avatarHtml = `<span class="turn-avatar av-poke"><img src="assets/pokemon/${safe}.png" alt="${escapeHtml(turn.slotPokemon)}"></span>`;
    } else {
      avatarHtml = `<span class="turn-avatar av-letter">${escapeHtml(aiLetterFallback(turn.kind))}</span>`;
    }
  } else {
    const logo = aiLogoSrc(turn.kind);
    avatarHtml = logo
      ? `<span class="turn-avatar av-logo"><img src="${logo}" alt="${escapeHtml(turn.kind || 'AI')}"></span>`
      : `<span class="turn-avatar av-letter">${escapeHtml(aiLetterFallback(turn.kind))}</span>`;
  }

  const rawHtml = marked.parse(normalizeMarkdownPathBreaks(turn.text), { breaks: true, gfm: true });
  const body = DOMPurify.sanitize(rawHtml, { ADD_ATTR: ['target', 'data-lang'] });
  // Spec 3 方案 E：工具簇折叠（之前每 tool 单独大块 → 信息密度极低）
  const toolHtml = renderToolCluster(turn.id || '', turn.toolCalls);

  // === Spec 2 · S8: thinking 字段 (assistant only, default collapsed) ===
  // S1 parser exposes turn.thinking as multi-block joined string (or null).
  // Render as <details> ABOVE main body — chronologically thinking precedes the answer.
  // Only attached for assistant role with non-empty string; user turns never carry thinking.
  let thinkingHtml = '';
  if (!isUser && typeof turn.thinking === 'string' && turn.thinking.length > 0) {
    const thinkingRaw = marked.parse(normalizeMarkdownPathBreaks(turn.thinking), { breaks: true, gfm: true });
    const thinkingBody = DOMPurify.sanitize(thinkingRaw, { ADD_ATTR: ['target', 'data-lang'] });
    // Long thinking (>5KB): summary shows first-200-char preview (HTML-escaped, newlines→space)
    let summaryLabel = '💭 思考过程';
    if (turn.thinking.length > 5120) {
      const previewRaw = turn.thinking.slice(0, 200).replace(/\s+/g, ' ').trim();
      summaryLabel = `💭 思考过程 (前 200 字符: ${escapeHtml(previewRaw)}…)`;
    }
    thinkingHtml = `<details class="turn-thinking">
        <summary class="turn-thinking-summary">${summaryLabel}</summary>
        <div class="turn-thinking-body">${thinkingBody}</div>
      </details>`;
  }

  return `<div class="${cls}" data-turn-id="${escapeHtml(turn.id || '')}">
    ${avatarHtml}
    <div class="turn-content">
      <div class="turn-head">
        <span class="turn-who">${escapeHtml(who)}</span>
        <span class="turn-meta">${escapeHtml(ts)}</span>
        ${_renderMetaPills(turn)}
        <div class="turn-actions">
          <button class="ta-btn" data-action="copy" title="复制">📋</button>
          ${isUser
            ? `<button class="ta-btn" data-action="resend" title="重发">↻</button>
               <button class="ta-btn" data-action="edit-resend" title="编辑重发">✏</button>`
            : `<button class="ta-btn" data-action="regen" title="重新生成">⏪</button>`}
        </div>
      </div>
      ${thinkingHtml}
      <div class="turn-body">${toolHtml}${body}</div>
    </div>
  </div>`;
}
window._renderTurnCard = renderTurnCard;

// === Spec 1 v0.9.0 · 代码块强化 (D2) ===
let _codeFoldThreshold = 30;
const _foldedCodesState = new Map();
const _bodyFoldState = new Map(); // turnId -> true(expanded) / false(folded)
const _turnRenderSigs = new Map(); // turnId -> compact content signature

function postProcessCardCodeBlocks(cardEl) {
  if (!cardEl) return;
  const blocks = cardEl.querySelectorAll('pre > code');
  blocks.forEach((code, idx) => {
    const pre = code.parentElement;
    // marked adds class="language-xx"; pull first language match
    const lang = (code.className.match(/language-(\w+)/) || [, ''])[1];
    // prism highlight (only if language plugin loaded)
    if (lang && window.Prism && Prism.languages[lang]) {
      try { code.innerHTML = Prism.highlight(code.textContent, Prism.languages[lang], lang); }
      catch {}
    }
    // wrap pre in .code-block-wrap, add Copy button + fold toggle if long
    const lines = code.textContent.split('\n').length;
    const turnId = cardEl.dataset.turnId || '';
    const codeKey = `${turnId}:code:${idx}`;
    const expanded = _foldedCodesState.has(codeKey) ? _foldedCodesState.get(codeKey) : (lines <= _codeFoldThreshold);
    const wrap = document.createElement('div');
    wrap.className = 'code-block-wrap';
    wrap.dataset.codeKey = codeKey;
    wrap.dataset.lang = lang || 'text';
    wrap.dataset.lines = lines;
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(pre);
    // Copy button
    const copyBtn = document.createElement('button');
    copyBtn.className = 'code-copy';
    copyBtn.textContent = '📋 Copy';
    copyBtn.dataset.action = 'code-copy';
    wrap.appendChild(copyBtn);
    // Fold toggle (long blocks)
    if (lines > _codeFoldThreshold && !expanded) {
      pre.style.display = 'none';
      const toggle = document.createElement('div');
      toggle.className = 'code-toggle';
      toggle.dataset.action = 'code-expand';
      toggle.textContent = `▸ 展开 ${_codeFoldThreshold} of ${lines} 行 · ${lang || 'text'}`;
      wrap.appendChild(toggle);
    } else if (lines > _codeFoldThreshold) {
      const toggle = document.createElement('div');
      toggle.className = 'code-toggle';
      toggle.dataset.action = 'code-collapse';
      toggle.textContent = `▾ 折叠 (${lines} 行)`;
      wrap.appendChild(toggle);
    }
  });
}

// === Spec 3 · 长 markdown 文本默认折叠 ===
// 在卡片插入 DOM 后调用：检测 turn-body scrollHeight 超过阈值 → 加 .body-foldable.folded
// + 插入"展开全文"按钮。必须在 mount 后调（detached 元素 scrollHeight=0）。
const _BODY_FOLD_THRESHOLD_PX = 400;
function postProcessLongTextFold(cardEl) {
  if (!cardEl) return;
  const body = cardEl.querySelector('.turn-body');
  if (!body) return;
  // 已存在折叠按钮（rerender 路径） → 跳过
  if (cardEl.querySelector('.body-fold-toggle')) return;
  if (body.scrollHeight <= _BODY_FOLD_THRESHOLD_PX) return;
  const turnId = cardEl.dataset.turnId || '';
  const expanded = turnId && _bodyFoldState.get(turnId) === true;
  body.classList.add('body-foldable');
  if (!expanded) body.classList.add('folded');
  const btn = document.createElement('div');
  btn.className = 'body-fold-toggle';
  btn.dataset.action = expanded ? 'body-collapse' : 'body-expand';
  btn.textContent = expanded ? '▴ 折叠' : '▾ 展开全文';
  body.parentElement.insertBefore(btn, body.nextSibling);
}

// 全局 click handler: 长文本展开/折叠
document.addEventListener('click', (e) => {
  const btn = e.target.closest && e.target.closest('[data-action="body-expand"], [data-action="body-collapse"]');
  if (!btn) return;
  const card = btn.closest('.turn-card');
  if (!card) return;
  const body = card.querySelector('.turn-body');
  if (!body) return;
  const turnId = card.dataset.turnId || '';
  if (btn.dataset.action === 'body-expand') {
    if (turnId) _bodyFoldState.set(turnId, true);
    body.classList.remove('folded');
    btn.dataset.action = 'body-collapse';
    btn.textContent = '▴ 折叠';
  } else {
    if (turnId) _bodyFoldState.set(turnId, false);
    body.classList.add('folded');
    btn.dataset.action = 'body-expand';
    btn.textContent = '▾ 展开全文';
  }
});

function mountTurnCard(container, turn) {
  const tmp = document.createElement('div');
  tmp.innerHTML = renderTurnCard(turn);
  const cardEl = tmp.firstElementChild;
  postProcessCardCodeBlocks(cardEl);
  // 路径识别 (T7 风险条款: 卡片内 .md / URL 必须可点击触发预览)
  const bodyEl = cardEl.querySelector('.turn-body');
  if (bodyEl && typeof wrapPathLinksInElement === 'function') wrapPathLinksInElement(bodyEl, { sessionId: activeSessionId });
  container.appendChild(cardEl);
  postProcessLongTextFold(cardEl);
  return cardEl;
}
window._mountTurnCard = mountTurnCard;

// === Spec 2 · S4: mountSessionTurnCard ===
// Mount a single Turn (from S1 parseClaudeTranscriptToTurns) as a card into #msg-overlay.
//
// Used by:
//   - S5 loadSessionHistoryToOverlay      — batch mount on session switch
//   - S6 turn-complete-event listener     — append on new assistant turn
//
// Boundary adapters / contract notes:
//   * renderTurnCard (line ~1630) accepts { id, role, text, ts, model?, kind?,
//     slotPokemon?, toolCalls? } and ignores unknown fields. S1 turns may
//     additionally carry { thinking, stopReason, usage } — those are passed
//     through harmlessly until S8 adds thinking rendering inside renderTurnCard.
//   * window._sessionTurns: spec1 stores raw `turn` objects (not wrapped),
//     because rerenderTurn (line ~1593) and getTurnFromCard (line ~1758) both
//     do `_sessionTurns.get(turnId)` and use the result as a turn directly.
//     Wrapping it in `{ sessionId, turn, element }` here would break those
//     button handlers. Instead we keep the Map shape (turnId → turn), and
//     stash sessionId on the DOM via cardEl.dataset.sessionId so future
//     per-session cleanup can find cards by sessionId without changing the
//     Map contract. The `element` is recoverable via
//     `document.querySelector('.turn-card[data-turn-id="…"]')` (used by
//     rerenderTurn already).
// 2026-05-06 道雪 重做 b54a3b6（原 fix 在 fix/card-overlay-scroll-lock 分支没合上 master）+
// Codex 多方审查补漏：chat UI 标准 scroll-respect-user 模式 — 仅当用户在底部 50px
// 容差内才自动跟随,否则尊重用户向上翻历史的意图。此 helper 守护三处:
//   (1) mountSessionTurnCard 的 opts.autoScroll(turn-complete-event 路径会传 true)
//   (2) _updateStreamingIndicator 创建"还在生成更多回复…"indicator 时
//   (3) loadSessionHistoryToOverlay 末尾的 batch scrollIntoView (Codex 发现):
//       incremental=true throttle 反复触发时不应拍底;incremental=false 切 session
//       时 container 已 innerHTML='' → helper 自然 true → 初次加载行为不退化
function _isCardOverlayAtBottom(el) {
  if (!el) return true;
  return (el.scrollHeight - el.scrollTop - el.clientHeight) < 50;
}

// optimistic user-card：用户在 floating-input 按 Enter 后立即 mount 一张 user 气泡卡。
//   不等 transcript 写盘 + 250ms throttle reload —— 后者经实测 user entry 写盘滞后 1-3s
//   （Claude CLI 等到 LLM call 启动才 append），用户视感 "气泡 5s 才出来"。
//   待真 user turn 从 transcript 解析进来时（mountSessionTurnCard 顶部的 dedup），扫一眼
//   现存 optimistic 卡片，文本匹配的删掉。turn.id 用 'pending-user-' 前缀的临时 id，
//   不进 _sessionTurns Map（不是权威 turn，避免被当作真 turn dedup-replace 链路对象）。
function mountOptimisticUserCard(sessionId, text, kind) {
  const container = document.getElementById('msg-overlay');
  if (!container) return null;
  // 移除"新会话，发首条消息"占位 placeholder（如果存在）— S5 默认会写一个
  const placeholder = container.querySelector('.msg-overlay-placeholder');
  if (placeholder) placeholder.remove();

  const optimisticId = 'pending-user-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const turn = { id: optimisticId, role: 'user', text, ts: Date.now(), kind };
  let cardEl;
  try {
    const tmp = document.createElement('div');
    tmp.innerHTML = renderTurnCard(turn);
    cardEl = tmp.firstElementChild;
  } catch (err) {
    console.warn('[mountOptimisticUserCard] renderTurnCard threw:', err);
    return null;
  }
  if (!cardEl) return null;
  cardEl.dataset.sessionId = String(sessionId || '');
  cardEl.dataset.optimistic = 'true';
  cardEl.dataset.optimisticText = text;

  // 插在 streaming-indicator 之前（与 mountSessionTurnCard 一致），保证位置正确
  const streamingTail = container.querySelector('.streaming-indicator');
  if (streamingTail) container.insertBefore(cardEl, streamingTail);
  else container.appendChild(cardEl);

  // 用户主动发了一条消息 → 一定希望看到自己刚发的气泡；不走 _wasAtBottom 守卫
  try {
    cardEl.scrollIntoView({ behavior: 'auto', block: 'end' });
  } catch {
    container.scrollTop = container.scrollHeight;
  }
  return cardEl;
}
window._mountOptimisticUserCard = mountOptimisticUserCard;

function turnRenderSignature(turn) {
  if (!turn) return '';
  const raw = JSON.stringify({
    role: turn.role || '',
    text: turn.text || '',
    thinking: turn.thinking || '',
    stopReason: turn.stopReason || '',
    durationMs: turn.durationMs || null,
    tsEnd: turn.tsEnd || null,
    toolCalls: Array.isArray(turn.toolCalls) ? turn.toolCalls : [],
    usage: turn.usage || null,
  });
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i++) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${raw.length}:${hash >>> 0}`;
}

function mountSessionTurnCard(sessionId, turn, opts = {}) {
  // 1. validate inputs
  if (!turn || !turn.id || !turn.role) {
    console.warn('[mountSessionTurnCard] invalid turn (missing id/role):', turn);
    return null;
  }
  // 2. resolve container
  const container = opts.container || document.getElementById('msg-overlay');
  if (!container) {
    console.warn('[mountSessionTurnCard] container not found (msg-overlay missing)');
    return null;
  }
  // defensive init (spec1 also does this at line ~1545, but be paranoid)
  if (!window._sessionTurns) window._sessionTurns = new Map();

  // optimistic user-card dedup：真 user turn 从 transcript 进来时，扫现存
  //   optimistic 占位卡，文本相同则删掉（让真卡片接替）。trim 比较两端容差。
  if (turn.role === 'user') {
    const sidStr = String(sessionId || '');
    const realText = (turn.text || '').trim();
    if (realText) {
      const opts2 = container.querySelectorAll('.turn-card.user[data-optimistic="true"]');
      opts2.forEach(opt => {
        if (opt.dataset.sessionId !== sidStr) return;
        const optText = (opt.dataset.optimisticText || '').trim();
        if (optText && optText === realText) {
          opt.remove();
        }
      });
    }
  }

  // dedup with in-place replace：同 turnId 已在 DOM 时，不是 skip 而是替换。
  // 原因：W5 后一个 logical turn 包含多个 raw entries，streaming 新 entry 合并进来时
  // turn.id 不变（取首条 entry uuid）但内容已变（toolCalls 多了 / text 长了 / tsEnd 变 /
  // mergedCount 增加）。skip 会让用户看不到新工具调用；replace 让卡片 in-place 更新。
  // 副作用：替换瞬间该卡片如有 hover 操作菜单会闪一下，可接受。
  const existing = container.querySelector(`.turn-card[data-turn-id="${CSS.escape(turn.id)}"]`);
  if (existing) {
    const turnForRender2 = (opts.kind && !turn.kind) ? { ...turn, kind: opts.kind } : turn;
    const prevTurn = window._sessionTurns.get(turn.id);
    const prevSig = _turnRenderSigs.get(turn.id) || turnRenderSignature(prevTurn);
    const nextSig = turnRenderSignature(turnForRender2);
    if (prevSig === nextSig) {
      window._sessionTurns.set(turn.id, turnForRender2);
      _turnRenderSigs.set(turn.id, nextSig);
      if (typeof _updateStreamingIndicator === 'function') _updateStreamingIndicator(sessionId);
      return existing;
    }
    let newCard = null;
    try {
      const tmp2 = document.createElement('div');
      tmp2.innerHTML = renderTurnCard(turnForRender2);
      newCard = tmp2.firstElementChild;
    } catch (err) {
      console.warn('[mountSessionTurnCard replace] renderTurnCard threw:', err);
      return null;
    }
    if (!newCard) return null;
    newCard.dataset.sessionId = String(sessionId || '');
    existing.replaceWith(newCard);
    if (typeof postProcessCardCodeBlocks === 'function') postProcessCardCodeBlocks(newCard);
    const bodyEl2 = newCard.querySelector('.turn-body');
    if (bodyEl2 && typeof wrapPathLinksInElement === 'function') wrapPathLinksInElement(bodyEl2, { sessionId });
    if (typeof postProcessLongTextFold === 'function') postProcessLongTextFold(newCard);
    window._sessionTurns.set(turn.id, (opts.kind && !turn.kind) ? { ...turn, kind: opts.kind } : turn);
    _turnRenderSigs.set(turn.id, nextSig);
    return newCard;
  }

  // 3. merge kind through to renderTurnCard without mutating caller's turn
  const turnForRender = (opts.kind && !turn.kind) ? { ...turn, kind: opts.kind } : turn;

  // 4. build wrapper element from HTML string
  let cardEl = null;
  try {
    const tmp = document.createElement('div');
    tmp.innerHTML = renderTurnCard(turnForRender);
    cardEl = tmp.firstElementChild;
  } catch (err) {
    console.warn('[mountSessionTurnCard] renderTurnCard threw:', err);
    return null;
  }
  if (!cardEl) {
    console.warn('[mountSessionTurnCard] renderTurnCard produced empty HTML for turn', turn.id);
    return null;
  }

  // multi-session safety: tag the DOM with sessionId for per-session cleanup
  cardEl.dataset.sessionId = String(sessionId || '');

  // 5. insert into container — Spec 3 W16：streaming indicator 必须在末尾，
  // 所以新卡插在 indicator 之前（如果存在）
  // 2026-05-06 道雪 scroll-respect-user：append 前先记录用户是否在底部,给 step 9 用
  const _wasAtBottom = _isCardOverlayAtBottom(container);
  const _streamingTail = container.querySelector('.streaming-indicator');
  if (_streamingTail) {
    container.insertBefore(cardEl, _streamingTail);
  } else {
    container.appendChild(cardEl);
  }

  // 6. post-process code blocks (Prism + Copy + folding)
  if (typeof postProcessCardCodeBlocks === 'function') {
    postProcessCardCodeBlocks(cardEl);
  }
  // 7. path link recognition (scoped to .turn-body to avoid touching meta/actions)
  const bodyEl = cardEl.querySelector('.turn-body');
  if (bodyEl && typeof wrapPathLinksInElement === 'function') {
    wrapPathLinksInElement(bodyEl, { sessionId });
  }
  // 7b. Spec 3 · 长文本默认折叠（必须在 DOM 插入后调，否则 scrollHeight=0）
  if (typeof postProcessLongTextFold === 'function') {
    postProcessLongTextFold(cardEl);
  }

  // 8. register in _sessionTurns (turnId → turn) — keep spec1 Map shape
  // Use turnForRender (kind merged) so rerenderTurn won't lose kind on fold/unfold
  window._sessionTurns.set(turn.id, turnForRender);
  _turnRenderSigs.set(turn.id, turnRenderSignature(turnForRender));

  // 9. autoScroll — 2026-05-06 道雪 scroll-respect-user:仅当用户原本在底部时才滚
  //   (向上翻历史时不打断,避免被新 turn 拍回底部)
  if (opts.autoScroll && _wasAtBottom) {
    try {
      cardEl.scrollIntoView({ behavior: 'smooth', block: 'end' });
    } catch {
      // older browsers without smooth-scroll options: fall back to plain scroll
      container.scrollTop = container.scrollHeight;
    }
  }

  // Spec 3 · W16：cardCount 变化 → indicator 文案需切（"正在思考"→"还在生成更多"）
  if (typeof _updateStreamingIndicator === 'function') _updateStreamingIndicator(sessionId);

  // 10. return cardEl
  return cardEl;
}
window._mountSessionTurnCard = mountSessionTurnCard;

function scheduleCodexHistoryRetry(sessionId, attempt = 0) {
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
    loadSessionHistoryToOverlay(sessionId, { codexRetryAttempt: attempt + 1 }).catch(err => {
      console.warn('[codex-history-retry] reload failed:', err);
    });
  }, delay);
  window._codexHistoryRetryState.set(sessionId, { timer, attempt });
}

// === Spec 2 v1.0.0 · S5 loadSessionHistoryToOverlay ===
// Load historical turns for a session and mount them as cards into #msg-overlay.
//
// Used by:
//   - showTerminal (S7) when switching to a Claude session in card view
//   - User explicit "reload history" action (future)
//
// Workflow:
//   1. Resolve container = #msg-overlay; missing → warn + bail
//   2. Clear container + clear _sessionTurns Map (multi-session safety)
//   3. Look up session via existing `sessions` Map (showTerminal pattern, line ~1080)
//   4. kind !== 'claude' (per isClaudeFamily) → friendly placeholder, skip IPC
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
    _turnRenderSigs.clear();
  } else if (!window._sessionTurns) {
    window._sessionTurns = new Map();
  }

  // helper: render a placeholder line inside the cleared container.
  // 增量模式下若需要显示 placeholder（如 IPC error）说明出了问题，仍然清掉重写。
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

  // 4. kind gate — spec 2 only supports Claude family; show placeholder for others
  const supportsCardHistory = kind && (isClaudeFamily(kind) || isCodexKind(kind));
  if (kind && !supportsCardHistory) {
    showPlaceholder(
      '卡片视图当前仅支持 Claude session — '
      + '<a href="#" data-action="switch-to-pty">切到 PTY 视图</a>'
    );
    return { mounted: 0, error: null };
  }

  const loadSeq = Date.now() + ':' + Math.random().toString(36).slice(2);
  if (!window._cardLoadSeqBySid) window._cardLoadSeqBySid = new Map();
  if (!incremental) window._cardLoadSeqBySid.set(sessionId, loadSeq);
  const isStaleLoad = () => (
    !incremental &&
    (sessionId !== activeSessionId || window._cardLoadSeqBySid.get(sessionId) !== loadSeq)
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
    showPlaceholder(
      '加载历史失败：' + msg + ' — '
      + '<a href="#" data-action="switch-to-pty">切到 PTY 视图查看终端</a>'
    );
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
        scheduleCodexHistoryRetry(sessionId, attempt);
        txt = '正在绑定 Codex 历史（resume 后通常需要几秒）';
      } else {
        txt = '加载历史失败：Codex rollout 尚未绑定或已被移动';
      }
    } else {
      txt = '加载历史失败：' + ipcError;
    }
    showPlaceholder(
      txt + ' — '
      + '<a href="#" data-action="switch-to-pty">切到 PTY 视图查看终端</a>'
    );
    return { mounted: 0, error: ipcError };
  }

  // 6b. no turns, no error → fresh session
  if (turns.length === 0) {
    if (window._codexHistoryRetryState) {
      const st = window._codexHistoryRetryState.get(sessionId);
      if (st && st.timer) { try { clearTimeout(st.timer); } catch {} }
      window._codexHistoryRetryState.delete(sessionId);
    }
    showPlaceholder(
      '新会话，发首条消息试试看 — '
      + '<a href="#" data-action="switch-to-pty">切到 PTY 视图</a>'
    );
    return { mounted: 0, error: null };
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
  if (!incremental) {
    container.innerHTML = '';
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

  // Single bottom-scroll AFTER loop (don't autoScroll per mount — N reflows = jitter)
  // — 仅当 batch 开始前用户在底部才滚(scroll-respect-user)
  if (lastCardEl && _batchWasAtBottom) {
    try {
      lastCardEl.scrollIntoView({ behavior: 'auto', block: 'end' });
    } catch {
      container.scrollTop = container.scrollHeight;
    }
  } else if (!incremental && !_batchWasAtBottom) {
    container.scrollTop = Math.min(
      overlayScrollBeforeLoad.top,
      Math.max(0, container.scrollHeight - container.clientHeight),
    );
  }

  return { mounted, error: null };
}
window._loadSessionHistoryToOverlay = loadSessionHistoryToOverlay;

ipcRenderer.on('prompt-submitted-event', (_event, payload) => {
  onPromptSubmittedFromTranscriptEvent(payload);
});

// === Spec 2 v1.0.0 · S6 turn-complete-event listener ===
// main.js (S3) broadcasts 'turn-complete-event' whenever an assistant turn
// finishes streaming. Append the just-completed turn as a card to #msg-overlay
// for the active Claude session in card view.
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

  // 1. AI 群聊 path — meeting-room.js handles its own card rendering
  if (meetingId) return;

  // 2. multi-session safety — only render for currently active session
  if (hubSessionId !== activeSessionId) return;

  // 3. only render in card view (PTY view doesn't use msg-overlay)
  if (currentView !== 'card') return;

  // 4. If overlay is in placeholder state (history failed to load earlier, e.g.
  //    ccSessionId was null when showTerminal ran), trigger full reload instead
  //    of appending a single card on top of the placeholder.
  const overlay = document.getElementById('msg-overlay');
  if (overlay && overlay.querySelector('.msg-overlay-placeholder')) {
    if (typeof loadSessionHistoryToOverlay === 'function') {
      loadSessionHistoryToOverlay(hubSessionId).catch(err => {
        console.warn('[turn-complete-event] reload after placeholder failed:', err);
      });
    }
    return;
  }

  try {
    const r = await ipcRenderer.invoke('parse-session-transcript', {
      hubSessionId,
      transcriptPath,
      opts: { limit: 1, fromTail: true },
    });

    if (r && !r.error && Array.isArray(r.turns) && r.turns.length > 0) {
      // got the structured turn from S1 parser
      const turn = r.turns[0];
      // turn-complete should always be assistant; defend against future broadcast scope changes
      if (turn.role !== 'assistant') return;
      // Dedup: skip if turn already mounted (race with loadSessionHistoryToOverlay)
      if (window._sessionTurns && window._sessionTurns.has(turn.id)) return;
      if (document.querySelector('.turn-card[data-turn-id="' + CSS.escape(turn.id) + '"]')) return;
      mountSessionTurnCard(hubSessionId, turn, { kind, autoScroll: true });
      return;
    }

    // fall through to payload-only fallback on parse error / empty
    const fallbackTurn = {
      id: 'turn-' + (completedAt || Date.now()),
      role: 'assistant',
      text: text || '',
      ts: completedAt || Date.now(),
      kind,
    };
    // Dedup: skip if turn already mounted (race with loadSessionHistoryToOverlay)
    if (window._sessionTurns && window._sessionTurns.has(fallbackTurn.id)) return;
    if (document.querySelector('.turn-card[data-turn-id="' + CSS.escape(fallbackTurn.id) + '"]')) return;
    mountSessionTurnCard(hubSessionId, fallbackTurn, { kind, autoScroll: true });
  } catch (err) {
    console.warn('[turn-complete-event] failed to render new turn:', err);
  }
});

function wrapPathLinksInElement(rootEl, opts = {}) {
  if (!rootEl) return;
  const cwd = opts.cwd || getSessionCwd(opts.sessionId || activeSessionId) || null;
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
    if (collectPathCandidates(normalizeMarkdownPathBreaks(node.nodeValue), cwd).length > 0) targets.push(node);
  }
  for (const textNode of targets) {
    const text = normalizeMarkdownPathBreaks(textNode.nodeValue);
    const candidates = collectPathCandidates(text, cwd);
    if (!candidates.length) continue;
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

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.ta-btn');
  if (!btn) return;
  const card = btn.closest('.turn-card');
  if (!card || !card.closest('.msg-overlay')) return;
  const turn = getTurnFromCard(card);
  if (!turn) return;
  const action = btn.dataset.action;

  if (action === 'copy') {
    let md = turn.text || '';
    if (Array.isArray(turn.toolCalls)) {
      for (const tc of turn.toolCalls) {
        md += `\n\n\`\`\`\n${tc.name || ''} ${tc.cmd || ''}\n${tc.stdout || ''}\n\`\`\``;
      }
    }
    navigator.clipboard.writeText(md).then(() => {
      const orig = btn.textContent;
      btn.textContent = '✓';
      setTimeout(() => { btn.textContent = orig; }, 1500);
    }).catch(() => {});
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
    // 复用 terminal-input IPC，不新增 channel
    const sid = (typeof activeSessionId !== 'undefined' && activeSessionId) || (typeof currentSessionId !== 'undefined' && currentSessionId);
    if (sid && typeof ipcRenderer !== 'undefined') {
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

// click handler — code-copy + code-expand/collapse
document.addEventListener('click', (e) => {
  const copyBtn = e.target.closest('[data-action="code-copy"]');
  if (copyBtn) {
    const code = copyBtn.parentElement.querySelector('pre code');
    if (code) {
      navigator.clipboard.writeText(code.textContent).then(() => {
        copyBtn.textContent = '✓ Copied';
        setTimeout(() => copyBtn.textContent = '📋 Copy', 1500);
      });
    }
    return;
  }
  const toggleBtn = e.target.closest('[data-action="code-expand"], [data-action="code-collapse"]');
  if (toggleBtn) {
    const wrap = toggleBtn.closest('.code-block-wrap');
    const key = wrap.dataset.codeKey;
    const want = toggleBtn.dataset.action === 'code-expand';
    _foldedCodesState.set(key, want);
    const pre = wrap.querySelector('pre');
    pre.style.display = want ? '' : 'none';
    if (want) {
      toggleBtn.dataset.action = 'code-collapse';
      toggleBtn.textContent = `▾ 折叠 (${wrap.dataset.lines} 行)`;
    } else {
      toggleBtn.dataset.action = 'code-expand';
      toggleBtn.textContent = `▸ 展开 ${_codeFoldThreshold} of ${wrap.dataset.lines} 行 · ${wrap.dataset.lang}`;
    }
  }
});

// === Spec 1 v0.9.0 · 视图切换 ===
// 默认 PTY（卡片视图作为可选第二视图，不破坏 PTY 主流程）— 2026-05-04 用户反馈
let currentView = 'pty'; // 'card' | 'pty'

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
const _CODEX_CARD_SUBMIT_PENDING_MS = 15 * 1000;
const _CODEX_CARD_WORK_MAX_MS = 45 * 60 * 1000;

function markCodexCardWorking(sessionId, source = 'prompt') {
  const session = sessions.get(sessionId);
  if (!session || !isCodexKind(session.kind) || session.status === 'dormant') return;
  if (_codexSubmitPendingTimers.has(sessionId)) {
    clearTimeout(_codexSubmitPendingTimers.get(sessionId));
    _codexSubmitPendingTimers.delete(sessionId);
  }
  session.cardWorkingSince = Date.now();
  session.cardWorkingSource = source;
  session.isWaiting = false;
  session.waitingReason = null;
  session.waitingText = null;
  session.status = 'running';
  if (typeof _updateStreamingIndicator === 'function') _updateStreamingIndicator(sessionId);
  if (source === 'floating_input') {
    const timer = setTimeout(() => {
      _codexSubmitPendingTimers.delete(sessionId);
      const latest = sessions.get(sessionId);
      if (!latest || latest.cardWorkingSource !== 'floating_input') return;
      latest.cardWorkingSince = null;
      latest.cardWorkingSource = null;
      latest.status = 'idle';
      if (typeof _updateStreamingIndicator === 'function') _updateStreamingIndicator(sessionId);
      renderSessionList();
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
}

function hasSemanticCardWorking(session) {
  if (!session) return false;
  if (!isCodexKind(session.kind) || session.isWaiting || !session.cardWorkingSince) return false;
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
  const base = isCodexKind(session.kind) ? 'Codex' : (session.kind || 'AI');
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
  document.querySelectorAll('.view-toggle-btn').forEach(b => {
    if (!b.dataset.view) return; // 跳过非视图按钮（如 #btn-compact-toggle 简洁模式独立 toggle）
    b.classList.toggle('active', b.dataset.view === mode);
  });
  // 切到 PTY 时 refit xterm
  if (mode === 'pty' && typeof terminalCache !== 'undefined') {
    const cached = terminalCache.get(activeSessionId);
    if (cached && cached.fitAddon) scheduleFitAndResizeTerminal(activeSessionId, cached, { force: true });
  }
  // Spec 3 · W3 resume bug fix (b)：切到卡片时若 overlay 没卡片（既无 turn-card 也无 placeholder），
  // 主动 trigger load — 因为 showTerminal 在切 session 时只在 currentView==='card' 才 load，
  // 默认 PTY 模式下 overlay 始终空，user 手动切到 card 时该看到历史。
  // 已有卡片或 placeholder 则不 reload（避免重复 IPC + reflow）。
  if (mode === 'card' && overlay && typeof loadSessionHistoryToOverlay === 'function' && activeSessionId) {
    const hasContent = overlay.querySelector('.turn-card, .msg-overlay-placeholder');
    if (!hasContent) {
      loadSessionHistoryToOverlay(activeSessionId).catch(err => {
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

function mountFloatingInput(sessionId, termContainer, terminal) {
  const bar = document.createElement('div');
  bar.className = 'floating-input-bar';

  const inputBox = document.createElement('div');
  inputBox.className = 'floating-input-box';
  inputBox.contentEditable = 'true';
  inputBox.setAttribute('data-placeholder', '输入消息… Enter 发送, Shift+Enter 换行');
  if (floatingInputDrafts.has(sessionId)) {
    inputBox.textContent = floatingInputDrafts.get(sessionId);
  }

  const sendBtn = document.createElement('button');
  sendBtn.className = 'floating-input-send';
  sendBtn.title = '发送 (Enter)';
  sendBtn.textContent = '▶';

  bar.append(inputBox, sendBtn);
  bar.classList.add('visible');

  const panel = termContainer.closest('.terminal-panel');
  if (panel) panel.appendChild(bar);
  else termContainer.appendChild(bar);

  // paste-sensitive TUI（claude/gemini/codex 等 9 家 AI CLI）会把紧贴到达的字符
  //   当成 paste 事件 — 紧贴的 \r 被当作 paste 内容吞掉，消息卡在输入框不提交
  //   （2026-05-10 用户反馈：按 Enter 后内容进了 shell 输入框但不发送）。
  //   修复参考 group-chat-watcher.js 1A fast-path：claude 家族用 BP marker 显式
  //   标记 paste 结束 + 500ms 间隔后单独发 \r；gemini/codex 不识别 BP，靠静默期
  //   触发 paste-detect 完成（≥400ms）；普通 shell 无 paste-detect，保持原行为。
  const BP_START = '\x1b[200~';
  const BP_END = '\x1b[201~';

  function sendInput() {
    const text = readContenteditablePlainText(inputBox);
    if (!text || !text.trim()) return;

    // 立即清 UI + scroll + 还焦给终端，让用户立刻感知"已发送"。后续异步往 PTY 写。
    inputBox.textContent = '';
    clearFloatingInputDraft(sessionId);
    terminal.scrollToBottom();
    terminal.focus();

    const session = (typeof sessions !== 'undefined' && sessions && typeof sessions.get === 'function')
      ? sessions.get(sessionId) : null;
    const kind = session && session.kind ? session.kind : null;
    clearSessionWaitingState(sessionId);
    if (isCodexKind(kind)) markCodexCardWorking(sessionId, 'floating_input');

    // optimistic user-card：卡片视图下立即弹气泡，不等 transcript 写盘 + 250ms throttle reload。
    //   2026-05-10 用户反馈：在卡片视图按 Enter 后约 5 秒才看到自己的气泡卡。根因是 user 气泡
    //   也走 transcript reload 路径，但 Claude CLI 通常等 LLM call 启动才把 user entry append
    //   到 JSONL（实测 1-3s 滞后）。聊天 app 标准做法是发出即 mount，待权威 entry 到时 dedup。
    if (currentView === 'card' && kind && (isClaudeFamily(kind) || isCodexKind(kind)) && typeof mountOptimisticUserCard === 'function') {
      try {
        mountOptimisticUserCard(sessionId, text.trim(), kind);
      } catch (err) {
        console.warn('[optimistic user-card] mount failed:', err);
      }
    }

    if (kind && isClaudeFamily(kind)) {
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
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendInput();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      terminal.focus();
    }
  });

  inputBox.addEventListener('input', () => {
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

  bar.addEventListener('click', (e) => e.stopPropagation());
  bar.addEventListener('mousedown', (e) => e.stopPropagation());

  return {
    dispose() {
      saveFloatingInputDraft(sessionId, inputBox);
      if (bar.parentNode) bar.parentNode.removeChild(bar);
    },
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
    if (trimmed && trimmed !== session.title) {
      session.userRenamed = true;
      if (session.status === 'dormant') {
        // No live PTY; just mutate locally and persist.
        session.title = trimmed;
        renderSessionList();
        schedulePersist();
      } else {
        await ipcRenderer.invoke('rename-session', { sessionId, title: trimmed, userRenamed: true });
        if (session.kind === 'claude' || session.kind === 'claude-resume') {
          syncRenameToClaude(sessionId, trimmed);
        }
      }
    }
    input.replaceWith(titleSpan);
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
function selectSession(id, opts = {}) {
  savePreviewState();
  activeMeetingId = null;
  const mrp = document.getElementById('meeting-room-panel');
  if (mrp) mrp.style.display = 'none';
  clearPreviewUI();
  const tp = document.getElementById('terminal-panel');
  if (tp) tp.style.display = '';

  const session = sessions.get(id);
  // Dormant session: clicking wakes it via resume-session IPC. Don't render
  // terminal now — session-created handler below will take over once PTY is up.
  if (session && session.status === 'dormant') {
    resumeDormantSession(id);
    return;
  }
  const switching = activeSessionId !== id;
  const cachedBeforeSelect = terminalCache.get(id);
  const requestedBottomPin = opts && opts.forceScrollBottom === true;
  const forceScrollBottom = !!(session && isCodexKind(session.kind) && (requestedBottomPin || !cachedBeforeSelect || !cachedBeforeSelect.opened));
  const shouldFocusTerminal = switching || currentView === 'pty';
  activeSessionId = id;
  if (session) {
    session.unreadCount = 0;
    session.isWaiting = false;
    session.waitingReason = null;
    session.waitingText = null;
  }
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
  restorePreviewForContext(`session:${id}`);
}

// --- Dropdown menu ---
btnNew.addEventListener('click', () => {
  menuEl.style.display = menuEl.style.display === 'none' ? 'block' : 'none';
});

document.addEventListener('mousedown', (e) => {
  if (!wrapperEl.contains(e.target)) menuEl.style.display = 'none';
  if (resumeWrapperEl && !resumeWrapperEl.contains(e.target)) resumeMenuEl.style.display = 'none';
});

for (const btn of document.querySelectorAll('.new-session-option')) {
  btn.addEventListener('click', async () => {
    menuEl.style.display = 'none';
    await ipcRenderer.invoke('create-session', btn.dataset.kind);
  });
}

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
    if (kind) ipcRenderer.invoke('create-session', kind);
  });
}

// --- Meeting buttons ---
if (btnGroupChat) {
  btnGroupChat.addEventListener('click', async () => {
    if (typeof window.openMeetingCreateModal === 'function') {
      window.openMeetingCreateModal('group');
    }
  });
}

// --- Resume past session modal ---
const resumeModalEl = document.getElementById('resume-modal');
const resumeListEl = document.getElementById('resume-list');
const resumeFilterEl = document.getElementById('resume-filter');
let resumeItems = [];

function openResumeModal() {
  resumeModalEl.style.display = 'flex';
  resumeFilterEl.value = '';
  resumeListEl.innerHTML = '<div class="modal-empty">Scanning…</div>';
  requestAnimationFrame(() => resumeFilterEl.focus());
  ipcRenderer.invoke('list-past-sessions', { limit: 50 }).then((items) => {
    resumeItems = items || [];
    renderResumeList(resumeItems);
  }).catch(() => {
    resumeListEl.innerHTML = '<div class="modal-empty">Scan failed.</div>';
  });
}

function closeResumeModal() {
  resumeModalEl.style.display = 'none';
}

// --- Create Meeting ---
// meeting-create-modal：前端创建入口统一为 AI 群聊。旧的 mode 参数只保留调用兼容，
//   不再从 UI 新建 legacy AI 群聊。Modal 在 renderer/meeting-create-modal.js，
//   提交后调 create-meeting IPC（带 slots），main.js 内部循环 add-meeting-sub +
//   持久化 slotSpecs，返回完整 meeting 对象，Modal 再调 selectMeeting(meeting.id)。
function createMeetingByMode(mode) {
  if (typeof window.openMeetingCreateModal === 'function') {
    window.openMeetingCreateModal('group');
  } else {
    console.error('[createMeetingByMode] meeting-create-modal not loaded');
  }
}

function renderResumeList(items) {
  if (!items || items.length === 0) {
    resumeListEl.innerHTML = '<div class="modal-empty">No past sessions found.</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'modal-row';
    const mtimeStr = it.mtime ? new Date(it.mtime).toLocaleString('zh-CN', { hour12: false }) : '';
    const preview = it.firstUserMessage || '(no user prompt captured)';
    const modelShort = (it.model || '').replace(/^claude-/, '').replace(/-\d+$/, '');
    row.innerHTML = `
      <div class="modal-row-main">
        <span class="modal-row-preview">${escapeHtml(preview)}</span>
      </div>
      <div class="modal-row-meta">
        <span class="modal-meta-time">${escapeHtml(mtimeStr)}</span>
        ${it.turnCount ? `<span class="modal-meta-chip">${it.turnCount}T</span>` : ''}
        ${modelShort ? `<span class="modal-meta-chip">${escapeHtml(modelShort)}</span>` : ''}
        ${it.cwd ? `<span class="modal-meta-cwd" title="${escapeHtml(it.cwd)}">${escapeHtml(it.cwd)}</span>` : ''}
      </div>
    `;
    row.addEventListener('click', async () => {
      closeResumeModal();
      await ipcRenderer.invoke('create-session', {
        kind: 'claude-resume',
        opts: { resumeCCSessionId: it.sessionId, resumeTranscriptPath: it.path || undefined, cwd: it.cwd || undefined },
      });
    });
    frag.appendChild(row);
  }
  resumeListEl.innerHTML = '';
  resumeListEl.appendChild(frag);
}

resumeFilterEl.addEventListener('input', () => {
  const q = resumeFilterEl.value.trim().toLowerCase();
  if (!q) { renderResumeList(resumeItems); return; }
  const filtered = resumeItems.filter(it => {
    const hay = ((it.firstUserMessage || '') + ' ' + (it.cwd || '') + ' ' + (it.model || '')).toLowerCase();
    return hay.includes(q);
  });
  renderResumeList(filtered);
});

document.getElementById('resume-modal-close').addEventListener('click', closeResumeModal);
resumeModalEl.addEventListener('click', (e) => {
  if (e.target === resumeModalEl) closeResumeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && resumeModalEl.style.display === 'flex') {
    e.preventDefault(); closeResumeModal();
  }
});

// --- "昨日之我" past-session full-text search (Ctrl+Shift+F) ---
const searchModalEl = document.getElementById('search-modal');
const searchQueryEl = document.getElementById('search-query');
const searchResultsEl = document.getElementById('search-results');
let searchDebounce = null;
let searchSeq = 0; // guard against out-of-order async responses

function openSearchModal() {
  searchModalEl.style.display = 'flex';
  searchQueryEl.value = '';
  searchResultsEl.innerHTML = '<div class="modal-empty">Type ≥ 2 chars to search.</div>';
  requestAnimationFrame(() => searchQueryEl.focus());
}
function closeSearchModal() { searchModalEl.style.display = 'none'; }

function highlightMatch(text, query) {
  if (!query) return escapeHtml(text);
  const ql = query.toLowerCase();
  const tl = text.toLowerCase();
  const out = [];
  let i = 0;
  while (i < text.length) {
    const hit = tl.indexOf(ql, i);
    if (hit < 0) { out.push(escapeHtml(text.slice(i))); break; }
    out.push(escapeHtml(text.slice(i, hit)));
    out.push('<mark>' + escapeHtml(text.slice(hit, hit + query.length)) + '</mark>');
    i = hit + query.length;
  }
  return out.join('');
}

function renderSearchHits(hits, query, truncated) {
  if (!hits.length) {
    searchResultsEl.innerHTML = '<div class="modal-empty">No matches.</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const h of hits) {
    const row = document.createElement('div');
    row.className = 'modal-row';
    const when = new Date(h.mtime).toLocaleString('zh-CN', { hour12: false });
    row.innerHTML = `
      <div class="modal-row-main">
        <span class="modal-row-preview">${highlightMatch(h.snippet, query)}</span>
      </div>
      <div class="modal-row-meta">
        <span class="modal-meta-time">${escapeHtml(when)}</span>
        <span class="modal-meta-chip">${h.role || '?'}</span>
        <span class="modal-meta-chip">line ${h.lineNo}</span>
      </div>
    `;
    row.title = 'Click to resume this session';
    row.addEventListener('click', async () => {
      closeSearchModal();
      await ipcRenderer.invoke('create-session', {
        kind: 'claude-resume',
        opts: { resumeCCSessionId: h.sessionId, resumeTranscriptPath: h.path || undefined },
      });
    });
    frag.appendChild(row);
  }
  searchResultsEl.innerHTML = '';
  if (truncated) {
    const note = document.createElement('div');
    note.className = 'modal-empty';
    note.style.padding = '8px 14px';
    note.style.textAlign = 'left';
    note.textContent = `Showing first ${hits.length} matches (scan truncated — refine query for more).`;
    searchResultsEl.appendChild(note);
  }
  searchResultsEl.appendChild(frag);
}

searchQueryEl.addEventListener('input', () => {
  const q = searchQueryEl.value.trim();
  if (q.length < 2) {
    searchResultsEl.innerHTML = '<div class="modal-empty">Type ≥ 2 chars to search.</div>';
    return;
  }
  if (searchDebounce) clearTimeout(searchDebounce);
  searchDebounce = setTimeout(async () => {
    const seq = ++searchSeq;
    searchResultsEl.innerHTML = '<div class="modal-empty">Searching…</div>';
    const res = await ipcRenderer.invoke('search-past-sessions', { query: q, limit: 50 });
    if (seq !== searchSeq) return; // newer query in flight
    renderSearchHits(res.hits || [], q, !!res.truncated);
  }, 300);
});

document.getElementById('search-modal-close').addEventListener('click', closeSearchModal);
searchModalEl.addEventListener('click', (e) => {
  if (e.target === searchModalEl) closeSearchModal();
});
document.addEventListener('keydown', (e) => {
  // Ctrl+Shift+F — global search
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
    e.preventDefault(); openSearchModal();
    return;
  }
  if (e.key === 'Escape' && searchModalEl.style.display === 'flex') {
    e.preventDefault(); closeSearchModal();
  }
});

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
    openPreviewPanel(raw);
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
    openPreviewPanel(fullPath);
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
// --- Terminal buffer reading and activity monitor ---
const terminalActivityMonitor = createTerminalActivityMonitor({
  sessions,
  terminalCache,
  getActiveSessionId: () => activeSessionId,
  renderSessionList,
  schedulePersist,
  updateStreamingIndicator: (sessionId) => {
    if (typeof _updateStreamingIndicator === 'function') _updateStreamingIndicator(sessionId);
  },
  hasSemanticCardWorking,
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

// Tool block folding 已废弃（2026-04-28）：之前 Claude session 的 ● tool 块下方
// 非 tool 行被改写成 "⋯ N lines" + xterm decoration 弹窗，长会话 buffer 滚动 +
// Codex/Gemini 路径不一致会渲染叠字错位。所有 kind 的 terminal-data 现在统一直写。

ipcRenderer.on('terminal-data', (_e, { sessionId, data }) => {
  const cached = terminalCache.get(sessionId);
  if (!cached) return;
  const sess = sessions.get(sessionId);
  if (sess && isCodexKind(sess.kind)) {
    const pinAfterWrite = shouldAutoPinCodexTerminal(sessionId, cached);
    let filtered = data;
    if (filtered.includes('prove documentation')) {
      filtered = filtered.replace(CODEX_PLACEHOLDER_RE, '');
    }
    cached.terminal.write(filtered);
    cached.terminal.write('\x1b[?25l');
    clearTimeout(_cursorDebounce.get(sessionId));
    _cursorDebounce.set(sessionId, setTimeout(() => {
      cached.terminal.write('\x1b[?25h');
    }, 150));
    if (pinAfterWrite) scheduleCodexBottomPin(sessionId, cached);
  } else {
    cached.terminal.write(data);
  }
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
        loadSessionHistoryToOverlay(sessionId, { incremental: true })
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
      if (sessionId === activeSessionId && currentView === 'card') {
        loadSessionHistoryToOverlay(sessionId, { incremental: true })
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
  deepseek: 'api',
  glm: 'api',
  gpt: 'api',
  kimi: 'api',
  qwen: 'api',
};
const accountUsageController = createAccountUsageController({
  document,
  window,
  ipcRenderer,
  sessions,
  escapeHtml,
  openConfigModal: () => openConfigModal(),
});
const renderAccountUsage = accountUsageController.render;
const sessionBurnRate = accountUsageController.sessionBurnRate;
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
    if (payload.sessionName && !session.userRenamed && !session.autoTitleGenerated && !session.meetingId && session.title !== payload.sessionName) {
      session.title = payload.sessionName;
      session.claudeSessionName = payload.sessionName;
      if (payload.sessionId === activeSessionId) {
        const el = terminalPanelEl.querySelector('.terminal-title');
        if (el) el.textContent = payload.sessionName;
      }
    }
    if (payload.sessionId === activeSessionId) updateActiveMetricsRow();
  }
  accountUsageController.recordStatusUsage(payload);
  renderSessionList();
});

ipcRenderer.on('agent-usage', (_e, totals) => {
  accountUsageController.recordAgentUsage(totals);
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
    a.textContent = '\uD83D\uDCC1 ' + session.cwd;
    a.title = 'Click to copy · ' + session.cwd;
    a.addEventListener('click', () => {
      try { clipboard.writeText(session.cwd); } catch {}
    });
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

// Claude Code hooks drive the session state.
// - 'prompt' (UserPromptSubmit): fires the moment user presses Enter.
//   Immediately flag the session as running — faster & more precise than
//   the 200-byte PTY heuristic.
// - 'stop' (Stop): fires when the agent loop finishes. Triggers unread/time bump.
ipcRenderer.on('hook-event', (_e, { event, sessionId, claudeSessionId, cwd, latestUserMessage }) => {
  const s = sessions.get(sessionId);
  if (s) {
    // Persist CC session id + cwd the first time we learn them so resumes work.
    if (claudeSessionId && s.ccSessionId !== claudeSessionId) {
      s.ccSessionId = claudeSessionId;
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
        renderSessionList();
        schedulePersist();
      }
    }
  }
  if (event === 'stop') {
    onReplyCompleteFromHook(sessionId);
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
  else if (event === 'prompt') onPromptSubmittedFromHook(sessionId);
});

function onPromptSubmittedFromHook(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (session.status !== 'running') {
    session.status = 'running';
    renderSessionList();
  }
}

// v0.13 · P0 #1: 跟踪窗口最近一次获得 focus 的时间，用于 onReplyCompleteFromHook
// 的 seenByUser 判断加 500ms 缓冲（alt-tab 切回瞬间 document.hasFocus() 还未更新
// 的窗口期会误判 → 错弹红点）。
let _lastWindowFocusAt = Date.now();
window.addEventListener('focus', () => { _lastWindowFocusAt = Date.now(); });

function buildReplyReadyPreview(text, fallback = 'Codex 回复完成，等你继续') {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return fallback;
  return raw.length > 120 ? raw.slice(0, 118) + '…' : raw;
}

function clearSessionWaitingState(sessionId) {
  const session = sessions.get(sessionId);
  if (!session || !session.isWaiting) return;
  session.isWaiting = false;
  session.waitingReason = null;
  session.waitingText = null;
  renderSessionList();
  schedulePersist();
}

function onReplyCompleteFromTranscriptEvent(payload) {
  const { hubSessionId, text, completedAt, meetingId, kind } = payload || {};
  if (meetingId) return;
  if (!hubSessionId) return;
  if (!isCodexKind(kind)) return;

  const session = sessions.get(hubSessionId);
  if (!session) return;
  if (session.status === 'dormant') return;

  const preview = buildReplyReadyPreview(text);
  const sig = `${completedAt || ''}:${preview}`;
  if (session._lastTranscriptReadySig === sig) return;
  session._lastTranscriptReadySig = sig;

  const wasWaiting = !!session.isWaiting;
  clearCodexCardWorking(hubSessionId);
  session.lastOutputPreview = preview;
  session.status = 'idle';
  session.isWaiting = true;
  session.waitingReason = 'reply-ready';
  session.waitingText = preview;
  session.lastMessageTime = completedAt || Date.now();
  if (typeof _updateStreamingIndicator === 'function') _updateStreamingIndicator(hubSessionId);

  const isActive = hubSessionId === activeSessionId;
  const focusOk = document.hasFocus() || (Date.now() - _lastWindowFocusAt < 500);
  const seenByUser = isActive && focusOk;
  if (!seenByUser) {
    session.unreadCount = (session.unreadCount || 0) + 1;
  }
  if (!isActive || !wasWaiting) maybeNotify(session);
  renderSessionList();
  schedulePersist();
}

function onPromptSubmittedFromTranscriptEvent(payload) {
  const { hubSessionId, text, submittedAt, meetingId, kind } = payload || {};
  if (meetingId) return;
  if (!hubSessionId) return;
  if (!isCodexKind(kind)) return;

  const session = sessions.get(hubSessionId);
  if (!session) return;
  if (session.status === 'dormant') return;

  const preview = buildPreviewFromUserMessage(text);
  const sig = `${submittedAt || ''}:${preview}`;
  if (preview && session._lastTranscriptPromptSig === sig) return;
  session._lastTranscriptPromptSig = sig;

  if (preview) {
    session.lastOutputPreview = preview;
    session._previewFromTranscript = true;
  }
  markCodexCardWorking(hubSessionId, 'rollout_user_message');
  session.lastMessageTime = submittedAt || Date.now();
  if (typeof _updateStreamingIndicator === 'function') _updateStreamingIndicator(hubSessionId);
  renderSessionList();
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

function onReplyCompleteFromHook(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (session.status === 'dormant') return;

  // v0.13 · P1 #5: Stop hook 500ms 去重窗口。CC 在 agent 子任务 / streaming
  // 抖动场景下偶尔会发两次 Stop，无去重导致 unread 计数加倍。
  const now = Date.now();
  if (session._lastStopHookTs && now - session._lastStopHookTs < 500) return;
  session._lastStopHookTs = now;

  // Fallback preview from xterm buffer — only matters when hook didn't supply
  // a transcript-sourced preview (very rare). Primary preview is written by
  // the hook-event handler directly from CC's JSONL.
  readTerminalPreview(sessionId);

  // "Claude is waiting for your input" — classify the tail of the AI's output.
  const wasWaiting = !!session.isWaiting;
  const w = isWaitingForUser(extractTailLines(sessionId, 40));
  session.isWaiting = w.waiting;
  session.waitingReason = w.waiting ? w.reason : null;
  session.waitingText = w.waiting ? String(w.text || '').slice(0, 200) : null;
  const newlyWaiting = w.waiting && !wasWaiting;

  // Stop hook IS the "AI finished replying" signal — fires once per Q&A turn.
  // Bump unread when the user hasn't actually seen the message: either this
  // session isn't the active one, OR the Hub window is unfocused (user alt-
  // tabbed away). The old check `sessionId !== activeSessionId` alone missed
  // the "focus lost, active-session reply lands, user returns with no badge"
  // case — matches the intermittent "有时候不提示" report.
  session.lastMessageTime = Date.now();
  const isActive = sessionId === activeSessionId;
  // v0.13 · P0 #1: alt-tab 切回 Hub 的 0~500ms 窗口里 hasFocus() 仍是 false，
  // 但用户明明已经在看 → 不应弹红点。用 _lastWindowFocusAt 时间戳补缓冲。
  const focusOk = document.hasFocus() || (Date.now() - _lastWindowFocusAt < 500);
  const seenByUser = isActive && focusOk;
  if (!seenByUser) {
    session.unreadCount = (session.unreadCount || 0) + 1;
  }
  // maybeNotify has its own focus guard (it returns early when focused) so
  // calling it unconditionally is safe — it handles system-notification policy.
  if (!isActive || newlyWaiting) maybeNotify(session);
  renderSessionList();
  schedulePersist();
}

// --- System notification (fire when window is in background) ---
async function maybeNotify(session) {
  try {
    if (!session || session.status === 'dormant') return;
    const focused = await ipcRenderer.invoke('is-window-focused');
    if (focused) return;
    const isW = !!session.isWaiting;
    ipcRenderer.send('show-notification', {
      title: session.title + (isW ? ' — 等你回复' : ' — reply ready'),
      body: (isW && session.waitingText) ? session.waitingText : (session.lastOutputPreview || ''),
    });
  } catch {}
}

// --- Keyboard shortcuts ---
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;

  // Ctrl+Alt+Home: emergency return to the launcher shell.
  if (!e.shiftKey && e.altKey && e.key === 'Home') {
    e.preventDefault();
    escapeToHome();
    return;
  }

  // Ctrl+N: new Claude session
  if (!e.shiftKey && !e.altKey && (e.key === 'n' || e.key === 'N')) {
    e.preventDefault();
    ipcRenderer.invoke('create-session', 'claude');
    return;
  }

  // Ctrl+W: close active session
  if (!e.shiftKey && !e.altKey && (e.key === 'w' || e.key === 'W')) {
    e.preventDefault();
    if (activeSessionId) ipcRenderer.invoke('close-session', activeSessionId);
    return;
  }

  // Ctrl+B: toggle sidebar
  if (!e.shiftKey && !e.altKey && (e.key === 'b' || e.key === 'B')) {
    e.preventDefault();
    toggleSidebar();
    return;
  }

  // Ctrl+Tab / Ctrl+Shift+Tab: cycle sessions
  if (e.key === 'Tab') {
    e.preventDefault();
    cycleSession(e.shiftKey ? -1 : 1);
    return;
  }

  // Ctrl+1..9: jump to Nth session in current sort order
  if (!e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
    e.preventDefault();
    jumpToSessionByIndex(parseInt(e.key, 10) - 1);
    return;
  }

  // Ctrl+F: terminal in-buffer search (when a terminal is active)
  if (!e.shiftKey && !e.altKey && (e.key === 'f' || e.key === 'F')) {
    e.preventDefault();
    if (activeSessionId) openTerminalSearch();
    return;
  }

  // Ctrl+Shift+C: copy selected terminal text
  if (e.shiftKey && !e.altKey && (e.key === 'c' || e.key === 'C' || e.code === 'KeyC')) {
    const cached = terminalCache.get(activeSessionId);
    const sel = cached && cached.terminal.getSelection();
    if (sel) {
      e.preventDefault();
      clipboard.writeText(sel);
    }
    return;
  }

  // Ctrl+End: jump to bottom
  if (!e.shiftKey && !e.altKey && e.key === 'End') {
    e.preventDefault();
    const c = terminalCache.get(activeSessionId);
    if (c) c.terminal.scrollToBottom();
    return;
  }
  // Ctrl+Home: jump to top
  if (!e.shiftKey && !e.altKey && e.key === 'Home') {
    e.preventDefault();
    const c = terminalCache.get(activeSessionId);
    if (c) c.terminal.scrollToTop();
    return;
  }

  // Ctrl+Up / Ctrl+Down: jump to previous/next user prompt.
  // 委派 minimap.navPrev/navNext —— 和 xterm-level keydown handler (renderer.js:~941)
  // 共用同一份跳转实现。stopPropagation 阻止后续 xterm handler 重复跳，避免双触发。
  if (!e.shiftKey && !e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    if (e.defaultPrevented) return; // xterm-level handler already handled this event
    const c = terminalCache.get(activeSessionId);
    if (!c || !c._minimap) return;
    const moved = e.key === 'ArrowUp' ? c._minimap.navPrev() : c._minimap.navNext();
    if (moved) {
      e.preventDefault();
    }
    return;
  }

  // Ctrl+Plus / Ctrl+Minus / Ctrl+0: font size
  if (!e.shiftKey && !e.altKey && (e.key === '=' || e.key === '+')) {
    e.preventDefault(); setFontSize(currentFontSize + 1); return;
  }
  if (!e.shiftKey && !e.altKey && e.key === '-') {
    e.preventDefault(); setFontSize(currentFontSize - 1); return;
  }
  if (!e.shiftKey && !e.altKey && e.key === '0') {
    e.preventDefault(); setFontSize(16); return;
  }
}, true);

function getSortedVisibleSessionIds() {
  // Same sort as renderSessionList so Ctrl+N maps to what user sees.
  const all = Array.from(sessions.values());
  return all
    .sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      return b.lastMessageTime - a.lastMessageTime || b.createdAt - a.createdAt;
    })
    .map(s => s.id);
}

function cycleSession(direction) {
  const ids = getSortedVisibleSessionIds();
  if (ids.length === 0) return;
  const i = Math.max(0, ids.indexOf(activeSessionId));
  const next = (i + direction + ids.length) % ids.length;
  selectSession(ids[next]);
}

function jumpToSessionByIndex(idx) {
  const ids = getSortedVisibleSessionIds();
  if (idx < 0 || idx >= ids.length) return;
  selectSession(ids[idx]);
}

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
  renderSessionList,
  schedulePersist,
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
// 简洁模式启动时强制折叠 sidebar（不污染 SIDEBAR_KEY 用户偏好）
if (compactMode) applySidebarCollapsed(true);
function toggleSidebar() {
  const next = !appContainerEl.classList.contains('sidebar-collapsed');
  localStorage.setItem(SIDEBAR_KEY, next ? '1' : '0');
  applySidebarCollapsed(next);
}
btnExpandEl.addEventListener('click', toggleSidebar);

function hideEscapeOverlayTargets() {
  for (const el of [
    menuEl,
    resumeMenuEl,
    contextMenuEl,
    termCtxMenuEl,
    document.getElementById('options-menu'),
    document.getElementById('theme-picker-popup'),
  ]) {
    if (el) el.style.display = 'none';
  }

  for (const id of ['resume-modal', 'search-modal']) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }

  for (const el of document.querySelectorAll('.config-modal-overlay, .pair-modal-overlay, .meeting-create-modal-overlay')) {
    el.classList.add('hidden');
  }

  if (typeof closeTerminalSearch === 'function') closeTerminalSearch();
}

function restoreLauncherShell() {
  for (const [, cached] of terminalCache) {
    if (cached && cached.container) cached.container.style.display = 'none';
  }

  preserveAndClearTerminalPanel();
  if (emptyStateEl) {
    emptyStateEl.style.display = '';
    terminalPanelEl.insertBefore(emptyStateEl, terminalPanelEl.firstChild);
  }

  const overlay = document.getElementById('msg-overlay');
  if (overlay) {
    overlay.innerHTML = '';
    overlay.classList.add('hidden');
  }

  terminalPanelEl.style.display = '';
  if (typeof applyViewMode === 'function') applyViewMode('pty');
}

function escapeToHome() {
  try { hideEscapeOverlayTargets(); } catch (err) { console.warn('[escape-home] hide overlays failed:', err); }
  try { if (typeof closePreviewPanel === 'function') closePreviewPanel(); } catch (err) { console.warn('[escape-home] close preview failed:', err); }
  try { if (typeof MeetingRoom !== 'undefined') MeetingRoom.closeMeetingPanel(); } catch (err) { console.warn('[escape-home] close meeting failed:', err); }

  activeSessionId = null;
  activeMeetingId = null;
  applySidebarCollapsed(false);
  restoreLauncherShell();
  renderSessionList();
}

const hubEscapeHomeBtn = document.getElementById('hub-escape-home');
if (hubEscapeHomeBtn) hubEscapeHomeBtn.addEventListener('click', escapeToHome);
// 2026-05-16 道雪：外部 HTTP 救援入口 — main.js POST /api/escape-home 通过这个 IPC 触发
ipcRenderer.on('escape-home', escapeToHome);

const { createConfigModalController } = require('./config-modal.js');
const configModal = createConfigModalController({ document, ipcRenderer, providerModes, renderAccountUsage });
const openConfigModal = configModal.open;
const setCodexProfileForm = configModal.setCodexProfileForm;

const themeController = createThemeController({
  document,
  localStorage,
  terminalCache,
  openConfigModal,
});
const applyTheme = themeController.applyTheme;

if (typeof MeetingRoom !== 'undefined') {
  MeetingRoom.init(sessions, getOrCreateTerminal);
}

ipcRenderer.on('session-created', (_e, { session }) => {
  // When resuming a dormant session, the hubId matches an existing dormant
  // entry. Merge live PTY info on top of the dormant metadata so title /
  // preview / unread / pinned aren't wiped.
  const existing = sessions.get(session.id);
  const wasDormant = existing && existing.status === 'dormant';
  if (wasDormant) {
    sessions.set(session.id, {
      ...existing,
      ...session,
      status: 'idle',
      // preserve persisted UX state
      pinned: existing.pinned,
      ccSessionId: existing.ccSessionId || session.ccSessionId,
      transcriptPath: existing.transcriptPath || session.transcriptPath,
      lastOutputPreview: existing.lastOutputPreview,
    });
  } else {
    sessions.set(session.id, session);
  }
  // Sub-sessions belonging to a meeting: add to sessions Map and, if the
  // meeting room is currently showing this meeting, mount the xterm for
  // any slot that was dormant (dormant slots skip xterm creation).
  if (session.meetingId) {
    // Pre-create the xterm instance so PTY 'terminal-data' events arriving
    // before renderTerminals() (which runs only after add-meeting-sub IPC
    // returns) land in the xterm buffer instead of being silent-dropped at
    // the terminal-data handler's `if (!cached) return`. Was most visible on
    // Claude — short startup output → permanent blank PowerShell box in the
    // meeting room. Gemini/Codex masked the bug via continuous streaming.
    getOrCreateTerminal(session.id);
    if (wasDormant && typeof MeetingRoom !== 'undefined' &&
        MeetingRoom.getActiveMeetingId() === session.meetingId) {
      MeetingRoom.mountSubTerminal(session.id);
    }
    renderSessionList();
    return;
  }
  activeSessionId = session.id;
  activeMeetingId = null;
  const mrp = document.getElementById('meeting-room-panel');
  if (mrp) mrp.style.display = 'none';
  if (terminalPanelEl) terminalPanelEl.style.display = '';
  ipcRenderer.send('focus-session', { sessionId: session.id });
  renderSessionList();
  // 新建 session 默认进 PTY；dormant resume 保留用户当前视图，避免卡片视图被唤醒流程打断。
  applyViewMode(wasDormant ? currentView : 'pty');
  showTerminal(session.id);
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
  if (ev.codexAppThreadId) s.codexAppThreadId = ev.codexAppThreadId;
  if (ev.codexSessionsRoot) s.codexSessionsRoot = ev.codexSessionsRoot;
  if (ev.codexAllowMtimeFallback) s.codexAllowMtimeFallback = true;
  if (ev.geminiChatId) s.geminiChatId = ev.geminiChatId;
  if (ev.geminiProjectHash) s.geminiProjectHash = ev.geminiProjectHash;
  if (ev.geminiProjectRoot) s.geminiProjectRoot = ev.geminiProjectRoot;
  if (ev.ccSessionId || ev.transcriptPath || ev.codexSid || ev.codexAppThreadId || ev.codexSessionsRoot || ev.codexAllowMtimeFallback || ev.geminiChatId || ev.geminiProjectHash || ev.geminiProjectRoot) {
    schedulePersist();
  }
  if (ev.hubSessionId === activeSessionId && currentView === 'card' && typeof loadSessionHistoryToOverlay === 'function') {
    loadSessionHistoryToOverlay(ev.hubSessionId).catch(err => {
      console.warn('[session-meta-updated] card reload failed:', err);
    });
  }
});

// Spec 3 · W13：清理 _cardReloadState 的 session 条目，防 Map 长期累积。
// session-closed 触发，确保即使 inProgress 异常残留也不影响新生命周期同 sessionId 的 session。
ipcRenderer.on('session-closed', (_e, { sessionId }) => {
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
  const cached = terminalCache.get(sessionId);
  if (cached) {
    if (cached._ro) cached._ro.disconnect();
    if (cached._resizeHandler) window.removeEventListener('resize', cached._resizeHandler);
    // Minimap holds xterm.onScroll/onRender subscriptions — must dispose before
    // terminal.dispose() so it can cleanly unhook rather than leak listeners.
    if (cached._minimap) { try { cached._minimap.dispose(); } catch {} cached._minimap = null; }
    if (cached._navButtons) { try { cached._navButtons.dispose(); } catch {} cached._navButtons = null; }
    if (cached._floatingInput) { try { cached._floatingInput.dispose(); } catch {} cached._floatingInput = null; }
    cached.terminal.dispose();
    cached.container.remove();
    terminalCache.delete(sessionId);
  }
  if (activeSessionId === sessionId) {
    activeSessionId = null;
    preserveAndClearTerminalPanel();
    terminalPanelEl.appendChild(emptyStateEl);
    emptyStateEl.style.display = '';
  }
  renderSessionList();
});

ipcRenderer.on('session-updated', (_e, { session }) => {
  if (!sessions.has(session.id)) return;
  const local = sessions.get(session.id);
  // Merge server updates but keep local preview/status (managed by renderer)
  if (!local.userRenamed && session.title) local.title = session.title;
  if (session.ccSessionId) local.ccSessionId = session.ccSessionId;
  if (session.transcriptPath) local.transcriptPath = session.transcriptPath;
  if (session.codexAppThreadId) local.codexAppThreadId = session.codexAppThreadId;
  if (session.codexSessionsRoot) local.codexSessionsRoot = session.codexSessionsRoot;
  if (session.codexAllowMtimeFallback) local.codexAllowMtimeFallback = true;
  if (session.userRenamed) local.userRenamed = true;
  if (session.autoTitleGenerated) local.autoTitleGenerated = true;
  if (typeof session.contextPct === 'number') local.contextPct = session.contextPct;
  if (typeof session.contextUsed === 'number') local.contextUsed = session.contextUsed;
  if (typeof session.contextMax === 'number') local.contextMax = session.contextMax;
  renderSessionList();
});

// --- Session persistence (dormant restore) ---
// Only Claude sessions persist across app restarts. PowerShell sessions are
// ephemeral by nature. Dormant sessions are rendered with status='dormant'
// and no PTY; clicking them spawns `claude --resume <ccSessionId>`.
let persistDebounceTimer = null;
function schedulePersist() {
  if (persistDebounceTimer) clearTimeout(persistDebounceTimer);
  persistDebounceTimer = setTimeout(() => {
    const list = [];
    for (const s of sessions.values()) {
      // 持久化白名单：AI 群聊会议 + 所有 AI kind（含 -resume 变体）。新增 AI 由 ai-kinds.js 单一真理源覆盖。
      if (!s.meetingId && !isAiKind(s.kind) && s.kind !== 'codex-app' && s.kind !== 'claude-resume' && !(typeof s.kind === 'string' && s.kind.endsWith('-resume'))) continue;
      list.push({
        hubId: s.id,
        title: s.title,
        kind: s.kind,
        cwd: s.cwd || null,
        pinned: !!s.pinned,
        ccSessionId: s.ccSessionId || null,
        transcriptPath: s.transcriptPath || null,
        meetingId: s.meetingId || null,
        lastMessageTime: s.lastMessageTime || Date.now(),
        lastOutputPreview: s.lastOutputPreview || '',
        unreadCount: s.unreadCount || 0,
        currentModel: s.currentModel || null,
        contextPct: typeof s.contextPct === 'number' ? s.contextPct : null,
        contextUsed: typeof s.contextUsed === 'number' ? s.contextUsed : null,
        contextMax: typeof s.contextMax === 'number' ? s.contextMax : null,
        userRenamed: !!s.userRenamed,
        autoTitleGenerated: !!s.autoTitleGenerated,
        // T10: include resume-meta in persist payload so main.js merge has the latest
        codexSid: s.codexSid || null,
        codexAppThreadId: s.codexAppThreadId || null,
        codexSessionsRoot: s.codexSessionsRoot || null,
        codexAllowMtimeFallback: !!s.codexAllowMtimeFallback,
        codexProfile: s.codexProfile || null,
        codexProfileLabel: s.codexProfileLabel || null,
        geminiChatId: s.geminiChatId || null,
        geminiProjectHash: s.geminiProjectHash || null,
        geminiProjectRoot: s.geminiProjectRoot || null,
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
      pinned: m.pinned || false, lastScene: m.lastScene || null,
      scene: m.scene, mode: m.mode,
      userRenamed: !!m.userRenamed,
      autoTitlePending: !!m.autoTitlePending,
      autoTitleGenerated: !!m.autoTitleGenerated,
      participants: Array.isArray(m.participants) ? m.participants : null,
      slotSpecs: Array.isArray(m.slotSpecs) ? m.slotSpecs : null,
      covenantText: m.covenantText || '',
    }));
    ipcRenderer.send('persist-sessions', list, meetingList);
  }, 400);
}

// Wake a dormant session: call main to spawn PTY with --resume, then wait for
// session-created which will replace the dormant entry.
async function resumeDormantSession(hubId) {
  const dormant = sessions.get(hubId);
  if (!dormant || dormant.status !== 'dormant') return;
  // Keep title / pinned / preview so UI stays stable through the resume.
  await ipcRenderer.invoke('resume-session', {
    hubId,
    kind: dormant.kind,
    title: dormant.title,
    cwd: dormant.cwd,
    ccSessionId: dormant.ccSessionId,
    transcriptPath: dormant.transcriptPath,
    meetingId: dormant.meetingId || null,
    lastMessageTime: dormant.lastMessageTime,
    lastOutputPreview: dormant.lastOutputPreview,
    // 把原 session 的 model 透传给 main.js → session-manager createSession 的 opts.model，
    // 避免 spawn `claude --resume` 时回退到默认 opus，丢失原 session 实际使用的 model。
    model: (dormant.currentModel && dormant.currentModel.id) || null,
    // T10: pass resume-meta so main.js Codex/Gemini precise resume works
    codexSid: dormant.codexSid || null,
    codexSessionsRoot: dormant.codexSessionsRoot || null,
    codexAllowMtimeFallback: !!dormant.codexAllowMtimeFallback,
    codexProfile: dormant.codexProfile || null,
    geminiChatId: dormant.geminiChatId || null,
    geminiProjectHash: dormant.geminiProjectHash || null,
    geminiProjectRoot: dormant.geminiProjectRoot || null,
    autoTitleGenerated: !!dormant.autoTitleGenerated,
  });
  // v0.13 · P0 #2: 不再反向清零 dormant 累积的 unread。睡前积压的对话用户还
  // 没看 → 应保留红点直到用户真正点击进入（selectSession 会清零）。原代码会
  // 让"睡前 N 条新消息"在 resume 瞬间静默丢失。
  const s = sessions.get(hubId);
  if (s) renderSessionList();
}

// --- Init ---
(async () => {
  traceRendererStartup('init ipc start');
  const [existing, persisted, dormantMeetings] = await Promise.all([
    ipcRenderer.invoke('get-sessions').catch(() => []),
    ipcRenderer.invoke('get-dormant-sessions').catch(() => null),
    ipcRenderer.invoke('get-dormant-meetings').catch(() => null),
  ]);
  traceRendererStartup(`init ipc done existing=${existing.length} persisted=${persisted && Array.isArray(persisted.sessions) ? persisted.sessions.length : 0} meetings=${Array.isArray(dormantMeetings) ? dormantMeetings.length : 0}`);

  for (const s of existing) sessions.set(s.id, s);

  if (persisted && Array.isArray(persisted.sessions)) {
    for (const meta of persisted.sessions) {
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
        title: meta.title || 'Claude',
        status: 'dormant',
        lastMessageTime: meta.lastMessageTime || Date.now(),
        lastOutputPreview: meta.lastOutputPreview || '',
        unreadCount: meta.unreadCount || 0,
        createdAt: meta.lastMessageTime || Date.now(),
        cwd: meta.cwd || null,
        pinned: !!meta.pinned,
        ccSessionId: meta.ccSessionId || null,
        transcriptPath: meta.transcriptPath || null,
        meetingId: meta.meetingId || null,
        currentModel: resolvedModel,
        contextPct: typeof meta.contextPct === 'number' ? meta.contextPct : null,
        contextUsed: typeof meta.contextUsed === 'number' ? meta.contextUsed : null,
        contextMax: typeof meta.contextMax === 'number' ? meta.contextMax : null,
        userRenamed: !!meta.userRenamed,
        autoTitleGenerated: !!meta.autoTitleGenerated,
        // T10: preserve resume-meta for precise resume (codex/gemini)
        codexSid: meta.codexSid || null,
        codexAppThreadId: meta.codexAppThreadId || null,
        codexSessionsRoot: meta.codexSessionsRoot || null,
        codexAllowMtimeFallback: !!meta.codexAllowMtimeFallback,
        codexProfile: meta.codexProfile || null,
        codexProfileLabel: meta.codexProfileLabel || null,
        geminiChatId: meta.geminiChatId || null,
        geminiProjectHash: meta.geminiProjectHash || null,
        geminiProjectRoot: meta.geminiProjectRoot || null,
      });
    }
  }

  if (Array.isArray(dormantMeetings)) {
    for (const m of dormantMeetings) {
      if (m.layout === 'split') m.layout = 'focus';
      meetings[m.id] = m;
    }
  }

  traceRendererStartup('renderSessionList start');
  renderSessionList();
  traceRendererStartup('renderSessionList done');
  ipcRenderer.send('renderer-sidebar-ready');
  traceRendererStartup('renderer-sidebar-ready sent');

  ipcRenderer.invoke('get-hub-config-raw').then((cfg) => {
    if (!cfg) return;
    providerModes.codex = cfg.codexBackend === 'api' ? 'api' : 'subscription';
    setCodexProfileForm(cfg.codexSubscriptionProfiles, cfg.codexSubscriptionProfile);
    if (typeof cfg.uiToolFoldThreshold === 'number' && !isNaN(cfg.uiToolFoldThreshold)) _toolFoldThreshold = cfg.uiToolFoldThreshold;
    if (typeof cfg.uiCodeFoldThreshold === 'number' && !isNaN(cfg.uiCodeFoldThreshold)) _codeFoldThreshold = cfg.uiCodeFoldThreshold;
    // 不在这里调 renderAccountUsage —— packyAccountData 还没从 cache 加载完成,
    // 提前渲染会出现一帧"未接入"假象(get-usage-cache 慢于本 promise resolve)。
    // 余额/用量行的渲染统一交给下面的 cache promise。
    traceRendererStartup('hub config loaded');
  }).catch(() => {});

  ipcRenderer.invoke('get-usage-cache').then((cached) => {
    accountUsageController.applyUsageCache(cached);
    traceRendererStartup('usage cache loaded');
  }).catch(() => { renderAccountUsage(); });
  applyViewMode('pty');
})();

// Persist on relevant changes — listen at renderer-level for mutations that
// touch persistable fields. Debounced.
for (const ch of ['session-created', 'session-closed', 'session-updated', 'meeting-created', 'meeting-updated', 'meeting-closed']) {
  ipcRenderer.on(ch, () => schedulePersist());
}

// --- Meeting Room IPC events ---
ipcRenderer.on('meeting-created', (_e, { meeting }) => {
  meetings[meeting.id] = meeting;
  // 2026-05-05 道雪：新 AI 群聊默认折叠（白名单未命中=折叠）。折叠态侧边栏已显示 3 个迷你
  //   slot 头像跳转按钮，用户能直接点头像进 sub session，不必展开看 slot 列表。
  renderSessionList();
});

ipcRenderer.on('meeting-updated', (_e, { meeting }) => {
  meetings[meeting.id] = meeting;
  if (typeof MeetingRoom !== 'undefined') {
    MeetingRoom.updateMeetingData(meeting.id, meeting);
  }
  renderSessionList();
});

// 2026-05-05 道雪 修3：AI 群聊 turn-complete IPC → 非 active AI 群聊累加 unread，
//   触发侧栏 has-unread 视觉提醒（unread-badge "⏸ 等你" + slot 1 边框）。
//   active AI 群聊不累加（用户正在看，不需要打扰）。
//   同 IPC 在 meeting-room.js 里也有监听器（cache 同步 + DOM 重渲），与本监听器职责正交。
ipcRenderer.on('groupchat-turn-complete', (_event, { meetingId }) => {
  if (!meetingId || meetingId === activeMeetingId) return;
  const meeting = meetings[meetingId];
  if (!meeting) return;
  meeting.unreadCount = (meeting.unreadCount || 0) + 1;
  meeting.lastMessageTime = Date.now();  // 触发排序（最新答完的 AI 群聊靠前）
  renderSessionList();
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
  }
  renderSessionList();
});
