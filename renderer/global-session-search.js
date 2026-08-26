'use strict';

const { isBlockingModalOpen } = require('./modal-layer-guard.js');

const PROVIDER_META = Object.freeze({
  claude: { label: 'Claude', className: 'provider-claude' },
  codex: { label: 'Codex', className: 'provider-codex' },
  meeting: { label: '群聊', className: 'provider-meeting' },
  deepseek: { label: 'DeepSeek', className: 'provider-deepseek' },
  all: { label: '全部', className: 'provider-all' },
});

const SCOPE_LABELS = Object.freeze({
  title: '标题',
  user: '我的提问',
  assistant: 'AI 回答',
  tool: '工具 / 文件',
});

function normalizeTerms(query) {
  return String(query || '').normalize('NFKC').toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
}

function appendHighlightedText(document, root, text, query) {
  const raw = String(text || '');
  const terms = normalizeTerms(query).sort((a, b) => b.length - a.length);
  if (!terms.length) {
    root.appendChild(document.createTextNode(raw));
    return;
  }
  const lower = raw.normalize('NFKC').toLocaleLowerCase();
  let cursor = 0;
  while (cursor < raw.length) {
    let next = null;
    for (const term of terms) {
      const index = lower.indexOf(term, cursor);
      if (index < 0) continue;
      if (!next || index < next.index || (index === next.index && term.length > next.term.length)) {
        next = { index, term };
      }
    }
    if (!next) {
      root.appendChild(document.createTextNode(raw.slice(cursor)));
      break;
    }
    if (next.index > cursor) root.appendChild(document.createTextNode(raw.slice(cursor, next.index)));
    const mark = document.createElement('mark');
    mark.textContent = raw.slice(next.index, next.index + next.term.length);
    root.appendChild(mark);
    cursor = next.index + next.term.length;
  }
}

