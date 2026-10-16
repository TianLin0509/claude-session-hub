'use strict';

// Execute the actual controller and its DOM handlers: changing effort is not
// permission to open CodeAgent's /model picker when the first prompt is sent.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const rendererDir = path.join(__dirname, '..', 'renderer');
const source = fs.readFileSync(path.join(rendererDir, 'workspace-controller.js'), 'utf8');
const catalog = [
  { id: 'GLM-5.2-WX-Auto', label: 'GLM-5.2 Auto' },
  { id: 'MiniMax-M2.7', label: 'MiniMax M2.7' },
];
const settle = () => new Promise(resolve => setImmediate(resolve));

function element(dataset = {}) {
  const listeners = new Map();
  return {
    dataset, style: {}, value: '', innerHTML: '', textContent: '', hidden: false,
    classList: { toggle() {} },
    setAttribute() {}, focus() {},
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    async fire(type) {
      for (const handler of listeners.get(type) || []) {
        await handler({ target: this, preventDefault() {}, stopPropagation() {} });
      }
      await settle();
    },
  };
}

function harness(config = {}) {
  const nodes = new Map([
    'new-session-menu', 'new-session-tuning', 'new-session-model',
    'new-session-effort', 'new-session-mcp', 'new-session-tuning-note',
    'new-session-summary',
  ].map(id => [id, element()]));
  const kindButtons = ['codeagent', 'powershell', 'claude'].map(kind => element({ kind }));
  const menu = nodes.get('new-session-menu');
  menu.querySelectorAll = selector => selector === '.new-session-option' ? kindButtons : [];
  menu.querySelector = selector => kindButtons.find(button => selector.includes(`data-kind="${button.dataset.kind}"`)) || null;
  const created = [];
  const ipcRenderer = {
    on() {},
    async invoke(channel, data) {
      if (channel === 'get-hub-config') return config;
      if (channel === 'codeagent:models') return { options: catalog };
      if (channel === 'workspace:list') return { root: 'D:\\IsolatedHubTest', flatRoot: true, items: [], recommended: [] };
      if (channel === 'workspace:default') return { path: 'D:\\IsolatedHubTest', label: 'Test', draft: false };
      if (channel === 'create-session') { created.push(data); return { id: 'test-session' }; }
      return null;
    },
  };
  const sandbox = {
    console,
    window: { dispatchEvent() {} },
    document: { getElementById: id => nodes.get(id) || null },
    CustomEvent: class { constructor(type) { this.type = type; } },
    setTimeout, clearTimeout,
    require(id) {
      if (id === 'electron') return { ipcRenderer };
      if (id === 'path') return path;
      if (id === './codeagent-preference') return { refresh: async () => false, preferredKind: () => 'codeagent', rememberKind() {} };
      if (id === '../core/distribution') return { kindAllowed: () => true };
      if (id === '../core/session-scenes') return { supportsScenes: () => false };
      return require(path.resolve(rendererDir, id));
    },
  };
  vm.runInNewContext(source, sandbox, { filename: 'workspace-controller.js' });
  const controller = sandbox.window.WorkspaceController;
  return {
    controller, nodes, created,
    async open(kind = 'codeagent') { controller.openNewSessionModal({ kind }); await settle(); },
    async change(id, value) { const node = nodes.get(id); node.value = value; await node.fire('change'); },
    async kind(kind) { await kindButtons.find(button => button.dataset.kind === kind).fire('click'); },
    async submit() { await controller.submitNewSession(); return created.at(-1); },
  };
}

test('default GUI creation explicitly keeps the native CodeAgent model', async () => {
  const h = harness();
  await h.open();
  assert.equal(h.nodes.get('new-session-model').value, '');
  assert.match(h.nodes.get('new-session-model').innerHTML, /<option value="">沿用 CodeAgent 当前模型<\/option>/);
  const created = await h.submit();
  assert.equal(created.kind, 'codeagent');
  assert.equal(created.opts.codeagentModelPick, false);
  assert.equal(created.opts.effort, 'high');
  assert.match(h.nodes.get('new-session-summary').innerHTML, /沿用 CodeAgent 当前模型/);
});

test('saved launch defaults do not count as a model choice in this dialog', async () => {
  const h = harness({ defaultModels: { codeagent: 'MiniMax-M2.7' }, launchDefaults: { codeagent: { effort: 'low' } } });
  await h.open();
  assert.equal(h.nodes.get('new-session-model').value, '');
  const created = await h.submit();
  assert.equal(created.opts.model, 'MiniMax-M2.7');
  assert.equal(created.opts.effort, 'low');
  assert.equal(created.opts.codeagentModelPick, false);
});

