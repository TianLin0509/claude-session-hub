'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createTeamToolsView } = require('../main/team-tools-view');
const { registerTeamWorkspaceIpc } = require('../main/ipc/team-workspace-handlers');
const { teamEnabled } = require('../core/team-workspace/catalog');
function rig() {
  let instance, requestPermission, checkPermission, attached = 0;
  const loads = [], changed = [];
  class View {
    constructor(options) {
      instance = this; this.options = options; this.webContents = new EventEmitter();
      Object.assign(this.webContents, { isDestroyed: () => false, loadURL: async url => { loads.push(url); this.url = url; }, getURL: () => this.url,
        setWindowOpenHandler: fn => { this.popup = fn; }, close: () => { this.closed = true; } });
    }
    setBounds(value) { this.rectangle = value; }
  }
  const win = { isDestroyed: () => false, getContentSize: () => [1200, 800], webContents: { getZoomFactor: () => 1.25, mainFrame: {} }, contentView: { addChildView() { attached += 1; }, removeChildView() { attached -= 1; } } };
  const view = createTeamToolsView({ getWindow: () => win, WebContentsView: View,
    session: { fromPartition: () => ({ setPermissionRequestHandler: fn => { requestPermission = fn; }, setPermissionCheckHandler: fn => { checkPermission = fn; } }) },
    catalog: [{ id: 'tools', name: 'Tools', url: 'https://tools.example.test/tools/' }], onChanged: s => changed.push(s) });
  return { view, win, loads, changed, get instance() { return instance; }, get attached() { return attached; }, permissions: () => { let yes; requestPermission(null, 'camera', value => { yes = value; }); return [yes, checkPermission()]; } };
}
test('team remote views are sandboxed and cannot navigate or pop out to unapproved origins', async () => {
  const r = rig(); await r.view.open({ id: 'tools', bounds: { x: 50, y: 100, width: 1000, height: 600 } });
  const prefs = r.instance.options.webPreferences;
  assert.equal(prefs.nodeIntegration, false); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.sandbox, true); assert.equal(prefs.preload, undefined);
  assert.deepEqual(r.permissions(), [false, false]);
  for (const target of ['file:///C:/private.txt', 'https://tools.example.test.evil.test/', 'https://a@tools.example.test/']) {
    let prevented = false;
    r.instance.webContents.emit('will-navigate', { preventDefault: () => { prevented = true; } }, target);
    assert.equal(prevented, true);
    assert.equal(r.instance.popup({ url: target }).action, 'deny');
  }
  assert.equal(r.loads.length, 1);
  let blocked = false;
  r.instance.webContents.emit('will-redirect', { preventDefault: () => { blocked = true; } }, 'https://evil.test/');
  assert.equal(blocked, true);
});
test('team view bounds account for zoom, hiding keeps a form alive and reopening does not reload', async () => {
  const r = rig(), req = { id: 'tools', bounds: { x: 50, y: 100, width: 1000, height: 600 } };
  await r.view.open(req); assert.deepEqual(r.instance.rectangle, { x: 63, y: 125, width: 1137, height: 675 });
  assert.equal(r.attached, 1); r.view.close(); assert.equal(r.attached, 0); assert.equal(r.instance.closed, undefined);
  await r.view.open(req); assert.equal(r.loads.length, 1); assert.equal(r.attached, 1);
  r.view.dispose(); assert.equal(r.instance.closed, true); assert.equal(r.attached, 0);
});
test('invalid catalog id or geometry cannot attach a view', async () => {
  const r = rig(); await assert.rejects(r.view.open({ id: 'tools', bounds: {} }), /网页区域/);
  await assert.rejects(r.view.open({ id: 'arbitrary', bounds: {} }), /入口/); assert.equal(r.attached, 0);
});
test('remote/subframe IPC cannot inspect or mutate private team state', async () => {
  const handlers = {}, r = rig(); let reads = 0;
  registerTeamWorkspaceIpc({ handle: (name, fn) => { handlers[name] = fn; } }, { getWindow: () => r.win, web: r.view, workspace: { state: () => { reads++; return { owner: 'self' }; }, execute: async () => ({ saved: true }) } });
  const wrong = await handlers['team:state']({ sender: {}, senderFrame: {} });
  assert.equal(wrong.ok, false); assert.equal(reads, 0);
  assert.equal((await handlers['team:state']({ sender: r.win.webContents, senderFrame: {} })).ok, false);
  const good = await handlers['team:state']({ sender: r.win.webContents, senderFrame: r.win.webContents.mainFrame });
  assert.equal(good.ok, false); assert.match(good.error, /未解锁/); assert.equal(reads, 0);
});
test('public edition does not show private team tools', () => {
  assert.equal(teamEnabled({}, { personalModules: false, target: null }), false);
  assert.equal(teamEnabled({}, { personalModules: false, target: 'company', featureEnabled: () => true }), true);
});
