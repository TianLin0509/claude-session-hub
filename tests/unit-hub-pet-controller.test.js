'use strict';
// 桌宠主进程控制器：窗口属性、默认开关、提醒 → 欢呼与气泡、安静模式、右键菜单、点击打开助理、设置读写、接线。
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createHubPetController, WIN_W, WIN_H } = require('../main/hub-pet-controller.js');
const { NoticeBus } = require('../core/company-assistant/notice-bus.js');

const ROOT = path.join(__dirname, '..');

class FakeWebContents extends EventEmitter {
  constructor() { super(); this.messages = []; }
  send(channel, payload) { this.messages.push([channel, payload]); }
  setWindowOpenHandler() {}
  getOSProcessId() { return 4242; }
  last(channel) { for (let i = this.messages.length - 1; i >= 0; i--) if (this.messages[i][0] === channel) return this.messages[i][1]; return null; }
}
class FakeWindow extends EventEmitter {
  constructor(options) { super(); this.options = options; this.webContents = new FakeWebContents(); this.destroyed = false; this.visible = false; this.bounds = { x: 0, y: 0, width: options.width, height: options.height }; FakeWindow.all.push(this); }
  loadFile(file) { this.file = file; queueMicrotask(() => this.webContents.emit('did-finish-load')); return Promise.resolve(); }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; this.emit('closed'); }
  setAlwaysOnTop(...a) { this.top = a; }
  setMenuBarVisibility() {}
  setIgnoreMouseEvents(v, o) { this.ignore = [v, o]; }
  setBounds(b) { this.bounds = { ...b }; }
  getBounds() { return { ...this.bounds }; }
  showInactive() { this.visible = true; }
  isVisible() { return this.visible; }
}
FakeWindow.all = [];
const created = [];
test.afterEach(() => { while (created.length) created.pop().dispose(); });

class FakeIpc extends EventEmitter {
  constructor() { super(); this.handlers = new Map(); }
  handle(ch, fn) { this.handlers.set(ch, fn); }
  removeHandler(ch) { this.handlers.delete(ch); }
}

const display = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const screen = { getPrimaryDisplay: () => display, getDisplayNearestPoint: () => display, getCursorScreenPoint: () => ({ x: 900, y: 900 }) };

function setup({ company = true, settings = null, now = () => new Date(2026, 9, 16, 10, 0).getTime() } = {}) {
  FakeWindow.all = [];
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-pet-'));
  if (settings) fs.writeFileSync(path.join(dataDir, 'hub-pet.json'), JSON.stringify(settings));
  const ipcMain = new FakeIpc();
  const mainWc = new FakeWebContents();
  const mainWindow = { webContents: mainWc, isDestroyed: () => false };
  const sent = [];
  let menu = null;
  const bus = new NoticeBus({ now });
  const ctl = createHubPetController({
    BrowserWindow: FakeWindow, screen, ipcMain, powerMonitor: { getSystemIdleTime: () => 0 }, app: { getAppMetrics: () => [] },
    Menu: { buildFromTemplate: t => ({ popup: () => { menu = t; } }) },
    htmlPath: 'pet.html', preloadPath: 'pet-preload.js', assetsDir: path.join(ROOT, 'renderer', 'assets', 'hub-pet'), dataDir,
    company, getMainWindow: () => mainWindow, focusPrimaryWindow: () => sent.push(['focus']), sendToRenderer: (ch, p) => sent.push([ch, p]),
    noticeBus: bus, debug: true, watchFullscreen: false, logger: { warn() {} }, now,
  });
  created.push(ctl);
  const petEvent = () => ({ sender: FakeWindow.all[0].webContents });
  return { ctl, ipcMain, bus, sent, dataDir, mainWc, petEvent, getMenu: () => menu };
}
const tick = () => new Promise(r => setImmediate(r));

test('公司版默认开、家里版默认关；窗口透明无边框置顶不进任务栏，点穿透明处', async () => {
  const home = setup({ company: false });
  assert.equal(home.ctl.start(), false);
  assert.equal(FakeWindow.all.length, 0);
  home.ctl.dispose();

  const { ctl } = setup({ company: true });
  assert.equal(ctl.start(), true);
  await tick();
  const w = FakeWindow.all[0];
  assert.equal(w.options.transparent, true);
  assert.equal(w.options.frame, false);
  assert.equal(w.options.skipTaskbar, true);
  assert.equal(w.options.alwaysOnTop, true);
  assert.equal(w.options.webPreferences.sandbox, true);
  assert.deepEqual(w.ignore, [true, { forward: true }]);
  assert.equal(w.bounds.width, WIN_W);
  assert.equal(w.bounds.height, WIN_H);
  assert.ok(w.bounds.x + WIN_W - 65 <= 1920, '默认在主屏右下角，身体不出屏');
  assert.equal(w.visible, true);
  assert.equal(w.webContents.last('hub-pet:state').pose, 'idle');
  assert.deepEqual(w.webContents.last('hub-pet:state').sequences, ['typing', 'idle-life', 'dock-right', 'stretch']);
  ctl.dispose();
});

