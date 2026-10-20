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
