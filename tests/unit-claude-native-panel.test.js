'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ClaudeNativeSession } = require('../core/claude-native-session');
const { createClaudeNativeControls } = require('../renderer/claude-native-controls');
const { deriveSessionRuntimeStatus } = require('../renderer/session-runtime-status');
const { buildComposerStatusModel } = require('../core/session-status-summary');

// Minimal DOM: enough for the panel to build forms and buttons.
class Element {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.style = {}; this.dataset = {};
    this.textContent = ''; this.hidden = false; this.listeners = {};
  }
  get childElementCount() { return this.children.length; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute() {}
  addEventListener(name, fn) { this.listeners[name] = fn; }
}

function withDocument(fn) {
  const previous = global.document;
  global.document = { createElement: tag => new Element(tag) };
  try { return fn(); } finally {
    if (previous === undefined) delete global.document; else global.document = previous;
  }
}

const session = runtime => ({ id: 'hub', kind: 'claude', runtimeBackend: 'claude-stream-json',
  nativeRuntime: { epoch: 1, revision: 1, requests: [], connection: 'connected', ...runtime } });

test('the panel stays hidden unless something needs the user, like the Codex panel', () => withDocument(() => {
  const controls = createClaudeNativeControls({ sessionId: 'hub', ipcRenderer: {} });
  // Ordinary work never shows a status block: the composer already says it.
  for (const state of ['idle', 'starting', 'running', 'completed', 'interrupted']) {
    controls.update(session({ state }));
    assert.equal(controls.element.hidden, true, state);
  }
  // A genuine uncertainty offers the reconcile step.
  controls.update(session({ state: 'unknown', revision: 2 }));
  assert.equal(controls.element.hidden, false);
  // An approval is something to act on.
  controls.update(session({ state: 'waiting', revision: 3, requests: [{ id: 'r1', method: 'claude/canUseTool',
    params: { toolName: 'Bash' }, raw: { input: { command: 'ls' } } }] }));
  assert.equal(controls.element.hidden, false);
  // A seat that has not started says so, as Codex does.
  controls.update(session({ state: 'idle', connection: 'unstarted', revision: 4 }));
  assert.equal(controls.element.hidden, false);
  // A non-native session never shows it.
  controls.update({ kind: 'claude' });
  assert.equal(controls.element.hidden, true);
}));

test('work in flight reads as working, not as an uncertain result', () => {
  const s = session({ state: 'starting', reason: '正在提交给 Claude', startedAt: 1000 });
  const composer = buildComposerStatusModel(s, { runtime: deriveSessionRuntimeStatus(s, { now: 5000 }), now: 5000 });
  assert.equal(composer.state, 'working');
  assert.match(composer.text, /正在工作/);
  assert.equal(composer.action, null, 'no reconnect button while a send is simply in flight');
  // A real uncertainty still says so.
  const unknown = session({ state: 'unknown' });
  assert.equal(buildComposerStatusModel(unknown, { runtime: deriveSessionRuntimeStatus(unknown) }).text, '本条提交待核对');
});

test('a submission waiting for its echo is published as starting, never as unknown', async t => {
  const native = new ClaudeNativeSession({ executable: process.execPath,
    commandArgs: [path.join(__dirname, 'fixtures/claude-stream.js'), '--fixture=no-echo'] });
  t.after(() => native.close());
  await native.start();
  const states = [];
  native.on('state', snapshot => states.push(snapshot.state));
  native.submit('等待回显', { clientSubmissionId: 'in-flight' }).catch(() => undefined);
  const deadline = Date.now() + 3000;
  while (!states.includes('starting') && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
  assert.ok(states.includes('starting'), JSON.stringify(states));
  assert.equal(states.includes('unknown'), false, 'an ordinary in-flight send must not read as 待核对');
  assert.equal(native.runtime.reason, '正在提交给 Claude');
});
