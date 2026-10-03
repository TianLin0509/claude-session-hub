'use strict';

// 「引用会话」真实界面验收：隔离 Hub + 假 CLI（不花额度）+ 伪造的 Claude / Codex 原生记录。
// 在 Claude 会话里用真实鼠标点「引用会话」→ 在弹窗里点 Codex 会话 → 输入框出现引用行，
// 路径指向的 md 真实存在且含 Codex 会话的对话正文；全程不自动发送。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const ROOT = path.resolve(__dirname, '..');
const RUN_ID = `${Date.now()}-${process.pid}`;
const TEMP_ROOT = path.join(os.tmpdir(), `hub-session-reference-${RUN_ID}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const WORK_DIR = path.join(TEMP_ROOT, 'workspace');
const FAKE_BIN_DIR = path.join(TEMP_ROOT, 'fake-bin');
const CODEX_HOME = path.join(TEMP_ROOT, 'codex-home');
const CLAUDE_ROOT = path.join(TEMP_ROOT, 'claude-projects');
const CODEX_ROOT = path.join(TEMP_ROOT, 'codex-sessions');
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'session-reference');
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, `session-reference-${RUN_ID}.png`);
const RESULT_PATH = path.join(ARTIFACT_DIR, `session-reference-${RUN_ID}.json`);

const CLAUDE_SID = '33333333-3333-4333-8333-333333333333';
const CODEX_SID = '019d4444-4444-7444-8444-444444444444';
const TARGET_HUB_ID = 'hub-claude-reference-target';
const SOURCE_HUB_ID = 'hub-codex-reference-source';
const SOURCE_TITLE = 'Codex 调度算法讨论';
const QUESTION_MARKER = 'REFERENCE_QUESTION_MARKER 链路自适应的 BLER 目标怎么定？';
const ANSWER_MARKER = 'REFERENCE_ANSWER_MARKER 建议按业务类型分档，eMBB 取 10%。';
const GROUP_ID = 'e2e-reference-group-0001';
const GROUP_TITLE = '调度算法评审群';
const GROUP_QUESTION_MARKER = 'GROUP_QUESTION_MARKER 比例公平和轮询哪个更适合高负载？';
const GROUP_ANSWER_MARKER = 'GROUP_ANSWER_MARKER 高负载下比例公平吞吐更高，轮询只适合做对照。';
const GROUP_PROGRESS_MARKER = 'GROUP_PROGRESS_MARKER 正在读代码';

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
    } catch (error) {
      lastError = error;
    }
    await _waitMs(150);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? ': ' + lastError.message : ''}`);
}

