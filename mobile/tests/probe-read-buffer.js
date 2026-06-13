'use strict';
// 读指定 Hub 会话的 PTY ring buffer 尾部。用法: node probe-read-buffer.js <cdpPort> <sessionId> [tailLen]
const { Cdp } = require('./e2e-remote-cdp-lib');
(async () => {
  const [port, sid, tailLen] = process.argv.slice(2);
  const cdp = new Cdp();
  await cdp.connect(port);
  const v = await cdp.eval(`(async()=>{const{ipcRenderer}=require('electron');const b=await ipcRenderer.invoke('debug:get-session-buffer','${sid}');return {len: typeof b==='string'?b.length:null, tail: typeof b==='string'?b.slice(-${tailLen || 1500}):null};})()`);
  console.log('len=', v.len);
  console.log('--- tail ---');
  console.log((v.tail || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, ''));
  cdp.close();
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
