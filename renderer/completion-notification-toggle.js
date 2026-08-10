'use strict';

function normalizeToggleState(value = {}) {
  return {
    enabled: value.enabled === true || value.notificationEnabled === true,
    configured: value.configured === true || value.serverchanSendKeySet === true,
  };
}

function createCompletionNotificationToggle({
  document,
  ipcRenderer,
  openNotificationSettings = () => {},
} = {}) {
  if (!document) throw new Error('document is required');
  if (!ipcRenderer) throw new Error('ipcRenderer is required');

  const button = document.getElementById('completion-notification-toggle');
  const label = document.getElementById('completion-notification-toggle-label');
  let state = { enabled: false, configured: false };
  let busy = false;
  let initialized = false;

  function render() {
    if (!button || !label) return state;
    const visualState = !state.configured ? 'unconfigured' : (state.enabled ? 'enabled' : 'disabled');
    button.dataset.state = visualState;
    button.classList.toggle('enabled', visualState === 'enabled');
    button.classList.toggle('disabled', visualState === 'disabled');
    button.classList.toggle('unconfigured', visualState === 'unconfigured');
    button.classList.toggle('busy', busy);
    button.setAttribute('aria-pressed', String(visualState === 'enabled'));
    button.setAttribute('aria-busy', String(busy));
    label.textContent = visualState === 'enabled'
      ? '通知开'
      : (visualState === 'disabled' ? '通知关' : '通知未配');
    button.title = visualState === 'enabled'
      ? '微信完成通知已开启：每次回答完成都会推送。点击关闭'
      : (visualState === 'disabled'
        ? '微信完成通知已关闭。点击开启'
        : '未配置 Server酱 SendKey，点击进入设置');
    return state;
  }

  function applyState(next) {
    state = normalizeToggleState(next);
    return render();
  }

  async function refresh() {
    try {
      const config = await ipcRenderer.invoke('get-hub-config');
      return applyState(config || {});
    } catch {
      return render();
    }
  }

  async function toggle() {
    if (busy) return { ok: false, status: 'busy' };
    if (!state.configured) {
      await Promise.resolve(openNotificationSettings());
      return { ok: false, status: 'configuration_missing' };
    }

    busy = true;
    render();
    try {
      const result = await ipcRenderer.invoke('set-completion-notification-enabled', {
        enabled: !state.enabled,
      });
      if (result && result.ok) {
        applyState(result);
      } else if (result && result.status === 'configuration_missing') {
        applyState(result);
        await Promise.resolve(openNotificationSettings());
      }
      return result;
    } catch {
      return { ok: false, status: 'ipc_failed' };
    } finally {
      busy = false;
      render();
    }
  }

  function init() {
    if (initialized || !button) return;
    initialized = true;
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void toggle();
    });
    if (typeof ipcRenderer.on === 'function') {
      ipcRenderer.on('completion-notification-config-changed', (_event, payload) => {
        applyState(payload || {});
      });
    }
    void refresh();
  }

  return {
    applyState,
    getState: () => ({ ...state }),
    init,
    refresh,
    toggle,
  };
}

module.exports = {
  createCompletionNotificationToggle,
  normalizeToggleState,
};
