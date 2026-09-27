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
