'use strict';
const http = require('http'); const WebSocket = require('ws');
const port = parseInt(process.argv[2] || '9333', 10);
function getJson(p){return new Promise((r,j)=>http.get(`http://127.0.0.1:${port}${p}`,res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>{try{r(JSON.parse(b))}catch(e){j(e)}})}).on('error',j))}
(async () => {
  const list = await getJson('/json/list');
  const target = list.find(t => t.type === 'page');
  console.log('[target url]', target.url);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let mid=0; const pending=new Map();
  const send = (m,p={})=>new Promise((r,j)=>{const id=++mid;pending.set(id,{r,j});ws.send(JSON.stringify({id,method:m,params:p}))});
  ws.on('message',raw=>{const m=JSON.parse(raw.toString());if(m.id&&pending.has(m.id)){const{r,j}=pending.get(m.id);pending.delete(m.id);if(m.error)j(m.error);else r(m.result)}});
  await new Promise(r=>ws.once('open',r));
  await send('Runtime.enable');
  const result = await send('Runtime.evaluate', {
    expression: `
      (async () => {
        try {
          const { ipcRenderer } = require('electron');
          const sessions = await ipcRenderer.invoke('get-sessions');
          return { ok: true, type: typeof sessions, isArray: Array.isArray(sessions), count: Array.isArray(sessions) ? sessions.length : null, sample: Array.isArray(sessions) ? sessions.slice(0, 2) : sessions };
        } catch (e) {
          return { ok: false, err: String(e) };
        }
      })()
    `,
    returnByValue: true, awaitPromise: true,
  });
  console.log(JSON.stringify(result.result.value, null, 2));
  ws.close(); process.exit(0);
})();
