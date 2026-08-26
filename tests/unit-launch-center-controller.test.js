'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  LAUNCH_INTENTS,
  createLaunchCenterController,
  normalizeLaunchIntent,
} = require('../renderer/launch-center-controller.js');

class FakeClassList {
  constructor() { this.values = new Set(); }
  toggle(name, force) {
    if (force) this.values.add(name);
    else this.values.delete(name);
    return !!force;
  }
  contains(name) { return this.values.has(name); }
}

class FakeElement {
  constructor(dataset = {}) {
    this.dataset = { ...dataset };
    this.classList = new FakeClassList();
    this.listeners = new Map();
    this.attributes = new Map();
    this.hidden = false;
    this.disabled = false;
    this.isConnected = true;
    this.style = { display: 'none' };
    this.tabIndex = 0;
    this.focusCount = 0;
    this.textContent = '';
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  getAttribute(name) { return this.attributes.get(name) || null; }
  focus() { this.focusCount += 1; }
  getClientRects() { return this.hidden ? [] : [{}]; }
  querySelectorAll() { return []; }
  async emit(type, event = {}) {
    const payload = {
      key: '', shiftKey: false, preventDefault() {}, stopPropagation() {},
      ...event,
    };
    for (const handler of (this.listeners.get(type) || [])) await handler(payload);
  }
}

class FakeWindow {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  emit(type) { for (const handler of (this.listeners.get(type) || [])) handler({ type }); }
}

function fixture() {
  const menu = new FakeElement();
  const trigger = new FakeElement();
  const subtitle = new FakeElement();
  const error = new FakeElement();
  error.hidden = true;
  const groupError = new FakeElement();
  groupError.hidden = true;
  const resumeCancel = new FakeElement();
  const intents = LAUNCH_INTENTS.map(launchIntent => new FakeElement({ launchIntent }));
  const panels = LAUNCH_INTENTS.map(launchPanel => new FakeElement({ launchPanel }));
  const resumes = [new FakeElement({ resumeKind: 'codex-resume' })];
  const elements = {
    'new-session-menu': menu,
    'btn-new': trigger,
    'launch-center-subtitle': subtitle,
    'launch-center-error': error,
    'launch-center-group-error': groupError,
    'launch-center-resume-cancel': resumeCancel,
  };
  const view = new FakeWindow();
  const document = {
    activeElement: trigger,
    defaultView: view,
    getElementById: id => elements[id] || null,
    querySelectorAll(selector) {
      if (selector === '[data-launch-intent]') return intents;
      if (selector === '[data-launch-panel]') return panels;
      if (selector === '[data-resume-kind]') return resumes;
      return [];
    },
  };
  return { document, view, menu, trigger, subtitle, error, groupError, resumeCancel, intents, panels, resumes };
}

test('launch intents normalize to the three supported routes', () => {
  assert.deepEqual(LAUNCH_INTENTS, ['session', 'group', 'resume']);
  assert.equal(normalizeLaunchIntent('group'), 'group');
  assert.equal(normalizeLaunchIntent('unknown'), 'session');
});

test('controller embeds group configuration once per open cycle and preserves resume/focus behavior', async () => {
  const ui = fixture();
  const calls = { open: [], close: 0, prepareGroup: 0, closeGroup: 0, resume: [] };
  const controller = createLaunchCenterController({
    document: ui.document,
    openSessionModal: options => { calls.open.push(options); ui.menu.style.display = 'flex'; },
    closeSessionModal: () => { calls.close += 1; ui.menu.style.display = 'none'; },
    prepareGroupPanel: () => { calls.prepareGroup += 1; },
    closeGroupPanel: () => { calls.closeGroup += 1; },
    resumeSession: async kind => calls.resume.push(kind),
  });

  controller.open('group', { kind: 'claude' });
  assert.equal(controller.getActiveIntent(), 'group');
  assert.equal(ui.panels.find(panel => panel.dataset.launchPanel === 'group').hidden, false);
  assert.equal(ui.panels.find(panel => panel.dataset.launchPanel === 'session').hidden, true);
  assert.equal(ui.trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(calls.prepareGroup, 1);

  controller.selectIntent('session', { focus: false });
  controller.selectIntent('group', { focus: false });
  assert.equal(calls.prepareGroup, 1, 'switching within one open cycle must preserve member edits');
  ui.menu.style.display = 'none';
  ui.view.emit('launch-center:closed');
  assert.equal(calls.closeGroup, 1);
  assert.equal(ui.trigger.getAttribute('aria-expanded'), 'false');

  controller.open('resume');
  await ui.resumes[0].emit('click');
  assert.deepEqual(calls.resume, ['codex-resume']);
  assert.equal(ui.resumes[0].disabled, false);

  controller.open('session');
  controller.close();
  assert.equal(ui.trigger.getAttribute('aria-expanded'), 'false');
  assert.ok(ui.trigger.focusCount >= 1);
  assert.equal(calls.close, 2);
});

test('workspace direct-open event resets a stale intent to session', () => {
  const ui = fixture();
  const controller = createLaunchCenterController({
    document: ui.document,
    openSessionModal() {},
    closeSessionModal() {},
    prepareGroupPanel() {},
    closeGroupPanel() {},
    resumeSession() {},
  });
  controller.selectIntent('resume', { focus: false });
  ui.view.emit('launch-center:session-opened');
  assert.equal(controller.getActiveIntent(), 'session');
  assert.equal(ui.trigger.getAttribute('aria-expanded'), 'true');
});
