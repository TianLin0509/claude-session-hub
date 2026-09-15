'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createSessionSplit } = require('../renderer/session-split');

class Element {
  constructor() {
    this.children = []; this.dataset = {}; this.attributes = {}; this.style = { setProperty() {} };
    this.clientWidth = 1400; this.hidden = false;
    const classes = new Set(); this.classList = { contains: k => classes.has(k), toggle: (k, v) => v ? classes.add(k) : classes.delete(k) };
  }
  before() {}
  append(...els) { this.children.push(...els); }
  prepend(...els) { this.children.unshift(...els); }
  replaceChildren(...els) { this.children = els; }
  setAttribute(k, v) { this.attributes[k] = v; }
  addEventListener() {}
  removeEventListener() {}
  focus() {}
  querySelector(selector) { return this.queries?.[selector] || null; }
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture() {
  const rows = new Map(['a', 'b', 'c'].map(id => [id, { id, kind: 'codex', status: 'idle' }]));
  let primaryId = 'a'; const calls = [], alerts = [], requests = new Map();
  const buttons = new Element(); buttons.queries = { '[data-session-layout="single"]': new Element(), '[data-session-layout="two"]': new Element() };
  const s = {
    primaryId: () => primaryId, sessions: () => [...rows.values()], session: id => rows.get(id), otherView: () => null,
    selectPrimary: async id => { primaryId = id; calls.push(['primary', id]); },
    focusPrimary() {}, alert: error => alerts.push(error), onFocus() {}, resize() {},
    openStatus: async id => requests.has(id) ? requests.get(id).promise : { available: true },
    ensureOpen: async id => { rows.get(id).status = 'idle'; }, sameIdentity: () => false,
    createView: id => ({ sessionId: id, focus() {}, resize() {}, setVisible() {}, updateStatus() {}, dispose() { calls.push(['dispose', id]); } }),
  };
  const layout = createSessionSplit({ document: { createElement: () => new Element() }, window: { ResizeObserver: class { observe() {} }, queueMicrotask }, primary: new Element(), buttons, services: s });
  return { layout, calls, alerts, requests, rows, s };
}
test('late open result cannot replace the most recent right-pane choice', async () => {
  const f = fixture(); await f.layout.setLayout('two');
  const pending = deferred(); f.requests.set('b', pending);
  const older = f.layout.route('b'); await f.layout.route('c');
  pending.resolve({ available: true }); await older;
  assert.equal(f.layout.secondary().sessionId, 'c');
  assert(!f.calls.some(([kind, id]) => kind === 'dispose' && id === 'c'));
});
test('occupied target preserves current right view and reports the owner', async () => {
  const f = fixture(); await f.layout.setLayout('two'); await f.layout.route('b');
  const pending = deferred(); f.requests.set('c', pending); pending.resolve({ available: false, message: 'PID 123 v1.2.3 占用' });
  await f.layout.route('c'); assert.equal(f.layout.secondary().sessionId, 'b');
  assert.deepEqual(f.alerts, ['PID 123 v1.2.3 占用']);
});
test('selecting existing primary focuses it; single mode promotes focused secondary exactly once', async () => {
  const f = fixture(); await f.layout.setLayout('two'); await f.layout.route('b');
  await f.layout.route('a'); assert.equal(f.layout.focusedId(), 'a'); assert.equal(f.layout.secondary().sessionId, 'b');
  await f.layout.route('b'); await f.layout.setLayout('single');
  assert.deepEqual(f.calls, [['dispose', 'b'], ['primary', 'b']]);
});
test('delayed session-created is consumed even after resume promise finishes', async () => {
  const f = fixture(); f.rows.get('b').status = 'dormant';
  await f.layout.setLayout('two'); await f.layout.route('b');
  assert.equal(f.layout.handlesCreated('b'), true);
  assert.equal(f.layout.handlesCreated('b'), false);
});
test('leaving split during open cancels mounting but still consumes late native creation', async () => {
  const f = fixture(); f.rows.get('b').status = 'dormant'; const resume = deferred(); f.s.ensureOpen = () => resume.promise;
  await f.layout.setLayout('two'); const opening = f.layout.route('b');
  await Promise.resolve(); await f.layout.setLayout('single'); resume.resolve(); await opening;
  assert.equal(f.layout.secondary(), null); assert.equal(f.layout.handlesCreated('b'), true);
});
