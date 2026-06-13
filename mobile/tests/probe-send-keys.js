'use strict';
// 给指定 Hub 会话 PTY 写按键。用法: node probe-send-keys.js <cdpPort> <sessionId> <text>（\r 用 {ENTER} 占位）
const { Cdp } = require('./e2e-remote-cdp-lib');
(async () => {
  const [port, sid, ...rest] = process.argv.slice(2);
  const text = rest.join(' ').replace(/\{ENTER\}/g, '\r');
  const cdp = new Cdp();
  await cdp.connect(port);
  await cdp.eval(`(()=>{const{ipcRenderer}=require('electron');ipcRenderer.send('terminal-input',{sessionId:${JSON.stringify(sid)},data:${JSON.stringify(text)}});return 'ok'})()`);
  console.log('sent:', JSON.stringify(text));
  cdp.close();
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
