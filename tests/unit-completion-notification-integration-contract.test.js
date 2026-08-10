'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const modalSource = fs.readFileSync(path.join(root, 'renderer', 'config-modal.js'), 'utf8');
const toggleSource = fs.readFileSync(path.join(root, 'renderer', 'completion-notification-toggle.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const dispatcherSource = fs.readFileSync(path.join(root, 'main', 'groupchat', 'dispatcher.js'), 'utf8');
const {
  buildConfigJsonUpdate,
  toEditableConfig,
  toMaskedConfig,
} = require('../main/ipc/config-handlers.js');

assert.ok(/id="cfg-serverchan-sendkey"[^>]*type="password"|type="password"[^>]*id="cfg-serverchan-sendkey"/.test(html),
  'SendKey must be rendered as a password input');
for (const id of [
  'cfg-notification-enabled',
  'cfg-notification-group-chats',
  'cfg-notification-include-preview',
  'config-notification-test',
  'config-notification-status',
  'completion-notification-toggle',
  'completion-notification-toggle-label',
]) {
  assert.ok(html.includes(`id="${id}"`), `settings UI should include ${id}`);
}
assert.ok(/ipcRenderer\.invoke\('test-completion-notification',\s*\{\s*sendKey\s*\}\)/.test(modalSource),
  'test button should call the dedicated main-process IPC without requiring a save');
assert.ok(/\.\.\.readNotificationForm\(\)/.test(modalSource),
  'settings save payload should include notification fields');
assert.ok(!html.includes('cfg-notification-mode') && !html.includes('cfg-notification-idle-seconds'),
  'automatic focus/idle filtering controls should be removed');
assert.ok(/set-completion-notification-enabled/.test(toggleSource),
  'top-bar toggle should persist through a dedicated narrow IPC');
assert.ok(/openNotificationSettings/.test(toggleSource),
  'unconfigured top-bar toggle should guide the user to ServerChan settings');

assert.ok(/completionNotifier\.handleTurnComplete\(ev\s*\|\|\s*\{\},\s*session\)/.test(mainSource),
  'main-process transcript completion should feed the notifier');
assert.ok(/completionNotifier\.notePromptSubmitted\(ev\s*\|\|\s*\{\}\)/.test(mainSource),
  'prompt submission should feed duration tracking');
assert.ok(/onGroupChatComplete:\s*\(event\)\s*=>\s*completionNotifier\.handleGroupChatComplete/.test(mainSource),
  'main should wire aggregate group-chat completion into the notifier');
assert.ok(/notifyGroupChatComplete\(\{[\s\S]*durationMs:\s*Date\.now\(\)\s*-\s*turnStartedAt[\s\S]*\},\s*meeting\)/.test(dispatcherSource),
  'dispatcher should emit one aggregate completion after a group turn settles');

const config = {
  notifications: {
    enabled: true,
    includePreview: false,
    notifyGroupChats: true,
    serverchanSendKey: 'SCT_SECRET_123456',
  },
};
const masked = toMaskedConfig(config);
assert.strictEqual(masked.serverchanSendKey, '***3456');
assert.strictEqual(masked.serverchanSendKeySet, true);
assert.ok(!JSON.stringify(masked).includes('SCT_SECRET_123456'));
const editable = toEditableConfig(config);
assert.strictEqual(editable.serverchanSendKey, 'SCT_SECRET_123456');
assert.ok(!Object.prototype.hasOwnProperty.call(editable, 'notificationMode'));

const existing = {
  providers: {
    codex: {
      backend: 'api',
      subscription_profile: 'work',
      subscription_profiles: [{ id: 'work', label: 'Work' }],
      api_key: 'CODEX_EXISTING_KEY',
      base_url: 'https://codex.example.test/v1',
      model: 'codex-custom-model',
      provider: 'custom-provider',
    },
  },
  notifications: {
    enabled: false,
    mode: 'away_or_idle',
    idle_seconds: 120,
    min_duration_seconds: 15,
    custom: 'preserve-me',
    serverchan: { send_key: 'SCT_OLD_123456', custom: 'keep' },
  },
  unrelated: { keep: true },
};
const preserved = buildConfigJsonUpdate(existing, {});
assert.deepStrictEqual(preserved.notifications, existing.notifications,
  'an unrelated partial save must not rewrite notification config');
const updated = buildConfigJsonUpdate(existing, {
  notificationEnabled: true,
  notificationIncludePreview: true,
  notificationNotifyGroupChats: false,
  serverchanSendKey: 'SCT_NEW_654321',
});
assert.strictEqual(updated.unrelated.keep, true);
assert.deepStrictEqual(updated.providers.codex, existing.providers.codex,
  'the dedicated notification update must preserve every Codex provider field');
assert.strictEqual(updated.notifications.custom, 'preserve-me');
assert.strictEqual(updated.notifications.enabled, true);
assert.strictEqual(updated.notifications.include_preview, true);
assert.strictEqual(updated.notifications.notify_group_chats, false);
assert.strictEqual(updated.notifications.serverchan.custom, 'keep');
assert.strictEqual(updated.notifications.serverchan.send_key, 'SCT_NEW_654321');
for (const legacyField of ['mode', 'idle_seconds', 'min_duration_seconds']) {
  assert.ok(!Object.prototype.hasOwnProperty.call(updated.notifications, legacyField),
    `legacy automatic filter field ${legacyField} should be removed on notification save`);
}

console.log('unit-completion-notification-integration-contract.test.js OK');
