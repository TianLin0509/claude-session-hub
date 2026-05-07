const { ipcRenderer, clipboard, nativeImage, shell, webFrame } = require('electron');
const { isClaudeFamily, isAiKind } = require('../core/ai-kinds.js');
const { formatAbsoluteTime } = require('./format-time.js');
const { marked } = require('marked');
const DOMPurify = require('dompurify');
const RENDER_STARTUP_TRACE = process.env.HUB_STARTUP_TRACE === '1';
const RENDER_STARTUP_T0 = performance.now();
function traceRendererStartup(msg) {
  if (!RENDER_STARTUP_TRACE) return;
  console.log(`[renderer-startup +${Math.round(performance.now() - RENDER_STARTUP_T0)}ms] ${msg}`);
}
traceRendererStartup('renderer.js start');
const { Terminal } = require('@xterm/xterm');

// --- Wheel/scroll diagnostic logger (DEBUG ONLY) ---
// Toggle in DevTools: __scrollDebug.on() / .off() / .read(20)
// Writes a JSON-ish line to scroll-debug.log on each tagged event.
window.__scrollDebug = (() => {
  const fs = require('fs');
  const pathMod = require('path');
  const LOG = pathMod.join(__dirname, '..', 'scroll-debug.log');
  let enabled = false;
  function snap(terminal, sessionId) {
    if (!terminal) return null;
    const buf = terminal.buffer.active;
    const out = {
      sid: sessionId ? sessionId.slice(0, 6) : '?',
      bufLen: buf.length, baseY: buf.baseY, vpY: buf.viewportY,
      cols: terminal.cols, rows: terminal.rows,
    };
    try {
      const vpEl = terminal.element && terminal.element.querySelector('.xterm-viewport');
      if (vpEl) {
        out.scrollH = vpEl.scrollHeight;
        out.scrollT = vpEl.scrollTop;
        out.clientH = vpEl.clientHeight;
        out.canScrollMore = vpEl.scrollHeight - vpEl.scrollTop - vpEl.clientHeight;
      }
      const vpInst = terminal._core && terminal._core._viewport;
      if (vpInst) {
        out.lastBufLen = vpInst._lastRecordedBufferLength;
        out.hasInnerRefresh = typeof vpInst._innerRefresh === 'function';
        out.hasQueueRefresh = typeof vpInst.queueRefresh === 'function';
        if (vpInst._lastRecordedViewportHeight !== undefined) {
          out.lastVpH = vpInst._lastRecordedViewportHeight;
        }
      }
    } catch (e) { out.err = String(e); }
    return out;
  }
  function log(tag, payload) {
    if (!enabled) return;
    try {
      const t = new Date().toISOString().slice(11, 23);
      fs.appendFileSync(LOG, `[${t}] ${tag} ${JSON.stringify(payload)}\n`);
    } catch {}
  }
  function probe(terminal, sessionId) {
    if (!terminal) return;
    try {
      const core = terminal._core || {};
      const out = {
        sid: sessionId ? sessionId.slice(0, 6) : '?',
        coreKeys: Object.keys(core).slice(0, 100),
        publicMethods: ['refresh','resize','scrollToBottom','scrollLines','scrollToLine','reset','clear'].filter(m => typeof terminal[m] === 'function'),
      };
      const candidates = ['_viewport','viewport','_renderService','_inputHandler','_bufferService','_renderer'];
      out.coreSubKeys = {};
      for (const k of candidates) {
        if (core[k]) {
          out.coreSubKeys[k] = Object.keys(core[k]).filter(x => /refresh|scroll|update|recompute|resize|inner/i.test(x)).slice(0, 30);
        }
      }
      const el = terminal.element;
      if (el) {
        out.elClasses = el.className;
        out.children = Array.from(el.children).map(c => c.className || c.tagName);
        const vp = el.querySelector('.xterm-viewport');
        if (vp) {
          out.vpChildren = Array.from(vp.children).map(c => `${c.tagName}.${c.className}(h=${c.clientHeight})`);
        }
      }
      fs.appendFileSync(LOG, `[PROBE] ${JSON.stringify(out, null, 2)}\n`);
      console.log('[scrollDebug] probe written to log');
    } catch (e) {
      fs.appendFileSync(LOG, `[PROBE-ERR] ${String(e)}\n`);
    }
  }
  return {
    on() {
      enabled = true;
      try { fs.writeFileSync(LOG, ''); } catch {}
      console.log('[scrollDebug] ON, log:', LOG);
    },
    off() { enabled = false; console.log('[scrollDebug] OFF'); },
    log, snap, probe,
    isOn() { return enabled; },
    path: LOG,
  };
})();

const { FitAddon } = require('@xterm/addon-fit');
const { Unicode11Addon } = require('@xterm/addon-unicode11');
const { SearchAddon } = require('@xterm/addon-search');
const { WebLinksAddon } = require('@xterm/addon-web-links');
const { WebglAddon } = require('@xterm/addon-webgl');
const { CanvasAddon } = require('@xterm/addon-canvas');

