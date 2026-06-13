'use strict';
const http = require('http');
const WebSocket = require('ws');
const focusId = process.argv[2] || '401f0118-8204-4616-a2b3-9bcd5c95a879';
const port = 51329;
function getJson(p) { return new Promise((r, j) => http.get(`http://127.0.0.1:${port}${p}`, res => { let b=''; res.on('data',c=>b+=c); res.on('end',()=>{try{r(JSON.parse(b))}catch(e){j(e)}});}).on('error',j)); }
(async () => {
  const list = await getJson('/json/list');
  const target = list.find(t => t.type === 'page' && t.url.includes('renderer/index.html'));
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let msgId = 0; const pending = new Map();
  const send = (m, p={}) => new Promise((r,j) => { const id=++msgId; pending.set(id,{r,j}); ws.send(JSON.stringify({id, method:m, params:p})); });
  ws.on('message', raw => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { const {r,j}=pending.get(m.id); pending.delete(m.id); if(m.error)j(m.error);else r(m.result);}});
  await new Promise(r => ws.once('open', r));
  await send('Runtime.enable');
  // 让 main 通过 IPC 反射 sessionManager.sessions.get(id) 的 pty.pid + killed
  const result = await send('Runtime.evaluate', {
    expression: `(async () => {
      const { ipcRenderer } = require('electron');
      // 复用 'restart-session' 之前 _toPublic 的 info；info 不暴露 pty。
      // 用 webContents.send → main process 反射太复杂。
      // 直接调 'get-sessions' 拿 info（虽无 pty 字段），再用 debug:get-session-buffer 印证活性
      const all = await ipcRenderer.invoke('get-sessions');
      const target = (all || []).find(s => s.id === '${focusId}');
      const buf = await ipcRenderer.invoke('debug:get-session-buffer', '${focusId}');
      return { found: !!target, info: target || null, bufferLen: typeof buf === 'string' ? buf.length : null };
    })()`,
    returnByValue: true, awaitPromise: true,
  });
  console.log(JSON.stringify(result.result.value, null, 2));
  ws.close(); process.exit(0);
})();
