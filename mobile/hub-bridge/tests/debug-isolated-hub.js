'use strict';

// CDP attach isolated hub renderer (port 9226)，调 IPC 拿 sessionManager 状态
// 同时直接在 main 进程 evaluate（renderer 不能直接调 mobile-bridge module，需要走 main IPC）

const WebSocket = require('ws');
const http = require('http');

const CDP_PORT = 9226;

async function main() {
  const tabs = await new Promise((res, rej) => {
    http.get(`http://127.0.0.1:${CDP_PORT}/json`, (r) => {
      let body = '';
      r.on('data', c => body += c);
      r.on('end', () => res(JSON.parse(body)));
    }).on('error', rej);
  });
  console.log('tabs:', tabs.length);
  const tab = tabs.find(t => t.type === 'page');
  if (!tab) { console.error('no page'); return; }

  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (data) => {
    const m = JSON.parse(data.toString());
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  });

  async function ipcInvoke(channel, ...args) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({
        id, method: 'Runtime.evaluate',
        params: {
          expression: `(async () => { const { ipcRenderer } = require('electron'); return await ipcRenderer.invoke(${JSON.stringify(channel)}, ${args.map(JSON.stringify).join(',')}); })()`,
          awaitPromise: true, returnByValue: true,
        }
      }));
    }).then(r => {
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
      return r.result.value;
    });
  }

  // 拿所有 sessions
  const sessions = await ipcInvoke('get-sessions');
  console.log('Sessions:', sessions.length);
  sessions.forEach(s => console.log(`  - ${s.id || s.hubId} kind=${s.kind} title=${s.title}`));

  // 通过 evaluate 直接调 require('mobile-bridge') 看 binder 状态
  const debug = await new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({
      id, method: 'Runtime.evaluate',
      params: {
        expression: `
          (() => {
            try {
              if (typeof global !== 'undefined' && global.__mobileBridge) {
                const b = global.__mobileBridge;
                return {
                  hasGlobal: true,
                  hasListSessions: typeof b.listDevices === 'function',
                  devices: b.listDevices().length,
                };
              }
              return { hasGlobal: false };
            } catch (e) { return { error: e.message }; }
          })()
        `,
        returnByValue: true,
      }
    }));
  }).then(r => r.result.value);
  console.log('global.__mobileBridge:', JSON.stringify(debug, null, 2));

  ws.close();
}
main().catch(e => { console.error('FATAL', e.message); process.exit(1); });
