'use strict';

const path = require('path');
const { fileURLToPath, pathToFileURL } = require('url');

const IMAGE_EXTENSIONS = new Set(['.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const WEB_EXTENSIONS = new Set(['.html', '.htm']);
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);
const TABLE_EXTENSIONS = new Set(['.csv', '.tsv']);
const NON_COPYABLE_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, '.pdf']);
const QUICK_OPEN_DEBOUNCE_MS = 140;
const PREVIEW_SCROLL_CAPTURE_TIMEOUT_MS = 350;
const PREVIEW_COPY_TIMEOUT_MS = 2000;

function cleanPreviewTarget(value) {
  return String(value == null ? '' : value).replace(/[\0\r\n]+/g, '').trim();
}

function previewPathKey(value) {
  const target = cleanPreviewTarget(value);
  if (/^https?:\/\//i.test(target)) return `url:${target}`;
  const resolved = path.resolve(target);
  return `file:${process.platform === 'win32' ? resolved.toLowerCase() : resolved}`;
}

function previewTitle(value) {
  const target = cleanPreviewTarget(value);
  if (/^https?:\/\//i.test(target)) {
    try { return new URL(target).hostname || target; } catch (_) { return target; }
  }
  return path.basename(target) || target;
}

function previewExtension(value) {
  if (/^https?:\/\//i.test(String(value || ''))) return '';
  return path.extname(String(value || '')).toLowerCase();
}

function createPreviewPanelController({
  document,
  ipcRenderer,
  shell,
  clipboard,
  fs,
  marked,
  DOMPurify,
  getActiveSessionId,
  getActiveMeetingId,
  getActiveCwd,
  openPath,
  refitActiveTerminal,
}) {
  const previewPanelEl = document.getElementById('preview-panel');
  const previewTitleEl = document.getElementById('preview-title');
  const previewBodyEl = document.getElementById('preview-body');
  const previewSplitterEl = document.getElementById('preview-splitter');
  const previewZoomLabelEl = document.getElementById('preview-zoom-label');
  const previewTabsEl = document.getElementById('preview-tabs');
  const quickOpenEl = document.getElementById('preview-quick-open');
  const quickOpenInputEl = document.getElementById('preview-quick-open-input');
  const quickOpenResultsEl = document.getElementById('preview-quick-open-results');
  const quickOpenStatusEl = document.getElementById('preview-quick-open-status');
  const contextPreviewStates = new Map();

  let currentContextKey = null;
  let previewSourcePanel = null;
  let currentPreviewPath = null;
  let previewIsFullscreen = false;
  let previewSplitRatio = 0.5;
  let previewZoomLevel = 1.0;
  let previewRenderToken = 0;
  let navigationToken = 0;
  let nextTabId = 1;
  let quickOpenItems = [];
  let quickOpenSelectedIndex = 0;
  let quickOpenSearchToken = 0;
  let quickOpenTimer = null;
  let quickOpenReturnFocus = null;
  let previewNoticeTimer = null;

  function getActiveContextKey() {
    const sessionId = getActiveSessionId && getActiveSessionId();
    if (sessionId) return `session:${sessionId}`;
    const meetingId = getActiveMeetingId && getActiveMeetingId();
    if (meetingId) return `meeting:${meetingId}`;
    return 'global';
  }

  function makeContextState() {
    return {
      tabs: [],
      activeTabId: null,
      isFullscreen: false,
      splitRatio: 0.5,
    };
  }

  function getContextState(key = currentContextKey, create = false) {
    if (!key) return null;
    let state = contextPreviewStates.get(key);
    if (!state && create) {
      state = makeContextState();
      contextPreviewStates.set(key, state);
    }
    return state || null;
  }

  function getActiveTab(state = getContextState()) {
    if (!state || !state.activeTabId) return null;
    return state.tabs.find(tab => tab.id === state.activeTabId) || null;
  }

  function applySplitWidths(ratio) {
    const src = previewSourcePanel ? document.getElementById(previewSourcePanel) : null;
    if (!ratio) {
      if (src) src.style.flex = '';
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

  function setPreviewZoom(level, { persist = true } = {}) {
    previewZoomLevel = Math.max(0.25, Math.min(5.0, Number(level) || 1));
    previewBodyEl.style.zoom = previewZoomLevel;
    const webview = previewBodyEl.querySelector('webview');
    if (webview) {
      try { webview.setZoomFactor(previewZoomLevel); } catch (_) {}
    }
    previewZoomLabelEl.textContent = `${Math.round(previewZoomLevel * 100)}%`;
    if (persist) {
      const tab = getActiveTab();
      if (tab) tab.zoomLevel = previewZoomLevel;
    }
  }

  function resetPreviewZoom(options) {
    setPreviewZoom(1.0, options);
  }

  async function capturePreviewScroll() {
    const webview = previewBodyEl.querySelector('webview');
    if (webview && typeof webview.executeJavaScript === 'function') {
      try {
        let timeoutId = null;
        const request = Promise.resolve(webview.executeJavaScript(`(() => {
          const de = document.documentElement || {};
          const body = document.body || {};
          return {
            x: window.scrollX || de.scrollLeft || body.scrollLeft || 0,
            y: window.scrollY || de.scrollTop || body.scrollTop || 0
          };
        })()`)).catch(() => null);
        const pos = await Promise.race([
          request,
          new Promise(resolve => { timeoutId = setTimeout(() => resolve(null), PREVIEW_SCROLL_CAPTURE_TIMEOUT_MS); }),
        ]);
        if (timeoutId) clearTimeout(timeoutId);
        if (!pos) throw new Error('webview scroll capture timed out');
        return {
          type: 'webview',
          x: Math.max(0, Number(pos && pos.x) || 0),
          y: Math.max(0, Number(pos && pos.y) || 0),
        };
      } catch (error) {
        console.debug('[preview] webview scroll capture skipped:', error && error.message);
      }
    }
    return {
      type: 'body',
      x: Math.max(0, Number(previewBodyEl.scrollLeft) || 0),
      y: Math.max(0, Number(previewBodyEl.scrollTop) || 0),
    };
  }

  async function captureActiveTabState(state = getContextState()) {
    const tab = getActiveTab(state);
    if (!tab || previewPanelEl.style.display !== 'flex') return;
    const tabId = tab.id;
    const scroll = await capturePreviewScroll();
    const stillPresent = state.tabs.find(candidate => candidate.id === tabId);
    if (!stillPresent) return;
    stillPresent.scroll = scroll;
    stillPresent.zoomLevel = previewZoomLevel;
  }

  async function savePreviewState() {
    const state = getContextState();
    if (!state || !getActiveTab(state)) return;
    state.isFullscreen = previewIsFullscreen;
    state.splitRatio = previewSplitRatio;
    await captureActiveTabState(state);
  }

  function restoreSourcePanelVisibility() {
    if (!previewSourcePanel) return;
    const src = document.getElementById(previewSourcePanel);
    if (src) src.style.display = previewSourcePanel === 'terminal-panel' ? '' : 'flex';
    previewSourcePanel = null;
  }

  function resetPreviewHeader() {
    currentPreviewPath = null;
    previewTitleEl.textContent = 'Preview';
    previewTitleEl.title = '';
    const badge = document.getElementById('preview-file-badge');
    const meta = document.getElementById('preview-file-meta');
    if (badge) badge.textContent = '--';
    if (meta) meta.textContent = '';
    updateActionAvailability();
  }

  function clearPreviewUI() {
    closeQuickOpen({ restoreFocus: false });
    clearPreviewNotice();
    previewRenderToken += 1;
    navigationToken += 1;
    previewPanelEl.style.display = 'none';
    previewPanelEl.classList.remove('preview-split');
    previewSplitterEl.style.display = 'none';
    previewIsFullscreen = false;
    previewSplitRatio = 0.5;
    previewBodyEl.innerHTML = '';
    if (previewTabsEl) previewTabsEl.innerHTML = '';
    resetPreviewLayoutEffects();
    resetPreviewZoom({ persist: false });
    resetPreviewHeader();
    previewSourcePanel = null;
    currentContextKey = null;
  }

  function setPreviewBodyLayout(alignItems, justifyContent) {
    previewBodyEl.style.alignItems = alignItems;
    previewBodyEl.style.justifyContent = justifyContent;
  }

  function restoreBodyScroll(scroll, token, tabId) {
    if (!scroll) return;
    requestAnimationFrame(() => {
      const state = getContextState();
      if (token !== previewRenderToken || !state || state.activeTabId !== tabId) return;
      previewBodyEl.scrollLeft = Math.max(0, Number(scroll.x) || 0);
      previewBodyEl.scrollTop = Math.max(0, Number(scroll.y) || 0);
    });
  }

  function restoreWebviewScroll(webview, scroll, token) {
    if (!scroll || !webview || typeof webview.executeJavaScript !== 'function') return;
    const x = Math.max(0, Number(scroll.x) || 0);
    const y = Math.max(0, Number(scroll.y) || 0);
    const js = `window.scrollTo(${JSON.stringify(x)}, ${JSON.stringify(y)});`;
    const apply = () => {
      if (token !== previewRenderToken) return;
      try {
        const result = webview.executeJavaScript(js);
        if (result && typeof result.catch === 'function') {
          void result.catch(error => console.debug('[preview] webview scroll restore skipped:', error && error.message));
        }
      } catch (error) {
        console.debug('[preview] webview scroll restore skipped:', error && error.message);
      }
    };
    try { webview.addEventListener('dom-ready', apply, { once: true }); } catch (_) {}
    try { webview.addEventListener('did-finish-load', apply, { once: true }); } catch (_) {}
    setTimeout(apply, 80);
    setTimeout(apply, 300);
  }

  function makeWebview(src, scroll, token) {
    const webview = document.createElement('webview');
    webview.src = src;
    webview.style.cssText = 'width:100%;height:100%;border:none;';
    setPreviewBodyLayout('stretch', 'stretch');
    previewBodyEl.appendChild(webview);
    try { webview.setZoomFactor(previewZoomLevel); } catch (_) {}
    restoreWebviewScroll(webview, scroll, token);
    return webview;
  }

  function showPreviewError(message, token = previewRenderToken) {
    if (token !== previewRenderToken) return;
    previewBodyEl.innerHTML = '';
    const error = document.createElement('div');
    error.className = 'preview-markdown';
    error.style.color = 'var(--text-secondary)';
    error.textContent = `加载失败：${String(message || 'unknown error')}`;
    previewBodyEl.appendChild(error);
  }

  function clearPreviewNotice() {
    if (previewNoticeTimer) {
      clearTimeout(previewNoticeTimer);
      previewNoticeTimer = null;
    }
    const notice = document.getElementById('preview-notice');
    if (notice) notice.remove();
  }

  function showPreviewNotice(message, level = 'error') {
    clearPreviewNotice();
    const notice = document.createElement('div');
    notice.id = 'preview-notice';
    notice.className = 'preview-notice';
    notice.dataset.level = level;
    notice.textContent = String(message || '操作失败');
    document.body.appendChild(notice);
    previewNoticeTimer = setTimeout(() => {
      notice.remove();
      previewNoticeTimer = null;
    }, 2800);
  }

  async function runAsyncAction(action, failureLabel = '操作失败') {
    try {
      return await action();
    } catch (error) {
      console.warn(`[preview] ${failureLabel}:`, error);
      showPreviewNotice(`${failureLabel}：${String(error && error.message || error)}`, 'error');
      return null;
    }
  }

  async function readPreviewFile(filePath) {
    try {
      return await ipcRenderer.invoke('read-file', filePath);
    } catch (error) {
      return { error: String(error && error.message || error) };
    }
  }

  function updateFileMetadata(filePath) {
    const isUrl = /^https?:\/\//i.test(filePath);
    const badgeEl = document.getElementById('preview-file-badge');
    const metaEl = document.getElementById('preview-file-meta');
    previewTitleEl.textContent = previewTitle(filePath);
    previewTitleEl.title = filePath;
    if (!badgeEl || !metaEl) return;
    if (isUrl) {
      badgeEl.textContent = 'URL';
      metaEl.textContent = '';
      return;
    }
    const ext = previewExtension(filePath);
    badgeEl.textContent = ext ? ext.slice(1).toUpperCase().slice(0, 4) : '--';
    try {
      const size = fs.statSync(filePath).size;
      if (size < 1024) metaEl.textContent = `${size} B`;
      else if (size < 1024 * 1024) metaEl.textContent = `${(size / 1024).toFixed(1)} KB`;
      else metaEl.textContent = `${(size / 1024 / 1024).toFixed(1)} MB`;
    } catch (_) {
      metaEl.textContent = '';
    }
  }

  function updateActionAvailability() {
    const isUrl = /^https?:\/\//i.test(String(currentPreviewPath || ''));
    const ext = previewExtension(currentPreviewPath);
    const copyContent = document.getElementById('preview-copy-content');
    const copyPath = document.getElementById('preview-copy-path');
    const showInFolder = document.getElementById('preview-show-in-folder');
    const openExternal = document.getElementById('preview-open-external');
    if (copyContent) copyContent.disabled = !currentPreviewPath || NON_COPYABLE_EXTENSIONS.has(ext);
    if (copyPath) copyPath.disabled = !currentPreviewPath;
    if (showInFolder) showInFolder.disabled = !currentPreviewPath || isUrl;
    if (openExternal) openExternal.disabled = !currentPreviewPath;
  }

  function renderTabs() {
    if (!previewTabsEl) return;
    previewTabsEl.innerHTML = '';
    previewBodyEl.removeAttribute('aria-labelledby');
    const state = getContextState();
    if (!state) return;
    for (const tab of state.tabs) {
      const active = tab.id === state.activeTabId;
      const shell = document.createElement('div');
      shell.className = `preview-tab-shell${active ? ' active' : ''}`;
      const tabButton = document.createElement('button');
      tabButton.type = 'button';
      tabButton.className = `preview-tab${tab.id === state.activeTabId ? ' active' : ''}`;
      tabButton.dataset.tabId = tab.id;
      tabButton.id = `preview-tab-node-${tab.id}`;
      tabButton.title = tab.path;
      tabButton.setAttribute('role', 'tab');
      tabButton.setAttribute('aria-selected', active ? 'true' : 'false');
      tabButton.setAttribute('aria-controls', 'preview-body');
      tabButton.tabIndex = active ? 0 : -1;
      if (active) previewBodyEl.setAttribute('aria-labelledby', tabButton.id);

      const title = document.createElement('span');
      title.className = 'preview-tab-title';
      title.textContent = tab.title;
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'preview-tab-close';
      close.dataset.closeTabId = tab.id;
      close.title = '关闭预览';
      close.setAttribute('aria-label', `关闭 ${tab.title}`);
      close.tabIndex = -1;
      close.textContent = '×';
      tabButton.appendChild(title);
      shell.append(tabButton, close);
      previewTabsEl.appendChild(shell);
    }
  }

  function focusPreviewTab(tabId) {
    if (!previewTabsEl) return;
    const tab = Array.from(previewTabsEl.querySelectorAll('[data-tab-id]'))
      .find(element => element.dataset.tabId === tabId);
    if (tab && typeof tab.focus === 'function') tab.focus();
  }

  function ensureSourcePanel() {
    if (previewSourcePanel) return;
    if (String(currentContextKey || '').startsWith('meeting:')) {
      previewSourcePanel = 'meeting-room-panel';
      return;
    }
    const meetingPanel = document.getElementById('meeting-room-panel');
    if (meetingPanel && meetingPanel.style.display !== 'none' && meetingPanel.style.display !== '') {
      previewSourcePanel = 'meeting-room-panel';
    } else {
      previewSourcePanel = 'terminal-panel';
    }
  }

  function showPanelFrame(state) {
    previewIsFullscreen = !!state.isFullscreen;
    previewSplitRatio = Number(state.splitRatio) || 0.5;
    ensureSourcePanel();
    const src = previewSourcePanel ? document.getElementById(previewSourcePanel) : null;
    if (src) src.style.display = previewIsFullscreen
      ? 'none'
      : (previewSourcePanel === 'terminal-panel' ? '' : 'flex');
    const emptyEl = document.getElementById('empty-state');
    if (emptyEl) emptyEl.style.display = 'none';
    previewPanelEl.style.display = 'flex';
    const isSplit = !previewIsFullscreen;
    previewPanelEl.classList.toggle('preview-split', isSplit);
    previewSplitterEl.style.display = isSplit ? '' : 'none';
    applySplitWidths(isSplit ? previewSplitRatio : null);
    const layoutButton = document.getElementById('preview-toggle-layout');
    if (layoutButton) {
      layoutButton.textContent = previewIsFullscreen ? '◫' : '□';
      layoutButton.title = previewIsFullscreen ? '并列预览' : '全屏预览';
    }
    renderTabs();
    if (isSplit) refitActiveTerminal();
  }

  function renderCsv(content, separator) {
    const wrap = document.createElement('div');
    wrap.className = 'preview-csv-wrap';
    const table = document.createElement('table');
    table.className = 'preview-csv';
    const rows = String(content || '').split(/\r?\n/).filter(line => line.trim());
    if (rows.length > 0) {
      const head = document.createElement('thead');
      const headRow = document.createElement('tr');
      for (const value of rows[0].split(separator)) {
        const cell = document.createElement('th');
        cell.textContent = value;
        headRow.appendChild(cell);
      }
      head.appendChild(headRow);
      table.appendChild(head);
      const body = document.createElement('tbody');
      for (const row of rows.slice(1)) {
        const tr = document.createElement('tr');
        for (const value of row.split(separator)) {
          const cell = document.createElement('td');
          cell.textContent = value;
          tr.appendChild(cell);
        }
        body.appendChild(tr);
      }
      table.appendChild(body);
    }
    wrap.appendChild(table);
    previewBodyEl.appendChild(wrap);
  }

  async function renderActiveTab(tab, options = {}) {
    const token = ++previewRenderToken;
    currentPreviewPath = tab.path;
    updateFileMetadata(tab.path);
    updateActionAvailability();
    setPreviewZoom(options.preserveZoom ? (options.zoomLevel || tab.zoomLevel || 1) : (tab.zoomLevel || 1), { persist: false });
    previewBodyEl.innerHTML = '';
    previewBodyEl.scrollLeft = 0;
    previewBodyEl.scrollTop = 0;
    const isUrl = /^https?:\/\//i.test(tab.path);
    const ext = previewExtension(tab.path);
    const scroll = options.scroll || tab.scroll;
    const isStillCurrent = () => {
      const state = getContextState();
      return token === previewRenderToken && state && state.activeTabId === tab.id;
    };

    if (isUrl) {
      tab.kind = 'web';
      makeWebview(tab.path, scroll, token);
      return;
    }
    if (WEB_EXTENSIONS.has(ext)) {
      tab.kind = 'web';
      makeWebview(pathToFileURL(tab.path).href, scroll, token);
      return;
    }
    if (MARKDOWN_EXTENSIONS.has(ext)) {
      tab.kind = 'text';
      const result = await readPreviewFile(tab.path);
      if (!isStillCurrent()) return;
      if (result.error) { showPreviewError(result.error, token); return; }
      let html;
      try { html = DOMPurify.sanitize(marked.parse(result.content)); }
      catch (error) { showPreviewError(`Markdown 渲染失败：${String(error && error.message || error)}`, token); return; }
      setPreviewBodyLayout('flex-start', 'flex-start');
      const markdown = document.createElement('div');
      markdown.className = 'preview-markdown';
      markdown.innerHTML = html;
      previewBodyEl.appendChild(markdown);
      restoreBodyScroll(scroll, token, tab.id);
      return;
    }
    if (IMAGE_EXTENSIONS.has(ext)) {
      tab.kind = 'image';
      setPreviewBodyLayout('center', 'center');
      const image = document.createElement('img');
      image.src = pathToFileURL(tab.path).href;
      image.className = 'preview-image';
      image.alt = tab.title;
      previewBodyEl.appendChild(image);
      restoreBodyScroll(scroll, token, tab.id);
      return;
    }
    if (ext === '.pdf') {
      tab.kind = 'pdf';
      makeWebview(pathToFileURL(tab.path).href, scroll, token);
      return;
    }
    if (TABLE_EXTENSIONS.has(ext)) {
      tab.kind = 'text';
      const result = await readPreviewFile(tab.path);
      if (!isStillCurrent()) return;
      if (result.error) { showPreviewError(result.error, token); return; }
      setPreviewBodyLayout('flex-start', 'flex-start');
      renderCsv(result.content, ext === '.tsv' ? '\t' : ',');
      restoreBodyScroll(scroll, token, tab.id);
      return;
    }

    tab.kind = 'text';
    const result = await readPreviewFile(tab.path);
    if (!isStillCurrent()) return;
    if (result.error) { showPreviewError(result.error, token); return; }
    let content = result.content;
    if (ext === '.json' || ext === '.jsonl') {
      try { content = JSON.stringify(JSON.parse(content), null, 2); } catch (_) {}
    }
    setPreviewBodyLayout('flex-start', 'flex-start');
    const code = document.createElement('pre');
    code.className = 'preview-code';
    const lines = String(content || '').split('\n');
    lines.forEach((line, index) => {
      const number = document.createElement('span');
      number.className = 'preview-line-num';
      number.textContent = String(index + 1);
      code.appendChild(number);
      code.appendChild(document.createTextNode ? document.createTextNode(line) : (() => {
        const span = document.createElement('span');
        span.textContent = line;
        return span;
      })());
      if (index < lines.length - 1) code.appendChild(document.createTextNode ? document.createTextNode('\n') : (() => {
        const span = document.createElement('span');
        span.textContent = '\n';
        return span;
      })());
    });
    previewBodyEl.appendChild(code);
    restoreBodyScroll(scroll, token, tab.id);
  }

  async function openPreviewPanel(filePath, options = {}) {
    const target = cleanPreviewTarget(filePath);
    if (!target) return null;
    const operation = ++navigationToken;
    const key = getActiveContextKey();
    const previousState = getContextState();
    if (currentContextKey === key && previousState) {
      await captureActiveTabState(previousState);
      if (operation !== navigationToken) return null;
    }

    currentContextKey = key;
    const state = getContextState(key, true);
    let tab = state.tabs.find(candidate => previewPathKey(candidate.path) === previewPathKey(target));
    if (!tab) {
      tab = {
        id: `preview-tab-${nextTabId++}`,
        path: target,
        title: previewTitle(target),
        zoomLevel: 1,
        scroll: null,
        kind: null,
        openedAt: Date.now(),
      };
      state.tabs.push(tab);
    } else {
      tab.openedAt = Date.now();
    }
    if (options.scroll) tab.scroll = options.scroll;
    if (options.zoomLevel) tab.zoomLevel = options.zoomLevel;
    state.activeTabId = tab.id;
    showPanelFrame(state);
    await renderActiveTab(tab, {
      preserveZoom: true,
      zoomLevel: tab.zoomLevel,
      scroll: tab.scroll,
    });
    return tab.id;
  }

  async function switchPreviewTab(tabId) {
    const state = getContextState();
    if (!state || state.activeTabId === tabId) return;
    const target = state.tabs.find(tab => tab.id === tabId);
    if (!target) return;
    const operation = ++navigationToken;
    await captureActiveTabState(state);
    if (operation !== navigationToken) return;
    state.activeTabId = target.id;
    renderTabs();
    await renderActiveTab(target, { preserveZoom: true, zoomLevel: target.zoomLevel, scroll: target.scroll });
  }

  async function closePreviewTab(tabId) {
    const state = getContextState();
    if (!state) return;
    const index = state.tabs.findIndex(tab => tab.id === tabId);
    if (index < 0) return;
    const wasActive = state.activeTabId === tabId;
    const operation = ++navigationToken;
    if (wasActive) await captureActiveTabState(state);
    if (operation !== navigationToken) return;
    state.tabs.splice(index, 1);
    if (state.tabs.length === 0) {
      closePreviewPanel();
      return;
    }
    if (!wasActive) {
      renderTabs();
      return;
    }
    const next = state.tabs[Math.min(index, state.tabs.length - 1)];
    state.activeTabId = next.id;
    renderTabs();
    await renderActiveTab(next, { preserveZoom: true, zoomLevel: next.zoomLevel, scroll: next.scroll });
  }

  async function restorePreviewForContext(key) {
    const state = getContextState(key);
    if (!state || state.tabs.length === 0) return;
    const operation = ++navigationToken;
    currentContextKey = key;
    let tab = getActiveTab(state);
    if (!tab) {
      tab = state.tabs[state.tabs.length - 1];
      state.activeTabId = tab.id;
    }
    showPanelFrame(state);
    if (operation !== navigationToken) return;
    await renderActiveTab(tab, { preserveZoom: true, zoomLevel: tab.zoomLevel, scroll: tab.scroll });
  }

  function closePreviewPanel() {
    clearPreviewNotice();
    navigationToken += 1;
    previewRenderToken += 1;
    const key = currentContextKey || getActiveContextKey();
    if (key) contextPreviewStates.delete(key);
    previewPanelEl.style.display = 'none';
    previewPanelEl.classList.remove('preview-split');
    previewSplitterEl.style.display = 'none';
    previewBodyEl.innerHTML = '';
    if (previewTabsEl) previewTabsEl.innerHTML = '';
    resetPreviewLayoutEffects();
    restoreSourcePanelVisibility();
    resetPreviewZoom({ persist: false });
    resetPreviewHeader();
    previewIsFullscreen = false;
    previewSplitRatio = 0.5;
    currentContextKey = null;
    refitActiveTerminal();
  }

  function dropPreviewContext(key) {
    if (!key) return false;
    const existed = contextPreviewStates.delete(key);
    if (currentContextKey === key) closePreviewPanel();
    return existed;
  }

  function togglePreviewLayout() {
    const state = getContextState();
    if (!state) return;
    previewIsFullscreen = !previewIsFullscreen;
    state.isFullscreen = previewIsFullscreen;
    const button = document.getElementById('preview-toggle-layout');
    if (previewIsFullscreen) {
      if (button) { button.textContent = '◫'; button.title = '并列预览'; }
      previewPanelEl.classList.remove('preview-split');
      previewSplitterEl.style.display = 'none';
      applySplitWidths(null);
      const src = previewSourcePanel ? document.getElementById(previewSourcePanel) : null;
      if (src) src.style.display = 'none';
    } else {
      if (button) { button.textContent = '□'; button.title = '全屏预览'; }
      previewPanelEl.classList.add('preview-split');
      previewSplitterEl.style.display = '';
      applySplitWidths(previewSplitRatio);
      const src = previewSourcePanel ? document.getElementById(previewSourcePanel) : null;
      if (src) src.style.display = previewSourcePanel === 'terminal-panel' ? '' : 'flex';
    }
    refitActiveTerminal();
  }

  function flashButton(button, message, status = 'success') {
    if (!button) return;
    const originalHtml = button.innerHTML;
    const originalTitle = button.title;
    button.textContent = message;
    button.dataset.flash = status;
    setTimeout(() => {
      button.innerHTML = originalHtml;
      button.title = originalTitle;
      delete button.dataset.flash;
    }, 1200);
  }

  function writeClipboard(text) {
    if (!clipboard || typeof clipboard.writeText !== 'function') throw new Error('clipboard unavailable');
    clipboard.writeText(String(text));
  }

  async function copyPreviewPath() {
    const button = document.getElementById('preview-copy-path');
    if (!currentPreviewPath) return;
    try {
      writeClipboard(currentPreviewPath);
      flashButton(button, '已复制');
    } catch (error) {
      console.warn('[preview] copy path failed:', error);
      flashButton(button, '失败', 'error');
      showPreviewNotice(`复制路径失败：${String(error && error.message || error)}`, 'error');
    }
  }

  async function copyPreviewContent() {
    const button = document.getElementById('preview-copy-content');
    const state = getContextState();
    const tab = getActiveTab(state);
    if (!currentPreviewPath || !state || !tab) return;
    const snapshot = { tabId: tab.id, path: currentPreviewPath, renderToken: previewRenderToken };
    const ext = previewExtension(snapshot.path);
    if (NON_COPYABLE_EXTENSIONS.has(ext)) {
      flashButton(button, '不可复制', 'error');
      return;
    }
    try {
      let content = '';
      const webview = previewBodyEl.querySelector('webview');
      if (webview && typeof webview.executeJavaScript === 'function') {
        let timeoutId = null;
        const request = Promise.resolve(webview.executeJavaScript(`(() => {
          const body = document.body;
          return body ? (body.innerText || body.textContent || '') : '';
        })()`));
        try {
          content = await Promise.race([
            request,
            new Promise((_, reject) => {
              timeoutId = setTimeout(() => reject(new Error('页面文字读取超时')), PREVIEW_COPY_TIMEOUT_MS);
            }),
          ]);
        } finally {
          if (timeoutId) clearTimeout(timeoutId);
        }
        if (!String(content || '').trim()) throw new Error('页面尚未就绪或没有可复制文字');
      } else {
        const result = await readPreviewFile(snapshot.path);
        if (result.error) throw new Error(result.error);
        content = result.content;
      }
      const currentState = getContextState();
      if (snapshot.renderToken !== previewRenderToken
          || currentPreviewPath !== snapshot.path
          || !currentState
          || currentState.activeTabId !== snapshot.tabId) {
        throw new Error('预览已切换，已取消复制');
      }
      writeClipboard(content || '');
      flashButton(button, '已复制');
    } catch (error) {
      console.warn('[preview] copy content failed:', error);
      flashButton(button, '复制失败', 'error');
      showPreviewNotice(`复制全文失败：${String(error && error.message || error)}`, 'error');
    }
  }

  async function showPreviewInFolder() {
    const button = document.getElementById('preview-show-in-folder');
    if (!currentPreviewPath || /^https?:\/\//i.test(currentPreviewPath)) return;
    try {
      const result = await ipcRenderer.invoke('show-in-folder', currentPreviewPath);
      if (result && result.error) {
        flashButton(button, '失败', 'error');
        showPreviewNotice(`定位失败：${result.error}`, 'error');
      }
      else flashButton(button, '已定位');
    } catch (error) {
      console.warn('[preview] show in folder failed:', error);
      flashButton(button, '失败', 'error');
      showPreviewNotice(`定位失败：${String(error && error.message || error)}`, 'error');
    }
  }

  async function openPreviewExternal() {
    if (!currentPreviewPath) return;
    const button = document.getElementById('preview-open-external');
    try {
      if (/^https?:\/\//i.test(currentPreviewPath)) {
        await shell.openExternal(currentPreviewPath);
        return;
      }
      const error = await ipcRenderer.invoke('open-path', currentPreviewPath);
      if (error) throw new Error(error);
    } catch (error) {
      console.warn('[hub] open external for preview failed:', currentPreviewPath, '->', error);
      flashButton(button, '失败', 'error');
      showPreviewNotice(`外部打开失败：${String(error && error.message || error)}`, 'error');
    }
  }

  async function handlePreviewLinkClick(event) {
    const anchor = event.target && event.target.closest && event.target.closest('a[href]');
    if (!anchor || anchor.classList.contains('rt-file-link')) return;
    const rawHref = anchor.getAttribute('href') || '';
    if (!rawHref || rawHref.startsWith('#')) return;
    event.preventDefault();
    event.stopPropagation();
    if (/^(mailto|tel|sms|callto|skype):/i.test(rawHref)) {
      await shell.openExternal(rawHref);
      return;
    }
    const protocol = /^([a-z][a-z0-9+.-]*):/i.exec(rawHref);
    if (protocol && !/^(https?|file)$/i.test(protocol[1])) {
      console.warn('[hub] unsupported scheme blocked:', rawHref);
      return;
    }
    const hashIndex = rawHref.indexOf('#');
    const withoutHash = hashIndex >= 0 ? rawHref.slice(0, hashIndex) : rawHref;
    let href;
    try { href = decodeURIComponent(withoutHash); } catch (_) { href = withoutHash; }
    if (/^https?:\/\//i.test(href)) { await openPreviewPanel(href); return; }
    let target = href;
    if (/^file:/i.test(href)) {
      try { target = fileURLToPath(href); } catch (_) { target = href.replace(/^file:\/+/i, ''); }
    }
    const isAbsolute = /^[a-zA-Z]:[\\/]/.test(target) || target.startsWith('/');
    if (!isAbsolute && currentPreviewPath && !/^https?:\/\//i.test(currentPreviewPath)) {
      try { target = path.resolve(path.dirname(currentPreviewPath), target); } catch (error) {
        console.warn('[hub] preview link resolve failed:', error);
      }
    }
    if (typeof openPath === 'function') await openPath(target);
    else await openPreviewPanel(target);
  }

  function recentQuickOpenItems() {
    const state = getContextState(currentContextKey || getActiveContextKey());
    if (!state) return [];
    return [...state.tabs]
      .sort((a, b) => b.openedAt - a.openedAt)
      .map(tab => ({
        path: tab.path,
        name: tab.title,
        relativePath: tab.path,
        isDirectory: false,
        source: 'recent',
      }));
  }

  function renderQuickOpenItems(items, statusText) {
    quickOpenItems = Array.isArray(items) ? items : [];
    quickOpenSelectedIndex = Math.min(Math.max(0, quickOpenSelectedIndex), Math.max(0, quickOpenItems.length - 1));
    if (quickOpenStatusEl) quickOpenStatusEl.textContent = statusText || '';
    if (quickOpenInputEl) quickOpenInputEl.setAttribute('aria-expanded', 'true');
    if (!quickOpenResultsEl) return;
    quickOpenResultsEl.innerHTML = '';
    if (quickOpenItems.length === 0) {
      if (quickOpenInputEl) quickOpenInputEl.removeAttribute('aria-activedescendant');
      const empty = document.createElement('div');
      empty.className = 'preview-quick-open-empty';
      empty.textContent = '没有匹配路径。可粘贴完整绝对路径后重试。';
      quickOpenResultsEl.appendChild(empty);
      return;
    }
    quickOpenItems.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = `preview-quick-open-item${index === quickOpenSelectedIndex ? ' selected' : ''}`;
      row.id = `preview-quick-open-option-${index}`;
      row.dataset.resultIndex = String(index);
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', index === quickOpenSelectedIndex ? 'true' : 'false');
      row.title = item.path;

      const icon = document.createElement('span');
      icon.className = 'preview-quick-open-item-icon';
      icon.textContent = item.isDirectory ? '▰' : '▤';
      const main = document.createElement('span');
      main.className = 'preview-quick-open-item-main';
      const name = document.createElement('span');
      name.className = 'preview-quick-open-item-name';
      name.textContent = item.name || previewTitle(item.path);
      const pathEl = document.createElement('span');
      pathEl.className = 'preview-quick-open-item-path';
      pathEl.textContent = item.relativePath || item.path;
      main.append(name, pathEl);
      const source = document.createElement('span');
      source.className = 'preview-quick-open-item-source';
      source.textContent = item.source === 'exact' ? '精确' : item.source === 'recent' ? '最近' : '本地';
      row.append(icon, main, source);
      quickOpenResultsEl.appendChild(row);
    });
    if (quickOpenInputEl && quickOpenItems.length > 0) {
      quickOpenInputEl.setAttribute('aria-activedescendant', `preview-quick-open-option-${quickOpenSelectedIndex}`);
    }
  }

  async function runQuickOpenSearch(query, token, activateFirst = false) {
    const contextKey = getActiveContextKey();
    const cwd = getActiveCwd && getActiveCwd();
    const requestStillCurrent = () => (
      token === quickOpenSearchToken
      && quickOpenEl
      && quickOpenEl.style.display === 'flex'
      && getActiveContextKey() === contextKey
      && String(getActiveCwd && getActiveCwd() || '') === String(cwd || '')
    );
    let result;
    try {
      result = await ipcRenderer.invoke('preview:search-paths', { query, cwd, limit: 40 });
    } catch (error) {
      if (!requestStillCurrent()) return;
      renderQuickOpenItems([], `搜索失败：${String(error && error.message || error)}`);
      return;
    }
    if (!requestStillCurrent()) return;
    const items = result && Array.isArray(result.results) ? result.results : [];
    const scope = cwd ? `当前 workspace · ${result.indexedCount || 0} 项` : '仅检查精确绝对路径';
    const suffix = result && result.truncated ? ' · 索引已达上限' : '';
    const warning = result && result.errorsCount ? ` · ${result.errorsCount} 个目录不可读` : '';
    renderQuickOpenItems(items, result && result.error ? `搜索失败：${result.error}` : `${scope}${suffix}${warning}`);
    if (activateFirst && items.length > 0 && requestStillCurrent()) {
      await activateQuickOpenItem(0);
    }
  }

  function handleQuickOpenInput() {
    const query = String(quickOpenInputEl && quickOpenInputEl.value || '').trim();
    quickOpenSearchToken += 1;
    const token = quickOpenSearchToken;
    if (quickOpenTimer) {
      clearTimeout(quickOpenTimer);
      quickOpenTimer = null;
    }
    if (!query) {
      const recent = recentQuickOpenItems();
      renderQuickOpenItems(recent, recent.length ? '当前会话最近预览' : '输入绝对路径、相对路径或文件名');
      return;
    }
    renderQuickOpenItems([], '正在本地搜索…');
    quickOpenTimer = setTimeout(() => {
      quickOpenTimer = null;
      void runQuickOpenSearch(query, token);
    }, QUICK_OPEN_DEBOUNCE_MS);
  }

  async function activateQuickOpenItem(index = quickOpenSelectedIndex) {
    const item = quickOpenItems[index];
    if (!item || !item.path) return;
    const items = quickOpenItems.slice();
    const returnFocus = quickOpenReturnFocus;
    closeQuickOpen({ restoreFocus: false });
    try {
      if (typeof openPath === 'function') await openPath(item.path);
      else await openPreviewPanel(item.path);
      const state = getContextState();
      if (state && state.activeTabId) focusPreviewTab(state.activeTabId);
      else if (returnFocus && returnFocus.isConnected !== false && typeof returnFocus.focus === 'function') returnFocus.focus();
    } catch (error) {
      console.warn('[preview] quick open failed:', item.path, error);
      if (quickOpenEl) quickOpenEl.style.display = 'flex';
      quickOpenReturnFocus = returnFocus;
      if (quickOpenInputEl) {
        quickOpenInputEl.value = item.path;
        quickOpenInputEl.setAttribute('aria-expanded', 'true');
      }
      renderQuickOpenItems(items, `打开失败：${String(error && error.message || error)}`);
      try { quickOpenInputEl.focus(); } catch (_) {}
    }
  }

  function paintQuickOpenSelection() {
    if (!quickOpenResultsEl) return;
    const rows = quickOpenResultsEl.querySelectorAll('.preview-quick-open-item');
    rows.forEach((row, index) => {
      const selected = index === quickOpenSelectedIndex;
      row.classList.toggle('selected', selected);
      row.setAttribute('aria-selected', selected ? 'true' : 'false');
    });
    if (quickOpenInputEl) {
      if (rows[quickOpenSelectedIndex]) {
        quickOpenInputEl.setAttribute('aria-activedescendant', rows[quickOpenSelectedIndex].id);
      } else {
        quickOpenInputEl.removeAttribute('aria-activedescendant');
      }
    }
    if (rows[quickOpenSelectedIndex]) rows[quickOpenSelectedIndex].scrollIntoView({ block: 'nearest' });
  }

  function openQuickOpen() {
    if (!quickOpenEl || !quickOpenInputEl) return;
    if (quickOpenEl.style.display !== 'flex') quickOpenReturnFocus = document.activeElement || null;
    quickOpenEl.style.display = 'flex';
    quickOpenInputEl.setAttribute('aria-expanded', 'true');
    quickOpenInputEl.value = '';
    quickOpenSearchToken += 1;
    const recent = recentQuickOpenItems();
    renderQuickOpenItems(recent, recent.length ? '当前会话最近预览' : '输入绝对路径、相对路径或文件名');
    setTimeout(() => {
      try { quickOpenInputEl.focus(); } catch (_) {}
    }, 0);
  }

  function closeQuickOpen({ restoreFocus = true } = {}) {
    if (quickOpenTimer) {
      clearTimeout(quickOpenTimer);
      quickOpenTimer = null;
    }
    quickOpenSearchToken += 1;
    if (quickOpenEl) quickOpenEl.style.display = 'none';
    if (quickOpenInputEl) {
      quickOpenInputEl.setAttribute('aria-expanded', 'false');
      quickOpenInputEl.removeAttribute('aria-activedescendant');
    }
    const returnFocus = quickOpenReturnFocus;
    quickOpenReturnFocus = null;
    if (restoreFocus && returnFocus && returnFocus.isConnected !== false && typeof returnFocus.focus === 'function') {
      setTimeout(() => {
        try { returnFocus.focus(); } catch (_) {}
      }, 0);
    }
  }

  function handleQuickOpenKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeQuickOpen();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (quickOpenItems.length === 0) return;
      quickOpenSelectedIndex = Math.min(quickOpenItems.length - 1, quickOpenSelectedIndex + 1);
      paintQuickOpenSelection();
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (quickOpenItems.length === 0) return;
      quickOpenSelectedIndex = Math.max(0, quickOpenSelectedIndex - 1);
      paintQuickOpenSelection();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (quickOpenItems.length > 0) void activateQuickOpenItem();
      else {
        const query = String(quickOpenInputEl.value || '').trim();
        if (query) {
          if (quickOpenTimer) {
            clearTimeout(quickOpenTimer);
            quickOpenTimer = null;
          }
          quickOpenSearchToken += 1;
          void runQuickOpenSearch(query, quickOpenSearchToken, true);
        }
      }
    }
  }

  function initSplitterDrag() {
    let dragging = false;
    let rafId = 0;
    previewSplitterEl.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      dragging = true;
      previewSplitterEl.classList.add('dragging');
      previewBodyEl.style.pointerEvents = 'none';
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });
    document.addEventListener('mousemove', (event) => {
      if (!dragging || rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        const src = previewSourcePanel ? document.getElementById(previewSourcePanel) : null;
        if (!src) return;
        const srcRect = src.getBoundingClientRect();
        const previewRect = previewPanelEl.getBoundingClientRect();
        const totalContent = srcRect.width + previewRect.width;
        if (totalContent <= 0) return;
        const desired = event.clientX - srcRect.left;
        previewSplitRatio = Math.max(0.1, Math.min(0.9, desired / totalContent));
        const state = getContextState();
        if (state) state.splitRatio = previewSplitRatio;
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

  function addClickListener(id, handler) {
    const element = document.getElementById(id);
    if (element) element.addEventListener('click', handler);
  }

  previewBodyEl.addEventListener('click', event => {
    void runAsyncAction(() => handlePreviewLinkClick(event), '链接打开失败');
  });
  if (previewTabsEl) {
    previewTabsEl.addEventListener('click', event => {
      const close = event.target && event.target.closest && event.target.closest('[data-close-tab-id]');
      if (close) {
        event.preventDefault();
        event.stopPropagation();
        void runAsyncAction(() => closePreviewTab(close.dataset.closeTabId), '关闭预览失败');
        return;
      }
      const tab = event.target && event.target.closest && event.target.closest('[data-tab-id]');
      if (tab) void runAsyncAction(() => switchPreviewTab(tab.dataset.tabId), '切换预览失败');
    });
    previewTabsEl.addEventListener('keydown', event => {
      const tabElement = event.target && event.target.closest && event.target.closest('[data-tab-id]');
      if (!tabElement || event.target.closest('[data-close-tab-id]')) return;
      const state = getContextState();
      if (!state || state.tabs.length === 0) return;
      const currentIndex = state.tabs.findIndex(tab => tab.id === tabElement.dataset.tabId);
      let targetIndex = null;
      if (event.key === 'ArrowLeft') targetIndex = (currentIndex - 1 + state.tabs.length) % state.tabs.length;
      else if (event.key === 'ArrowRight') targetIndex = (currentIndex + 1) % state.tabs.length;
      else if (event.key === 'Home') targetIndex = 0;
      else if (event.key === 'End') targetIndex = state.tabs.length - 1;
      else if (event.key === 'Delete') {
        event.preventDefault();
        void runAsyncAction(() => closePreviewTab(tabElement.dataset.tabId), '关闭预览失败');
        return;
      }
      if (targetIndex === null) return;
      event.preventDefault();
      const targetId = state.tabs[targetIndex].id;
      void runAsyncAction(async () => {
        await switchPreviewTab(targetId);
        focusPreviewTab(targetId);
      }, '切换预览失败');
    });
  }
  addClickListener('preview-close', closePreviewPanel);
  addClickListener('preview-toggle-layout', togglePreviewLayout);
  addClickListener('preview-open-external', () => { void runAsyncAction(openPreviewExternal, '外部打开失败'); });
  addClickListener('preview-copy-content', () => { void runAsyncAction(copyPreviewContent, '复制全文失败'); });
  addClickListener('preview-copy-path', () => { void runAsyncAction(copyPreviewPath, '复制路径失败'); });
  addClickListener('preview-show-in-folder', () => { void runAsyncAction(showPreviewInFolder, '资源管理器定位失败'); });
  addClickListener('preview-open-path', openQuickOpen);
  addClickListener('preview-new-tab', openQuickOpen);
  addClickListener('btn-preview-path', openQuickOpen);
  addClickListener('preview-quick-open-close', closeQuickOpen);
  addClickListener('preview-zoom-out', () => setPreviewZoom(previewZoomLevel - 0.1));
  addClickListener('preview-zoom-in', () => setPreviewZoom(previewZoomLevel + 0.1));
  addClickListener('preview-zoom-reset', () => resetPreviewZoom());
  if (quickOpenInputEl) {
    quickOpenInputEl.addEventListener('input', handleQuickOpenInput);
    quickOpenInputEl.addEventListener('keydown', handleQuickOpenKeydown);
  }
  if (quickOpenEl) {
    quickOpenEl.addEventListener('mousedown', event => {
      if (event.target === quickOpenEl) closeQuickOpen();
    });
  }
  if (quickOpenResultsEl) {
    quickOpenResultsEl.addEventListener('mousemove', event => {
      const row = event.target && event.target.closest && event.target.closest('[data-result-index]');
      if (!row) return;
      quickOpenSelectedIndex = Number(row.dataset.resultIndex) || 0;
      paintQuickOpenSelection();
    });
    quickOpenResultsEl.addEventListener('click', event => {
      const row = event.target && event.target.closest && event.target.closest('[data-result-index]');
      if (row) void runAsyncAction(
        () => activateQuickOpenItem(Number(row.dataset.resultIndex) || 0),
        '路径打开失败',
      );
    });
  }

  document.addEventListener('keydown', (event) => {
    if (quickOpenEl && quickOpenEl.style.display === 'flex') {
      if (event.key === 'Tab') {
        const focusable = Array.from(quickOpenEl.querySelectorAll('input, button, [tabindex]'))
          .filter(element => !element.disabled && Number(element.tabIndex) >= 0);
        if (focusable.length > 0) {
          event.preventDefault();
          const current = focusable.indexOf(document.activeElement);
          const next = event.shiftKey
            ? (current <= 0 ? focusable.length - 1 : current - 1)
            : (current < 0 || current === focusable.length - 1 ? 0 : current + 1);
          focusable[next].focus();
        }
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeQuickOpen();
        return;
      }
    }
    if (event.key !== 'Escape') return;
    if (previewPanelEl.style.display === 'flex') {
      event.preventDefault();
      event.stopPropagation();
      closePreviewPanel();
    }
  }, true);
  previewBodyEl.addEventListener('wheel', (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    setPreviewZoom(previewZoomLevel + (event.deltaY < 0 ? 0.1 : -0.1));
  }, { passive: false });
  initSplitterDrag();
  updateActionAvailability();

  return {
    openPreviewPanel,
    closePreviewPanel,
    savePreviewState,
    clearPreviewUI,
    restorePreviewForContext,
    switchPreviewTab,
    closePreviewTab,
    dropPreviewContext,
    openQuickOpen,
    closeQuickOpen,
    copyPreviewContent,
    copyPreviewPath,
    showPreviewNotice,
    getPreviewState(key = currentContextKey || getActiveContextKey()) {
      const state = getContextState(key);
      if (!state) return null;
      return {
        activeTabId: state.activeTabId,
        isFullscreen: state.isFullscreen,
        splitRatio: state.splitRatio,
        tabs: state.tabs.map(tab => ({ ...tab, scroll: tab.scroll ? { ...tab.scroll } : null })),
      };
    },
  };
}

module.exports = {
  QUICK_OPEN_DEBOUNCE_MS,
  cleanPreviewTarget,
  createPreviewPanelController,
  previewPathKey,
  previewTitle,
};
