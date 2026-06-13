'use strict';

// 通过 CDP 连接 Hub renderer，evaluate IPC 调用看 SessionManager 真实状态
// 用法: node probe-hub-sessions.js <cdpPort> [sessionId]

const http = require('http');
const WebSocket = require('ws');

const cdpPort = parseInt(process.argv[2] || '51329', 10);
const focusSessionId = process.argv[3] || null;

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
  if (!target) {
    console.error('No renderer target found');
    process.exit(2);
  }
  console.log(`[cdp] connecting ${target.webSocketDebuggerUrl}`);
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
    // 通过 IPC 询问 main process
    const probeCode = `
      (async () => {
        const { ipcRenderer } = require('electron');
        // hub 提供了一组 IPC handlers，我们看现成的
        const allSessions = await ipcRenderer.invoke('get-sessions').catch(e => ({err: String(e)}));
        ${focusSessionId ? `const buf = await ipcRenderer.invoke('debug:get-session-buffer', '${focusSessionId}').catch(e => ({err: String(e)}));` : 'const buf = null;'}
        return { allSessionsCount: Array.isArray(allSessions) ? allSessions.length : null, focusBufferLen: typeof buf === 'string' ? buf.length : null, focusBufferTail: typeof buf === 'string' ? buf.slice(-2000) : buf };
      })()
    `;
    try {
      const result = await send('Runtime.evaluate', {
        expression: probeCode,
        returnByValue: true,
        awaitPromise: true,
      });
      console.log(JSON.stringify(result.result.value, null, 2));
    } catch (e) {
      console.error('[evaluate err]', e);
    }
    ws.close();
    process.exit(0);
  });

  ws.on('error', (e) => { console.error('[ws err]', e.message); process.exit(1); });
}

main().catch((e) => { console.error('[main err]', e); process.exit(1); });
