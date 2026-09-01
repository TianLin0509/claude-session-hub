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
    completionNotificationEnabled: true,
    feishuTargetSet: true,
    available: true,
    targetType: 'session',
    targetId: 'session-1',
  }), {
    enabled: true,
    configured: true,
    available: true,
    targetType: 'session',
    targetId: 'session-1',
  });

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
  let config = { notificationConfigured: false };
  let target = {
    id: 'session-1',
    type: 'session',
    title: 'Important session',
    completionNotificationEnabled: false,
  };
  let changedListener = null;
  let targetChangedListener = null;
  const invocations = [];
  const ipcRenderer = {
    async invoke(channel, payload) {
      invocations.push({ channel, payload });
      if (channel === 'get-hub-config') return config;
      if (channel === 'set-completion-notification-enabled') {
        assert.strictEqual(payload.sessionId, target.id);
        target.completionNotificationEnabled = payload.enabled;
        return {
          ok: true,
          enabled: payload.enabled,
          configured: true,
          targetType: 'session',
          targetId: target.id,
        };
      }
      throw new Error(`unexpected channel: ${channel}`);
    },
    on(channel, listener) {
      if (channel === 'completion-notification-config-changed') changedListener = listener;
      if (channel === 'completion-notification-target-changed') targetChangedListener = listener;
    },
  };

  const controller = createCompletionNotificationToggle({
    document,
    ipcRenderer,
    getNotificationTarget: () => target,
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

  config = { notificationConfigured: true };
  await controller.refresh();
  assert.strictEqual(button.dataset.state, 'disabled');
  assert.strictEqual(label.textContent, '通知关');
  const enabled = await controller.toggle();
  assert.strictEqual(enabled.ok, true);
  assert.deepStrictEqual(controller.getState(), {
    enabled: true,
    configured: true,
    available: true,
    targetType: 'session',
    targetId: 'session-1',
  });
  assert.strictEqual(button.dataset.state, 'enabled');
  assert.strictEqual(label.textContent, '通知开');
  assert.strictEqual(button.getAttribute('aria-pressed'), 'true');

  target.completionNotificationEnabled = false;
  changedListener({}, { configured: true });
  assert.strictEqual(button.dataset.state, 'disabled');
  assert.strictEqual(label.textContent, '通知关');

  target = null;
  targetChangedListener({}, {});
  assert.strictEqual(button.dataset.state, 'unavailable');
  assert.strictEqual(label.textContent, '会话通知');

  console.log('unit-completion-notification-toggle.test.js OK');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
