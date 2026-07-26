'use strict';

const IMAGE_PATH_RE = /[A-Za-z]:[\\/](?:[^\\/:*?"<>|\r\n\s]+[\\/])*[^\\/:*?"<>|\r\n\s]+\.(?:png|jpe?g|gif|webp|bmp)(?![A-Za-z0-9])/gi;

function createTerminalInputController({ document, window, ipcRenderer, clipboard, terminalCache, EventCtor = Event, requestAnimationFrameFn = requestAnimationFrame, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout }) {
  if (!document) throw new Error('document is required');
  if (!ipcRenderer) throw new Error('ipcRenderer is required');
  if (!clipboard) throw new Error('clipboard is required');
  if (!terminalCache) throw new Error('terminalCache is required');

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
  //   普通 session 浮动输入框 / AI 群聊输入框等 contenteditable 元素用：
  //   1. 监听 'paste' 事件（contenteditable 默认会 fire，与 xterm 不同）
  //   2. 检测剪贴板有图片 → 调 save-clipboard-image IPC 拿绝对路径
  //   3. 用 execCommand('insertText', path) 在 caret 位置插入路径文字
  //      （execCommand 比 selection.insertNode 更稳：自动处理 caret/undo stack/IME）
  //   4. 文本粘贴显式插入 text/plain，避免 HTML 源格式进入输入框
  // 暴露为 window.attachContenteditablePasteImage 供 meeting-room.js IIFE 使用。
  function htmlToPlainText(html) {
    if (!html) return '';
    const DOMParserCtor = window && window.DOMParser;
    if (typeof DOMParserCtor === 'function') {
      const parsed = new DOMParserCtor().parseFromString(html, 'text/html');
      return (parsed && parsed.body && (parsed.body.innerText || parsed.body.textContent)) || '';
    }
    return '';
  }

  function getPastePlainText(e) {
    const cd = e && e.clipboardData;
    if (cd && typeof cd.getData === 'function') {
      const plainText = cd.getData('text/plain') || '';
      if (plainText) return plainText;
      return htmlToPlainText(cd.getData('text/html') || '');
    }
    return clipboard.readText ? (clipboard.readText() || '') : '';
  }

  function hasClipboardImage(e) {
    const cd = e && e.clipboardData;
    if (cd && cd.items) {
      for (const it of cd.items) {
        if (it.kind === 'file' && /^image\//.test(it.type)) return true;
      }
    }
    const img = clipboard.readImage();
    return !!(img && !img.isEmpty());
  }

  function insertContenteditableText(inputEl, text) {
    document.execCommand('insertText', false, text);
    inputEl.dispatchEvent(new EventCtor('input', { bubbles: true }));
  }

  // Text paste is normalized to text/plain; image-only paste still inserts a
  // saved local image path. Keep the public name for existing callers.
  function attachContenteditablePasteImage(inputEl) {
    if (!inputEl || inputEl.dataset.imgPasteBound === '1') return;
    inputEl.dataset.imgPasteBound = '1';
    inputEl.addEventListener('paste', async (e) => {
      // Text wins over image so copied HTML selections become plain prompts.
      const plainText = getPastePlainText(e);
      if (plainText) {
        e.preventDefault();
        insertContenteditableText(inputEl, plainText);
        return;
      }

      if (!hasClipboardImage(e)) return;
      e.preventDefault();
      try {
        const filePath = await ipcRenderer.invoke('save-clipboard-image');
        if (!filePath) return;
        // 在 caret 位置插入路径文本（保持 selection / 维护 undo stack）
        // execCommand 在 contenteditable 里仍然可用（虽然标记 deprecated，浏览器仍支持
        // 且对 Electron renderer 是稳定 API，与 xterm.paste 等价语义）
        insertContenteditableText(inputEl, filePath);
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
  
    clearTimeoutFn(previewTimeout);
    previewTimeout = setTimeoutFn(() => {
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
    requestAnimationFrameFn(() => {
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
    clearTimeoutFn(previewTimeout);
    previewTooltip.style.display = 'none';
    previewTooltip.dataset.path = '';
  }

  return {
    handlePasteForSession,
    attachContenteditablePasteImage,
    setupImageHover,
    getTerminalCoords,
    getInputLineSelection,
    deleteInputSelection,
    extractPathAtPosition,
    hidePreview,
  };
}

module.exports = { createTerminalInputController };
