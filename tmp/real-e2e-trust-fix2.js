'use strict';
// 给 Claude PTY 发 Enter 确认 trust prompt（用 terminal-input ipcRenderer.send）
const fs = require('fs');
const path = require('path');
const http = require('http');
const { connectCDP } = require('../tests/helpers/cdp-client');

const PORT = 9224;
const CLAUDE_SID = '9c377b90-7ac5-4734-ab06-0d5e45f4089b';

function gj(u) {
  return new Promise((r, e) => http.get(u, res => {
    let d = ''; res.on('data', c => d += c);
    res.on('end', () => { try { r(JSON.parse(d)); } catch (x) { r(null); } });
  }).on('error', e));
}

async function shot(client, label) {
  const fp = path.join(__dirname, `trust-fix2-${label}-${Date.now()}.png`);
  const r = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(fp, Buffer.from(r.data, 'base64'));
  console.log('  [shot]', fp);
  return fp;
}

(async () => {
  const list = await gj(`http://127.0.0.1:${PORT}/json/list`);
  const main = list.find(t => t.type === 'page' && (t.url || '').includes('index.html'));
  const client = await connectCDP(main.webSocketDebuggerUrl);
  await client.send('Runtime.enable');

  console.log('[step] send "1\\r" via terminal-input (ipcRenderer.send)');
  await client.eval(`(() => {
    const { ipcRenderer } = require('electron');
    // Claude trust prompt 默认选项是 1 (Yes, I trust this folder), 直接 Enter 应该确认
    ipcRenderer.send('terminal-input', { sessionId: '${CLAUDE_SID}', data: '\\r' });
    return 'sent_enter';
  })()`);
  await new Promise(r => setTimeout(r, 3000));

  console.log('[step] check Claude ready after Enter');
  let ready = false;
  for (let i = 0; i < 120; i++) {
    const r = await client.eval(`(async () => {
      const { ipcRenderer } = require('electron');
      return await ipcRenderer.invoke('cli-ready-status', '${CLAUDE_SID}');
    })()`);
    if (r === true) {
      ready = true;
      console.log(`  Claude ready @ ${(i * 0.5).toFixed(1)}s`);
      break;
    }
    if (i % 10 === 0) console.log(`  +${(i * 0.5).toFixed(1)}s ready=${r}`);
    await new Promise(r => setTimeout(r, 500));
  }

  await shot(client, 'after-enter');

  if (!ready) {
    console.log('[step] still not ready, dump PTY');
    const ptyTxt = await client.eval(`(() => {
      const rows = document.querySelectorAll('.xterm-rows > div');
      let txt = '';
      for (const r of rows) txt += (r.innerText || r.textContent || '') + '\\n';
      return txt.slice(0, 4000);
    })()`);
    console.log(ptyTxt);
    // 可能还需要再发 Enter（1M context onboarding）
    console.log('[step] try Enter again');
    await client.eval(`(() => {
      const { ipcRenderer } = require('electron');
      ipcRenderer.send('terminal-input', { sessionId: '${CLAUDE_SID}', data: '\\r' });
      return 'sent_enter2';
    })()`);
    await new Promise(r => setTimeout(r, 3000));
    for (let i = 0; i < 60; i++) {
      const r = await client.eval(`(async () => {
        const { ipcRenderer } = require('electron');
        return await ipcRenderer.invoke('cli-ready-status', '${CLAUDE_SID}');
      })()`);
      if (r === true) { ready = true; console.log(`  ready @ +${i * 0.5}s after second Enter`); break; }
      if (i % 10 === 0) console.log(`  ready=${r} +${i * 0.5}s`);
      await new Promise(r => setTimeout(r, 500));
    }
    await shot(client, 'after-enter2');
    if (!ready) {
      const ptyTxt2 = await client.eval(`(() => {
        const rows = document.querySelectorAll('.xterm-rows > div');
        let txt = '';
        for (const r of rows) txt += (r.innerText || r.textContent || '') + '\\n';
        return txt.slice(0, 4000);
      })()`);
      console.log('PTY after 2nd Enter:');
      console.log(ptyTxt2);
    }
  }

  console.log(ready ? 'CLAUDE_READY' : 'CLAUDE_STILL_NOT_READY');
  await client.close();
})().catch(e => { console.error(e); process.exit(1); });
