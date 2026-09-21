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
    this.textContent = ''; this.hidden = false; this.listeners = {}; this.value = '';
  }
  get childElementCount() { return this.children.length; }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parentNode=this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children.forEach(node=>{node.parentNode=null;}); this.children=[]; this.append(...nodes); }
  insertBefore(node,before) { node.remove(); node.parentNode=this; this.children.splice(before?this.children.indexOf(before):this.children.length,0,node); }
  remove() { if(this.parentNode) {this.parentNode.children=this.parentNode.children.filter(node=>node!==this);this.parentNode=null;} }
  get lastElementChild() { return this.children.at(-1); }
  contains(node) { return node===this || this.children.some(child=>child.contains(node)); }
  querySelectorAll(selector) { const tags=selector.split(',');return this.children.flatMap(child=>[...(tags.includes(child.tagName)?[child]:[]),...child.querySelectorAll(selector)]); }
  focus() { document.activeElement=this; }
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
  // Recovery happens on the next send, without a manual-review panel.
  controls.update(session({ state: 'unknown', revision: 2 }));
  assert.equal(controls.element.hidden, true);
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

test('questions preserve typed answers when another request arrives, and choices match Codex interaction',()=>withDocument(()=>{
  const controls=createClaudeNativeControls({sessionId:'hub',ipcRenderer:{}});
  const question=id=>({id,epoch:1,submissionId:'turn',method:'claude/requestUserInput',
    params:{questions:[{question:id,options:[{label:'推荐方案',description:'保持完整记录'}]}]},raw:{input:{questions:[]}}});
  controls.update(session({state:'waiting',requests:[question('first')]}));
  const first=controls.element.querySelectorAll('textarea')[0];first.value='我写了一半';first.focus();
  controls.update(session({state:'waiting',revision:2,requests:[question('first'),question('second')]}));
  assert.equal(controls.element.querySelectorAll('textarea')[0],first);
  assert.equal(first.value,'我写了一半');assert.equal(document.activeElement,first);
  const second=controls.element.querySelectorAll('textarea')[1];second.value='第二个回答';
  controls.update(session({state:'waiting',revision:3,requests:[question('second')]}));
  assert.equal(controls.element.querySelectorAll('textarea')[0],second);assert.equal(second.value,'第二个回答');
  const option=controls.element.querySelectorAll('button').find(button=>button.textContent==='推荐方案');
  option.listeners.click();assert.equal(second.value,'推荐方案');assert.equal(document.activeElement,second);
  assert(controls.element.className.includes('codex-native-controls'));
}));

test('submission, accepted input and running work have distinct feedback without recovery actions', () => {
  const s = session({ state: 'starting', reason: '正在提交给 Claude', startedAt: 1000 });
  const composer = buildComposerStatusModel(s, { runtime: deriveSessionRuntimeStatus(s, { now: 5000 }), now: 5000 });
  assert.equal(composer.state, 'working');
  assert.equal(composer.text, 'Claude 正在提交 · 4s');
  assert.equal(composer.action, null, 'no reconnect button while a send is simply in flight');
  s.nativeRuntime.submission={clientSubmissionId:'one',sendStatus:'accepted'};
  const accepted=buildComposerStatusModel(s,{runtime:deriveSessionRuntimeStatus(s,{now:5000}),now:5000});
  assert.equal(accepted.text,'Claude 已收到 · 等待输出 · 4s');
  assert.equal(accepted.action,null);
  s.nativeRuntime.state='running';
  const running=buildComposerStatusModel(s,{runtime:deriveSessionRuntimeStatus(s,{now:5000}),now:5000});
  assert.equal(running.text,'Claude 正在工作 · 4s');
  assert.equal(running.action,null);
  // A real uncertainty still says so.
  const unknown = session({ state: 'unknown' });
  assert.equal(buildComposerStatusModel(unknown, { runtime: deriveSessionRuntimeStatus(unknown) }).text, '等待连接响应');
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
