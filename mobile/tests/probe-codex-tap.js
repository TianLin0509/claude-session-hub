'use strict';
// Probe codex tap binding state via CDP
const http = require('http');
const WebSocket = require('ws');

const cdpPort = parseInt(process.argv[2] || '9337', 10);
const sessionId = process.argv[3];

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${cdpPort}${path}`, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function main() {
  const list = await getJson('/json/list');
  const target = list.find(t => t.type === 'page' && t.url.includes('renderer/index.html')) || list.find(t => t.type === 'page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let msgId = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++msgId;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });

  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) rej(m.error); else res(m.result);
    }
  });

  ws.on('open', async () => {
    await send('Runtime.enable');
    // 通过 require remote 拉 main process 的 transcriptTap
    const probeCode = `
      (async () => {
        const { ipcRenderer } = require('electron');
        const result = await ipcRenderer.invoke('debug:probe-codex-tap', '${sessionId || ''}').catch(e => ({err: String(e)}));
        return result;
      })()
    `;
    try {
      const r = await send('Runtime.evaluate', {
        expression: probeCode,
        returnByValue: true,
        awaitPromise: true,
      });
      console.log(JSON.stringify(r.result.value, null, 2));
    } catch (e) {
      console.error('err:', e);
    }
    ws.close();
    process.exit(0);
  });
}
main();
