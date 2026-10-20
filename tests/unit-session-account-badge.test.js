'use strict';
// 会话栏去杂（2026-10-20 田哥）：
//   1. CodeAgent 会话不再显示「池」，个人号与号池号统一显示账号工号首字母（小写），悬停是代称，不写工号；
//   2. 通道回合状态（已答 / 没答上 / N 轮 / 处理中 / 公司）不进会话栏，挪到会话头部；「重启打断」这类异常仍留在会话栏。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { accountInitial, accountBadges } = require('../core/codeagent-account-badge');
const { accountBadge, initialFromLabel, createAccountBadges } = require('../renderer/session-account-badge');

const ROOT = path.resolve(__dirname, '..');

test('工号首个英文字母、小写；没有字母为空', () => {
  assert.equal(accountInitial('l00654321'), 'l');
  assert.equal(accountInitial('W00612345'), 'w');
  assert.equal(accountInitial('00s12345'), 's');
  assert.equal(accountInitial('00612345'), '');
  assert.equal(accountInitial(''), '');
  assert.equal(accountInitial(undefined), '');
});

test('账号表：个人号与号池各号的字母和代称来自登录凭证与号池登记，不含工号全文', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-badge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const personal = path.join(root, 'personal');
  const data = path.join(root, 'data');
  fs.mkdirSync(personal, { recursive: true });
  fs.writeFileSync(path.join(personal, '.credentials.json'), JSON.stringify({ idaasOAuth: { accountId: 'l00654321', xAuthToken: 'x' } }));
  for (const [id, accountId] of [['abc123', 'w00612345'], ['def456', 'f00123456'], ['ghi789', null]]) {
    const dir = path.join(data, 'codeagent-pool', 'accounts', id);
    fs.mkdirSync(dir, { recursive: true });
    if (accountId) fs.writeFileSync(path.join(dir, '.credentials.json'), '﻿' + JSON.stringify({ devUCOAuth: { accountId, accessToken: 'x' } }));
  }
  fs.writeFileSync(path.join(data, 'codeagent-pool', 'pool.json'), JSON.stringify({ schema: 1, accounts: [{ id: 'abc123', note: '王工' }, { id: 'def456' }, { id: 'ghi789' }] }));
  const out = accountBadges({ dataDir: data, personalDir: personal });
  assert.deepEqual(out.personal, { initial: 'l', alias: '个人' });
  assert.deepEqual(out.accounts.abc123, { initial: 'w', alias: '号 1', note: '王工' });
  assert.deepEqual(out.accounts.def456, { initial: 'f', alias: '号 2', note: '' });
  assert.equal(out.accounts.ghi789.initial, '', '没登录的号没有字母');
  assert.doesNotMatch(JSON.stringify(out), /\d{5,}/, '不回工号全文');
  // 没有号池、个人号没登录：都为空
  assert.deepEqual(accountBadges({ dataDir: path.join(root, 'none'), personalDir: path.join(root, 'nobody') }), { personal: { initial: '', alias: '个人' }, accounts: {} });
});

test('会话 → 徽标：个人号与号池号统一字母；悬停代称；非 CodeAgent 或拿不到字母不显示（不退回「池」）', () => {
  const data = { personal: { initial: 'l', alias: '个人' }, accounts: { abc123: { initial: 'w', alias: '号 1', note: '王工' }, def456: { initial: 'f', alias: '号 2', note: '' } } };
  assert.deepEqual(accountBadge({ kind: 'codeagent' }, data), { letter: 'l', title: '个人账号' });
  assert.deepEqual(accountBadge({ kind: 'codeagent-resume' }, data), { letter: 'l', title: '个人账号' });
  assert.deepEqual(accountBadge({ kind: 'codeagent', codeagentPoolAccount: 'abc123', codeagentPoolLabel: 'w006****45（王工）' }, data), { letter: 'w', title: '号池 · 号 1（王工）' });
  assert.deepEqual(accountBadge({ kind: 'codeagent', codeagentPoolAccount: 'def456' }, data), { letter: 'f', title: '号池 · 号 2' });
  // 号已移出号池：用会话记下的脱敏标签兜底
  assert.deepEqual(accountBadge({ kind: 'codeagent', codeagentPoolAccount: 'gone01', codeagentPoolLabel: 's001****23（老号）' }, data), { letter: 's', title: '号池账号' });
  assert.equal(accountBadge({ kind: 'codeagent', codeagentPoolAccount: 'gone02', codeagentPoolLabel: '未登录' }, data), null);
  assert.equal(accountBadge({ kind: 'claude' }, data), null);
  assert.equal(accountBadge({ kind: 'codeagent' }, { personal: { initial: '' }, accounts: {} }), null);
  assert.equal(accountBadge({ kind: 'codeagent' }, null), null);
  assert.equal(initialFromLabel('（f00 备注）'), '');
});

test('渲染层接线：第一次用到才取账号表，取到后通知重画；号池登录变化后重取，获取模型权限中的推送不重取', async () => {
  const calls = [];
  let listener = null;
  let painted = 0;
  let personal = 'l';
  const badges = createAccountBadges({
    invoke: async channel => { calls.push(channel); return { ok: true, personal: { initial: personal, alias: '个人' }, accounts: {} }; },
    subscribe: fn => { listener = fn; },
    onChange: () => { painted += 1; },
  });
  assert.equal(badges.badge({ kind: 'claude' }), null);
  assert.equal(calls.length, 0, '没有 CodeAgent 会话时不取');
  assert.equal(badges.badge({ kind: 'codeagent' }), null, '还没取到时先不显示');
  await badges.load();
  assert.deepEqual(calls, ['codeagent-pool:badges']);
  assert.equal(painted, 1);
  assert.deepEqual(badges.badge({ kind: 'codeagent' }), { letter: 'l', title: '个人账号' });
  listener({ id: 'personal', probing: true });
  assert.equal(calls.length, 1);
  personal = 's';
  listener({ id: 'personal', loggedIn: true });
  await badges.load();
  assert.equal(calls.length, 2);
  assert.equal(painted, 2);
  assert.equal(badges.badge({ kind: 'codeagent' }).letter, 's');
});

test('会话栏源码：不再渲染「池」与回合状态标签，只留重启打断；会话头部有回合状态', () => {
  const list = fs.readFileSync(path.join(ROOT, 'renderer', 'session-list-renderer.js'), 'utf8');
  assert.doesNotMatch(list, /sl-pool|>池</);
  assert.match(list, /bridge && bridge\.role === 'restart' \?/);
  assert.match(list, /'<span class="sl-title">' \+ _warningHtml\(anyWarning\) \+ accountHtml \+ bridgeHtml/);
  const renderer = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
  assert.match(renderer, /crumb\.append\(workspaceBtn, crumbSep, titleSpan, statusDot\);\r?\n  paintCrumbBridge\(sessionId\);/);
  assert.match(renderer, /document\.addEventListener\('bridge-threads-updated'/);
  const handlers = fs.readFileSync(path.join(ROOT, 'main', 'ipc', 'session-handlers.js'), 'utf8');
  assert.match(handlers, /ipcMain\.handle\('codeagent-pool:badges'/);
});
