'use strict';
const http = require('http'); const WebSocket = require('ws');
const port = parseInt(process.argv[2] || '9333', 10);
function getJson(p){return new Promise((r,j)=>http.get(`http://127.0.0.1:${port}${p}`,res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>{try{r(JSON.parse(b))}catch(e){j(e)}})}).on('error',j))}
(async () => {
  const list = await getJson('/json/list');
  const target = list.find(t => t.type === 'page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let mid=0; const pending=new Map();
  const send = (m,p={})=>new Promise((r,j)=>{const id=++mid;pending.set(id,{r,j});ws.send(JSON.stringify({id,method:m,params:p}))});
  ws.on('message',raw=>{const m=JSON.parse(raw.toString());if(m.id&&pending.has(m.id)){const{r,j}=pending.get(m.id);pending.delete(m.id);if(m.error)j(m.error);else r(m.result)}});
  await new Promise(r=>ws.once('open',r));
  const hubPath = 'file:///C:/Users/lintian/claude-session-hub/renderer/index.html';
  console.log('[navigate]', hubPath);
  await send('Page.enable');
  await send('Page.navigate', { url: hubPath });
  await new Promise(r => setTimeout(r, 3000));
  const list2 = await getJson('/json/list');
  console.log('[new url]', list2[0].url);
  ws.close(); process.exit(0);
})();
