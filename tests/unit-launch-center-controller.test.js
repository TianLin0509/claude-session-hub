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
  emit(type, detail) { for (const handler of (this.listeners.get(type) || [])) handler({ type, detail }); }
}

function fixture() {
  const menu = new FakeElement();
  const trigger = new FakeElement();
  const label = new FakeElement();
  trigger.querySelector = () => label;
  const more = new FakeElement();
  const status = new FakeElement();
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
    'btn-new-more': more,
    'launch-split-status': status,
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
  return { document, view, menu, trigger, label, more, status, subtitle, error, groupError, resumeCancel, intents, panels, resumes };
}

test('launch intents normalize to the three supported routes', () => {
  assert.deepEqual(LAUNCH_INTENTS, ['session', 'group', 'resume']);
  assert.equal(normalizeLaunchIntent('group'), 'group');
  assert.equal(normalizeLaunchIntent('unknown'), 'session');
});

const lastLaunch = () => ({
  kind: 'codex', model: 'test-model', effort: 'high', mcpProfile: 'none',
  codexSpeedTier: 'inherit', workspace: { path: 'C:\\AIWork', label: 'AIWork', draft: false }, ts: 123,
});

function launchFixture(initial = null, overrides = {}) {
  const ui = fixture();
  let stored = initial;
  const calls = { open: [], create: [] };
  const storage = { getItem: () => stored, setItem: (_key, value) => { stored = value; } };
  const workspaceController = {
    loadModelCatalog: async () => ({}),
    resolveSessionTuning: (_kind, model, selection) => ({
      ...selection, model, modelOptions: [{ id: model }], showEffort: true, showMcp: true, showFast: false, showCodexTier: true,
    }),
    buildSessionTuningOpts: (_kind, model, selection) => ({ model, effort: selection.effort, mcpProfile: selection.mcpProfile }),
    createSession: async (kind, options) => { calls.create.push({ kind, options }); return { id: 'second' }; },
  };
  const controller = createLaunchCenterController({
    document: ui.document, storage, getWorkspaceController: () => workspaceController,
    isDirectory: async () => true,
    openSessionModal: options => { calls.open.push(options); ui.menu.style.display = 'flex'; },
    closeSessionModal: () => { ui.menu.style.display = 'none'; },
    ...overrides,
  });
  return { ...ui, controller, calls, workspaceController, storage, stored: () => stored, remove: () => { stored = null; } };
}

test('successful center notification remembers a snapshot; open, cancel, group and resume do not overwrite it', () => {
  const ui = launchFixture();
  const record = lastLaunch();
  ui.view.emit('launch-center:session-created', { sessionId: 'first', launch: record });
  record.workspace.label = 'changed later';
  assert.equal(JSON.parse(ui.stored()).workspace.label, 'AIWork');
  assert.equal(ui.label.textContent, '启动');
  assert.equal(ui.trigger.title, '打开启动中心 (Ctrl+N)');
  assert.equal(ui.trigger.getAttribute('aria-haspopup'), 'dialog');
  const stored = ui.stored();
  ui.controller.open('group'); ui.controller.close(); ui.controller.open('resume'); ui.controller.close();
  ui.view.emit('launch-center:session-created', { launch: lastLaunch() });
  assert.equal(ui.stored(), stored);
});

test('last launch reuses the existing create function without opening center and preserves inherit', async () => {
  const ui = launchFixture(JSON.stringify(lastLaunch()));
  const session = await ui.controller.launchLast();
  assert.equal(session.id, 'second');
  assert.equal(ui.calls.open.length, 0);
  assert.deepEqual(ui.calls.create, [{ kind: 'codex', options: { workspace: lastLaunch().workspace, opts: { model: 'test-model', effort: 'high', mcpProfile: 'none' } } }]);
  assert.equal(JSON.parse(ui.stored()).codexSpeedTier, 'inherit');
  assert.equal(ui.trigger.disabled, false);
});

test('no history, removed history and malformed records open center without creating', async () => {
  for (const value of [null, '{broken', '{}', JSON.stringify({ ...lastLaunch(), kind: 'codex-resume' }), JSON.stringify({ ...lastLaunch(), workspace: { path: 'relative' } })]) {
    const ui = launchFixture(value);
    await ui.controller.launchLast();
    assert.equal(ui.calls.create.length, 0);
    assert.equal(ui.calls.open.length, 1);
    assert.equal(ui.label.textContent, '启动');
  }
  const ui = launchFixture(JSON.stringify(lastLaunch()));
  ui.remove();
  await ui.controller.launchLast();
  assert.equal(ui.calls.create.length, 0);
  assert.equal(ui.label.textContent, '启动');
});

test('missing directory falls back with original workspace and preserves history', async () => {
  const original = JSON.stringify(lastLaunch());
  const ui = launchFixture(original, { isDirectory: async () => false });
  await ui.controller.launchLast();
  assert.equal(ui.calls.create.length, 0);
  assert.deepEqual(ui.calls.open[0].workspace, lastLaunch().workspace);
  assert.match(ui.status.textContent, /工作区/);
  assert.equal(ui.stored(), original);
});

