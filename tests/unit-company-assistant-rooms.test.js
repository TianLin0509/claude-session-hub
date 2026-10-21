'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { CompanyAssistant } = require('../core/company-assistant/service');
const component = require('../core/company-assistant/room-component');
function rig(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-room-unit-'));
  const now = new Date(2026, 9, 20, 11, 40).getTime();
  const a = new CompanyAssistant({ dataDir: root, noTimer: true, noTools: true, roomHome: root, now: () => now });
  t.after(() => a.close());
  return { a, root, now };
}
test('已在秘书原界面停止的守护不会被 Hub 自动重启', async t => {
  const { a, root, now } = rig(t);
  a.setSettings({ rooms: { enabled: true } });
  fs.mkdirSync(path.join(root, 'hub-control'));
  fs.writeFileSync(path.join(root, 'hub-control', 'status.json'), JSON.stringify({ protocol: 1, at: now, running: false }));
  let starts = 0; a.rooms.command = async () => { starts++; };
  await a.rooms.tick();
  assert.equal(starts, 0); assert.equal(a.settings().rooms.enabled, false);
});
test('累计超过30条新历史保留最新结果；重扫不重复推送', async t => {
  const { a, root } = rig(t);
  a.saveState({ roomSeen: [] });
  const history = Array.from({ length: 31 }, (_, i) => ({ 日期: '2026-10-27', 时间: '14:00', 状态: '成功', 会议室: 'R' + i, 时间戳: i }));
  fs.writeFileSync(path.join(root, 'booking_history.json'), JSON.stringify(history));
  const sent = []; a.phone.active = () => true; a.phone.send = async text => { sent.push(text); return true; };
  await a.rooms.tick();
  assert.equal(a.state().roomEvents.length, 30); assert.equal(a.state().roomEvents[0].record.会议室, 'R30');
  await a.rooms.tick();
  assert.equal(new Set(sent).size, sent.length); assert.equal(a.state().roomEvents[0].record.会议室, 'R30');
  await assert.rejects(a.rooms.command('configure', { date: 'tomorrow' }), /不支持指定明天/);
});
test('组件只接受现有发布公钥的签名，篡改清单被拒绝', t => {
  const { root } = rig(t), file = path.resolve(__dirname, '../core/company-assistant/room-component/control.json');
  const m = component.manifest(file); assert.equal(m.version, '2.1.1');
  assert.equal(component.verified(path.join(path.dirname(file), m.code.file), m.code), true);
  const modified = JSON.parse(fs.readFileSync(file, 'utf8')); modified.code.sha256 = 'a'.repeat(64);
  const altered = path.join(root, 'altered.json'); fs.writeFileSync(altered, JSON.stringify(modified));
  assert.throws(() => component.manifest(altered), /签名不正确/);
});
test('组件已回退或累计三次启动失败时，不会清零恢复计数', async t => {
  const { a, root } = rig(t), m = component.manifest(path.resolve(__dirname, '../core/company-assistant/room-component/control.json'));
  fs.mkdirSync(path.join(root, 'updates'));
  const file = path.join(root, 'updates', 'current.json');
  for (const failure of [{ bad: true, boots: 0 }, { bad: false, boots: 3 }]) {
    const before = JSON.stringify({ version: m.version, sha256: m.code.sha256, ...failure });
    fs.writeFileSync(file, before);
    await assert.rejects(component.stage(a, 'must-not-execute.exe', root), /已回退/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
});
const { EventEmitter } = require('node:events');
const { slotText } = require('../core/company-assistant/rooms');
function fakeChild({ exitWith, write } = {}) {
  return (exe, args, opts) => {
    const child = new EventEmitter(); child.pid = 4242; child.exitCode = null; child.opts = opts; child.args = args;
    fakeChild.last = child;
    if (exitWith !== undefined) setImmediate(() => { if (write) fs.writeFileSync(args[1], JSON.stringify(write)); child.exitCode = exitWith; child.emit('exit', exitWith); });
    return child;
  };
}
test('版本探测：超时 120 秒，超时只按 PID 结束自己起的那棵树，探测临时目录用完即删', async t => {
  const { a } = rig(t);
  assert.equal(component.PROBE_TIMEOUT_MS, 120000);
  const killed = [];
  await assert.rejects(component.probe(a, 'fixture.exe', { spawnFn: fakeChild(), timeoutMs: 30, kill: async c => { killed.push(c.pid); } }), /秒内没有回报版本/);
  assert.deepEqual(killed, [4242]);
  assert.equal(fakeChild.last.opts.env.MSZ_HOME.includes('mishu-probe-'), true);
  assert.deepEqual(fs.readdirSync(a.dir).filter(f => f.startsWith('mishu-probe-')), []);
  const info = await component.probe(a, 'fixture.exe', { spawnFn: fakeChild({ exitWith: 0, write: { exe_shell: 1, exe_version: '2.1.0' } }), kill: async () => { throw Error('normal exit must not kill by PID'); } });
  assert.equal(info.exe_version, '2.1.0');
  assert.deepEqual(fs.readdirSync(a.dir).filter(f => f.startsWith('mishu-probe-')), []);
});
test('缺少随包运行时就报安装包错误，不回退寻找或启动用户安装的秘书', async t => {
  const { a, root } = rig(t), bundle = path.join(root, 'bundle');
  fs.mkdirSync(bundle);
  fs.copyFileSync(path.resolve(__dirname, '../core/company-assistant/room-component/baseline.json'), path.join(bundle, 'baseline.json'));
  a.rooms.deps.roomBundle = bundle;
  const external = path.join(root, 'external.exe'); fs.writeFileSync(external, 'do not run');
  a.setSettings({ rooms: { exePath: external } });
  a.rooms.deps.roomSpawn = () => { throw Error('must not spawn'); };
  await assert.rejects(a.rooms.ensure(), /安装包缺少会议室组件/);
  assert.equal(a.settings().rooms.exePath, external);
  assert.equal(a.rooms.status().available, false);
});
function embeddedRig(t, processes = []) {
  const { a, root } = rig(t), exe = path.join(root, 'embedded.exe');
  fs.writeFileSync(exe, 'fixture');
  const originalPrepare = component.prepareRuntime, originalStage = component.stage;
  component.prepareRuntime = () => ({ exe, baseline: {} });
  component.stage = async () => ({ ready: true });
  t.after(() => { component.prepareRuntime = originalPrepare; component.stage = originalStage; });
  a.rooms.deps.roomProcesses = async () => processes;
  let spawned = 0;
  a.rooms.deps.roomSpawn = (file, args, opts) => {
    spawned++; assert.equal(file, exe); assert.deepEqual(args, ['--hub-control']);
    assert.equal(opts.env.MSZ_NO_TRAY, '1'); assert.equal(opts.env.MSZ_HOME, root);
    const child = new EventEmitter(); child.pid = 4242; child.unref = () => {};
    fs.mkdirSync(path.join(root, 'hub-control'), { recursive: true });
    fs.writeFileSync(path.join(root, 'hub-control', 'status.json'), JSON.stringify({ protocol: 1, at: a.now(), running: false }));
    return child;
  };
  return { a, root, exe, spawned: () => spawned };
}
test('全新用户直接准备内嵌组件且保持未预约，不需要程序路径或独立版本探测', async t => {
  const { a, root, exe, spawned } = embeddedRig(t);
  const ready = await a.rooms.ensure();
  assert.equal(ready.connected, true); assert.equal(ready.embedded, true);
  assert.equal(ready.running, false); assert.equal(a.settings().rooms.enabled, false);
  assert.equal(a.settings().rooms.exePath, exe); assert.equal(spawned(), 1);
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json')));
  assert.equal(config['系统']['自动检查更新'], false);
  assert.equal(config['系统']['开机自动启动守护'], false);
  assert.equal(config['高级']['无界面'], true);
  assert.equal(config['会后动作']['小鲁班ID'], '');
  assert.equal(fs.existsSync(path.join(root, 'booking_history.json')), false);
  await a.rooms.ensure(); assert.equal(spawned(), 1);
});
test('外部秘书存活时不启动第二份，不写旧配置，也不把其心跳误作内嵌已接通', async t => {
  const { a, root, spawned } = embeddedRig(t, [{ ProcessId: 11, ExecutablePath: path.join(os.tmpdir(), 'external-secretary.exe') }]);
  const before = '{"主题":"保留旧任务","系统":{"自动检查更新":true}}';
  fs.writeFileSync(path.join(root, 'config.json'), before);
  fs.mkdirSync(path.join(root, 'hub-control'));
  fs.writeFileSync(path.join(root, 'hub-control', 'status.json'), JSON.stringify({ protocol: 1, at: a.now(), running: true }));
  await assert.rejects(a.rooms.ensure(), /未启动第二份抢订/);
  assert.equal(spawned(), 0); assert.equal(a.rooms.status().connected, false);
  assert.equal(fs.readFileSync(path.join(root, 'config.json'), 'utf8'), before);
});
test('保留旧规则、历史、网页登录资料，仅关闭组件独立自更新/自启并启用后台浏览器', t => {
  const { root } = rig(t);
  const config = { 主题: '保留', 优先会议室: ['R1'], 高级: { 浏览器: 'Edge' }, 会后动作: { 模式: '提醒' }, future: 8 };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(root, 'booking_history.json'), 'original history');
  fs.mkdirSync(path.join(root, 'browser_profile')); fs.writeFileSync(path.join(root, 'browser_profile', 'Cookies'), 'login bytes');
  component.initializeHome(root);
  const after = JSON.parse(fs.readFileSync(path.join(root, 'config.json')));
  assert.equal(after.主题, config.主题); assert.deepEqual(after.优先会议室, config.优先会议室);
  assert.equal(after.future, 8); assert.equal(after.高级.浏览器, 'Edge'); assert.deepEqual(after.会后动作, config.会后动作);
  assert.equal(fs.readFileSync(path.join(root, 'booking_history.json'), 'utf8'), 'original history');
  assert.equal(fs.readFileSync(path.join(root, 'browser_profile', 'Cookies'), 'utf8'), 'login bytes');
});
test('公司打包前置校验在运行时缺失或哈希错误时硬失败', t => {
  const { root } = rig(t), { stageRuntime } = require('../core/company-assistant/room-component/build-runtime');
  const dir = path.join(root, 'core/company-assistant/room-component'); fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.resolve(__dirname, '../core/company-assistant/room-component/baseline.json'), path.join(dir, 'baseline.json'));
  assert.throws(() => stageRuntime({ appDir: root, source: '' }), /安装包必须自带/);
  const wrong = path.join(root, 'wrong.exe'); fs.writeFileSync(wrong, 'wrong');
  assert.throws(() => stageRuntime({ appDir: root, source: wrong }), /签名清单不符/);
});
test('会议室结果卡片按开始时间与时长显示「10-27（周二）14:00–16:00 · 会议室」，字段不全原样显示', t => {
  assert.equal(slotText({ 日期: '2026-10-27', 时间: '14:00 起 2h0m', 会议室: '练秋湖F12-3-13R' }), '10-27（周二）14:00–16:00 · 练秋湖F12-3-13R');
  assert.equal(slotText({ 日期: '2026-10-26', 时间: '9:30 起 1h30m', 会议室: 'R1' }), '10-26（周一）09:30–11:00 · R1');
  assert.equal(slotText({ 日期: '2026-10-27', 时间: '14:00 起', 会议室: 'R1' }), '2026-10-27 14:00 起 · R1');
  assert.equal(slotText({ 时间: '14:00 起 2h0m' }), '14:00 起 2h0m · 未选定');
  assert.equal(slotText({ 日期: '2026-10-27', 时间: '23:00 起 2h0m', 会议室: 'R1' }), '2026-10-27 23:00 起 2h0m · R1');
  const { a } = rig(t);
  a.saveState({ roomEvents: [{ id: 'x', at: 1, record: { 状态: '成功', 日期: '2026-10-27', 时间: '14:00 起 2h0m', 会议室: 'R1' } }] });
  assert.equal(a.rooms.status().events[0].slot, '10-27（周二）14:00–16:00 · R1');
  const page = fs.readFileSync(path.resolve(__dirname, '../renderer/company-assistant-page.js'), 'utf8');
  assert.match(page, /esc\(e\.slot \|\|/);
});
test('手机推送的会议室结果也用同一时段写法', async t => {
  const { a, root } = rig(t);
  a.saveState({ roomSeen: [] });
  fs.writeFileSync(path.join(root, 'booking_history.json'), JSON.stringify([{ 日期: '2026-10-27', 时间: '14:00 起 2h0m', 状态: '成功', 会议室: 'R1', 时间戳: 'x' }]));
  const sent = []; a.phone.active = () => true; a.phone.send = async text => { sent.push(text); return true; };
  await a.rooms.tick();
  assert.deepEqual(sent, ['会议室成功：10-27（周二）14:00–16:00 · R1']);
});
test('左栏状态圆点 10px（含 2px 白边），四色不变', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '../renderer/styles/company-assistant-page.css'), 'utf8');
  const dot = /\.ca-dot\{[^}]*\}/.exec(css)[0];
  assert.match(dot, /width:10px;height:10px;border:2px solid #fff/); assert.match(dot, /background:#8a94a6/);
  assert.match(css, /\.ca-dot\.ok\{background:#15803d\}\.ca-dot\.warn\{background:#a16207\}\.ca-dot\.run\{background:#3478f6\}/);
});
test('WeLink 两次没续上时左栏写「自动续期没成功，点这里扫码登录」，点整行直接扫码', () => {
  const page = fs.readFileSync(path.resolve(__dirname, '../renderer/company-assistant-page.js'), 'utf8');
  assert.match(page, /'needs-scan' \? '自动续期没成功，点这里扫码登录'/);
  assert.doesNotMatch(page, /\? '需要扫码'/);
  assert.match(page, /auth\.state === 'needs-scan' \? 'login' : 'settings-tab:welink'/);
});