// --- Shared regex patterns ---
// One source of truth for UI-parsing heuristics. When Claude Code changes its
// TUI (prompt glyph, box chars, marker emoji) or we add a new file type, fix
// it here and every caller picks it up.
//
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
// Absolute path ending in a 1-8 char alnum extension. Accepts: Windows drive
// (C:\... or C:/...), UNC (\\server\share\...), home (~/... or ~\...). Pure
// POSIX (/foo) intentionally excluded — too many false positives in CC's
// markdown output (URL fragments, code, comments). /g so callers can iterate
// with exec(); reset lastIndex before each loop to avoid state leakage.
const ABS_PATH_RE = /(?:[A-Za-z]:[\\/]|\\\\[^\\/:*?"<>|\r\n\s]+\\|~[\\/])(?:[^\\/:*?"<>|\r\n\s]+[\\/])*[^\\/:*?"<>|\r\n\s]+\.[A-Za-z0-9]{1,8}(?![A-Za-z0-9])/g;
// Relative path: must contain at least one separator (segments + ext).
// Optional ./ or ../ prefix. Pure filenames like "renderer.js" intentionally
// excluded — signal too weak, would noise-match every code identifier.
// Will also match the tail of an absolute path; caller must dedupe by range.
// Each REL match must be fs.existsSync()-validated against session.cwd before
// being shown as clickable, since "docs/x.md" in prose is often not a real
// file reference.
const REL_PATH_RE = /(?:\.{1,2}[\\/])?(?:[^\\/:*?"<>|\r\n\s]+[\\/])+[^\\/:*?"<>|\r\n\s]+\.[A-Za-z0-9]{1,8}(?![A-Za-z0-9])/g;
// http(s) URL with optional port. Permissive on host so localhost:port (which
// xterm's WebLinksAddon misses — its regex requires a path-char terminator,
// excluding port-digit endings) gets caught here. Trailing prose punctuation
// (".,;:!?)]") is trimmed by the caller after match.
const URL_RE = /\bhttps?:\/\/[\w\-.~]+(?::\d+)?(?:[\/?#][^\s<>"'`\\]*)?/g;
// Image-only subset (for hover-preview tooltip). Kept absolute-only — hover
// preview reads files via file:// directly, no cwd context available here.
const IMAGE_PATH_RE = /[A-Za-z]:[\\/](?:[^\\/:*?"<>|\r\n\s]+[\\/])*[^\\/:*?"<>|\r\n\s]+\.(?:png|jpe?g|gif|webp|bmp)(?![A-Za-z0-9])/gi;
const PREVIEW_PATH_RE = /\.(?:html?|md|markdown|png|jpe?g|gif|webp|bmp|svg|pdf|csv|tsv|json|jsonl|js|ts|jsx|tsx|mjs|cjs|py|go|rs|java|c|cpp|h|hpp|cs|txt|log|ya?ml|toml|ini|cfg|conf|sh|bat|ps1|xml|sql|r|rb|php|swift|kt|lua|zig|asm|css|scss|less)$/i;
// Our own clipboard-image directory. Stripped from sidebar preview: paste
// injects the path before the user's typed text and would otherwise eat the
// entire 60-char preview.
const HUB_IMG_PATH_RE = /(?:[A-Za-z]:)?[\\/][^\s]*[\\/]\.claude-session-hub[\\/]images[\\/][^\s]+?\.(?:png|jpe?g|gif|webp|bmp)/gi;

// --- Paste support (text + image) ---
// Attached per-terminal via attachCustomKeyEventHandler in getOrCreateTerminal.
// Fires only when the xterm has focus. We intercept ALL Ctrl+V, not just image
// pastes, because Chromium's native Ctrl+V on xterm's hidden helper textarea
// does NOT fire a paste event in Electron — if we let xterm handle the default,
// nothing happens. So we read the clipboard ourselves and call terminal.paste().
async function handlePasteForSession(sessionId) {
  const cached = terminalCache.get(sessionId);
  if (!cached) return;

  const img = clipboard.readImage();
  if (!img.isEmpty()) {
    const filePath = await ipcRenderer.invoke('save-clipboard-image');
    if (filePath) cached.terminal.paste(filePath);
    return;
  }

  const text = clipboard.readText();
  if (text) cached.terminal.paste(text);
}

// 卡片优化（2026-05-03 道雪）：自定义输入框（contenteditable div）粘贴图片支持。
//   xterm 的 paste handler 不能用（xterm.paste 是 xterm-only API）。这里给
//   普通 session 浮动输入框 / 圆桌输入框等 contenteditable 元素用：
//   1. 监听 'paste' 事件（contenteditable 默认会 fire，与 xterm 不同）
//   2. 检测剪贴板有图片 → 调 save-clipboard-image IPC 拿绝对路径
//   3. 用 execCommand('insertText', path) 在 caret 位置插入路径文字
//      （execCommand 比 selection.insertNode 更稳：自动处理 caret/undo stack/IME）
//   4. 文本粘贴走浏览器默认（不 preventDefault）
// 暴露为 window.attachContenteditablePasteImage 供 meeting-room.js IIFE 使用。
function attachContenteditablePasteImage(inputEl) {
  if (!inputEl || inputEl.dataset.imgPasteBound === '1') return;
  inputEl.dataset.imgPasteBound = '1';
  inputEl.addEventListener('paste', async (e) => {
    // 优先看事件携带的 clipboardData（同步），其次 fallback 到 Electron clipboard
    const cd = e.clipboardData;
    let hasImage = false;
    if (cd && cd.items) {
      for (const it of cd.items) {
        if (it.kind === 'file' && /^image\//.test(it.type)) { hasImage = true; break; }
      }
    }
    if (!hasImage) {
      const img = clipboard.readImage();
      if (img && !img.isEmpty()) hasImage = true;
    }
    if (!hasImage) return; // 纯文本粘贴走浏览器默认
    e.preventDefault();
    try {
      const filePath = await ipcRenderer.invoke('save-clipboard-image');
      if (!filePath) return;
      // 在 caret 位置插入路径文本（保持 selection / 维护 undo stack）
      // execCommand 在 contenteditable 里仍然可用（虽然标记 deprecated，浏览器仍支持
      // 且对 Electron renderer 是稳定 API，与 xterm.paste 等价语义）
      document.execCommand('insertText', false, filePath);
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (err) {
      console.warn('[paste-image] save-clipboard-image failed:', err && err.message);
    }
  });
}
if (typeof window !== 'undefined') window.attachContenteditablePasteImage = attachContenteditablePasteImage;

// --- Image hover preview tooltip ---
const previewTooltip = document.createElement('div');
previewTooltip.className = 'image-preview-tooltip';
previewTooltip.style.display = 'none';
document.body.appendChild(previewTooltip);

/** Extract an image path around the given column, if any. Uses the shared
 *  IMAGE_PATH_RE so all path heuristics stay in sync. */
function extractPathAtPosition(lineText, colIndex) {
  IMAGE_PATH_RE.lastIndex = 0;
  let match;
  while ((match = IMAGE_PATH_RE.exec(lineText)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (colIndex >= start && colIndex <= end) return match[0];
  }
  return null;
}

let previewTimeout = null;

function setupImageHover(terminal, container) {
  container.addEventListener('mousemove', (e) => {
    const coords = getTerminalCoords(terminal, container, e);
    if (!coords) { hidePreview(); return; }

    const buf = terminal.buffer.active;
    const line = buf.getLine(coords.row);
    if (!line) { hidePreview(); return; }

    const lineText = line.translateToString(false);
    const filePath = extractPathAtPosition(lineText, coords.col);

    if (filePath) {
      // extractPathAtPosition already scopes to image extensions via
      // IMAGE_PATH_RE, so any match here is safe to preview.
      showPreview(filePath, e.clientX, e.clientY);
    } else {
      hidePreview();
    }
  });

  container.addEventListener('mouseleave', hidePreview);
}

function getTerminalCoords(terminal, container, mouseEvent) {
  // Prefer .xterm-screen for pixel-perfect coordinate mapping — the
  // outer container may have padding/margins that shift the origin.
  const screenEl = container.querySelector('.xterm-screen');
  const rect = (screenEl || container).getBoundingClientRect();
  const renderer = terminal._core._renderService;
  if (!renderer || !renderer.dimensions) return null;

  const dims = renderer.dimensions;
  const x = mouseEvent.clientX - rect.left;
  const y = mouseEvent.clientY - rect.top;

  const col = Math.floor(x / dims.css.cell.width);
  const row = Math.floor(y / dims.css.cell.height) + terminal.buffer.active.viewportY;

  if (col < 0 || row < 0 || col >= terminal.cols) return null;
  return { col, row };
}

// --- Word-like input-line editing helpers ---

function getInputLineSelection(terminal) {
  const pos = terminal.getSelectionPosition();
  if (!pos) return null;

  const buf = terminal.buffer.active;
  const cursorRow = buf.baseY + buf.cursorY;
  // xterm internals are 0-based despite IBufferCellPosition docs saying 1-based
  if (pos.start.y !== cursorRow || pos.end.y !== cursorRow) return null;

  const text = terminal.getSelection();
  if (!text) return null;

  return { startCol: pos.start.x, endCol: pos.end.x, text };
}

function deleteInputSelection(terminal, sessionId, insertAfter) {
  const sel = getInputLineSelection(terminal);
  if (!sel || sel.text.length === 0) return false;

  const buf = terminal.buffer.active;
  let data = '';

  const toEnd = sel.endCol - buf.cursorX;
  if (toEnd > 0) data += '\x1b[C'.repeat(toEnd);
  else if (toEnd < 0) data += '\x1b[D'.repeat(-toEnd);

  data += '\x7f'.repeat(sel.text.length);
  if (insertAfter) data += insertAfter;

  terminal.clearSelection();
  ipcRenderer.send('terminal-input', { sessionId, data });
  return true;
}

function showPreview(filePath, mouseX, mouseY) {
  // Debounce to avoid flickering
  if (previewTooltip.dataset.path === filePath && previewTooltip.style.display === 'block') {
    // Just update position
    positionTooltip(mouseX, mouseY);
    return;
  }

  clearTimeout(previewTimeout);
  previewTimeout = setTimeout(() => {
    // Use file:// protocol for local images
    const fileUrl = 'file:///' + filePath.replace(/\\/g, '/');
    previewTooltip.innerHTML = `<img src="${fileUrl}" alt="preview" style="max-width:400px;max-height:300px;border-radius:6px;">`;
    previewTooltip.dataset.path = filePath;
    previewTooltip.style.display = 'block';
    positionTooltip(mouseX, mouseY);
  }, 300);
}

function positionTooltip(x, y) {
  const pad = 12;
  previewTooltip.style.left = `${x + pad}px`;
  previewTooltip.style.top = `${y + pad}px`;

  // Keep within viewport
  requestAnimationFrame(() => {
    const rect = previewTooltip.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      previewTooltip.style.left = `${x - rect.width - pad}px`;
    }
    if (rect.bottom > window.innerHeight) {
      previewTooltip.style.top = `${y - rect.height - pad}px`;
    }
  });
}

function hidePreview() {
  clearTimeout(previewTimeout);
  previewTooltip.style.display = 'none';
  previewTooltip.dataset.path = '';
}

// --- State ---
const sessions = new Map();
let activeSessionId = null;
const terminalCache = new Map();

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
const btnRoundtable = document.getElementById('btn-roundtable');
const contextMenuEl = document.getElementById('context-menu');
const appContainerEl = document.getElementById('app-container');
// btn-collapse-sidebar 已删除 (v0.8.4) — 用 Ctrl+B 折叠;展开按钮 btn-expand-sidebar 在折叠态仍提供
const btnExpandEl = document.getElementById('btn-expand-sidebar');

let contextMenuSessionId = null;

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
  for (const [, c] of terminalCache) {
    c.terminal.options.fontSize = size;
    if (c.opened) {
      try { c.fitAddon.fit(); } catch {}
    }
  }
}

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
    try { active.fitAddon.fit(); } catch {}
    ipcRenderer.send('terminal-resize', {
      sessionId: activeSessionId,
      cols: active.terminal.cols,
      rows: active.terminal.rows,
    });
  }
}

// Restore persisted zoom on boot.
applyZoom(currentZoom);

// --- Global Memo Panel ---
const MEMO_OPEN_KEY = 'claude-hub-memo-open';
const _memoFs = require('fs');
const _memoPath = require('path');
const _memoFile = _memoPath.join(
  require('../core/data-dir').getHubDataDir(), 'memo.json'
);

function loadMemoItems() {
  try { return JSON.parse(_memoFs.readFileSync(_memoFile, 'utf8')); }
  catch { return []; }
}
function saveMemoItems(items) {
  try {
    _memoFs.mkdirSync(_memoPath.dirname(_memoFile), { recursive: true });
    _memoFs.writeFileSync(_memoFile, JSON.stringify(items, null, 2), 'utf8');
  } catch (e) { console.error('[memo] save failed:', e.message); }
}

function formatMemoTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
  if (sameDay) return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
}

function renderMemoList() {
  const listEl = document.getElementById('memo-list');
  if (!listEl) return;
  const items = loadMemoItems();
  if (items.length === 0) {
    listEl.innerHTML = '<div class="memo-empty">暂无备忘</div>';
    return;
  }
  listEl.innerHTML = items.map(item => `
    <div class="memo-item" data-id="${item.id}">
      <div class="memo-item-time">${formatMemoTime(item.ts)}</div>
      <div class="memo-item-body">
        <span class="memo-item-text">${escapeHtml(item.text)}</span>
        <span class="memo-item-actions">
          <button class="memo-item-btn memo-copy-btn" title="复制">📋</button>
          <button class="memo-item-btn memo-del-btn" title="删除">🗑</button>
        </span>
      </div>
    </div>
  `).join('');
}

function addMemoItem(text) {
  if (!text.trim()) return;
  const items = loadMemoItems();
  items.unshift({ id: 'm_' + Date.now(), text: text.trim(), ts: Date.now() });
  saveMemoItems(items);
  renderMemoList();
}

function deleteMemoItem(id) {
  const items = loadMemoItems().filter(i => i.id !== id);
  saveMemoItems(items);
  renderMemoList();
}

function clearAllMemo() {
  saveMemoItems([]);
  renderMemoList();
}

function toggleMemoPanel() {
  const panel = document.getElementById('memo-panel');
  if (!panel) return;
  const isOpen = panel.style.display !== 'none';
  panel.style.display = isOpen ? 'none' : 'flex';
  localStorage.setItem(MEMO_OPEN_KEY, String(!isOpen));
  document.querySelectorAll('.btn-memo-toggle').forEach(btn => {
    btn.classList.toggle('active', !isOpen);
  });
  if (!isOpen) renderMemoList();
  // Re-fit active terminal after layout change
  const active = activeSessionId && terminalCache.get(activeSessionId);
  if (active && active.opened) {
    setTimeout(() => { try { active.fitAddon.fit(); } catch {} }, 50);
  }
}

// Memo panel event delegation (runs once on DOMContentLoaded)
function initMemoPanel() {
  const addBtn = document.getElementById('memo-add-btn');
  const input = document.getElementById('memo-input');
  const clearBtn = document.getElementById('memo-clear-btn');
  const listEl = document.getElementById('memo-list');
  if (!addBtn || !input) return;

  // Prevent keyboard events from reaching xterm
  input.addEventListener('keydown', e => e.stopPropagation());
  input.addEventListener('keypress', e => e.stopPropagation());
  input.addEventListener('keyup', e => e.stopPropagation());

  addBtn.addEventListener('click', () => {
    addMemoItem(input.value);
    input.value = '';
    input.focus();
  });

  input.addEventListener('keydown', e => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      addMemoItem(input.value);
      input.value = '';
    }
  });

  clearBtn.addEventListener('click', () => toggleMemoPanel());

  listEl.addEventListener('click', e => {
    const copyBtn = e.target.closest('.memo-copy-btn');
    if (copyBtn) {
      const item = copyBtn.closest('.memo-item');
      const text = item.querySelector('.memo-item-text').textContent;
      clipboard.writeText(text);
      copyBtn.textContent = '✓';
      setTimeout(() => { copyBtn.textContent = '📋'; }, 1200);
      return;
    }
    const delBtn = e.target.closest('.memo-del-btn');
    if (delBtn) {
      const item = delBtn.closest('.memo-item');
      deleteMemoItem(item.dataset.id);
    }
  });

  // Restore open state
  if (localStorage.getItem(MEMO_OPEN_KEY) === 'true') {
    const panel = document.getElementById('memo-panel');
    if (panel) {
      panel.style.display = 'flex';
      renderMemoList();
      document.querySelectorAll('.btn-memo-toggle').forEach(btn => btn.classList.add('active'));
    }
  }
}

initMemoPanel();

// --- Helpers ---
function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// --- Sidebar tree state: which meeting entries are expanded to show their sub-sessions ---
// Persists across reloads. Default = collapsed (白名单未命中即折叠)；用户点 ▶ 后才进
// _expandedMeetings 集合并落盘。2026-05-05 道雪改：新圆桌不再默认展开，折叠态本来
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
  const k = String(kind || '').replace(/-resume$/, '');
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
    // 2026-05-05 道雪 修3：圆桌 item 接入 unread 机制 —— 全员答完且非 active 时累加，
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
      // 2026-05-05 道雪 修3：圆桌 item 也应用 has-unread CSS（跟普通 session 一致），
      //   全员答完且非 active 时高亮提醒；用户点进圆桌后清零。
      const hasUnread = !isActive && (s.unreadCount > 0);
      div.className = 'session-item meeting' + (isActive ? ' selected' : '')
        + (isExpanded ? ' expanded' : '') + (hasUnread ? ' has-unread' : '');
      div.dataset.meetingId = s.id;
      // Phase 8(2026-05-05 道雪): 折叠/展开态都显示 3 个迷你头像跳转按钮(替代旧 "N 个子会话" 文字)。
      //   slot 配色绑定: subSessions[0]=Pikachu(slot1) / [1]=Charmander(slot2) / [2]=Squirtle(slot3),
      //   PNG 图与卡片头像/footer 一致(assets/pokemon/*.png)。
      //   状态点: thinking/streaming(running)=黄, errored=红, idle/completed=绿, 创建中=灰。
      const SLOT_AVATAR_FILES = ['pikachu.png', 'charmander.png', 'squirtle.png'];
      const SLOT_LABELS_M = ['⚡ Pikachu', '🔥 Charmander', '💎 Squirtle'];
      const miniJumpsHtml = (s._meeting.subSessions || []).slice(0, 3).map((subId, idx) => {
        const sub = sessions.get(subId);
        const label = SLOT_LABELS_M[idx] || `Slot ${idx + 1}`;
        const modelLabel = sub && sub.currentModel ? (typeof modelShort === 'function' ? modelShort(sub.currentModel) : sub.currentModel.id) : '';
        // 状态点配色: 复用 sub.status(running/idle/errored), 配合 cliReadyCache 推断 initializing
        let statusCls = 'mini-st-ready';
        if (!sub) statusCls = 'mini-st-init';
        else if (sub.status === 'errored' || sub.status === 'error') statusCls = 'mini-st-error';
        else if (sub.status === 'running') statusCls = 'mini-st-thinking';
        const isActiveChild = subId === activeSessionId;
        const tooltip = `${label}${modelLabel ? ' · ' + modelLabel : ''} (点击跳转)`;
        return `<button class="mini-jump-btn slot-${idx + 1}${isActiveChild ? ' active' : ''}" data-sub-id="${subId}" title="${escapeHtml(tooltip)}">
          <img src="assets/pokemon/${SLOT_AVATAR_FILES[idx]}" alt="${label}" />
          <span class="mini-jump-status-dot ${statusCls}"></span>
        </button>`;
      }).join('');
      div.innerHTML = `
        <div class="session-item-header">
          <span class="session-title">
            <span class="expand-arrow" data-action="toggle-expand" title="${isExpanded ? '折叠' : '展开'}">▶</span>
            ${s.pinned ? '<span class="pin-icon" title="Pinned">📌</span>' : ''}
            <span class="session-status running"></span>🎯 ${escapeHtml(s.title)}<span class="meeting-badge">${s._meeting.subSessions.length}</span>
          </span>
          <span class="session-header-right">
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
          if (subId) selectSession(subId);
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
          childDiv.className = 'session-item child' + (isChildActive ? ' selected' : '');
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
          childDiv.addEventListener('click', () => selectSession(subId));
          childDiv.addEventListener('contextmenu', (ev) => { ev.preventDefault(); openContextMenu(subId, ev.clientX, ev.clientY); });
          sessionListEl.appendChild(childDiv);
        }
      }
      continue;
    }

    const isActive = s.id === activeSessionId;
    const div = document.createElement('div');
    const dormantCls = s.status === 'dormant' ? ' dormant' : '';
    const waitingCls = s.isWaiting && !isActive ? ' is-waiting' : '';
    div.className = 'session-item' + (isActive ? ' selected' : '') + (!isActive && s.unreadCount > 0 ? ' has-unread' : '') + waitingCls + dormantCls;
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
    const footerInner = [modelBadge, ctxBadge, burnBadge].filter(Boolean).join('');
    div.innerHTML = `
      <div class="session-item-header">
        <span class="session-title">${s.pinned ? '<span class="pin-icon" title="Pinned">📌</span>' : ''}<span class="session-status ${s.status}"></span>${escapeHtml(s.title)}</span>
        <span class="session-header-right">
          ${s.isWaiting && !isActive ? `<span class="waiting-badge" title="${escapeHtml(s.waitingText || 'Claude is waiting for your input')}">⏸ 等你</span>` : ''}
          ${s.unreadCount > 0 && !isActive && !s.isWaiting ? `<span class="unread-badge" title="${escapeHtml(s.lastOutputPreview || 'AI 有新消息')}">⏸ 等你</span>` : ''}
          <span class="session-time">${formatTime(s.lastMessageTime)}</span>
        </span>
      </div>
      <div class="session-preview">${escapeHtml((s.isWaiting && s.waitingText) || s.lastOutputPreview || 'No output yet')}</div>
      ${footerInner ? `<div class="session-footer">${footerInner}</div>` : ''}
    `;
    div.addEventListener('click', () => selectSession(s.id));
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
  // 2026-05-05 道雪 修3：清 unread —— 用户点进圆桌即"看过"，跟普通 session 一致。
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

  terminal.onData((data) => { ipcRenderer.send('terminal-input', { sessionId, data }); });
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
      if (s.userRenamed) return; // user's Hub rename is authoritative
      // slot 化（2026-05-03 道雪）：圆桌 sub session title 永久绑定 slot 名
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
      ipcRenderer.invoke('rename-session', { sessionId, title: clean });
    });
  }

  // Intercept Ctrl/Cmd+V ourselves (both text and image) — Electron's Chromium
  // doesn't fire paste events on xterm's helper textarea for real keystrokes.
  terminal.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;

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
    if (!e.ctrlKey && !e.metaKey) return;
    const delta = e.deltaY < 0 ? 1 : -1;
    setFontSize(currentFontSize + delta);
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
  if (localStorage.getItem(MEMO_OPEN_KEY) === 'true') memoBtn.classList.add('active');
  memoBtn.addEventListener('click', () => toggleMemoPanel());

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

  requestAnimationFrame(() => {
    const dbg = window.__scrollDebug;
    if (dbg && dbg.isOn()) dbg.log('show:raf-enter', { focus: opts.focus, ...dbg.snap(cached.terminal, sessionId) });
    cached.fitAddon.fit();
    if (dbg && dbg.isOn()) dbg.log('show:after-fit', dbg.snap(cached.terminal, sessionId));
    ipcRenderer.send('terminal-resize', { sessionId, cols: cached.terminal.cols, rows: cached.terminal.rows });
    if (opts.focus) {
      cached.terminal.scrollToBottom();
      if (dbg && dbg.isOn()) dbg.log('show:after-stb', dbg.snap(cached.terminal, sessionId));
      cached.terminal.focus();
      const vp = cached.container.querySelector('.xterm-viewport');
      if (vp) vp.scrollTop = vp.scrollHeight;
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
        if (vp) vp.scrollTop = vp.scrollHeight;
        // Re-pin xterm's logical viewport too (scrollToBottom may have been
        // a no-op the first time when scrollArea was still stale).
        try { cached.terminal.scrollToBottom(); } catch {}
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
    if (!cached.container.offsetWidth) return;
    cached.fitAddon.fit();
    ipcRenderer.send('terminal-resize', { sessionId, cols: cached.terminal.cols, rows: cached.terminal.rows });
    if (cached._minimap) cached._minimap.invalidate();
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
      loadSessionHistoryToOverlay(sessionId).catch(err => {
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
    if (bodyEl && typeof wrapPathLinksInElement === 'function') wrapPathLinksInElement(bodyEl);
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
  const k = (kind || '').toLowerCase().replace(/-resume$/, '');
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
    // Spec 3 · W6：用户头像用皮卡丘（与圆桌 slot 体系视觉一致，复用 .av-poke 黄色背景）
    avatarHtml = `<span class="turn-avatar av-poke"><img src="assets/pokemon/pikachu.png" alt="你"></span>`;
  } else if (turn.slotPokemon) {
    // 圆桌 slot 体系
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

  const rawHtml = marked.parse(turn.text || '', { breaks: true, gfm: true });
  const body = DOMPurify.sanitize(rawHtml, { ADD_ATTR: ['target', 'data-lang'] });
  // Spec 3 方案 E：工具簇折叠（之前每 tool 单独大块 → 信息密度极低）
  const toolHtml = renderToolCluster(turn.id || '', turn.toolCalls);

  // === Spec 2 · S8: thinking 字段 (assistant only, default collapsed) ===
  // S1 parser exposes turn.thinking as multi-block joined string (or null).
  // Render as <details> ABOVE main body — chronologically thinking precedes the answer.
  // Only attached for assistant role with non-empty string; user turns never carry thinking.
  let thinkingHtml = '';
  if (!isUser && typeof turn.thinking === 'string' && turn.thinking.length > 0) {
    const thinkingRaw = marked.parse(turn.thinking, { breaks: true, gfm: true });
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
  body.classList.add('body-foldable', 'folded');
  const btn = document.createElement('div');
  btn.className = 'body-fold-toggle';
  btn.dataset.action = 'body-expand';
  btn.textContent = '▾ 展开全文';
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
  if (btn.dataset.action === 'body-expand') {
    body.classList.remove('folded');
    btn.dataset.action = 'body-collapse';
    btn.textContent = '▴ 折叠';
  } else {
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
  if (bodyEl && typeof wrapPathLinksInElement === 'function') wrapPathLinksInElement(bodyEl);
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

  // dedup with in-place replace：同 turnId 已在 DOM 时，不是 skip 而是替换。
  // 原因：W5 后一个 logical turn 包含多个 raw entries，streaming 新 entry 合并进来时
  // turn.id 不变（取首条 entry uuid）但内容已变（toolCalls 多了 / text 长了 / tsEnd 变 /
  // mergedCount 增加）。skip 会让用户看不到新工具调用；replace 让卡片 in-place 更新。
  // 副作用：替换瞬间该卡片如有 hover 操作菜单会闪一下，可接受。
  const existing = container.querySelector(`.turn-card[data-turn-id="${CSS.escape(turn.id)}"]`);
  if (existing) {
    let newCard = null;
    try {
      const tmp2 = document.createElement('div');
      const turnForRender2 = (opts.kind && !turn.kind) ? { ...turn, kind: opts.kind } : turn;
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
    if (bodyEl2 && typeof wrapPathLinksInElement === 'function') wrapPathLinksInElement(bodyEl2);
    if (typeof postProcessLongTextFold === 'function') postProcessLongTextFold(newCard);
    window._sessionTurns.set(turn.id, (opts.kind && !turn.kind) ? { ...turn, kind: opts.kind } : turn);
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
    wrapPathLinksInElement(bodyEl);
  }
  // 7b. Spec 3 · 长文本默认折叠（必须在 DOM 插入后调，否则 scrollHeight=0）
  if (typeof postProcessLongTextFold === 'function') {
    postProcessLongTextFold(cardEl);
  }

  // 8. register in _sessionTurns (turnId → turn) — keep spec1 Map shape
  // Use turnForRender (kind merged) so rerenderTurn won't lose kind on fold/unfold
  window._sessionTurns.set(turn.id, turnForRender);

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

  // 1. resolve container
  const container = document.getElementById('msg-overlay');
  if (!container) {
    console.warn('[loadSessionHistoryToOverlay] container not found (msg-overlay missing)');
    return { mounted: 0, error: 'container missing' };
  }

  // 2. clear container + Map (avoid stale turns from previous session)
  if (!incremental) {
    container.innerHTML = '';
    if (!window._sessionTurns) window._sessionTurns = new Map();
    window._sessionTurns.clear();
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
  const kind = session ? (session.kind || null) : null;

  // 4. kind gate — spec 2 only supports Claude family; show placeholder for others
  if (kind && !isClaudeFamily(kind)) {
    showPlaceholder(
      '卡片视图当前仅支持 Claude session — '
      + '<a href="#" data-action="switch-to-pty">切到 PTY 视图</a>'
    );
    return { mounted: 0, error: null };
  }

  // 5. invoke IPC (let main.js apply default opts: limit:50, fromTail:true)
  let result;
  try {
    result = await ipcRenderer.invoke('parse-session-transcript', {
      hubSessionId: sessionId,
      ccSessionId,
      opts: opts.parseOpts,
    });
  } catch (err) {
    const msg = (err && err.message) ? err.message : String(err);
    console.warn('[loadSessionHistoryToOverlay] IPC invoke threw:', err);
    showPlaceholder(
      '加载历史失败：' + msg + ' — '
      + '<a href="#" data-action="switch-to-pty">切到 PTY 视图查看终端</a>'
    );
    return { mounted: 0, error: msg };
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
    showPlaceholder(
      '新会话，发首条消息试试看 — '
      + '<a href="#" data-action="switch-to-pty">切到 PTY 视图</a>'
    );
    return { mounted: 0, error: null };
  }

  // 6c. mount each turn; pass kind through opts so renderTurnCard picks it up.
  // Use a default kind 'claude' if session lookup failed but main.js still
  // returned turns — they came from a Claude transcript by definition.
  const mountKind = kind || 'claude';
  // 2026-05-06 道雪 scroll-respect-user (Codex 多方审查发现):
  //   incremental=true 路径(streaming partial-update throttle)反复触发本函数,
  //   末尾的 batch scrollIntoView 没 guard → 用户上翻历史时仍被拍回底部。
  //   incremental=false(切 session): line 2179 已清 container.innerHTML='' →
  //     scrollTop=0/scrollHeight=0 → helper 自然返回 true → 初次加载行为不退化。
  //   incremental=true(throttle reload): container 保留旧内容 → 反映用户真实位置。
  const _batchWasAtBottom = _isCardOverlayAtBottom(container);
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
  }

  return { mounted, error: null };
}
window._loadSessionHistoryToOverlay = loadSessionHistoryToOverlay;

// === Spec 2 v1.0.0 · S6 turn-complete-event listener ===
// main.js (S3) broadcasts 'turn-complete-event' whenever an assistant turn
// finishes streaming. Append the just-completed turn as a card to #msg-overlay
// for the active Claude session in card view.
//
// Skip conditions (each is a multi-instance / multi-view safety guard):
//   - meetingId truthy → 圆桌 has its own card pipeline (renderer/meeting-room.js)
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

  // 1. 圆桌 path — meeting-room.js handles its own card rendering
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

// rt-file-link click → openPreviewPanel (only for cards inside .msg-overlay,
// don't conflict with meeting-room.js handler which targets its own scope)
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a.rt-file-link');
  if (!a) return;
  if (!a.closest('.msg-overlay')) return;
  e.preventDefault();
  e.stopPropagation();
  const path = a.dataset.path;
  if (path && typeof openPreviewPanel === 'function') openPreviewPanel(path);
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
    // - Roundtable: `<div id="mr-input-box" contenteditable>`
    const inputEl = document.querySelector('.floating-input-box')
      || document.getElementById('mr-input-box');
    if (inputEl) {
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
function _updateStreamingIndicator(sessionId) {
  if (sessionId !== activeSessionId) return;
  const overlay = document.getElementById('msg-overlay');
  if (!overlay) return;
  const sess = sessions.get(sessionId);
  const isRunning = sess && sess.status === 'running';
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
    if (!indicator) {
      // 2026-05-06 道雪 scroll-respect-user:append 前记录是否在底部,仅满足条件才滚
      //   (status running↔idle 反复切换时频繁触发的强制 scroll 是历史 bug 主因之一)
      const wasAtBottom = _isCardOverlayAtBottom(overlay);
      indicator = document.createElement('div');
      indicator.className = 'streaming-indicator';
      indicator.dataset.sessionId = String(sessionId);
      indicator.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="text"></span>';
      overlay.appendChild(indicator);
      if (wasAtBottom) {
        try { overlay.scrollTop = overlay.scrollHeight; } catch {}
      }
    }
    // 动态文案
    const cardCount = overlay.querySelectorAll('.turn-card[data-turn-id]').length;
    const textEl = indicator.querySelector('.text');
    if (textEl) {
      textEl.textContent = cardCount === 0
        ? 'Claude 正在思考…'
        : 'Claude 还在生成更多回复…';
    }
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
    b.classList.toggle('active', b.dataset.view === mode);
  });
  // 切到 PTY 时 refit xterm
  if (mode === 'pty' && typeof terminalCache !== 'undefined') {
    const cached = terminalCache.get(activeSessionId);
    if (cached && cached.fitAddon) cached.fitAddon.fit();
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

  const sendBtn = document.createElement('button');
  sendBtn.className = 'floating-input-send';
  sendBtn.title = '发送 (Enter)';
  sendBtn.textContent = '▶';

  bar.append(inputBox, sendBtn);
  bar.classList.add('visible');

  const panel = termContainer.closest('.terminal-panel');
  if (panel) panel.appendChild(bar);
  else termContainer.appendChild(bar);

  function sendInput() {
    const text = inputBox.innerText;
    if (!text || !text.trim()) return;
    ipcRenderer.send('terminal-input', { sessionId, data: text + '\r' });
    inputBox.textContent = '';
    terminal.scrollToBottom();
    terminal.focus();
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
        await ipcRenderer.invoke('rename-session', { sessionId, title: trimmed });
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
function selectSession(id) {
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
  activeSessionId = id;
  if (session) {
    session.unreadCount = 0;
    session.isWaiting = false;
    session.waitingReason = null;
    session.waitingText = null;
  }
  ipcRenderer.send('focus-session', { sessionId: id });
  renderSessionList();
  showTerminal(id, { focus: switching });
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
// 主 CTA 召集圆桌(走现有 createMeetingByMode);底部超链接 1v1 单聊(走 create-session)。
// 静态 DOM,无最近会话,无磁盘 IO,无 IPC 启动开销。
for (const cta of document.querySelectorAll('.launcher-cta')) {
  cta.addEventListener('click', () => {
    if (cta.dataset.launcherAction === 'roundtable') {
      createMeetingByMode('general');
    }
  });
}
for (const link of document.querySelectorAll('.launcher-link')) {
  link.addEventListener('click', () => {
    const kind = link.dataset.launcherKind;
    if (kind) ipcRenderer.invoke('create-session', kind);
  });
}

// --- Roundtable button ---
btnRoundtable.addEventListener('click', async () => {
  await createMeetingByMode('general');
});

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

// --- Create Meeting (mode-driven, no modal) ---
// meeting-create-modal（2026-05-01）：+号菜单的圆桌入口现在弹 Modal 让用户选 AI/model，
//   不再"立即创建 Claude+Gemini+Codex"。Modal 在 renderer/meeting-create-modal.js，
//   提交后调 create-meeting IPC（带 slots），main.js 内部循环 add-meeting-sub +
//   持久化 slotSpecs，返回完整 meeting 对象，Modal 再调 selectMeeting(meeting.id)。
function createMeetingByMode(mode) {
  if (typeof window.openMeetingCreateModal === 'function') {
    window.openMeetingCreateModal(mode || 'general');
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
        opts: { resumeCCSessionId: it.sessionId, cwd: it.cwd || undefined },
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
        opts: { resumeCCSessionId: h.sessionId },
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
// Cross-line paths (xterm soft-wrap on long paths): we register ONE link per
// physical line covered, all sharing the same fullPath. xterm hover/click
// hit-testing on cross-line ranges (startY ≠ endY) has known quirks that
// silently break long-path detection — single-line ranges sidestep them.

// LRU + TTL cache for relative-path existsSync. Hover spam can re-query the
// same path 60+ times in seconds; without this we'd stat the disk each time.
// 5s TTL keeps file-creation feedback near-instant.
const REL_PATH_CACHE = new Map();
const REL_PATH_CACHE_MAX = 256;
const REL_PATH_CACHE_TTL_MS = 5000;
function _resolveRelPathIfExists(cwd, relPath) {
  const key = `${cwd}|${relPath}`;
  const now = Date.now();
  const hit = REL_PATH_CACHE.get(key);
  if (hit && now - hit.ts < REL_PATH_CACHE_TTL_MS) {
    REL_PATH_CACHE.delete(key);
    REL_PATH_CACHE.set(key, hit); // refresh LRU recency
    return hit.absPath;
  }
  let absPath = null;
  try {
    const candidate = require('path').resolve(cwd, relPath);
    if (require('fs').existsSync(candidate)) absPath = candidate;
  } catch {}
  REL_PATH_CACHE.set(key, { absPath, ts: now });
  if (REL_PATH_CACHE.size > REL_PATH_CACHE_MAX) {
    const oldestKey = REL_PATH_CACHE.keys().next().value;
    REL_PATH_CACHE.delete(oldestKey);
  }
  return absPath;
}

// Group of currently-registered link instances that all point to the same
// fullPath. Used so that hovering ANY segment of a wrap-split path lights up
// the underline on EVERY segment (xterm's default only decorates the line
// the cursor is on). Mutating link.decorations.underline triggers a re-render
// per the xterm.d.ts ILink contract.
const _activeLinkGroups = new Map(); // fullPath → Set<ILink>
function _registerLinkInGroup(fullPath, link) {
  let set = _activeLinkGroups.get(fullPath);
  if (!set) { set = new Set(); _activeLinkGroups.set(fullPath, set); }
  set.add(link);
}
function _unregisterLinkFromGroup(fullPath, link) {
  const set = _activeLinkGroups.get(fullPath);
  if (!set) return;
  set.delete(link);
  if (set.size === 0) _activeLinkGroups.delete(fullPath);
}
function _setGroupUnderline(fullPath, value) {
  const set = _activeLinkGroups.get(fullPath);
  if (!set) return;
  for (const link of set) {
    if (link.decorations) link.decorations.underline = value;
  }
}

function registerLocalPathLinks(terminal, sessionId) {
  // Path-valid char regex for the heuristic-continuation boundary check.
  // Excludes whitespace + path-illegal chars + quotes/backtick (so we don't
  // wrongly stitch across `'path.md'  next-line-prose` style boundaries).
  const PATH_BOUNDARY_RE = /[^\\/:*?"<>|\r\n\s'"`]/;
  // Heuristic: treat `current` as a wrap-continuation of `prev` even when
  // current.isWrapped is false. Required because Ink-based apps (Claude Code,
  // Codex CLI, etc.) detect cols via process.stdout.columns and emit their own
  // hard \n at the cols boundary — conpty forwards those as explicit lines,
  // xterm sees isWrapped=false, and our wrap stitching would break long paths.
  // Trigger only when prev exactly fills cols AND boundary chars on both
  // sides are path-valid — three conjunct conditions keep false-positive rate
  // low; a stray mis-stitch still gets filtered by the regex match in phase 1/2.
  const _isHeuristicCont = (prevLine, currentLine) => {
    if (!prevLine || !currentLine) return false;
    const cols = terminal.cols;
    const prevTrim = prevLine.translateToString(true);
    if (prevTrim.length !== cols) return false;
    const prevLast = prevTrim[prevTrim.length - 1];
    const curRaw = currentLine.translateToString(false);
    const curFirst = curRaw[0];
    return !!(prevLast && curFirst
      && PATH_BOUNDARY_RE.test(prevLast)
      && PATH_BOUNDARY_RE.test(curFirst));
  };

  terminal.registerLinkProvider({
    provideLinks(lineNumber, callback) {
      const buf = terminal.buffer.active;
      const line = buf.getLine(lineNumber - 1);
      if (!line) { callback(undefined); return; }

      // Walk backwards to find the start of this logical line group. Continue
      // past either xterm's isWrapped flag OR our heuristic continuation.
      let groupIdx = lineNumber - 1; // 0-based buffer index
      while (groupIdx > 0) {
        const cur = buf.getLine(groupIdx);
        if (cur && cur.isWrapped) { groupIdx--; continue; }
        const prev = buf.getLine(groupIdx - 1);
        if (_isHeuristicCont(prev, cur)) { groupIdx--; continue; }
        break;
      }
      const groupLine = groupIdx + 1; // 1-based line number of group start

      // Collect group + wrapped continuations into one flat string so a path
      // split across wrap can be matched whole.
      let text = '';
      const lineWidths = [];
      for (let i = groupIdx; ; i++) {
        const l = buf.getLine(i);
        if (!l) break;
        if (i > groupIdx) {
          const prev = buf.getLine(i - 1);
          if (!l.isWrapped && !_isHeuristicCont(prev, l)) break;
        }
        const lt = l.translateToString(true);
        text += lt;
        lineWidths.push(lt.length);
      }

      // Phase 0 — collect URL matches. Catches http(s)://host:port forms
      // that WebLinksAddon's stricter built-in regex misses. URLs go straight
      // to openPreviewPanel (which has webview-rendering for http schemes).
      const candidates = []; // [{ start, end, openPath, isUrl? }]
      URL_RE.lastIndex = 0;
      let m;
      while ((m = URL_RE.exec(text))) {
        // Trim trailing prose punctuation (".,;:!?)]") that's not part of the URL.
        const trimmed = m[0].replace(/[.,;:!?)\]]+$/, '');
        if (trimmed.length < 'http://x'.length) continue;
        candidates.push({
          start: m.index,
          end: m.index + trimmed.length - 1,
          openPath: trimmed,
          isUrl: true,
        });
      }

      // Phase 1 — collect ABS matches (high confidence, no validation).
      ABS_PATH_RE.lastIndex = 0;
      while ((m = ABS_PATH_RE.exec(text))) {
        candidates.push({
          start: m.index,
          end: m.index + m[0].length - 1,
          openPath: m[0],
        });
      }

      // Phase 2 — REL matches: drop any overlapping with ABS/URL (REL regex
      // also matches the tail of an absolute path or URL), then
      // existsSync-validate against session.cwd. Skip phase entirely if cwd
      // unavailable.
      const cwd = (sessions.get(sessionId) || {}).cwd;
      if (cwd) {
        REL_PATH_RE.lastIndex = 0;
        while ((m = REL_PATH_RE.exec(text))) {
          const start = m.index;
          const end = start + m[0].length - 1;
          const overlapsExisting = candidates.some(c =>
            !(end < c.start || start > c.end));
          if (overlapsExisting) continue;
          const absPath = _resolveRelPathIfExists(cwd, m[0]);
          if (!absPath) continue;
          candidates.push({ start, end, openPath: absPath });
        }
      }

      // Phase 3 — for each candidate, register one single-line link per
      // physical line it covers, all sharing the same openPath. xterm calls
      // provideLinks once per line, so we only return segments matching
      // lineNumber on this call (other lines get their own segment when
      // xterm queries them).
      const links = [];
      for (const c of candidates) {
        let cum = 0;
        for (let i = 0; i < lineWidths.length; i++) {
          const lineStart = cum;
          const lineEnd = cum + lineWidths[i]; // exclusive
          cum = lineEnd;
          if (c.end < lineStart || c.start >= lineEnd) continue;
          const yLine = groupLine + i;
          if (yLine !== lineNumber) continue;
          const segStartOff = Math.max(c.start, lineStart);
          const segEndOff = Math.min(c.end, lineEnd - 1);
          const startX = segStartOff - lineStart + 1; // xterm cols are 1-based
          const endX = segEndOff - lineStart + 1;
          const fullPath = c.openPath;
          const isUrl = !!c.isUrl;
          // hover/leave/dispose route through _activeLinkGroups so all
          // segments of the same fullPath share underline state — hover any
          // segment, every segment lights up. Initial underline:false; xterm
          // mutates back via the hover callback.
          const linkObj = {
            range: {
              start: { x: startX, y: yLine },
              end: { x: endX, y: yLine },
            },
            text: fullPath, // hover tooltip shows the resolved absolute path
            decorations: { pointerCursor: true, underline: false },
            activate: async () => {
              if (isUrl || PREVIEW_PATH_RE.test(fullPath)) {
                openPreviewPanel(fullPath);
              } else {
                const err = await ipcRenderer.invoke('open-path', fullPath);
                if (err) console.warn('[hub] open-path failed:', fullPath, '→', err);
              }
            },
            hover: () => _setGroupUnderline(fullPath, true),
            leave: () => _setGroupUnderline(fullPath, false),
          };
          linkObj.dispose = () => _unregisterLinkFromGroup(fullPath, linkObj);
          _registerLinkInGroup(fullPath, linkObj);
          links.push(linkObj);
        }
      }
      callback(links.length > 0 ? links : undefined);
    },
  });
}

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
const previewPanelEl = document.getElementById('preview-panel');
const previewTitleEl = document.getElementById('preview-title');
const previewBodyEl = document.getElementById('preview-body');
const previewSplitterEl = document.getElementById('preview-splitter');
let previewSourcePanel = null;
let currentPreviewPath = null;
let previewIsFullscreen = false;
let previewSplitRatio = 0.5;

