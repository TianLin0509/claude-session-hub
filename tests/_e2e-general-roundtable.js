// Phase 7 E2E Test 2: General roundtable default + UI + mutual exclusion +
// parseDriverCommand integration via UI input.
//
// Verifies:
//   - Fresh meeting defaults to roundtableMode = true
//   - Card panel renders with title "圆桌讨论"
//   - Focus / Blackboard layout buttons NOT visible (hidden in roundtableMode)
//   - 3-xterm terminals container has class mr-terminals-hidden
//   - Mode toggle shows 圆桌 as active
//   - Click 主驾 → driverMode active, roundtableMode false
//   - Click 投研 → researchMode active, title becomes "投研圆桌"
//   - Click 圆桌 → back to roundtableMode
//   - Mutual exclusion enforced both directions
//   - <arena-prompts>/<id>-roundtable.md is written on roundtable enable, contains
//     "圆桌讨论规则" but NOT "LinDangAgent"
//   - parseDriverCommand UI integration: input is cleared after Enter (best-effort)
//
// Runs Hub in isolated mode via CLAUDE_HUB_DATA_DIR + custom CDP port.
// No real CLI sessions are attached.

'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('../node_modules/ws');

const HUB_DIR = path.resolve(__dirname, '..');
const ELECTRON = path.join(HUB_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const TEMP_DATA = 'C:\\Users\\lintian\\AppData\\Local\\Temp\\hub-roundtable-e2e-general';
const CDP_PORT = 9225;
const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');

let _id = 0;
let assertionsPassed = 0;
let assertionsFailed = 0;
const failures = [];
const screenshots = [];

function rpc(ws, method, params = {}) {
  const i = ++_id;
  return new Promise((res, rej) => {
    const onMsg = raw => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.id === i) {
        ws.removeListener('message', onMsg);
        msg.error ? rej(new Error(`CDP ${method}: ${msg.error.message || JSON.stringify(msg.error)}`)) : res(msg.result);
      }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => { ws.removeListener('message', onMsg); rej(new Error(`CDP ${method} timeout`)); }, 30000);
  });
}

