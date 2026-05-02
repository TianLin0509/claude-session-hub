'use strict';
// E2E: create-meeting 失败时必须 fail loud（不进空房间）
// 触发方式：data dir 设为不可写路径（hub 进程 mkdir arena-prompts 会 ENOENT）
// 期望：modal 内显示错误 + 不进空 meeting

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('../node_modules/ws');

const HUB_DIR = path.resolve(__dirname, '..');
const ELECTRON = path.join(HUB_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const TEMP_DATA = process.env.HUB_DATA || 'C:\\Users\\lintian\\AppData\\Local\\Temp\\hub-e2e-failloud';
const CDP_PORT = parseInt(process.env.CDP_PORT || '9241', 10);
const SCREENSHOT_DIR = path.join(__dirname, 'screenshots', 'e2e-failloud');

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

async function attachWhenReady(port) {
  for (let i = 0; i < 30; i++) {
    const list = await gj(`http://127.0.0.1:${port}/json/list`).catch(() => null);
    if (list) {
      const main = list.find(t => t.type === 'page' && t.url.includes('index.html'));
      if (main) {
        const ws = new WebSocket(main.webSocketDebuggerUrl);
        await new Promise((r, e) => { ws.on('open', r); ws.on('error', e); });
        await rpc(ws, 'Page.enable');
        await rpc(ws, 'Runtime.enable');
        await rpc(ws, 'Log.enable');
        return ws;
      }
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('attach timeout');
}

function startHub(env) {
  const proc = spawn(ELECTRON, ['.', `--remote-debugging-port=${CDP_PORT}`], {
    cwd: HUB_DIR, env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ready = false;
  const log = [];
  proc.stdout.on('data', c => { const s = c.toString(); log.push(s); if (s.includes('hook server listening')) ready = true; });
  proc.stderr.on('data', c => log.push(c.toString()));
  return { proc, isReady: () => ready, getLog: () => log.join('') };
}

async function shot(ws, label) {
  if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const fp = path.join(SCREENSHOT_DIR, `${Date.now()}-${label}.png`);
  try {
    const r = await rpc(ws, 'Page.captureScreenshot', { format: 'png' }, 8000);
    fs.writeFileSync(fp, Buffer.from(r.data, 'base64'));
    console.log('  [shot] ' + fp);
  } catch (e) { console.log('  [shot fail] ' + label + ': ' + e.message); }
}

(async () => {
  // 模式：data dir 真实存在，但 arena-prompts 子路径预先创为 file
  // 这样 hub 启动正常（state.json 等都能写），但 add-sub 时 writePromptFile 调
  // mkdirSync('arena-prompts',{recursive:true}) 会 EEXIST/ENOTDIR — 真实 silent fail 路径
  try { fs.rmSync(TEMP_DATA, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(TEMP_DATA, { recursive: true });
  const blockerPath = path.join(TEMP_DATA, 'arena-prompts');
  fs.writeFileSync(blockerPath, 'block file — make mkdir fail');
  console.log('[setup] data dir = ' + TEMP_DATA);
  console.log('[setup] blocker file = ' + blockerPath);

  const { proc, isReady, getLog } = startHub({ CLAUDE_HUB_DATA_DIR: TEMP_DATA });
  console.log(`[setup] Hub PID=${proc.pid} on CDP :${CDP_PORT}`);
  // 等 hook server 起来（即使数据目录坏了，hook server 应该能起）
  for (let i = 0; i < 30; i++) {
    if (isReady()) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!isReady()) {
    // hub 起不来也是 bug
    console.log('!! Hub failed to start with broken data dir — log dump:');
    console.log(getLog().slice(0, 3000));
    proc.kill();
    process.exit(1);
  }

  let ws;
  try {
    ws = await attachWhenReady(CDP_PORT);

    // dialog auto-dismiss + 记录
    const dialogs = [];
    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.method === 'Page.javascriptDialogOpening') {
        dialogs.push({ type: m.params.type, message: m.params.message.slice(0, 300) });
        ws.send(JSON.stringify({ id: ++_id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
      }
    });

    // 监听 console error
    const errs = [];
    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
        errs.push((m.params.args || []).map(a => a.value || a.description || '').join(' ').slice(0, 300));
      }
      if (m.method === 'Runtime.exceptionThrown') {
        errs.push('EX: ' + JSON.stringify(m.params.exceptionDetails).slice(0, 300));
      }
    });

    // === 步骤 1: 点 #btn-roundtable ===
    console.log('\n[step] click 圆桌按钮');
    await ev(ws, `document.getElementById('btn-roundtable').click()`);
    await new Promise(r => setTimeout(r, 1500));
    await shot(ws, 'modal-open');

    // 诊断：modal 是否真的打开
    const modalState = await ev(ws, `(() => {
      const mcm = document.getElementById('meeting-create-modal');
      if (!mcm) return { exists: false };
      const btn = mcm.querySelector('.mcm-create');
      return {
        exists: true,
        visible: mcm.getBoundingClientRect().width > 0,
        display: getComputedStyle(mcm).display,
        createBtnFound: !!btn,
        createBtnText: btn ? btn.textContent : null,
      };
    })()`);
    console.log('  modalState =', JSON.stringify(modalState));

    if (!modalState.exists || !modalState.createBtnFound) {
      console.log('!! modal 没正常出现，console errors:');
      console.log(errs.slice(-10).join('\n'));
      throw new Error('modal not opened');
    }

    // === 步骤 2: 点击创建（应该失败） ===
    console.log('[step] click 创建圆桌');
    await ev(ws, `document.querySelector('#meeting-create-modal .mcm-create').click()`);
    // 等 8s（add-sub 可能慢）
    await new Promise(r => setTimeout(r, 8000));
    await shot(ws, 'after-submit');

    // === 断言 ===
    console.log('\n[assertions]');
    const state = await ev(ws, `(async () => {
      const { ipcRenderer } = require('electron');
      const meetings = await ipcRenderer.invoke('get-meetings') || [];
      const mcm = document.getElementById('meeting-create-modal');
      function vis(el){ if(!el)return false; const r=el.getBoundingClientRect(); return r.width>0 && r.height>0 && getComputedStyle(el).display!=='none'; }
      return {
        meetingCount: meetings.length,
        meetingsSubCounts: meetings.map(m => ({ id: m.id, title: m.title, subCount: (m.subSessions||[]).length })),
        modalVisible: mcm ? vis(mcm) : false,
        modalErrorText: mcm ? (mcm.querySelector('.mcm-error')?.textContent || null) : null,
        createBtnText: mcm ? (mcm.querySelector('.mcm-create')?.textContent || null) : null,
        createBtnDisabled: mcm ? (mcm.querySelector('.mcm-create')?.disabled || false) : null,
      };
    })()`);
    console.log('state =', JSON.stringify(state, null, 2));
    console.log('dialogs intercepted =', dialogs);

    // CORE 断言：失败时不该进空房间
    const emptyMeetings = state.meetingsSubCounts.filter(m => m.subCount === 0);
    check(emptyMeetings.length === 0,
      'add-sub 全失败时不应留下 subCount=0 的空 meeting',
      { emptyMeetings, allMeetings: state.meetingsSubCounts });

    // CORE 断言：modal 应显示错误而不是关闭
    check(state.modalVisible,
      'add-sub 失败时 modal 应保持可见（显示错误）',
      { modalVisible: state.modalVisible });

    check(state.modalErrorText && state.modalErrorText.trim().length > 0,
      'modal 应显示 .mcm-error 错误文本',
      { errorText: state.modalErrorText });

    // 不应出现 native alert dialog
    check(dialogs.length === 0,
      '不应弹出 native alert（应用 inline error）',
      { dialogs });

    // create 按钮应恢复可点击（让用户能修正后重试）
    check(state.createBtnText === '创建圆桌' && state.createBtnDisabled === false,
      'create 按钮应恢复可点状态',
      { btnText: state.createBtnText, disabled: state.createBtnDisabled });

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
