'use strict';

// 长文本粘贴：隔离 Hub + 假 CLI（不花额度），在会话输入框里粘贴 3000 行，
// 测粘贴本身和粘贴后打字的主线程阻塞（longtask 合计），并检查粘贴块的行为。
//
// 注意：粘贴用构造的 ClipboardEvent（带 DataTransfer）触发，不碰用户的系统剪贴板；
// 它走的是输入框真实的 paste 监听器，但不等同于用户真按 Ctrl+V（未覆盖系统剪贴板读取）。
// 打字用 CDP Input.insertText / dispatchKeyEvent，属于浏览器层的真实输入事件。
//
// HUB_PASTE_E2E_MODE=measure 只测量不断言，用于对比改动前后的基线。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const ROOT = path.resolve(__dirname, '..');
const RUN_ID = `${Date.now()}-${process.pid}`;
const TEMP_ROOT = path.join(os.tmpdir(), `hub-paste-chip-${RUN_ID}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const WORK_DIR = path.join(TEMP_ROOT, 'workspace');
const FAKE_BIN_DIR = path.join(TEMP_ROOT, 'fake-bin');
const CODEX_HOME = path.join(TEMP_ROOT, 'codex-home');
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'composer-paste-chip');
const RESULT_PATH = path.join(ARTIFACT_DIR, `composer-paste-chip-${RUN_ID}.json`);
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, `composer-paste-chip-${RUN_ID}.png`);
const MEASURE_ONLY = process.env.HUB_PASTE_E2E_MODE === 'measure';
const SESSION_ID = 'hub-claude-paste-target';
const CLAUDE_SID = '55555555-5555-4555-8555-555555555555';
const LINES = Number(process.env.HUB_PASTE_E2E_LINES) || 3000;
// HUB_PASTE_E2E_REAL_CLIPBOARD=1：用系统剪贴板 + 真实 Ctrl+V 按键，而不是构造 paste 事件。
const REAL_CLIPBOARD = process.env.HUB_PASTE_E2E_REAL_CLIPBOARD === '1';
const CLIPBOARD_GUARD = path.join(__dirname, 'helpers', 'clipboard-guard.ps1');

function clipboardGuard(action, dir, textFile) {
  const args = ['-STA', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', CLIPBOARD_GUARD, action, dir];
  if (textFile) args.push('-TextFile', textFile);
  const run = require('node:child_process').spawnSync('powershell', args, { encoding: 'utf8', windowsHide: true });
  return { code: run.status, out: String(run.stdout || '').trim() + String(run.stderr || '').trim() };
}

// 这个测试会写系统剪贴板，而且不止真实 Ctrl+V 一处：「复制输入框内容」那步派发的 copy 事件
// 会触发 Hub 全局的复制兜底（clipboard-controller 的 handleNativeCopy），把选区真实写进剪贴板。
// 所以整个测试开始前先备份用户剪贴板，结束时恢复并逐格式核对。备份失败（有无法原样恢复的
// 格式）就不跑；恢复时剪贴板若已不是测试写入的任何一份文字（用户中途复制了别的），则不覆盖。
const CLIPBOARD_DIR = path.join(TEMP_ROOT, 'clipboard-backup');
const PASTE_TEXT_FILE = path.join(TEMP_ROOT, 'clipboard-paste-text.txt');
const COPIED_TEXT_FILE = path.join(TEMP_ROOT, 'clipboard-copied-text.txt');

function backupUserClipboard() {
  const backup = clipboardGuard('backup', CLIPBOARD_DIR);
  if (backup.code !== 0) throw new Error(`用户剪贴板无法安全备份，测试不运行（会写系统剪贴板）：${backup.out}`);
  return backup.out;
}

function restoreUserClipboard(candidateFiles) {
  const restore = clipboardGuard('restore', CLIPBOARD_DIR, candidateFiles.join(';'));
  const report = { restore: restore.out };
  if (/^RESTORED/.test(restore.out)) {
    const verify = clipboardGuard('verify', CLIPBOARD_DIR);
    report.verify = verify.out;
    if (verify.code !== 0) console.error(`⚠ 剪贴板恢复后核对不一致：${verify.out}；原始内容备份在 ${CLIPBOARD_DIR}`);
  }
  report.ok = /^(VERIFIED|SKIPPED)/.test(report.verify || report.restore);
  console.log(`[clipboard] ${report.restore}${report.verify ? ' / ' + report.verify : ''}`);
  return report;
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitFor(label, fn, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) { lastError = error; }
    await _waitMs(150);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? ': ' + lastError.message : ''}`);
}

