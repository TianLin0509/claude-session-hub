'use strict';

// 群聊输入框的长文本粘贴块：隔离 Hub + 假 CLI + 伪造的休眠群聊（不唤醒真实 CLI）。
// 粘贴用构造的 ClipboardEvent（本测试没有复制步骤，不碰系统剪贴板）；打字、点击是 CDP 真实输入。
// 覆盖：收成块且不卡、块后接着打字、切走再切回块原样还原、真实点击发送的是逐字完整原文。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const ROOT = path.resolve(__dirname, '..');
const RUN_ID = `${Date.now()}-${process.pid}`;
const TEMP_ROOT = path.join(os.tmpdir(), `hub-gc-paste-chip-${RUN_ID}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const WORK_DIR = path.join(TEMP_ROOT, 'workspace');
const FAKE_BIN_DIR = path.join(TEMP_ROOT, 'fake-bin');
const CODEX_HOME = path.join(TEMP_ROOT, 'codex-home');
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'groupchat-paste-chip');
const RESULT_PATH = path.join(ARTIFACT_DIR, `groupchat-paste-chip-${RUN_ID}.json`);
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, `groupchat-paste-chip-${RUN_ID}.png`);
const MEETING_ID = 'meeting-paste-chip-e2e';
const MEMBER_ID = 'member-paste-chip-e2e';
const OTHER_SESSION_ID = 'hub-claude-paste-other';
const LINES = 3000;

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)); });
  });
}

async function waitFor(label, fn, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value; } catch (error) { lastError = error; }
    await _waitMs(150);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? ': ' + lastError.message : ''}`);
}

function writeFixtures() {
  fs.mkdirSync(FAKE_BIN_DIR, { recursive: true });
  const fakeCliPath = path.join(FAKE_BIN_DIR, 'fake-cli.js');
  // 假 CLI 保持运行：一退出会话就变「异常」，群聊项点了也不再切回（时序相关的假失败）。
  fs.writeFileSync(fakeCliPath, "'use strict';\nprocess.stdout.write('[fake-cli]\\r\\n');\nsetInterval(() => {}, 60000);\n", 'utf8');
  for (const provider of ['claude', 'codex']) {
    fs.writeFileSync(path.join(FAKE_BIN_DIR, `${provider}.cmd`), `@echo off\r\n"${process.execPath}" "${fakeCliPath}" ${provider} %*\r\n`, 'utf8');
  }
  for (const dir of [WORK_DIR, CODEX_HOME, DATA_DIR, path.join(DATA_DIR, 'meetings')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'config.json'), JSON.stringify({
    providers: {
      claude: { backend: 'subscription' },
      codex: { backend: 'subscription', subscription_profile: 'e2e', subscription_profiles: [{ id: 'e2e', label: 'E2E', home: CODEX_HOME }] },
    },
  }, null, 2), 'utf8');
  const now = Date.now();
  // 成员要有原生会话 ID 才能被唤醒（由 PATH 里的假 CLI 接住），否则会弹「唤醒失败」挡住输入框。
  const memberSid = '66666666-6666-4666-8666-666666666666';
  const otherSid = '77777777-7777-4777-8777-777777777777';
  const claudeDir = path.join(TEMP_ROOT, 'claude-projects', 'gc-paste');
  fs.mkdirSync(claudeDir, { recursive: true });
  const transcriptFor = sid => {
    const file = path.join(claudeDir, `${sid}.jsonl`);
    fs.writeFileSync(file, [
      { type: 'user', uuid: 'u1', timestamp: '2026-09-25T10:00:00Z', message: { role: 'user', content: '你好' } },
      { type: 'assistant', uuid: 'a1', timestamp: '2026-09-25T10:00:01Z', message: { role: 'assistant', model: 'claude-haiku', stop_reason: 'end_turn', content: [{ type: 'text', text: '你好' }] } },
    ].map(row => JSON.stringify({ ...row, sessionId: sid, cwd: WORK_DIR })).join('\n') + '\n', 'utf8');
    return file;
  };
  const memberTranscript = transcriptFor(memberSid);
  const otherTranscript = transcriptFor(otherSid);
  const meeting = {
    schemaVersion: 2, id: MEETING_ID, title: '粘贴块群聊验收', scene: 'general', mode: 'free', groupChat: true,
    groupMode: 'deliberation', workspace: WORK_DIR, workspaceLabel: '粘贴块', createdAt: now - 60000, updatedAt: now - 60000,
    lastMessageTime: now - 60000, subSessions: [MEMBER_ID], slotSpecs: [{ kind: 'claude' }], participants: [0],
    _cursors: { [MEMBER_ID]: 0 }, _nextIdx: 0, _timeline: [],
  };
  fs.writeFileSync(path.join(DATA_DIR, 'meetings', `${MEETING_ID}.json`), JSON.stringify(meeting), 'utf8');
  fs.writeFileSync(path.join(DATA_DIR, 'state.json'), JSON.stringify({
    version: 1, cleanShutdown: true, immersiveByMeeting: {}, meetings: [meeting],
    sessions: [
      { schemaVersion: 1, hubId: MEMBER_ID, kind: 'claude', title: '群聊成员', cwd: WORK_DIR, meetingId: MEETING_ID, ccSessionId: memberSid, transcriptPath: memberTranscript, lastMessageTime: now - 60000, updatedAt: now - 60000 },
      { schemaVersion: 1, hubId: OTHER_SESSION_ID, kind: 'claude', title: '别的会话', cwd: WORK_DIR, ccSessionId: otherSid, transcriptPath: otherTranscript, lastMessageTime: now - 30000, updatedAt: now - 30000 },
    ],
  }, null, 2), 'utf8');
}

