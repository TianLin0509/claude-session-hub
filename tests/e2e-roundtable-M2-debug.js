'use strict';
// M2-debug: 复现 M2 失败现象，dump PTY ringBuffer / sessions state / hub stdout

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('../node_modules/ws');

const HUB_DIR = path.resolve(__dirname, '..');
const ELECTRON = path.join(HUB_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const TEMP_DATA = 'C:\\Users\\lintian\\AppData\\Local\\Temp\\hub-e2e-M2-debug';
const CDP_PORT = parseInt(process.env.CDP_PORT || '9252', 10);
const HUB_LOG = 'C:\\Users\\lintian\\AppData\\Local\\Temp\\hub-e2e-M2-debug.log';
const PROMPT = '用三种角度分析「为什么需要多 AI 圆桌」';

let _id = 0;
function rpc(ws, m, p = {}, t = 25000) {
  const i = ++_id;
  return new Promise((res, rej) => {
    const f = raw => { let m; try { m = JSON.parse(raw); } catch { return; } if (m.id === i) { ws.removeListener('message', f); m.error ? rej(new Error(JSON.stringify(m.error).slice(0, 200))) : res(m.result); } };
    ws.on('message', f);
    ws.send(JSON.stringify({ id: i, method: m, params: p }));
    setTimeout(() => { ws.removeListener('message', f); rej(new Error(m + ' timeout')); }, t);
  });
}
async function ev(ws, x, t) {
  const r = await rpc(ws, 'Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }, t);
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
}
function gj(u) { return new Promise((r, e) => http.get(u, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try { r(JSON.parse(d)); } catch(x){r(null);} }); }).on('error', e)); }

