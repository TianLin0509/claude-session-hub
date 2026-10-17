'use strict';
// 记住的形象没装时后台补下载（2026-10-18）：2.1.8 选了兔子的用户升级到只带小猫、企鹅的版本后，
// 启动即用设置页同一条校验下载路径补装并换上；下载失败只说一次温和提示，点开去「助理 → 设置 → 桌宠」。
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createHubPetController } = require('../main/hub-pet-controller.js');
const { NoticeBus } = require('../core/company-assistant/notice-bus.js');
const { buildPacks } = require('../scripts/build-hub-pet-packs.js');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'renderer', 'assets', 'hub-pet');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hub-pet-auto-'));

class FakeWebContents extends EventEmitter {
  constructor() { super(); this.messages = []; }
  send(channel, payload) { this.messages.push([channel, payload]); }
  setWindowOpenHandler() {}
  last(channel) { for (let i = this.messages.length - 1; i >= 0; i--) if (this.messages[i][0] === channel) return this.messages[i][1]; return null; }
}
class FakeWindow extends EventEmitter {
  constructor(options) { super(); this.options = options; this.webContents = new FakeWebContents(); this.destroyed = false; this.visible = false; this.bounds = { x: 0, y: 0, width: options.width, height: options.height }; FakeWindow.all.push(this); }
  loadFile() { queueMicrotask(() => this.webContents.emit('did-finish-load')); return Promise.resolve(); }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; this.emit('closed'); }
  setAlwaysOnTop() {} setMenuBarVisibility() {} setIgnoreMouseEvents() {}
  setBounds(b) { this.bounds = { ...b }; }
  getBounds() { return { ...this.bounds }; }
  showInactive() { this.visible = true; } show() { this.visible = true; } focus() {} hide() { this.visible = false; }
  isVisible() { return this.visible; }
}
FakeWindow.all = [];
class FakeIpc extends EventEmitter {
  constructor() { super(); this.handlers = new Map(); }
  handle(ch, fn) { this.handlers.set(ch, fn); }
  removeHandler(ch) { this.handlers.delete(ch); }
}
const display = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const screen = { getPrimaryDisplay: () => display, getDisplayNearestPoint: () => display, getCursorScreenPoint: () => ({ x: 900, y: 900 }) };

// 只带小猫、企鹅的公司版资产。
function companyAssets() {
  const dir = tmp();
  fs.copyFileSync(path.join(ASSETS, 'manifest.json'), path.join(dir, 'manifest.json'));
  for (const id of ['01-cat', '03-penguin', 'thumbs']) fs.cpSync(path.join(ASSETS, id), path.join(dir, id), { recursive: true });
  return dir;
}
const packDir = (() => { let dir = null; return () => { if (!dir) { dir = tmp(); buildPacks({ assetsDir: ASSETS, out: dir, ids: ['05-rabbit', '07-shiba'] }); } return dir; }; })();
function fakeFetch(dir, { fail = false, requests = [], delayMs = 0 } = {}) {
  return async url => {
    requests.push(String(url));
    if (delayMs) await new Promise(r => setTimeout(r, delayMs));
    if (fail) throw new Error('getaddrinfo ENOTFOUND pets.test');
    const file = path.join(dir, decodeURIComponent(String(url).split('/').pop()));
    if (!fs.existsSync(file)) return new Response('not found', { status: 404 });
    const body = fs.readFileSync(file);
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(body.length) } });
  };
}
const SOURCES = [{ id: 'local', name: '本地', manifest: 'http://pets.test/catalog.json', files: 'http://pets.test/' }];
const created = [];
test.afterEach(() => { while (created.length) created.pop().dispose(); });

function setup({ settings, fail = false, enabled = true, delayMs = 0 } = {}) {
  FakeWindow.all = [];
  const dataDir = tmp();
  fs.writeFileSync(path.join(dataDir, 'hub-pet.json'), JSON.stringify({ enabled, mode: 'gentle', ...settings }));
  const ipcMain = new FakeIpc();
  const mainWindow = { webContents: new FakeWebContents(), isDestroyed: () => false };
  const sent = [];
  const requests = [];
  const now = () => new Date(2026, 9, 18, 10, 0).getTime();
  const ctl = createHubPetController({
    BrowserWindow: FakeWindow, screen, ipcMain, powerMonitor: { getSystemIdleTime: () => 0 }, app: { getAppMetrics: () => [] },
    htmlPath: 'pet.html', preloadPath: 'pet-preload.js', assetsDir: companyAssets(), dataDir, company: true,
    getMainWindow: () => mainWindow, focusPrimaryWindow: () => sent.push(['focus']), sendToRenderer: (ch, p) => sent.push([ch, p]),
    noticeBus: new NoticeBus({ now }), debug: true, watchFullscreen: false, logger: { warn() {}, info() {} }, now,
    fetchImpl: fakeFetch(packDir(), { fail, requests, delayMs }), roleSources: SOURCES, autoRoleDelayMs: 5,
  });
  created.push(ctl);
  const pet = () => FakeWindow.all.find(w => w.options.title === 'AI Hub 桌宠');
  return { ctl, ipcMain, sent, requests, dataDir, pet };
}
const waitFor = async (fn, ms = 5000) => { const until = Date.now() + ms; while (Date.now() < until) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 10)); } throw new Error('timeout'); };
const tick = () => new Promise(r => setImmediate(r));

