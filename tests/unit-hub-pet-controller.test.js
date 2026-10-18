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
  show() { this.visible = true; }
  focus() { this.focused = true; }
  hide() { this.visible = false; }
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

function setup({ company = true, settings = null, now = () => new Date(2026, 9, 16, 10, 0).getTime(), screen: scr = screen } = {}) {
  FakeWindow.all = [];
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-pet-'));
  if (settings) fs.writeFileSync(path.join(dataDir, 'hub-pet.json'), JSON.stringify(settings));
  const ipcMain = new FakeIpc();
  const mainWc = new FakeWebContents();
  const mainWindow = { webContents: mainWc, isDestroyed: () => false };
  const sent = [];
  const bus = new NoticeBus({ now });
  const ctl = createHubPetController({
    BrowserWindow: FakeWindow, screen: scr, ipcMain, powerMonitor: { getSystemIdleTime: () => 0 }, app: { getAppMetrics: () => [] },
    htmlPath: 'pet.html', preloadPath: 'pet-preload.js', assetsDir: path.join(ROOT, 'renderer', 'assets', 'hub-pet'), dataDir,
    company, getMainWindow: () => mainWindow, focusPrimaryWindow: () => sent.push(['focus']), sendToRenderer: (ch, p) => sent.push([ch, p]),
    noticeBus: bus, debug: true, watchFullscreen: false, logger: { warn() {} }, now,
  });
  created.push(ctl);
  const petEvent = () => ({ sender: FakeWindow.all[0].webContents });
  // 右键菜单（2026-10-17 起是自绘的小窗）：返回菜单窗口里显示的内容，act() 模拟点了菜单里的一项。
  const menuWin = () => FakeWindow.all.find(w => w.options.title === 'AI Hub 桌宠菜单');
  const openMenu = async () => { ipcMain.emit('hub-pet:menu', petEvent()); await tick(); return menuWin().webContents.last('hub-pet-menu:state'); };
  const act = payload => ipcMain.emit('hub-pet-menu:act', { sender: menuWin().webContents }, payload);
  return { ctl, ipcMain, bus, sent, dataDir, mainWc, petEvent, openMenu, act, menuWin };
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
  const { ctl, bus, petEvent, ipcMain, openMenu, act } = setup();
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

  const menu = await openMenu();
  assert.equal(menu.quietHour, false, '右键菜单有「安静一小时」开关');
  act({ type: 'quietHour', value: true });
  bus.publish({ id: 'n2', kind: 'awaiting-reply', title: '组员 B 等你 14 小时了' });
  st = w.webContents.last('hub-pet:state');
  assert.equal(st.bubble, null);
  assert.equal(st.dots, 1);
  assert.equal(st.quiet, true);
  ctl.dispose();
});