const sessionPreviewStates = new Map();

function getActiveContextKey() {
  if (activeSessionId) return `session:${activeSessionId}`;
  if (activeMeetingId) return `meeting:${activeMeetingId}`;
  return null;
}

function savePreviewState() {
  const key = getActiveContextKey();
  if (!key || !currentPreviewPath) return;
  sessionPreviewStates.set(key, {
    path: currentPreviewPath,
    isFullscreen: previewIsFullscreen,
    zoomLevel: previewZoomLevel,
    splitRatio: previewSplitRatio,
  });
}

function clearPreviewUI() {
  previewPanelEl.style.display = 'none';
  previewPanelEl.classList.remove('preview-split');
  previewSplitterEl.style.display = 'none';
  currentPreviewPath = null;
  previewIsFullscreen = false;
  previewSplitRatio = 0.5;
  previewSourcePanel = null;
  applySplitWidths(null);
  resetPreviewZoom();
}

function restorePreviewForContext(key) {
  const state = sessionPreviewStates.get(key);
  if (!state) return;
  previewIsFullscreen = state.isFullscreen;
  previewSplitRatio = state.splitRatio || 0.5;
  openPreviewPanel(state.path).then(() => {
    setPreviewZoom(state.zoomLevel);
    const btn = document.getElementById('preview-toggle-layout');
    if (btn) {
      btn.textContent = previewIsFullscreen ? '◫' : '□';
      btn.title = previewIsFullscreen ? '并列预览' : '全屏预览';
    }
  });
}

