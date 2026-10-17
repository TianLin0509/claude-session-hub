'use strict';
// 桌宠设置文件：默认值、非法值回落、写盘后再读一致、文件坏了不崩。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createSettingsStore } = require('../core/hub-pet/settings');

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
  assert.deepEqual(again, { enabled: true, role: '07-shiba', mode: 'lively', position: { x: 100, y: 201 }, quietUntil: 0, silentDate: '2026-10-16', peekOnFullscreen: true });
  fs.writeFileSync(path.join(dir, 'hub-pet.json'), '{broken');
  assert.equal(createSettingsStore({ dataDir: dir, company: true, logger: { warn() {} } }).get().enabled, true);
});
