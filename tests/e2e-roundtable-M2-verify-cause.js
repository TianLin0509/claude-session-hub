'use strict';
// systematic-debugging Phase 3：验证假设
// 假设：M2 失败因 cli-ready 太早，CLI 实际还在 OAuth 中就被发 prompt → 吃掉
// 验证：在 ready 之后 sleep 60s 给 OAuth 充分时间，再发 prompt
// 如果通过 → root cause 确认；如果仍失败 → 别的根因

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('../node_modules/ws');

const HUB_DIR = path.resolve(__dirname, '..');
const ELECTRON = path.join(HUB_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const TEMP_DATA = 'C:\\Users\\lintian\\AppData\\Local\\Temp\\hub-e2e-M2-verify';
const HUB_LOG = 'C:\\Users\\lintian\\AppData\\Local\\Temp\\hub-e2e-M2-verify.log';
const CDP_PORT = parseInt(process.env.CDP_PORT || '9253', 10);
const PROMPT = '用三种角度分析「为什么需要多 AI 圆桌」';
const SLEEP_AFTER_READY_MS = 60000;

let _id = 0;
let pass = 0, fail = 0;
function check(cond, msg, details) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (details ? ' — ' + JSON.stringify(details).slice(0, 200) : '')); }
}
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
  const checkReady = () => { try { return fs.readFileSync(HUB_LOG, 'utf8').includes('hook server listening'); } catch { return false; } };
  for (let i = 0; i < 30 && !checkReady(); i++) await new Promise(r => setTimeout(r, 1000));

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
    if (m.method === 'Page.javascriptDialogOpening') ws.send(JSON.stringify({ id: ++_id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
  });
  for (let i = 0; i < 30; i++) {
    const r = await ev(ws, `(() => ({ hasFn: typeof window.openMeetingCreateModal === 'function', hasBtn: !!document.getElementById('btn-roundtable') }))()`).catch(() => ({}));
    if (r.hasFn && r.hasBtn) break;
    await new Promise(r => setTimeout(r, 500));
  }

  console.log('[create roundtable]');
  await ev(ws, `document.getElementById('btn-roundtable').click()`);
  await new Promise(r => setTimeout(r, 1500));
  await ev(ws, `document.querySelector('#meeting-create-modal .mcm-create').click()`);

  let meetingId = null;
  for (let i = 0; i < 60; i++) {
    const r = await ev(ws, `(async () => { const { ipcRenderer } = require('electron'); const ms = await ipcRenderer.invoke('get-meetings') || []; const m = ms[ms.length - 1]; if (!m || (m.subSessions||[]).length !== 3) return null; const ready={}; for (const sid of m.subSessions) ready[sid] = await ipcRenderer.invoke('cli-ready-status', sid); return { meetingId: m.id, ready }; })()`, 5000).catch(() => null);
    if (r && Object.values(r.ready).every(v => v)) { meetingId = r.meetingId; break; }
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log(`  ready meetingId=${meetingId}`);
  if (!meetingId) { proc.kill(); process.exit(1); }

  // ★ KEY DIFF：sleep 60s 给 OAuth 充分时间
  console.log(`\n[KEY] sleep ${SLEEP_AFTER_READY_MS / 1000}s for real OAuth completion`);
  for (let i = 1; i <= SLEEP_AFTER_READY_MS / 5000; i++) {
    await new Promise(r => setTimeout(r, 5000));
    process.stdout.write(`  +${i*5}s `);
  }
  console.log();

  // 现在发 prompt
  console.log('\n[send prompt]');
  await ev(ws, `(() => {
    const ib = document.getElementById('mr-input-box');
    ib.focus();
    ib.textContent = ${JSON.stringify(PROMPT)};
    ib.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await new Promise(r => setTimeout(r, 200));
  await ev(ws, `document.getElementById('mr-send-btn').click()`);

  // 轮询 30s 看是否产出 token
  console.log('\n[wait token (60s)]');
  let anyTextSeen = { claude: false, gemini: false, codex: false };
  const startStream = Date.now();
  while (Date.now() - startStream < 60000) {
    const r = await ev(ws, `(() => Array.from(document.querySelectorAll('.mr-ft[data-ft-sid]')).map(c => ({
      kind: c.getAttribute('data-ft-kind'),
      status: c.querySelector('.mr-ft-status')?.className.match(/mr-ft-status (\\w+)/)?.[1],
      previewLen: (c.querySelector('.mr-ft-preview')?.textContent.trim() || '').length,
    })))()`).catch(() => []);
    for (const c of r) if (c.previewLen > 0) anyTextSeen[c.kind] = true;
    if (anyTextSeen.claude && anyTextSeen.gemini && anyTextSeen.codex) break;
    if (((Date.now() - startStream) / 5000) % 1 < 0.2) console.log(`  +${((Date.now() - startStream) / 1000).toFixed(0)}s text=${JSON.stringify(anyTextSeen)} cards=${JSON.stringify(r.map(x => ({k:x.kind,s:x.status,l:x.previewLen})))}`);
    await new Promise(r => setTimeout(r, 1500));
  }

  check(anyTextSeen.claude, 'claude 卡片出现 token (after 60s sleep)', anyTextSeen);
  check(anyTextSeen.gemini, 'gemini 卡片出现 token (after 60s sleep)');
  check(anyTextSeen.codex, 'codex 卡片出现 token (after 60s sleep)');

  // hub log dump
  console.log('\n[hub log fanout-sent entries]');
  try {
    const log = fs.readFileSync(HUB_LOG, 'utf8');
    const sentLines = log.split('\n').filter(l => /turn 1 fanout sent|zero-echo|skipped \(not ready\)/.test(l));
    sentLines.forEach(l => console.log('  ' + l.slice(0, 200)));
  } catch (e) { console.log('hub log read fail'); }

  ws.close();
  proc.kill();

  console.log(`\n=== Result: ${pass} passed, ${fail} failed ===`);
  console.log(fail === 0 ? '✅ Hypothesis CONFIRMED: cli-ready too early' : '❌ Hypothesis REJECTED: 60s sleep not enough or different root cause');
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('FATAL', e.message); process.exit(2); });
