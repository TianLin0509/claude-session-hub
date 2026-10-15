'use strict';
// 公司版 2026-10-15 两项：设置菜单的隐藏入口（键盘敲口令解锁，一台电脑一次）与网络放行页自动点击。
// 界面上的按键行为（菜单开着才算、输入框里打字不算）在 tests/e2e-company-link-ui-cdp.js 用真实界面验证。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { rig, pair } = require('./helpers/company-bridge-rig');
const { matchesUnlock, unlockDigest, UNLOCK_LENGTH } = require('../core/company-bridge/unlock');
const { pickGateButton, MAX_TRIES, COOLDOWN_MS } = require('../core/company-bridge/gate-pass');
const { registerCompanyBridgeIpc } = require('../main/ipc/company-bridge-handlers');

// 真口令不进任何文件（公司版代码在公开仓库）：逻辑用一个测试口令的摘要验证；
// 真口令只在本机设了 HUB_UNLOCK_PHRASE 时核对内置摘要。
const PHRASE = 'testunlockz';
const TEST_DIGEST = unlockDigest(PHRASE);
const REAL = process.env.HUB_UNLOCK_PHRASE || '';

test('口令核对：只认完整口令（大小写不限），多一个少一个字母都不认', () => {
  assert.equal(PHRASE.length, UNLOCK_LENGTH);
  assert.equal(matchesUnlock(PHRASE, TEST_DIGEST), true);
  assert.equal(matchesUnlock(PHRASE.toUpperCase(), TEST_DIGEST), true);
  assert.equal(matchesUnlock(PHRASE.slice(0, -1) + 'x', TEST_DIGEST), false);
  assert.equal(matchesUnlock('x' + PHRASE, TEST_DIGEST), false);
  assert.equal(matchesUnlock('', TEST_DIGEST), false);
  assert.equal(matchesUnlock(PHRASE), false, '测试口令不能解开内置摘要');
});

test('真口令（本机提供时）：解开内置摘要；源码和界面脚本里没有原文', { skip: !REAL && '未设置 HUB_UNLOCK_PHRASE' }, () => {
  assert.equal(matchesUnlock(REAL), true);
  for (const file of ['core/company-bridge/unlock.js', 'renderer/home-link.js', 'core/company-bridge/company.js', 'main/ipc/company-bridge-handlers.js', 'tests/unit-company-unlock-gate.test.js', 'tests/e2e-company-link-ui-cdp.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', file), 'utf8').toLowerCase(), new RegExp(REAL.toLowerCase()), file);
  }
});

const withDigest = { companyDeps: { unlockDigest: TEST_DIGEST } };
test('解锁状态：新电脑未解锁，敲错不解锁，敲对后重开 Hub 仍在；升级前已配对的电脑直接算解锁', async t => {
  const r = rig(t, withDigest);
  assert.equal(r.company.unlocked(), false);
  assert.equal(r.company.status().unlocked, false);
  assert.equal(r.company.unlock('abcdefghijk'), false);
  assert.equal(r.company.unlocked(), false);
  assert.equal(r.company.unlock(PHRASE), true);
  const { CompanyBridge } = require('../core/company-bridge/company');
  const again = new CompanyBridge({ dataDir: path.join(r.root, 'company'), noTimer: true, fetchImpl: r.relay.fetch, now: () => r.clock.now });
  assert.equal(again.unlocked(), true);
  again.close();

  // 配对过、但数据里没有解锁记录（2.1.0 之前的版本）：重开后算已解锁。
  const p = rig(t);
  await pair(p);
  p.company.store.set('featureUnlock', null);
  assert.equal(p.company.unlocked(), false);
  const upgraded = new CompanyBridge({ dataDir: path.join(p.root, 'company'), noTimer: true, fetchImpl: p.relay.fetch, now: () => p.clock.now });
  assert.equal(upgraded.unlocked(), true);
  assert.equal(upgraded.store.get('featureUnlock').via, 'paired');
  upgraded.close();
});

