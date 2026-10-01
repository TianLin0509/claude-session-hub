'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { scopedConnection } = require('../core/scoped-cdp');
const once = (ws, event) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Error('Timed out waiting for ' + event)), 3000);
  ws.once(event, value => { clearTimeout(timer); resolve(value); });
});

// A fake browser: one owned page OWN, attachable as session S1; it records what reaches it.
async function fakeBrowser(t) {
  const server = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const received = [], peers = [];
  let attached = 0;
  server.on('connection', ws => {
    peers.push(ws);
    ws.on('message', bytes => {
      const m = JSON.parse(bytes); received.push(m);
      const reply = result => ws.send(JSON.stringify({ id: m.id, ...(m.sessionId ? { sessionId: m.sessionId } : {}), result }));
      if (m.method === 'Target.getTargetInfo' && m.params?.targetId === 'OWN') reply({ targetInfo: { targetId: 'OWN', type: 'page', url: 'https://chatgpt.com/', browserContextId: 'C', attached: false } });
      else if (m.method === 'Target.attachToTarget') reply({ sessionId: 'S' + ++attached });
      else reply({ echo: m.method });
    });
  });
  const port = server.address().port;
  t.after(async () => { for (const ws of server.clients) ws.terminate(); await new Promise(r => server.close(r)); });
  return { ep: { port, ws: `ws://127.0.0.1:${port}/devtools/browser/fixture` }, received, emit: m => peers.forEach(ws => ws.send(JSON.stringify(m))) };
}
async function client(t, relay) {
  const ws = new WebSocket(relay.endpoint);
  t.after(async () => { ws.terminate(); await relay.close(); });
  await once(ws, 'open');
  const inbox = [];
  ws.on('message', bytes => inbox.push(JSON.parse(bytes)));
  let id = 0;
  const call = (method, params = {}, sessionId) => {
    const mine = ++id;
    ws.send(JSON.stringify({ id: mine, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => {
      const end = Date.now() + 3000;
      (function look() {
        const hit = inbox.find(m => m.id === mine);
        if (hit) return resolve(hit);
        if (Date.now() > end) return reject(Error('no reply to ' + method));
        setTimeout(look, 10);
      })();
    });
  };
  return { call, inbox };
}
const settle = () => new Promise(r => setTimeout(r, 100));

test('the browser-level auto-attach reports the owned page only and never reaches Chrome', async t => {
  const chrome = await fakeBrowser(t);
  const { call, inbox } = await client(t, await scopedConnection(chrome.ep, ['OWN']));
  const reply = await call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  assert.deepEqual(reply.result, {});
  const attached = inbox.filter(m => m.method === 'Target.attachedToTarget');
  assert.equal(attached.length, 1);
  assert.equal(attached[0].params.sessionId, 'S1');
  assert.equal(attached[0].params.targetInfo.targetId, 'OWN');
  assert.equal(chrome.received.some(m => m.method === 'Target.setAutoAttach'), false);
  assert.deepEqual(chrome.received.find(m => m.method === 'Target.attachToTarget').params, { targetId: 'OWN', flatten: true });
});

test('the page session works, but its frames are never attached and focus is not emulated', async t => {
  const chrome = await fakeBrowser(t);
  const { call } = await client(t, await scopedConnection(chrome.ep, ['OWN']));
  assert.equal((await call('Runtime.evaluate', { expression: '1' }, 'S1')).result.echo, 'Runtime.evaluate');
  assert.deepEqual((await call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, 'S1')).result, {});
  assert.deepEqual((await call('Emulation.setFocusEmulationEnabled', { enabled: true }, 'S1')).result, {});
  const forwarded = chrome.received.filter(m => m.sessionId === 'S1').map(m => m.method);
  assert.deepEqual(forwarded, ['Runtime.evaluate']);
  assert.match((await call('Runtime.evaluate', {}, 'OTHER')).error.message, /Unknown session/);
  assert.match((await call('Target.attachToTarget', { targetId: 'X', flatten: true }, 'S1')).error.message, /scoped/);
});

test('browser commands that could reach other pages or end the browser are refused', async t => {
  const chrome = await fakeBrowser(t), refused = [];
  const { call } = await client(t, await scopedConnection(chrome.ep, ['OWN'], { onRefused: m => refused.push(m) }));
  for (const [method, params] of [['Browser.close'], ['Target.createTarget', { url: 'about:blank' }], ['Target.attachToTarget', { targetId: 'X' }],
    ['Target.getTargets'], ['Target.closeTarget', { targetId: 'X' }], ['Storage.clearCookies'], ['Target.createBrowserContext']]) {
    assert.match((await call(method, params || {})).error.message, /scoped/, method);
  }
  assert.deepEqual(refused, ['Browser.close', 'Target.createTarget', 'Target.attachToTarget', 'Target.getTargets', 'Target.closeTarget', 'Storage.clearCookies', 'Target.createBrowserContext']);
  for (const [method, params] of [['Browser.getVersion'], ['Browser.setDownloadBehavior', { behavior: 'allowAndName' }], ['Target.getTargetInfo'], ['Target.closeTarget', { targetId: 'OWN' }]]) {
    assert.equal((await call(method, params || {})).result.echo, method, method);
  }
  const reached = chrome.received.map(m => m.method);
  for (const method of ['Browser.close', 'Target.createTarget', 'Target.getTargets', 'Storage.clearCookies']) assert.equal(reached.includes(method), false, method);
});

test('only events of the owned page and download events reach the tool', async t => {
  const chrome = await fakeBrowser(t);
  const { call, inbox } = await client(t, await scopedConnection(chrome.ep, ['OWN']));
  await call('Browser.getVersion');
  chrome.emit({ sessionId: 'OTHER', method: 'Page.loadEventFired', params: {} });
  chrome.emit({ method: 'Target.attachedToTarget', params: { sessionId: 'S9', targetInfo: { targetId: 'X', type: 'iframe' } } });
  chrome.emit({ sessionId: 'S1', method: 'Page.loadEventFired', params: { timestamp: 1 } });
  chrome.emit({ method: 'Browser.downloadWillBegin', params: { guid: 'g' } });
  chrome.emit({ method: 'Target.detachedFromTarget', params: { sessionId: 'S1', targetId: 'OWN' } });
  await settle();
  const events = inbox.filter(m => m.method).map(m => m.method + (m.sessionId ? '@' + m.sessionId : ''));
  assert.deepEqual(events, ['Page.loadEventFired@S1', 'Browser.downloadWillBegin', 'Target.detachedFromTarget']);
});

test('accepts only the verified local browser endpoint and at least one owned page', async () => {
  await assert.rejects(scopedConnection({ port: 9222, ws: 'ws://example.com:9222/browser' }, ['OWN']), /Invalid local/);
  await assert.rejects(scopedConnection({ port: 9222, ws: 'ws://127.0.0.1:9223/browser' }, ['OWN']), /Invalid local/);
  await assert.rejects(scopedConnection({ port: 9222, ws: 'ws://127.0.0.1:9222/browser' }, []), /no owned page/);
});

test('a session the tool opens itself (newCDPSession) reaches owned pages only and may focus them', async t => {
  const chrome = await fakeBrowser(t);
  const { call } = await client(t, await scopedConnection(chrome.ep, ['OWN']));
  const browser = (await call('Target.attachToBrowserTarget')).result.sessionId;
  assert.match(browser, /^scoped-browser-/);
  assert.equal(chrome.received.some(m => m.method === 'Target.attachToBrowserTarget'), false, 'never a real browser session');
  assert.match((await call('Target.attachToTarget', { targetId: 'OTHER', flatten: true }, browser)).error.message, /scoped/);
  assert.match((await call('Target.getTargets', {}, browser)).error.message, /scoped/);
  const own = (await call('Target.attachToTarget', { targetId: 'OWN', flatten: true }, browser)).result.sessionId;
  assert.equal(own, 'S2');
  assert.equal((await call('Emulation.setFocusEmulationEnabled', { enabled: true }, own)).result.echo, 'Emulation.setFocusEmulationEnabled', 'the tool asked for focus on its own page');
  assert.deepEqual((await call('Emulation.setFocusEmulationEnabled', { enabled: true }, 'S1')).result, {}, 'the automatic session still gets no focus');
  assert.deepEqual((await call('Target.detachFromTarget', { sessionId: own }, browser)).result, {});
  assert.match((await call('Runtime.evaluate', {}, own)).error.message, /Unknown session/);
});
