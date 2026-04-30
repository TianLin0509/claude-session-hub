'use strict';
// IF-C5 E2E 验证：input-fixes 批次（IF-C0..C4）的端到端校验。
//
// 启动隔离 Hub + CDP 9228，验证：
//   1. cli-ready-status IPC 已注册（Bug B 修复基础）
//   2. _cliReadyCache 在 renderer 顶部存在 + cli-ready 轮询启动
//   3. isInitializing 判断走 _cliReadyCache（line 196 不再用 markerStatus）
//   4. openMeeting 末尾有 setTimeout focus #mr-input-box（auto-focus）
//   5. setupInput 的 textContent='' 在 if(!_inputBound) 块内（不擦用户输入）
//   6. 软提醒 banner DOM (#mr-input-soft-alert) 存在
//   7. toolbar 按钮顺序：[群策群力][总结发言] divider [总结人]
//   8. .mr-ft-preview-md class 存在（markdown 渲染）
//   9. package.json version === '0.3.0'

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('../node_modules/ws');

const HUB_DIR = path.resolve(__dirname, '..');
const ELECTRON = path.join(HUB_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const TEMP_DATA = 'C:\\Users\\lintian\\AppData\\Local\\Temp\\hub-test-inputfixes-e2e';
const CDP_PORT = 9228;
const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');
let _id = 0;

function rpc(ws, method, params = {}) {
  const i = ++_id;
  return new Promise((res, rej) => {
    const onMsg = raw => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.id === i) {
        ws.removeListener('message', onMsg);
        msg.error ? rej(new Error(`CDP ${method}: ${msg.error.message}`)) : res(msg.result);
      }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => { ws.removeListener('message', onMsg); rej(new Error(`timeout ${method}`)); }, 30000);
  });
}

