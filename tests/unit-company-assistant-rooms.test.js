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
const { HubTools } = require('../core/company-assistant/hub-tools');
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
test('没接通过（无已保存程序）时，助理/手机工具不找、不登记、不拉起秘书，只提示去设置里接通', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-room-gate-'));
  const a = new CompanyAssistant({ dataDir: root, noTimer: true, roomSpawn: () => { throw Error('must not spawn'); } });
  t.after(() => a.close());
  const original = component.discover; let looked = 0;
  component.discover = async () => { looked++; return ''; };
  t.after(() => { component.discover = original; });
  for (const op of ['start', 'configure', 'login']) {
    const r = await a.rooms.command(op, op === 'configure' ? { 主题: 'x' } : {});
    assert.equal(r.ok, false); assert.equal(r.needsConnect, true); assert.equal(r.error, '请先在助理设置 → 抢会议室里接通');
  }
  a.saveState({ sessionId: 'assistant-1' });
  const viaTool = await new HubTools(a, {}).invoke({ name: 'room_booking', arguments: { op: 'start' }, callerSessionId: 'assistant-1' });
  assert.equal(viaTool.needsConnect, true);
  assert.equal(looked, 0); assert.equal(a.settings().rooms?.exePath || '', '');
  await assert.rejects(a.rooms.ensure(), /请先在助理设置/);
  assert.equal(looked, 0);
});
test('打开页签只显示找到的程序不保存；版本探测只在点「接通」时做，之后后台启动沿用结果', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-room-probe-')), home = path.join(root, 'mishu');
  fs.mkdirSync(home); const exe = path.join(home, 'MishuTerminator-2.1.1.exe'); fs.writeFileSync(exe, 'fixture');
  const shell = component.manifest(path.resolve(__dirname, '../core/company-assistant/room-component/control.json')).shell;
  let probes = 0;
  const spawnFn = (file, args, opts) => { probes++; return fakeChild({ exitWith: 0, write: { exe_shell: shell, exe_version: '2.1.1' } })(file, args, opts); };
  const a = new CompanyAssistant({ dataDir: root, noTimer: true, noTools: true, roomProbe: { spawnFn }, roomSpawn: () => { const c = new EventEmitter(); c.unref = () => {}; return c; } });
  t.after(() => a.close());
  const original = component.discover;
  component.discover = async () => exe;
  t.after(() => { component.discover = original; });
  const seen = await a.rooms.discover();
  assert.equal(seen.available, true); assert.equal(seen.exePath, exe); assert.equal(a.settings().rooms?.exePath || '', '');
  // Found but not connected by the user: the tool still refuses.
  assert.equal((await a.rooms.command('start')).needsConnect, true);
  const live = () => { fs.mkdirSync(path.join(home, 'hub-control'), { recursive: true }); fs.writeFileSync(path.join(home, 'hub-control', 'status.json'), JSON.stringify({ protocol: 1, at: a.now(), running: false })); };
  const connecting = a.rooms.ensure({ user: true }); setTimeout(live, 50);
  await connecting;
  assert.equal(probes, 1); assert.equal(a.settings().rooms.exePath, exe); assert.equal(a.state().roomProbe.exe_version, '2.1.1');
  fs.rmSync(path.join(home, 'hub-control'), { recursive: true, force: true });
  const background = a.rooms.ensure(); setTimeout(live, 50);
  await background;
  assert.equal(probes, 1, 'background start reuses the recorded probe');
  // The exe changed on disk: a background start asks the user instead of probing on its own.
  fs.rmSync(path.join(home, 'hub-control'), { recursive: true, force: true });
  fs.writeFileSync(exe, 'fixture-updated');
  await assert.rejects(a.rooms.ensure(), /请先在助理设置/);
  assert.equal(probes, 1);
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