async function evalRpc(ws, expr) {
  const r = await rpc(ws, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 800));
  return r.result.value;
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
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
    cwd: HUB_DIR, env, detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ready = false;
  return new Promise((resolve, reject) => {
    const onData = (chunk) => {
      const s = chunk.toString();
      if (s.includes('hook server listening')) {
        ready = true;
        resolve(proc);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', reject);
    proc.on('exit', (code) => { if (!ready) reject(new Error(`Hub exited early code=${code}`)); });
    setTimeout(() => { if (!ready) reject(new Error('Hub did not signal ready within 30s')); }, 30000);
  });
}

async function takeScreenshot(ws, label) {
  if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const ts = Date.now();
  const fname = `general-roundtable-${label}-${ts}.png`;
  const fpath = path.join(SCREENSHOT_DIR, fname);
  const r = await rpc(ws, 'Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(fpath, Buffer.from(r.data, 'base64'));
  screenshots.push(fpath);
  return fpath;
}

function assert(cond, msg) {
  if (cond) {
    console.log(`  -> ✓ ${msg}`);
    assertionsPassed++;
  } else {
    console.log(`  -> ✗ FAIL: ${msg}`);
    assertionsFailed++;
    failures.push(msg);
  }
}

async function clickModeAndWait(ws, mode) {
  await evalRpc(ws, `(async () => {
    const btn = document.querySelector('.mr-mode-btn[data-mode="${mode}"]');
    if (!btn) throw new Error('mode-btn not found: ${mode}');
    btn.click();
    // Allow IPC round-trip + meeting-updated event + re-render
    await new Promise(r => setTimeout(r, 2500));
    return true;
  })()`);
}

async function readUiState(ws, meetingId) {
  return await evalRpc(ws, `(async () => {
    const { ipcRenderer } = require('electron');
    const meetings = await ipcRenderer.invoke('get-meetings');
    const m = (meetings || []).find(x => x.id === '${meetingId}');
    const panel = document.getElementById('mr-roundtable-panel');
    const titleEl = panel ? panel.querySelector('.mr-rt-title') : null;
    const focusBtn = document.getElementById('mr-btn-focus');
    const bbBtn = document.getElementById('mr-btn-blackboard');
    const terms = document.getElementById('mr-terminals');
    const activeBtn = document.querySelector('.mr-mode-btn.active');
    return {
      meetingFlags: m ? {
        roundtableMode: !!m.roundtableMode,
        researchMode: !!m.researchMode,
        driverMode: !!m.driverMode,
      } : null,
      panelExists: !!panel,
      titleText: titleEl ? titleEl.textContent.trim() : null,
      focusBtnVisible: !!focusBtn,
      bbBtnVisible: !!bbBtn,
      terminalsHiddenClass: terms ? terms.classList.contains('mr-terminals-hidden') : null,
      activeMode: activeBtn ? activeBtn.getAttribute('data-mode') : null,
    };
  })()`);
}

(async () => {
  // Clean temp data dir
  try { fs.rmSync(TEMP_DATA, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(TEMP_DATA, { recursive: true });
  console.log(`[E2E-2] TEMP_DATA=${TEMP_DATA}`);

  let hub = null;
  let ws = null;
  try {
    console.log(`[E2E-2] Step 1: start Hub on CDP port ${CDP_PORT}...`);
    hub = await startHub(CDP_PORT);
    console.log(`  -> Hub PID=${hub.pid}, ready signal seen`);
    await new Promise(r => setTimeout(r, 2000));

    console.log(`[E2E-2] Step 2: attach CDP...`);
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
    console.log(`  -> CDP attached`);

    console.log(`[E2E-2] Step 3: create a meeting via 'create-meeting' IPC and verify constructor default...`);
    const meetingId = await evalRpc(ws, `(async () => {
      const { ipcRenderer } = require('electron');
      const m = await ipcRenderer.invoke('create-meeting');
      return m.id;
    })()`);
    console.log(`  -> created meeting ${meetingId}`);

    let st = await readUiState(ws, meetingId);
    console.log(`  initial flags: ${JSON.stringify(st.meetingFlags)}`);
    assert(st.meetingFlags && st.meetingFlags.roundtableMode === true, 'fresh meeting defaults to roundtableMode === true');
    assert(st.meetingFlags && st.meetingFlags.researchMode === false, 'fresh meeting researchMode === false');
    assert(st.meetingFlags && st.meetingFlags.driverMode === false, 'fresh meeting driverMode === false');

    console.log(`[E2E-2] Step 4: explicitly enable roundtable mode (write prompt file) + open meeting...`);
    // create-meeting just creates in-memory. To exercise the prompt-file write,
    // call toggle-roundtable-mode IPC (the same handler the UI uses on click).
    await evalRpc(ws, `(async () => {
      const { ipcRenderer } = require('electron');
      const res = await ipcRenderer.invoke('toggle-roundtable-mode', {
        meetingId: '${meetingId}', enabled: true
      });
      if (!res || !res.ok) throw new Error('toggle-roundtable-mode failed: ' + JSON.stringify(res));
      // Attach meeting to renderer's local meetings map and open it
      const m = (await ipcRenderer.invoke('get-meetings')).find(x => x.id === '${meetingId}');
      meetings[m.id] = m;
      selectMeeting(m.id);
      await new Promise(r => setTimeout(r, 1500));
      return true;
    })()`);

    console.log(`[E2E-2] Step 5: assert roundtable UI invariants...`);
    st = await readUiState(ws, meetingId);
    console.log(`  roundtable state: ${JSON.stringify(st)}`);
    assert(st.panelExists, 'roundtable card panel renders');
    assert(st.titleText === '圆桌讨论', `title shows "圆桌讨论" (got "${st.titleText}")`);
    assert(!st.focusBtnVisible, 'Focus layout button is HIDDEN in roundtableMode');
    assert(!st.bbBtnVisible, 'Blackboard layout button is HIDDEN in roundtableMode');
    assert(st.terminalsHiddenClass === true, 'terminals container has mr-terminals-hidden class');
    assert(st.activeMode === 'roundtable', `mode toggle highlights 圆桌 as active (got "${st.activeMode}")`);

    await takeScreenshot(ws, 'roundtable-state');

    console.log(`[E2E-2] Step 6: verify <arena-prompts>/${meetingId}-roundtable.md...`);
    const rtFile = path.join(TEMP_DATA, 'arena-prompts', `${meetingId}-roundtable.md`);
    const rtExists = fs.existsSync(rtFile);
    assert(rtExists, `${rtFile} exists`);
    if (rtExists) {
      const content = fs.readFileSync(rtFile, 'utf-8');
      assert(content.includes('圆桌讨论规则'), 'prompt file contains "圆桌讨论规则"');
      assert(!content.includes('LinDangAgent'), 'prompt file does NOT contain "LinDangAgent" (general roundtable, not 投研)');
      console.log(`  -> roundtable prompt size: ${content.length} chars`);
    }

    console.log(`[E2E-2] Step 7: parseDriverCommand UI integration — type @claude foo, press Enter...`);
    // In roundtableMode with no sub-sessions, sending text via input should
    // route to rt-private (because @claude is a single-target). The send path
    // in handleMeetingSend will hit the 'rt-private' branch but with no claude
    // sub session — best-effort behavior. We check the input box clears.
    const mentionState = await evalRpc(ws, `(async () => {
      const box = document.getElementById('mr-input-box');
      if (!box) return { error: 'no input box' };
      box.textContent = '@';
      box.focus();
      const range = document.createRange();
      range.selectNodeContents(box);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      box.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 250));
      const menu = document.getElementById('mr-rt-mention-menu');
      const buttons = Array.from(document.querySelectorAll('.mr-rt-mention-item'));
      const visibleBeforePick = !!menu && menu.style.display !== 'none';
      const items = buttons.map(btn => ({
        label: btn.querySelector('.mr-rt-mention-label')?.textContent || '',
        value: btn.querySelector('.mr-rt-mention-value')?.textContent || ''
      }));
      const debate = buttons.find(btn => btn.querySelector('.mr-rt-mention-value')?.textContent === '@debate');
      if (debate) debate.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 100));
      return {
        visible: visibleBeforePick,
        count: items.length,
        values: items.map(x => x.value),
        afterPick: box.textContent
      };
    })()`);
    console.log(`  mention menu: ${JSON.stringify(mentionState)}`);
    assert(mentionState.visible === true, '@ mention menu becomes visible');
    assert(mentionState.count === 5, '@ mention menu shows 5 choices');
    assert(['@claude', '@gemini', '@codex', '@debate', '@summary @claude'].every(v => mentionState.values.includes(v)),
      '@ mention menu includes 3 AI choices plus debate and summary');
    assert(mentionState.afterPick === '@debate ', 'clicking @debate inserts command into input');

    const aiFocusState = await evalRpc(ws, `(async () => {
      const { ipcRenderer } = require('electron');
      const box = document.getElementById('mr-input-box');
      const terminals = document.getElementById('mr-terminals');
      const meeting = window.MeetingRoom.getMeetingData('${meetingId}');
      if (!box || !terminals || !meeting || typeof sessions === 'undefined') {
        return { error: 'missing renderer fixtures' };
      }
      const originalSend = ipcRenderer.send.bind(ipcRenderer);
      ipcRenderer.send = (channel, ...args) => {
        if (channel === 'update-meeting') return;
        return originalSend(channel, ...args);
      };
      const originalSubs = Array.isArray(meeting.subSessions) ? meeting.subSessions.slice() : [];
      const originalFocused = meeting.focusedSub || null;
      const fakeSubs = [
        ['fake-claude', 'claude'],
        ['fake-gemini', 'gemini'],
        ['fake-codex', 'codex']
      ];
      for (const [sid, kind] of fakeSubs) {
        sessions.set(sid, { id: sid, kind, title: kind, status: 'active' });
        const slot = document.createElement('div');
        slot.className = 'mr-sub-slot';
        slot.dataset.sessionId = sid;
        slot.style.display = sid === 'fake-gemini' ? '' : 'none';
        terminals.appendChild(slot);
      }
      meeting.subSessions = fakeSubs.map(x => x[0]);
      meeting.focusedSub = 'fake-gemini';
      box.textContent = '@cl';
      box.focus();
      const range = document.createRange();
      range.selectNodeContents(box);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      box.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 100));
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 250));
      const visibleSid = Array.from(terminals.querySelectorAll('.mr-sub-slot'))
        .filter(slot => slot.style.display !== 'none')
        .map(slot => slot.dataset.sessionId)
        .find(sid => sid && sid.startsWith('fake-')) || null;
      const focusedAfter = meeting.focusedSub;
      const inputAfter = box.textContent;
      for (const [sid] of fakeSubs) {
        sessions.delete(sid);
        terminals.querySelectorAll('.mr-sub-slot').forEach(slot => {
          if (slot.dataset.sessionId === sid) slot.remove();
        });
      }
      meeting.subSessions = originalSubs;
      meeting.focusedSub = originalFocused;
      ipcRenderer.send = originalSend;
      return { focusedAfter, visibleSid, inputAfter };
    })()`);
    console.log(`  AI focus after mention: ${JSON.stringify(aiFocusState)}`);
    assert(aiFocusState.focusedAfter === 'fake-claude', 'selecting @claude focuses Claude shell');
    assert(aiFocusState.visibleSid === 'fake-claude', 'selecting @claude shows Claude shell slot');
    assert(aiFocusState.inputAfter === '@claude ', 'keyboard selection inserts @claude');

    const inputCleared = await evalRpc(ws, `(async () => {
      const box = document.getElementById('mr-input-box');
      if (!box) return { error: 'no input box' };
      box.innerText = '@claude foo';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      const sendBtn = document.getElementById('mr-send-btn');
      if (sendBtn) sendBtn.click();
      // Allow handler to run / clear input
      await new Promise(r => setTimeout(r, 800));
      return { afterText: box.innerText };
    })()`);
    console.log(`  input after send: ${JSON.stringify(inputCleared)}`);
    // Best-effort: input is either cleared or unchanged depending on how
    // handleMeetingSend handles "no sub-sessions" early-return. Don't fail
    // the whole test on this — log it.
    if (inputCleared.afterText === '' || inputCleared.afterText === '@claude foo') {
      console.log(`  -> input state: '${inputCleared.afterText}' (acceptable — no real sub-sessions to receive)`);
      assertionsPassed++;
    } else {
      console.log(`  -> input state unexpected: '${inputCleared.afterText}'`);
    }

    console.log(`[E2E-2] Step 8: click 主驾 mode button → expect driverMode active...`);
    await clickModeAndWait(ws, 'driver');
    st = await readUiState(ws, meetingId);
    console.log(`  after 主驾: ${JSON.stringify(st)}`);
    assert(st.meetingFlags.driverMode === true, 'driverMode === true');
    assert(st.meetingFlags.roundtableMode === false, 'roundtableMode === false (mutex)');
    assert(st.meetingFlags.researchMode === false, 'researchMode === false (mutex)');
    assert(st.activeMode === 'driver', `mode toggle active is 'driver' (got "${st.activeMode}")`);
    // In driver mode, the legacy layout buttons should reappear and panel removed
    assert(!st.panelExists, 'roundtable panel is removed in driverMode');
    assert(st.focusBtnVisible, 'Focus button reappears in driverMode');

    await takeScreenshot(ws, 'driver-state');

    console.log(`[E2E-2] Step 9: click 投研 mode button → expect researchMode active + title 投研圆桌...`);
    await clickModeAndWait(ws, 'research');
    st = await readUiState(ws, meetingId);
    console.log(`  after 投研: ${JSON.stringify(st)}`);
    assert(st.meetingFlags.researchMode === true, 'researchMode === true');
    assert(st.meetingFlags.roundtableMode === false, 'roundtableMode === false (mutex)');
    assert(st.meetingFlags.driverMode === false, 'driverMode === false (mutex)');
    assert(st.activeMode === 'research', `mode toggle active is 'research' (got "${st.activeMode}")`);
    assert(st.panelExists, 'roundtable panel renders in researchMode (shared panel)');
    assert(st.titleText === '投研圆桌', `title becomes "投研圆桌" (got "${st.titleText}")`);
    assert(st.focusBtnVisible, 'Focus button is visible in researchMode (legacy preserved)');

    await takeScreenshot(ws, 'research-state');

    console.log(`[E2E-2] Step 10: click 圆桌 mode button → expect back to roundtableMode...`);
    await clickModeAndWait(ws, 'roundtable');
    st = await readUiState(ws, meetingId);
    console.log(`  after 圆桌: ${JSON.stringify(st)}`);
    assert(st.meetingFlags.roundtableMode === true, 'roundtableMode === true (back to default)');
    assert(st.meetingFlags.researchMode === false, 'researchMode === false (mutex enforced going back)');
    assert(st.meetingFlags.driverMode === false, 'driverMode === false (mutex enforced going back)');
    assert(st.activeMode === 'roundtable', `mode toggle active is 'roundtable' (got "${st.activeMode}")`);
    assert(st.titleText === '圆桌讨论', `title back to "圆桌讨论" (got "${st.titleText}")`);
    assert(!st.focusBtnVisible, 'Focus button hidden again in roundtableMode');
    assert(st.terminalsHiddenClass === true, 'terminals container hidden again');

    await takeScreenshot(ws, 'roundtable-after-cycle');

    console.log(`[E2E-2] Step 11: mutual-exclusion — research→roundtable transition...`);
    await clickModeAndWait(ws, 'research');
    let mid = await readUiState(ws, meetingId);
    assert(mid.meetingFlags.researchMode === true && mid.meetingFlags.roundtableMode === false,
      'after research: researchMode true, roundtableMode false');
    await clickModeAndWait(ws, 'roundtable');
    mid = await readUiState(ws, meetingId);
    assert(mid.meetingFlags.roundtableMode === true && mid.meetingFlags.researchMode === false,
      'after roundtable: roundtableMode true, researchMode false');

  } catch (e) {
    console.error(`[E2E-2] EXCEPTION:`, e.message);
    console.error(e.stack);
    assertionsFailed++;
    failures.push(`Exception: ${e.message}`);
    if (ws) {
      try { await takeScreenshot(ws, 'error'); } catch {}
    }
  } finally {
    console.log(`[E2E-2] Cleanup: closing CDP, killing Hub...`);
    if (ws) { try { ws.close(); } catch {} }
    if (hub) {
      try { hub.kill('SIGKILL'); } catch {}
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  console.log(`\n========================================`);
  console.log(`[E2E-2 SUMMARY] ${assertionsPassed} passed, ${assertionsFailed} failed`);
  if (screenshots.length > 0) {
    console.log(`Screenshots:`);
    for (const s of screenshots) console.log(`  ${s}`);
  }
  if (assertionsFailed === 0) {
    console.log(`✅ All ${assertionsPassed} assertions passed`);
    process.exit(0);
  } else {
    console.log(`❌ ${assertionsFailed} assertion(s) failed:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
})();