function fakeIpc() {
  const handlers = new Map();
  return { handle: (name, fn) => handlers.set(name, fn), call: (name, req) => handlers.get(name)({}, req), handlers };
}

test('未解锁时公司一端的 IPC 只回答「未解锁」和解锁本身，其余一律拒绝；解锁后照常', async t => {
  const r = rig(t, withDigest);
  const ipc = fakeIpc();
  registerCompanyBridgeIpc(ipc, r.company);
  const locked = await ipc.call('bridge:status');
  assert.deepEqual(locked, { ok: true, role: 'company', unlocked: false });
  for (const [name, req] of [['bridge:set-settings', { autoGate: true }], ['bridge:pair', { code: 'x' }], ['bridge:check-now'], ['bridge:unpair'], ['bridge:retry', { id: 'Q-1' }], ['bridge:open-gate'], ['bridge:open-session', { sessionId: 'abc' }]]) {
    const res = await ipc.call(name, req);
    assert.equal(res.ok, false, name); assert.equal(res.error, '功能未启用', name);
  }
  assert.equal(r.company.settings().autoGate, false);
  assert.deepEqual(await ipc.call('bridge:unlock', { text: 'abcdefghijk' }), { ok: true, unlocked: false });
  assert.deepEqual(await ipc.call('bridge:unlock', { text: PHRASE }), { ok: true, unlocked: true });
  const full = await ipc.call('bridge:status');
  assert.equal(full.unlocked, true); assert.ok(full.settings && full.link);
  assert.equal((await ipc.call('bridge:set-settings', { autoGate: true })).ok, true);
  assert.equal(r.company.settings().autoGate, true);

  // 家里一端不受影响。
  const home = fakeIpc();
  registerCompanyBridgeIpc(home, r.home);
  assert.equal((await home.call('bridge:status')).role, 'home');
  assert.equal((await home.call('bridge:check-now')).ok, true);
});

test('放行按钮识别：优先「继续访问 / 我已知晓」，不点「不同意 / 返回 / 取消」', () => {
  assert.equal(pickGateButton(['返回', '继续访问']), 1);
  assert.equal(pickGateButton(['不同意', '同意']), 1);
  assert.equal(pickGateButton(['确定', '我已知晓风险，继续访问']), 1);
  assert.equal(pickGateButton(['首页', 'I understand the risks, Continue']), 1);
  assert.equal(pickGateButton(['Cancel', 'OK']), 1);
  assert.equal(pickGateButton(['Back to safety', 'Proceed anyway']), 1);
  assert.equal(pickGateButton(['帮助', '首页']), -1);
  assert.equal(pickGateButton(['这是一大段页面说明文字，里面提到了继续访问这几个字但不是按钮本身的文字内容']), -1);
  assert.equal(pickGateButton([]), -1);
});

// 通道被公司代理拦着：所有请求都跳转到放行页；放行页上的按钮被点过才恢复。
function gatedRig(t, open) {
  const calls = [];
  let r;
  const fake = async url => { calls.push(url); return open(r, url); };
  r = rig(t, { companyDeps: { openHiddenGate: fake, unlockDigest: TEST_DIGEST } });
  const inner = r.relay.fetch;
  r.gated = false;
  r.relay.fetch = async (url, init) => r.gated ? { ok: false, status: 302, type: 'basic', headers: { get: k => String(k).toLowerCase() === 'location' ? 'https://gate.example.test/warn?from=relay' : null }, text: async () => '' } : inner(url, init);
  r.company.link.fetchImpl = (...a) => r.relay.fetch(...a);
  r.home.link.fetchImpl = (...a) => r.relay.fetch(...a);
  r.calls = calls;
  return r;
}
const sampleHtml = '<html><body><p>该网站未分类</p><button>返回</button><button>继续访问</button></body></html>';

