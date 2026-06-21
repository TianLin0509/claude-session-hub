const path = require('path');

function createPreviewPanelController({
  document,
  ipcRenderer,
  shell,
  fs,
  marked,
  DOMPurify,
  getActiveSessionId,
  getActiveMeetingId,
  refitActiveTerminal,
}) {
  const previewPanelEl = document.getElementById('preview-panel');
  const previewTitleEl = document.getElementById('preview-title');
  const previewBodyEl = document.getElementById('preview-body');
  const previewSplitterEl = document.getElementById('preview-splitter');
  const previewZoomLabelEl = document.getElementById('preview-zoom-label');
  const sessionPreviewStates = new Map();

  let previewSourcePanel = null;
  let currentPreviewPath = null;
  let previewIsFullscreen = false;
  let previewSplitRatio = 0.5;
  let previewZoomLevel = 1.0;
  let previewRestoreToken = 0;

  function getActiveContextKey() {
    const sessionId = getActiveSessionId && getActiveSessionId();
    if (sessionId) return `session:${sessionId}`;
    const meetingId = getActiveMeetingId && getActiveMeetingId();
    if (meetingId) return `meeting:${meetingId}`;
    return null;
  }

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

  function resetPreviewLayoutEffects() {
    for (const id of ['terminal-panel', 'meeting-room-panel']) {
      const el = document.getElementById(id);
      if (el) el.style.flex = '';
    }
    previewPanelEl.style.flex = '';
  }

  function setPreviewZoom(level) {
    previewZoomLevel = Math.max(0.25, Math.min(5.0, level));
    previewBodyEl.style.zoom = previewZoomLevel;
    const wv = previewBodyEl.querySelector('webview');
    if (wv) try { wv.setZoomFactor(previewZoomLevel); } catch {}
    previewZoomLabelEl.textContent = Math.round(previewZoomLevel * 100) + '%';
  }

  function resetPreviewZoom() {
    setPreviewZoom(1.0);
  }

  async function capturePreviewScroll() {
    const wv = previewBodyEl.querySelector('webview');
    if (wv && typeof wv.executeJavaScript === 'function') {
      try {
        const pos = await wv.executeJavaScript(`(() => {
          const de = document.documentElement || {};
          const body = document.body || {};
          return {
            x: window.scrollX || de.scrollLeft || body.scrollLeft || 0,
            y: window.scrollY || de.scrollTop || body.scrollTop || 0
          };
        })()`);
        return {
          type: 'webview',
          x: Math.max(0, Number(pos && pos.x) || 0),
          y: Math.max(0, Number(pos && pos.y) || 0),
        };
      } catch {}
    }
    return {
      type: 'body',
      x: Math.max(0, Number(previewBodyEl.scrollLeft) || 0),
      y: Math.max(0, Number(previewBodyEl.scrollTop) || 0),
    };
  }

  async function savePreviewState() {
    const key = getActiveContextKey();
    if (!key || !currentPreviewPath) return;
    sessionPreviewStates.set(key, {
      path: currentPreviewPath,
      isFullscreen: previewIsFullscreen,
      zoomLevel: previewZoomLevel,
      splitRatio: previewSplitRatio,
      scroll: await capturePreviewScroll(),
    });
  }

  function clearPreviewUI() {
    previewRestoreToken += 1;
    previewPanelEl.style.display = 'none';
    previewPanelEl.classList.remove('preview-split');
    previewSplitterEl.style.display = 'none';
    currentPreviewPath = null;
    previewIsFullscreen = false;
    previewSplitRatio = 0.5;
    previewSourcePanel = null;
    previewBodyEl.innerHTML = '';
    resetPreviewLayoutEffects();
    resetPreviewZoom();
  }

  function restorePreviewForContextLegacy(key) {
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

  async function restorePreviewForContext(key) {
    const state = sessionPreviewStates.get(key);
    if (!state) return;
    previewIsFullscreen = state.isFullscreen;
    previewSplitRatio = state.splitRatio || 0.5;
    await openPreviewPanel(state.path, {
      zoomLevel: state.zoomLevel,
      scroll: state.scroll,
      preserveZoom: true,
    });
    const btn = document.getElementById('preview-toggle-layout');
    if (btn) {
      btn.textContent = previewIsFullscreen ? 'Split' : 'Full';
      btn.title = previewIsFullscreen ? '并列预览' : '全屏预览';
    }
  }

  function setPreviewBodyLayout(alignItems, justifyContent) {
    previewBodyEl.style.alignItems = alignItems;
    previewBodyEl.style.justifyContent = justifyContent;
  }

  function restoreBodyScroll(scroll) {
    if (!scroll) return;
    requestAnimationFrame(() => {
      previewBodyEl.scrollLeft = Math.max(0, Number(scroll.x) || 0);
      previewBodyEl.scrollTop = Math.max(0, Number(scroll.y) || 0);
    });
  }

  function restoreWebviewScroll(wv, scroll, token) {
    if (!scroll || !wv || typeof wv.executeJavaScript !== 'function') return;
    const x = Math.max(0, Number(scroll.x) || 0);
    const y = Math.max(0, Number(scroll.y) || 0);
    const js = `window.scrollTo(${JSON.stringify(x)}, ${JSON.stringify(y)});`;
    const apply = () => {
      if (token !== previewRestoreToken) return;
      try { wv.executeJavaScript(js); } catch {}
    };
    try { wv.addEventListener('dom-ready', apply, { once: true }); } catch {}
    try { wv.addEventListener('did-finish-load', apply, { once: true }); } catch {}
    setTimeout(apply, 80);
    setTimeout(apply, 300);
  }

  function makeWebview(src, scroll, token) {
    const wv = document.createElement('webview');
    wv.src = src;
    wv.style.cssText = 'width:100%;height:100%;border:none;';
    setPreviewBodyLayout('stretch', 'stretch');
    previewBodyEl.appendChild(wv);
    restoreWebviewScroll(wv, scroll, token);
  }

  function showPreviewError(result) {
    previewBodyEl.innerHTML = `<div class="preview-markdown" style="color:var(--text-secondary)">Failed to load: ${result.error}</div>`;
  }

  async function openPreviewPanel(filePath, options = {}) {
    filePath = filePath.replace(/[\r\n]+/g, '').trim();
    const token = ++previewRestoreToken;
    currentPreviewPath = filePath;
    if (options.preserveZoom) setPreviewZoom(options.zoomLevel || 1.0);
    else resetPreviewZoom();
    const isUrl = /^https?:\/\//i.test(filePath);
    const fileName = isUrl ? filePath.replace(/^https?:\/\//i, '').split(/[/?#]/)[0] : filePath.replace(/^.*[\\/]/, '');
    previewTitleEl.textContent = fileName;
    previewTitleEl.title = filePath;

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
      const meetingPanel = document.getElementById('meeting-room-panel');
      if (meetingPanel.style.display !== 'none' && meetingPanel.style.display !== '') {
        previewSourcePanel = 'meeting-room-panel';
      } else {
        previewSourcePanel = 'terminal-panel';
      }
    }

    const src = document.getElementById(previewSourcePanel);
    if (previewIsFullscreen && src) src.style.display = 'none';
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
      makeWebview(filePath, options.scroll, token);
      return;
    }

    const ext = filePath.replace(/^.*\./, '.').toLowerCase();

    if (ext === '.html' || ext === '.htm') {
      makeWebview('file:///' + filePath.replace(/\\/g, '/'), options.scroll, token);
    } else if (ext === '.md' || ext === '.markdown') {
      const result = await ipcRenderer.invoke('read-file', filePath);
      if (result.error) { showPreviewError(result); return; }
      const html = DOMPurify.sanitize(marked.parse(result.content));
      setPreviewBodyLayout('flex-start', 'flex-start');
      previewBodyEl.innerHTML = `<div class="preview-markdown">${html}</div>`;
      restoreBodyScroll(options.scroll);
    } else if (ext === '.svg' || ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.gif' || ext === '.webp' || ext === '.bmp') {
      const fileUrl = 'file:///' + filePath.replace(/\\/g, '/');
      setPreviewBodyLayout('center', 'center');
      previewBodyEl.innerHTML = `<img src="${fileUrl}" class="preview-image">`;
      restoreBodyScroll(options.scroll);
    } else if (ext === '.pdf') {
      makeWebview('file:///' + filePath.replace(/\\/g, '/'), options.scroll, token);
    } else if (ext === '.csv' || ext === '.tsv') {
      const result = await ipcRenderer.invoke('read-file', filePath);
      if (result.error) { showPreviewError(result); return; }
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
      setPreviewBodyLayout('flex-start', 'flex-start');
      previewBodyEl.innerHTML = tableHtml;
      restoreBodyScroll(options.scroll);
    } else {
      const result = await ipcRenderer.invoke('read-file', filePath);
      if (result.error) { showPreviewError(result); return; }
      let content = result.content;
      if (ext === '.json' || ext === '.jsonl') {
        try { content = JSON.stringify(JSON.parse(content), null, 2); } catch {}
      }
      const escaped = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const lines = escaped.split('\n');
      const numbered = lines.map((line, i) => `<span class="preview-line-num">${i + 1}</span>${line}`).join('\n');
      setPreviewBodyLayout('flex-start', 'flex-start');
      previewBodyEl.innerHTML = `<pre class="preview-code">${numbered}</pre>`;
      restoreBodyScroll(options.scroll);
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
    resetPreviewLayoutEffects();
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

  function handlePreviewLinkClick(e) {
    const a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    if (a.classList.contains('rt-file-link')) return;
    const rawHref = a.getAttribute('href') || '';
    if (!rawHref || rawHref.startsWith('#')) return;
    e.preventDefault();
    e.stopPropagation();
    if (/^(mailto|tel|sms|callto|skype):/i.test(rawHref)) {
      try { shell.openExternal(rawHref); } catch (err) { console.warn('[hub] openExternal failed:', err); }
      return;
    }
    const proto = /^([a-z][a-z0-9+.-]*):/i.exec(rawHref);
    if (proto && !/^(https?|file)$/i.test(proto[1])) {
      console.warn('[hub] unsupported scheme blocked:', rawHref);
      return;
    }
    const hashIdx = rawHref.indexOf('#');
    const pathOnly = hashIdx >= 0 ? rawHref.slice(0, hashIdx) : rawHref;
    let href;
    try { href = decodeURIComponent(pathOnly); } catch (_) { href = pathOnly; }
    if (/^https?:\/\//i.test(href)) { openPreviewPanel(href); return; }
    let target = href.replace(/^file:\/+/i, '');
    const isAbs = /^[a-zA-Z]:[\\/]/.test(target) || target.startsWith('/');
    if (!isAbs && currentPreviewPath && !/^https?:\/\//i.test(currentPreviewPath)) {
      try {
        const dir = path.dirname(currentPreviewPath);
        target = path.resolve(dir, target);
      } catch (err) { console.warn('[hub] preview link resolve failed:', err); }
    }
    openPreviewPanel(target);
  }

  function initSplitterDrag() {
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
  }

  previewBodyEl.addEventListener('click', handlePreviewLinkClick);
  document.getElementById('preview-close').addEventListener('click', closePreviewPanel);
  document.getElementById('preview-toggle-layout').addEventListener('click', togglePreviewLayout);
  document.getElementById('preview-open-external').addEventListener('click', async () => {
    if (!currentPreviewPath) return;
    if (/^https?:\/\//i.test(currentPreviewPath)) {
      shell.openExternal(currentPreviewPath);
      return;
    }
    const err = await ipcRenderer.invoke('open-path', currentPreviewPath);
    if (err) console.warn('[hub] open-path for preview failed:', currentPreviewPath, '->', err);
  });
  // 2026-06-21 道雪：用捕获阶段 + stopPropagation 让预览 ESC 独占本次按键，避免冒泡到
  //   meeting-room 的时光机/聚焦/对比 ESC 处理器（否则一次 ESC 会连带退出时光机）。
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && previewPanelEl.style.display === 'flex') {
      e.preventDefault();
      e.stopPropagation();
      closePreviewPanel();
    }
  }, true);
  document.getElementById('preview-zoom-out').addEventListener('click', () => setPreviewZoom(previewZoomLevel - 0.1));
  document.getElementById('preview-zoom-in').addEventListener('click', () => setPreviewZoom(previewZoomLevel + 0.1));
  document.getElementById('preview-zoom-reset').addEventListener('click', resetPreviewZoom);
  previewBodyEl.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.1 : -0.1;
    setPreviewZoom(previewZoomLevel + delta);
  }, { passive: false });
  initSplitterDrag();

  return {
    openPreviewPanel,
    closePreviewPanel,
    savePreviewState,
    clearPreviewUI,
    restorePreviewForContext,
  };
}

module.exports = { createPreviewPanelController };
