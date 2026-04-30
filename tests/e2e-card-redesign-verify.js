'use strict';
// Card redesign E2E 验证（CR-C5）：启动隔离 Hub + CDP 9227，校验：
//   1. .mr-ft computed height === 220px（防抖关键）
//   2. .mr-ft computed display === 'flex'，flex-direction === 'column'
//   3. .mr-ft-strip grid-template-columns 三列等宽（minmax(0, 1fr) 渲染为相等 px）
//   4. 卡片 DOM 含 .mr-ft-head / .mr-ft-avatar / .mr-ft-info / .mr-ft-row3 /
//      .mr-ft-row4 / .mr-ft-bottom 全套结构
//   5. 头像 img src 指向 assets/pokemon/*.png
//   6. row3 含 "本轮" + "累计" + "⏱"；row4 含 "本轮" + "累计" + "🪙"
//   7. 截图保存到 tests/screenshots/card-redesign-*.png
//
// 运行：
//   $env:CLAUDE_HUB_DATA_DIR = "C:\Users\lintian\AppData\Local\Temp\hub-test-cr"
//   .\node_modules\electron\dist\electron.exe . --remote-debugging-port=9227 &
//   node tests/_e2e-card-redesign-verify.js

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('../node_modules/ws');

const HUB_DIR = path.resolve(__dirname, '..');
const ELECTRON = path.join(HUB_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const TEMP_DATA = 'C:\\Users\\lintian\\AppData\\Local\\Temp\\hub-test-cardredesign-e2e';
const CDP_PORT = 9227;
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
      if (!main) throw new Error('no main window via CDP');
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
  throw new Error(`attachCDP failed after retries: ${lastErr?.message || lastErr}`);
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
  const fname = `card-redesign-${label}-${Date.now()}.png`;
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
  // 清隔离目录
  try { fs.rmSync(TEMP_DATA, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(TEMP_DATA, { recursive: true });
  console.log(`[E2E-CR] TEMP_DATA=${TEMP_DATA}`);

  let hub = null, ws = null;
  try {
    console.log(`[E2E-CR] Step 1: start Hub on CDP port ${CDP_PORT}...`);
    hub = await startHub(CDP_PORT);
    console.log(`  -> Hub PID=${hub.pid}, ready signal seen`);
    await new Promise(r => setTimeout(r, 2000));

    console.log('[E2E-CR] Step 2: attach CDP...');
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

    console.log('[E2E-CR] Step 3: create meeting + add 3 sub-sessions to render cards...');
    const meetingId = await evalRpc(ws, `(async () => {
      const { ipcRenderer } = require('electron');
      const m = await ipcRenderer.invoke('create-meeting');
      // 三家假 sub（不必等 PTY 真就绪—只验 DOM 结构）
      // 这里直接走 add-meeting-sub，让卡片 DOM 渲染出来
      for (const kind of ['claude', 'gemini', 'codex']) {
        try { await ipcRenderer.invoke('add-meeting-sub', { meetingId: m.id, kind, opts: {} }); } catch (e) {}
      }
      meetings[m.id] = m;
      selectMeeting(m.id);
      await new Promise(r => setTimeout(r, 2500));
      return m.id;
    })()`);
    console.log(`  -> meeting created: ${meetingId}`);

    const s1 = await screenshot(ws, 'initial-cards');
    console.log(`  screenshot: ${s1}`);
    screenshots.push(s1);

    console.log('[E2E-CR] Step 4: verify CSS anti-jitter rules...');
    const cssAudit = await evalRpc(ws, `(() => {
      const strip = document.querySelector('.mr-ft-strip');
      const card = document.querySelector('.mr-ft');
      if (!strip || !card) return { error: 'no strip or card found' };
      const stripStyle = getComputedStyle(strip);
      const cardStyle = getComputedStyle(card);
      return {
        stripDisplay: stripStyle.display,
        stripGridCols: stripStyle.gridTemplateColumns,
        cardHeight: cardStyle.height,
        cardDisplay: cardStyle.display,
        cardFlexDir: cardStyle.flexDirection,
        cardOverflow: cardStyle.overflow,
      };
    })()`);
    console.log(`  cssAudit: ${JSON.stringify(cssAudit)}`);
    if (cssAudit && !cssAudit.error) {
      assert(cssAudit.stripDisplay === 'grid', 'strip display: grid');
      // grid-template-columns: minmax(0, 1fr) repeated 3x → computed 应是三个相等 px
      const cols = (cssAudit.stripGridCols || '').split(/\s+/);
      assert(cols.length === 3, `strip has 3 columns (got ${cols.length})`);
      if (cols.length === 3) {
        const widths = cols.map(c => parseFloat(c));
        const allFinite = widths.every(w => Number.isFinite(w));
        const maxDiff = allFinite ? Math.max(...widths) - Math.min(...widths) : Infinity;
        assert(allFinite && maxDiff < 1, `strip 3 cols equal-width (max diff ${maxDiff.toFixed(2)}px)`);
      }
      assert(cssAudit.cardHeight === '220px', `card height = 220px (got ${cssAudit.cardHeight})`);
      assert(cssAudit.cardDisplay === 'flex', `card display: flex (got ${cssAudit.cardDisplay})`);
      assert(cssAudit.cardFlexDir === 'column', `card flex-direction: column`);
      assert(cssAudit.cardOverflow === 'hidden', 'card overflow: hidden');
    } else {
      assert(false, 'CSS audit needs strip + card present');
    }

    console.log('[E2E-CR] Step 5: verify DOM structure...');
    const domAudit = await evalRpc(ws, `(() => {
      const card = document.querySelector('.mr-ft');
      if (!card) return { error: 'no card' };
      const head = card.querySelector('.mr-ft-head');
      const avatar = card.querySelector('.mr-ft-avatar');
      const info = card.querySelector('.mr-ft-info');
      const row1 = card.querySelector('.mr-ft-row1');
      const row2 = card.querySelector('.mr-ft-row2');
      const row3 = card.querySelector('.mr-ft-row3');
      const row4 = card.querySelector('.mr-ft-row4');
      const bottom = card.querySelector('.mr-ft-bottom');
      const avatarImg = avatar ? avatar.querySelector('img') : null;
      return {
        hasHead: !!head,
        hasAvatar: !!avatar,
        hasInfo: !!info,
        hasRow1: !!row1, hasRow2: !!row2, hasRow3: !!row3, hasRow4: !!row4,
        hasBottom: !!bottom,
        avatarSrc: avatarImg ? avatarImg.getAttribute('src') : null,
        row3Text: row3 ? row3.textContent : '',
        row4Text: row4 ? row4.textContent : '',
      };
    })()`);
    console.log(`  domAudit: ${JSON.stringify(domAudit)}`);
    if (!domAudit.error) {
      assert(domAudit.hasHead, '.mr-ft-head exists');
      assert(domAudit.hasAvatar, '.mr-ft-avatar exists');
      assert(domAudit.hasInfo, '.mr-ft-info exists');
      assert(domAudit.hasRow3, '.mr-ft-row3 (⏱ time) exists');
      assert(domAudit.hasRow4, '.mr-ft-row4 (🪙 token) exists');
      assert(domAudit.hasBottom, '.mr-ft-bottom exists');
      // 头像可能是 PNG（avatarSrc 含 pokemon）或 emoji fallback（onerror 替换）
      assert(domAudit.avatarSrc === null || /pokemon\/(pikachu|charmander|squirtle)\.png/.test(domAudit.avatarSrc),
        `avatar src points to pokemon PNG (got: ${domAudit.avatarSrc})`);
      assert(domAudit.row3Text.includes('⏱') && domAudit.row3Text.includes('本轮') && domAudit.row3Text.includes('累计'),
        `row3 text contains ⏱/本轮/累计 (got: ${domAudit.row3Text.trim().slice(0, 60)})`);
      assert(domAudit.row4Text.includes('🪙') && domAudit.row4Text.includes('本轮') && domAudit.row4Text.includes('累计'),
        `row4 text contains 🪙/本轮/累计 (got: ${domAudit.row4Text.trim().slice(0, 60)})`);
    } else {
      console.log(`  (DOM audit skipped: ${domAudit.error})`);
    }

    console.log('[E2E-CR] Step 6: verify 3 cards rendered (one per kind)...');
    const cardCount = await evalRpc(ws, `document.querySelectorAll('.mr-ft').length`);
    console.log(`  card count: ${cardCount}`);
    assert(cardCount === 3, `3 cards rendered (got ${cardCount})`);

    const s2 = await screenshot(ws, 'final');
    console.log(`  screenshot: ${s2}`);
    screenshots.push(s2);

  } catch (e) {
    console.error('[E2E-CR] EXCEPTION:', e.message);
    console.error(e.stack);
    failed++;
    failures.push(`Exception: ${e.message}`);
    if (ws) try { const s = await screenshot(ws, 'error'); console.log(`error screenshot: ${s}`); screenshots.push(s); } catch {}
  } finally {
    console.log('[E2E-CR] Cleanup: closing CDP, killing Hub...');
    if (ws) try { ws.close(); } catch {}
    if (hub) {
      try { hub.kill('SIGKILL'); } catch {}
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  console.log(`\n========================================`);
  console.log(`[E2E-CR SUMMARY] ${passed} passed, ${failed} failed`);
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
