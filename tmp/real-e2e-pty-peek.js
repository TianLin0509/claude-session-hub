'use strict';
// 看 Claude PTY 的真实输出，诊断卡在哪
const fs = require('fs');
const path = require('path');
const http = require('http');
const { connectCDP } = require('../tests/helpers/cdp-client');

const PORT = 9224;

function gj(u) {
  return new Promise((r, e) => http.get(u, res => {
    let d = ''; res.on('data', c => d += c);
    res.on('end', () => { try { r(JSON.parse(d)); } catch (x) { r(null); } });
  }).on('error', e));
}

(async () => {
  const list = await gj(`http://127.0.0.1:${PORT}/json/list`);
  const main = list.find(t => t.type === 'page' && (t.url || '').includes('index.html'));
  const client = await connectCDP(main.webSocketDebuggerUrl);
  await client.send('Runtime.enable');

  // 找 Claude sub session 然后 通过 IPC 拉 PTY 历史
  const sessions = await client.eval(`(async () => {
    const { ipcRenderer } = require('electron');
    const ms = await ipcRenderer.invoke('get-meetings');
    const m = ms[ms.length - 1];
    return m.subSessions;
  })()`);
  console.log('subs:', sessions);

  // 试 'get-session-output' / 'get-pty-history' 等可能的 IPC
  const peek = await client.eval(`(async () => {
    const { ipcRenderer } = require('electron');
    const candidates = ['get-session-output', 'get-pty-history', 'get-pty-buffer', 'get-session-buffer', 'session-get-buffer', 'get-session-history'];
    const out = {};
    for (const ch of candidates) {
      try {
        const r = await ipcRenderer.invoke(ch, '9c377b90-7ac5-4734-ab06-0d5e45f4089b');
        out[ch] = { ok: true, type: typeof r, len: typeof r === 'string' ? r.length : (r && r.length) || JSON.stringify(r || {}).length };
      } catch (e) {
        out[ch] = { err: e.message.slice(0, 100) };
      }
    }
    return out;
  })()`);
  console.log('IPC peek:', JSON.stringify(peek, null, 2));

  // 切 PTY 视图看实际终端
  await client.eval(`(() => {
    const claudeCard = document.querySelector('.mr-ft[data-ft-kind="claude"]');
    if (claudeCard) {
      // 双击或单击进入 detail（看 meeting-room.js 怎么 zoom）
      claudeCard.click();
    }
    return null;
  })()`);
  await new Promise(r => setTimeout(r, 1500));

  const fp = path.join(__dirname, `pty-peek-${Date.now()}.png`);
  const r = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(fp, Buffer.from(r.data, 'base64'));
  console.log('shot:', fp);

  // 看 zoom 后是否有 PTY 元素
  const zoom = await client.eval(`(() => {
    const xterm = document.querySelector('.xterm-screen, .xterm-rows, [class*="xterm"]');
    const ftZoom = document.querySelector('.mr-ft-zoom, [class*="zoom"]');
    const allText = document.body.innerText.slice(0, 2000);
    return { hasXterm: !!xterm, hasZoom: !!ftZoom, bodyText: allText };
  })()`);
  console.log('zoom state:', JSON.stringify(zoom, null, 2).slice(0, 3000));

  await client.close();
})().catch(e => { console.error(e); process.exit(1); });