test('新提醒：欢呼 + 气泡说标题；点气泡展开正文；安静一小时只亮小圆点', async () => {
  const { ctl, bus, petEvent, ipcMain, getMenu } = setup();
  ctl.start();
  await tick();
  const w = FakeWindow.all[0];
  bus.publish({ id: 'n1', kind: 'meeting-prep', title: '14:00 的评审准备卡好了', text: '材料 v3 新增第 4 章' });
  let st = w.webContents.last('hub-pet:state');
  assert.equal(st.pose, 'happy');
  assert.equal(st.bubble.title, '14:00 的评审准备卡好了');
  ipcMain.emit('hub-pet:press', petEvent(), { target: 'bubble' });
  ipcMain.emit('hub-pet:release', petEvent());
  assert.equal(w.webContents.last('hub-pet:panel').items[0].text, '材料 v3 新增第 4 章');
  st = w.webContents.last('hub-pet:state');
  assert.equal(st.bubble, null);
  assert.notEqual(st.pose, 'happy');

  ipcMain.emit('hub-pet:menu', petEvent());
  const quiet = getMenu().find(i => i.label === '安静一小时');
  assert.ok(quiet, '右键菜单有「安静一小时」');
  quiet.click();
  bus.publish({ id: 'n2', kind: 'awaiting-reply', title: '组员 B 等你 14 小时了' });
  st = w.webContents.last('hub-pet:state');
  assert.equal(st.bubble, null);
  assert.equal(st.dots, 1);
  assert.equal(st.quiet, true);
  ctl.dispose();
});

test('右键菜单包含 6 件助理事项和各项开关；点事项、点宠物都打开助理页', async () => {
  const { ctl, ipcMain, petEvent, getMenu, sent } = setup();
  ctl.start();
  await tick();
  ipcMain.emit('hub-pet:menu', petEvent());
  const labels = getMenu().filter(i => i.label).map(i => i.label);
  for (const l of ['今天的会', '下午会前准备', '谁在等我回', '汇总某个群', '未读邮件分拣', '起草周报', '安静一小时', '今天别说话', '说话频率', '换角色']) assert.ok(labels.includes(l), '缺少菜单项 ' + l);
  getMenu().find(i => i.label === '谁在等我回').click();
  assert.deepEqual(sent.slice(-2)[0], ['focus']);
  assert.equal(sent.slice(-1)[0][0], 'hub-pet:open-assistant');
  assert.equal(sent.slice(-1)[0][1].action, 'awaiting-reply');
  ipcMain.emit('hub-pet:press', petEvent(), { target: 'pet' });
  ipcMain.emit('hub-pet:release', petEvent());
  assert.equal(sent.slice(-1)[0][0], 'hub-pet:open-assistant');
  assert.equal(sent.slice(-1)[0][1].source, 'pet');
  getMenu().find(i => i.label === '换角色').submenu.find(r => r.label === '企鹅').click();
  assert.equal(FakeWindow.all[0].webContents.last('hub-pet:state').role, '03-penguin');
  ctl.dispose();
});

test('设置：只认主窗口；关掉销毁窗口并写盘，再打开恢复', async () => {
  const { ctl, ipcMain, mainWc, dataDir } = setup();
  ctl.start();
  await tick();
  const set = ipcMain.handlers.get('hub-pet:set-settings');
  assert.equal(await set({ sender: {} }, { enabled: false }), null, '其他页面不能改');
  const res = await set({ sender: mainWc }, { enabled: false, mode: 'lively', role: 'nope' });
  assert.equal(res.settings.enabled, false);
  assert.equal(res.settings.mode, 'lively');
  assert.equal(res.settings.role, '01-cat');
  assert.equal(FakeWindow.all[0].destroyed, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'hub-pet.json'), 'utf8')).enabled, false);
  await set({ sender: mainWc }, { enabled: true });
  await tick();
  assert.equal(FakeWindow.all.length, 2);
  assert.equal(FakeWindow.all[1].destroyed, false);
  ctl.dispose();
  assert.equal(ipcMain.handlers.size, 0);
  assert.equal(ipcMain.listenerCount('hub-pet:press'), 0);
});

test('全屏时躲到屏幕右边只露一部分，结束后回原位', async () => {
  const { ctl, ipcMain, mainWc } = setup();
  ctl.start();
  await tick();
  const w = FakeWindow.all[0];
  const before = w.getBounds();
  const debug = ipcMain.handlers.get('hub-pet:debug');
  await debug({ sender: mainWc }, { op: 'override', fullscreen: true });
  await new Promise(r => setTimeout(r, 520));
  assert.equal(w.webContents.last('hub-pet:state').pose, 'peek');
  const visibleBody = 1920 - (w.getBounds().x + 65);
  assert.ok(visibleBody > 40 && visibleBody < 90, '露出约 42% 的身体，实际 ' + visibleBody);
  await debug({ sender: mainWc }, { op: 'override', fullscreen: false });
  await new Promise(r => setTimeout(r, 520));
  assert.equal(w.getBounds().x, before.x);
  assert.equal(w.getBounds().y, before.y);
  ctl.dispose();
});

test('接线：main.js 创建并在退出时释放；配置页挂载；渲染端不可见时停帧', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  assert.match(main, /createHubPetController\(/);
  assert.match(main, /capture\('hub-pet', \(\) => hubPetController\?\.dispose\(\)\)/);
  assert.match(main, /featureEnabled\('hubPet'\)/);
  const renderer = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
  assert.match(renderer, /mountHubPetSettings\(/);
  const pet = fs.readFileSync(path.join(ROOT, 'renderer', 'hub-pet', 'pet.js'), 'utf8');
  assert.match(pet, /visibilitychange/);
  assert.match(pet, /cancelAnimationFrame/);
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'renderer', 'assets', 'hub-pet', 'manifest.json'), 'utf8'));
  for (const [role, info] of Object.entries(manifest)) {
    for (const p of info.poses) assert.ok(fs.existsSync(path.join(ROOT, 'renderer', 'assets', 'hub-pet', role, p + '.webp')), role + '/' + p);
    for (const s of info.sequences) assert.ok(fs.existsSync(path.join(ROOT, 'renderer', 'assets', 'hub-pet', role, 'seq-' + s + '.webp')), role + '/seq-' + s);
  }
});
