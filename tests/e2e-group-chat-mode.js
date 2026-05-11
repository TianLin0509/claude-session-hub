'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const HUB_DIR = path.resolve(__dirname, '..');
const ELECTRON = path.join(HUB_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const CDP_PORT = parseInt(process.env.CDP_PORT || '9297', 10);
const DATA_DIR = process.env.HUB_DATA || path.join(os.tmpdir(), 'hub-e2e-group-chat-mode');
const SCREENSHOT_DIR = path.join(HUB_DIR, 'tests', 'screenshots', 'group-chat-mode');

let msgId = 0;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function rpc(ws, method, params = {}, timeout = 15000) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error(`${method} timeout`));
    }, timeout);
    function onMsg(raw) {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.id !== id) return;
      clearTimeout(timer);
      ws.off('message', onMsg);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalJs(ws, expression, timeout = 15000) {
  const r = await rpc(ws, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, timeout);
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 800));
  return r.result.value;
}

async function screenshot(ws, name) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const fp = path.join(SCREENSHOT_DIR, `${Date.now()}-${name}.png`);
  const r = await rpc(ws, 'Page.captureScreenshot', { format: 'png' }, 10000);
  fs.writeFileSync(fp, Buffer.from(r.data, 'base64'));
  console.log(`  screenshot: ${fp}`);
  return fp;
}

async function attach(port) {
  for (let i = 0; i < 45; i++) {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => null);
    const page = Array.isArray(list) && list.find(x => x.type === 'page' && !String(x.url).startsWith('devtools://'));
    if (page) {
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
      await rpc(ws, 'Page.enable');
      await rpc(ws, 'Runtime.enable');
      return ws;
    }
    await sleep(1000);
  }
  throw new Error('CDP attach timeout');
}

