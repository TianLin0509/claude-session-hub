'use strict';

const path = require('path');
const { isPathInsideRoot } = require('../core/file-manager-directory.js');

const PREVIEWABLE_EXTENSIONS = new Set([
  '.html', '.htm', '.md', '.markdown', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.pdf',
  '.csv', '.tsv', '.json', '.jsonl', '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.py', '.go', '.rs',
  '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.txt', '.log', '.yaml', '.yml', '.toml', '.ini', '.cfg',
  '.conf', '.sh', '.bat', '.ps1', '.xml', '.sql', '.r', '.rb', '.php', '.swift', '.kt', '.lua', '.zig',
  '.asm', '.css', '.scss', '.less',
]);

const FILE_ICON_PATHS = Object.freeze({
  folder: '<path d="M3 6.8A1.8 1.8 0 0 1 4.8 5h4l1.7 1.8h8.7A1.8 1.8 0 0 1 21 8.6v8.6a1.8 1.8 0 0 1-1.8 1.8H4.8A1.8 1.8 0 0 1 3 17.2Z"/>',
  file: '<path d="M6 2.8h7l5 5v13.4H6Z"/><path d="M13 2.8v5h5"/>',
  code: '<path d="M8.5 8 5 12l3.5 4M15.5 8 19 12l-3.5 4M13.5 5l-3 14"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.7"/><path d="m5 18 4.5-4 3.2 2.7 2.7-2.5L19 18"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 4v16M15 4v16"/>',
  link: '<path d="m9.5 14.5 5-5M7 16.8l-1.3 1.3a3 3 0 0 1-4.2-4.2l3-3a3 3 0 0 1 4.2 0M17 7.2l1.3-1.3a3 3 0 0 1 4.2 4.2l-3 3a3 3 0 0 1-4.2 0"/>',
});

function extensionOf(name) {
  const match = String(name || '').toLowerCase().match(/(\.[^.\\/]+)$/);
  return match ? match[1] : '';
}

function fileVisualKind(name, type = 'file') {
  if (type === 'directory') return 'folder';
  if (type === 'link') return 'link';
  const extension = extensionOf(name);
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].includes(extension)) return 'image';
  if (['.csv', '.tsv', '.json', '.jsonl', '.xml', '.yaml', '.yml', '.toml'].includes(extension)) return 'table';
  if (['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.sh', '.bat', '.ps1', '.sql', '.r', '.rb', '.php', '.swift', '.kt', '.lua', '.zig', '.asm', '.css', '.scss', '.less', '.html', '.htm'].includes(extension)) return 'code';
  return 'file';
}

function isPreviewableFile(name) {
  return PREVIEWABLE_EXTENSIONS.has(extensionOf(name));
}