(async () => {
  try { fs.rmSync(TEMP_DATA, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(TEMP_DATA, { recursive: true });
  const logFD = fs.openSync(HUB_LOG, 'w');
  const proc = spawn(ELECTRON, ['.', `--remote-debugging-port=${CDP_PORT}`], {
    cwd: HUB_DIR, env: { ...process.env, CLAUDE_HUB_DATA_DIR: TEMP_DATA },
    stdio: ['ignore', logFD, logFD],
  });

  let ready = false;
  const checkReady = () => { try { return fs.readFileSync(HUB_LOG, 'utf8').includes('hook server listening'); } catch { return false; } };
  for (let i = 0; i < 30 && !ready; i++) { await new Promise(r => setTimeout(r, 1000)); ready = checkReady(); }
  console.log('[setup] hub ready, log =', HUB_LOG);

  let list;
  for (let i = 0; i < 20; i++) {
    list = await gj(`http://127.0.0.1:${CDP_PORT}/json/list`).catch(() => null);
    if (list) break;
    await new Promise(r => setTimeout(r, 500));
  }
  const main = list.find(t => t.type === 'page' && t.url.includes('index.html'));
  const ws = new WebSocket(main.webSocketDebuggerUrl);
  await new Promise((r, e) => { ws.on('open', r); ws.on('error', e); });
  await rpc(ws, 'Page.enable');
  await rpc(ws, 'Runtime.enable');
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.method === 'Page.javascriptDialogOpening') {
      ws.send(JSON.stringify({ id: ++_id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
    }
  });
  for (let i = 0; i < 30; i++) {
    const r = await ev(ws, `(() => ({ hasFn: typeof window.openMeetingCreateModal === 'function', hasBtn: !!document.getElementById('btn-roundtable') }))()`).catch(() => ({}));
    if (r.hasFn && r.hasBtn) break;
    await new Promise(r => setTimeout(r, 500));
  }

  console.log('\n[step1] create roundtable');
  await ev(ws, `document.getElementById('btn-roundtable').click()`);
  await new Promise(r => setTimeout(r, 1500));
  await ev(ws, `document.querySelector('#meeting-create-modal .mcm-create').click()`);

  // 等 ready
  let meetingId = null, subs = null;
  for (let i = 0; i < 60; i++) {
    const r = await ev(ws, `(async () => { const { ipcRenderer } = require('electron'); const ms = await ipcRenderer.invoke('get-meetings') || []; const m = ms[ms.length - 1]; if (!m || (m.subSessions||[]).length !== 3) return null; const ready={}; for (const sid of m.subSessions) ready[sid] = await ipcRenderer.invoke('cli-ready-status', sid); return { meetingId: m.id, subs: m.subSessions, ready }; })()`, 5000).catch(() => null);
    if (r && Object.values(r.ready).every(v => v)) {
      meetingId = r.meetingId; subs = r.subs;
      console.log(`  ready @ ${i}s`);
      break;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!subs) { console.log('!! no subs ready'); proc.kill(); process.exit(1); }

  // === diagnostic: PTY buffer 在 ready 时 ===
  console.log('\n[diag-1] PTY ringBuffer at "ready"');
  const buf1 = await ev(ws, `(async () => {
    const { ipcRenderer } = require('electron');
    const out = {};
    for (const sid of ${JSON.stringify(subs)}) {
      try { out[sid] = (await ipcRenderer.invoke('get-session-buffer', sid) || '').slice(-800); } catch (e) { out[sid] = 'ERR: ' + e.message; }
    }
    return out;
  })()`, 10000);
  for (const sid in buf1) {
    console.log(`--- sub ${sid} buffer (last 800) ---`);
    console.log(buf1[sid] || '(empty)');
  }

  // === step 2: 输入 + 发送 ===
  console.log('\n[step2] inject prompt + click send');
  await ev(ws, `(() => {
    const ib = document.getElementById('mr-input-box');
    ib.focus();
    ib.textContent = ${JSON.stringify(PROMPT)};
    ib.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await new Promise(r => setTimeout(r, 200));
  await ev(ws, `document.getElementById('mr-send-btn').click()`);

  // === step 3: 等 5s 看 PTY 是否有 prompt 进入 ===
  await new Promise(r => setTimeout(r, 5000));
  console.log('\n[diag-2] PTY ringBuffer at +5s after send');
  const buf2 = await ev(ws, `(async () => {
    const { ipcRenderer } = require('electron');
    const out = {};
    for (const sid of ${JSON.stringify(subs)}) {
      try { out[sid] = (await ipcRenderer.invoke('get-session-buffer', sid) || '').slice(-1500); } catch (e) { out[sid] = 'ERR: ' + e.message; }
    }
    return out;
  })()`, 10000);
  for (const sid in buf2) {
    console.log(`--- sub ${sid} buffer +5s (last 1500) ---`);
    console.log((buf2[sid] || '(empty)').slice(-1500));
  }

  // === step 4: 等 25s 看 streaming preview ===
  await new Promise(r => setTimeout(r, 25000));
  console.log('\n[diag-3] cards + buffers at +30s');
  const cards = await ev(ws, `(() => Array.from(document.querySelectorAll('.mr-ft[data-ft-sid]')).map(c => ({
    kind: c.getAttribute('data-ft-kind'),
    sid: c.getAttribute('data-ft-sid'),
    status: c.querySelector('.mr-ft-status')?.className.match(/mr-ft-status (\\w+)/)?.[1],
    previewLen: (c.querySelector('.mr-ft-preview')?.textContent.trim() || '').length,
    previewSnip: (c.querySelector('.mr-ft-preview')?.textContent || '').trim().slice(0, 100),
  })))()`);
  console.log('cards =', JSON.stringify(cards, null, 2));

  const buf3 = await ev(ws, `(async () => {
    const { ipcRenderer } = require('electron');
    const out = {};
    for (const sid of ${JSON.stringify(subs)}) {
      try { out[sid] = (await ipcRenderer.invoke('get-session-buffer', sid) || '').slice(-2000); } catch (e) { out[sid] = 'ERR: ' + e.message; }
    }
    return out;
  })()`, 10000);
  for (const sid in buf3) {
    console.log(`--- sub ${sid} buffer +30s (last 2000) ---`);
    console.log((buf3[sid] || '(empty)').slice(-2000));
  }

  // hub log dump
  console.log('\n[diag-hub-log last 3000 chars]');
  try {
    const log = fs.readFileSync(HUB_LOG, 'utf8');
    console.log(log.slice(-3000));
  } catch (e) {
    console.log('hub log read fail:', e.message);
  }

  ws.close();
  proc.kill();
  process.exit(0);
})().catch(e => { console.error('FATAL', e.message); console.error(e.stack); process.exit(1); });