async function openPreviewPanel(filePath) {
  filePath = filePath.replace(/[\r\n]+/g, '').trim();
  currentPreviewPath = filePath;
  resetPreviewZoom();
  const isUrl = /^https?:\/\//i.test(filePath);
  const fileName = isUrl ? filePath.replace(/^https?:\/\//i, '').split(/[/?#]/)[0] : filePath.replace(/^.*[\\/]/, '');
  previewTitleEl.textContent = fileName;
  previewTitleEl.title = filePath;

  // 0.8.2: 文件类型角标 + 大小信息
  const badgeEl = document.getElementById('preview-file-badge');
  const metaEl = document.getElementById('preview-file-meta');
  if (badgeEl && metaEl) {
    if (isUrl) {
      badgeEl.textContent = 'URL';
      metaEl.textContent = '';
    } else {
      const m = filePath.match(/\.([a-zA-Z0-9]+)$/);
      badgeEl.textContent = m ? m[1].toUpperCase().slice(0, 4) : '--';
      try {
        const size = fs.statSync(filePath).size;
        if (size < 1024) metaEl.textContent = size + ' B';
        else if (size < 1024 * 1024) metaEl.textContent = (size / 1024).toFixed(1) + ' KB';
        else metaEl.textContent = (size / 1024 / 1024).toFixed(1) + ' MB';
      } catch {
        metaEl.textContent = '';
      }
    }
  }

  if (!previewSourcePanel) {
    if (document.getElementById('meeting-room-panel').style.display !== 'none'
        && document.getElementById('meeting-room-panel').style.display !== '') {
      previewSourcePanel = 'meeting-room-panel';
    } else {
      previewSourcePanel = 'terminal-panel';
    }
  }

  const src = document.getElementById(previewSourcePanel);
  if (previewIsFullscreen) {
    if (src) src.style.display = 'none';
  }
  const emptyEl = document.getElementById('empty-state');
  if (emptyEl) emptyEl.style.display = 'none';
  previewPanelEl.style.display = 'flex';
  const isSplit = !previewIsFullscreen;
  previewPanelEl.classList.toggle('preview-split', isSplit);
  previewSplitterEl.style.display = isSplit ? '' : 'none';
  applySplitWidths(isSplit ? previewSplitRatio : null);
  if (isSplit) refitActiveTerminal();

  previewBodyEl.innerHTML = '';

  if (isUrl) {
    const wv = document.createElement('webview');
    wv.src = filePath;
    wv.style.cssText = 'width:100%;height:100%;border:none;';
    previewBodyEl.style.alignItems = 'stretch';
    previewBodyEl.style.justifyContent = 'stretch';
    previewBodyEl.appendChild(wv);
    return;
  }

  const ext = filePath.replace(/^.*\./, '.').toLowerCase();

  if (ext === '.html' || ext === '.htm') {
    const wv = document.createElement('webview');
    wv.src = 'file:///' + filePath.replace(/\\/g, '/');
    wv.style.cssText = 'width:100%;height:100%;border:none;';
    previewBodyEl.style.alignItems = 'stretch';
    previewBodyEl.style.justifyContent = 'stretch';
    previewBodyEl.appendChild(wv);
  } else if (ext === '.md' || ext === '.markdown') {
    const { marked } = require('marked');
    const DOMPurify = require('dompurify');
    const result = await ipcRenderer.invoke('read-file', filePath);
    if (result.error) {
      previewBodyEl.innerHTML = `<div class="preview-markdown" style="color:var(--text-secondary)">Failed to load: ${result.error}</div>`;
      return;
    }
    const html = DOMPurify.sanitize(marked.parse(result.content));
    previewBodyEl.style.alignItems = 'flex-start';
    previewBodyEl.style.justifyContent = 'flex-start';
    previewBodyEl.innerHTML = `<div class="preview-markdown">${html}</div>`;
  } else if (ext === '.svg' || ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.gif' || ext === '.webp' || ext === '.bmp') {
    const fileUrl = 'file:///' + filePath.replace(/\\/g, '/');
    previewBodyEl.style.alignItems = 'center';
    previewBodyEl.style.justifyContent = 'center';
    previewBodyEl.innerHTML = `<img src="${fileUrl}" class="preview-image">`;
  } else if (ext === '.pdf') {
    const wv = document.createElement('webview');
    wv.src = 'file:///' + filePath.replace(/\\/g, '/');
    wv.style.cssText = 'width:100%;height:100%;border:none;';
    previewBodyEl.style.alignItems = 'stretch';
    previewBodyEl.style.justifyContent = 'stretch';
    previewBodyEl.appendChild(wv);
  } else if (ext === '.csv' || ext === '.tsv') {
    const result = await ipcRenderer.invoke('read-file', filePath);
    if (result.error) {
      previewBodyEl.innerHTML = `<div class="preview-markdown" style="color:var(--text-secondary)">Failed to load: ${result.error}</div>`;
      return;
    }
    const sep = ext === '.tsv' ? '\t' : ',';
    const rows = result.content.split(/\r?\n/).filter(l => l.trim());
    let tableHtml = '<div class="preview-csv-wrap"><table class="preview-csv"><thead><tr>';
    if (rows.length > 0) {
      for (const cell of rows[0].split(sep)) tableHtml += `<th>${cell.replace(/</g, '&lt;')}</th>`;
      tableHtml += '</tr></thead><tbody>';
      for (let i = 1; i < rows.length; i++) {
        tableHtml += '<tr>';
        for (const cell of rows[i].split(sep)) tableHtml += `<td>${cell.replace(/</g, '&lt;')}</td>`;
        tableHtml += '</tr>';
      }
      tableHtml += '</tbody>';
    }
    tableHtml += '</table></div>';
    previewBodyEl.style.alignItems = 'flex-start';
    previewBodyEl.style.justifyContent = 'flex-start';
    previewBodyEl.innerHTML = tableHtml;
  } else {
    const result = await ipcRenderer.invoke('read-file', filePath);
    if (result.error) {
      previewBodyEl.innerHTML = `<div class="preview-markdown" style="color:var(--text-secondary)">Failed to load: ${result.error}</div>`;
      return;
    }
    let content = result.content;
    if (ext === '.json' || ext === '.jsonl') {
      try { content = JSON.stringify(JSON.parse(content), null, 2); } catch {}
    }
    const escaped = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const lines = escaped.split('\n');
    const numbered = lines.map((line, i) => `<span class="preview-line-num">${i + 1}</span>${line}`).join('\n');
    previewBodyEl.style.alignItems = 'flex-start';
    previewBodyEl.style.justifyContent = 'flex-start';
    previewBodyEl.innerHTML = `<pre class="preview-code">${numbered}</pre>`;
  }
}

function closePreviewPanel() {
  const key = getActiveContextKey();
  if (key) sessionPreviewStates.delete(key);

  previewPanelEl.style.display = 'none';
  previewPanelEl.classList.remove('preview-split');
  previewSplitterEl.style.display = 'none';
  currentPreviewPath = null;
  previewIsFullscreen = false;
  previewSplitRatio = 0.5;
  applySplitWidths(null);
  resetPreviewZoom();

  if (previewSourcePanel) {
    const src = document.getElementById(previewSourcePanel);
    if (src) src.style.display = previewSourcePanel === 'terminal-panel' ? '' : 'flex';
    previewSourcePanel = null;
  }
  refitActiveTerminal();
}

function togglePreviewLayout() {
  previewIsFullscreen = !previewIsFullscreen;
  const btn = document.getElementById('preview-toggle-layout');
  if (previewIsFullscreen) {
    btn.textContent = '◫';
    btn.title = '并列预览';
    previewPanelEl.classList.remove('preview-split');
    previewSplitterEl.style.display = 'none';
    applySplitWidths(null);
    if (previewSourcePanel) {
      const src = document.getElementById(previewSourcePanel);
      if (src) src.style.display = 'none';
    }
  } else {
    btn.textContent = '□';
    btn.title = '全屏预览';
    previewPanelEl.classList.add('preview-split');
    previewSplitterEl.style.display = '';
    applySplitWidths(previewSplitRatio);
    if (previewSourcePanel) {
      const src = document.getElementById(previewSourcePanel);
      if (src) src.style.display = previewSourcePanel === 'terminal-panel' ? '' : 'flex';
    }
  }
  refitActiveTerminal();
}

// 2026-05-05 道雪 bug：预览面板内的 <a> 点击默认行为是 navigate 整个 renderer
// 进程,会把 index.html 替换为对 href 的 file:// 加载——结果就是"完全黑屏"。
// 典型触发：预览 .md 文件,内有指向其他 .md 的相对链接,marked 渲染成 <a href="x.md">,
// 用户点击 → 整个 hub UI 消失。这里委托拦截,路由回 openPreviewPanel。
//
// 2026-05-06 道雪 多方审查后增强:
//   1. mailto:/tel:/sms: 走 shell.openExternal 让 OS 处理(原版会落入 path.resolve 错误拼接)
//   2. 其它非 http(s)/file scheme(javascript:/data: 等)直接丢弃(双层防御,DOMPurify 已 sanitize)
//   3. URL-encode 解码(中文/空格文件名)
//   4. 跨文件锚点 other.md#section 拆 hash 后再 resolve(原版会把整串当文件名,扩展名匹配失败)
previewBodyEl.addEventListener('click', (e) => {
  const a = e.target && e.target.closest && e.target.closest('a[href]');
  if (!a) return;
  if (a.classList.contains('rt-file-link')) return; // 已有专门处理
  const rawHref = a.getAttribute('href') || '';
  if (!rawHref || rawHref.startsWith('#')) return; // 同页锚点保持默认
  e.preventDefault();
  e.stopPropagation();
  // mailto:/tel:/sms: 等用 OS 默认应用打开
  if (/^(mailto|tel|sms|callto|skype):/i.test(rawHref)) {
    try { shell.openExternal(rawHref); } catch (err) { console.warn('[hub] openExternal failed:', err); }
    return;
  }
  // javascript:/data: 等危险协议丢弃(DOMPurify 应已 sanitize,这里多一层兜底)
  const proto = /^([a-z][a-z0-9+.-]*):/i.exec(rawHref);
  if (proto && !/^(https?|file)$/i.test(proto[1])) {
    console.warn('[hub] unsupported scheme blocked:', rawHref);
    return;
  }
  // 拆 fragment(other.md#section 这种跨文件锚点),路径解析忽略 hash
  const hashIdx = rawHref.indexOf('#');
  const pathOnly = hashIdx >= 0 ? rawHref.slice(0, hashIdx) : rawHref;
  let href;
  try { href = decodeURIComponent(pathOnly); } catch (_) { href = pathOnly; }
  if (/^https?:\/\//i.test(href)) { openPreviewPanel(href); return; }
  let target = href.replace(/^file:\/+/i, '');
  const isAbs = /^[a-zA-Z]:[\\/]/.test(target) || target.startsWith('/');
  if (!isAbs && currentPreviewPath && !/^https?:\/\//i.test(currentPreviewPath)) {
    try {
      const dir = require('path').dirname(currentPreviewPath);
      target = require('path').resolve(dir, target);
    } catch (err) { console.warn('[hub] preview link resolve failed:', err); }
  }
  openPreviewPanel(target);
});

document.getElementById('preview-close').addEventListener('click', closePreviewPanel);
document.getElementById('preview-toggle-layout').addEventListener('click', togglePreviewLayout);
document.getElementById('preview-open-external').addEventListener('click', async () => {
  if (currentPreviewPath) {
    if (/^https?:\/\//i.test(currentPreviewPath)) {
      shell.openExternal(currentPreviewPath);
    } else {
      const err = await ipcRenderer.invoke('open-path', currentPreviewPath);
      if (err) console.warn('[hub] open-path for preview failed:', currentPreviewPath, '→', err);
    }
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && previewPanelEl.style.display === 'flex') {
    e.preventDefault();
    closePreviewPanel();
  }
});

// --- Preview zoom ---
let previewZoomLevel = 1.0;
const previewZoomLabelEl = document.getElementById('preview-zoom-label');

function setPreviewZoom(level) {
  previewZoomLevel = Math.max(0.25, Math.min(5.0, level));
  previewBodyEl.style.zoom = previewZoomLevel;
  // Also zoom webview content if present
  const wv = previewBodyEl.querySelector('webview');
  if (wv) try { wv.setZoomFactor(previewZoomLevel); } catch {}
  previewZoomLabelEl.textContent = Math.round(previewZoomLevel * 100) + '%';
}

function resetPreviewZoom() {
  setPreviewZoom(1.0);
}

document.getElementById('preview-zoom-out').addEventListener('click', () => setPreviewZoom(previewZoomLevel - 0.1));
document.getElementById('preview-zoom-in').addEventListener('click', () => setPreviewZoom(previewZoomLevel + 0.1));
document.getElementById('preview-zoom-reset').addEventListener('click', resetPreviewZoom);

previewBodyEl.addEventListener('wheel', (e) => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  const delta = e.deltaY < 0 ? 0.1 : -0.1;
  setPreviewZoom(previewZoomLevel + delta);
}, { passive: false });

// --- Preview splitter drag ---

function applySplitWidths(ratio) {
  const src = previewSourcePanel ? document.getElementById(previewSourcePanel) : null;
  if (!ratio) {
    if (src) { src.style.flex = ''; }
    previewPanelEl.style.flex = '';
    return;
  }
  const r = Math.max(0.1, Math.min(0.9, ratio));
  if (src) src.style.flex = String(r);
  previewPanelEl.style.flex = String(1 - r);
}

function refitActiveTerminal() {
  const sid = activeSessionId;
  if (!sid) return;
  const cached = terminalCache.get(sid);
  if (!cached || !cached.opened) return;
  requestAnimationFrame(() => {
    if (!cached.container.offsetWidth) return;
    try { cached.fitAddon.fit(); } catch (_) {}
    ipcRenderer.send('terminal-resize', { sessionId: sid, cols: cached.terminal.cols, rows: cached.terminal.rows });
  });
}

(function initSplitterDrag() {
  let dragging = false;
  let rafId = 0;
  previewSplitterEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    previewSplitterEl.classList.add('dragging');
    previewBodyEl.style.pointerEvents = 'none';
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      const src = previewSourcePanel ? document.getElementById(previewSourcePanel) : null;
      if (!src) return;
      const srcRect = src.getBoundingClientRect();
      const previewRect = previewPanelEl.getBoundingClientRect();
      const totalContent = srcRect.width + previewRect.width;
      if (totalContent <= 0) return;
      const desired = e.clientX - srcRect.left;
      previewSplitRatio = Math.max(0.1, Math.min(0.9, desired / totalContent));
      applySplitWidths(previewSplitRatio);
    });
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    previewSplitterEl.classList.remove('dragging');
    previewBodyEl.style.pointerEvents = '';
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    refitActiveTerminal();
  });
})();

