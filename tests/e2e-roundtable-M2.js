'use strict';
// M2: 中文输入"用三种角度分析「为什么需要多 AI 圆桌」"，回车
// 断言：3 家都进入 streaming；每张卡片 30 秒内出现 ≥1 个 token；
//       timeline 出现一条新 turn；输入框被清空。

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('../node_modules/ws');

const HUB_DIR = path.resolve(__dirname, '..');
const ELECTRON = path.join(HUB_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const TEMP_DATA = process.env.HUB_DATA || 'C:\\Users\\lintian\\AppData\\Local\\Temp\\hub-e2e-M2';
const CDP_PORT = parseInt(process.env.CDP_PORT || '9251', 10);
const SCREENSHOT_DIR = path.join(__dirname, 'screenshots', 'e2e-roundtable');
const PROMPT = '用三种角度分析「为什么需要多 AI 圆桌」';

let _id = 0;
let pass = 0, fail = 0;
const failures = [];
function check(cond, msg, details) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; failures.push({ msg, details }); console.log('  ✗ ' + msg + (details ? ' — ' + JSON.stringify(details).slice(0, 200) : '')); }
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
async function shot(ws, label) {
  if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const fp = path.join(SCREENSHOT_DIR, `${Date.now()}-${label}.png`);
  try {
    const r = await rpc(ws, 'Page.captureScreenshot', { format: 'png' }, 10000);
    fs.writeFileSync(fp, Buffer.from(r.data, 'base64'));
    console.log('  [shot] ' + fp);
  } catch (e) { console.log('  [shot fail] ' + label + ': ' + e.message); }
}