function createFileManagerPanel(options = {}) {
  const document = options.document;
  const windowObject = options.window || (document && document.defaultView) || globalThis;
  const ipcRenderer = options.ipcRenderer;
  const getActiveContext = typeof options.getActiveContext === 'function' ? options.getActiveContext : () => null;
  const openPathInHub = typeof options.openPathInHub === 'function' ? options.openPathInHub : async () => ({ ok: false });
  const onLayoutChange = typeof options.onLayoutChange === 'function' ? options.onLayoutChange : () => {};
  if (!document) throw new Error('document is required');
  if (!ipcRenderer || typeof ipcRenderer.invoke !== 'function') throw new Error('ipcRenderer is required');

  const state = {
    root: '',
    label: '',
    generation: 0,
    cache: new Map(),
    expanded: new Set(),
    selectedPath: '',
    query: '',
    statusTimer: null,
  };

  const elements = {};

  function contextFrom(value, allowFallback = true) {
    if (typeof value === 'string') return { cwd: value, label: '' };
    if (value && typeof value === 'object') {
      return {
        cwd: String(value.cwd || value.root || '').trim(),
        label: String(value.label || value.workspaceLabel || '').trim(),
      };
    }
    return allowFallback ? contextFrom(getActiveContext(), false) : { cwd: '', label: '' };
  }

  function pathKey(value) {
    try { return path.resolve(String(value || '')).toLowerCase(); }
    catch (_) { return String(value || '').toLowerCase(); }
  }

  function isOpen() {
    return !!(elements.panel && elements.panel.style.display !== 'none');
  }

  function isOpenFor(root) {
    return isOpen() && String(root || '').toLowerCase() === state.root.toLowerCase();
  }

  function syncToggleButtons() {
    document.querySelectorAll('.btn-file-manager-toggle').forEach((button) => {
      button.classList.toggle('active', isOpenFor(button.dataset && button.dataset.root));
      button.setAttribute('aria-pressed', String(isOpenFor(button.dataset && button.dataset.root)));
    });
  }

  function scheduleLayoutUpdate() {
    const run = () => {
      try { onLayoutChange(); } catch (_) {}
    };
    if (windowObject && typeof windowObject.requestAnimationFrame === 'function') {
      windowObject.requestAnimationFrame(run);
    } else {
      setTimeout(run, 0);
    }
  }

  function setStatus(message, tone = '', { sticky = false } = {}) {
    if (!elements.status) return;
    if (state.statusTimer) clearTimeout(state.statusTimer);
    state.statusTimer = null;
    elements.status.textContent = String(message || '');
    elements.status.dataset.tone = tone;
    if (message && !sticky) {
      state.statusTimer = setTimeout(() => {
        state.statusTimer = null;
        refreshStatusSummary();
      }, 2200);
    }
  }

  function refreshStatusSummary() {
    const record = state.cache.get(state.root);
    if (!record || record.loading) {
      setStatus(state.root ? '正在读取…' : '当前会话没有工作目录', '', { sticky: true });
      return;
    }
    if (record.error) {
      setStatus(record.error, 'error', { sticky: true });
      return;
    }
    const suffix = record.truncated ? ` · 仅显示前 ${record.entries.length} 项` : '';
    const filter = state.query ? ` · 筛选“${state.query}”` : '';
    setStatus(`${record.total} 项${suffix}${filter}`, record.truncated ? 'warning' : '', { sticky: true });
  }

  function iconSvg(kind, className = '') {
    const paths = FILE_ICON_PATHS[kind] || FILE_ICON_PATHS.file;
    return `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  }

  function makeMessageRow(text, depth = 0, tone = '') {
    const row = document.createElement('div');
    row.className = `fm-tree-message${tone ? ` ${tone}` : ''}`;
    row.style.setProperty('--fm-depth', String(depth));
    row.textContent = text;
    return row;
  }

  function descendantMatches(directory, query, seen = new Set()) {
    if (!query || seen.has(directory)) return false;
    seen.add(directory);
    const record = state.cache.get(directory);
    if (!record || !Array.isArray(record.entries)) return false;
    return record.entries.some((entry) => {
      if (entry.name.toLowerCase().includes(query)) return true;
      return entry.type === 'directory' && state.expanded.has(entry.path)
        && descendantMatches(entry.path, query, seen);
    });
  }

  function shouldShowEntry(entry, query) {
    if (!query) return true;
    if (entry.name.toLowerCase().includes(query)) return true;
    return entry.type === 'directory' && state.expanded.has(entry.path)
      && descendantMatches(entry.path, query);
  }

  function makeTreeRow(entry, depth) {
    const row = document.createElement('div');
    row.className = `fm-node fm-node-${entry.type}${entry.hidden ? ' is-hidden' : ''}`;
    row.setAttribute('role', 'none');
    row.style.setProperty('--fm-depth', String(depth));

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'fm-node-button';
    button.dataset.fmNode = 'true';
    button.dataset.path = entry.path;
    button.dataset.type = entry.type;
    button.setAttribute('role', 'treeitem');
    button.setAttribute('aria-level', String(depth + 1));
    if (entry.path === state.selectedPath) button.classList.add('selected');
    if (entry.type === 'directory') {
      button.setAttribute('aria-expanded', String(state.expanded.has(entry.path)));
    }
    const action = entry.type === 'directory'
      ? (state.expanded.has(entry.path) ? '折叠文件夹' : '展开文件夹')
      : (isPreviewableFile(entry.name) ? '在 Hub 中预览' : '使用系统应用打开');
    button.title = `${action} · ${entry.path}`;

    const disclosure = document.createElement('span');
    disclosure.className = 'fm-disclosure';
    if (entry.type === 'directory') {
      disclosure.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m6 3.5 4.5 4.5L6 12.5"/></svg>';
      disclosure.classList.toggle('expanded', state.expanded.has(entry.path));
    }

    const kind = fileVisualKind(entry.name, entry.type);
    const icon = document.createElement('span');
    icon.className = `fm-node-icon ${kind}`;
    icon.innerHTML = iconSvg(kind);
    const name = document.createElement('span');
    name.className = 'fm-node-name';
    name.textContent = entry.name;
    const meta = document.createElement('span');
    meta.className = 'fm-node-meta';
    if (entry.type === 'directory') {
      const child = state.cache.get(entry.path);
      if (child && !child.loading && !child.error) meta.textContent = String(child.total);
    } else if (entry.type === 'link') {
      meta.textContent = '链接';
    } else {
      meta.textContent = entry.extension ? entry.extension.slice(1).toUpperCase() : '';
    }
    button.append(disclosure, icon, name, meta);
    row.appendChild(button);
    return row;
  }

  function appendDirectory(directory, depth, query, ancestry = new Set()) {
    if (ancestry.has(directory)) return;
    const nextAncestry = new Set(ancestry);
    nextAncestry.add(directory);
    const record = state.cache.get(directory);
    if (!record || record.loading) {
      elements.tree.appendChild(makeMessageRow('正在读取…', depth, 'loading'));
      return;
    }
    if (record.error) {
      elements.tree.appendChild(makeMessageRow(record.error, depth, 'error'));
      return;
    }
    for (const entry of record.entries) {
      if (!shouldShowEntry(entry, query)) continue;
      elements.tree.appendChild(makeTreeRow(entry, depth));
      if (entry.type === 'directory' && state.expanded.has(entry.path)) {
        appendDirectory(entry.path, depth + 1, query, nextAncestry);
      }
    }
    if (record.truncated) {
      elements.tree.appendChild(makeMessageRow(`此目录共 ${record.total} 项，仅显示前 ${record.entries.length} 项`, depth, 'warning'));
    }
  }

  function renderTree() {
    if (!elements.tree) return;
    elements.tree.replaceChildren();
    if (!state.root) {
      elements.tree.appendChild(makeMessageRow('打开一个带工作目录的会话后即可浏览文件。'));
      refreshStatusSummary();
      return;
    }
    appendDirectory(state.root, 0, state.query.toLowerCase());
    if (!elements.tree.children.length) {
      elements.tree.appendChild(makeMessageRow(state.query ? '没有匹配的已加载文件' : '这个文件夹是空的'));
    }
    refreshStatusSummary();
  }

  async function loadDirectory(directory, generation = state.generation) {
    state.cache.set(directory, { loading: true, entries: [], total: 0, truncated: false, error: '' });
    renderTree();
    let result;
    try {
      result = await ipcRenderer.invoke('file-manager:list-directory', {
        root: state.root,
        directory,
        limit: 3000,
      });
    } catch (error) {
      result = { ok: false, error: String(error && error.message || error), entries: [] };
    }
    if (generation !== state.generation || !isOpen()) return result;
    state.cache.set(directory, {
      loading: false,
      entries: result && Array.isArray(result.entries) ? result.entries : [],
      total: Number(result && result.total) || 0,
      truncated: !!(result && result.truncated),
      error: result && result.ok === true ? '' : String(result && result.error || '目录读取失败'),
    });
    renderTree();
    return result;
  }

  async function setRoot(context) {
    const next = contextFrom(context);
    state.generation += 1;
    state.root = next.cwd;
    state.label = next.label;
    state.cache.clear();
    state.expanded.clear();
    state.selectedPath = '';
    state.query = '';
    if (elements.filter) elements.filter.value = '';
    if (elements.rootName) elements.rootName.textContent = next.label || (next.cwd ? next.cwd.split(/[\\/]/).filter(Boolean).pop() : '未选择目录');
    if (elements.rootPath) elements.rootPath.textContent = next.cwd || '当前会话没有工作目录';
    if (elements.rootButton) {
      elements.rootButton.disabled = !next.cwd;
      elements.rootButton.title = next.cwd ? `在资源管理器中打开 · ${next.cwd}` : '当前会话没有工作目录';
    }
    if (!next.cwd) {
      renderTree();
      syncToggleButtons();
      return { ok: false, error: 'missing workspace' };
    }
    state.expanded.add(next.cwd);
    syncToggleButtons();
    return loadDirectory(next.cwd, state.generation);
  }

  function dispatchPanelOpening() {
    const CustomEventCtor = windowObject && windowObject.CustomEvent;
    if (typeof CustomEventCtor === 'function') {
      document.dispatchEvent(new CustomEventCtor('hub-side-panel-opening', { detail: { panel: 'files' } }));
    }
  }

  async function open(context) {
    const next = contextFrom(context);
    dispatchPanelOpening();
    elements.panel.style.display = 'flex';
    elements.panel.setAttribute('aria-hidden', 'false');
    scheduleLayoutUpdate();
    return setRoot(next);
  }

  function scrollSelectedIntoView() {
    const selectedKey = pathKey(state.selectedPath);
    if (!selectedKey || !elements.tree) return;
    const selected = Array.from(elements.tree.querySelectorAll('[data-fm-node]'))
      .find(button => pathKey(button.dataset.path) === selectedKey);
    if (selected && typeof selected.scrollIntoView === 'function') {
      selected.scrollIntoView({ block: 'center', inline: 'nearest' });
    }
  }

  async function revealDirectory(directory) {
    const target = path.resolve(String(directory || ''));
    if (!state.root || !isPathInsideRoot(state.root, target)) {
      return { ok: false, error: 'target is outside the displayed root', code: 'outside_root' };
    }
    const relative = path.relative(state.root, target);
    if (!relative) {
      state.selectedPath = '';
      renderTree();
      setStatus('已在文件管理中打开', 'success');
      return { ok: true, root: state.root, target, revealed: true };
    }

    let current = state.root;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      const expected = path.join(current, segment);
      const record = state.cache.get(current);
      const entry = record && !record.loading && !record.error
        ? record.entries.find(item => item.type === 'directory' && pathKey(item.path) === pathKey(expected))
        : null;
      if (!entry) {
        return { ok: false, error: `无法在文件树中定位目录：${expected}`, code: 'directory_not_found' };
      }
      current = entry.path;
      state.expanded.add(current);
      if (!state.cache.has(current)) {
        const loaded = await loadDirectory(current, state.generation);
        if (!loaded || loaded.ok !== true) {
          return { ok: false, error: loaded && loaded.error || `目录读取失败：${current}`, code: 'read_failed' };
        }
      }
    }
    state.selectedPath = current;
    renderTree();
    scrollSelectedIntoView();
    setStatus('已定位到目录', 'success');
    return { ok: true, root: state.root, target: current, revealed: true };
  }

  async function openDirectory(directory, context) {
    const target = typeof directory === 'string' && path.isAbsolute(directory)
      ? path.resolve(directory)
      : '';
    if (!target) return { ok: false, error: 'invalid directory path', code: 'invalid_path' };
    const preferred = contextFrom(context);
    const active = contextFrom(getActiveContext(), false);
    if (!preferred.label && active.cwd && pathKey(active.cwd) === pathKey(preferred.cwd)) {
      preferred.label = active.label;
    }
    const preferredRoot = preferred.cwd && isPathInsideRoot(preferred.cwd, target)
      ? path.resolve(preferred.cwd)
      : target;
    let opened = await open({
      cwd: preferredRoot,
      label: pathKey(preferredRoot) === pathKey(target)
        ? (preferred.label || path.basename(target))
        : preferred.label,
    });
    if ((!opened || opened.ok !== true) && pathKey(preferredRoot) !== pathKey(target)) {
      opened = await open({ cwd: target, label: path.basename(target) });
    }
    if (!opened || opened.ok !== true) return opened || { ok: false, error: 'directory open failed' };

    const revealed = await revealDirectory(target);
    if (revealed.ok) return revealed;
    if (pathKey(state.root) !== pathKey(target)) {
      const fallback = await open({ cwd: target, label: path.basename(target) });
      if (fallback && fallback.ok === true) {
        setStatus('已在文件管理中打开', 'success');
        return { ok: true, root: target, target, revealed: false };
      }
      return fallback;
    }
    return revealed;
  }

  function close() {
    if (!elements.panel || elements.panel.style.display === 'none') return false;
    state.generation += 1;
    elements.panel.style.display = 'none';
    elements.panel.setAttribute('aria-hidden', 'true');
    syncToggleButtons();
    scheduleLayoutUpdate();
    return true;
  }

  function toggle(context) {
    const next = contextFrom(context);
    if (isOpenFor(next.cwd)) {
      close();
      return Promise.resolve({ ok: true, closed: true });
    }
    return open(next);
  }

  function syncContext(context) {
    if (!isOpen()) {
      syncToggleButtons();
      return Promise.resolve(false);
    }
    const next = contextFrom(context);
    if (next.cwd.toLowerCase() === state.root.toLowerCase()) {
      syncToggleButtons();
      return Promise.resolve(false);
    }
    return setRoot(next).then(() => true);
  }

  async function openRootExternal() {
    if (!state.root) return;
    let error = '';
    try { error = await ipcRenderer.invoke('open-path', state.root); }
    catch (caught) { error = String(caught && caught.message || caught); }
    setStatus(error ? `打开失败：${error}` : '已在资源管理器中打开', error ? 'error' : 'success');
  }

  async function activateEntry(button) {
    const targetPath = String(button.dataset.path || '');
    const type = String(button.dataset.type || 'file');
    if (!targetPath) return;
    if (type === 'directory') {
      if (state.expanded.has(targetPath)) {
        state.expanded.delete(targetPath);
        renderTree();
        return;
      }
      state.expanded.add(targetPath);
      if (!state.cache.has(targetPath)) await loadDirectory(targetPath);
      else renderTree();
      return;
    }
    if (type === 'link' || type === 'other') {
      let error = '';
      try { error = await ipcRenderer.invoke('open-path', targetPath); }
      catch (caught) { error = String(caught && caught.message || caught); }
      setStatus(error ? `打开失败：${error}` : '已使用系统应用打开', error ? 'error' : 'success');
      return;
    }
    state.selectedPath = targetPath;
    renderTree();
    let result;
    try {
      result = await openPathInHub(targetPath, { cwd: state.root, preview: true });
    } catch (error) {
      setStatus(`文件打开失败：${String(error && error.message || error)}`, 'error');
      return;
    }
    if (!result || result.ok === false) {
      setStatus(result && result.error ? result.error : '文件打开失败', 'error');
      return;
    }
    setStatus(result.type === 'preview' ? '已在 Hub 中预览' : '已使用系统应用打开', 'success');
  }

  function handleTreeKeyboard(event) {
    const current = event.target && event.target.closest && event.target.closest('[data-fm-node]');
    if (!current) return;
    const buttons = Array.from(elements.tree.querySelectorAll('[data-fm-node]'));
    const index = buttons.indexOf(current);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const next = buttons[Math.max(0, Math.min(buttons.length - 1, index + delta))];
      if (next) next.focus();
      return;
    }
    if (event.key === 'ArrowRight' && current.dataset.type === 'directory' && current.getAttribute('aria-expanded') !== 'true') {
      event.preventDefault();
      void activateEntry(current);
    } else if (event.key === 'ArrowLeft' && current.dataset.type === 'directory' && current.getAttribute('aria-expanded') === 'true') {
      event.preventDefault();
      void activateEntry(current);
    }
  }

  function init() {
    elements.panel = document.getElementById('file-manager-panel');
    elements.tree = document.getElementById('file-manager-tree');
    elements.filter = document.getElementById('file-manager-filter');
    elements.status = document.getElementById('file-manager-status');
    elements.rootButton = document.getElementById('file-manager-root');
    elements.rootName = document.getElementById('file-manager-root-name');
    elements.rootPath = document.getElementById('file-manager-root-path');
    elements.close = document.getElementById('file-manager-close');
    elements.refresh = document.getElementById('file-manager-refresh');
    elements.openExternal = document.getElementById('file-manager-open-external');
    if (!elements.panel || !elements.tree || !elements.filter) return false;

    elements.close.addEventListener('click', close);
    elements.refresh.addEventListener('click', () => { if (state.root) void setRoot({ cwd: state.root, label: state.label }); });
    elements.openExternal.addEventListener('click', () => { void openRootExternal(); });
    elements.rootButton.addEventListener('click', () => { void openRootExternal(); });
    elements.filter.addEventListener('input', () => {
      state.query = elements.filter.value.trim();
      renderTree();
    });
    for (const name of ['keydown', 'keypress', 'keyup']) {
      elements.filter.addEventListener(name, event => event.stopPropagation());
    }
    elements.tree.addEventListener('click', (event) => {
      const button = event.target.closest && event.target.closest('[data-fm-node]');
      if (button) void activateEntry(button);
    });
    elements.tree.addEventListener('keydown', handleTreeKeyboard);
    document.addEventListener('hub-side-panel-opening', (event) => {
      if (event && event.detail && event.detail.panel !== 'files') close();
    });
    renderTree();
    return true;
  }

  return {
    close,
    init,
    isOpen,
    isOpenFor,
    open,
    openDirectory,
    refresh: () => setRoot({ cwd: state.root, label: state.label }),
    syncContext,
    toggle,
  };
}

module.exports = {
  PREVIEWABLE_EXTENSIONS,
  createFileManagerPanel,
  extensionOf,
  fileVisualKind,
  isPreviewableFile,
};