test('unsupported model/effort or missing tuning field falls back without silent substitution', async () => {
  for (const field of ['model', 'effort', 'mcpProfile', 'codexSpeedTier']) {
    const ui = launchFixture(JSON.stringify(lastLaunch()));
    const resolve = ui.workspaceController.resolveSessionTuning;
    ui.workspaceController.resolveSessionTuning = (...args) => ({ ...resolve(...args), [field]: 'replacement' });
    await ui.controller.launchLast();
    assert.equal(ui.calls.create.length, 0, field);
    assert.match(ui.status.textContent, /配置/);
  }
  const incomplete = lastLaunch(); delete incomplete.mcpProfile;
  const ui = launchFixture(JSON.stringify(incomplete));
  await ui.controller.launchLast();
  assert.equal(ui.calls.create.length, 0);
});

test('busy gate covers asynchronous validation and failed creation never overwrites history', async () => {
  let release;
  const original = JSON.stringify(lastLaunch());
  const ui = launchFixture(original, { isDirectory: () => new Promise(resolve => { release = resolve; }) });
  const pending = ui.controller.launchLast();
  assert.equal(ui.trigger.disabled, true);
  await ui.controller.launchLast();
  ui.workspaceController.createSession = async () => { throw new Error('creation rejected'); };
  release(true); await pending;
  assert.equal(ui.calls.open.length, 1);
  assert.match(ui.status.textContent, /creation rejected/);
  assert.equal(ui.stored(), original);
  assert.equal(ui.trigger.disabled, false);
});

test('storage write failure reports successful creation without retrying or opening center', async () => {
  const ui = launchFixture(JSON.stringify(lastLaunch()));
  ui.storage.setItem = () => { throw new Error('quota'); };
  assert.equal((await ui.controller.launchLast()).id, 'second');
  assert.equal(ui.calls.create.length, 1);
  assert.equal(ui.calls.open.length, 0);
  assert.match(ui.status.textContent, /会话已创建.*记忆未保存/);
});

test('storage read failure and inaccessible workspace stay recoverable', async () => {
  const ui = launchFixture();
  ui.storage.getItem = () => { throw new Error('storage denied'); };
  await ui.controller.launchLast();
  assert.equal(ui.calls.create.length, 0);
  assert.equal(ui.calls.open.length, 1);
  assert.match(ui.status.textContent, /记忆不可用/);
  const denied = launchFixture(JSON.stringify(lastLaunch()), { isDirectory: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } });
  await denied.controller.launchLast();
  assert.match(denied.status.textContent, /访问权限/);
  assert.equal(denied.calls.create.length, 0);
});

test('unavailable catalog and empty creation response cannot report success', async () => {
  const original = JSON.stringify(lastLaunch());
  const ui = launchFixture(original);
  ui.workspaceController.loadModelCatalog = async () => ({ ok: false });
  await ui.controller.launchLast();
  assert.equal(ui.calls.create.length, 0);
  assert.equal(ui.stored(), original);
  const empty = launchFixture(original);
  empty.workspaceController.createSession = async () => null;
  await empty.controller.launchLast();
  assert.match(empty.status.textContent, /有效会话/);
  assert.equal(empty.stored(), original);
});

test('late fallback prefill cannot overwrite user edits or a reopened center', async () => {
  const ui = launchFixture(JSON.stringify(lastLaunch()), { isDirectory: async () => false });
  let resolveCatalog;
  ui.workspaceController.loadModelCatalog = () => new Promise(resolve => { resolveCatalog = resolve; });
  const pending = ui.controller.launchLast();
  await new Promise(resolve => setImmediate(resolve));
  await ui.menu.emit('pointerdown');
  // If stale prefill continues, any input lookup would throw here.
  const get = ui.document.getElementById;
  ui.document.getElementById = id => {
    if (id.startsWith('new-session-') && id !== 'new-session-error') throw new Error('stale prefill');
    return get(id);
  };
  resolveCatalog({}); await pending;
  assert.doesNotMatch(ui.status.textContent, /stale prefill/);
  assert.equal(ui.trigger.disabled, false);
});

test('Claude false Fast choice survives success snapshot and direct launch', async () => {
  const record = { ...lastLaunch(), kind: 'claude', fastMode: false };
  delete record.codexSpeedTier;
  const ui = launchFixture(JSON.stringify(record));
  ui.workspaceController.resolveSessionTuning = (_kind, model, selection) => ({ ...selection, model, modelOptions: [{ id: model }], showEffort: true, showMcp: true, showFast: true, showCodexTier: false });
  ui.workspaceController.buildSessionTuningOpts = (_kind, model, selection) => ({ model, fastMode: selection.fastMode });
  await ui.controller.launchLast();
  assert.equal(ui.calls.create[0].options.opts.fastMode, false);
  assert.equal(JSON.parse(ui.stored()).fastMode, false);
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
