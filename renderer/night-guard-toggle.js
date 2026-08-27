'use strict';

function normalizeNightGuardToggleState(value = {}) {
  const targetId = typeof value.targetId === 'string' ? value.targetId : null;
  const status = typeof value.status === 'string' ? value.status : 'off';
  return {
    available: value.available === true && !!targetId,
    targetId,
    enabled: value.enabled === true,
    mode: value.mode === 'goal' ? 'goal' : 'manual',
    status,
    message: typeof value.message === 'string' ? value.message : '',
    healthyRounds: Math.max(0, Number(value.healthyRounds) || 0),
  };
}

function visualStateOf(state) {
  if (!state.available) return 'unavailable';
  if (state.status === 'blocked') return 'blocked';
  if (state.status === 'waiting-network' || state.status === 'grace') return 'waiting';
  if (state.status === 'waiting-runtime') return 'runtime';
  if (state.status === 'resuming' || state.status === 'recovering') return 'recovering';
  if (state.status === 'completed') return 'completed';
  return state.enabled ? 'enabled' : 'disabled';
}

function createNightGuardToggle({ document, ipcRenderer, getTarget = () => null } = {}) {
  if (!document) throw new Error('document is required');
  if (!ipcRenderer) throw new Error('ipcRenderer is required');
  const button = document.getElementById('night-guard-toggle');
  const label = document.getElementById('night-guard-toggle-label');
  let state = normalizeNightGuardToggleState();
  let busy = false;

  function render() {
    if (!button || !label) return state;
    const visual = visualStateOf(state);
    button.dataset.state = visual;
    for (const name of ['unavailable', 'disabled', 'enabled', 'waiting', 'runtime', 'recovering', 'completed', 'blocked']) {
      button.classList.toggle(name, name === visual);
    }
    button.classList.toggle('busy', busy);
    button.setAttribute('aria-pressed', String(state.enabled));
    button.setAttribute('aria-busy', String(busy));
    label.textContent = {
      unavailable: '夜间保护',
      disabled: '守护关',
      enabled: state.mode === 'goal' ? '目标守护' : '守护开',
      waiting: `等网络${state.healthyRounds ? ` ${state.healthyRounds}/3` : ''}`,
      runtime: '等输入框',
      recovering: '续跑中',
      completed: '已完成',
      blocked: '需处理',
    }[visual] || '夜间保护';
    button.title = state.message || ({
      unavailable: '夜间保护仅支持当前打开的 Codex 会话',
      disabled: '为当前 Codex 会话手动开启一次性夜间保护',
      enabled: '夜间保护已开启；任务完成后自动关闭。点击可手动关闭',
      waiting: '已确认最终断流，正在等待代理连续稳定；尚未发送恢复指令',
      runtime: '网络已恢复，正在确认 Codex 输入框可安全续跑',
      recovering: '已在同一 Codex 会话中提交受控续跑指令',
      completed: '受保护任务已经完成，保护已自动关闭',
      blocked: '保护已熔断，没有继续发送；请查看会话状态',
    }[visual] || '夜间保护');
    button.disabled = busy || !state.available;
    return state;
  }

  function applyState(next, targetId = state.targetId) {
    state = normalizeNightGuardToggleState({ ...next, targetId, available: !!targetId });
    return render();
  }

  async function refreshTarget() {
    const target = getTarget();
    if (!target || !target.id) {
      state = normalizeNightGuardToggleState();
      render();
      return state;
    }
    const local = target.nightGuard || {};
    applyState(local, target.id);
    try {
      const result = await ipcRenderer.invoke('night-guard:get', { sessionId: target.id });
      if (result && result.ok && result.state && getTarget()?.id === target.id) {
        applyState(result.state, target.id);
      }
    } catch (error) {
      console.warn('[night-guard] failed to refresh target state:', error && error.message);
    }
    return state;
  }

  async function toggle() {
    const target = getTarget();
    if (!target || !target.id || busy) return { ok: false, error: 'target-unavailable' };
    busy = true;
    render();
    try {
      const result = await ipcRenderer.invoke('night-guard:set-enabled', {
        sessionId: target.id,
        enabled: !state.enabled,
      });
      if (result && result.ok && result.state) applyState(result.state, target.id);
      return result;
    } finally {
      busy = false;
      render();
    }
  }

  function init() {
    if (button) button.addEventListener('click', () => { void toggle(); });
    ipcRenderer.on('night-guard-status', (_event, payload = {}) => {
      const target = getTarget();
      if (!target || target.id !== payload.sessionId) return;
      applyState(payload.state || {}, target.id);
    });
    void refreshTarget();
    return state;
  }

  return { init, toggle, refreshTarget, render, getState: () => ({ ...state }) };
}

module.exports = {
  createNightGuardToggle,
  normalizeNightGuardToggleState,
  visualStateOf,
};
