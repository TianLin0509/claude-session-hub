'use strict';
// CDP E2E Step 5: 最终截图 + 关键 state 总结

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CDP = 'http://127.0.0.1:9229';
const ARTIFACT_DIR = 'C:\\Users\\lintian\\Desktop\\claude-artifacts';

function get(url) {
  return new Promise((res, rej) => {
    http.get(url, (r) => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>res(d)); }).on('error', rej);
  });
}
function newCdp(u) {
  const ws = new WebSocket(u); let id=1; const p=new Map();
  return new Promise(ok => {
    ws.on('open', () => ok({
      send(m, x={}) { const i=id++; return new Promise((r,rj)=>{p.set(i,{r,rj});ws.send(JSON.stringify({id:i,method:m,params:x}));}); },
      close() { ws.close(); },
    }));
    ws.on('message', raw => {
      const m=JSON.parse(raw.toString());
      if (m.id && p.has(m.id)) { const {r,rj}=p.get(m.id); p.delete(m.id); if (m.error) rj(new Error(m.error.message)); else r(m.result); }
    });
  });
}

(async () => {
  const ts = JSON.parse(await get(`${CDP}/json/list`));
  const t = ts.find(x => x.type === 'page');
  const cdp = await newCdp(t.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // 触发 UI 重渲染（确保 meeting 列表出现在 sidebar）
  await cdp.send('Runtime.evaluate', {
    expression: `window.dispatchEvent(new Event('focus'));`,
  });
  await new Promise(r => setTimeout(r, 500));

  // 最终截图
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const p1 = path.join(ARTIFACT_DIR, 'p0-2-hub-after-meeting-created.png');
  fs.writeFileSync(p1, Buffer.from(shot.data, 'base64'));
  console.log(`screenshot: ${p1} (${(fs.statSync(p1).size / 1024).toFixed(1)} KB)`);

  cdp.close();
})().catch(e => { console.error(e.message); process.exit(1); });