// --- Terminal buffer reading (xterm.js buffer API) ---

const silenceTimers = new Map();
const dataCounters = new Map();  // sessionId -> bytes received in current burst
const SILENCE_MS = 2000; // 2s silence = idle (Claude Code status bar refreshes ~every 30-60s)

/** Pure parser: extract user prompts from raw buffer line strings.
 *  Claude Code's user-input prompt is "❯ <text>", often wrapped in a
 *  box like "│ ❯ <text> │". This strictly matches ❯ (not > or ›,
 *  which would catch AI output) and skips any line containing an
 *  AI-reply marker (⏺●◐ etc.) as a safety net.
 */
function parseQuestionsFromLines(lines) {
  const questions = [];
  const seen = new Set();
  for (const raw of lines) {
    if (!raw) continue;
    if (AI_MARKERS_RE.test(raw)) continue;
    const m = raw.match(PROMPT_LINE_RE);
    if (!m) continue;
    const q = m[1].replace(/\s+$/, '').trim();
    if (q.length < 2) continue;
    if (seen.has(q)) continue;
    seen.add(q);
    questions.push(q);
  }
  return questions;
}

/** Extract user questions from an xterm buffer. */
function extractUserQuestions(sessionId) {
  const cached = terminalCache.get(sessionId);
  if (!cached || !cached.opened) return [];
  const buf = cached.terminal.buffer.active;
  const lines = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true);
    if (text.trim()) lines.push(text);
  }
  return parseQuestionsFromLines(lines);
}


/** Read the trailing N lines of the xterm buffer as plain text (post-render). */
function extractTailLines(sessionId, count = 40) {
  const cached = terminalCache.get(sessionId);
  if (!cached || !cached.opened) return [];
  const buf = cached.terminal.buffer.active;
  const out = [];
  const start = Math.max(0, buf.length - count);
  for (let i = start; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (!line) continue;
    out.push(line.translateToString(true));
  }
  return out;
}

/** Strict classifier: does the session look like Claude is waiting for user input?
 *  False positives are worse than false negatives — only fire on clear question
 *  / choice / confirm patterns. Returns { waiting, reason, text } or { waiting:false }. */
function isWaitingForUser(lines) {
  if (!lines || lines.length === 0) return { waiting: false };
  let lastMeaningful = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const L = (lines[i] || '').trim();
    if (!L) continue;
    if (PROMPT_PREFIX_RE.test(L)) continue;
    const stripped = L.replace(AI_MARKERS_RE, '').trim();
    if (!stripped) continue;
    lastMeaningful = stripped;
    break;
  }
  if (!lastMeaningful) return { waiting: false };
  const tail = lines.slice(-12).join('\n');
  // Rule: [y/N] / [Y/n] / (yes/no) → explicit confirm
  if (/\[y\/N\]|\[Y\/n\]|\(yes\/no\)/i.test(tail)) {
    return { waiting: true, reason: 'confirm', text: lastMeaningful };
  }
  // Rule: numbered list + question word (both Chinese and English)
  const hasList = /(^|\n)\s*[1-9][.\)]\s+\S|(^|\n)\s*[①②③④⑤⑥⑦⑧⑨]/m.test(tail);
  const hasQWord = /\b(which|what|choose|select|option|pick)\b|哪个|哪一|请选择|请确认|选择|选 ?[一二三1-9]/i.test(tail);
  if (hasList && hasQWord) {
    return { waiting: true, reason: 'choice', text: lastMeaningful };
  }
  // Rule: last meaningful line ends with ? / ？ and is short enough to be a question
  if (lastMeaningful.length < 200 && /[?？]\s*$/.test(lastMeaningful)) {
    return { waiting: true, reason: 'question', text: lastMeaningful };
  }
  return { waiting: false };
}

/** Signature: last question text. Used to distinguish real Q&A turns from TUI noise. */
function getQuestionsSignature(sessionId) {
  const qs = extractUserQuestions(sessionId);
  return qs.length === 0 ? '' : qs[qs.length - 1].slice(0, 200);
}

function readTerminalPreview(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;

  const questions = extractUserQuestions(sessionId);
  if (questions.length === 0) return;

  const lastQ = questions[questions.length - 1];
  const newPreview = lastQ.length > 60 ? lastQ.substring(0, 58) + '…' : lastQ;

  // Preview text only; sort time + unread are bumped on AI reply completion.
  // If we've already received an authoritative preview from the CC transcript
  // hook, don't let the regex fallback overwrite it with potentially-stale
  // buffer content.
  if (session._previewFromTranscript) return;
  if (newPreview && newPreview !== session.lastOutputPreview) {
    session.lastOutputPreview = newPreview;
    renderSessionList();
    schedulePersist();
  }
}

function onTerminalOutput(sessionId, dataLen) {
  const session = sessions.get(sessionId);
  if (!session) return;

  // Track data volume in current burst
  dataCounters.set(sessionId, (dataCounters.get(sessionId) || 0) + dataLen);

  // Only mark running if significant data (>200 bytes), not status bar refreshes
  if (dataCounters.get(sessionId) > 200 && session.status !== 'running') {
    session.status = 'running';
    renderSessionList();
    if (typeof _updateStreamingIndicator === 'function') _updateStreamingIndicator(sessionId);
  }

  // Reset silence timer
  if (silenceTimers.has(sessionId)) clearTimeout(silenceTimers.get(sessionId));
  silenceTimers.set(sessionId, setTimeout(() => {
    silenceTimers.delete(sessionId);
    dataCounters.delete(sessionId);

    const wasRunning = session.status === 'running';
    if (wasRunning) {
      session.status = 'idle';
      if (typeof _updateStreamingIndicator === 'function') _updateStreamingIndicator(sessionId);
    }

    readTerminalPreview(sessionId);

    // Semantic signal: unread/time bump only when the last-question signature
    // actually changed (= a new Q&A turn), not just on any running→idle cycle.
    // This ignores Claude Code's periodic TUI redraws (status bar, context %).
    //
    // v0.13 · P0 #3: silence fallback 改"距上次 Stop hook ≥ 5s 才接管"，
    // 不再依赖 hookUp 全局标志。覆盖两类漏报：
    //   (a) hook server up 但 CC 单次 hook drop（HTTP 5xx / agent SDK 子调用）
    //   (b) Hub 启动初期 hook server 未就绪的 1~2s 窗口
    // 仍受 signature 比较保护，与 Stop hook 路径并存不会 double bump。
    const lastStopMs = Date.now() - (session._lastStopHookTs || 0);
    if (session.lastOutputPreview && lastStopMs >= 5000) {
      const sig = getQuestionsSignature(sessionId);
      const prev = session.readSignature || '';
      if (sig !== prev) {
        session.lastMessageTime = Date.now();
        session.readSignature = sig;
        if (sessionId !== activeSessionId) {
          session.unreadCount = (session.unreadCount || 0) + 1;
        }
      }
    }

    renderSessionList();
  }, SILENCE_MS));
}

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
  if (sess && sess.kind === 'codex') {
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
  } else {
    cached.terminal.write(data);
  }
  onTerminalOutput(sessionId, data.length);

  // Spec 2 partial-update workaround + Spec 3 · B1+B3 优化:
  // transcriptTap.emit('turn-complete') only fires on stop_reason ∈ {end_turn, max_tokens, refusal} —
  // assistant turns with stop_reason='tool_use' wait for the next message; card view lags PTY.
  // Throttle (leading edge) reload card every ~250ms while PTY streams. Not debounce — debounce
  // resets timer on every PTY chunk, so during streaming it never fires until full silence.
  // Spec 3 · B1：传 incremental:true → mount dedup 自动跳过已存在 turn id，无需全清重建
  // Spec 3 · B3：throttle 800→250ms（B1+B2 完成后单次 reload <50ms 才安全调小，否则反向打负载）
  if (sessionId === activeSessionId && currentView === 'card' && typeof loadSessionHistoryToOverlay === 'function') {
    if (!window._cardReloadState) window._cardReloadState = new Map();
    let st = window._cardReloadState.get(sessionId);
    if (!st) { st = { lastReloadAt: 0, pendingTimer: null, inProgress: false }; window._cardReloadState.set(sessionId, st); }
    if (!st.pendingTimer && !st.inProgress) {
      const sinceLast = Date.now() - st.lastReloadAt;
      const delay = Math.max(80, 250 - sinceLast);
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
  }
});

// Status updates from our custom statusline script.
// Carries contextPct / cwd / api time / session_name per session + account-wide usage5h/usage7d.
const accountUsage = { usage5h: null, usage7d: null };
const agentUsage = { gemini: null, codex: null };
const agentUsageLastSeen = { gemini: 0, codex: 0 };
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
let _claudeUsageLastSeen = 0;
// Samples for quota burn-rate attribution. Per-session contextUsed history
// (15 min ring) → tokens/min. Global 5h samples let us estimate tokens-per-pct
// so we can project each session's burn as "% of 5h cap per hour".
const BURN_HISTORY_MS = 15 * 60 * 1000;
const globalUsageSamples = []; // [{t, pct, totalUsedTokens}]
const DEFAULT_TOKENS_PER_PCT = 2_000_000; // fallback baseline if we have no delta

function pruneSamples(arr, now) {
  const cutoff = now - BURN_HISTORY_MS;
  while (arr.length && arr[0].t < cutoff) arr.shift();
}

function aggregateUsedTokens(now) {
  let total = 0;
  for (const s of sessions.values()) {
    // Use each session's most recent contextUsed as a proxy. Not perfect —
    // but good enough to attribute ratably.
    if (typeof s.contextUsed === 'number') total += s.contextUsed;
  }
  return total;
}

function estimateTokensPerPct() {
  // Find two global samples far enough apart with a positive pct delta.
  for (let i = globalUsageSamples.length - 1; i >= 1; i--) {
    const a = globalUsageSamples[i];
    for (let j = i - 1; j >= 0; j--) {
      const b = globalUsageSamples[j];
      if (a.t - b.t < 60 * 1000) continue; // need ≥1 min spread
      const dp = a.pct - b.pct;
      const dt = a.totalUsedTokens - b.totalUsedTokens;
      if (dp > 0.3 && dt > 0) return dt / dp;
    }
  }
  return DEFAULT_TOKENS_PER_PCT;
}

function sessionBurnRate(session) {
  const samples = session._tokenSamples;
  if (!samples || samples.length < 2) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const dt = last.t - first.t;
  if (dt < 60 * 1000) return null;
  const dTokens = last.used - first.used;
  if (dTokens <= 0) return null;
  const tokensPerMin = dTokens / (dt / 60000);
  const tokensPerPct = estimateTokensPerPct();
  const pctPerHour = (tokensPerMin * 60) / tokensPerPct;
  return { tokensPerMin, pctPerHour };
}