function startHub() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const proc = spawn(ELECTRON, ['.', `--remote-debugging-port=${CDP_PORT}`], {
    cwd: HUB_DIR,
    env: { ...process.env, CLAUDE_HUB_DATA_DIR: DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  proc.stdout.on('data', c => logs.push(c.toString()));
  proc.stderr.on('data', c => logs.push(c.toString()));
  return { proc, logs };
}

function assertOk(cond, message, detail) {
  if (!cond) {
    const suffix = detail ? `\n${JSON.stringify(detail, null, 2)}` : '';
    throw new Error(message + suffix);
  }
  console.log('  OK ' + message);
}

(async () => {
  console.log(`[setup] isolated data dir: ${DATA_DIR}`);
  console.log(`[setup] CDP port: ${CDP_PORT}`);
  const { proc, logs } = startHub();
  console.log(`[setup] spawned isolated Hub PID=${proc.pid}`);
  let ws;
  const shots = [];
  try {
    ws = await attach(CDP_PORT);
    await sleep(1500);

    await evalJs(ws, `document.getElementById('btn-group-chat').click()`);
    await sleep(800);
    shots.push(await screenshot(ws, 'modal-open'));

    const modal1 = await evalJs(ws, `(() => {
      const m = document.getElementById('meeting-create-modal');
      return {
        visible: !!m && getComputedStyle(m).display !== 'none',
        title: m?.querySelector('#mcm-title-text')?.textContent || '',
        addVisible: !!m?.querySelector('#mcm-add-member') && getComputedStyle(m.querySelector('#mcm-add-member')).display !== 'none',
        slotCount: m ? m.querySelectorAll('.mcm-slot').length : 0,
        firstAvatar: m?.querySelector('.mcm-slot img')?.getAttribute('src') || '',
      };
    })()`);
    assertOk(modal1.visible, 'group chat modal is visible', modal1);
    assertOk(modal1.title.includes('AI 群聊'), 'modal title identifies AI group chat', modal1);
    assertOk(modal1.addVisible, 'add-member button is visible in group mode', modal1);
    assertOk(modal1.slotCount === 3, 'group modal starts with three default members', modal1);
    assertOk(modal1.firstAvatar.includes('assets/ai-logos/'), 'group modal uses AI company logo avatars', modal1);

    await evalJs(ws, `document.getElementById('mcm-add-member').click()`);
    await sleep(400);
    const modal2 = await evalJs(ws, `(() => {
      const m = document.getElementById('meeting-create-modal');
      return {
        slotCount: m ? m.querySelectorAll('.mcm-slot').length : 0,
        removeCount: m ? m.querySelectorAll('.mcm-remove-member').length : 0,
      };
    })()`);
    assertOk(modal2.slotCount === 4, 'add-member creates a fourth AI member', modal2);
    assertOk(modal2.removeCount >= 1, 'additional group members are removable', modal2);

    await evalJs(ws, `document.querySelector('#meeting-create-modal .mcm-create').click()`);
    let meeting = null;
    for (let i = 0; i < 60; i++) {
      const raw = await evalJs(ws, `(async () => {
        const { ipcRenderer } = require('electron');
        const meetings = await ipcRenderer.invoke('get-meetings') || [];
        return JSON.stringify(meetings.find(m => m.groupChat) || null);
      })()`, 10000);
      meeting = raw ? JSON.parse(raw) : null;
      if (meeting && Array.isArray(meeting.subSessions) && meeting.subSessions.length === 4) break;
      await sleep(1000);
    }
    assertOk(meeting && meeting.groupChat, 'created meeting is marked groupChat', meeting);
    assertOk(meeting.subSessions.length === 4, 'created group meeting has four members', meeting);
    assertOk(Array.isArray(meeting.participants) && meeting.participants.length === 4, 'all group members are selected by default', meeting);
    assertOk(meeting.groupMode === 'deliberation', 'group mode defaults to deliberation', meeting);

    await evalJs(ws, `(() => {
      localStorage.removeItem('mr-group-chat-view-mode');
      const item = Array.from(document.querySelectorAll('.session-item.meeting'))
        .find(el => el.textContent.includes('AI 群聊'));
      if (item) item.click();
    })()`);
    await sleep(1500);
    shots.push(await screenshot(ws, 'group-room'));
    const chatState = await evalJs(ws, `(() => ({
      hasChatShell: !!document.querySelector('.mr-gc-shell'),
      hasCardStrip: !!document.querySelector('.mr-ft-strip'),
      chatButtonActive: document.getElementById('mr-btn-group-chat-view')?.classList.contains('active') || false,
      cardButtonExists: !!document.getElementById('mr-btn-group-card-view'),
      sideMemberCount: document.querySelectorAll('.mr-gc-member').length,
      sideLogoSrcs: Array.from(document.querySelectorAll('.mr-gc-member img')).map(img => img.getAttribute('src') || ''),
      sidebarSrcs: Array.from(document.querySelectorAll('.session-item.meeting .mini-jump-btn img')).map(img => img.getAttribute('src') || ''),
    }))()`);
    assertOk(chatState.hasChatShell, 'group room defaults to WeChat-like chat view', chatState);
    assertOk(!chatState.hasCardStrip, 'group default view does not render roundtable cards', chatState);
    assertOk(chatState.chatButtonActive && chatState.cardButtonExists, 'group header exposes chat/card view toggle', chatState);
    assertOk(chatState.sideMemberCount === 4 && chatState.sideLogoSrcs.every(src => src.includes('assets/ai-logos/')),
      'group chat side members use AI company logo avatars', chatState);
    assertOk(chatState.sidebarSrcs.length === 4 && chatState.sidebarSrcs.every(src => src.includes('assets/ai-logos/')),
      'group sidebar mini avatars use AI company logos', chatState);

    await evalJs(ws, `document.getElementById('mr-btn-group-card-view').click()`);
    await sleep(800);
    shots.push(await screenshot(ws, 'group-card-view'));
    const cardViewState = await evalJs(ws, `(() => ({
      hasChatShell: !!document.querySelector('.mr-gc-shell'),
      cardCount: document.querySelectorAll('.mr-ft[data-ft-sid]').length,
      cardButtonActive: document.getElementById('mr-btn-group-card-view')?.classList.contains('active') || false,
    }))()`);
    assertOk(!cardViewState.hasChatShell && cardViewState.cardCount === 4 && cardViewState.cardButtonActive,
      'group card view button switches to existing card cards', cardViewState);

    await evalJs(ws, `document.getElementById('mr-btn-group-chat-view').click()`);
    await sleep(800);
    const chatReturnState = await evalJs(ws, `(() => ({
      hasChatShell: !!document.querySelector('.mr-gc-shell'),
      chatButtonActive: document.getElementById('mr-btn-group-chat-view')?.classList.contains('active') || false,
    }))()`);
    assertOk(chatReturnState.hasChatShell && chatReturnState.chatButtonActive,
      'group chat view button returns to message flow', chatReturnState);

    const mentionNoJump = await evalJs(ws, `(async () => {
      const { ipcRenderer } = require('electron');
      const beforeMeetings = await ipcRenderer.invoke('get-meetings') || [];
      const beforeMeeting = beforeMeetings.find(m => m.id === ${JSON.stringify(meeting.id)}) || {};
      const beforeFocused = beforeMeeting.focusedSub || null;
      const input = document.getElementById('mr-input-box');
      input.textContent = '@m2';
      input.focus();
      const range = document.createRange();
      range.selectNodeContents(input);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 160));
      const menu = document.getElementById('mr-rt-mention-menu');
      const beforeMenuVisible = !!menu && getComputedStyle(menu).display !== 'none';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 260));
      const afterMeetings = await ipcRenderer.invoke('get-meetings') || [];
      const afterMeeting = afterMeetings.find(m => m.id === ${JSON.stringify(meeting.id)}) || {};
      return JSON.stringify({
        beforeFocused,
        afterFocused: afterMeeting.focusedSub || null,
        beforeMenuVisible,
        inputText: input.textContent,
        hasChatShell: !!document.querySelector('.mr-gc-shell'),
        activeIsInput: document.activeElement === input,
      });
    })()`, 20000);
    const mentionNoJumpState = JSON.parse(mentionNoJump);
    assertOk(mentionNoJumpState.beforeMenuVisible, 'group mention menu opens for @m2', mentionNoJumpState);
    assertOk(mentionNoJumpState.inputText === '@m2 ', 'group mention inserts target token into input', mentionNoJumpState);
    assertOk(mentionNoJumpState.afterFocused === mentionNoJumpState.beforeFocused,
      'group mention insert does not switch focused sub-session', mentionNoJumpState);
    assertOk(mentionNoJumpState.hasChatShell && mentionNoJumpState.activeIsInput,
      'group mention insert keeps chat view and input focus stable', mentionNoJumpState);

    const scrollState = await evalJs(ws, `(async () => {
      const { ipcRenderer } = require('electron');
      const originalInvoke = ipcRenderer.invoke.bind(ipcRenderer);
      const sid1 = ${JSON.stringify(meeting.subSessions[0])};
      const sid2 = ${JSON.stringify(meeting.subSessions[1])};
      const longText = Array.from({ length: 18 }, (_, i) => '第 ' + (i + 1) + ' 段：这是一段用于撑高群聊滚动区域的回答内容，模拟 Claude 已经输出长答案，而其他成员仍在思考。').join('\\n\\n');
      const fakeState = {
        schemaVersion: 1,
        meetingId: ${JSON.stringify(meeting.id)},
        currentTurn: 2,
        currentMode: 'group',
        messages: [
          { id: 'u1', turnNum: 1, role: 'user', speaker: '我', content: '@all 大家好', createdAt: Date.now() - 120000, anchor: 'raw://group/${meeting.id}/msg/u1' },
          { id: 'a1-m1', turnNum: 1, role: 'assistant', sid: sid1, speaker: 'Claude 1', content: longText, createdAt: Date.now() - 90000, anchor: 'raw://group/${meeting.id}/msg/a1-m1', status: 'completed' },
          { id: 'u2', turnNum: 2, role: 'user', speaker: '我', content: '继续讨论无线通信状态记忆。', createdAt: Date.now() - 60000, anchor: 'raw://group/${meeting.id}/msg/u2' },
          { id: 'a2-m1', turnNum: 2, role: 'assistant', sid: sid1, speaker: 'Claude 1', content: longText, createdAt: Date.now() - 30000, anchor: 'raw://group/${meeting.id}/msg/a2-m1', status: 'completed' },
        ],
        summarySegments: [{ id: 'seg-1' }],
        turns: [{ n: 1, mode: 'group', by: { [sid1]: longText } }],
        aiStats: {},
        _partialBy: { [sid2]: { text: 'DeepSeek 正在补充...', status: 'streaming' } },
      };
      ipcRenderer.invoke = (channel, payload) => {
        if (channel === 'groupchat:get-state' && payload && payload.meetingId === ${JSON.stringify(meeting.id)}) {
          return Promise.resolve(JSON.parse(JSON.stringify(fakeState)));
        }
        return originalInvoke(channel, payload);
      };
      document.getElementById('mr-btn-group-card-view').click();
      await new Promise(r => setTimeout(r, 120));
      document.getElementById('mr-btn-group-chat-view').click();
      await new Promise(r => setTimeout(r, 300));
      const scroller = document.querySelector('.mr-gc-messages');
      const maxTop = scroller ? Math.max(0, scroller.scrollHeight - scroller.clientHeight) : 0;
      if (scroller) scroller.scrollTop = Math.min(520, Math.max(120, Math.floor(maxTop / 2)));
      const before = scroller ? scroller.scrollTop : -1;
      ipcRenderer.emit('roundtable-partial-update', {}, {
        meetingId: ${JSON.stringify(meeting.id)},
        sid: sid2,
        status: 'streaming',
        text: 'DeepSeek 正在补充...\\n\\n新增一段流式内容，用来触发聊天视图全量重绘兜底。',
        thinkSec: 2,
      });
      await new Promise(r => setTimeout(r, 120));
      const afterEl = document.querySelector('.mr-gc-messages');
      const after = afterEl ? afterEl.scrollTop : -1;
      ipcRenderer.invoke = originalInvoke;
      return JSON.stringify({ before, after, maxTop, hasScroller: !!afterEl });
    })()`, 20000);
    const scrollResult = JSON.parse(scrollState);
    assertOk(scrollResult.hasScroller && scrollResult.before > 0 && Math.abs(scrollResult.after - scrollResult.before) <= 8,
      'group chat partial updates preserve user scroll position', scrollResult);

    const emptySend = await evalJs(ws, `(async () => {
      const { ipcRenderer } = require('electron');
      await ipcRenderer.invoke('roundtable:set-participants', { meetingId: ${JSON.stringify(meeting.id)}, participants: [] });
      await new Promise(r => setTimeout(r, 600));
      const result = await ipcRenderer.invoke('groupchat:turn', { meetingId: ${JSON.stringify(meeting.id)}, userInput: '没有 @ 且无人勾选时应被拒绝' });
      const input = document.getElementById('mr-input-box');
      const send = document.getElementById('mr-send-btn');
      return JSON.stringify({
        status: result.status,
        reason: result.reason || '',
        placeholder: input?.dataset?.placeholder || '',
        sendDisabled: !!send?.disabled,
        avatarCount: document.querySelectorAll('.mr-free-avatar-chk').length,
        memberCount: document.querySelectorAll('.mr-gc-member').length,
        modeChipsText: document.getElementById('mr-input-mode-chips')?.textContent || '',
      });
    })()`, 20000);
    const emptyState = JSON.parse(emptySend);
    assertOk(emptyState.status === 'error' && emptyState.reason.includes('勾选'), 'empty selection without @ is rejected before AI dispatch', emptyState);
    assertOk(emptyState.sendDisabled === false, 'group input remains enabled at zero selected members for @ routing', emptyState);
    assertOk(emptyState.placeholder.includes('@m1'), 'zero-selected placeholder explains @ routing', emptyState);
    assertOk(emptyState.avatarCount === 4, 'group toolbar renders all four selectable members', emptyState);
    assertOk(emptyState.memberCount === 4, 'group chat view keeps member list visible at zero selected members', emptyState);
    assertOk(emptyState.modeChipsText.trim() === '', 'group chat hides fixed roundtable debate mode menu', emptyState);

    shots.push(await screenshot(ws, 'zero-selected-state'));
    console.log(JSON.stringify({ ok: true, dataDir: DATA_DIR, screenshots: shots }, null, 2));
  } catch (e) {
    console.error('[hub logs tail]');
    console.error(logs.join('').slice(-4000));
    if (ws) {
      try { shots.push(await screenshot(ws, 'error')); } catch {}
    }
    throw e;
  } finally {
    if (ws) try { ws.close(); } catch {}
    if (proc && !proc.killed) proc.kill();
  }
})().catch(e => {
  console.error('FATAL:', e.stack || e.message);
  process.exit(1);
});
