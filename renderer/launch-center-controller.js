'use strict';

const LAUNCH_INTENTS = Object.freeze(['session', 'group', 'resume']);
const LAST_LAUNCH_KEY = 'hub.launch.last';
const CLI_LABELS = Object.freeze({ claude: 'Claude', codex: 'Codex', gemini: 'Gemini', deepseek: 'DeepSeek', kimi: 'Kimi', powershell: 'PowerShell' });
const TUNING_FIELDS = ['model', 'effort', 'mcpProfile', 'fastMode', 'codexSpeedTier'];

function normalizeLastLaunch(value) {
  if (!value || !Object.hasOwn(CLI_LABELS, value.kind) || !Number.isFinite(value.ts)) return null;
  const workspace = value.workspace;
  if (!workspace || typeof workspace.path !== 'string' || !require('path').isAbsolute(workspace.path)) return null;
  const record = {
    kind: value.kind, workspace: { path: workspace.path, label: typeof workspace.label === 'string' ? workspace.label : require('path').basename(workspace.path), draft: workspace.draft === true }, ts: value.ts,
  };
  for (const key of TUNING_FIELDS) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== (key === 'fastMode' ? 'boolean' : 'string')) return null;
    record[key] = value[key];
  }
  return record;
}
const INTENT_COPY = Object.freeze({
  session: '选择 AI、模型与工作目录',
  group: '直接配置模板、成员与工作目录',
  resume: '按提供方恢复原生历史会话',
});

function normalizeLaunchIntent(value) {
  return LAUNCH_INTENTS.includes(value) ? value : 'session';
}