ipcRenderer.on('status-event', (_e, payload) => {
  const session = sessions.get(payload.sessionId);
  if (session) {
    session.contextPct = payload.contextPct;
    session.contextUsed = payload.contextUsed;
    session.contextMax = payload.contextMax;
    if (typeof payload.contextUsed === 'number') {
      if (!session._tokenSamples) session._tokenSamples = [];
      session._tokenSamples.push({ t: Date.now(), used: payload.contextUsed });
      pruneSamples(session._tokenSamples, Date.now());
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
    if (payload.sessionName && !session.userRenamed && !session.meetingId && session.title !== payload.sessionName) {
      session.title = payload.sessionName;
      session.claudeSessionName = payload.sessionName;
      if (payload.sessionId === activeSessionId) {
        const el = terminalPanelEl.querySelector('.terminal-title');
        if (el) el.textContent = payload.sessionName;
      }
    }
    if (payload.sessionId === activeSessionId) updateActiveMetricsRow();
  }
  // Usage is account-wide — keep the latest reported values + sample for burn rate.
  if (payload.usage5h) {
    accountUsage.usage5h = payload.usage5h;
    _claudeUsageLastSeen = Date.now();
    const now = Date.now();
    globalUsageSamples.push({ t: now, pct: payload.usage5h.pct, totalUsedTokens: aggregateUsedTokens(now) });
    pruneSamples(globalUsageSamples, now);
  }
  if (payload.usage7d) accountUsage.usage7d = payload.usage7d;
  renderAccountUsage();
  renderSessionList();
});

ipcRenderer.on('agent-usage', (_e, totals) => {
  if (totals.gemini && (totals.gemini.usage5h || totals.gemini.usage7d)) {
    agentUsage.gemini = totals.gemini;
    agentUsageLastSeen.gemini = totals.gemini._ts || Date.now();
  }
  if (totals.codex && (totals.codex.usage5h || totals.codex.usage7d)) {
    agentUsage.codex = totals.codex;
    agentUsageLastSeen.codex = totals.codex._ts || Date.now();
  }
  renderAccountUsage();
});

// Map a model id to a CSS family class for badge coloring.
function modelClass(id) {
  if (!id) return '';
  const s = id.toLowerCase();
  if (s.includes('opus')) return 'opus';
  if (s.includes('sonnet')) return 'sonnet';
  if (s.includes('haiku')) return 'haiku';
  if (s.includes('gemini')) return 'gemini';
  if (s.includes('codex') || s.includes('gpt-5') || s.includes('o3') || s.includes('o4-mini')) return 'codex';
  if (s.includes('deepseek')) return 'deepseek';
  if (s.includes('glm')) return 'glm';
  if (s.includes('gpt')) return 'gpt';
  if (s.includes('kimi')) return 'kimi';
  if (s.includes('qwen')) return 'qwen';
  return '';
}

// Short label for the sidebar badge. display_name is already compact
// ("Opus 4.6 (1M context)"); we strip the parenthetical to keep the pill slim.
function modelShort(m) {
  if (!m) return '';
  const dn = m.displayName || '';
  if (dn) return dn.replace(/\s*\(.*?\)\s*$/, '').trim();
  const id = (m.id || '').toLowerCase();
  if (id.includes('opus')) return 'Opus';
  if (id.includes('sonnet')) return 'Sonnet';
  if (id.includes('haiku')) return 'Haiku';
  if (id.includes('gemini')) return id.replace(/^gemini-/, 'Gemini ').replace(/-/g, ' ');
  if (id.includes('codex')) return 'Codex';
  if (id.includes('deepseek')) return 'DS';
  if (id.includes('glm')) return 'GLM';
  if (id.includes('gpt')) return 'GP';
  if (id.includes('kimi')) return 'KI';
  if (id.includes('qwen')) return 'QW';
  return m.id || '';
}

// Refresh just the terminal-header badge for the active session without a full re-render.
function updateActiveModelBadge() {
  const session = activeSessionId ? sessions.get(activeSessionId) : null;
  if (!session) return;
  const titleSection = terminalPanelEl.querySelector('.terminal-title-section');
  if (!titleSection) return; // header not mounted yet (empty state)
  let badge = titleSection.querySelector('.terminal-model-badge');
  if (!session.currentModel) {
    if (badge) badge.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement('span');
    titleSection.appendChild(badge);
  }
  badge.className = 'terminal-model-badge ' + modelClass(session.currentModel.id);
  badge.textContent = session.currentModel.displayName || modelShort(session.currentModel);
  badge.title = session.currentModel.id + ' — click to switch model';
  // attach after className is set — attach uses classList.add to preserve
  attachModelPickerHandler(badge, activeSessionId);
}

// ---- Model picker dropdown ----
// Per-kind \u6e05\u5355\u5355\u4e00\u771f\u7406\u6e90\u5728 core/model-options.js\uff08spec docs/superpowers/specs/2026-05-01-per-cli-model-picker-design.md\uff09\u3002
// claude / deepseek / glm / gpt / kimi / qwen \u90fd\u8dd1\u5728 claude CLI \u4e0a\uff08\u76f4\u8fde\u6216 ANTHROPIC_BASE_URL \u4e2d\u8f6c\uff09\uff0c
// \u8d70\u539f\u5730 `/model <id>\r` \u5207\u6362\u3002codex / gemini \u7684 PTY \u4e0d\u8bc6\u522b inline `/model`\uff08spec \u00a73.1 \u5df2\u8bba\u8bc1\uff09\uff0c
// picker \u6539\u4e3a\u663e\u793a\u53ea\u8bfb\u6e05\u5355 + \u63d0\u793a"\u91cd\u65b0\u5efa\u7acb session"\u2014\u2014\u907f\u514d\u53d1\u9001\u65e0\u6548\u5207\u6362\u8ba9\u7528\u6237\u8bef\u4ee5\u4e3a\u5207\u4e86\u3002
const { modelOptionsFor, canSwitchInline } = require('../core/model-options.js');

let openModelPicker = null; // { el, badge, onDocClick } while a picker is open

function attachModelPickerHandler(badgeEl, sessionId) {
  if (!badgeEl || badgeEl._modelPickerBound) return;
  badgeEl._modelPickerBound = true;
  badgeEl.classList.add('clickable');
  badgeEl.addEventListener('click', (e) => {
    e.stopPropagation();
    if (openModelPicker && openModelPicker.badge === badgeEl) {
      closeModelPicker();
      return;
    }
    showModelPicker(badgeEl, sessionId);
  });
}

function showModelPicker(badgeEl, sessionId) {
  closeModelPicker();
  const session = sessions.get(sessionId);
  const kind = session && session.kind ? session.kind : '';
  const options = modelOptionsFor(kind);
  const inlineOk = canSwitchInline(kind);
  const currentId = session && session.currentModel ? (session.currentModel.id || '') : '';

  const menu = document.createElement('div');
  menu.className = 'model-picker-menu';

  if (options.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'model-picker-empty';
    empty.textContent = '\u8be5\u4f1a\u8bdd\u7c7b\u578b\u4e0d\u652f\u6301\u6a21\u578b\u5207\u6362';
    menu.appendChild(empty);
  } else {
    if (!inlineOk) {
      const note = document.createElement('div');
      note.className = 'model-picker-note';
      note.textContent = '\u2139 \u8be5 CLI \u4e0d\u652f\u6301\u539f\u5730\u5207\u6362\u6a21\u578b\u2014\u2014\u8bf7\u5173\u95ed\u540e\u65b0\u5efa\u4f1a\u8bdd\u65f6\u9009\u62e9';
      menu.appendChild(note);
    }
    options.forEach((opt) => {
      const item = document.createElement('div');
      item.className = 'model-picker-item';
      if (!inlineOk) item.classList.add('disabled');
      item.dataset.modelId = opt.id;
      if (opt.id === currentId) item.classList.add('current');
      item.innerHTML = `<span class="model-picker-check">${opt.id === currentId ? '\u2713' : ''}</span><span class="model-picker-label">${escapeHtml(opt.label)}</span><span class="model-picker-id">${escapeHtml(opt.id)}</span>`;
      if (inlineOk) {
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          ipcRenderer.send('terminal-input', { sessionId, data: `/model ${opt.id}\r` });
          closeModelPicker();
        });
      } else {
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          // \u53ea\u8bfb\uff1a\u70b9\u51fb\u5173\u95ed menu\uff0c\u4e0d\u53d1 PTY \u8f93\u5165\u3002
          closeModelPicker();
        });
      }
      menu.appendChild(item);
    });
  }

  document.body.appendChild(menu);
  const rect = badgeEl.getBoundingClientRect();
  menu.style.top = (rect.bottom + 4) + 'px';
  menu.style.left = rect.left + 'px';
  const onDocClick = (e) => { if (!menu.contains(e.target)) closeModelPicker(); };
  // defer so the triggering click doesn't immediately close the menu
  setTimeout(() => document.addEventListener('click', onDocClick), 0);
  openModelPicker = { el: menu, badge: badgeEl, onDocClick };
}

function closeModelPicker() {
  if (!openModelPicker) return;
  document.removeEventListener('click', openModelPicker.onDocClick);
  openModelPicker.el.remove();
  openModelPicker = null;
}

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

function formatResetIn(resetsAt) {
  if (!resetsAt) return '';
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (isNaN(ms) || ms <= 0) return '';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h < 24) return `${h}h${m ? ' ' + m + 'm' : ''}`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

// PackyAPI 账户数据(余额 / 今日消耗 / 累计消耗) - main 后台 5min 拉取后通过 IPC 推送
let packyAccountData = null;

function renderAccountUsage() {
  const el = document.getElementById('account-usage');
  if (!el) return;
  el.style.display = 'block';

  const pctCls = (pct) => pct >= 85 ? 'danger' : pct >= 70 ? 'warn' : 'ok';

  const renderBar = (label, u) => {
    const resetTxt = u && u.resetsAt ? formatResetIn(u.resetsAt) : '';
    const resetHtml = resetTxt
      ? `<span class="acc-bar-reset" title="距离 ${label} 配额刷新还有 ${resetTxt}">${resetTxt}</span>`
      : `<span class="acc-bar-reset"></span>`;
    if (!u || u.pct === null || u.pct === undefined) {
      return `<div class="acc-bar-line"><span class="acc-bar-label">${label}</span><div class="acc-bar-track"><div class="acc-bar-fill dim" style="width:0%"></div></div><span class="acc-bar-pct dim">—</span>${resetHtml}</div>`;
    }
    const pct = Math.round(u.pct);
    const cls = pctCls(pct);
    const w = Math.max(2, pct);
    return `<div class="acc-bar-line"><span class="acc-bar-label">${label}</span><div class="acc-bar-track"><div class="acc-bar-fill ${cls}" style="width:${w}%"></div></div><span class="acc-bar-pct ${cls}">${pct}%</span>${resetHtml}</div>`;
  };

  const logoSrc = (badgeClass) => {
    if (badgeClass === 'cl') return 'assets/ai-logos/claude.svg';
    if (badgeClass === 'cx') return 'assets/ai-logos/codex.svg';
    return '';
  };
  const renderUsageRow = (badgeClass, name, u5h, u7d) => {
    const src = logoSrc(badgeClass);
    const logoHtml = src
      ? `<img class="acc-ai-logo" src="${src}" alt="${escapeHtml(name)}" title="${escapeHtml(name)}">`
      : `<span class="acc-ai-letters">${badgeClass.toUpperCase()}</span>`;
    return `
      <div class="acc-usage-row" title="${escapeHtml(name)}">
        <span class="acc-ai-badge ${badgeClass}">${logoHtml}</span>
        <div class="acc-bars">
          ${renderBar('5h', u5h)}
          ${renderBar('7d', u7d)}
        </div>
      </div>
    `;
  };

  const renderPackyRow = (data) => {
    if (!data || !data.enabled) {
      return `<div class="acc-packy-row no-cookie clickable" data-action="open-packy-settings" title="点击打开设置 → 填 PackyAPI cookie 启用余额监控">
        <span class="acc-packy-icon">$</span>
        <div class="acc-packy-text">
          <div class="acc-packy-balance-line"><span class="acc-packy-balance">未接入</span></div>
          <div class="acc-packy-spend-line">点击此处填 cookie</div>
        </div>
      </div>`;
    }
    const fmt = (n) => '$' + (typeof n === 'number' ? n.toFixed(2) : '—');
    if (data.error && (data.balanceUsd === null || data.balanceUsd === undefined)) {
      return `<div class="acc-packy-row error clickable" data-action="open-packy-settings" title="${escapeHtml(data.error)} · 点击打开设置重填 cookie">
        <span class="acc-packy-icon">!</span>
        <div class="acc-packy-text">
          <div class="acc-packy-balance-line"><span class="acc-packy-balance">cookie 失效</span></div>
          <div class="acc-packy-spend-line">今日 ${fmt(data.todayUsd)} · 点击重填</div>
        </div>
      </div>`;
    }
    const balance = (data.balanceUsd !== null && data.balanceUsd !== undefined) ? fmt(data.balanceUsd) : '—';
    const total = (data.usedUsd !== null && data.usedUsd !== undefined) ? fmt(data.usedUsd) : '—';
    // 注:packyapi 的 /v1/dashboard/billing/usage 端点不响应 date 参数,
    // 无法做"今日 vs 累计"的区分。只显示累计消耗,避免数据相同造成误导。
    return `<div class="acc-packy-row" title="PackyAPI · ${escapeHtml(data.displayName || '账户')}">
      <span class="acc-packy-icon">¥</span>
      <div class="acc-packy-text">
        <div class="acc-packy-balance-line">
          <span class="acc-packy-balance">${balance}</span>
          <span class="acc-packy-balance-label">余额</span>
        </div>
        <div class="acc-packy-spend-line">
          <span>累计消耗 <span class="acc-packy-spend-today">${total}</span></span>
        </div>
      </div>
      <button class="acc-packy-topup" data-action="packy-topup">充值</button>
    </div>`;
  };

  const c = agentUsage.codex || {};
  el.innerHTML =
    renderUsageRow('cl', 'Claude', accountUsage.usage5h, accountUsage.usage7d) +
    renderUsageRow('cx', 'Codex', c.usage5h, c.usage7d) +
    renderPackyRow(packyAccountData);

  // 充值按钮 — 打开 packyapi console
  const topupBtn = el.querySelector('[data-action="packy-topup"]');
  if (topupBtn) {
    topupBtn.addEventListener('click', () => {
      ipcRenderer.invoke('open-external-url', 'https://www.packyapi.com/console').catch(() => {
        window.open('https://www.packyapi.com/console', '_blank');
      });
    });
  }
  // 未接入 / cookie 失效 整行可点击 → 打开设置并定位到 cookie 输入框
  el.querySelectorAll('[data-action="open-packy-settings"]').forEach(row => {
    row.addEventListener('click', async () => {
      try {
        await openConfigModal();
        const cookieEl = document.getElementById('cfg-packy-cookie');
        if (cookieEl) {
          cookieEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          setTimeout(() => cookieEl.focus(), 200);
        }
      } catch {}
    });
  });
}

ipcRenderer.on('packy-account-updated', (_e, data) => {
  packyAccountData = data;
  renderAccountUsage();
});

setInterval(renderAccountUsage, 60000);

function pctClass(pct) {
  if (pct >= 85) return 'danger';
  if (pct >= 70) return 'warn';
  return 'ok';
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

// --- Context menu (right-click session) ---
function openContextMenu(sessionId, x, y) {
  contextMenuSessionId = sessionId;
  contextMenuEl.style.display = 'block';
  contextMenuEl.style.left = `${x}px`;
  contextMenuEl.style.top = `${y}px`;
  requestAnimationFrame(() => {
    const rect = contextMenuEl.getBoundingClientRect();
    if (rect.right > window.innerWidth) contextMenuEl.style.left = `${x - rect.width}px`;
    if (rect.bottom > window.innerHeight) contextMenuEl.style.top = `${y - rect.height}px`;
  });
  const pinBtn = contextMenuEl.querySelector('[data-action="pin"]');
  const restartBtn = contextMenuEl.querySelector('[data-action="restart"]');
  if (pinBtn) pinBtn.style.display = '';
  if (restartBtn) restartBtn.style.display = '';
  const session = sessions.get(sessionId);
  if (pinBtn && session) pinBtn.textContent = session.pinned ? 'Unpin' : 'Pin to top';
}

function closeContextMenu() {
  contextMenuEl.style.display = 'none';
  contextMenuSessionId = null;
}

document.addEventListener('mousedown', (e) => {
  if (contextMenuEl.style.display === 'block' && !contextMenuEl.contains(e.target)) {
    closeContextMenu();
  }
});

for (const btn of contextMenuEl.querySelectorAll('.context-menu-item')) {
  btn.addEventListener('click', async () => {
    const action = btn.dataset.action;
    const sid = contextMenuSessionId;
    closeContextMenu();
    if (!sid) return;

    const session = sessions.get(sid);

    if (action === 'close' && meetings[sid]) {
      await ipcRenderer.invoke('close-meeting', sid);
      delete meetings[sid];
      if (activeMeetingId === sid) {
        activeMeetingId = null;
        if (typeof MeetingRoom !== 'undefined') MeetingRoom.closeMeetingPanel();
        if (emptyStateEl) emptyStateEl.style.display = '';
      }
      renderSessionList();
      schedulePersist();
      return;
    }

    if (!session) return;

    if (action === 'pin') {
      session.pinned = !session.pinned;
      renderSessionList();
      schedulePersist();
    } else if (action === 'restart') {
      await ipcRenderer.invoke('restart-session', sid);
    } else if (action === 'close') {
      if (session && session.status === 'dormant') {
        sessions.delete(sid);
        if (activeSessionId === sid) activeSessionId = null;
        renderSessionList();
        schedulePersist();
      } else {
        await ipcRenderer.invoke('close-session', sid);
      }
    }
  });
}

// --- Terminal context menu (right-click selected text → Preview) ---
const termCtxMenuEl = document.getElementById('terminal-context-menu');
let termCtxMenuSelection = null;

function openTerminalContextMenu(selection, x, y) {
  termCtxMenuSelection = selection;
  termCtxMenuEl.style.display = 'block';
  termCtxMenuEl.style.left = `${x}px`;
  termCtxMenuEl.style.top = `${y}px`;
  requestAnimationFrame(() => {
    const rect = termCtxMenuEl.getBoundingClientRect();
    if (rect.right > window.innerWidth) termCtxMenuEl.style.left = `${x - rect.width}px`;
    if (rect.bottom > window.innerHeight) termCtxMenuEl.style.top = `${y - rect.height}px`;
  });
}

function closeTerminalContextMenu() {
  termCtxMenuEl.style.display = 'none';
  termCtxMenuSelection = null;
}

document.addEventListener('mousedown', (e) => {
  if (termCtxMenuEl.style.display === 'block' && !termCtxMenuEl.contains(e.target)) {
    closeTerminalContextMenu();
  }
});

termCtxMenuEl.querySelector('[data-action="preview"]').addEventListener('click', () => {
  const sel = termCtxMenuSelection;
  closeTerminalContextMenu();
  if (sel) openPreviewPanel(sel.trim());
});

// --- Terminal in-buffer search (Ctrl+F) ---
const termSearchEl = document.getElementById('terminal-search');
const termSearchInput = document.getElementById('terminal-search-input');
const termSearchCount = document.getElementById('terminal-search-count');
const termSearchPrev = document.getElementById('terminal-search-prev');
const termSearchNext = document.getElementById('terminal-search-next');
const termSearchClose = document.getElementById('terminal-search-close');

function openTerminalSearch() {
  termSearchEl.style.display = 'flex';
  termSearchInput.focus();
  termSearchInput.select();
}
function closeTerminalSearch() {
  termSearchEl.style.display = 'none';
  const cached = terminalCache.get(activeSessionId);
  if (cached && cached.searchAddon) cached.searchAddon.clearDecorations();
  if (cached) cached.terminal.focus();
}

const SEARCH_OPTS = {
  decorations: {
    matchBackground: '#58a6ff66',
    matchBorder: '#58a6ff',
    matchOverviewRuler: '#58a6ff',
    activeMatchBackground: '#f0883e88',
    activeMatchBorder: '#f0883e',
    activeMatchColorOverviewRuler: '#f0883e',
  },
};

function runSearch(direction) {
  const cached = terminalCache.get(activeSessionId);
  if (!cached || !cached.searchAddon) return;
  const q = termSearchInput.value;
  if (!q) { cached.searchAddon.clearDecorations(); termSearchCount.textContent = ''; return; }
  const found = direction >= 0
    ? cached.searchAddon.findNext(q, SEARCH_OPTS)
    : cached.searchAddon.findPrevious(q, SEARCH_OPTS);
  termSearchCount.textContent = found ? '' : 'no match';
}

termSearchInput.addEventListener('input', () => runSearch(1));
termSearchInput.addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Enter') { e.preventDefault(); runSearch(e.shiftKey ? -1 : 1); }
  else if (e.key === 'Escape') { e.preventDefault(); closeTerminalSearch(); }
});
termSearchPrev.addEventListener('click', () => runSearch(-1));
termSearchNext.addEventListener('click', () => runSearch(1));
termSearchClose.addEventListener('click', closeTerminalSearch);