(async () => {
  console.log('[setup] clean data dir');
  try { fs.rmSync(TEMP_DATA, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(TEMP_DATA, { recursive: true });

  console.log(`[setup] spawn Hub on CDP :${CDP_PORT}`);
  const proc = spawn(ELECTRON, ['.', `--remote-debugging-port=${CDP_PORT}`], {
    cwd: HUB_DIR, env: { ...process.env, CLAUDE_HUB_DATA_DIR: TEMP_DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ready = false;
  const hubLog = [];
  proc.stdout.on('data', c => { const s = c.toString(); hubLog.push(s); if (s.includes('hook server listening')) ready = true; });
  proc.stderr.on('data', c => hubLog.push(c.toString()));
  for (let i = 0; i < 30 && !ready; i++) await new Promise(r => setTimeout(r, 1000));
  if (!ready) { console.log('!! hub failed to start'); console.log(hubLog.join('').slice(-2000)); proc.kill(); process.exit(1); }

  let ws;
  let meetingId = null;
  try {
    let list;
    for (let i = 0; i < 20; i++) {
      list = await gj(`http://127.0.0.1:${CDP_PORT}/json/list`).catch(() => null);
      if (list) break;
      await new Promise(r => setTimeout(r, 500));
    }
    const main = list.find(t => t.type === 'page' && t.url.includes('index.html'));
    ws = new WebSocket(main.webSocketDebuggerUrl);
    await new Promise((r, e) => { ws.on('open', r); ws.on('error', e); });
    await rpc(ws, 'Page.enable');
    await rpc(ws, 'Runtime.enable');

    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.method === 'Page.javascriptDialogOpening') {
        console.log('  [!DIALOG]', m.params.type, '-', m.params.message.slice(0, 200));
        ws.send(JSON.stringify({ id: ++_id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
      }
    });

    // 等 renderer 就绪
    for (let i = 0; i < 30; i++) {
      const r = await ev(ws, `(() => ({ hasFn: typeof window.openMeetingCreateModal === 'function', hasBtn: !!document.getElementById('btn-roundtable') }))()`).catch(() => ({}));
      if (r.hasFn && r.hasBtn) break;
      await new Promise(r => setTimeout(r, 500));
    }

    // === Pre-M2: 复用 M1 创建圆桌 ===
    console.log('\n[Pre] create roundtable [claude, gemini, codex]');
    await ev(ws, `document.getElementById('btn-roundtable').click()`);
    await new Promise(r => setTimeout(r, 1500));
    await ev(ws, `document.querySelector('#meeting-create-modal .mcm-create').click()`);

    // 等 meeting + 三家 ready
    let allReady = false;
    const waitStart = Date.now();
    while (Date.now() - waitStart < 60000) {
      const r = await ev(ws, `(async () => {
        const { ipcRenderer } = require('electron');
        const ms = await ipcRenderer.invoke('get-meetings') || [];
        const m = ms[ms.length - 1];
        if (!m || (m.subSessions||[]).length !== 3) return null;
        const ready = {};
        for (const sid of m.subSessions) ready[sid] = await ipcRenderer.invoke('cli-ready-status', sid);
        return { meetingId: m.id, subs: m.subSessions, ready };
      })()`, 8000).catch(() => null);
      if (r && r.ready && Object.values(r.ready).every(v => v)) {
        allReady = true; meetingId = r.meetingId;
        console.log(`  ready @ ${((Date.now() - waitStart) / 1000).toFixed(1)}s`);
        break;
      }
      await new Promise(r => setTimeout(r, 1500));
    }
    check(allReady, 'Pre: 三家 cli-ready', { meetingId });
    if (!allReady) throw new Error('PRE failed');

    await shot(ws, 'M2-pre-input');

    // === M2.1: 中文输入 + 发送 ===
    console.log('\n[M2.1] input chinese prompt and send');
    const beforeSend = await ev(ws, `(() => {
      const ib = document.getElementById('mr-input-box');
      if (!ib) return null;
      // contenteditable 正确姿势：textContent + 派 input 事件
      ib.focus();
      ib.textContent = ${JSON.stringify(PROMPT)};
      ib.dispatchEvent(new Event('input', { bubbles: true }));
      return { text: ib.textContent, focused: document.activeElement === ib };
    })()`);
    console.log('  beforeSend =', beforeSend);
    check(beforeSend && beforeSend.text === PROMPT, 'M2.1: 输入框已注入中文 prompt', beforeSend);

    // click 发送按钮（doSend）
    await ev(ws, `document.getElementById('mr-send-btn').click()`);
    // 立即查输入框（doSend 应同步清空）
    await new Promise(r => setTimeout(r, 200));
    const afterSendImmediate = await ev(ws, `(() => {
      const ib = document.getElementById('mr-input-box');
      return { text: ib?.innerText || '', textContent: ib?.textContent || '' };
    })()`);
    console.log('  immediately after send =', afterSendImmediate);
    check((afterSendImmediate.textContent || '').trim() === '', 'M2.1: 发送后输入框立即清空', afterSendImmediate);

    // === M2.2: 三家进入 streaming（轮询 max 30s） ===
    console.log('\n[M2.2] wait 3 cards entering streaming (max 30s)');
    const startStream = Date.now();
    let streamingState = { claude: false, gemini: false, codex: false };
    let anyTextSeen = { claude: false, gemini: false, codex: false };
    while (Date.now() - startStream < 30000) {
      const r = await ev(ws, `(() => {
        const cards = Array.from(document.querySelectorAll('.mr-ft[data-ft-sid]'));
        return cards.map(c => {
          const status = c.querySelector('.mr-ft-status')?.className.match(/mr-ft-status (\\w+)/)?.[1];
          const preview = c.querySelector('.mr-ft-preview')?.textContent.trim() || '';
          return { kind: c.getAttribute('data-ft-kind'), status, previewLen: preview.length };
        });
      })()`).catch(() => []);
      for (const c of r) {
        if (c.status === 'streaming' || c.status === 'thinking') streamingState[c.kind] = true;
        if (c.previewLen > 0) anyTextSeen[c.kind] = true;
      }
      if (streamingState.claude && streamingState.gemini && streamingState.codex) {
        console.log(`  all 3 streaming/thinking @ ${((Date.now() - startStream) / 1000).toFixed(1)}s`);
        break;
      }
      if (((Date.now() - startStream) / 1000) % 5 < 1.5) {
        console.log(`  +${((Date.now() - startStream) / 1000).toFixed(0)}s streaming=${JSON.stringify(streamingState)} text=${JSON.stringify(anyTextSeen)} cards=${JSON.stringify(r.map(x => ({k:x.kind,s:x.status})))}`);
      }
      await new Promise(r => setTimeout(r, 1500));
    }
    check(streamingState.claude, 'M2.2: claude streaming/thinking', streamingState);
    check(streamingState.gemini, 'M2.2: gemini streaming/thinking', streamingState);
    check(streamingState.codex, 'M2.2: codex streaming/thinking', streamingState);

    // === M2.3: 等 ≥1 个 token 出现（max 30s 后再延 30s 看 preview） ===
    console.log('\n[M2.3] wait ≥1 token preview per card (max +30s)');
    const tokenStart = Date.now();
    while (Date.now() - tokenStart < 30000) {
      const r = await ev(ws, `(() => {
        const cards = Array.from(document.querySelectorAll('.mr-ft[data-ft-sid]'));
        return cards.map(c => ({
          kind: c.getAttribute('data-ft-kind'),
          previewLen: (c.querySelector('.mr-ft-preview')?.textContent.trim() || '').length,
        }));
      })()`).catch(() => []);
      for (const c of r) if (c.previewLen > 0) anyTextSeen[c.kind] = true;
      if (anyTextSeen.claude && anyTextSeen.gemini && anyTextSeen.codex) break;
      await new Promise(r => setTimeout(r, 1500));
    }
    check(anyTextSeen.claude, 'M2.3: claude 卡片出现 token', anyTextSeen);
    check(anyTextSeen.gemini, 'M2.3: gemini 卡片出现 token', anyTextSeen);
    check(anyTextSeen.codex, 'M2.3: codex 卡片出现 token', anyTextSeen);

    await shot(ws, 'M2-after-streaming');

    // === M2.4: timeline 出现新 turn (等三家答完, max 120s) ===
    console.log('\n[M2.4] wait timeline.md to be written (turn-complete needed)');
    const tlPath = path.join(TEMP_DATA, 'timelines', `timeline-${meetingId}.md`);
    const altPath = path.join(HUB_DIR, '.arena', `timeline-${meetingId}.md`);
    let tlContent = '';
    const tlStart = Date.now();
    while (Date.now() - tlStart < 120000) {
      if (fs.existsSync(tlPath)) { tlContent = fs.readFileSync(tlPath, 'utf8'); break; }
      if (fs.existsSync(altPath)) { tlContent = fs.readFileSync(altPath, 'utf8'); break; }
      await new Promise(r => setTimeout(r, 2000));
      // 也轮询 turn-complete 状态
      const tc = await ev(ws, `(async () => {
        const { ipcRenderer } = require('electron');
        const ms = await ipcRenderer.invoke('get-meetings') || [];
        const m = ms[ms.length - 1];
        return { turnsLen: (m?.turns||[]).length, lastTurn: (m?.turns||[]).slice(-1)[0] };
      })()`).catch(() => null);
      if (((Date.now() - tlStart) / 5000) % 1 < 0.5) console.log(`  +${((Date.now() - tlStart) / 1000).toFixed(0)}s turns=${tc?.turnsLen} byCount=${Object.keys(tc?.lastTurn?.by||{}).length}/3`);
    }
    console.log(`  tlPath ${tlPath} exists=${fs.existsSync(tlPath)}, altPath ${altPath} exists=${fs.existsSync(altPath)}`);
    console.log(`  timeline content (first 500 chars) = ${tlContent.slice(0, 500)}`);
    check(tlContent.length > 0, 'M2.4: timeline 文件存在且非空', { tlLen: tlContent.length });
    check(/## 第 1 轮/.test(tlContent), 'M2.4: timeline.md 含第 1 轮标题', { length: tlContent.length });
    check(tlContent.includes('用户输入') || tlContent.includes(PROMPT.slice(0, 6)),
      'M2.4: timeline 含用户输入', { snippet: tlContent.slice(0, 500) });

  } finally {
    if (ws) ws.close();
    proc.kill();
  }

  console.log(`\n=== M2 Result: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) {
    console.log('Failures:');
    for (const f of failures) console.log(' - ' + f.msg);
    process.exit(1);
  }
  process.exit(0);
})().catch(e => {
  console.error('FATAL', e.message);
  console.error(e.stack);
  process.exit(2);
});