function writeFixtures() {
  fs.mkdirSync(FAKE_BIN_DIR, { recursive: true });
  const fakeCliPath = path.join(FAKE_BIN_DIR, 'fake-cli.js');
  fs.writeFileSync(fakeCliPath, "'use strict';\nprocess.stdout.write('[fake-cli]\\r\\n');\nsetTimeout(() => process.exit(0), 120);\n", 'utf8');
  for (const provider of ['claude', 'codex']) {
    fs.writeFileSync(path.join(FAKE_BIN_DIR, `${provider}.cmd`),
      `@echo off\r\n"${process.execPath}" "${fakeCliPath}" ${provider} %*\r\n`, 'utf8');
  }
  fs.mkdirSync(WORK_DIR, { recursive: true });
  fs.mkdirSync(CODEX_HOME, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'config.json'), JSON.stringify({
    providers: {
      claude: { backend: 'subscription' },
      codex: { backend: 'subscription', subscription_profile: 'e2e', subscription_profiles: [{ id: 'e2e', label: 'E2E', home: CODEX_HOME }] },
    },
  }, null, 2), 'utf8');
  const claudeDir = path.join(TEMP_ROOT, 'claude-projects', 'paste-e2e');
  fs.mkdirSync(claudeDir, { recursive: true });
  const claudePath = path.join(claudeDir, `${CLAUDE_SID}.jsonl`);
  fs.writeFileSync(claudePath, [
    { type: 'user', uuid: 'u1', timestamp: '2026-09-25T10:00:00Z', message: { role: 'user', content: '你好' } },
    { type: 'assistant', uuid: 'a1', timestamp: '2026-09-25T10:00:01Z', message: { role: 'assistant', model: 'claude-haiku', stop_reason: 'end_turn', content: [{ type: 'text', text: '你好' }] } },
  ].map(row => JSON.stringify({ ...row, sessionId: CLAUDE_SID, cwd: WORK_DIR })).join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(DATA_DIR, 'state.json'), JSON.stringify({
    version: 1,
    cleanShutdown: true,
    sessions: [{ schemaVersion: 1, hubId: SESSION_ID, kind: 'claude', title: 'Claude 粘贴测试', cwd: WORK_DIR,
      ccSessionId: CLAUDE_SID, transcriptPath: claudePath,
      lastMessageTime: Date.now() - 60_000, updatedAt: Date.now() - 60_000 }],
    meetings: [],
    immersiveByMeeting: {},
  }, null, 2), 'utf8');
}

// 页面内：挂 longtask 观察器，返回自上次调用以来的阻塞合计。
const INSTALL_PROBE = `(() => {
  if (window.__pasteProbe) return true;
  const probe = { total: 0, max: 0, count: 0 };
  new PerformanceObserver(list => {
    for (const entry of list.getEntries()) { probe.total += entry.duration; probe.max = Math.max(probe.max, entry.duration); probe.count += 1; }
  }).observe({ entryTypes: ['longtask'] });
  window.__pasteProbe = probe;
  window.__takeProbe = () => { const snap = { total: Math.round(probe.total), max: Math.round(probe.max), count: probe.count }; probe.total = 0; probe.max = 0; probe.count = 0; return snap; };
  return true;
})()`;

const settle = client => client.eval('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => r(true), 50))))');

async function measure(client, label, action) {
  console.log(`[step] ${label}`);
  await client.eval('window.__takeProbe()');
  const startedAt = Date.now();
  await action();
  await settle(client);
  await _waitMs(300);
  const wallMs = Date.now() - startedAt;
  const blocking = await client.eval('window.__takeProbe()');
  return { label, wallMs, ...blocking };
}

