'use strict';
// E2E：E4 modal stale DOM rebuild + E5 disabled mode hint + E6 关闭按钮存在
// 同一 hub 实例测三个独立断言。

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('../node_modules/ws');

const HUB_DIR = path.resolve(__dirname, '..');
const ELECTRON = path.join(HUB_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const TEMP_DATA = process.env.HUB_DATA || 'C:\\Users\\lintian\\AppData\\Local\\Temp\\hub-e2e-stalehints';
const CDP_PORT = parseInt(process.env.CDP_PORT || '9245', 10);

let _id = 0;
let pass = 0, fail = 0;
const failures = [];
function check(cond, msg, details) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; failures.push({ msg, details }); console.log('  ✗ ' + msg + (details ? ' — ' + JSON.stringify(details).slice(0, 200) : '')); }
}
function rpc(ws, m, p = {}, t = 15000) {
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
  // 干净 data dir（让 hub 完整启动 + 可创建 meeting）
  try { fs.rmSync(TEMP_DATA, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(TEMP_DATA, { recursive: true });

  const proc = spawn(ELECTRON, ['.', `--remote-debugging-port=${CDP_PORT}`], {
    cwd: HUB_DIR, env: { ...process.env, CLAUDE_HUB_DATA_DIR: TEMP_DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ready = false;
  proc.stdout.on('data', c => { if (c.toString().includes('hook server listening')) ready = true; });
  proc.stderr.on('data', () => {});
  for (let i = 0; i < 30 && !ready; i++) await new Promise(r => setTimeout(r, 1000));

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

    // 等 renderer.js 完成所有 binding（meeting-create-modal.js 等）
    // poll: window.openMeetingCreateModal 函数 + #btn-roundtable 都就绪
    for (let i = 0; i < 30; i++) {
      const r = await ev(ws, `(() => ({
        hasFn: typeof window.openMeetingCreateModal === 'function',
        hasBtn: !!document.getElementById('btn-roundtable'),
      }))()`).catch(() => ({ hasFn: false, hasBtn: false }));
      if (r.hasFn && r.hasBtn) break;
      await new Promise(r => setTimeout(r, 500));
    }

    // ============ E4: modal stale DOM rebuild ============
    console.log('\n[E4] modal stale DOM rebuild');
    // 1) 打开 modal
    await ev(ws, `document.getElementById('btn-roundtable').click()`);
    await new Promise(r => setTimeout(r, 1500));
    const before = await ev(ws, `(() => {
      const m = document.getElementById('meeting-create-modal');
      return { exists: !!m, visible: m ? m.getBoundingClientRect().width > 0 : false };
    })()`);
    check(before.exists && before.visible, 'E4-step1: 首次点击 modal 出现', before);

    // 2) 关闭 modal（点 cancel 按钮）
    await ev(ws, `document.querySelector('#meeting-create-modal .mcm-cancel').click()`);
    await new Promise(r => setTimeout(r, 300));

    // 3) 强制 remove modal（模拟 stale 路径）
    await ev(ws, `document.getElementById('meeting-create-modal')?.remove()`);
    await new Promise(r => setTimeout(r, 200));
    const removed = await ev(ws, `({ exists: !!document.getElementById('meeting-create-modal') })`);
    check(!removed.exists, 'E4-step2: modal 已从 DOM 移除', removed);

    // 4) 再点 #btn-roundtable（应该重建）
    await ev(ws, `document.getElementById('btn-roundtable').click()`);
    await new Promise(r => setTimeout(r, 800));
    const after = await ev(ws, `(() => {
      const m = document.getElementById('meeting-create-modal');
      return { exists: !!m, visible: m ? m.getBoundingClientRect().width > 0 : false };
    })()`);
    check(after.exists && after.visible, 'E4-step3: remove 后再点 modal 应重新出现（修复前会失败）', after);

    // ============ E6: 关闭会议按钮（验证 by design 已存在） ============
    console.log('\n[E6] 关闭会议按钮');
    // 先关 modal 进入会议
    await ev(ws, `document.querySelector('#meeting-create-modal .mcm-create').click()`);
    await new Promise(r => setTimeout(r, 6000));
    const closeBtnState = await ev(ws, `(() => {
      const btn = document.getElementById('mr-btn-close');
      if (!btn) return { exists: false };
      const r = btn.getBoundingClientRect();
      return {
        exists: true,
        visible: r.width > 0 && r.height > 0,
        ariaLabel: btn.getAttribute('aria-label'),
        title: btn.title,
        hasSvg: !!btn.querySelector('svg'),
      };
    })()`);
    check(closeBtnState.exists, 'E6: #mr-btn-close 按钮存在', closeBtnState);
    check(closeBtnState.visible, 'E6: 关闭按钮可见', closeBtnState);
    check(/关闭|Close/i.test(closeBtnState.ariaLabel + ' ' + closeBtnState.title), 'E6: 关闭按钮 aria-label/title 含语义', closeBtnState);

    // ============ E5: pilot/observer disabled 时 title 解释原因 ============
    console.log('\n[E5] pilot/observer disabled hint');
    // 等卡片渲染（已在 close-btn 测中等过）
    const pilotState = await ev(ws, `(async () => {
      const { ipcRenderer } = require('electron');
      const ms = await ipcRenderer.invoke('get-meetings') || [];
      const m = ms[ms.length - 1];
      const pilotBtn = document.querySelector('[data-dispatch-mode="pilot"]');
      const observerBtn = document.querySelector('[data-dispatch-mode="observer"]');
      return {
        pilotSlot: m?.pilotSlot,
        pilotBtn: pilotBtn ? { disabled: pilotBtn.disabled, title: pilotBtn.title } : null,
        observerBtn: observerBtn ? { disabled: observerBtn.disabled, title: observerBtn.title } : null,
      };
    })()`);
    console.log('  pilotState =', JSON.stringify(pilotState));
    // 默认未选主驾 → 应该 disabled + title 含"主驾角色"hint
    check(pilotState.pilotBtn && pilotState.pilotBtn.disabled, 'E5: 未选主驾时 pilot 按钮 disabled', pilotState.pilotBtn);
    check(pilotState.pilotBtn && /主驾角色|先选|请先/.test(pilotState.pilotBtn.title),
      'E5: pilot disabled 时 title 解释原因（含"主驾角色"或"先选"）', pilotState.pilotBtn);
    check(pilotState.observerBtn && /主驾角色|先选|请先/.test(pilotState.observerBtn.title),
      'E5: observer disabled 时 title 解释原因', pilotState.observerBtn);

  } finally {
    if (ws) ws.close();
    proc.kill();
  }

  console.log(`\n=== Result: ${pass} passed, ${fail} failed ===`);
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