async function clickPoint(client, x, y) {
  await client.send('Page.bringToFront');
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

// 取元素中心点，并确认它没被别的东西盖住。
function locate(client, selectorExpr) {
  return client.eval(`(() => {
    const el = ${selectorExpr};
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      text: el.textContent.trim(),
      visible: rect.width > 0 && rect.height > 0 && getComputedStyle(el).display !== 'none',
      topmost: hit === el || el.contains(hit),
      x, y,
    };
  })()`);
}

function writeFakeCli() {
  fs.mkdirSync(FAKE_BIN_DIR, { recursive: true });
  const fakeCliPath = path.join(FAKE_BIN_DIR, 'fake-cli.js');
  fs.writeFileSync(fakeCliPath, "'use strict';\nprocess.stdout.write('[fake-cli]\\r\\n');\nsetTimeout(() => process.exit(0), 120);\n", 'utf8');
  for (const provider of ['claude', 'codex']) {
    fs.writeFileSync(path.join(FAKE_BIN_DIR, `${provider}.cmd`),
      `@echo off\r\n"${process.execPath}" "${fakeCliPath}" ${provider} %*\r\n`, 'utf8');
  }
}

function writeFixtures() {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  fs.mkdirSync(CODEX_HOME, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'config.json'), JSON.stringify({
    providers: {
      claude: { backend: 'subscription' },
      codex: { backend: 'subscription', subscription_profile: 'e2e', subscription_profiles: [{ id: 'e2e', label: 'E2E', home: CODEX_HOME }] },
    },
  }, null, 2), 'utf8');

  const claudeDir = path.join(CLAUDE_ROOT, 'reference-e2e');
  fs.mkdirSync(claudeDir, { recursive: true });
  const claudePath = path.join(claudeDir, `${CLAUDE_SID}.jsonl`);
  const claudeRows = [
    { type: 'user', uuid: 'c-u1', timestamp: '2026-09-25T10:00:00Z', message: { content: '目标会话的第一个问题' } },
    { type: 'assistant', uuid: 'c-a1', timestamp: '2026-09-25T10:00:01Z', message: { model: 'claude-haiku', stop_reason: 'end_turn', content: [{ type: 'text', text: '目标会话的回答' }] } },
  ];
  fs.writeFileSync(claudePath, claudeRows.map(row => JSON.stringify({ ...row, sessionId: CLAUDE_SID, cwd: WORK_DIR,
    message: { role: row.type, id: row.uuid, ...row.message } })).join('\n') + '\n', 'utf8');

  const dayDir = path.join(CODEX_ROOT, '2026', '09', '25');
  fs.mkdirSync(dayDir, { recursive: true });
  const codexPath = path.join(dayDir, `rollout-2026-09-25T09-00-00-${CODEX_SID}.jsonl`);
  const codexRows = [
    { timestamp: '2026-09-25T09:00:00Z', type: 'session_meta', payload: { id: CODEX_SID, timestamp: '2026-09-25T09:00:00Z', cwd: WORK_DIR, source: 'cli', originator: 'codex_cli_rs' } },
    { timestamp: '2026-09-25T09:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: QUESTION_MARKER } },
    { timestamp: '2026-09-25T09:00:02Z', type: 'event_msg', payload: { type: 'task_started' } },
    { timestamp: '2026-09-25T09:00:03Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: ANSWER_MARKER, duration_ms: 1000 } },
  ];
  fs.writeFileSync(codexPath, codexRows.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8');

  const state = {
    version: 1,
    cleanShutdown: true,
    sessions: [
      { schemaVersion: 1, hubId: TARGET_HUB_ID, kind: 'claude', title: 'Claude 引用目标', cwd: WORK_DIR,
        ccSessionId: CLAUDE_SID, transcriptPath: claudePath,
        lastMessageTime: Date.parse('2026-09-25T10:00:01Z'), updatedAt: Date.parse('2026-09-25T10:00:01Z') },
      { schemaVersion: 1, hubId: SOURCE_HUB_ID, kind: 'codex', title: SOURCE_TITLE, cwd: WORK_DIR,
        codexSid: CODEX_SID, codexSessionsRoot: CODEX_ROOT, transcriptPath: codexPath,
        lastMessageTime: Date.parse('2026-09-25T09:00:03Z'), updatedAt: Date.parse('2026-09-25T09:00:03Z') },
    ],
    meetings: [
      { id: GROUP_ID, type: 'meeting', title: GROUP_TITLE, subSessions: [], groupChat: true, scene: 'general',
        createdAt: Date.parse('2026-09-25T08:00:00Z'), lastMessageTime: Date.parse('2026-09-25T11:00:00Z') },
    ],
    immersiveByMeeting: {},
  };
  fs.writeFileSync(path.join(DATA_DIR, 'state.json'), JSON.stringify(state, null, 2), 'utf8');

  // 群聊的权威记录：成员回答文件已归并进来的群聊状态。过程汇报不该出现在引用里。
  fs.mkdirSync(path.join(DATA_DIR, 'arena-prompts'), { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'arena-prompts', `${GROUP_ID}-groupchat.json`), JSON.stringify({
    meetingId: GROUP_ID, nextMessageSeq: 4,
    messages: [
      { seq: 1, role: 'user', origin: 'user', content: GROUP_QUESTION_MARKER, createdAt: Date.parse('2026-09-25T10:59:00Z') },
      { seq: 2, role: 'assistant', sid: 'm1', speaker: 'Codex 1', content: GROUP_PROGRESS_MARKER, status: 'progress_update', createdAt: Date.parse('2026-09-25T10:59:30Z') },
      { seq: 3, role: 'assistant', sid: 'm1', speaker: 'Codex 1', content: GROUP_ANSWER_MARKER, createdAt: Date.parse('2026-09-25T11:00:00Z') },
    ],
  }, null, 2), 'utf8');
}

async function main() {
  writeFakeCli();
  writeFixtures();
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const port = Number(process.env.HUB_REFERENCE_E2E_PORT) || await reservePort();
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'Path';
  const result = { runId: RUN_ID, port };
  let hub = null;
  let client = null;
  try {
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR,
      port,
      label: 'session-reference',
      extraEnv: {
        [pathKey]: `${FAKE_BIN_DIR}${path.delimiter}${process.env[pathKey] || ''}`,
        HUB_CLAUDE_BACKEND: 'subscription',
        HUB_CODEX_BACKEND: 'subscription',
        HUB_CODEX_PROFILE: 'e2e',
        HUB_SESSION_SEARCH_CLAUDE_ROOTS: CLAUDE_ROOT,
        HUB_SESSION_SEARCH_CODEX_ROOTS: CODEX_ROOT,
        HUB_SESSION_SEARCH_REFRESH_TTL_MS: '500',
        HUB_SESSION_SEARCH_PREWARM: '1',
        HUB_SESSION_SEARCH_PREWARM_DELAY_MS: '250',
      },
    });
    await _waitMs(1000);
    client = await connectFirstPage(hub, target => target.type === 'page' && /index\.html/i.test(target.url || ''));

    console.log('[step] open Claude target session');
    await waitFor('dormant sessions loaded', () => client.eval(`sessions.has(${JSON.stringify(TARGET_HUB_ID)})`));
    await client.eval(`selectSession(${JSON.stringify(TARGET_HUB_ID)})`);
    const button = await waitFor('reference button', () => locate(client, "document.querySelector('.fi-bridge-reference')"));
    result.button = button;
    assert.equal(button.text, '引用会话');
    assert.equal(button.visible, true);
    assert.equal(button.topmost, true, 'reference button must not be covered');
    result.toolbarOrder = await client.eval(`Array.from(document.querySelector('.fi-bridge-toolbar').children).map(el => el.textContent.trim())`);

    // 输入框里先有一个长文本粘贴块：引用只能在末尾追加，不能把块展开或把整框收成新块。
    const PASTED = Array.from({ length: 50 }, (_, i) => `粘贴行 ${i + 1}`).join('\n');
    await client.eval(`(() => {
      const box = document.querySelector('.floating-input-box');
      box.focus();
      const dt = new DataTransfer();
      dt.setData('text/plain', ${JSON.stringify(PASTED)});
      box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    })()`);
    assert.equal(await client.eval("document.querySelectorAll('.floating-input-box .fi-paste-chip').length"), 1);

    console.log('[step] click 引用会话');
    await clickPoint(client, button.x, button.y);
    const row = await waitFor('Codex row in picker', () => locate(client,
      `Array.from(document.querySelectorAll('#gc-fork-picker [data-gc-picker-row]')).find(el => el.dataset.gcPickerRow === ${JSON.stringify(SOURCE_HUB_ID)})`));
    result.pickerRows = await client.eval(`Array.from(document.querySelectorAll('#gc-fork-picker [data-gc-picker-row]')).map(el => el.dataset.gcPickerRow)`);
    assert.ok(!result.pickerRows.includes(TARGET_HUB_ID), 'current session must not list itself');
    assert.equal(row.topmost, true, 'picker row must be clickable');
    const pickerShot = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(SCREENSHOT_PATH.replace('.png', '-picker.png'), Buffer.from(pickerShot.data, 'base64'));

    console.log('[step] pick Codex source');
    const pickedAt = Date.now();
    await clickPoint(client, row.x, row.y);
    const inserted = await waitFor('reference line in input', () => client.eval(`(() => {
      const box = document.querySelector('.floating-input-box');
      const text = box ? box.innerText : '';
      return text.includes('【引用会话】') ? text : null;
    })()`), 30000);
    result.pickToInsertMs = Date.now() - pickedAt;
    result.inputText = inserted;
    result.chipPreserved = await client.eval(`(() => {
      const box = document.querySelector('.floating-input-box');
      const full = readContenteditablePlainText(box);
      // Chromium 在不可编辑的行内块后插换行会多出一个空行，只校验「原文 + 空白 + 引用行」。
      const pasted = ${JSON.stringify(PASTED)};
      return { chips: box.querySelectorAll('.fi-paste-chip').length,
        startsWithPaste: full.startsWith(pasted) && /^\\s+【引用会话】/.test(full.slice(pasted.length)) };
    })()`);
    assert.deepEqual(result.chipPreserved, { chips: 1, startsWithPaste: true }, 'reference must append after the existing paste chip');
    assert.ok(inserted.includes(`Codex 会话「${SOURCE_TITLE}」`), inserted);
    const mdPath = (inserted.match(/聊天记录：(.+?\.md)/) || [])[1];
    assert.ok(mdPath, 'reference line must contain a .md path');
    result.mdPath = mdPath;
    assert.ok(path.resolve(mdPath).startsWith(path.resolve(DATA_DIR)), 'md must live in the isolated data dir');
    const md = fs.readFileSync(mdPath, 'utf8');
    assert.ok(md.includes('REFERENCE_QUESTION_MARKER'), 'md must contain the source question');
    assert.ok(md.includes('REFERENCE_ANSWER_MARKER'), 'md must contain the source answer');
    result.mdHead = md.slice(0, 600);

    // 索引热身后（生产常态）：md 已是最新，解析应当不等刷新、立即返回。
    result.warmResolve = await client.eval(`(async () => {
      const { ipcRenderer } = require('electron');
      const startedAt = performance.now();
      const res = await ipcRenderer.invoke('session-reference:resolve', { sessionId: ${JSON.stringify(SOURCE_HUB_ID)} });
      return { ms: Math.round(performance.now() - startedAt), ok: res.ok, fresh: res.fresh, path: res.path };
    })()`);
    assert.equal(result.warmResolve.ok, true);
    assert.equal(result.warmResolve.fresh, true);
    assert.equal(result.warmResolve.path, mdPath);
    assert.ok(result.warmResolve.ms < 1000, `warm resolve took ${result.warmResolve.ms}ms`);

    // 不自动发送：输入框仍保留引用行，且目标会话的原生记录没有新增用户消息。
    await _waitMs(800);
    result.stillInInput = await client.eval(`document.querySelector('.floating-input-box').innerText.includes('【引用会话】')`);
    assert.equal(result.stillInInput, true);
    result.toast = await client.eval(`(document.getElementById('gc-fork-toast') || {}).textContent || ''`);

    // ── 引用群聊：同一个按钮，清单里出现群聊；选中后插入【引用群聊】行，md 含正式发言
    console.log('[step] click 引用会话 again, pick group chat');
    const buttonAgain = await waitFor('reference button idle', async () => {
      const b = await locate(client, "document.querySelector('.fi-bridge-reference')");
      return b && b.text === '引用会话' ? b : null;
    });
    await clickPoint(client, buttonAgain.x, buttonAgain.y);
    const groupRow = await waitFor('group row in picker', () => locate(client,
      `Array.from(document.querySelectorAll('#gc-fork-picker [data-gc-picker-row]')).find(el => el.dataset.gcPickerRow === ${JSON.stringify('meeting:' + GROUP_ID)})`));
    result.groupPickerRows = await client.eval(`Array.from(document.querySelectorAll('#gc-fork-picker [data-gc-picker-row]')).map(el => el.dataset.gcPickerRow + ' | ' + el.textContent.trim())`);
    result.pickerTitle = await client.eval(`document.querySelector('#gc-fork-picker .modal-title').textContent`);
    assert.equal(result.pickerTitle, '引用会话 / 群聊');
    assert.ok(groupRow.text.includes(GROUP_TITLE) && groupRow.text.includes('群聊'), groupRow.text);
    assert.equal(groupRow.topmost, true, 'group row must be clickable');
    const groupPickerShot = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(SCREENSHOT_PATH.replace('.png', '-group-picker.png'), Buffer.from(groupPickerShot.data, 'base64'));
    await clickPoint(client, groupRow.x, groupRow.y);
    const groupInserted = await waitFor('group reference line in input', () => client.eval(`(() => {
      const box = document.querySelector('.floating-input-box');
      const text = box ? box.innerText : '';
      return text.includes('【引用群聊】') ? text : null;
    })()`), 30000);
    assert.ok(groupInserted.includes(`群聊「${GROUP_TITLE}」`), groupInserted);
    assert.ok(groupInserted.includes('【引用会话】'), 'earlier session reference must be kept');
    const groupMdPath = (groupInserted.match(/【引用群聊】[^\n]*聊天记录：(.+?\.md)/) || [])[1];
    assert.ok(groupMdPath, 'group reference line must contain a .md path');
    result.groupMdPath = groupMdPath;
    assert.equal(path.dirname(path.resolve(groupMdPath)), path.join(path.resolve(DATA_DIR), 'transcripts'),
      'group md must live in the transcripts dir that Claude sessions can read');
    const groupMd = fs.readFileSync(groupMdPath, 'utf8');
    assert.ok(groupMd.includes('GROUP_QUESTION_MARKER') && groupMd.includes('GROUP_ANSWER_MARKER'), groupMd);
    assert.ok(!groupMd.includes('GROUP_PROGRESS_MARKER'), 'progress updates must not be quoted');
    result.groupMdHead = groupMd.slice(0, 600);
    result.groupToast = await client.eval(`(document.getElementById('gc-fork-toast') || {}).textContent || ''`);
    const shot = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(SCREENSHOT_PATH, Buffer.from(shot.data, 'base64'));
    result.screenshot = SCREENSHOT_PATH;
    result.ok = true;
    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify(result, null, 2));
    console.log('E2E session-reference: PASS');
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
  }
}

if (require.main === module) main().catch(error => { console.error(error); process.exit(1); });
module.exports = { writeFakeCli, writeFixtures, reservePort, DATA_DIR, WORK_DIR, FAKE_BIN_DIR,
  CODEX_HOME, CLAUDE_ROOT, CODEX_ROOT, TEMP_ROOT, SOURCE_HUB_ID, SOURCE_TITLE };
