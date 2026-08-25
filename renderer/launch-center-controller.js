'use strict';

const LAUNCH_INTENTS = Object.freeze(['session', 'group', 'resume']);
const INTENT_COPY = Object.freeze({
  session: '选择 AI、模型与工作目录',
  group: '选择协作模板，再配置群聊成员',
  resume: '按提供方恢复原生历史会话',
});

function normalizeLaunchIntent(value) {
  return LAUNCH_INTENTS.includes(value) ? value : 'session';
}

function createLaunchCenterController({
  document,
  openSessionModal,
  closeSessionModal,
  openGroupModal,
  resumeSession,
}) {
  if (!document) throw new Error('launch center requires document');
  const menuEl = document.getElementById('new-session-menu');
  const triggerEl = document.getElementById('btn-new');
  const subtitleEl = document.getElementById('launch-center-subtitle');
  const errorEl = document.getElementById('launch-center-error');
  const configureGroupButton = document.getElementById('launch-center-configure-group');
  const resumeCancelButton = document.getElementById('launch-center-resume-cancel');
  const intentButtons = [...document.querySelectorAll('[data-launch-intent]')];
  const panels = [...document.querySelectorAll('[data-launch-panel]')];
  const templateButtons = [...document.querySelectorAll('[data-launch-group-template]')];
  const resumeButtons = [...document.querySelectorAll('[data-resume-kind]')];
  let activeIntent = 'session';
  let selectedGroupTemplate = 'general';
  let returnFocus = null;

  function setOpenState(open) {
    if (triggerEl) triggerEl.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (!open && returnFocus && returnFocus.isConnected && typeof returnFocus.focus === 'function') {
      returnFocus.focus({ preventScroll: true });
      returnFocus = null;
    }
  }

  function setError(message = '') {
    if (!errorEl) return;
    errorEl.textContent = message;
    errorEl.hidden = !message;
  }

  function selectIntent(value, { focus = true } = {}) {
    activeIntent = normalizeLaunchIntent(value);
    setError('');
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
    if (focus) {
      const selectedButton = intentButtons.find(button => button.dataset.launchIntent === activeIntent);
      if (selectedButton) selectedButton.focus({ preventScroll: true });
    }
    return activeIntent;
  }

  function open(intent = 'session', options = {}) {
    if (!menuEl || menuEl.style.display === 'none') {
      const active = document.activeElement;
      const activeInside = menuEl && active && typeof menuEl.contains === 'function' && menuEl.contains(active);
      returnFocus = activeInside ? triggerEl : active;
    }
    if (typeof openSessionModal === 'function') openSessionModal(options);
    setOpenState(true);
    selectIntent(intent, { focus: intent !== 'session' });
  }

  function close() {
    setError('');
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

  for (const button of templateButtons) {
    button.addEventListener('click', () => {
      selectedGroupTemplate = button.dataset.launchGroupTemplate || 'general';
      for (const candidate of templateButtons) {
        const selected = candidate === button;
        candidate.classList.toggle('selected', selected);
        candidate.setAttribute('aria-pressed', selected ? 'true' : 'false');
      }
    });
  }

  if (configureGroupButton) {
    configureGroupButton.addEventListener('click', () => {
      close();
      if (typeof openGroupModal === 'function') openGroupModal({ templateId: selectedGroupTemplate });
    });
  }

  if (resumeCancelButton) resumeCancelButton.addEventListener('click', close);

  for (const button of resumeButtons) {
    button.addEventListener('click', async () => {
      const kind = button.dataset.resumeKind;
      if (!kind || typeof resumeSession !== 'function') return;
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      setError('');
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
    view.addEventListener('launch-center:session-opened', () => {
      setOpenState(true);
      selectIntent('session', { focus: false });
    });
    view.addEventListener('launch-center:closed', () => setOpenState(false));
  }

  if (menuEl) {
    menuEl.addEventListener('keydown', event => {
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
  return {
    close,
    getActiveIntent: () => activeIntent,
    getSelectedGroupTemplate: () => selectedGroupTemplate,
    open,
    selectIntent,
    toggle,
  };
}

module.exports = {
  INTENT_COPY,
  LAUNCH_INTENTS,
  createLaunchCenterController,
  normalizeLaunchIntent,
};