test('升级后记着兔子但没装：先用小猫，启动后台下载装好就换成兔子，设置一直记着兔子', async () => {
  const h = setup({ settings: { role: '05-rabbit' } });
  assert.equal(h.ctl.getSettings().role, '05-rabbit', '记忆不被改成小猫');
  h.ctl.start();
  await tick();
  const firstState = h.pet().webContents.messages.find(([ch]) => ch === 'hub-pet:state');
  assert.equal(firstState && firstState[1].role, '01-cat', '没装时先用小猫');
  // 下载前任何一次别的设置写盘都不能把记忆改掉。
  h.ctl.setSettings({ mode: 'quiet' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.dataDir, 'hub-pet.json'), 'utf8')).role, '05-rabbit');
  const auto = await waitFor(() => { const a = h.ctl._autoRole(); return a.phase === 'installed' ? a : null; });
  assert.equal(auto.id, '05-rabbit');
  assert.ok(h.requests.some(u => /catalog\.json$/.test(u)) && h.requests.some(u => /05-rabbit-1\.0\.0\.json$/.test(u)), '走目录 + 包的校验下载');
  assert.ok(fs.existsSync(path.join(h.dataDir, 'hub-pet', 'roles', '05-rabbit', 'idle.webp')), '装进数据目录');
  const state = h.pet().webContents.last('hub-pet:state');
  assert.equal(state.role, '05-rabbit', '装好当场换上');
  assert.match(state.assetBase, /^file:.*hub-pet\/roles\/05-rabbit\/$/);
  const changed = h.sent.filter(([ch]) => ch === 'hub-pet:settings-changed').pop();
  assert.equal(changed && changed[1].settings.role, '05-rabbit', '设置页同步');
  assert.equal(h.ctl._speech.snapshot().bubble, null, '成功不打扰');
  assert.equal(h.ctl._speech.snapshot().dots, 0);
});

test('下载失败：只说一次温和提示，点开去「助理 → 设置 → 桌宠」；仍记着兔子，下次启动再试', async () => {
  const h = setup({ settings: { role: '05-rabbit' }, fail: true });
  h.ctl.start();
  const auto = await waitFor(() => { const a = h.ctl._autoRole(); return a.phase === 'failed' ? a : null; });
  assert.equal(auto.id, '05-rabbit');
  const bubble = h.ctl._speech.snapshot().bubble;
  assert.ok(bubble, '有一个气泡');
  assert.match(bubble.title, /兔子还没下载下来/);
  assert.equal(h.pet().webContents.last('hub-pet:state').role, '01-cat');
  // 同一次启动里再触发也不重复提示、不再联网。
  const before = h.requests.length;
  await h.ctl._restoreRememberedRole();
  assert.equal(h.requests.length, before);
  h.ctl._speech.tick(() => ({ ok: true }));
  assert.equal(h.ctl._speech.snapshot().dots + (h.ctl._speech.snapshot().bubble ? 1 : 0), 1, '只有一条');
  // 点「在助理里打开」→ 打开助理设置的桌宠分页。
  h.ipcMain.emit('hub-pet:open-notice', { sender: h.pet().webContents }, { id: bubble.id });
  const open = h.sent.filter(([ch]) => ch === 'hub-pet:open-assistant').pop();
  assert.equal(open[1].settingsTab, 'pet');
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.dataDir, 'hub-pet.json'), 'utf8')).role, '05-rabbit', '记忆保留，下次启动再试');
});

test('不需要时不联网：装着的形象、桌宠关着、记着的是未知形象', async () => {
  for (const [settings, enabled] of [[{ role: '03-penguin' }, true], [{ role: '05-rabbit' }, false], [{ role: '99-dragon' }, true]]) {
    const h = setup({ settings, enabled });
    h.ctl.start();
    await new Promise(r => setTimeout(r, 40));
    assert.equal(h.requests.length, 0, JSON.stringify(settings));
    assert.equal(h.ctl._autoRole().phase, 'idle');
  }
});

test('用户在下载完成前换了别的形象：失败也不提示；还没开始下载就换了则根本不联网', async () => {
  const h = setup({ settings: { role: '07-shiba' }, fail: true, delayMs: 120 });
  h.ctl.start();
  await waitFor(() => h.ctl._autoRole().phase === 'downloading' || null);
  h.ctl.setSettings({ role: '03-penguin' });
  await waitFor(() => h.ctl._autoRole().phase === 'failed' || null);
  assert.equal(h.ctl._speech.snapshot().bubble, null);
  assert.equal(h.ctl.getSettings().role, '03-penguin');
});

test('启动后、开始下载前就换成已装的形象：不联网', async () => {
  const h = setup({ settings: { role: '07-shiba' } });
  h.ctl.start();
  h.ctl.setSettings({ role: '03-penguin' });
  await new Promise(r => setTimeout(r, 40));
  assert.equal(h.requests.length, 0);
  assert.equal(h.ctl._autoRole().phase, 'idle');
});
