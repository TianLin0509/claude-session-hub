'use strict';
// 桌宠设置文件：默认值、非法值回落、写盘后再读一致、文件坏了不崩。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createSettingsStore, defaults, normalize, parseBox, parseScale } = require('../core/hub-pet/settings');

test('默认值：公司版开、家里版关，温和档、小猫', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-pet-set-'));
  assert.equal(createSettingsStore({ dataDir: dir, company: true }).get().enabled, true);
  const home = createSettingsStore({ dataDir: dir, company: false }).get();
  assert.equal(home.enabled, false);
  assert.equal(home.mode, 'gentle');
  assert.equal(home.role, '01-cat');
});

test('写盘再读；非法角色、档位、位置被忽略；坏文件回落默认', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-pet-set-'));
  const s = createSettingsStore({ dataDir: dir, logger: { warn() {} } });
  s.update({ enabled: true, role: '07-shiba', mode: 'lively', position: { x: 100.4, y: 200.6 }, silentDate: '2026-10-16' });
  s.update({ role: 'dragon', mode: 'loud', position: { x: 'a' } });
  const again = createSettingsStore({ dataDir: dir }).get();
  assert.deepEqual(again, { enabled: true, role: '07-shiba', mode: 'lively', position: { x: 100, y: 201 }, quietUntil: 0, silentDate: '2026-10-16', peekOnFullscreen: true, scale: 1, bodyBoxes: {} });
  fs.writeFileSync(path.join(dir, 'hub-pet.json'), '{broken');
  assert.equal(createSettingsStore({ dataDir: dir, company: true, logger: { warn() {} } }).get().enabled, true);
});

// 2026-10-18 审核：大小从文件、设置页来的各种取值。
test('大小取值：数字样子的字符串认、NaN / 空串 / 布尔不认、超界按上下限、老文件缺字段按原大小', () => {
  assert.equal(parseScale(1.234), 1.23);
  assert.equal(parseScale('1.25'), 1.25);
  assert.equal(parseScale(' 0.8 '), 0.8);
  assert.equal(parseScale(5), 1.6);
  assert.equal(parseScale('-1'), 0.6);
  for (const bad of [NaN, Infinity, '', '  ', 'abc', null, undefined, true, {}, []]) assert.equal(parseScale(bad), null, JSON.stringify(String(bad)));
  const base = defaults();
  assert.equal(normalize({ scale: '1.4' }, base).scale, 1.4);
  assert.equal(normalize({ scale: 'big' }, { ...base, scale: 1.2 }).scale, 1.2, '不认的值保留原值');
  assert.equal(normalize({ scale: 0 }, base).scale, 0.6);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-pet-set-'));
  // 2.1.10 以前的文件：没有 scale、bodyBoxes
  fs.writeFileSync(path.join(dir, 'hub-pet.json'), JSON.stringify({ enabled: true, role: '01-cat', mode: 'gentle', position: { x: 10, y: 20 } }));
  const old = createSettingsStore({ dataDir: dir }).get();
  assert.equal(old.scale, 1);
  assert.deepEqual(old.bodyBoxes, {});
  assert.deepEqual(old.position, { x: 10, y: 20 });
  // JSON 里写不出 NaN，手改成字符串 "NaN" 或超界
  fs.writeFileSync(path.join(dir, 'hub-pet.json'), JSON.stringify({ scale: 'NaN' }));
  assert.equal(createSettingsStore({ dataDir: dir }).get().scale, 1);
  fs.writeFileSync(path.join(dir, 'hub-pet.json'), JSON.stringify({ scale: '9' }));
  assert.equal(createSettingsStore({ dataDir: dir }).get().scale, 1.6);
});

test('透明边按形象记住；只改内存的更新等 flush 才写盘', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-pet-set-'));
  const s = createSettingsStore({ dataDir: dir });
  s.update({ bodyBoxes: { '01-cat': { left: 0.153125, right: 0.2, top: 0.1, bottom: 2 } } });
  s.update({ bodyBoxes: { '03-penguin': { left: -1, right: 'x', top: 0, bottom: 0.1 }, '../bad': { left: 0.1 } } });
  const boxes = createSettingsStore({ dataDir: dir }).get().bodyBoxes;
  assert.deepEqual(boxes, { '01-cat': { left: 0.1531, right: 0.2, top: 0.1, bottom: 0.45 }, '03-penguin': { left: 0, right: 0, top: 0, bottom: 0.1 } });
  assert.deepEqual(parseBox(null), null);

  s.update({ scale: 1.3 }, { persist: false });
  assert.equal(s.isDirty(), true);
  assert.equal(JSON.parse(fs.readFileSync(s.file, 'utf8')).scale, 1, '还没写盘');
  s.flush();
  assert.equal(JSON.parse(fs.readFileSync(s.file, 'utf8')).scale, 1.3);
  assert.equal(s.isDirty(), false);
  s.update({ scale: 1.3 }, { persist: false });
  assert.equal(s.isDirty(), false, '没变就不算要写');
});
