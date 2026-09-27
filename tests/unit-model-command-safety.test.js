'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createModelUiController } = require('../renderer/model-ui');

function controller(session) {
  const sent = [];
  const ui = createModelUiController({
    document: {}, ipcRenderer: { send: (channel, payload) => sent.push({ channel, payload }) },
    sessions: new Map([['s', session]]), terminalPanelEl: {}, getActiveSessionId: () => 's',
    escapeHtml: String, getTerminalScreenText: () => '› Ask Codex to do anything',
    repaintActiveComposer: () => {},
  });
  return { ui, sent };
}
for (const operation of ['model', 'effort']) test(`rejecting a busy Codex ${operation} change must not send Escape into its running task`, async () => {
  const { ui, sent } = controller({ id: 's', kind: 'codex', agentRuntime: 'pty', status: 'running',
    runtimeTruth: { state: 'running', confidence: 'authoritative', observedAt: Date.now() },
    currentModel: { id: 'gpt-5.6-sol' }, effort: 'low' });
  const result = operation === 'model'
    ? await ui.switchModel('s', { id: 'gpt-6-astra', label: 'Astra' })
    : await ui.switchEffort('s', 'high');
  assert.equal(result.ok, false);
  assert.deepEqual(sent, [], 'refusing a setting change must not stop the model');
});