test('右键菜单（自绘小窗）：6 件助理事项、说话频率、安静开关、已安装的形象；点事项打开助理页，换形象当场生效', async () => {
  const { ctl, ipcMain, petEvent, sent, openMenu, act, menuWin } = setup();
  ctl.start();
  await tick();
  const menu = await openMenu();
  const w = menuWin();
  assert.equal(w.options.transparent, true);
  assert.equal(w.options.frame, false);
  assert.equal(w.options.webPreferences.sandbox, true);
  assert.equal(w.visible, true, '右键后菜单显示');
  assert.deepEqual(menu.actions.map(a => a.label), ['今天的会', '下午会前准备', '谁在等我回', '汇总某个群', '未读邮件分拣', '起草周报']);
  assert.deepEqual(menu.modes.map(m => m.label), ['活泼', '温和', '安静']);
  assert.equal(menu.mode, 'gentle');
  assert.ok(menu.roles.some(r => r.id === '01-cat') && menu.roles.some(r => r.id === '03-penguin'), '列出已安装的形象');
  assert.ok(menu.roles.every(r => r.preview), '每个形象带预览图');
  assert.equal(menu.role.id, '01-cat');
  act({ type: 'mode', mode: 'lively' });
  assert.equal(w.webContents.last('hub-pet-menu:state').mode, 'lively', '换频率后菜单当场更新、不收起');
  assert.equal(w.visible, true);
  act({ type: 'action', action: 'awaiting-reply' });
  assert.equal(w.visible, false, '点事项后菜单收起');
  assert.deepEqual(sent.slice(-2)[0], ['focus']);
  assert.equal(sent.slice(-1)[0][0], 'hub-pet:open-assistant');
  assert.equal(sent.slice(-1)[0][1].action, 'awaiting-reply');
  ipcMain.emit('hub-pet:press', petEvent(), { target: 'pet' });
  ipcMain.emit('hub-pet:release', petEvent());
  assert.equal(sent.slice(-1)[0][0], 'hub-pet:open-assistant');
  assert.equal(sent.slice(-1)[0][1].source, 'pet');
  await openMenu();
  act({ type: 'role', role: '03-penguin' });
  assert.equal(FakeWindow.all[0].webContents.last('hub-pet:state').role, '03-penguin');
  act({ type: 'role', role: 'not-installed' });
  assert.equal(FakeWindow.all[0].webContents.last('hub-pet:state').role, '03-penguin', '没装的形象不认');
  act({ type: 'settings', tab: 'pet' });
  assert.equal(sent.slice(-1)[0][1].settingsTab, 'pet', '「桌宠设置…」打开助理设置的桌宠分页');
  // 只认菜单窗口自己发来的
  ipcMain.emit('hub-pet-menu:act', { sender: {} }, { type: 'hide' });
  assert.equal(ctl.getSettings().enabled, true);
  ctl.dispose();
  assert.equal(w.destroyed, true, '收起桌宠时菜单窗口一起销毁');
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

// 2026-10-18 田哥在公司 2.1.10 上反馈：双屏拖不到另一块屏；离屏幕边还有一段距离就像撞到空气墙；想要大小滑动条。
const wait = ms => new Promise(r => setTimeout(r, ms));
async function dragTo(ipcMain, petEvent, debug, mainWc, from, to) {
  await debug({ sender: mainWc }, { op: 'cursor', pos: from });
  ipcMain.emit('hub-pet:press', petEvent(), { target: 'pet' });
  for (let i = 1; i <= 6; i++) { await debug({ sender: mainWc }, { op: 'cursor', pos: { x: from.x + (to.x - from.x) * i / 6, y: from.y + (to.y - from.y) * i / 6 } }); await wait(40); }
  await wait(250); // 停一会儿再松手：不带速度，不滑行
  ipcMain.emit('hub-pet:release', petEvent());
  await wait(500);
}

test('双屏：能从主屏拖到右边那块屏，停在第二块屏上', async () => {
  const left = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
  const right = { workArea: { x: 1920, y: 0, width: 2560, height: 1400 } };
  const twoScreens = { getPrimaryDisplay: () => left, getDisplayNearestPoint: p => (p.x >= 1920 ? right : left), getCursorScreenPoint: () => ({ x: 0, y: 0 }) };
  const { ctl, ipcMain, petEvent, mainWc } = setup({ screen: twoScreens, settings: { enabled: true, position: { x: 1500, y: 700 } } });
  ctl.start();
  await tick();
  const w = FakeWindow.all[0];
  const debug = ipcMain.handlers.get('hub-pet:debug');
  const b = w.getBounds(), grab = { x: b.x + 140, y: b.y + b.height - 60 };
  await dragTo(ipcMain, petEvent, debug, mainWc, grab, { x: 2800, y: 900 });
  const after = w.getBounds();
  assert.ok(after.x > 1920, '宠物到了第二块屏：x=' + after.x);
  assert.equal(after.x, 2800 - 140, '跟着鼠标走，没被主屏右边挡住');
  assert.ok(after.y + after.height - 6 <= 1400, '在第二块屏里面');
});

test('贴边按看得见的身体算：量出图里的透明边后，身体正好贴到屏幕边，不再隔一段距离', async () => {
  const { ctl, ipcMain, petEvent, mainWc } = setup({ settings: { enabled: true, position: { x: 800, y: 700 } } });
  ctl.start();
  await tick();
  const w = FakeWindow.all[0];
  const debug = ipcMain.handlers.get('hub-pet:debug');
  let st = await debug({ sender: mainWc }, { op: 'state' });
  assert.deepEqual([st.inset.left, st.inset.right], [65, 65], '没量出来前和以前一样');
  // 小猫的实测透明边：左 15%、右 20%、脚下 14%（renderer 量出 idle.webp：320 宽里 minX 49、maxX 254、maxY 275）
  ipcMain.emit('hub-pet:body-box', petEvent(), { left: 49 / 320, right: 65 / 320, top: 0.1, bottom: 44 / 320 });
  st = await debug({ sender: mainWc }, { op: 'state' });
  assert.deepEqual([st.inset.left, st.inset.right], [65 + 23, 65 + 30]);
  const b = w.getBounds();
  await dragTo(ipcMain, petEvent, debug, mainWc, { x: b.x + 140, y: b.y + 300 }, { x: 4000, y: b.y + 300 });
  const after = w.getBounds();
  assert.equal(after.x + WIN_W - (65 + 30), 1920, '看得见的身体右边正好在屏幕右边');
  assert.equal((await debug({ sender: mainWc }, { op: 'state' })).dock, 'right');
  ipcMain.emit('hub-pet:body-box', petEvent(), { left: 3, right: -1, top: 0, bottom: 0 });
  st = await debug({ sender: mainWc }, { op: 'state' });
  assert.deepEqual([st.bodyBox.left, st.bodyBox.right], [0.45, 0], '奇怪的数被限住');
});

test('大小：0.6–1.6 倍连续调；放大时脚的位置不动、窗口往上长；贴着右边的继续贴着', async () => {
  const { ctl, ipcMain, mainWc, dataDir } = setup({ settings: { enabled: true, position: { x: 1920 - WIN_W + 65, y: 600 } } });
  ctl.start();
  await tick();
  const w = FakeWindow.all[0];
  const set = ipcMain.handlers.get('hub-pet:set-settings');
  const before = w.getBounds();
  assert.equal(before.height, WIN_H);
  await set({ sender: mainWc }, { scale: 1.6 });
  const big = w.getBounds();
  assert.equal(big.height, 190 + 240, '身体 240、上面照样留 190 给气泡');
  assert.equal(big.y + big.height, before.y + before.height, '脚的位置不动');
  assert.equal(big.x + WIN_W - (WIN_W - 240) / 2, 1920, '原来贴右边，放大后身体右边还在屏幕边');
  assert.equal(w.webContents.last('hub-pet:state').scale, 1.6, '告诉渲染端');
  await set({ sender: mainWc }, { scale: 0.83 });
  assert.equal(w.getBounds().height, WIN_H, '缩小时窗口不比原来矮（气泡要有地方）');
  assert.equal((await set({ sender: mainWc }, { scale: 5 })).settings.scale, 1.6, '超出范围按上限');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'hub-pet.json'), 'utf8')).scale, 1.6, '记住大小');
});