function createLaunchCenterController({
  document,
  openSessionModal,
  closeSessionModal,
  prepareGroupPanel,
  closeGroupPanel,
  resumeSession,
  storage,
  getWorkspaceController = () => document.defaultView.WorkspaceController,
  isDirectory = async path => (await require('fs').promises.stat(path)).isDirectory(),
}) {
  if (!document) throw new Error('launch center requires document');
  const menuEl = document.getElementById('new-session-menu');
  const triggerEl = document.getElementById('btn-new');
  const moreEl = document.getElementById('btn-new-more');
  const statusEl = document.getElementById('launch-split-status');
  const subtitleEl = document.getElementById('launch-center-subtitle');
  const errorEl = document.getElementById('launch-center-error');
  const groupErrorEl = document.getElementById('launch-center-group-error');
  const resumeCancelButton = document.getElementById('launch-center-resume-cancel');
  const intentButtons = [...document.querySelectorAll('[data-launch-intent]')];
  const panels = [...document.querySelectorAll('[data-launch-panel]')];
  const resumeButtons = [...document.querySelectorAll('[data-resume-kind]')];
  let activeIntent = 'session';
  let groupPrepared = false;
  let returnFocus = null;
  let launching = false;
  let openRevision = 0;

  function showLaunchStatus(message = '') {
    if (statusEl) {
      statusEl.textContent = message;
      statusEl.hidden = !message;
    }
    const formError = document.getElementById('new-session-error');
    if (message && formError && activeIntent === 'session' && menuEl.style.display !== 'none') {
      formError.textContent = message;
      formError.hidden = false;
      formError.scrollIntoView({ block: 'nearest' });
    }
  }

  function readLastLaunch() {
    try {
      const raw = (storage || document.defaultView.localStorage)?.getItem(LAST_LAUNCH_KEY);
      if (!raw) return null;
      try { return normalizeLastLaunch(JSON.parse(raw)); }
      catch { return null; } // A malformed record is equivalent to no usable history.
    } catch (error) {
      showLaunchStatus(`启动记忆不可用：${error.message || error}`);
      return null;
    }
  }

  function refreshLastLaunch() {
    const last = readLastLaunch();
    const label = triggerEl && triggerEl.querySelector('.btn-label');
    if (label) label.textContent = '启动';
    if (triggerEl) {
      triggerEl.title = '打开启动中心 (Ctrl+N)';
      triggerEl.setAttribute('aria-haspopup', 'dialog');
      triggerEl.setAttribute('aria-expanded', menuEl && menuEl.style.display !== 'none' ? 'true' : 'false');
    }
    return last;
  }

  function rememberLaunch(launch) {
    const last = normalizeLastLaunch({ ...launch, ts: Date.now() });
    if (!last) {
      showLaunchStatus('会话已创建，记忆未保存：启动配置不完整');
      return;
    }
    try {
      const target = storage || document.defaultView.localStorage;
      if (!target) throw new Error('本地存储不可用');
      target.setItem(LAST_LAUNCH_KEY, JSON.stringify(last));
      showLaunchStatus();
      refreshLastLaunch();
    } catch (error) {
      showLaunchStatus(`会话已创建，记忆未保存：${error.message || error}`);
    }
  }

  async function fallbackToCenter(last, message) {
    open('session', last ? { kind: last.kind, workspace: { ...last.workspace } } : {});
    showLaunchStatus(message);
    if (!last) return;
    const revision = openRevision;
    try {
      await getWorkspaceController().loadModelCatalog(last.kind);
      if (revision !== openRevision || activeIntent !== 'session' || menuEl.style.display === 'none') return;
      const selected = menuEl.querySelector?.('.new-session-option.selected');
      if (selected && selected.dataset.kind !== last.kind) return;
      // Restore via the existing controls so private form state follows the UI.
      for (const [field, id] of [['model', 'new-session-model'], ['effort', 'new-session-effort'], ['mcpProfile', 'new-session-mcp'], ['fastMode', 'new-session-fast'], ['codexSpeedTier', 'new-session-codex-tier']]) {
        const input = document.getElementById(id);
        if (!input || last[field] === undefined) continue;
        if (field === 'fastMode') input.checked = last[field];
        else {
          if (![...input.options].some(option => option.value === last[field])) continue;
          input.value = last[field];
        }
        input.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
      }
    } catch (error) {
      if (revision === openRevision) showLaunchStatus(`${message}；配置预填失败：${error.message || error}`);
    }
  }

  async function launchLast() {
    if (launching) return null;
    showLaunchStatus();
    const last = refreshLastLaunch();
    if (!last) { open('session'); return null; }
    launching = true;
    if (triggerEl) { triggerEl.disabled = true; triggerEl.setAttribute('aria-busy', 'true'); }
    try {
      let directoryOk;
      try { directoryOk = await isDirectory(last.workspace.path); }
      catch (error) { throw new Error(`工作区无法访问（${error.code === 'ENOENT' ? '目录已不存在' : '请检查目录及访问权限'}）：${last.workspace.path}`); }
      if (!directoryOk) throw new Error(`工作区不存在或不是目录：${last.workspace.path}`);
      const workspace = getWorkspaceController();
      const catalog = await workspace.loadModelCatalog(last.kind);
      if (['codex', 'claude'].includes(last.kind) && !catalog) throw new Error('模型配置目录不可用，请在启动中心确认');
      if (catalog && (catalog.refreshError || catalog.ok === false)) throw new Error(`模型配置目录读取失败：${catalog.refreshError || '目录不可用'}`);
      const tuning = workspace.resolveSessionTuning(last.kind, last.model, last);
      const required = [
        ['model', tuning.modelOptions.length > 0], ['effort', tuning.showEffort], ['mcpProfile', tuning.showMcp],
        ['fastMode', tuning.showFast], ['codexSpeedTier', tuning.showCodexTier],
      ];
      for (const [field, applies] of required) {
        if (applies && (last[field] === undefined || tuning[field] !== last[field])) {
          throw new Error(`上次配置已不可用或不完整（${field}: ${last[field] ?? '未记录'}），请在启动中心确认`);
        }
      }
      const opts = workspace.buildSessionTuningOpts(last.kind, last.model, last);
      const session = await workspace.createSession(last.kind, { workspace: { ...last.workspace }, opts });
      if (!session || !session.id) throw new Error('创建未返回有效会话');
      rememberLaunch(last);
      return session;
    } catch (error) {
      await fallbackToCenter(last, `无法直接启动：${error.message || error}`);
      return null;
    } finally {
      launching = false;
      if (triggerEl) { triggerEl.disabled = false; triggerEl.removeAttribute('aria-busy'); }
    }
  }

  function setOpenState(open) {
    if (moreEl) moreEl.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (triggerEl && triggerEl.getAttribute('aria-haspopup')) triggerEl.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (!open && returnFocus && returnFocus.isConnected && typeof returnFocus.focus === 'function') {
      returnFocus.focus({ preventScroll: true });
      returnFocus = null;
    }
  }

  function clearErrors() {
    for (const element of [errorEl, groupErrorEl]) {
      if (!element) continue;
      element.textContent = '';
      element.hidden = true;
    }
  }

  function setError(message = '', intent = activeIntent) {
    const target = intent === 'group' ? groupErrorEl : errorEl;
    if (!target) return;
    target.textContent = message;
    target.hidden = !message;
  }

  function selectIntent(value, { focus = true } = {}) {
    openRevision += 1;
    activeIntent = normalizeLaunchIntent(value);
    clearErrors();
    for (const button of intentButtons) {
      const selected = button.dataset.launchIntent === activeIntent;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-selected', selected ? 'true' : 'false');
      button.tabIndex = selected ? 0 : -1;
    }
    for (const panel of panels) {
      panel.hidden = panel.dataset.launchPanel !== activeIntent;
    }
    if (subtitleEl) subtitleEl.textContent = INTENT_COPY[activeIntent];
    if (activeIntent === 'group' && !groupPrepared && typeof prepareGroupPanel === 'function') {
      try {
        prepareGroupPanel();
        groupPrepared = true;
      } catch (error) {
        setError(`群聊配置加载失败：${error && error.message ? error.message : String(error)}`, 'group');
      }
    }
    if (focus) {
      const selectedButton = intentButtons.find(button => button.dataset.launchIntent === activeIntent);
      if (selectedButton) selectedButton.focus({ preventScroll: true });
    }
    return activeIntent;
  }

  function open(intent = 'session', options = {}) {
    const wasClosed = !menuEl || menuEl.style.display === 'none';
    if (wasClosed) {
      const active = document.activeElement;
      const activeInside = menuEl && active && typeof menuEl.contains === 'function' && menuEl.contains(active);
      returnFocus = activeInside ? triggerEl : active;
      if (groupPrepared && typeof closeGroupPanel === 'function') closeGroupPanel();
      groupPrepared = false;
    }
    if (typeof openSessionModal === 'function') openSessionModal(options);
    setOpenState(true);
    selectIntent(intent, { focus: intent !== 'session' });
  }

  function close() {
    openRevision += 1;
    clearErrors();
    if (groupPrepared && typeof closeGroupPanel === 'function') closeGroupPanel();
    groupPrepared = false;
    if (typeof closeSessionModal === 'function') closeSessionModal();
    else if (menuEl) menuEl.style.display = 'none';
    setOpenState(false);
  }

  function toggle() {
    if (menuEl && menuEl.style.display !== 'none') close();
    else open('session');
  }

  for (const button of intentButtons) {
    button.addEventListener('click', () => selectIntent(button.dataset.launchIntent));
    button.addEventListener('keydown', event => {
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const current = intentButtons.indexOf(button);
      let next = current;
      if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = intentButtons.length - 1;
      else next = (current + (event.key === 'ArrowDown' ? 1 : -1) + intentButtons.length) % intentButtons.length;
      selectIntent(intentButtons[next].dataset.launchIntent);
    });
  }

  if (resumeCancelButton) resumeCancelButton.addEventListener('click', close);

  for (const button of resumeButtons) {
    button.addEventListener('click', async () => {
      const kind = button.dataset.resumeKind;
      if (!kind || typeof resumeSession !== 'function') return;
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      clearErrors();
      try {
        close();
        await resumeSession(kind);
      } catch (error) {
        open('resume');
        setError(`恢复失败：${error && error.message ? error.message : String(error)}`);
      } finally {
        button.disabled = false;
        button.removeAttribute('aria-busy');
      }
    });
  }

  const view = document.defaultView;
  if (view && typeof view.addEventListener === 'function') {
    view.addEventListener('focus', refreshLastLaunch);
    view.addEventListener('storage', refreshLastLaunch);
    view.addEventListener('launch-center:session-created', event => {
      if (event.detail && event.detail.sessionId && event.detail.launch) rememberLaunch(event.detail.launch);
    });
    view.addEventListener('launch-center:session-opened', () => {
      setOpenState(true);
      selectIntent('session', { focus: false });
    });
    view.addEventListener('launch-center:closed', () => {
      openRevision += 1;
      if (groupPrepared && typeof closeGroupPanel === 'function') closeGroupPanel();
      groupPrepared = false;
      clearErrors();
      setOpenState(false);
    });
  }

  if (menuEl) {
    // A user edit cancels any delayed fallback prefill still awaiting its catalog.
    menuEl.addEventListener('pointerdown', () => { openRevision += 1; });
    menuEl.addEventListener('input', () => { openRevision += 1; });
    menuEl.addEventListener('keydown', event => {
      openRevision += 1;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...menuEl.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])')]
        .filter(node => !node.hidden && node.getClientRects().length > 0);
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
    });
  }

  selectIntent('session', { focus: false });
  refreshLastLaunch();
  return {
    close,
    getActiveIntent: () => activeIntent,
    open,
    selectIntent,
    toggle,
    launchLast,
    refreshLastLaunch,
  };
}

module.exports = {
  INTENT_COPY,
  LAUNCH_INTENTS,
  createLaunchCenterController,
  normalizeLaunchIntent,
  normalizeLastLaunch,
};
