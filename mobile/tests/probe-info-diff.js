'use strict';
const http = require('http'); const WebSocket = require('ws'); const crypto = require('crypto');
function getJson(p){return new Promise((r,j)=>http.get(`http://127.0.0.1:51329${p}`,res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>{try{r(JSON.parse(b))}catch(e){j(e)}})}).on('error',j))}
(async () => {
  const list = await getJson('/json/list');
  const target = list.find(t => t.url.includes('renderer/index.html'));
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let mid=0; const pending=new Map();
  const send = (m,p={})=>new Promise((r,j)=>{const id=++mid;pending.set(id,{r,j});ws.send(JSON.stringify({id,method:m,params:p}))});
  ws.on('message',raw=>{const m=JSON.parse(raw.toString());if(m.id&&pending.has(m.id)){const{r,j}=pending.get(m.id);pending.delete(m.id);if(m.error)j(m.error);else r(m.result)}});
  await new Promise(r=>ws.once('open',r));
  await send('Runtime.enable');

  // 用 GUI 路径建一个，全 info dump
  const guiId = crypto.randomUUID();
  await send('Runtime.evaluate',{expression:`(async()=>{const{ipcRenderer}=require('electron');await ipcRenderer.invoke('create-session',{kind:'claude',opts:{id:'${guiId}',title:'probe-gui'}})})()`,returnByValue:true,awaitPromise:true});
  await new Promise(r=>setTimeout(r,1500));
  const guiInfo = await send('Runtime.evaluate',{expression:`(async()=>{const{ipcRenderer}=require('electron');const all=await ipcRenderer.invoke('get-sessions');return all.find(s=>s.id==='${guiId}')})()`,returnByValue:true,awaitPromise:true});

  // Mobile 路径 b4edefcf 信息
  const mobileId = '401f0118-8204-4616-a2b3-9bcd5c95a879';
  const mobileInfo = await send('Runtime.evaluate',{expression:`(async()=>{const{ipcRenderer}=require('electron');const all=await ipcRenderer.invoke('get-sessions');return all.find(s=>s.id==='${mobileId}')})()`,returnByValue:true,awaitPromise:true});

  console.log('=== GUI created (Claude should be running) ===');
  console.log(JSON.stringify(guiInfo.result.value, null, 2));
  console.log('\n=== Mobile created (Claude is stuck) ===');
  console.log(JSON.stringify(mobileInfo.result.value, null, 2));

  // 清理
  await send('Runtime.evaluate',{expression:`(async()=>{const{ipcRenderer}=require('electron');await ipcRenderer.invoke('close-session','${guiId}')})()`,returnByValue:true,awaitPromise:true});
  ws.close();process.exit(0);
})();
