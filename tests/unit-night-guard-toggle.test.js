'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createNightGuardToggle,
  normalizeNightGuardToggleState,
  visualStateOf,
} = require('../renderer/night-guard-toggle.js');

function element() {
  const classes = new Set();
  const attrs = new Map();
  const listeners = {};
  return {
    dataset: {}, textContent: '', title: '', disabled: false,
    classList: { toggle(name, on) { if (on) classes.add(name); else classes.delete(name); }, contains: name => classes.has(name) },
    setAttribute(name, value) { attrs.set(name, String(value)); },
    getAttribute(name) { return attrs.get(name); },
    addEventListener(name, fn) { listeners[name] = fn; },
    _listeners: listeners,
  };
}

test('night guard toggle renders lifecycle and sends a per-session manual change', async () => {
  const button = element();
  const label = element();
  const document = { getElementById: id => id === 'night-guard-toggle' ? button : (id === 'night-guard-toggle-label' ? label : null) };
  let target = { id: 's1', kind: 'codex', nightGuard: { enabled: false, status: 'off' } };
  let statusListener = null;
  const calls = [];
  const ipcRenderer = {
    async invoke(channel, payload) {
      calls.push({ channel, payload });
      if (channel === 'night-guard:get') return { ok: true, state: target.nightGuard };
      if (channel === 'night-guard:set-enabled') {
        target.nightGuard = { enabled: payload.enabled, status: payload.enabled ? 'armed' : 'off', mode: 'manual' };
        return { ok: true, state: target.nightGuard };
      }
      throw new Error(channel);
    },
    on(channel, fn) { if (channel === 'night-guard-status') statusListener = fn; },
  };
  const toggle = createNightGuardToggle({ document, ipcRenderer, getTarget: () => target });
  toggle.init();
  await toggle.refreshTarget();
  assert.equal(button.dataset.state, 'disabled');
  await toggle.toggle();
  assert.equal(button.dataset.state, 'enabled');
  assert.equal(label.textContent, '守护开');
  assert.equal(calls.some(call => call.channel === 'night-guard:set-enabled' && call.payload.enabled), true);

  statusListener({}, { sessionId: 's1', state: { enabled: true, status: 'waiting-network', healthyRounds: 2 } });
  assert.equal(button.dataset.state, 'waiting');
  assert.equal(label.textContent, '等网络 2/3');

  target = null;
  await toggle.refreshTarget();
  assert.equal(button.dataset.state, 'unavailable');
  assert.equal(button.disabled, true);
});

test('toggle normalization maps blocked protection to a visible terminal state', () => {
  const state = normalizeNightGuardToggleState({ available: true, targetId: 's1', status: 'blocked' });
  assert.equal(visualStateOf(state), 'blocked');
});