// --- Sidebar collapse ---
const SIDEBAR_KEY = 'claude-hub-sidebar-collapsed';
function applySidebarCollapsed(collapsed) {
  appContainerEl.classList.toggle('sidebar-collapsed', collapsed);
  // After CSS transition, refit active xterm so it claims the new width.
  setTimeout(() => {
    const cached = terminalCache.get(activeSessionId);
    if (!cached) return;
    try { cached.fitAddon.fit(); } catch (_) {}
    ipcRenderer.send('terminal-resize', {
      sessionId: activeSessionId,
      cols: cached.terminal.cols,
      rows: cached.terminal.rows,
    });
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

// --- Theme selector ---
const THEME_CLASSES = ['theme-midnight', 'theme-obsidian', 'theme-aurora', 'theme-light'];
const XTERM_THEMES = {
  default: {
    background: '#0d1117', foreground: '#f0f6fc', cursor: '#58a6ff',
    cursorAccent: '#0d1117', selectionBackground: 'rgba(88, 166, 255, 0.3)',
    black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922',
    blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39d353', white: '#f0f6fc',
    brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364',
    brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff',
    brightCyan: '#56d364', brightWhite: '#ffffff',
  },
  midnight: {
    background: '#080c14', foreground: '#c8d8f0', cursor: '#58a6ff',
    cursorAccent: '#080c14', selectionBackground: 'rgba(88, 166, 255, 0.3)',
    black: '#1a2540', red: '#ff7b72', green: '#39d353', yellow: '#d29922',
    blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39d353', white: '#c8d8f0',
    brightBlack: '#3a4a68', brightRed: '#ffa198', brightGreen: '#56d364',
    brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff',
    brightCyan: '#56d364', brightWhite: '#e0ecff',
  },
  obsidian: {
    background: '#0a0a0a', foreground: '#d4c4a8', cursor: '#e8a040',
    cursorAccent: '#0a0a0a', selectionBackground: 'rgba(232, 160, 64, 0.25)',
    black: '#1a1a1a', red: '#ff7b72', green: '#e8a040', yellow: '#f0b860',
    blue: '#c8a878', magenta: '#d4a080', cyan: '#e8a040', white: '#d4c4a8',
    brightBlack: '#504030', brightRed: '#ffa198', brightGreen: '#f0b860',
    brightYellow: '#f8d080', brightBlue: '#d8c098', brightMagenta: '#e0b898',
    brightCyan: '#f0b860', brightWhite: '#e8d8c0',
  },
  aurora: {
    background: '#0b0e13', foreground: '#b0d0e0', cursor: '#7ee8c8',
    cursorAccent: '#0b0e13', selectionBackground: 'rgba(126, 232, 200, 0.25)',
    black: '#1a1f28', red: '#ff7b72', green: '#7ee8c8', yellow: '#d29922',
    blue: '#58a6ff', magenta: '#bc8cff', cyan: '#7ee8c8', white: '#b0d0e0',
    brightBlack: '#384858', brightRed: '#ffa198', brightGreen: '#a0f0d8',
    brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff',
    brightCyan: '#a0f0d8', brightWhite: '#d0e8f0',
  },
};
function applyTheme(name) {
  THEME_CLASSES.forEach(c => document.body.classList.remove(c));
  if (name && name !== 'default') document.body.classList.add('theme-' + name);
  localStorage.setItem('claude-hub-theme', name || 'default');
  const popup = document.getElementById('theme-picker-popup');
  if (popup) {
    for (const opt of popup.querySelectorAll('.theme-option')) {
      opt.classList.toggle('active', (opt.dataset.theme || 'default') === (name || 'default'));
    }
  }
  const xt = XTERM_THEMES[name] || XTERM_THEMES.default;
  for (const [, cached] of terminalCache) {
    cached.terminal.options.theme = xt;
  }
}
(function initThemePicker() {
  const saved = localStorage.getItem('claude-hub-theme') || 'default';
  applyTheme(saved);
  // 主题切换通过"选项"菜单触发
  const optionsBtn = document.getElementById('btn-options');
  const optionsMenu = document.getElementById('options-menu');
  const themeItem = document.getElementById('options-theme');
  const themePopup = document.getElementById('theme-picker-popup');
  if (!optionsBtn || !optionsMenu) return;

  // 选项菜单展开/收起
  optionsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    optionsMenu.style.display = optionsMenu.style.display === 'none' ? 'block' : 'none';
  });
  document.addEventListener('mousedown', (e) => {
    if (!optionsBtn.contains(e.target) && !optionsMenu.contains(e.target)) {
      optionsMenu.style.display = 'none';
    }
  });

  // 主题选项点击 -> 显示主题选择弹窗
  if (themeItem && themePopup) {
    themeItem.addEventListener('click', (e) => {
      e.stopPropagation();
      themePopup.style.display = 'block';
      optionsMenu.style.display = 'none';
    });
    for (const opt of themePopup.querySelectorAll('.theme-option')) {
      opt.addEventListener('click', () => {
        applyTheme(opt.dataset.theme);
        themePopup.style.display = 'none';
      });
    }
    document.addEventListener('mousedown', (e) => {
      if (!themePopup.contains(e.target)) themePopup.style.display = 'none';
    });
  }

  // 设置选项点击 -> 打开配置面板
  const settingsItem = document.getElementById('options-settings');
  if (settingsItem) {
    settingsItem.addEventListener('click', async (e) => {
      e.stopPropagation();
      optionsMenu.style.display = 'none';
      openConfigModal();
    });
  }
})();

// --- Config/Settings Modal (API key + proxy) ---
const CONFIG_AI_META = {
  claude: {
    title: 'Claude 设置',
    hint: '使用当前本机 Claude Code 订阅登录状态。Hub 保持现有订阅启动方式。',
    status: '订阅',
    statusClass: 'subscription',
  },
  gemini: {
    title: 'Gemini 设置',
    hint: '使用当前本机 Gemini CLI 登录状态。代理设置会影响新建 Gemini 会话。',
    status: '订阅',
    statusClass: 'subscription',
  },
  codex: {
    title: 'Codex 设置',
    hint: '全 Hub 新建 Codex 会话统一生效。API 模式会使用隔离 CODEX_HOME，不污染本机订阅配置。',
  },
  deepseek: {
    title: 'DeepSeek 设置',
    hint: 'DeepSeek 当前通过 API 接入，新建 DeepSeek 会话生效。',
    status: 'API',
    statusClass: 'api',
  },
  glm: {
    title: 'GLM 设置',
    hint: 'GLM 当前通过 API 接入，新建 GLM 会话生效。',
    status: 'API',
    statusClass: 'api',
  },
  gpt: {
    title: 'GPT 设置',
    hint: 'GPT 当前通过 PackyAPI codex 分组的 Anthropic 兼容端点接入，新建 GPT 会话生效。',
    status: 'API',
    statusClass: 'api',
  },
  kimi: {
    title: 'Kimi 设置',
    hint: 'Kimi 当前通过 PackyAPI bailian 分组的 Anthropic 兼容端点接入，新建 Kimi 会话生效。',
    status: 'API',
    statusClass: 'api',
  },
  qwen: {
    title: 'Qwen 设置',
    hint: 'Qwen 当前通过 PackyAPI bailian 分组的 Anthropic 兼容端点接入（与 Kimi 共享 bailian key），新建 Qwen 会话生效。',
    status: 'API',
    statusClass: 'api',
  },
};

let activeConfigAi = 'codex';

function configEl(id) {
  return document.getElementById(id);
}

function setConfigStatus(el, label, cls) {
  if (!el) return;
  el.textContent = label;
  el.className = 'config-ai-status ' + (cls || '');
}

function updateConfigSummaries() {
  const codexBackend = configEl('cfg-codex-backend') ? configEl('cfg-codex-backend').value : 'subscription';
  const codexModel = configEl('cfg-codex-model') ? (configEl('cfg-codex-model').value.trim() || 'gpt-5.5') : 'gpt-5.5';
  const codexKey = configEl('cfg-codex-key') ? configEl('cfg-codex-key').value.trim() : '';
  const deepseekKey = configEl('cfg-deepseek-key') ? configEl('cfg-deepseek-key').value.trim() : '';
  const glmKey = configEl('cfg-glm-key') ? configEl('cfg-glm-key').value.trim() : '';
  const glmModel = configEl('cfg-glm-model') ? (configEl('cfg-glm-model').value.trim() || 'glm-5.1') : 'glm-5.1';
  const gptKey = configEl('cfg-gpt-key') ? configEl('cfg-gpt-key').value.trim() : '';
  const gptModel = configEl('cfg-gpt-model') ? (configEl('cfg-gpt-model').value.trim() || 'gpt-5.4-high') : 'gpt-5.4-high';
  const kimiKey = configEl('cfg-kimi-key') ? configEl('cfg-kimi-key').value.trim() : '';
  const kimiModel = configEl('cfg-kimi-model') ? (configEl('cfg-kimi-model').value.trim() || 'kimi-k2.5') : 'kimi-k2.5';
  const qwenKey = configEl('cfg-qwen-key') ? configEl('cfg-qwen-key').value.trim() : '';
  const qwenModel = configEl('cfg-qwen-model') ? (configEl('cfg-qwen-model').value.trim() || 'qwen3.6-plus') : 'qwen3.6-plus';

  const codexSummary = configEl('cfg-summary-codex');
  if (codexSummary) {
    codexSummary.textContent = codexBackend === 'api'
      ? `第三方 API · ${codexModel} · Packy`
      : `订阅模式 · ${codexModel}`;
  }
  setConfigStatus(
    configEl('cfg-status-codex'),
    codexBackend === 'api' ? (codexKey ? 'API' : '缺 Key') : '订阅',
    codexBackend === 'api' ? (codexKey ? 'api' : 'missing') : 'subscription'
  );

  const deepseekSummary = configEl('cfg-summary-deepseek');
  if (deepseekSummary) deepseekSummary.textContent = deepseekKey ? 'API · deepseek-v4-pro' : 'API · 未配置 Key';
  setConfigStatus(configEl('cfg-status-deepseek'), deepseekKey ? 'API' : '缺 Key', deepseekKey ? 'api' : 'missing');

  const glmSummary = configEl('cfg-summary-glm');
  if (glmSummary) glmSummary.textContent = glmKey ? `API · ${glmModel}` : 'API · 未配置 Key';
  setConfigStatus(configEl('cfg-status-glm'), glmKey ? 'API' : '缺 Key', glmKey ? 'api' : 'missing');

  const gptSummary = configEl('cfg-summary-gpt');
  if (gptSummary) gptSummary.textContent = gptKey ? `API · ${gptModel} · Packy` : 'API · 未配置 Key';
  setConfigStatus(configEl('cfg-status-gpt'), gptKey ? 'API' : '缺 Key', gptKey ? 'api' : 'missing');

  const kimiSummary = configEl('cfg-summary-kimi');
  if (kimiSummary) kimiSummary.textContent = kimiKey ? `API · ${kimiModel} · Packy` : 'API · 未配置 Key';
  setConfigStatus(configEl('cfg-status-kimi'), kimiKey ? 'API' : '缺 Key', kimiKey ? 'api' : 'missing');

  const qwenSummary = configEl('cfg-summary-qwen');
  if (qwenSummary) qwenSummary.textContent = qwenKey ? `API · ${qwenModel} · Packy` : 'API · 未配置 Key';
  setConfigStatus(configEl('cfg-status-qwen'), qwenKey ? 'API' : '缺 Key', qwenKey ? 'api' : 'missing');

  if (activeConfigAi === 'codex') {
    setConfigStatus(
      configEl('cfg-detail-status'),
      codexBackend === 'api' ? (codexKey ? 'API' : '缺 Key') : '订阅',
      codexBackend === 'api' ? (codexKey ? 'api' : 'missing') : 'subscription'
    );
  } else if (activeConfigAi === 'deepseek') {
    setConfigStatus(configEl('cfg-detail-status'), deepseekKey ? 'API' : '缺 Key', deepseekKey ? 'api' : 'missing');
  } else if (activeConfigAi === 'glm') {
    setConfigStatus(configEl('cfg-detail-status'), glmKey ? 'API' : '缺 Key', glmKey ? 'api' : 'missing');
  } else if (activeConfigAi === 'gpt') {
    setConfigStatus(configEl('cfg-detail-status'), gptKey ? 'API' : '缺 Key', gptKey ? 'api' : 'missing');
  } else if (activeConfigAi === 'kimi') {
    setConfigStatus(configEl('cfg-detail-status'), kimiKey ? 'API' : '缺 Key', kimiKey ? 'api' : 'missing');
  } else if (activeConfigAi === 'qwen') {
    setConfigStatus(configEl('cfg-detail-status'), qwenKey ? 'API' : '缺 Key', qwenKey ? 'api' : 'missing');
  }
}

function showConfigMainView() {
  if (configEl('config-main-view')) configEl('config-main-view').classList.remove('hidden');
  if (configEl('config-detail-view')) configEl('config-detail-view').classList.add('hidden');
  document.querySelectorAll('.config-ai-row').forEach(row => row.classList.remove('active'));
  updateConfigSummaries();
}

function showConfigDetail(ai) {
  activeConfigAi = ai || 'codex';
  const meta = CONFIG_AI_META[activeConfigAi] || CONFIG_AI_META.codex;
  if (configEl('config-main-view')) configEl('config-main-view').classList.add('hidden');
  if (configEl('config-detail-view')) configEl('config-detail-view').classList.remove('hidden');
  if (configEl('cfg-detail-title')) configEl('cfg-detail-title').textContent = meta.title;
  if (configEl('cfg-detail-hint')) configEl('cfg-detail-hint').textContent = meta.hint;
  document.querySelectorAll('.config-ai-row').forEach(row => row.classList.toggle('active', row.dataset.ai === activeConfigAi));
  document.querySelectorAll('.config-ai-detail').forEach(panel => panel.classList.toggle('active', panel.id === 'cfg-detail-' + activeConfigAi));

  if (meta.status) {
    setConfigStatus(configEl('cfg-detail-status'), meta.status, meta.statusClass);
  }
  updateConfigSummaries();
}

async function openConfigModal() {
  const modal = document.getElementById('config-modal');
  if (!modal) return;

  // 加载当前配置
  try {
    const cfg = await ipcRenderer.invoke('get-hub-config-raw');
    providerModes.codex = cfg.codexBackend === 'api' ? 'api' : 'subscription';
    document.getElementById('cfg-proxy').value = cfg.proxy || '';
    document.getElementById('cfg-deepseek-key').value = cfg.deepseekApiKey || '';
    document.getElementById('cfg-codex-backend').value = cfg.codexBackend || 'subscription';
    document.getElementById('cfg-codex-key').value = cfg.codexApiKey || '';
    document.getElementById('cfg-codex-url').value = cfg.codexApiBaseUrl || '';
    document.getElementById('cfg-codex-model').value = cfg.codexApiModel || '';
    document.getElementById('cfg-glm-key').value = cfg.glmApiKey || '';
    document.getElementById('cfg-glm-url').value = cfg.glmBaseUrl || '';
    document.getElementById('cfg-glm-model').value = cfg.glmModel || '';
    document.getElementById('cfg-gpt-key').value = cfg.gptApiKey || '';
    document.getElementById('cfg-gpt-url').value = cfg.gptBaseUrl || '';
    document.getElementById('cfg-gpt-model').value = cfg.gptModel || '';
    document.getElementById('cfg-kimi-key').value = cfg.kimiApiKey || '';
    document.getElementById('cfg-kimi-url').value = cfg.kimiBaseUrl || '';
    document.getElementById('cfg-kimi-model').value = cfg.kimiModel || '';
    document.getElementById('cfg-qwen-key').value = cfg.qwenApiKey || '';
    document.getElementById('cfg-qwen-url').value = cfg.qwenBaseUrl || '';
    document.getElementById('cfg-qwen-model').value = cfg.qwenModel || '';
    const packyEl = document.getElementById('cfg-packy-cookie');
    if (packyEl) packyEl.value = cfg.packySessionCookie || '';
    const expiresEl = document.getElementById('cfg-packy-expires');
    if (expiresEl) expiresEl.textContent = cfg.packySessionCookie ? '已配置' : '未配置';
    updateConfigSummaries();
  } catch {
    // 加载失败也显示空白面板
  }
  showConfigMainView();
  modal.classList.remove('hidden');
}

function closeConfigModal() {
  const modal = document.getElementById('config-modal');
  if (modal) modal.classList.add('hidden');
  const msg = document.getElementById('config-save-msg');
  if (msg) { msg.style.display = 'none'; msg.textContent = ''; }
}

// 配置面板事件（DOM ready 后绑定）
function initConfigModal() {
  const modal = document.getElementById('config-modal');
  if (!modal) return;

  document.getElementById('config-close').addEventListener('click', closeConfigModal);
  document.getElementById('config-cancel').addEventListener('click', closeConfigModal);
  const backBtn = document.getElementById('config-back');
  if (backBtn) backBtn.addEventListener('click', showConfigMainView);
  document.querySelectorAll('.config-ai-row').forEach(row => {
    row.addEventListener('click', () => showConfigDetail(row.dataset.ai));
  });
  ['cfg-codex-backend', 'cfg-codex-key', 'cfg-codex-url', 'cfg-codex-model', 'cfg-deepseek-key', 'cfg-glm-key', 'cfg-glm-url', 'cfg-glm-model', 'cfg-gpt-key', 'cfg-gpt-url', 'cfg-gpt-model', 'cfg-kimi-key', 'cfg-kimi-url', 'cfg-kimi-model', 'cfg-qwen-key', 'cfg-qwen-url', 'cfg-qwen-model'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', updateConfigSummaries);
    if (el) el.addEventListener('change', updateConfigSummaries);
  });
  modal.addEventListener('click', (e) => { if (e.target === modal) closeConfigModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
      e.preventDefault(); closeConfigModal();
    }
  });

  document.getElementById('config-save').addEventListener('click', async () => {
    const msg = document.getElementById('config-save-msg');
    const newConfig = {
      proxy: document.getElementById('cfg-proxy').value.trim() || undefined,
      deepseekApiKey: document.getElementById('cfg-deepseek-key').value.trim() || undefined,
      codexBackend: document.getElementById('cfg-codex-backend').value,
      codexApiKey: document.getElementById('cfg-codex-key').value.trim() || undefined,
      codexApiBaseUrl: document.getElementById('cfg-codex-url').value.trim() || undefined,
      codexApiModel: document.getElementById('cfg-codex-model').value.trim() || undefined,
      glmApiKey: document.getElementById('cfg-glm-key').value.trim() || undefined,
      glmBaseUrl: document.getElementById('cfg-glm-url').value.trim() || undefined,
      glmModel: document.getElementById('cfg-glm-model').value.trim() || undefined,
      gptApiKey: document.getElementById('cfg-gpt-key').value.trim() || undefined,
      gptBaseUrl: document.getElementById('cfg-gpt-url').value.trim() || undefined,
      gptModel: document.getElementById('cfg-gpt-model').value.trim() || undefined,
      kimiApiKey: document.getElementById('cfg-kimi-key').value.trim() || undefined,
      kimiBaseUrl: document.getElementById('cfg-kimi-url').value.trim() || undefined,
      kimiModel: document.getElementById('cfg-kimi-model').value.trim() || undefined,
      qwenApiKey: document.getElementById('cfg-qwen-key').value.trim() || undefined,
      qwenBaseUrl: document.getElementById('cfg-qwen-url').value.trim() || undefined,
      qwenModel: document.getElementById('cfg-qwen-model').value.trim() || undefined,
      packySessionCookie: (document.getElementById('cfg-packy-cookie') && document.getElementById('cfg-packy-cookie').value.trim()) || undefined,
    };
    try {
      const result = await ipcRenderer.invoke('save-hub-config', newConfig);
      if (result && result.success) {
        providerModes.codex = newConfig.codexBackend === 'api' ? 'api' : 'subscription';
        renderAccountUsage();
        msg.textContent = '配置已保存。新创建的 Codex / GLM / DeepSeek / GPT / Kimi / Qwen 会话将立即生效。';
        msg.className = 'config-save-msg success';
        msg.style.display = 'block';
        setTimeout(() => { msg.style.display = 'none'; }, 4000);
      } else {
        throw new Error('save failed');
      }
    } catch (err) {
      msg.textContent = '保存失败: ' + (err.message || '未知错误');
      msg.className = 'config-save-msg error';
      msg.style.display = 'block';
    }
  });
}
document.addEventListener('DOMContentLoaded', initConfigModal);
// 如果 DOM 已经 ready 也立即尝试
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  setTimeout(initConfigModal, 0);
}

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
      ccSessionId: existing.ccSessionId,
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
  // 新建/resume session 强制 PTY 视图，用户手动点"卡片"才进卡片模式
  applyViewMode('pty');
  showTerminal(session.id);
});