const INSTALL_PROBE = `(() => {
  if (window.__pasteProbe) return true;
  const probe = { total: 0, max: 0, count: 0 };
  new PerformanceObserver(list => { for (const e of list.getEntries()) { probe.total += e.duration; probe.max = Math.max(probe.max, e.duration); probe.count += 1; } }).observe({ entryTypes: ['longtask'] });
  window.__pasteProbe = probe;
  window.__takeProbe = () => { const s = { total: Math.round(probe.total), max: Math.round(probe.max), count: probe.count }; probe.total = 0; probe.max = 0; probe.count = 0; return s; };
  return true;
})()`;

async function clickSelector(client, selector) {
  // 等到元素可见且没被遮挡再点（群聊面板打开后有一段布局/成员唤醒的过渡）。
  const box = await waitFor(`${selector} visible and clickable`, () => client.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return null; const x = r.left + r.width / 2, y = r.top + r.height / 2; const hit = document.elementFromPoint(x, y); return (hit === el || el.contains(hit)) ? { x, y } : null; })()`), 15000);
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
}

async function typeKeys(client, text) {
  for (const ch of text) {
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
  }
}

const readBox = client => client.eval(`(() => {
  const box = document.getElementById('mr-input-box');
  return { chips: box.querySelectorAll('.fi-paste-chip').length, nodes: box.getElementsByTagName('*').length,
    full: readContenteditablePlainText(box), label: box.querySelector('.fi-paste-chip')?.dataset.label || null };
})()`);

async function main() {
  writeFixtures();
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const pasteText = Array.from({ length: LINES }, (_, i) => `第 ${i + 1} 行：群聊粘贴块 调度日志 value=${(i * 0.37).toFixed(2)} ok`).join('\n');
  const expected = '请大家看：' + pasteText + '，给出结论';
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'Path';
  const result = { runId: RUN_ID, lines: LINES };
  let hub = null;
  let client = null;
  try {
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR, port: await reservePort(), label: 'groupchat-paste-chip', windowMode: 'hidden',
      extraEnv: {
        [pathKey]: `${FAKE_BIN_DIR}${path.delimiter}${process.env[pathKey] || ''}`,
        HUB_CLAUDE_BACKEND: 'subscription', HUB_CODEX_BACKEND: 'subscription', HUB_CODEX_PROFILE: 'e2e', HUB_SESSION_SEARCH_PREWARM: '0',
      },
    });
    await _waitMs(1000);
    client = await connectFirstPage(hub, target => target.type === 'page' && /index\.html/i.test(target.url || ''));
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await waitFor('meeting in sidebar', () => client.eval(`!!document.querySelector('[data-meeting-id="${MEETING_ID}"]')`));
    await clickSelector(client, `[data-meeting-id="${MEETING_ID}"]`);
    await waitFor('group composer', () => client.eval(`activeMeetingId === ${JSON.stringify(MEETING_ID)} && !!document.getElementById('mr-input-box')`));
    await client.eval(INSTALL_PROBE);
    await clickSelector(client, '#mr-input-box');
    await typeKeys(client, '请大家看：');

    await client.eval('window.__takeProbe()');
    await client.eval(`(() => {
      const box = document.getElementById('mr-input-box');
      box.focus();
      const dt = new DataTransfer();
      dt.setData('text/plain', ${JSON.stringify(pasteText)});
      box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    })()`);
    await _waitMs(400);
    result.pasteBlocking = await client.eval('window.__takeProbe()');
    await typeKeys(client, '，给出结论');
    await _waitMs(300);
    result.typeBlocking = await client.eval('window.__takeProbe()');
    result.afterPaste = await readBox(client);
    assert.equal(result.afterPaste.chips, 1, 'long paste collapses into one chip in the group composer');
    assert.ok(result.afterPaste.nodes < 20, `group composer DOM stays small, got ${result.afterPaste.nodes}`);
    assert.match(result.afterPaste.label, new RegExp(`${LINES} 行`));
    assert.equal(result.afterPaste.full, expected, 'expanded text is exact');
    assert.ok(result.pasteBlocking.total < 200 && result.typeBlocking.total < 200, `no long blocking: ${JSON.stringify([result.pasteBlocking, result.typeBlocking])}`);
    const persisted = await client.eval(`JSON.stringify(localStorage)`);
    assert.ok(!/[]/.test(persisted), 'persisted drafts must not contain chip markers');

    // 切到别的会话再切回群聊：块按原样还原，内容不变
    await clickSelector(client, `.session-item[data-session-id="${OTHER_SESSION_ID}"]`);
    await waitFor('left meeting', () => client.eval(`activeMeetingId !== ${JSON.stringify(MEETING_ID)}`));
    // 侧栏有双击保护：500ms 内在同一坐标的第二次点击沿用上一次的目标（列表重排后，
    // 群聊项恰好移到了刚才点「别的会话」的位置）。像真人一样隔一会儿再点。
    await _waitMs(800);
    await clickSelector(client, `[data-meeting-id="${MEETING_ID}"]`);
    try {
      await waitFor('back in meeting', () => client.eval(`activeMeetingId === ${JSON.stringify(MEETING_ID)} && !!document.getElementById('mr-input-box')`));
    } catch (error) {
      result.switchBackDiagnostics = await client.eval(`(() => {
        const all = [...document.querySelectorAll('[data-meeting-id="${MEETING_ID}"]')];
        const first = all[0]; const r = first && first.getBoundingClientRect();
        const hit = r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
        return { activeMeetingId, activeSessionId, matches: all.map(el => el.className + ' ' + el.tagName),
          hit: hit ? hit.className + ' <' + hit.tagName + '>' : null, hasInput: !!document.getElementById('mr-input-box') };
      })()`);
      throw error;
    }
    result.afterSwitch = await readBox(client);
    assert.equal(result.afterSwitch.chips, 1, 'chip is restored after switching back');
    assert.equal(result.afterSwitch.full, expected, 'restored draft is exact');
    const shot = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(SCREENSHOT_PATH, Buffer.from(shot.data, 'base64'));
    result.screenshot = SCREENSHOT_PATH;

    // 真实点击发送：拦截 groupchat:turn（不派发给成员），核对发出去的 userInput 是完整原文。
    // 第一次让它失败：Hub 会把消息退回输入框 —— 退回的必须完整，且大段文字要收成块而不是铺满 DOM。
    await client.eval(`(() => {
      const { ipcRenderer } = require('electron');
      window.__groupTurns = [];
      window.__groupTurnStatus = 'failed';
      const original = ipcRenderer.invoke.bind(ipcRenderer);
      ipcRenderer.invoke = (channel, payload, ...rest) => {
        if (channel === 'groupchat:turn') {
          window.__groupTurns.push(payload);
          return Promise.resolve(window.__groupTurnStatus === 'completed'
            ? { ok: true, status: 'completed', turnNum: 1 }
            : { ok: false, status: 'failed', reason: 'e2e 模拟发送失败' });
        }
        return original(channel, payload, ...rest);
      };
    })()`);
    await clickSelector(client, '#mr-send-btn');
    const failedTurn = await waitFor('first group turn dispatched', () => client.eval('window.__groupTurns && window.__groupTurns[0]'), 10000);
    assert.equal(failedTurn.userInput, expected, 'group chat sends the full original text');
    result.afterFailedSend = await waitFor('failed send restored into composer', async () => {
      const box = await readBox(client);
      return box.full.trim() ? box : null;
    }, 10000);
    assert.equal(result.afterFailedSend.full, expected, 'a failed send restores the exact text');
    assert.equal(result.afterFailedSend.chips, 1, 'the restored long text is collapsed into a chip, not spread over the DOM');
    assert.ok(result.afterFailedSend.nodes < 20, `restored composer DOM stays small, got ${result.afterFailedSend.nodes}`);
    // 退回时可能弹出失败提示，先关掉再重发。
    await client.eval(`document.querySelectorAll('.hub-dialog-overlay button, .modal-overlay .modal-close').forEach(b => { if (/知道了|关闭|×/.test(b.textContent)) b.click(); })`);

    // 第二次成功：输入框清空。
    await client.eval("window.__groupTurnStatus = 'completed'");
    await clickSelector(client, '#mr-send-btn');
    const turn = await waitFor('second group turn dispatched', () => client.eval('window.__groupTurns && window.__groupTurns[1]'), 10000);
    result.sentLength = String(turn.userInput || '').length;
    assert.equal(turn.userInput, expected, 'the resend after restore is still the full original text');
    await _waitMs(500);
    result.afterSend = await readBox(client);
    assert.equal(result.afterSend.full.trim(), '', 'composer is cleared after a successful send');

    result.ok = true;
    console.log(JSON.stringify(result, null, 2));
    console.log('E2E groupchat-paste-chip: PASS');
  } catch (error) {
    result.ok = false;
    result.error = error && error.stack || String(error);
    if (client) { try { const shot = await client.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(SCREENSHOT_PATH.replace('.png', '-fail.png'), Buffer.from(shot.data, 'base64')); } catch {} }
    throw error;
  } finally {
    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
    if (client) { try { client.close(); } catch {} }
    if (hub) await gracefulQuit(hub);
  }
}

main().catch(error => { console.error(error); process.exit(1); });
