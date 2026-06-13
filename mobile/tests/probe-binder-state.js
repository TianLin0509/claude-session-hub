'use strict';
const http = require('http'); const WebSocket = require('ws');
const port = parseInt(process.argv[2] || '9335', 10);
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
  // 用 ipcMain.handle('debug:get-mobile-binder-state') 但没有
  // 替代：从 renderer 跑代码访问 global.__mobileBridge?
  const result = await send('Runtime.evaluate', {
    expression: `
      (() => {
        try {
          // global.__mobileBridge 是 main 设的，但 renderer 没法直接访问 main 的 global
          // 我们用 process.mainModule? 不行 — renderer 是隔离 context
          // 直接通过 require 拿 main 的对象，行不通
          // 但 ipcRenderer 可以传一个新 handler 名让 main 反射
          return { has_global: typeof global !== 'undefined', has_ipc: typeof require !== 'undefined' && !!require('electron').ipcRenderer };
        } catch (e) { return { err: String(e) }; }
      })()
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(result.result.value));

  // 通过 ipcRenderer 调一个不存在的 handle 看错误，然后用 sendSync hack
  // 实际上最简单：直接在 renderer 加 IPC bridge 临时 inject 一个 handler 不可能 — handler 由 main 注册
  // 唯一方法：让 main 注册 dump handler。需要重启 hub 才能加 handler
  // 所以这里换个角度：从 transcript 看消息发送时间，确认 turn-complete 是否触发过

  console.log('---');
  // 看 ac3410f5 session 的 transcript 末几条 user/assistant message 时间
  const focusInfo = await send('Runtime.evaluate', {
    expression: `(async()=>{const{ipcRenderer}=require('electron');const all=await ipcRenderer.invoke('get-sessions');const s = all.find(x=>x.id==='ac3410f5-0493-40e6-86e9-4cb1e4880ed0');return s||null})()`,
    returnByValue: true, awaitPromise: true,
  });
  console.log('ac3410 session info:', JSON.stringify(focusInfo.result.value));

  ws.close(); process.exit(0);
})();
