'use strict';
// 通过 renderer evaluate 跑代码访问 main 的 global.__mobileBridge.binder.sessionSubscribers
// 用 ipcRenderer.invoke 不行，需要 main 注册 handler。但 hub 启动时 main.js 把 mobileBridge
// 挂到 global.__mobileBridge — 我们让 main process 通过 webContents.executeJavaScript
// 是反过来的。不行。
// 方法：让 main process 自己跑一段代码。可以通过 webContents.executeJavaScript on remote
// 但需要 ipcMain 注册新 handler。
// 唯一可用：让 main 自己往 webContents.send debug-mobile-state，由 renderer 反弹。
// 但 main 不主动跑。
// 实际可行：用 require('electron-remote') 不可用（renderer 不能 require electron main 模块）
//
// 最终方案：从 renderer 用 ipcRenderer.send 触发一个 ipcMain.on 事件。但没注册 handler。
//
// 干脆从 renderer 调 process.mainModule? 不行 renderer context 隔离
//
// 直接 evaluate 看 window.electron / __mobileBridge 全局：renderer 不能直接访问 main 的 global
//
// 让我换最直接的：让 renderer 调用一个**已存在**的 IPC handler 间接验证：
// - debug:get-session-buffer 看 ac3410f5 PTY buffer，看 Claude 回复后的内容是否产出
// - get-sessions 看 session info
const http = require('http'); const WebSocket = require('ws');
function getJson(p){return new Promise((r,j)=>http.get(`http://127.0.0.1:9335${p}`,res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>{try{r(JSON.parse(b))}catch(e){j(e)}})}).on('error',j))}
(async () => {
  const list = await getJson('/json/list');
  const target = list.find(t => t.url.includes('renderer/index.html'));
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let mid=0; const pending=new Map();
  const send = (m,p={})=>new Promise((r,j)=>{const id=++mid;pending.set(id,{r,j});ws.send(JSON.stringify({id,method:m,params:p}))});
  ws.on('message',raw=>{const m=JSON.parse(raw.toString());if(m.id&&pending.has(m.id)){const{r,j}=pending.get(m.id);pending.delete(m.id);if(m.error)j(m.error);else r(m.result)}});
  await new Promise(r=>ws.once('open',r));
  await send('Runtime.enable');
  // 让 renderer evaluate process.mainModule 不行（隔离）
  // 但能用 ipcRenderer.sendSync 触发同步事件，main 端没注册响应不会卡（会返回 undefined）
  // 实际上 ipcRenderer 在 renderer process。但 hub 的 preload 没 expose 任何 mobile dump 接口。
  // 我用最 hacky 方法：通过 evaluate 在 renderer 跑 ipcRenderer.invoke('debug:dump-mobile-state')
  // 然后看是不是 already registered。
  const r = await send('Runtime.evaluate', {
    expression: `(async()=>{
      const {ipcRenderer}=require('electron');
      try {
        // 看是否已有 mobile-dump-state handler（main.js 没注册）
        return await ipcRenderer.invoke('mobile-dump-state');
      } catch(e) { return { err: String(e) }; }
    })()`,
    returnByValue: true, awaitPromise: true,
  });
  console.log(JSON.stringify(r.result.value, null, 2));
  ws.close(); process.exit(0);
})();