async function typeKeys(client, text) {
  for (const ch of text) {
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
  }
}

async function main() {
  writeFixtures();
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const pasteText = Array.from({ length: LINES }, (_, i) => `第 ${i + 1} 行：链路自适应 BLER 目标与 MCS 选择的仿真日志 value=${(i * 0.37).toFixed(2)} ok`).join('\n');
  const composedText = '请看这段：' + pasteText + '，帮我分析一下异常点短短一行';
  fs.writeFileSync(PASTE_TEXT_FILE, pasteText, 'utf8');
  fs.writeFileSync(COPIED_TEXT_FILE, composedText, 'utf8');
  const clipboardBackup = backupUserClipboard();
  const port = Number(process.env.HUB_PASTE_E2E_PORT) || await reservePort();
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'Path';
  const result = { runId: RUN_ID, mode: MEASURE_ONLY ? 'measure' : 'assert', lines: LINES, realClipboard: REAL_CLIPBOARD, clipboardBackup };
  let hub = null;
  let client = null;
  try {
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR,
      port,
      label: 'composer-paste-chip',
      extraEnv: {
        [pathKey]: `${FAKE_BIN_DIR}${path.delimiter}${process.env[pathKey] || ''}`,
        HUB_CLAUDE_BACKEND: 'subscription',
        HUB_CODEX_BACKEND: 'subscription',
        HUB_CODEX_PROFILE: 'e2e',
        HUB_SESSION_SEARCH_PREWARM: '0',
      },
    });
    await _waitMs(1000);
    client = await connectFirstPage(hub, target => target.type === 'page' && /index\.html/i.test(target.url || ''));
    await waitFor('session loaded', () => client.eval(`sessions.has(${JSON.stringify(SESSION_ID)})`));
    await client.eval(`selectSession(${JSON.stringify(SESSION_ID)})`);
    await waitFor('composer', () => client.eval("!!document.querySelector('.floating-input-box')"));
    await client.eval(INSTALL_PROBE);
    await client.eval("document.querySelector('.floating-input-box').focus()");
    await settle(client);

    await typeKeys(client, '请看这段：');
    result.pasteChars = pasteText.length;

    if (REAL_CLIPBOARD) {
      // 真实路径：文字先进系统剪贴板（模拟从别的程序复制），再按 Ctrl+V，
      // 由 Chromium 自己读系统剪贴板、派发真实 paste 事件。用户原剪贴板测完原样恢复。
      // 占用剪贴板的窗口尽量短：写入 → 按键 → 立刻恢复。
      const set = clipboardGuard('settext', CLIPBOARD_DIR, PASTE_TEXT_FILE);
      if (set.code !== 0) throw new Error(`写入测试文字失败：${set.out}`);
      try {
        await client.eval("document.querySelector('.floating-input-box').focus()");
        result.paste = await measure(client, 'paste (real Ctrl+V)', async () => {
          await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 2 });
          await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 2 });
          await waitFor('chip from real paste', () => client.eval("document.querySelectorAll('.floating-input-box .fi-paste-chip').length === 1"), 10000);
        });
      } finally {
        result.clipboardAfterPaste = restoreUserClipboard([PASTE_TEXT_FILE]);
      }
    } else {
      result.paste = await measure(client, 'paste', () => client.eval(`(() => {
        const box = document.querySelector('.floating-input-box');
        box.focus();
        const dt = new DataTransfer();
        dt.setData('text/plain', ${JSON.stringify(pasteText)});
        box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        return true;
      })()`));
    }
    if (REAL_CLIPBOARD) assert.ok(result.clipboardAfterPaste.ok, `user clipboard must be restored intact: ${JSON.stringify(result.clipboardAfterPaste)}`);
    result.typeAfterPaste = await measure(client, 'type 10 chars after paste', () => typeKeys(client, '，帮我分析一下异常点'));

    result.dom = await client.eval(`(() => {
      const box = document.querySelector('.floating-input-box');
      const chip = box.querySelector('.fi-paste-chip');
      return {
        nodeCount: box.getElementsByTagName('*').length,
        chipCount: box.querySelectorAll('.fi-paste-chip').length,
        chipLabel: chip ? getComputedStyle(chip, '::before').content : null,
        chipEditable: chip ? chip.getAttribute('contenteditable') : null,
        visibleTextChars: box.innerText.length,
      };
    })()`);
    result.expanded = await client.eval(`(() => {
      const text = readContenteditablePlainText(document.querySelector('.floating-input-box'));
      return { length: text.length, head: text.slice(0, 40), tail: text.slice(-20) };
    })()`);
    console.log(JSON.stringify({ paste: result.paste, typeAfterPaste: result.typeAfterPaste, dom: result.dom, expanded: result.expanded }, null, 2));
    const shot = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(SCREENSHOT_PATH, Buffer.from(shot.data, 'base64'));
    result.screenshot = SCREENSHOT_PATH;

    if (!MEASURE_ONLY) {
      // 粘贴块：DOM 里只有一个不可编辑的块，读出来的是「前缀 + 原文 + 后缀」，逐字不差
      assert.equal(result.dom.chipCount, 1, 'long paste must collapse into one chip');
      assert.equal(result.dom.chipEditable, 'false');
      assert.match(result.dom.chipLabel, new RegExp(`${LINES} 行`));
      assert.ok(result.dom.nodeCount < 20, `composer DOM must stay small, got ${result.dom.nodeCount}`);
      const full = await client.eval("readContenteditablePlainText(document.querySelector('.floating-input-box'))");
      assert.equal(full, '请看这段：' + pasteText + '，帮我分析一下异常点', 'expanded text must equal typed + pasted text exactly');
      assert.ok(result.typeAfterPaste.total < 200, `typing after paste must not block (got ${result.typeAfterPaste.total}ms longtask)`);

      // 悬停：真实鼠标移到块上，出现预览，含首行和行数
      const chipBox = await client.eval(`(() => {
        const r = document.querySelector('.floating-input-box .fi-paste-chip').getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
      })()`);
      assert.ok(chipBox.w > 40 && chipBox.h > 10, 'chip must be visible');
      await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: chipBox.x, y: chipBox.y });
      result.hover = await waitFor('paste preview', () => client.eval(`(() => {
        const pop = document.querySelector('.fi-paste-preview');
        if (!pop || pop.hidden) return null;
        const r = pop.getBoundingClientRect();
        return { text: pop.innerText.slice(0, 200), visible: r.width > 0 && r.height > 0, inViewport: r.top >= 0 && r.bottom <= innerHeight };
      })()`), 5000);
      assert.equal(result.hover.visible, true);
      assert.equal(result.hover.inViewport, true);
      assert.match(result.hover.text, /第 1 行：链路自适应/);
      assert.match(result.hover.text, new RegExp(`${LINES} 行`));
      const hoverShot = await client.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(SCREENSHOT_PATH.replace('.png', '-hover.png'), Buffer.from(hoverShot.data, 'base64'));
      await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
      await waitFor('preview hidden', () => client.eval("(() => { const p = document.querySelector('.fi-paste-preview'); return !p || p.hidden; })()"), 5000);

      // 短文本照常内联，不变成块
      await client.eval(`(() => {
        const box = document.querySelector('.floating-input-box');
        const dt = new DataTransfer();
        dt.setData('text/plain', '短短一行');
        box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      })()`);
      result.shortPaste = await client.eval(`(() => {
        const box = document.querySelector('.floating-input-box');
        return { chips: box.querySelectorAll('.fi-paste-chip').length, endsWith: readContenteditablePlainText(box).endsWith('短短一行') };
      })()`);
      assert.deepEqual(result.shortPaste, { chips: 1, endsWith: true });

      // 退格：光标在块后面时，一次退格删掉整个块（和 CLI 一样）
      await client.eval(`(() => {
        const box = document.querySelector('.floating-input-box');
        const chip = box.querySelector('.fi-paste-chip');
        const range = document.createRange();
        range.setStartAfter(chip); range.collapse(true);
        const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
      })()`);
      await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
      await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
      result.afterBackspace = await client.eval(`(() => {
        const box = document.querySelector('.floating-input-box');
        return { chips: box.querySelectorAll('.fi-paste-chip').length, text: readContenteditablePlainText(box) };
      })()`);
      assert.equal(result.afterBackspace.chips, 0, 'one backspace removes the whole chip');
      assert.equal(result.afterBackspace.text, '请看这段：，帮我分析一下异常点短短一行');

      // 撤销：Ctrl+Z 把块找回来，内容仍可完整展开
      await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2, commands: ['undo'] });
      await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 });
      result.afterUndo = await client.eval(`(() => {
        const box = document.querySelector('.floating-input-box');
        return { chips: box.querySelectorAll('.fi-paste-chip').length, length: readContenteditablePlainText(box).length };
      })()`);
      assert.equal(result.afterUndo.chips, 1, 'undo restores the chip');
      assert.equal(result.afterUndo.length, ('请看这段：' + pasteText + '，帮我分析一下异常点短短一行').length);

      // 复制输入框里的块：剪贴板拿到的是原文，而不是块的内部标记
      result.copyOut = await client.eval(`(() => {
        const box = document.querySelector('.floating-input-box');
        const range = document.createRange(); range.selectNodeContents(box);
        const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
        const dt = new DataTransfer();
        const event = new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true });
        box.dispatchEvent(event);
        const text = dt.getData('text/plain');
        return { prevented: event.defaultPrevented, length: text.length, hasMarker: /[\\uE000\\uE001]/.test(text) };
      })()`);
      assert.equal(result.copyOut.prevented, true);
      assert.equal(result.copyOut.hasMarker, false);
      assert.equal(result.copyOut.length, result.afterUndo.length);

      // 发送：拦截 send-prompt，确认发出去的是完整原文，输入框清空
      await client.eval(`(() => {
        const { ipcRenderer } = require('electron');
        window.__sentPrompts = [];
        const original = ipcRenderer.invoke.bind(ipcRenderer);
        ipcRenderer.invoke = (channel, payload, ...rest) => {
          if (channel === 'session:send-prompt') { window.__sentPrompts.push(payload.text); return Promise.resolve({ ok: true, sendStatus: 'confirmed' }); }
          return original(channel, payload, ...rest);
        };
        document.querySelector('.floating-input-box').focus();
        placeCaretAtContenteditableEnd(document.querySelector('.floating-input-box'));
      })()`);
      await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      const sent = await waitFor('prompt sent', () => client.eval('window.__sentPrompts && window.__sentPrompts[0]'), 5000);
      assert.equal(sent, '请看这段：' + pasteText + '，帮我分析一下异常点短短一行', 'sent prompt must be the full original text');
      result.sentLength = sent.length;
      result.inputAfterSend = await client.eval("readContenteditablePlainText(document.querySelector('.floating-input-box'))");
      assert.equal(result.inputAfterSend.trim(), '');
    }

    result.ok = true;
    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
    console.log(`E2E composer-paste-chip (${result.mode}): PASS`);
  } catch (error) {
    result.ok = false;
    result.error = error && error.stack || String(error);
    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
    if (client) {
      try {
        const shot = await client.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(SCREENSHOT_PATH.replace('.png', '-fail.png'), Buffer.from(shot.data, 'base64'));
      } catch {}
    }
    throw error;
  } finally {
    if (client) { try { client.close(); } catch {} }
    if (hub) await gracefulQuit(hub);
    // 复制那步会经 Hub 的全局复制兜底真实写剪贴板；不论测试成败都在这里还原。
    result.clipboardAtEnd = restoreUserClipboard([PASTE_TEXT_FILE, COPIED_TEXT_FILE]);
    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
    if (!result.clipboardAtEnd.ok) {
      console.error(`✗ 用户剪贴板未能原样恢复，原始内容备份在 ${CLIPBOARD_DIR}`);
      process.exitCode = 1;
    }
  }
}

main().catch(error => { console.error(error); process.exit(1); });
