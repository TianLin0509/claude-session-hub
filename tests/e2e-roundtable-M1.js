'use strict';
// M1: 隔离启动 Hub，新建圆桌成员 [claude, gemini, codex]
// 断言：3 个子 session 全部 cli-ready；3 张卡片渲染；输入框 placeholder 含"圆桌讨论"

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('../node_modules/ws');

const HUB_DIR = path.resolve(__dirname, '..');
const ELECTRON = path.join(HUB_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const TEMP_DATA = process.env.HUB_DATA || 'C:\\Users\\lintian\\AppData\\Local\\Temp\\hub-e2e-M1';
const CDP_PORT = parseInt(process.env.CDP_PORT || '9250', 10);
const SCREENSHOT_DIR = path.join(__dirname, 'screenshots', 'e2e-roundtable');

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
    return fp;
  } catch (e) { console.log('  [shot fail] ' + label + ': ' + e.message); return null; }
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
  proc.stdout.on('data', c => { if (c.toString().includes('hook server listening')) ready = true; });
  proc.stderr.on('data', () => {});
  for (let i = 0; i < 30 && !ready; i++) await new Promise(r => setTimeout(r, 1000));
  if (!ready) { console.log('!! hub failed to start'); proc.kill(); process.exit(1); }

  let ws;
  try {
    // attach
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

    // dialog auto-dismiss
    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.method === 'Page.javascriptDialogOpening') {
        console.log('  [!DIALOG]', m.params.type, '-', m.params.message.slice(0, 200));
        ws.send(JSON.stringify({ id: ++_id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
      }
    });

    // 等 renderer 就绪
    for (let i = 0; i < 30; i++) {
      const r = await ev(ws, `(() => ({ hasFn: typeof window.openMeetingCreateModal === 'function', hasBtn: !!document.getElementById('btn-roundtable') }))()`).catch(() => ({ hasFn: false, hasBtn: false }));
      if (r.hasFn && r.hasBtn) break;
      await new Promise(r => setTimeout(r, 500));
    }

    // === M1.1: 通过 UI 创建圆桌 [claude, gemini, codex] ===
    console.log('\n[M1.1] open create modal + verify default 3 slots');
    await ev(ws, `document.getElementById('btn-roundtable').click()`);
    await new Promise(r => setTimeout(r, 1500));
    await shot(ws, 'M1-modal-open');

    const slotState = await ev(ws, `(() => {
      const mcm = document.getElementById('meeting-create-modal');
      if (!mcm) return null;
      return Array.from(mcm.querySelectorAll('.mcm-slot')).map((s, i) => ({
        idx: i,
        kind: (s.querySelector('.mcm-ai-select') || {}).value || null,
        model: (s.querySelector('.mcm-model-select') || {}).value || null,
      }));
    })()`);
    console.log('  default slots =', JSON.stringify(slotState));
    check(Array.isArray(slotState) && slotState.length === 3, 'M1.1: modal 默认 3 个 slot', { count: slotState?.length });
    check(slotState?.[0]?.kind === 'claude', 'M1.1: slot 0 = claude', slotState?.[0]);
    check(slotState?.[1]?.kind === 'gemini', 'M1.1: slot 1 = gemini', slotState?.[1]);
    check(slotState?.[2]?.kind === 'codex', 'M1.1: slot 2 = codex', slotState?.[2]);

    // === M1.2: 提交创建 ===
    console.log('\n[M1.2] click 创建圆桌, wait for meeting');
    await ev(ws, `document.querySelector('#meeting-create-modal .mcm-create').click()`);
    // poll meeting created（最多 15s — create-meeting 内部 await 3 个 add-sub）
    let created = null;
    for (let i = 0; i < 30; i++) {
      const r = await ev(ws, `(async () => { const{ipcRenderer}=require('electron'); const ms=await ipcRenderer.invoke('get-meetings'); return ms[ms.length-1] || null; })()`, 5000).catch(() => null);
      if (r && (r.subSessions || []).length === 3) { created = r; break; }
      await new Promise(r => setTimeout(r, 500));
    }
    check(created !== null, 'M1.2: meeting 创建成功且 subSessions=3', { meeting: created });
    if (!created) {
      const dbg = await ev(ws, `(async () => { const{ipcRenderer}=require('electron'); const ms=await ipcRenderer.invoke('get-meetings'); const mcm = document.getElementById('meeting-create-modal'); return { meetings: ms, modalErrText: mcm?.querySelector('.mcm-error')?.textContent }; })()`);
      console.log('  debug =', JSON.stringify(dbg).slice(0, 800));
      throw new Error('meeting not created');
    }

    // === M1.3: 等三家 cli-ready ===
    console.log('\n[M1.3] wait 3 sub sessions cli-ready (max 60s)');
    const startReady = Date.now();
    let subReady = { claude: false, gemini: false, codex: false };
    let pollCount = 0;
    while (Date.now() - startReady < 60000) {
      pollCount++;
      const r = await ev(ws, `(async () => {
        const { ipcRenderer } = require('electron');
        const ms = await ipcRenderer.invoke('get-meetings') || [];
        const m = ms[ms.length - 1];
        if (!m) return null;
        const out = {};
        for (const sid of m.subSessions) {
          out[sid] = await ipcRenderer.invoke('cli-ready-status', sid);
        }
        // 同步取每个 sub 的 kind
        const subKinds = {};
        for (const sid of m.subSessions) {
          // 通过 sessions Map 拿 kind（renderer 全局 sessions 是个 Map）
          const s = (typeof sessions !== 'undefined' && sessions) ? sessions.get(sid) : null;
          if (s) subKinds[sid] = s.kind;
        }
        return { ready: out, kinds: subKinds };
      })()`, 8000).catch(() => null);
      if (r) {
        for (const sid in r.ready) {
          const kind = r.kinds[sid];
          if (kind && r.ready[sid]) subReady[kind] = true;
        }
        if (subReady.claude && subReady.gemini && subReady.codex) {
          console.log(`  all 3 ready @ ${((Date.now() - startReady) / 1000).toFixed(1)}s`);
          break;
        }
      }
      if (pollCount % 5 === 0) console.log(`  +${((Date.now() - startReady) / 1000).toFixed(0)}s ready=${JSON.stringify(subReady)}`);
      await new Promise(r => setTimeout(r, 1500));
    }
    check(subReady.claude, 'M1.3: claude ready', subReady);
    check(subReady.gemini, 'M1.3: gemini ready', subReady);
    check(subReady.codex, 'M1.3: codex ready', subReady);
    await shot(ws, 'M1-after-ready');

    // === M1.4: 卡片渲染 ===
    console.log('\n[M1.4] verify 3 cards rendered');
    const cards = await ev(ws, `(() => {
      const cards = Array.from(document.querySelectorAll('.mr-ft[data-ft-sid]'));
      return cards.map(c => ({
        sid: c.getAttribute('data-ft-sid'),
        kind: c.getAttribute('data-ft-kind'),
        slot: c.className.match(/slot-(\\d)/)?.[1],
        statusCls: c.querySelector('.mr-ft-status')?.className.match(/mr-ft-status (\\w+)/)?.[1],
        statusText: c.querySelector('.mr-ft-status')?.textContent.trim(),
        visible: c.getBoundingClientRect().width > 0,
      }));
    })()`);
    console.log('  cards =', JSON.stringify(cards, null, 2));
    check(cards.length === 3, 'M1.4: 3 张卡片渲染', { count: cards.length });
    check(cards.every(c => c.visible), 'M1.4: 所有卡片可见');
    const kinds = cards.map(c => c.kind).sort();
    check(JSON.stringify(kinds) === JSON.stringify(['claude', 'codex', 'gemini']), 'M1.4: 卡片 kind 完整 [claude, codex, gemini]', kinds);

    // === M1.5: 输入框 placeholder ===
    console.log('\n[M1.5] input placeholder');
    const inp = await ev(ws, `(() => {
      const ib = document.getElementById('mr-input-box');
      return ib ? { placeholder: ib.dataset.placeholder, contenteditable: ib.contentEditable } : null;
    })()`);
    console.log('  input =', JSON.stringify(inp));
    check(inp && /圆桌讨论/.test(inp.placeholder || ''), 'M1.5: 输入框 placeholder 含"圆桌讨论"', inp);

    await shot(ws, 'M1-final');

  } finally {
    if (ws) ws.close();
    proc.kill();
  }

  console.log(`\n=== M1 Result: ${pass} passed, ${fail} failed ===`);
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
