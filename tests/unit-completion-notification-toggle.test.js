'use strict';

const assert = require('assert');
const {
  createCompletionNotificationToggle,
  normalizeToggleState,
} = require('../renderer/completion-notification-toggle.js');

function makeElement() {
  const classes = new Set();
  const attributes = new Map();
  const listeners = {};
  return {
    className: '',
    dataset: {},
    textContent: '',
    title: '',
    classList: {
      toggle(name, on) {
        if (on) classes.add(name);
        else classes.delete(name);
      },
      contains(name) { return classes.has(name); },
    },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name); },
    addEventListener(type, handler) { listeners[type] = handler; },
    _classes: classes,
    _listeners: listeners,
  };
}

async function main() {
  assert.deepStrictEqual(normalizeToggleState({
    notificationEnabled: true,
    serverchanSendKeySet: true,
  }), { enabled: true, configured: true });

  const button = makeElement();
  const label = makeElement();
  const document = {
    getElementById(id) {
      if (id === 'completion-notification-toggle') return button;
      if (id === 'completion-notification-toggle-label') return label;
      return null;
    },
  };

  let openSettingsCount = 0;
  let config = { notificationEnabled: false, serverchanSendKeySet: false };
  let changedListener = null;
  const invocations = [];
  const ipcRenderer = {
    async invoke(channel, payload) {
      invocations.push({ channel, payload });
      if (channel === 'get-hub-config') return config;
      if (channel === 'set-completion-notification-enabled') {
        config = {
          notificationEnabled: payload.enabled,
          serverchanSendKeySet: true,
        };
        return { ok: true, enabled: payload.enabled, configured: true };
      }
      throw new Error(`unexpected channel: ${channel}`);
    },
    on(channel, listener) {
      if (channel === 'completion-notification-config-changed') changedListener = listener;
    },
  };

  const controller = createCompletionNotificationToggle({
    document,
    ipcRenderer,
    openNotificationSettings() { openSettingsCount += 1; },
  });
  controller.init();
  await controller.refresh();
  assert.strictEqual(button.dataset.state, 'unconfigured');
  assert.strictEqual(label.textContent, '通知未配');
  assert.strictEqual(button.getAttribute('aria-pressed'), 'false');

  const missing = await controller.toggle();
  assert.strictEqual(missing.status, 'configuration_missing');
  assert.strictEqual(openSettingsCount, 1);
  assert.strictEqual(invocations.filter(item => item.channel === 'set-completion-notification-enabled').length, 0);

  controller.applyState({ enabled: false, configured: true });
  assert.strictEqual(button.dataset.state, 'disabled');
  assert.strictEqual(label.textContent, '通知关');
  const enabled = await controller.toggle();
  assert.strictEqual(enabled.ok, true);
  assert.deepStrictEqual(controller.getState(), { enabled: true, configured: true });
  assert.strictEqual(button.dataset.state, 'enabled');
  assert.strictEqual(label.textContent, '通知开');
  assert.strictEqual(button.getAttribute('aria-pressed'), 'true');

  changedListener({}, { enabled: false, configured: true });
  assert.strictEqual(button.dataset.state, 'disabled');
  assert.strictEqual(label.textContent, '通知关');

  console.log('unit-completion-notification-toggle.test.js OK');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