// 2026-10-16：CodeAgent 不再有 MCP 下拉（CLI 挡不住用户级 MCP，选档只会关掉 Hub 自己的工具），创建时不带档位、按完整挂载。
test('effort changes do not authorize a model picker; CodeAgent sends no MCP profile', async () => {
  const h = harness();
  await h.open();
  await h.change('new-session-effort', 'low');
  const created = await h.submit();
  assert.equal(created.opts.effort, 'low');
  assert.equal(created.opts.mcpProfile, undefined);
  assert.equal(created.opts.codeagentModelPick, false);
});

test('an explicit model selection is sent to session creation', async () => {
  const h = harness();
  await h.open();
  await h.change('new-session-model', 'MiniMax-M2.7');
  const created = await h.submit();
  assert.equal(created.opts.model, 'MiniMax-M2.7');
  assert.equal(created.opts.codeagentModelPick, true);
  assert.doesNotMatch(h.nodes.get('new-session-summary').innerHTML, /沿用 CodeAgent 当前模型/);
});

test('choosing the old default GLM is also an explicit model selection', async () => {
  const h = harness();
  await h.open();
  await h.change('new-session-model', 'GLM-5.2-WX-Auto');
  const created = await h.submit();
  assert.equal(created.opts.model, 'GLM-5.2-WX-Auto');
  assert.equal(created.opts.codeagentModelPick, true);
});

test('returning to the native-model option cancels an explicit picker request', async () => {
  const h = harness();
  await h.open();
  await h.change('new-session-model', 'MiniMax-M2.7');
  await h.change('new-session-model', '');
  await h.kind('powershell');
  await h.kind('codeagent');
  assert.equal(h.nodes.get('new-session-model').value, '');
  assert.equal((await h.submit()).opts.codeagentModelPick, false);
});

test('explicit CodeAgent model choice survives switching kinds and back', async () => {
  const h = harness();
  await h.open();
  await h.change('new-session-model', 'MiniMax-M2.7');
  await h.kind('powershell');
  assert.equal('codeagentModelPick' in h.controller.tuningOpts(), false);
  await h.kind('codeagent');
  const created = await h.submit();
  assert.equal(created.opts.model, 'MiniMax-M2.7');
  assert.equal(created.opts.codeagentModelPick, true);
});

test('effort-only state remains implicit after switching kinds and back', async () => {
  const h = harness();
  await h.open();
  await h.change('new-session-effort', 'medium');
  await h.kind('powershell');
  await h.kind('codeagent');
  const created = await h.submit();
  assert.equal(created.opts.effort, 'medium');
  assert.equal(created.opts.codeagentModelPick, false);
});

test('another kind model choice cannot authorize CodeAgent model selection', async () => {
  const h = harness();
  await h.open('claude');
  await h.change('new-session-model', 'haiku');
  await h.kind('codeagent');
  assert.equal((await h.submit()).opts.codeagentModelPick, false);
});

test('closing and reopening the dialog clears the previous explicit choice', async () => {
  const h = harness();
  await h.open();
  await h.change('new-session-model', 'MiniMax-M2.7');
  h.controller.closeNewSessionModal();
  await h.open();
  assert.equal((await h.submit()).opts.codeagentModelPick, false);
});

test('shared programmatic tuning retains the existing explicit-model contract', () => {
  const h = harness();
  const opts = h.controller.buildSessionTuningOpts('codeagent', 'MiniMax-M2.7');
  assert.equal(opts.model, 'MiniMax-M2.7');
  assert.equal(opts.codeagentModelPick, true);
});

test('group slots distinguish inherited defaults from concrete model choices through main sanitization', () => {
  const h = harness();
  const { sessionOptionsForMeetingSlot } = require('../main/ipc/meeting-create-handlers');
  for (const [model, selection, expected] of [
    [undefined, {}, false],
    ['MiniMax-M2.7', { followDefault: true }, false],
    ['MiniMax-M2.7', { followDefault: false }, true],
    ['MiniMax-M2.7', { codeagentModelPick: false }, false],
  ]) {
    const opts = h.controller.buildSessionTuningOpts('codeagent', model, selection);
    const main = sessionOptionsForMeetingSlot({ kind: 'codeagent', ...opts }, 'D:/test');
    assert.equal(main.codeagentModelPick, expected);
    assert.equal(require('../core/session-manager')._private.shouldPickCodeAgentModel(main), expected);
  }
});
