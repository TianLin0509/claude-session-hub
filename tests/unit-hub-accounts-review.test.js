'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { HubChrome } = require('../core/hub-chrome');
const { acquire } = require('../core/web-roundtable/store');

function chrome(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-accounts-review-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return new HubChrome({ root });
}

test('login probe retries a navigation context loss and closes only its own page', async t => {
  const hub = chrome(t);
  let attempts = 0, detached = 0;
  const closed = [];
  hub.running = async () => true;
  hub.openTab = async () => ({ targetId: 'inspection-tab' });
  hub.page = async () => ({
    evaluate: async () => {
      if (++attempts === 1) throw Error('Execution context was destroyed.');
      return { host: 'chat.deepseek.com', profile: true };
    },
    close: () => { detached++; },
  });
  hub.closeTab = async id => { closed.push(id); };
  assert.equal((await hub.liveStatus('main', 'deepseek', { timeoutMs: 2000 })).state, 'signed_in');
  assert.equal(attempts, 2);
  assert.equal(detached, 1);
  assert.deepEqual(closed, ['inspection-tab']);
});

test('login probe still propagates non-navigation errors', async t => {
  const hub = chrome(t);
  let attempts = 0, closed = false;
  hub.running = async () => true;
  hub.openTab = async () => ({ targetId: 'inspection-tab' });
  hub.page = async () => ({ evaluate: async () => { attempts++; throw Error('Browser disconnected'); }, close() {} });
  hub.closeTab = async () => { closed = true; };
  await assert.rejects(hub.liveStatus('main', 'deepseek'), /Browser disconnected/);
  assert.equal(attempts, 1);
  assert.equal(closed, true);
});

test('idle tool cleanup cannot close a browser reserved by a login inspector', async t => {
  const hub = chrome(t);
  let closed = 0;
  hub.workTabs = async () => 0;
  hub.close = async () => { closed++; };
  const release = acquire('account-check', path.join(hub.root, 'locks'));
  try {
    assert.equal(await hub.closeIfIdle(), false);
    assert.equal(closed, 0);
    hub.inspectionOwner = true;
    assert.equal(await hub.closeIfIdle(), true);
    assert.equal(closed, 1);
  } finally { release(); }
  hub.inspectionOwner = false;
  assert.equal(await hub.closeIfIdle(), true);
  assert.equal(closed, 2);
});

test('a headless tab in another profile is closed before it can visit an account website', async t => {
  const hub = chrome(t), closed = [], calls = [];
  hub.browser = async () => ({ ep: { headless: true, port: 1234 }, cdp: {
    async call(method, args) {
      calls.push({ method, args });
      if (method === 'Target.createTarget') return { targetId: 'own-new-tab' };
      if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: 'own-new-tab', browserContextId: 'wrong-profile' } };
      throw Error('unexpected ' + method);
    }, close() {},
  } });
  hub.marker = async () => ({ targetId: 'marker', browserContextId: 'correct-profile' });
  hub.pagesIn = async () => [{ targetId: 'other-task' }];
  hub.page = async () => { assert.fail('must not access a page in the wrong profile'); };
  hub.closeTab = async id => closed.push(id);
  await assert.rejects(hub._openTab('main', 'https://chatgpt.com/'), /账号隔离校验失败/);
  assert.deepEqual(closed, ['own-new-tab']);
  assert.match(calls[0].args.url, /^file:.*identity-main\.html#task-/);
});

test('a browser navigation error is reported and the newly created inspection tab is released', async t => {
  const hub = chrome(t), closed = [];
  hub.browser = async () => ({ ep: { headless: true, port: 1234 }, cdp: {
    async call(method) {
      if (method === 'Target.createTarget') return { targetId: 'own-new-tab' };
      if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: 'own-new-tab', browserContextId: 'main' } };
      throw Error('unexpected ' + method);
    }, close() {},
  } });
  hub.marker = async () => ({ targetId: 'marker', browserContextId: 'main' });
  hub.pagesIn = async () => [];
  hub.page = async () => ({ call: async () => ({ errorText: 'net::ERR_CONNECTION_RESET' }), close() {} });
  hub.closeTab = async id => closed.push(id);
  await assert.rejects(hub._openTab('main', 'https://chatgpt.com/'), /ERR_CONNECTION_RESET/);
  assert.deepEqual(closed, ['own-new-tab']);
});

test('ChatGPT security gate stops session requests immediately and releases its page', async t => {
  const hub = chrome(t); let probes = 0, closed = false;
  hub.openTab = async () => ({ targetId: 'probe' });
  hub.page = async () => ({ evaluate: async () => { probes++; return { host: 'chatgpt.com', challenge: true }; }, close() {} });
  hub.closeTab = async () => { closed = true; };
  await assert.rejects(hub.chatgptAccount('main'), e => e.code === 'HUB_LOGIN_CHECK_RESTRICTED');
  assert.equal(probes, 1, 'no session request or 15-second retry on a known security gate');
  assert.equal(closed, true);
});