function formatSearchTime(timestamp, now = Date.now()) {
  const at = Number(timestamp) || 0;
  if (!at) return '';
  const diff = Math.max(0, now - at);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 2 * day) return '昨天';
  const date = new Date(at);
  const year = date.getFullYear() === new Date(now).getFullYear() ? '' : `${date.getFullYear()}-`;
  return `${year}${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatAbsolute(timestamp) {
  if (!timestamp) return '';
  try { return new Date(timestamp).toLocaleString('zh-CN', { hour12: false }); }
  catch { return ''; }
}

function providerMeta(provider) {
  return PROVIDER_META[provider] || { label: provider || 'AI', className: 'provider-all' };
}

function createStaticEmpty(document, { title, detail, className = '', busy = false } = {}) {
  const empty = document.createElement('div');
  empty.className = `session-search-empty ${className || ''}${busy ? ' busy' : ''}`.trim();
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '1.5');
  icon.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', busy ? 'M12 3a9 9 0 1 0 9 9' : 'M5 5l14 14M8.5 8.5A6 6 0 0 0 17 17');
  icon.appendChild(path);
  const strong = document.createElement('strong');
  strong.textContent = title || '';
  const span = document.createElement('span');
  span.textContent = detail || '';
  empty.append(icon, strong, span);
  return empty;
}

function createGlobalSessionSearch(options) {
  const {
    document,
    window,
    ipcRenderer,
    clipboard,
    openHit = async () => {},
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = options;
  const overlay = document.getElementById('search-modal');
  const queryInput = document.getElementById('search-query');
  const closeButton = document.getElementById('search-modal-close');
  const launchButton = document.getElementById('btn-global-search');
  const resultsRoot = document.getElementById('search-results');
  const previewRoot = document.getElementById('session-search-preview');
  const summaryRoot = document.getElementById('session-search-result-summary');
  const providerRoot = document.getElementById('session-search-provider-filters');
  const scopeRoot = document.getElementById('session-search-scope-tabs');
  const timeSelect = document.getElementById('session-search-time');
  const projectSelect = document.getElementById('session-search-project');
  const sortSelect = document.getElementById('session-search-sort');
  const statusButton = document.getElementById('session-search-index-status');
  const statusText = document.getElementById('session-search-status-text');
  const liveRegion = document.getElementById('session-search-live');

  let activeProvider = 'all';
  let activeScope = 'all';
  let results = [];
  let activeIndex = -1;
  let activePreview = null;
  let searchTimer = null;
  let statusTimer = null;
  let searchSequence = 0;
  let previewSequence = 0;
  let lastResponse = null;
  let statusWasRefreshing = false;
  let returnFocusElement = null;

  const isOpen = () => overlay && overlay.style.display === 'flex';

  function announce(text) {
    if (liveRegion) liveRegion.textContent = String(text || '');
  }

  function statusDescription(status) {
    const stats = status && status.index || {};
    if (status && status.lastError && !status.ready) return status.lastError;
    if (status && status.refreshing) {
      const done = Number(status.indexedSources) || 0;
      const total = Number(status.totalSources) || 0;
      return total ? `正在建立本地索引 · ${done}/${total}` : '正在发现本地会话…';
    }
    if (status && status.ready) {
      const suffix = status.phase === 'ready_with_errors' && status.staleSources
        ? ` · ${status.staleSources} 个来源仅保留旧索引或标题`
        : '';
      return `本地索引已更新 · ${Number(stats.sessions) || 0} 个 session · ${Number(stats.documents) || 0} 条记录${suffix}`;
    }
    return '正在读取本地索引…';
  }

  function renderStatus(status) {
    if (!statusButton || !statusText) return;
    statusButton.classList.remove('ready', 'busy', 'error');
    if (status && status.ready && !status.refreshing) statusButton.classList.add('ready');
    else if (status && status.lastError && !status.ready) statusButton.classList.add('error');
    else statusButton.classList.add('busy');
    statusText.textContent = statusDescription(status);
    statusButton.title = status && status.lastError
      ? `${status.lastError}\n点击重新建立本地索引`
      : '点击重新建立本地索引';
  }

  async function refreshStatus({ repeat = true } = {}) {
    try {
      const status = await ipcRenderer.invoke('get-session-search-status');
      renderStatus(status);
      const refreshJustCompleted = statusWasRefreshing && status && status.ready && !status.refreshing;
      statusWasRefreshing = !!(status && status.refreshing);
      if (refreshJustCompleted && isOpen() && queryInput.value.trim().length >= 2) {
        void performSearch({ immediate: true });
      }
      const shouldPoll = status && (status.refreshing || (!status.ready && !status.lastError));
      if (repeat && isOpen() && shouldPoll) {
        if (statusTimer) clearTimeoutFn(statusTimer);
        statusTimer = setTimeoutFn(() => refreshStatus({ repeat: true }), 450);
      }
      return status;
    } catch (error) {
      renderStatus({ ready: false, lastError: error.message });
      return null;
    }
  }

  function renderInitialState() {
    results = [];
    activeIndex = -1;
    activePreview = null;
    summaryRoot.firstElementChild.textContent = '输入至少 2 个字符开始搜索';
    summaryRoot.lastElementChild.textContent = '';
    resultsRoot.replaceChildren(createStaticEmpty(document, {
      title: '找回以前解决过的问题',
      detail: '支持 Claude、Codex、DeepSeek 和 AI 群聊；所有内容仅在本机索引。',
    }));
    previewRoot.innerHTML = `
      <div class="session-search-preview-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H6.5A2.5 2.5 0 0 0 4 21.5Z"/><path d="M4 5.5v16M8 7h8M8 11h6"/></svg>
        <strong>选择左侧结果查看完整上下文</strong>
        <span>预览不会启动 CLI，也不会修改原会话。</span>
      </div>`;
  }

  function searchRequest() {
    return {
      query: queryInput.value.trim(),
      providers: activeProvider === 'all' ? [] : [activeProvider],
      scopes: activeScope === 'all' ? [] : [activeScope],
      timeRange: timeSelect.value || 'all',
      project: projectSelect.value || '',
      sort: sortSelect.value || 'relevance',
      limit: 50,
    };
  }

  function setProvider(provider) {
    activeProvider = provider || 'all';
    for (const button of providerRoot.querySelectorAll('[data-provider]')) {
      const active = button.dataset.provider === activeProvider;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }
  }

  function setScope(scope) {
    activeScope = scope || 'all';
    for (const button of scopeRoot.querySelectorAll('[data-scope]')) {
      const active = button.dataset.scope === activeScope;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    }
  }

  function updateFacets(response) {
    const providerCounts = response && response.facets && response.facets.providers || {};
    const allCount = Object.values(providerCounts).reduce((sum, value) => sum + (Number(value) || 0), 0);
    for (const button of providerRoot.querySelectorAll('[data-provider]')) {
      const provider = button.dataset.provider;
      const count = provider === 'all' ? allCount : (Number(providerCounts[provider]) || 0);
      const countNode = button.querySelector('b');
      if (countNode) countNode.textContent = String(count);
      if (provider === 'deepseek') button.hidden = count === 0 && activeProvider !== 'deepseek';
    }

    const selectedProject = projectSelect.value;
    const projects = response && response.facets && Array.isArray(response.facets.projects)
      ? response.facets.projects
      : [];
    const createOption = (label, value) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      return option;
    };
    const options = [createOption('全部', '')];
    let selectedStillPresent = !selectedProject;
    for (const project of projects) {
      if (!project || !project.label) continue;
      const option = createOption(`${project.label} (${project.count})`, project.label);
      if (project.label === selectedProject) selectedStillPresent = true;
      options.push(option);
    }
    if (selectedProject && !selectedStillPresent) options.push(createOption(selectedProject, selectedProject));
    projectSelect.replaceChildren(...options);
    projectSelect.value = selectedProject;
  }

  function resultScopeLabel(scope) {
    return SCOPE_LABELS[scope] || scope || '内容';
  }

  function createResultRow(hit, index) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'session-search-result';
    button.dataset.resultIndex = String(index);
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(index === activeIndex));
    const line = document.createElement('div');
    line.className = 'session-search-result-line';
    const provider = document.createElement('span');
    const meta = providerMeta(hit.provider);
    provider.className = `session-search-result-provider ${meta.className}`;
    const dot = document.createElement('span');
    dot.className = 'provider-dot';
    provider.append(dot, document.createTextNode(meta.label));
    const time = document.createElement('time');
    time.className = 'session-search-result-time';
    time.textContent = formatSearchTime(hit.bestMatch && hit.bestMatch.timestamp || hit.updatedAt);
    line.append(provider, time);

    const title = document.createElement('div');
    title.className = 'session-search-result-title';
    title.textContent = hit.title || '未命名会话';
    const snippet = document.createElement('div');
    snippet.className = 'session-search-result-snippet';
    appendHighlightedText(document, snippet, hit.bestMatch && hit.bestMatch.text || '', queryInput.value);
    const metaRow = document.createElement('div');
    metaRow.className = 'session-search-result-meta';
    for (const text of [
      resultScopeLabel(hit.bestMatch && hit.bestMatch.scope),
      hit.projectLabel || null,
      `${Number(hit.matchCount) || 1} 处命中`,
      hit.turnCount ? `${hit.turnCount} 条记录` : null,
    ].filter(Boolean)) {
      const chip = document.createElement('span');
      chip.className = 'session-search-meta-chip';
      chip.textContent = text;
      chip.title = text;
      metaRow.appendChild(chip);
    }
    button.append(line, title, snippet, metaRow);
    button.addEventListener('click', () => selectResult(index, { focusRow: false }));
    button.addEventListener('dblclick', () => openSelectedHit({ focus: true }));
    button.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        const next = (index + direction + results.length) % results.length;
        void selectResult(next, { focusRow: true });
      } else if (event.key === 'Enter') {
        event.preventDefault();
        if (event.ctrlKey || event.metaKey) void openSelectedHit({ focus: true });
        else void selectResult(index, { focusRow: false });
      }
    });
    return button;
  }

  function renderResults(response) {
    lastResponse = response;
    results = Array.isArray(response && response.results) ? response.results : [];
    activeIndex = -1;
    activePreview = null;
    updateFacets(response);
    const totalSessions = Number(response && response.totalSessions) || 0;
    const totalMatches = Number(response && response.totalMatches) || 0;
    summaryRoot.firstElementChild.textContent = totalSessions
      ? `找到 ${totalSessions} 个 session · ${totalMatches} 处命中`
      : '没有匹配的会话';
    summaryRoot.lastElementChild.textContent = response && Number.isFinite(response.queryMs)
      ? `${response.queryMs}ms · ${sortSelect.value === 'recent' ? '最近更新' : '相关度'} ↓`
      : '';
    if (!results.length) {
      resultsRoot.replaceChildren(createStaticEmpty(document, {
        title: '没有找到匹配内容',
        detail: '可减少关键词，切换“全部内容”，或放宽来源、时间和项目范围。',
      }));
      previewRoot.replaceChildren(createStaticEmpty(document, {
        title: '换个条件再试试',
        detail: '搜索不会修改任何历史记录。',
      }));
      announce('没有找到匹配的会话');
      return;
    }
    const fragment = document.createDocumentFragment();
    results.forEach((hit, index) => fragment.appendChild(createResultRow(hit, index)));
    resultsRoot.replaceChildren(fragment);
    announce(`找到 ${totalSessions} 个会话，${totalMatches} 处命中`);
    selectResult(0, { focusRow: false });
  }

  function renderSearchError(error) {
    summaryRoot.firstElementChild.textContent = '搜索失败';
    summaryRoot.lastElementChild.textContent = '';
    resultsRoot.replaceChildren(createStaticEmpty(document, {
      title: '本地索引暂时不可用',
      detail: error && error.message ? error.message : String(error || '未知错误'),
      className: 'error',
    }));
    announce('搜索失败');
  }

  async function performSearch({ immediate = false } = {}) {
    if (searchTimer) { clearTimeoutFn(searchTimer); searchTimer = null; }
    const request = searchRequest();
    if (request.query.normalize('NFKC').trim().length < 2) {
      renderInitialState();
      return;
    }
    if (!immediate) {
      searchTimer = setTimeoutFn(() => performSearch({ immediate: true }), 160);
      return;
    }
    const seq = ++searchSequence;
    summaryRoot.firstElementChild.textContent = '正在搜索本地索引…';
    summaryRoot.lastElementChild.textContent = '';
    if (!results.length) {
      resultsRoot.replaceChildren(createStaticEmpty(document, {
        title: '正在搜索', detail: '第一次使用时会先在后台建立本地索引。', busy: true,
      }));
    }
    try {
      const response = await ipcRenderer.invoke('search-past-sessions', request);
      if (seq !== searchSequence || !isOpen()) return;
      if (response && response.error) throw new Error(response.error);
      renderResults(response || {});
      if (response && response.status) renderStatus(response.status);
      if (response && response.refreshing) void refreshStatus({ repeat: true });
    } catch (error) {
      if (seq !== searchSequence || !isOpen()) return;
      renderSearchError(error);
    }
  }

  function previewLabel(item) {
    if (item.role === 'user') return '我的提问';
    if (item.role === 'assistant') return item.speaker || 'AI 回答';
    if (item.role === 'tool') return '工具 / 文件';
    return resultScopeLabel(item.scope);
  }

  function renderPreview(hit, preview) {
    if (!preview || !preview.session) {
      previewRoot.replaceChildren(createStaticEmpty(document, {
        title: '无法读取这条上下文', detail: '原始记录可能正在写入或已被移动。', className: 'error',
      }));
      return;
    }
    activePreview = preview;
    const header = document.createElement('header');
    header.className = 'session-search-preview-header';
    const heading = document.createElement('div');
    heading.className = 'session-search-preview-heading';
    const title = document.createElement('h3');
    title.textContent = preview.session.title || hit.title || '未命名会话';
    const meta = document.createElement('p');
    const provider = providerMeta(preview.session.provider || hit.provider).label;
    meta.textContent = [provider, preview.session.projectLabel || preview.session.cwd, formatAbsolute(hit.updatedAt)].filter(Boolean).join(' · ');
    heading.append(title, meta);
    const actions = document.createElement('div');
    actions.className = 'session-search-preview-actions';
    const copy = document.createElement('button');
    copy.type = 'button'; copy.className = 'session-search-action'; copy.textContent = '复制引用';
    const locate = document.createElement('button');
    locate.type = 'button'; locate.className = 'session-search-action primary'; locate.textContent = '定位到命中';
    const open = document.createElement('button');
    open.type = 'button'; open.className = 'session-search-action'; open.textContent = hit.provider === 'meeting' ? '打开群聊' : '打开会话';
    copy.addEventListener('click', () => copyReference(hit, preview, copy));
    locate.addEventListener('click', () => openSelectedHit({ focus: true }));
    open.addEventListener('click', () => openSelectedHit({ focus: false }));
    actions.append(copy, locate, open);
    header.append(heading, actions);

    const context = document.createElement('div');
    context.className = 'session-search-preview-context';
    for (const item of (Array.isArray(preview.context) ? preview.context : [])) {
      const turn = document.createElement('article');
      turn.className = `session-search-preview-turn ${item.role === 'user' ? 'user' : ''} ${item.isMatch ? 'match' : ''}`.trim();
      if (item.isMatch) turn.dataset.searchMatch = '1';
      const turnMeta = document.createElement('div');
      turnMeta.className = 'session-search-preview-meta';
      const label = document.createElement('span');
      label.textContent = `${previewLabel(item)}${item.isMatch ? ' · 精确命中' : ' · 上下文'}`;
      const time = document.createElement('time');
      time.textContent = formatAbsolute(item.timestamp);
      turnMeta.append(label, time);
      const text = document.createElement('div');
      text.className = 'session-search-preview-text';
      appendHighlightedText(document, text, item.text || '', queryInput.value);
      turn.append(turnMeta, text);
      if (item.truncated) {
        const note = document.createElement('div');
        note.className = 'session-search-preview-truncated';
        note.textContent = '此处仅显示命中附近内容；打开原会话可查看完整回答。';
        turn.appendChild(note);
      }
      context.appendChild(turn);
    }
    previewRoot.replaceChildren(header, context);
    const match = context.querySelector('[data-search-match="1"]');
    if (match) match.scrollIntoView({ block: 'center' });
  }

  async function selectResult(index, { focusRow = false } = {}) {
    if (!Number.isInteger(index) || index < 0 || index >= results.length) return;
    activeIndex = index;
    activePreview = null;
    for (const row of resultsRoot.querySelectorAll('.session-search-result')) {
      const active = Number(row.dataset.resultIndex) === index;
      row.classList.toggle('active', active);
      row.setAttribute('aria-selected', String(active));
      if (active) {
        row.scrollIntoView({ block: 'nearest' });
        if (focusRow) row.focus();
      }
    }
    const hit = results[index];
    const seq = ++previewSequence;
    previewRoot.replaceChildren(createStaticEmpty(document, {
      title: '正在读取上下文', detail: '从已经建立的本地索引中提取命中前后记录。', busy: true,
    }));
    try {
      const preview = await ipcRenderer.invoke('get-session-search-preview', {
        sessionKey: hit.sessionKey,
        eventId: hit.bestMatch && hit.bestMatch.eventId,
        query: queryInput.value.trim(),
      });
      if (seq !== previewSequence || activeIndex !== index || !isOpen()) return;
      renderPreview(hit, preview);
    } catch (error) {
      if (seq !== previewSequence || !isOpen()) return;
      renderPreview(hit, null);
    }
  }

  async function copyReference(hit, preview, button) {
    const match = (preview.context || []).find(item => item.isMatch) || preview.context[0] || {};
    const text = [
      `【昨日之我 · ${providerMeta(hit.provider).label}】${hit.title || '未命名会话'}`,
      match.timestamp ? formatAbsolute(match.timestamp) : '',
      match.text || hit.bestMatch && hit.bestMatch.text || '',
    ].filter(Boolean).join('\n');
    try {
      if (clipboard && typeof clipboard.writeText === 'function') clipboard.writeText(text);
      else if (window.navigator.clipboard) await window.navigator.clipboard.writeText(text);
      const original = button.textContent;
      button.textContent = '已复制';
      setTimeoutFn(() => { if (button.isConnected) button.textContent = original; }, 900);
    } catch (error) {
      announce(`复制失败：${error.message}`);
    }
  }

  async function openSelectedHit({ focus }) {
    const hit = results[activeIndex];
    if (!hit) return;
    const preview = activePreview;
    close({ restoreFocus: false });
    try {
      await openHit(hit, { focus: !!focus, preview });
    } catch (error) {
      console.warn('[session-search] open hit failed:', error);
      if (window && typeof window.alert === 'function') window.alert(`打开历史会话失败：${error && error.message ? error.message : String(error)}`);
    }
  }

  function scheduleSearch() {
    // A previous IPC response may already be in flight when the user changes
    // provider/scope/query. Invalidate it immediately, not 160 ms later when
    // the debounced replacement request starts, or stale Codex results can
    // briefly render under an already-active “群聊” filter.
    searchSequence += 1;
    previewSequence += 1;
    results = [];
    activeIndex = -1;
    activePreview = null;
    lastResponse = null;
    const nextQuery = queryInput.value.normalize('NFKC').trim();
    if (nextQuery.length >= 2) {
      summaryRoot.firstElementChild.textContent = '正在更新搜索条件…';
      summaryRoot.lastElementChild.textContent = '';
      resultsRoot.replaceChildren(createStaticEmpty(document, {
        title: '正在搜索', detail: '按最新的来源、范围和关键词重新排序。', busy: true,
      }));
      previewRoot.replaceChildren(createStaticEmpty(document, {
        title: '等待新的匹配结果', detail: '旧结果已清除，避免显示在错误的筛选条件下。', busy: true,
      }));
    }
    void performSearch({ immediate: false });
  }

  async function forceRefresh() {
    statusButton.disabled = true;
    renderStatus({ ready: false, refreshing: true, indexedSources: 0, totalSources: 0 });
    try {
      const status = await ipcRenderer.invoke('refresh-session-search', { force: true });
      renderStatus(status);
      if (queryInput.value.trim().length >= 2) await performSearch({ immediate: true });
    } catch (error) {
      renderStatus({ ready: false, refreshing: false, lastError: error.message });
      announce(`索引刷新失败：${error.message}`);
    } finally {
      statusButton.disabled = false;
    }
  }

  function open() {
    if (!overlay) return;
    returnFocusElement = document.activeElement && typeof document.activeElement.focus === 'function'
      ? document.activeElement
      : launchButton;
    overlay.style.display = 'flex';
    void refreshStatus({ repeat: true });
    if (queryInput.value.trim().length >= 2) void performSearch({ immediate: true });
    else renderInitialState();
    window.requestAnimationFrame(() => {
      queryInput.focus();
      queryInput.select();
    });
  }

  function close({ restoreFocus = true } = {}) {
    if (!overlay) return;
    overlay.style.display = 'none';
    searchSequence += 1;
    previewSequence += 1;
    if (searchTimer) { clearTimeoutFn(searchTimer); searchTimer = null; }
    if (statusTimer) { clearTimeoutFn(statusTimer); statusTimer = null; }
    if (restoreFocus && returnFocusElement && returnFocusElement.isConnected) {
      const focusTarget = returnFocusElement;
      window.requestAnimationFrame(() => focusTarget.focus());
    }
    returnFocusElement = null;
  }

  queryInput.addEventListener('input', scheduleSearch);
  queryInput.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!results.length) return;
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      const next = activeIndex < 0 ? 0 : (activeIndex + direction + results.length) % results.length;
      void selectResult(next, { focusRow: false });
      return;
    }
    if (event.key === 'Enter' && results.length) {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) void openSelectedHit({ focus: true });
      else void selectResult(activeIndex < 0 ? 0 : activeIndex, { focusRow: true });
    }
  });
  providerRoot.addEventListener('click', (event) => {
    const button = event.target.closest('[data-provider]');
    if (!button) return;
    setProvider(button.dataset.provider);
    scheduleSearch();
  });
  scopeRoot.addEventListener('click', (event) => {
    const button = event.target.closest('[data-scope]');
    if (!button) return;
    setScope(button.dataset.scope);
    scheduleSearch();
  });
  for (const select of [timeSelect, projectSelect, sortSelect]) select.addEventListener('change', scheduleSearch);
  closeButton.addEventListener('click', close);
  if (launchButton) launchButton.addEventListener('click', open);
  statusButton.addEventListener('click', () => void forceRefresh());
  overlay.addEventListener('mousedown', event => { if (event.target === overlay) close(); });
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && String(event.key).toLowerCase() === 'f') {
      if (isBlockingModalOpen(document, { exceptIds: ['search-modal'] })) return;
      event.preventDefault();
      event.stopImmediatePropagation?.();
      open();
      return;
    }
    if (event.key === 'Escape' && isOpen()) {
      event.preventDefault();
      event.stopImmediatePropagation?.();
      close();
      return;
    }
    if (event.key === 'Tab' && isOpen()) {
      const focusable = [...overlay.querySelectorAll(
        'button:not([disabled]):not([hidden]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter(element => element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });

  if (process && process.env && process.env.CLAUDE_HUB_E2E === '1') {
    window.__hubE2E = window.__hubE2E || {};
    window.__hubE2E.globalSessionSearch = {
      open,
      close,
      search: () => performSearch({ immediate: true }),
      state: () => ({
        open: isOpen(),
        query: queryInput.value,
        activeProvider,
        activeScope,
        resultCount: results.length,
        activeIndex,
        totalSessions: lastResponse && lastResponse.totalSessions || 0,
        totalMatches: lastResponse && lastResponse.totalMatches || 0,
        previewTitle: previewRoot.querySelector('h3')?.textContent || '',
      }),
    };
  }

  return { open, close, performSearch, selectResult, isOpen };
}

module.exports = {
  PROVIDER_META,
  SCOPE_LABELS,
  appendHighlightedText,
  createGlobalSessionSearch,
  formatSearchTime,
  normalizeTerms,
};