// Spec 3 · W12：transcript-tap session-bound 触发的 IPC，内存 sessions Map 同步
// codex/gemini 的 resume meta（之前只落盘 lastPersistedSessions，renderer 内存
// 拿不到 → reboot 才生效）。Claude/claude-resume 不走这条（ccSessionId 走 hook-event）。
ipcRenderer.on('session-meta-updated', (_e, ev) => {
  if (!ev || !ev.hubSessionId) return;
  const s = sessions.get(ev.hubSessionId);
  if (!s) return;
  if (ev.codexSid && !s.codexSid) s.codexSid = ev.codexSid;
  if (ev.geminiChatId && !s.geminiChatId) s.geminiChatId = ev.geminiChatId;
  if (ev.geminiProjectHash && !s.geminiProjectHash) s.geminiProjectHash = ev.geminiProjectHash;
  if (ev.geminiProjectRoot && !s.geminiProjectRoot) s.geminiProjectRoot = ev.geminiProjectRoot;
});

// Spec 3 · W13：清理 _cardReloadState 的 session 条目，防 Map 长期累积。
// session-closed 触发，确保即使 inProgress 异常残留也不影响新生命周期同 sessionId 的 session。
ipcRenderer.on('session-closed', (_e, { sessionId }) => {
  if (window._cardReloadState && window._cardReloadState.has(sessionId)) {
    const st = window._cardReloadState.get(sessionId);
    if (st && st.pendingTimer) { try { clearTimeout(st.pendingTimer); } catch {} }
    window._cardReloadState.delete(sessionId);
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
  if (silenceTimers.has(sessionId)) {
    clearTimeout(silenceTimers.get(sessionId));
    silenceTimers.delete(sessionId);
  }
  dataCounters.delete(sessionId);
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
  local.title = session.title;
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
      // 持久化白名单：圆桌会议 + 所有 AI kind（含 -resume 变体）。新增 AI 由 ai-kinds.js 单一真理源覆盖。
      if (!s.meetingId && !isAiKind(s.kind) && s.kind !== 'claude-resume' && !(typeof s.kind === 'string' && s.kind.endsWith('-resume'))) continue;
      list.push({
        hubId: s.id,
        title: s.title,
        kind: s.kind,
        cwd: s.cwd || null,
        pinned: !!s.pinned,
        ccSessionId: s.ccSessionId || null,
        meetingId: s.meetingId || null,
        lastMessageTime: s.lastMessageTime || Date.now(),
        lastOutputPreview: s.lastOutputPreview || '',
        unreadCount: s.unreadCount || 0,
        currentModel: s.currentModel || null,
        // T10: include resume-meta in persist payload so main.js merge has the latest
        codexSid: s.codexSid || null,
        geminiChatId: s.geminiChatId || null,
        geminiProjectHash: s.geminiProjectHash || null,
        geminiProjectRoot: s.geminiProjectRoot || null,
      });
    }
    // 2026-05-05 道雪：旧版只挑 11 字段，scene/mode/pilotSlot/dispatchMode/participants/
    //   slotSpecs/covenantText 全被剥掉 → 写残 state.json → 重启后 restoreMeeting fallback
    //   scene='general'，所有圆桌退化为通用场景（投研 LinDangAgent MCP 不挂入）。
    //   修：补全所有 createMeeting 写入 + setMeetingContext 维护的持久化字段。
    //   main.js persist-sessions handler 端加了 fallback 兜底，但渲染端先把字段补全是第一道防线。
    const meetingList = Object.values(meetings).map(m => ({
      id: m.id, type: 'meeting', title: m.title, subSessions: m.subSessions,
      layout: m.layout, focusedSub: m.focusedSub, syncContext: m.syncContext,
      sendTarget: m.sendTarget, createdAt: m.createdAt, lastMessageTime: m.lastMessageTime,
      pinned: m.pinned || false, lastScene: m.lastScene || null,
      scene: m.scene, mode: m.mode,
      pilotSlot: (typeof m.pilotSlot === 'number') ? m.pilotSlot : null,
      dispatchMode: m.dispatchMode || 'all',
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
    meetingId: dormant.meetingId || null,
    lastMessageTime: dormant.lastMessageTime,
    lastOutputPreview: dormant.lastOutputPreview,
    // 把原 session 的 model 透传给 main.js → session-manager createSession 的 opts.model，
    // 避免 spawn `claude --resume` 时回退到默认 opus，丢失原 session 实际使用的 model。
    model: (dormant.currentModel && dormant.currentModel.id) || null,
    // T10: pass resume-meta so main.js Codex/Gemini precise resume works
    codexSid: dormant.codexSid || null,
    geminiChatId: dormant.geminiChatId || null,
    geminiProjectHash: dormant.geminiProjectHash || null,
    geminiProjectRoot: dormant.geminiProjectRoot || null,
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
        meetingId: meta.meetingId || null,
        currentModel: resolvedModel,
        // T10: preserve resume-meta for precise resume (codex/gemini)
        codexSid: meta.codexSid || null,
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
    if (typeof cfg.uiToolFoldThreshold === 'number' && !isNaN(cfg.uiToolFoldThreshold)) _toolFoldThreshold = cfg.uiToolFoldThreshold;
    if (typeof cfg.uiCodeFoldThreshold === 'number' && !isNaN(cfg.uiCodeFoldThreshold)) _codeFoldThreshold = cfg.uiCodeFoldThreshold;
    // 不在这里调 renderAccountUsage —— packyAccountData 还没从 cache 加载完成,
    // 提前渲染会出现一帧"未接入"假象(get-usage-cache 慢于本 promise resolve)。
    // 余额/用量行的渲染统一交给下面的 cache promise。
    traceRendererStartup('hub config loaded');
  }).catch(() => {});

  ipcRenderer.invoke('get-usage-cache').then((cached) => {
    if (!cached) cached = {};
    if (cached.claude && cached.claude.usage5h) {
      accountUsage.usage5h = cached.claude.usage5h;
      accountUsage.usage7d = cached.claude.usage7d;
      if (cached.claude.ts) _claudeUsageLastSeen = cached.claude.ts;
    }
    if (cached.gemini) agentUsage.gemini = cached.gemini;
    if (cached.gemini && cached.gemini.ts) agentUsageLastSeen.gemini = cached.gemini.ts;
    if (cached.codex) agentUsage.codex = cached.codex;
    if (cached.codex && cached.codex.ts) agentUsageLastSeen.codex = cached.codex.ts;
    if (cached.packy) packyAccountData = cached.packy;
    renderAccountUsage();
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
  // 2026-05-05 道雪：新圆桌默认折叠（白名单未命中=折叠）。折叠态侧边栏已显示 3 个迷你
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

// 2026-05-05 道雪 修3：圆桌 turn-complete IPC → 非 active 圆桌累加 unread，
//   触发侧栏 has-unread 视觉提醒（unread-badge "⏸ 等你" + slot 1 边框）。
//   active 圆桌不累加（用户正在看，不需要打扰）。
//   同 IPC 在 meeting-room.js 里也有监听器（cache 同步 + DOM 重渲），与本监听器职责正交。
ipcRenderer.on('roundtable-turn-complete', (_event, { meetingId }) => {
  if (!meetingId || meetingId === activeMeetingId) return;
  const meeting = meetings[meetingId];
  if (!meeting) return;
  meeting.unreadCount = (meeting.unreadCount || 0) + 1;
  meeting.lastMessageTime = Date.now();  // 触发排序（最新答完的圆桌靠前）
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

// --- Mobile Pair Dialog ---
// This file is loaded as a synchronous <script> in <body> BEFORE the
// #pair-modal element is parsed. Guard with DOMContentLoaded so all
// IDs are present when we wire up listeners.
function initMobilePair() {
  const modal = document.getElementById('pair-modal');
  if (!modal) return; // pair UI not present (dev fallback)

  const btn = document.getElementById('btn-mobile');
  const closeBtn = document.getElementById('pair-close');
  const addrList = document.getElementById('pair-addr-list');
  const addrInput = document.getElementById('pair-addr-input');
  const addrAddBtn = document.getElementById('pair-addr-add');
  const deviceNameInput = document.getElementById('pair-device-name');
  const generateBtn = document.getElementById('pair-generate');
  const qrArea = document.getElementById('pair-qr-area');
  const devicesList = document.getElementById('pair-devices');

  let addresses = [];

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function renderAddrs() {
    addrList.innerHTML = '';
    addresses.forEach((a, i) => {
      const li = document.createElement('li');
      li.innerHTML = `<span>${escapeHtml(a)}</span><button aria-label="删除">×</button>`;
      li.querySelector('button').addEventListener('click', () => {
        addresses.splice(i, 1);
        renderAddrs();
      });
      addrList.appendChild(li);
    });
  }

  async function refreshDevices() {
    const list = await ipcRenderer.invoke('mobile:list-devices');
    devicesList.innerHTML = '';
    if (!list.length) {
      const li = document.createElement('li');
      li.className = 'hint';
      li.textContent = '暂无已配对设备';
      devicesList.appendChild(li);
      return;
    }
    for (const d of list) {
      const li = document.createElement('li');
      const seen = d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : '—';
      li.innerHTML = `
        <div class="device-info">
          <span class="device-name">${escapeHtml(d.name)}</span>
          <span class="device-meta">最近连接 ${escapeHtml(seen)} · IP ${escapeHtml(d.lastIp || '—')}</span>
        </div>
        <button class="revoke-btn" data-id="${escapeHtml(d.deviceId)}">撤销</button>
      `;
      li.querySelector('.revoke-btn').addEventListener('click', async () => {
        if (!confirm(`确定撤销设备 "${d.name}"？撤销后该手机将无法连接`)) return;
        await ipcRenderer.invoke('mobile:revoke-device', d.deviceId);
        refreshDevices();
      });
      devicesList.appendChild(li);
    }
  }

  async function openModal() {
    modal.classList.remove('hidden');
    // Default addresses = LAN IPs + actual mobile port
    const [ips, port] = await Promise.all([
      ipcRenderer.invoke('mobile:get-ips'),
      ipcRenderer.invoke('mobile:get-port'),
    ]);
    addresses = ips.map(i => `${i.address}:${port}`);
    renderAddrs();
    qrArea.innerHTML = '<p class="hint">点左侧"生成"按钮</p>';
    refreshDevices();
  }

  function closeModal() { modal.classList.add('hidden'); }

  btn && btn.addEventListener('click', openModal);
  closeBtn.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeModal();
  });

  addrAddBtn.addEventListener('click', () => {
    const v = addrInput.value.trim();
    if (v && !addresses.includes(v)) {
      addresses.push(v);
      addrInput.value = '';
      renderAddrs();
    }
  });
  addrInput.addEventListener('keydown', (e) => { if (e.isComposing || e.keyCode === 229) return; if (e.key === 'Enter') addrAddBtn.click(); });

  generateBtn.addEventListener('click', async () => {
    if (!addresses.length) { alert('至少填一个地址'); return; }
    generateBtn.disabled = true;
    try {
      const { qrDataUrl, pairUrl } = await ipcRenderer.invoke('mobile:create-pairing', {
        addresses,
        deviceName: deviceNameInput.value.trim() || 'Phone',
      });
      qrArea.innerHTML = `<img src="${qrDataUrl}" alt="Pair QR" /><p>${escapeHtml(pairUrl)}</p>`;
    } catch (e) {
      qrArea.innerHTML = `<p style="color:#e24a4a">生成失败: ${escapeHtml(e.message || String(e))}</p>`;
    } finally {
      generateBtn.disabled = false;
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initMobilePair);
} else {
  initMobilePair();
}

