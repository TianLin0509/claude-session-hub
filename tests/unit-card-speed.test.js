'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createModelUiController } = require('../renderer/model-ui');

function element() {
  return {
    children: [], dataset: {}, style: {}, listeners: {}, classList: { contains: () => false },
    appendChild(child) { this.children.push(child); },
    replaceChildren() { this.children = []; },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 10, top: 100, bottom: 120, width: 200, height: 80 }; },
    remove() { this.removed = true; },
  };
}
async function choose({ kind = 'codex', screen = '', response = { ok: true, result: { codexSpeedTier: 'standard' } }, busy = false } = {}) {
  const session = { id: 's', kind, status: busy ? 'running' : 'idle', currentModel: { id: 'gpt-6-astra' }, codexSpeedTier: 'fast', effort: 'high' };
  const calls = [];
  const document = { body: element(), createElement: element, addEventListener() {}, removeEventListener() {},
    defaultView: { innerWidth: 1000, innerHeight: 800, WorkspaceController: { codexModelTuning: () => ({ fromCache: true, supportsFast: true }) } } };
  const ui = createModelUiController({ document, sessions: new Map([['s', session]]),
    ipcRenderer: { async invoke(...args) { calls.push(args); return response; } },
    terminalPanelEl: element(), getActiveSessionId: () => 's', escapeHtml: String,
    getTerminalScreenText: () => screen, sleep: async () => {}, setTimeoutFn: fn => fn(),
  });
  await ui.showSpeedPicker(element(), 's');
  const menu = document.body.children[0];
  menu.children.find(item => item.dataset.speed === 'standard').listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  return { session, calls, menu };
}

for (const kind of ['codex', 'codex-resume']) {
  for (const screen of ['', '› old renderer draft']) {
    test(`${kind} speed uses backend truth even with missing/stale renderer frame ${JSON.stringify(screen)}`, async () => {
      const { calls, session, menu } = await choose({ kind, screen });
      assert.deepEqual(calls, [['codex:set-speed', { sessionId: 's', tier: 'standard' }]]);
      assert.equal(session.codexSpeedTier, 'standard');
      assert.equal(session.effort, 'high');
      assert.equal(session.currentModel.id, 'gpt-6-astra');
      assert.equal(session._modelSwitchPending, undefined);
      assert.equal(menu.removed, true);
    });
  }
}
test('backend rejection remains visible and does not claim a speed change', async () => {
  const { calls, session, menu } = await choose({ response: { ok: false, message: 'Codex 输入框有草稿' } });
  assert.equal(calls.length, 1);
  assert.equal(session.codexSpeedTier, 'fast');
  assert.equal(session._modelSwitchPending, undefined);
  assert.match(menu.children.find(item => item.dataset.state === 'error').textContent, /输入框有草稿/);
});
test('busy sessions are still protected; no command interrupts the answer', async () => {
  const { calls, session, menu } = await choose({ busy: true });
  assert.deepEqual(calls, []);
  assert.equal(session.codexSpeedTier, 'fast');
  assert.match(menu.children.find(item => item.dataset.state === 'error').textContent, /当前回答结束/);
});
test('Claude PTY retains its existing draft readiness guard', async () => {
  const { calls, menu } = await choose({ kind: 'claude', screen: '❯ draft' });
  assert.deepEqual(calls, []);
  assert.match(menu.children.find(item => item.dataset.state === 'error').textContent, /草稿/);
});
