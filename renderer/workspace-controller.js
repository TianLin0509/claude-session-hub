'use strict';

(function () {
  const { ipcRenderer } = require('electron');
  const path = require('path');
  const { modelOptionsFor, DEFAULT_MODEL_BY_KIND } = require('../core/model-options.js');

  const KIND_LABELS = {
    claude: 'Claude Code',
    gemini: 'Gemini CLI',
    codex: 'Codex CLI',
    deepseek: 'DeepSeek',
    kimi: 'Kimi Code · K3',
    powershell: 'PowerShell',
  };

  // `--effort` is a Claude CLI flag only. deepseek runs through the claude CLI but
  // session-manager builds its command without the flag, so it is Claude-only here.
  const EFFORT_KINDS = new Set(['claude']);
  const DEFAULT_EFFORT = 'max';
  const RECENT_LIMIT = 8;

  let menuEl = null;
  let selectedKind = 'claude';
  let workspaceMode = 'scratch';
  let existingWorkspace = null;
  let submitting = false;
  let selectedModel = '';
  let selectedEffort = DEFAULT_EFFORT;
  let recentItems = [];
  let scratchRoot = '';
  let archiveModalEl = null;
  let archiveContext = null;
  let archiveParent = null;
  let archiveBusy = false;
  let archiveReturnFocus = null;
  const archiveQueue = [];
  const archivePendingKeys = new Set();
  const archivePromptedKeys = new Set();

  function compactPath(value, max = 58) {
    const text = String(value || '');
    if (text.length <= max) return text;
    return `${text.slice(0, 3)}…${text.slice(-(max - 4))}`;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeFolderName(value) {
    return String(value || '')
      .normalize('NFKC')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
      .replace(/[. ]+$/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 48);
  }

  function setArchiveError(message = '') {
    const error = archiveModalEl && archiveModalEl.querySelector('#workspace-archive-error');
    if (!error) return;
    error.textContent = message;
    error.hidden = !message;
  }

  function archiveTargetPath() {
    const input = archiveModalEl && archiveModalEl.querySelector('#workspace-archive-folder-name');
    const name = input ? safeFolderName(input.value) : '';
    return archiveParent && name ? path.join(archiveParent, name) : '';
  }

  function paintArchiveModal() {
    if (!archiveModalEl || !archiveContext) return;
    archiveModalEl.querySelectorAll('[data-archive-parent]').forEach(button => {
      const selected = button.dataset.archiveParent === archiveParent;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
    const custom = archiveModalEl.querySelector('#workspace-archive-custom-parent');
    if (custom) {
      const isCategory = (archiveContext.categories || []).some(item => item.path === archiveParent);
      custom.classList.toggle('selected', !!archiveParent && !isCategory);
      const value = custom.querySelector('small');
      if (value) value.textContent = archiveParent && !isCategory ? compactPath(archiveParent, 46) : '选择任意父目录，并在其中新建项目路径';
    }
    const target = archiveModalEl.querySelector('#workspace-archive-target');
    const targetPath = archiveTargetPath();
    if (target) {
      target.textContent = targetPath || '先选择正式分类或自定义位置';
      target.title = targetPath;
    }
    const submit = archiveModalEl.querySelector('#workspace-archive-submit');
    if (submit) submit.disabled = archiveBusy || !targetPath;
  }

  function ensureArchiveModal() {
    if (archiveModalEl && document.body.contains(archiveModalEl)) return archiveModalEl;
    archiveModalEl = document.createElement('div');
    archiveModalEl.id = 'workspace-archive-modal';
    archiveModalEl.className = 'workspace-archive-overlay';
    archiveModalEl.style.display = 'none';
    archiveModalEl.innerHTML = `
      <section class="workspace-archive-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-archive-title" aria-describedby="workspace-archive-description">
        <header class="workspace-archive-head">
          <div class="workspace-archive-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 7.5h6l2 2h8v9.5H4Z"/><path d="M12 4v10m-3-3 3 3 3-3"/></svg></div>
          <div><h2 id="workspace-archive-title">首轮完成，归档 Workspace</h2><p id="workspace-archive-description">选择正式位置后，Hub 会短暂重连 CLI，并从 _scratch 移走项目。</p></div>
          <button type="button" class="workspace-archive-close" aria-label="暂不归档">×</button>
        </header>
        <div class="workspace-archive-body">
          <div class="workspace-archive-source"><span>当前临时目录</span><strong id="workspace-archive-label"></strong><code id="workspace-archive-source"></code></div>
          <fieldset class="workspace-archive-fieldset"><legend>归档分类</legend><div class="workspace-archive-categories" id="workspace-archive-categories"></div></fieldset>
          <button type="button" class="workspace-archive-custom" id="workspace-archive-custom-parent"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h7l2 2h9v10H3Z"/><path d="M15 5v6m-3-3h6"/></svg><span><strong>完全新建路径</strong><small>选择任意父目录，并在其中新建项目路径</small></span></button>
          <label class="workspace-archive-name" for="workspace-archive-folder-name"><span>项目文件夹名称</span><input id="workspace-archive-folder-name" type="text" maxlength="48" autocomplete="off" spellcheck="false"></label>
          <div class="workspace-archive-preview"><span>归档后路径</span><code id="workspace-archive-target"></code></div>
          <div class="workspace-archive-error" id="workspace-archive-error" role="alert" hidden></div>
        </div>
        <footer class="workspace-archive-footer"><button type="button" class="workspace-archive-later">暂留 _scratch</button><button type="button" class="workspace-archive-submit" id="workspace-archive-submit">归档并继续</button></footer>
      </section>`;
    document.body.appendChild(archiveModalEl);

    archiveModalEl.querySelector('.workspace-archive-close').addEventListener('click', closeArchiveModal);
    archiveModalEl.querySelector('.workspace-archive-later').addEventListener('click', closeArchiveModal);
    archiveModalEl.querySelector('#workspace-archive-folder-name').addEventListener('input', () => {
      setArchiveError('');
      paintArchiveModal();
    });
    archiveModalEl.querySelector('#workspace-archive-custom-parent').addEventListener('click', async () => {
      if (archiveBusy) return;
      setArchiveError('');
      try {
        const picked = await ipcRenderer.invoke('workspace:pick-archive-parent');
        if (picked && picked.path) archiveParent = picked.path;
      } catch (error) {
        setArchiveError(`选择路径失败：${error && error.message ? error.message : String(error)}`);
      }
      paintArchiveModal();
    });
    archiveModalEl.querySelector('#workspace-archive-submit').addEventListener('click', () => void submitArchive());
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && archiveModalEl && archiveModalEl.style.display !== 'none' && !archiveBusy) closeArchiveModal();
    });
    return archiveModalEl;
  }

  function openArchiveContext(context) {
    ensureArchiveModal();
    archiveContext = context;
    archiveParent = null;
    archiveBusy = false;
    archiveReturnFocus = document.activeElement;
    setArchiveError(context.resumeReady === false
      ? `正在等待安全重连信息：${(context.resumeIssues || []).join('；')}`
      : '');
    archiveModalEl.querySelector('#workspace-archive-label').textContent = context.label || context.title || '未命名任务';
    archiveModalEl.querySelector('#workspace-archive-source').textContent = compactPath(context.source, 76);
    archiveModalEl.querySelector('#workspace-archive-source').title = context.source || '';
    const categories = archiveModalEl.querySelector('#workspace-archive-categories');
    categories.innerHTML = (context.categories || []).map(item => `<button type="button" data-archive-parent="${escapeHtml(item.path)}" aria-pressed="false"><span>${escapeHtml(item.name)}</span><small>${escapeHtml(compactPath(item.path, 34))}</small></button>`).join('');
    categories.querySelectorAll('[data-archive-parent]').forEach(button => {
      button.addEventListener('click', () => {
        archiveParent = button.dataset.archiveParent;
        setArchiveError('');
        paintArchiveModal();
      });
    });
    const input = archiveModalEl.querySelector('#workspace-archive-folder-name');
    input.value = (context.workspace && context.workspace.suggestedName) || context.title || 'new-project';
    archiveModalEl.style.display = 'flex';
    paintArchiveModal();
    const firstCategory = categories.querySelector('button');
    (firstCategory || archiveModalEl.querySelector('#workspace-archive-custom-parent')).focus();
  }

  function closeArchiveModal() {
    if (!archiveModalEl || archiveBusy) return;
    // 这里原来会把「已问过」标记删掉，于是每轮回答结束都会重新弹一次归档框——
    // 用户点了「暂留 _scratch」等于白点。关闭 = 用户已经做过决定，本次运行不再打扰；
    // 同时落盘到 workspace 注册表，Hub 重启后也不再问同一个 workspace。
    if (archiveContext) {
      archivePromptedKeys.add(`${archiveContext.scope}:${archiveContext.id}`);
      if (archiveContext.source) {
        void ipcRenderer.invoke('workspace:dismiss-archive', { path: archiveContext.source })
          .catch(error => console.warn('[workspace] dismiss archive failed:', error && error.message));
      }
    }
    archiveModalEl.style.display = 'none';
    archiveContext = null;
    archiveParent = null;
    if (archiveReturnFocus && typeof archiveReturnFocus.focus === 'function') archiveReturnFocus.focus();
    archiveReturnFocus = null;
    const next = archiveQueue.shift();
    if (next) setTimeout(() => openArchiveContext(next), 0);
  }

  async function submitArchive() {
    if (!archiveContext || archiveBusy) return;
    const target = archiveTargetPath();
    if (!target) return;
    const input = archiveModalEl.querySelector('#workspace-archive-folder-name');
    archiveBusy = true;
    setArchiveError('');
    paintArchiveModal();
    const submit = archiveModalEl.querySelector('#workspace-archive-submit');
    submit.textContent = '正在安全重连…';
    try {
      const result = await ipcRenderer.invoke('workspace:archive-and-restart', {
        scope: archiveContext.scope,
        id: archiveContext.id,
        parent: archiveParent,
        folderName: safeFolderName(input.value),
      });
      if (!result || !result.ok) throw new Error('归档未返回成功状态');
      window.dispatchEvent(new CustomEvent('workspace-archive-completed', { detail: result }));
      archiveBusy = false;
      submit.textContent = '归档并继续';
      closeArchiveModal();
    } catch (error) {
      archiveBusy = false;
      submit.textContent = '重试归档';
      setArchiveError(error && error.message ? error.message : String(error));
      paintArchiveModal();
    }
  }

  async function maybePromptArchive(scope, id) {
    const key = `${scope}:${id}`;
    if (!id || archivePromptedKeys.has(key) || archivePendingKeys.has(key)) return false;
    archivePendingKeys.add(key);
    try {
      let context = null;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        context = await ipcRenderer.invoke('workspace:archive-context', { scope, id });
        if (!context || !context.required) return false;
        if (context.workspace && context.workspace.suggestedName && context.resumeReady !== false) break;
        await new Promise(resolve => setTimeout(resolve, 400));
      }
      archivePromptedKeys.add(key);
      if (archiveContext || (archiveModalEl && archiveModalEl.style.display !== 'none')) archiveQueue.push(context);
      else openArchiveContext(context);
      return true;
    } catch (error) {
      console.warn('[workspace] archive reminder failed:', error && error.message);
      return false;
    } finally {
      archivePendingKeys.delete(key);
    }
  }

  async function createScratch(label = '未命名任务') {
    return ipcRenderer.invoke('workspace:create-scratch', { label });
  }

  async function pickWorkspace() {
    return ipcRenderer.invoke('workspace:pick');
  }

  async function createSession(kind, options = {}) {
    let workspace = options.workspace || null;
    if (!workspace && options.cwd) {
      workspace = await ipcRenderer.invoke('workspace:select', options.cwd);
    }
    if (!workspace) workspace = await createScratch(options.workspaceLabel || '未命名任务');
    return ipcRenderer.invoke('create-session', {
      kind,
      opts: {
        ...(options.opts || {}),
        cwd: workspace.path,
        workspaceLabel: workspace.label,
        workspaceDraft: !!workspace.draft,
      },
    });
  }

  function setError(message = '') {
    const errorEl = document.getElementById('new-session-error');
    if (!errorEl) return;
    errorEl.textContent = message;
    errorEl.hidden = !message;
  }

  // Recent workspaces are the primary way to pick an existing path; the OS folder
  // dialog stays available as the fallback for directories Hub has never seen.
  async function loadRecent() {
    try {
      const listing = await ipcRenderer.invoke('workspace:list');
      scratchRoot = (listing && listing.scratchRoot) || scratchRoot;
      recentItems = ((listing && listing.items) || [])
        .filter(item => item && item.path && !item.legacy)
        .slice(0, RECENT_LIMIT);
    } catch (error) {
      recentItems = [];
      console.warn('[workspace] recent list failed:', error && error.message);
    }
    renderRecent();
  }

  function renderRecent() {
    const listEl = document.getElementById('new-session-recent');
    if (!listEl) return;
    if (recentItems.length === 0) {
      listEl.innerHTML = '<div class="session-recent-empty">暂无最近工作区，用右上角「浏览文件夹…」选择。</div>';
      return;
    }
    listEl.innerHTML = recentItems.map(item => {
      const selected = !!existingWorkspace && existingWorkspace.path === item.path;
      const badge = item.draft ? '<span class="session-recent-badge">临时</span>'
        : item.pinned ? '<span class="session-recent-badge">置顶</span>' : '';
      return `<button type="button" class="session-recent-item${selected ? ' selected' : ''}" role="option"`
        + ` aria-selected="${selected ? 'true' : 'false'}" data-recent-path="${escapeHtml(item.path)}"`
        + ` title="${escapeHtml(item.path)}">`
        + `<div><strong>${escapeHtml(item.label || path.basename(item.path))}</strong>`
        + `<small>${escapeHtml(compactPath(item.path, 52))}</small></div>${badge}</button>`;
    }).join('');
    listEl.querySelectorAll('[data-recent-path]').forEach(button => {
      button.addEventListener('click', () => {
        const target = recentItems.find(item => item.path === button.dataset.recentPath);
        if (!target) return;
        existingWorkspace = target;
        workspaceMode = 'existing';
        setError('');
        renderRecent();
        paint();
      });
    });
  }

  function paintTuning() {
    const label = document.getElementById('new-session-tuning-label');
    const grid = document.getElementById('new-session-tuning');
    const modelSelect = document.getElementById('new-session-model');
    const effortField = document.getElementById('new-session-effort-field');
    const effortSelect = document.getElementById('new-session-effort');
    if (!grid || !modelSelect) return;

    const options = modelOptionsFor(selectedKind);
    const hasModels = options.length > 0;
    if (label) label.hidden = !hasModels;
    grid.hidden = !hasModels;
    if (!hasModels) return;

    if (!options.some(option => option.id === selectedModel)) {
      selectedModel = DEFAULT_MODEL_BY_KIND[selectedKind] || options[0].id;
    }
    const wanted = options.map(option => `${option.id} ${option.label}`).join('|');
    if (modelSelect.dataset.builtFor !== wanted) {
      modelSelect.innerHTML = options
        .map(option => `<option value="${escapeHtml(option.id)}">${escapeHtml(option.label)}</option>`)
        .join('');
      modelSelect.dataset.builtFor = wanted;
    }
    modelSelect.value = selectedModel;

    const showEffort = EFFORT_KINDS.has(selectedKind);
    if (effortField) effortField.hidden = !showEffort;
    if (effortSelect) effortSelect.value = selectedEffort;
    grid.style.gridTemplateColumns = showEffort ? '' : '1fr';
  }

  function paint() {
    if (!menuEl) return;
    menuEl.querySelectorAll('.new-session-option').forEach(button => {
      const selected = button.dataset.kind === selectedKind;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
    menuEl.querySelectorAll('.session-workspace-choice').forEach(button => {
      const selected = button.dataset.workspaceMode === workspaceMode;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-checked', selected ? 'true' : 'false');
    });

    paintTuning();

    const existingRow = document.getElementById('new-session-existing-path');
    const pathValue = document.getElementById('new-session-path-value');
    if (existingRow) existingRow.hidden = workspaceMode !== 'existing';
    if (pathValue) {
      pathValue.textContent = existingWorkspace ? compactPath(existingWorkspace.path) : '尚未选择';
      pathValue.title = existingWorkspace ? existingWorkspace.path : '';
    }
    const summary = document.getElementById('new-session-summary');
    if (summary) {
      // 外层 span 是 rtl（为了从左侧省略），内容必须用 bdi 包回 ltr，
      // 否则路径里的 `\` 和标点会被双向算法重排。
      summary.innerHTML = `<bdi>${escapeHtml(summaryText())}</bdi>`;
      summary.title = summaryTitle();
    }
    const submit = document.getElementById('new-session-submit');
    if (submit) submit.disabled = submitting || (workspaceMode === 'existing' && !existingWorkspace);
  }

  // The footer states where the session will actually land, so a mis-set
  // AI_HUB_WORKSPACE_ROOT is visible before the session is created.
  function targetPathPreview() {
    if (workspaceMode === 'existing') return existingWorkspace ? existingWorkspace.path : '';
    return scratchRoot ? path.join(scratchRoot, 'inbox-…') : '新建临时 workspace';
  }

  function tuningTag() {
    const options = modelOptionsFor(selectedKind);
    if (options.length === 0) return '';
    const model = options.find(option => option.id === selectedModel);
    const modelLabel = model ? model.label : selectedModel;
    return EFFORT_KINDS.has(selectedKind) ? `${modelLabel} · ${selectedEffort}` : modelLabel;
  }

  function summaryText() {
    const parts = [KIND_LABELS[selectedKind] || selectedKind];
    const tuning = tuningTag();
    if (tuning) parts.push(tuning);
    const target = targetPathPreview();
    parts.push(target ? compactPath(target, 46) : '请选择目录');
    return parts.join(' · ');
  }

  function summaryTitle() {
    const target = targetPathPreview();
    return target || '请选择目录';
  }

  async function chooseExistingPath() {
    setError('');
    try {
      const workspace = await pickWorkspace();
      if (workspace && workspace.path) {
        existingWorkspace = workspace;
        workspaceMode = 'existing';
        await loadRecent();
      }
    } catch (error) {
      setError(`选择目录失败：${error && error.message ? error.message : String(error)}`);
    }
    renderRecent();
    paint();
    return existingWorkspace;
  }

  function closeNewSessionModal() {
    if (menuEl) menuEl.style.display = 'none';
    setError('');
  }

  function openNewSessionModal(options = {}) {
    if (!menuEl) return;
    selectedKind = KIND_LABELS[options.kind] ? options.kind : 'claude';
    workspaceMode = 'scratch';
    existingWorkspace = null;
    submitting = false;
    selectedModel = DEFAULT_MODEL_BY_KIND[selectedKind] || '';
    selectedEffort = DEFAULT_EFFORT;
    setError('');
    renderRecent();
    paint();
    // 必须是 flex：.new-session-menu 用 column flex 把 head/footer 固定、中段滚动。
    // 早期这里写的是 'block'，内联样式压过 CSS 的 display:flex，
    // 于是 .session-create-body 拿不到 flex 高度，overflow-y 不生效，
    // max-height + overflow:hidden 直接把「创建会话」按钮裁掉。
    menuEl.style.display = 'flex';
    const selected = menuEl.querySelector(`.new-session-option[data-kind="${selectedKind}"]`);
    if (selected) selected.focus();
    void loadRecent().then(paint);
  }

  // Only send what the selected CLI understands: model for kinds with a model
  // list, effort for Claude. Omitting them keeps session-manager's defaults.
  function tuningOpts() {
    const opts = {};
    if (modelOptionsFor(selectedKind).length > 0 && selectedModel) opts.model = selectedModel;
    if (EFFORT_KINDS.has(selectedKind) && selectedEffort) opts.effort = selectedEffort;
    return opts;
  }

  async function submitNewSession() {
    if (submitting) return null;
    setError('');
    let workspace = existingWorkspace;
    if (workspaceMode === 'existing' && !workspace) {
      workspace = await chooseExistingPath();
      if (!workspace) return null;
    }

    submitting = true;
    paint();
    const submit = document.getElementById('new-session-submit');
    if (submit) submit.textContent = '创建中…';
    try {
      if (workspaceMode === 'scratch') workspace = await createScratch('未命名任务');
      const session = await createSession(selectedKind, { workspace, opts: tuningOpts() });
      closeNewSessionModal();
      return session;
    } catch (error) {
      setError(`创建失败：${error && error.message ? error.message : String(error)}`);
      return null;
    } finally {
      submitting = false;
      if (submit) submit.textContent = '创建会话';
      paint();
    }
  }

  function init() {
    menuEl = document.getElementById('new-session-menu');
    if (!menuEl) return;

    menuEl.querySelectorAll('.new-session-option').forEach(button => {
      button.addEventListener('click', () => {
        selectedKind = button.dataset.kind || 'claude';
        setError('');
        paint();
      });
    });
    menuEl.querySelectorAll('.session-workspace-choice').forEach(button => {
      button.addEventListener('click', () => {
        workspaceMode = button.dataset.workspaceMode === 'existing' ? 'existing' : 'scratch';
        setError('');
        paint();
        // No auto-opening the OS dialog: the recent list is shown first and
        // "浏览文件夹…" is the explicit fallback.
        if (workspaceMode === 'existing') void loadRecent().then(paint);
      });
    });
    const modelSelect = document.getElementById('new-session-model');
    if (modelSelect) {
      modelSelect.addEventListener('change', () => {
        selectedModel = modelSelect.value;
        paint();
      });
    }
    const effortSelect = document.getElementById('new-session-effort');
    if (effortSelect) {
      effortSelect.addEventListener('change', () => {
        selectedEffort = effortSelect.value;
        paint();
      });
    }
    const pick = document.getElementById('new-session-pick-path');
    if (pick) pick.addEventListener('click', () => void chooseExistingPath());
    const submit = document.getElementById('new-session-submit');
    if (submit) submit.addEventListener('click', () => void submitNewSession());
    for (const id of ['new-session-close', 'new-session-cancel']) {
      const button = document.getElementById(id);
      if (button) button.addEventListener('click', closeNewSessionModal);
    }
    paint();
  }

  window.WorkspaceController = {
    closeNewSessionModal,
    compactPath,
    createScratch,
    createSession,
    openNewSessionModal,
    maybePromptMeetingArchive: meetingId => maybePromptArchive('meeting', meetingId),
    maybePromptSessionArchive: sessionId => maybePromptArchive('session', sessionId),
    pickWorkspace,
    submitNewSession,
  };

  init();
})();
