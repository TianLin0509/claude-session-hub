'use strict';
// 给 Claude PTY 发 Enter 确认 trust prompt → 等 ready → 发 prompt → 验 iframe
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
  const fp = path.join(__dirname, `trust-fix-${label}-${Date.now()}.png`);
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

  console.log('[step] send Enter to PTY via IPC pty-write');
  // 看 main.js 暴露什么 PTY write IPC
  const writeAttempt = await client.eval(`(async () => {
    const { ipcRenderer } = require('electron');
    const candidates = ['pty-write', 'pty-input', 'session-write', 'session-input', 'write-session', 'write-pty'];
    const out = {};
    for (const ch of candidates) {
      try {
        const r = await ipcRenderer.invoke(ch, '${CLAUDE_SID}', '\\r');
        out[ch] = { ok: true, result: r };
      } catch (e) {
        out[ch] = { err: e.message.slice(0, 100) };
      }
    }
    return out;
  })()`);
  console.log('  write attempts:', JSON.stringify(writeAttempt, null, 2));

  await new Promise(r => setTimeout(r, 2000));

  console.log('[step] check Claude ready after Enter');
  for (let i = 0; i < 60; i++) {
    const r = await client.eval(`(async () => {
      const { ipcRenderer } = require('electron');
      return await ipcRenderer.invoke('cli-ready-status', '${CLAUDE_SID}');
    })()`);
    if (r) {
      console.log(`  Claude ready @ ${i * 0.5}s`);
      break;
    }
    if (i % 5 === 0) console.log(`  +${(i * 0.5).toFixed(1)}s ready=${r}`);
    await new Promise(r => setTimeout(r, 500));
  }

  await shot(client, 'after-enter');

  console.log('[step] dump xterm rows');
  const ptyTxt = await client.eval(`(() => {
    const rows = document.querySelectorAll('.xterm-rows > div');
    let txt = '';
    for (const r of rows) {
      txt += (r.innerText || r.textContent || '') + '\\n';
    }
    return { rowCount: rows.length, txt: txt.slice(0, 4000) };
  })()`);
  console.log(ptyTxt.txt);

  await client.close();
})().catch(e => { console.error(e); process.exit(1); });
