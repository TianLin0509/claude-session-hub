'use strict';

// 通过 GUI 路径（ipcMain.handle('create-session')）创建 claude session
// 对比 mobile-bridge 路径，看 buffer 行为是否一样
// 用法: node probe-create-via-ipc.js <cdpPort>

const http = require('http');
const WebSocket = require('ws');

const cdpPort = parseInt(process.argv[2] || '51329', 10);

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
  const target = list.find(t => t.type === 'page' && t.url.includes('renderer/index.html'));
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
    console.log('[step] 通过 ipcMain.handle("create-session") 创建一个 claude session');
    const evalA = await send('Runtime.evaluate', {
      expression: `
        (async () => {
          const { ipcRenderer } = require('electron');
          const sess = await ipcRenderer.invoke('create-session', { kind: 'claude', opts: { title: 'probe-via-gui' } });
          return { id: sess.id, kind: sess.kind, title: sess.title };
        })()
      `,
      returnByValue: true,
      awaitPromise: true,
    });
    console.log('[gui-session]', JSON.stringify(evalA.result.value));
    const guiId = evalA.result.value.id;

    // 等 10 秒让 claude 启动
    console.log('[step] 等 10s 让 Claude CLI 在 PTY 里启动');
    await new Promise(r => setTimeout(r, 10000));

    const evalB = await send('Runtime.evaluate', {
      expression: `
        (async () => {
          const { ipcRenderer } = require('electron');
          const buf = await ipcRenderer.invoke('debug:get-session-buffer', '${guiId}');
          return { len: typeof buf === 'string' ? buf.length : 'N/A', tail: typeof buf === 'string' ? buf.slice(-400) : buf };
        })()
      `,
      returnByValue: true,
      awaitPromise: true,
    });
    console.log('[after-10s gui session buffer]', JSON.stringify(evalB.result.value, null, 2));

    // 关闭这个 probe session
    await send('Runtime.evaluate', {
      expression: `(async () => { const { ipcRenderer } = require('electron'); await ipcRenderer.invoke('close-session', '${guiId}'); })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    console.log('[done] 已关闭 probe session');
    ws.close();
    process.exit(0);
  });

  ws.on('error', (e) => { console.error('[ws err]', e.message); process.exit(1); });
}

main().catch((e) => { console.error('[main err]', e); process.exit(1); });
