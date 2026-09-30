'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { passiveDownloadConnection } = require('../core/passive-cdp-connection');
const once = (ws, event) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Error('Timed out waiting for ' + event)), 3000);
  ws.once(event, value => { clearTimeout(timer); resolve(value); });
});

test('download relay suppresses synthetic focus only and preserves session messages', async t => {
  const upstream = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
  await once(upstream, 'listening');
  const received = [];
  upstream.on('connection', ws => ws.on('message', bytes => {
    const value = JSON.parse(bytes); received.push(value);
    ws.send(JSON.stringify({ id: value.id, sessionId: value.sessionId, result: { echo: value.params } }));
  }));
  const port = upstream.address().port;
  const relay = await passiveDownloadConnection({ port, ws: `ws://127.0.0.1:${port}/browser/fixture` });
  const client = new WebSocket(relay.endpoint);
  t.after(async () => { client.terminate(); await relay.close(); for (const ws of upstream.clients) ws.terminate(); await new Promise(r => upstream.close(r)); });
  await once(client, 'open');
  let reply = once(client, 'message');
  client.send(JSON.stringify({ id: 1, sessionId: 'own-session', method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true } }));
  assert.deepEqual(JSON.parse(await reply), { id: 1, sessionId: 'own-session', result: {} });
  assert.deepEqual(received, []);
  reply = once(client, 'message');
  client.send(JSON.stringify({ id: 2, sessionId: 'own-session', method: 'Runtime.evaluate', params: { expression: '原样传递' } }));
  assert.deepEqual(JSON.parse(await reply), { id: 2, sessionId: 'own-session', result: { echo: { expression: '原样传递' } } });
  assert.equal(received[0].method, 'Runtime.evaluate');
  reply = once(client, 'message');
  client.send(JSON.stringify({ id: 3, method: 'Browser.setDownloadBehavior', params: { behavior: 'allowAndName' } }));
  assert.equal(JSON.parse(await reply).result.echo.behavior, 'allowAndName');
  assert.equal(received.length, 2);
  const closed = once(client, 'close'); await relay.close(); await closed;
  assert.equal(received.some(m => m.method === 'Browser.close'), false);
});

test('download relay accepts only the verified local browser endpoint', async () => {
  await assert.rejects(passiveDownloadConnection({ port: 9222, ws: 'ws://example.com:9222/browser' }), /Invalid local/);
  await assert.rejects(passiveDownloadConnection({ port: 9222, ws: 'ws://127.0.0.1:9223/browser' }), /Invalid local/);
});
