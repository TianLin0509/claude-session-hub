'use strict';

// 通过 GUI IPC 但传 opts.id，验证是否同样卡 PTY
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:9334${path}`, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

(async () => {
  const list = await getJson('/json/list');
  const target = list.find(t => t.type === 'page' && t.url.includes('renderer/index.html'));
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let msgId = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++msgId; pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); if (m.error) rej(m.error); else res(m.result); }
  });
  await new Promise(r => ws.once('open', r));
  await send('Runtime.enable');

  const customId = crypto.randomUUID();
  console.log(`[step] GUI IPC + opts.id="${customId}"`);
  await send('Runtime.evaluate', {
    expression: `(async () => { const { ipcRenderer } = require('electron'); await ipcRenderer.invoke('create-session', { kind: 'claude', opts: { id: '${customId}', title: 'probe-with-id' } }); })()`,
    returnByValue: true, awaitPromise: true,
  });
  await new Promise(r => setTimeout(r, 10000));
  const buf = await send('Runtime.evaluate', {
    expression: `(async () => { const { ipcRenderer } = require('electron'); const b = await ipcRenderer.invoke('debug:get-session-buffer', '${customId}'); return { len: typeof b === 'string' ? b.length : 'N/A', tail: typeof b === 'string' ? b.slice(-300) : b }; })()`,
    returnByValue: true, awaitPromise: true,
  });
  console.log('[after-10s buffer]', JSON.stringify(buf.result.value, null, 2));

  // 清理
  await send('Runtime.evaluate', {
    expression: `(async () => { const { ipcRenderer } = require('electron'); await ipcRenderer.invoke('close-session', '${customId}'); })()`,
    returnByValue: true, awaitPromise: true,
  });
  ws.close(); process.exit(0);
})();
