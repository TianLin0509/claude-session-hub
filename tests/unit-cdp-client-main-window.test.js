'use strict';
// connectFirstPage 默认连主窗口（2026-10-17 发布分身报：桌宠页排在 CDP 页面清单第一个，不指定窗口的测试连到了桌宠）。
// 本机起一个假的调试端口：/json/list 给出页面清单，每个页面一个 WebSocket 地址，看实际连上的是哪一个。
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { WebSocketServer } = require('ws');
const { connectFirstPage, isMainWindow } = require('./helpers/cdp-client');

async function fakeCdp(t, pagesAt) {
  const connected = [];
  const server = http.createServer((req, res) => {
    if (req.url !== '/json/list') { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(pagesAt(Date.now()).map(p => ({ ...p, webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/page/${p.id}` }))));
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (_ws, req) => connected.push(req.url.split('/').pop()));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { wss.close(); server.close(); });
  return { hub: { cdpHttpBase: `http://127.0.0.1:${server.address().port}`, label: 'fake' }, connected };
}
const PET = { id: 'pet', type: 'page', url: 'file:///D:/hub/renderer/hub-pet/pet.html' };
const MAIN = { id: 'main', type: 'page', url: 'file:///D:/hub/renderer/index.html' };
const settle = () => new Promise(r => setTimeout(r, 100));

test('桌宠排第一：默认连主窗口 renderer/index.html', async t => {
  const { hub, connected } = await fakeCdp(t, () => [PET, MAIN]);
  const c = await connectFirstPage(hub); await settle(); await c.close();
  assert.deepEqual(connected, ['main']);
  assert.equal(isMainWindow({ type: 'page', url: 'file:///C:\\hub\\renderer\\index.html' }), true, 'Windows 反斜杠路径也认');
});

test('主窗口晚一点才出现：稍等后连主窗口；一直没有就退回第一个页面；显式 filter 照旧', async t => {
  const start = Date.now();
  const late = await fakeCdp(t, now => (now - start > 600 ? [PET, MAIN] : [PET]));
  const c1 = await connectFirstPage(late.hub); await settle(); await c1.close();
  assert.deepEqual(late.connected, ['main']);
  const none = await fakeCdp(t, () => [{ id: 'worker', type: 'service_worker', url: 'x' }, PET]);
  const c2 = await connectFirstPage(none.hub, null, { waitMainMs: 300 }); await settle(); await c2.close();
  assert.deepEqual(none.connected, ['pet']);
  const explicit = await fakeCdp(t, () => [MAIN, PET]);
  const c3 = await connectFirstPage(explicit.hub, x => x.id === 'pet'); await settle(); await c3.close();
  assert.deepEqual(explicit.connected, ['pet']);
});
