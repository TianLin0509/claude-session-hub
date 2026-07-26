'use strict';

(function () {
  const { ipcRenderer } = require('electron');

  const KIND_LABELS = {
    claude: 'Claude Code',
    gemini: 'Gemini CLI',
    codex: 'Codex CLI',
    deepseek: 'DeepSeek',
    kimi: 'Kimi Code · K3',
    powershell: 'PowerShell',
  };

  let menuEl = null;
  let selectedKind = 'claude';
  let workspaceMode = 'scratch';
  let existingWorkspace = null;
  let submitting = false;

  function compactPath(value, max = 58) {
    const text = String(value || '');
    if (text.length <= max) return text;
    return `${text.slice(0, 3)}…${text.slice(-(max - 4))}`;
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
      },
    });
  }

  function setError(message = '') {
    const errorEl = document.getElementById('new-session-error');
    if (!errorEl) return;
    errorEl.textContent = message;
    errorEl.hidden = !message;
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

    const existingRow = document.getElementById('new-session-existing-path');
    const pathValue = document.getElementById('new-session-path-value');
    if (existingRow) existingRow.hidden = workspaceMode !== 'existing';
    if (pathValue) {
      pathValue.textContent = existingWorkspace ? compactPath(existingWorkspace.path) : '尚未选择';
      pathValue.title = existingWorkspace ? existingWorkspace.path : '';
    }
    const summary = document.getElementById('new-session-summary');
    if (summary) {
      summary.textContent = workspaceMode === 'scratch'
        ? `${KIND_LABELS[selectedKind] || selectedKind} · 新建临时 workspace`
        : `${KIND_LABELS[selectedKind] || selectedKind} · ${existingWorkspace ? compactPath(existingWorkspace.path, 40) : '请选择目录'}`;
    }
    const submit = document.getElementById('new-session-submit');
    if (submit) submit.disabled = submitting || (workspaceMode === 'existing' && !existingWorkspace);
  }

  async function chooseExistingPath() {
    setError('');
    try {
      const workspace = await pickWorkspace();
      if (workspace && workspace.path) {
        existingWorkspace = workspace;
        workspaceMode = 'existing';
      }
    } catch (error) {
      setError(`选择目录失败：${error && error.message ? error.message : String(error)}`);
    }
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
    setError('');
    paint();
    menuEl.style.display = 'block';
    const selected = menuEl.querySelector(`.new-session-option[data-kind="${selectedKind}"]`);
    if (selected) selected.focus();
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
      const session = await createSession(selectedKind, { workspace });
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
        if (workspaceMode === 'existing' && !existingWorkspace) void chooseExistingPath();
      });
    });
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
    pickWorkspace,
    submitNewSession,
  };

  init();
})();
