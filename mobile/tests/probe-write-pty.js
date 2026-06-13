'use strict';
const http = require('http'); const WebSocket = require('ws');
const port = parseInt(process.argv[2] || '9334', 10);
const sid = process.argv[3];
function getJson(p){return new Promise((r,j)=>http.get(`http://127.0.0.1:${port}${p}`,res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>{try{r(JSON.parse(b))}catch(e){j(e)}})}).on('error',j))}
(async () => {
  const list = await getJson('/json/list');
  const target = list.find(t => t.url.includes('renderer/index.html'));
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let mid=0; const pending=new Map();
  const send = (m,p={})=>new Promise((r,j)=>{const id=++mid;pending.set(id,{r,j});ws.send(JSON.stringify({id,method:m,params:p}))});
  ws.on('message',raw=>{const m=JSON.parse(raw.toString());if(m.id&&pending.has(m.id)){const{r,j}=pending.get(m.id);pending.delete(m.id);if(m.error)j(m.error);else r(m.result)}});
  await new Promise(r=>ws.once('open',r));
  await send('Runtime.enable');
  // ipcMain.on terminal-input 是个 on 不是 handle
  await send('Runtime.evaluate', {
    expression: `
      (() => {
        const { ipcRenderer } = require('electron');
        ipcRenderer.send('terminal-input', { sessionId: '${sid}', data: 'Get-Date\\r' });
        return 'sent';
      })()
    `,
    returnByValue: true,
  });
  console.log('[sent] Get-Date\\r');
  await new Promise(r => setTimeout(r, 3000));
  const buf = await send('Runtime.evaluate', {
    expression: `(async()=>{const{ipcRenderer}=require('electron');const b=await ipcRenderer.invoke('debug:get-session-buffer','${sid}');return {len: typeof b==='string'?b.length:null, tail: typeof b==='string'?b.slice(-300):null};})()`,
    returnByValue: true, awaitPromise: true,
  });
  console.log('[buffer after write]', JSON.stringify(buf.result.value, null, 2));
  ws.close(); process.exit(0);
})();
