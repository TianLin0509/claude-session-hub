'use strict';
const http = require('http'); const WebSocket = require('ws');
function getJson(p){return new Promise((r,j)=>http.get(`http://127.0.0.1:9334${p}`,res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>{try{r(JSON.parse(b))}catch(e){j(e)}})}).on('error',j))}
(async () => {
  const list = await getJson('/json/list');
  const target = list.find(t => t.url.includes('renderer/index.html'));
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let mid=0; const pending=new Map();
  const send = (m,p={})=>new Promise((r,j)=>{const id=++mid;pending.set(id,{r,j});ws.send(JSON.stringify({id,method:m,params:p}))});
  ws.on('message',raw=>{const m=JSON.parse(raw.toString());if(m.id&&pending.has(m.id)){const{r,j}=pending.get(m.id);pending.delete(m.id);if(m.error)j(m.error);else r(m.result)}});
  await new Promise(r=>ws.once('open',r));
  await send('Runtime.enable');
  console.log('[step] GUI IPC create-session claude');
  const created = await send('Runtime.evaluate', {
    expression: `(async()=>{const{ipcRenderer}=require('electron');try{const s=await ipcRenderer.invoke('create-session',{kind:'claude',opts:{title:'gui-on-95052'}});return{ok:true,id:s.id};}catch(e){return{ok:false,err:String(e)};}})()`,
    returnByValue: true, awaitPromise: true,
  });
  console.log('[created]', JSON.stringify(created.result.value));
  const id = created.result.value.id;
  if (!id) { ws.close(); process.exit(1); }
  await new Promise(r=>setTimeout(r,10000));
  const buf = await send('Runtime.evaluate', {
    expression: `(async()=>{const{ipcRenderer}=require('electron');const all=await ipcRenderer.invoke('get-sessions');const b=await ipcRenderer.invoke('debug:get-session-buffer','${id}');return {sessionCount: all.length, bufLen: typeof b==='string'?b.length:null, bufTail: typeof b==='string'?b.slice(-300):null};})()`,
    returnByValue: true, awaitPromise: true,
  });
  console.log('[after 10s]', JSON.stringify(buf.result.value, null, 2));
  await send('Runtime.evaluate', {
    expression: `(async()=>{const{ipcRenderer}=require('electron');await ipcRenderer.invoke('close-session','${id}');})()`,
    returnByValue: true, awaitPromise: true,
  });
  ws.close(); process.exit(0);
})();