async function evalRpc(ws, expr) {
  const r = await rpc(ws, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 800));
  return r.result.value;
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function attachCDP(port) {
  let lastErr = null;
  for (let i = 0; i < 25; i++) {
    try {
      const list = await getJson(`http://127.0.0.1:${port}/json/list`);
      const main = list.find(t => t.type === 'page' && t.url.includes('index.html'));
      if (!main) throw new Error('no main window');
      const ws = new WebSocket(main.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
      await rpc(ws, 'Page.enable');
      await rpc(ws, 'Runtime.enable');
      return ws;
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  throw new Error(`attachCDP failed: ${lastErr?.message}`);
}

function startHub(port) {
  const env = { ...process.env, CLAUDE_HUB_DATA_DIR: TEMP_DATA };
  const proc = spawn(ELECTRON, ['.', `--remote-debugging-port=${port}`], {
    cwd: HUB_DIR, env, detached: false, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ready = false;
  return new Promise((resolve, reject) => {
    const onData = (chunk) => {
      const s = chunk.toString();
      if (s.includes('hook server listening')) { ready = true; resolve(proc); }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', reject);
    proc.on('exit', (code) => { if (!ready) reject(new Error(`Hub exited early code=${code}`)); });
    setTimeout(() => { if (!ready) reject(new Error('Hub did not signal ready within 30s')); }, 30000);
  });
}

async function screenshot(ws, label) {
  if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const fname = `input-fixes-${label}-${Date.now()}.png`;
  const fpath = path.join(SCREENSHOT_DIR, fname);
  const r = await rpc(ws, 'Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(fpath, Buffer.from(r.data, 'base64'));
  return fpath;
}

let passed = 0, failed = 0, failures = [];
const screenshots = [];
function assert(cond, msg) {
  if (cond) { console.log(`  ✓ ${msg}`); passed++; }
  else { console.log(`  ✗ FAIL: ${msg}`); failed++; failures.push(msg); }
}

(async () => {
  // 静态源码契约校验（IF-C1..C4 关键代码片段必须存在）— 不需要启动 Hub
  console.log('[E2E-IF] Static source-code contract checks...');
  const mainSrc = fs.readFileSync(path.join(HUB_DIR, 'main.js'), 'utf-8');
  const mrJsSrc = fs.readFileSync(path.join(HUB_DIR, 'renderer', 'meeting-room.js'), 'utf-8');
  const mrCssSrc = fs.readFileSync(path.join(HUB_DIR, 'renderer', 'meeting-room.css'), 'utf-8');
  const indexSrc = fs.readFileSync(path.join(HUB_DIR, 'renderer', 'index.html'), 'utf-8');
  const pkg = JSON.parse(fs.readFileSync(path.join(HUB_DIR, 'package.json'), 'utf-8'));

  // IF-C1
  assert(/ipcMain\.handle\(['"]cli-ready-status['"]/.test(mainSrc),
    'main.js registers cli-ready-status IPC handler');
  assert(/let _cliReadyCache\s*=\s*\{\}/.test(mrJsSrc),
    'renderer has _cliReadyCache module variable');
  assert(/function startCliReadyPoll\(\)/.test(mrJsSrc),
    'startCliReadyPoll function defined');
  assert(/function stopCliReadyPoll\(\)/.test(mrJsSrc),
    'stopCliReadyPoll function defined');
  assert(/const isInitializing\s*=\s*s\s*&&\s*!_cliReadyCache\[sub\.sid\]/.test(mrJsSrc),
    'isInitializing uses _cliReadyCache (not markerStatus) — P0 bug B fix');
  assert(/startCliReadyPoll\(\);/.test(mrJsSrc) && /stopCliReadyPoll\(\);/.test(mrJsSrc),
    'startCliReadyPoll + stopCliReadyPoll called from openMeeting / closeMeetingPanel');

  // IF-C2
  assert(/setTimeout\(\(\)\s*=>\s*\{[\s\S]*?inputBox\.focus\(\)/.test(mrJsSrc),
    'openMeeting setTimeout focus #mr-input-box (auto-focus)');
  // textContent='' 必须在 _inputBound block 内（用 grep 行号判断顺序）
  const inputBoundIdx = mrJsSrc.indexOf("if (_inputBound) return;");
  const textContentIdx = mrJsSrc.lastIndexOf("inputBox.textContent = ''");
  assert(textContentIdx > inputBoundIdx,
    `setupInput textContent='' moved into _inputBound block (after if check)`);

  // IF-C3
  assert(/function _refreshSoftAlert\(meeting\)/.test(mrJsSrc),
    '_refreshSoftAlert function defined');
  assert(/let _bannerDismissedFor/.test(mrJsSrc),
    '_bannerDismissedFor module variable defined');
  assert(/id="mr-input-soft-alert"/.test(indexSrc),
    'index.html has soft-alert banner div');
  assert(/\.mr-input-soft-alert\s*\{/.test(mrCssSrc),
    'CSS .mr-input-soft-alert rule exists');

  // IF-C4
  // toolbar 顺序：debate-btn 出现在 summary-btn 之前，summary-btn 出现在 divider 之前
  const debateIdx = mrJsSrc.indexOf('id="mr-rt-debate-btn"');
  const summaryIdx = mrJsSrc.indexOf('id="mr-rt-summary-btn"');
  const dividerIdx = mrJsSrc.indexOf('class="mr-rt-tb-divider"');
  const pickIdx = mrJsSrc.indexOf('id="mr-rt-summary-pick"');
  assert(debateIdx >= 0 && summaryIdx > debateIdx,
    'toolbar: 群策群力 button before 总结发言 button');
  assert(summaryIdx > 0 && dividerIdx > summaryIdx,
    'toolbar: 总结发言 button before divider');
  assert(dividerIdx > 0 && pickIdx > dividerIdx,
    'toolbar: divider before 总结人 picker');

  assert(pkg.version === '0.3.0', `package.json version === "0.3.0" (got "${pkg.version}")`);

  // IF-C0
  assert(/_renderMarkdown\(/.test(mrJsSrc),
    '_ftHtml uses _renderMarkdown for completed preview');
  assert(/mr-ft-preview-md/.test(mrCssSrc),
    'CSS .mr-ft-preview-md rules exist');

  // 动态 Hub smoke + IPC 检查
  try { fs.rmSync(TEMP_DATA, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(TEMP_DATA, { recursive: true });
  console.log(`[E2E-IF] TEMP_DATA=${TEMP_DATA}`);

  let hub = null, ws = null;
  try {
    console.log(`[E2E-IF] Step: start Hub on CDP ${CDP_PORT}...`);
    hub = await startHub(CDP_PORT);
    console.log(`  -> Hub PID=${hub.pid}, ready signal seen`);
    await new Promise(r => setTimeout(r, 2000));

    console.log('[E2E-IF] Step: attach CDP...');
    ws = await attachCDP(CDP_PORT);
    await evalRpc(ws, `(async () => {
      for (let i = 0; i < 30; i++) {
        if (typeof require !== 'undefined') {
          try { const { ipcRenderer } = require('electron'); if (ipcRenderer) return true; } catch {}
        }
        await new Promise(r => setTimeout(r, 200));
      }
      return false;
    })()`);
    console.log('  -> CDP attached + ipcRenderer ready');

    // IPC 调用：cli-ready-status 对不存在的 sid 应返回 false
    console.log('[E2E-IF] Step: invoke cli-ready-status IPC (P0 fix data path)...');
    const ipcResult = await evalRpc(ws, `(async () => {
      const { ipcRenderer } = require('electron');
      try {
        const r = await ipcRenderer.invoke('cli-ready-status', 'fake-sid-not-exist');
        return { ok: true, value: r };
      } catch (e) {
        return { ok: false, err: e.message };
      }
    })()`);
    console.log(`  ipc result: ${JSON.stringify(ipcResult)}`);
    assert(ipcResult.ok === true && ipcResult.value === false,
      'cli-ready-status returns false for non-existent sid (no throw, default value)');

    // 验证 banner DOM 存在但默认隐藏
    const bannerCheck = await evalRpc(ws, `(() => {
      const b = document.getElementById('mr-input-soft-alert');
      if (!b) return { exists: false };
      return { exists: true, display: getComputedStyle(b).display };
    })()`);
    console.log(`  banner DOM: ${JSON.stringify(bannerCheck)}`);
    assert(bannerCheck.exists, 'soft-alert banner DOM #mr-input-soft-alert exists');
    assert(bannerCheck.display === 'none', 'banner default hidden (display:none) before any meeting');

    const s1 = await screenshot(ws, 'idle');
    console.log(`  screenshot: ${s1}`);
    screenshots.push(s1);

  } catch (e) {
    console.error('[E2E-IF] EXCEPTION:', e.message);
    failed++;
    failures.push(`Exception: ${e.message}`);
    if (ws) try { const s = await screenshot(ws, 'error'); screenshots.push(s); } catch {}
  } finally {
    console.log('[E2E-IF] Cleanup...');
    if (ws) try { ws.close(); } catch {}
    if (hub) {
      try { hub.kill('SIGKILL'); } catch {}
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  console.log(`\n========================================`);
  console.log(`[E2E-IF SUMMARY] ${passed} passed, ${failed} failed`);
  if (screenshots.length > 0) {
    console.log('Screenshots:');
    for (const s of screenshots) console.log(`  ${s}`);
  }
  if (failed === 0) {
    console.log(`✅ All ${passed} assertions passed`);
    process.exit(0);
  } else {
    console.log(`❌ ${failed} assertion(s) failed:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
})();