test('自动放行：开关关着不点；打开后被拦就点一次放行页、立即重连恢复，记日志和放行页样本', async t => {
  const r = gatedRig(t, async (rr) => { rr.gated = false; return { loaded: true, clicked: true, text: '继续访问', html: sampleHtml }; });
  await pair(r);
  r.company.unlock(PHRASE);
  r.gated = true;
  await r.company.checkNow();
  assert.ok(r.company.status().net.gate, '应识别为待放行');
  assert.equal(r.calls.length, 0, '开关关着不应自动点');

  r.company.setSettings({ autoGate: true });
  await r.company.checkNow();
  assert.deepEqual(r.calls, ['https://gate.example.test/warn?from=relay']);
  const st = r.company.status();
  assert.equal(st.net.gate, null, '点过后立即重连，放行状态应清除');
  assert.equal(st.net.autoGate.tries, 0);
  assert.ok(r.notices.some(n => /已自动放行/.test(n.title)));
  const logDir = path.join(r.root, 'company', 'logs');
  const lines = fs.readFileSync(path.join(logDir, 'company-gate.log'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map(x => x.result), ['clicked', 'passed']);
  assert.equal(lines[0].host, 'gate.example.test'); assert.equal(lines[0].button, '继续访问');
  assert.equal(fs.readFileSync(path.join(logDir, 'company-gate-sample.html'), 'utf8'), sampleHtml);
});

test('自动放行：连续 3 次点了仍被拦就停手提示人工，30 分钟后再试；找不到按钮、窗口出错都不卡住收件', async t => {
  let n = 0;
  const r = gatedRig(t, async () => { n += 1; if (n === 2) throw new Error('窗口加载失败'); return { loaded: true, clicked: n !== 3, text: n === 3 ? null : '继续访问', candidates: ['帮助'], html: sampleHtml }; });
  await pair(r);
  r.company.unlock(PHRASE);
  r.company.setSettings({ autoGate: true });
  r.gated = true;
  for (let i = 0; i < MAX_TRIES; i++) await r.company.checkNow();
  assert.equal(r.calls.length, MAX_TRIES);
  await r.company.checkNow();
  assert.equal(r.calls.length, MAX_TRIES, '第 4 次不该再点');
  assert.ok(r.company.status().net.autoGate.cooldownUntil);
  assert.ok(r.notices.some(n => /自动放行没成功/.test(n.title)));
  await r.company.checkNow();
  assert.equal(r.calls.length, MAX_TRIES, '冷却期内不点');
  r.clock.now += COOLDOWN_MS + 1000;
  await r.company.checkNow();
  assert.equal(r.calls.length, MAX_TRIES + 1, '冷却结束再试');
  const results = fs.readFileSync(path.join(r.root, 'company', 'logs', 'company-gate.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l).result);
  assert.deepEqual(results, ['clicked', 'error', 'no-button', 'gave-up', 'clicked']);

  // 放行后照常收发：家里发来的问题能收到。
  r.gated = false;
  await r.company.checkNow();
  assert.equal(r.company.status().net.gate, null);
});

test('Electron 的 net.fetch 遇到代理跳转直接报「Redirect was cancelled」：按待放行处理，不当断网', async () => {
  const { BridgeClient } = require('../core/company-bridge/client');
  const client = new BridgeClient({ baseUrl: 'https://relay.example.test/drop/tok/api', fetchImpl: async () => { throw new Error('Redirect was cancelled'); } });
  await assert.rejects(client.fetchMessages('a'.repeat(32), 'company', 0, 'company'), e => e.code === 'gate' && e.gateUrl === 'https://relay.example.test/drop/tok/');
  const offline = new BridgeClient({ baseUrl: 'https://relay.example.test/drop/tok/api', fetchImpl: async () => { throw new Error('net::ERR_CONNECTION_RESET'); } });
  await assert.rejects(offline.fetchMessages('a'.repeat(32), 'company', 0, 'company'), e => e.code === 'offline');
});
