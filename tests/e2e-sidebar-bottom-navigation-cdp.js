'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const ROOT = path.resolve(__dirname, '..');
const RUN_ID = `${Date.now()}-${process.pid}`;
const TEMP_ROOT = path.join(os.tmpdir(), `hub-sidebar-bottom-${RUN_ID}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const TRANSCRIPT_PATH = path.join(TEMP_ROOT, 'card-session.jsonl');
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'sidebar-bottom-navigation');
const CARD_SHOT = path.join(ARTIFACT_DIR, `ordinary-card-bottom-${RUN_ID}.png`);
const CHAT_SHOT = path.join(ARTIFACT_DIR, `group-chat-bottom-${RUN_ID}.png`);
const GROUP_CARD_SHOT = path.join(ARTIFACT_DIR, `group-card-bottom-${RUN_ID}.png`);
const RESULT_PATH = path.join(ARTIFACT_DIR, `result-${RUN_ID}.json`);

function canListen(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function availablePort(preferred) {
  for (let port = preferred; port < preferred + 60; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error('no free CDP port');
}

async function waitForEval(client, expression, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await client.eval(`Boolean(${expression})`)) return; } catch {}
    await _waitMs(200);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function screenshot(client, target) {
  const shot = await client.send('Page.captureScreenshot', {
    format: 'png', fromSurface: true, captureBeyondViewport: false,
  });
  fs.writeFileSync(target, Buffer.from(shot.data, 'base64'));
}

function writeClaudeTranscript() {
  const lines = [];
  const base = Date.now() - 60000;
  for (let i = 0; i < 24; i += 1) {
    const answerText = i === 23
      ? '最终一张卡片的可见说明。\n\n```bash\necho ORDINARY_VISIBLE_COMMAND\n```\n\n代码之后的可见结尾。'
      : `这是第 ${i + 1} 条回答。\n\n${'用于制造可滚动卡片历史的验收正文。'.repeat(9)}`;
    lines.push(JSON.stringify({
      type: 'user', uuid: `nav-u-${i}`, timestamp: new Date(base + i * 2000).toISOString(),
      message: { content: `卡片导航验收问题 ${i + 1}：请说明第 ${i + 1} 个检查点。` },
    }));
    lines.push(JSON.stringify({
      type: 'assistant', uuid: `nav-a-${i}`, timestamp: new Date(base + i * 2000 + 900).toISOString(),
      message: {
        model: 'claude-opus-4-7', stop_reason: 'end_turn',
        content: [{ type: 'text', text: answerText }],
        usage: { input_tokens: 100 + i, output_tokens: 60 },
      },
    }));
  }
  fs.writeFileSync(TRANSCRIPT_PATH, lines.join('\n') + '\n', 'utf8');
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeClaudeTranscript();
  const port = await availablePort(Number(process.env.HUB_SIDEBAR_BOTTOM_E2E_PORT || 19620));
  let hub = null;
  let client = null;
  const result = { runId: RUN_ID, port };
  try {
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR,
      port,
      label: 'sidebar-bottom-navigation',
      extraEnv: { CLAUDE_HUB_E2E: '1' },
    });
    client = await connectFirstPage(hub, t => t.type === 'page' && /renderer[\\/]index\.html/.test(t.url || ''));
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1500, height: 960, deviceScaleFactor: 1, mobile: false,
    });
    await waitForEval(client,
      'window.__hubE2E && window.MeetingRoom && window.MeetingRoom.debugRenderGroupChatState',
      'Hub E2E APIs');

    result.ordinaryCard = await client.eval(`(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const api = window.__hubE2E;
      window.__lastCopiedText = '';
      try {
        Object.defineProperty(navigator.clipboard, 'writeText', {
          configurable: true,
          value: async text => { window.__lastCopiedText = String(text || ''); },
        });
      } catch {
        navigator.clipboard.writeText = async text => { window.__lastCopiedText = String(text || ''); };
      }
      const sid = 'sidebar-bottom-card';
      const now = Date.now();
      api.addFakeSession({
        id: sid, kind: 'claude', title: '侧栏置底 · 普通卡片', status: 'idle',
        transcriptPath: ${JSON.stringify(TRANSCRIPT_PATH)}, createdAt: now, lastMessageTime: now,
      });
      await api.selectSession(sid, { forceScrollBottom: true });
      applyViewMode('card');
      await wait(850);
      const overlay = document.getElementById('msg-overlay');
      const maxBefore = Math.max(0, overlay.scrollHeight - overlay.clientHeight);
      overlay.scrollTop = 0;
      await wait(80);
      const sidebarItem = [...document.querySelectorAll('#session-list .session-item:not(.meeting)')]
        .find(el => (el.textContent || '').includes('侧栏置底 · 普通卡片'));
      if (!sidebarItem) throw new Error('ordinary sidebar item not found');
      sidebarItem.click();
      await wait(900);
      const maxAfter = Math.max(0, overlay.scrollHeight - overlay.clientHeight);
      const lastAssistant = [...overlay.querySelectorAll('.turn-card:not(.user)')].at(-1);
      lastAssistant.querySelector('[data-action="copy"]').click();
      await wait(100);
      const copiedText = window.__lastCopiedText;
      return {
        cardCount: overlay.querySelectorAll('.turn-card').length,
        maxBefore,
        maxAfter,
        scrollTop: overlay.scrollTop,
        bottomGap: Math.max(0, maxAfter - overlay.scrollTop),
        selected: [...document.querySelectorAll('#session-list .session-item.selected:not(.meeting)')]
          .some(el => (el.textContent || '').includes('侧栏置底 · 普通卡片')),
        copy: {
          length: copiedText.length,
          tail: copiedText.slice(-180),
          hasCommand: copiedText.includes('ORDINARY_VISIBLE_COMMAND'),
          hasNoise: copiedText.includes(String.fromCharCode(96).repeat(3)) || /bash|📋|Copy|复制/iu.test(copiedText),
        },
      };
    })()`);
    assert.ok(result.ordinaryCard.cardCount >= 40, JSON.stringify(result.ordinaryCard));
    assert.ok(result.ordinaryCard.maxAfter > 500, JSON.stringify(result.ordinaryCard));
    assert.ok(result.ordinaryCard.bottomGap <= 3, JSON.stringify(result.ordinaryCard));
    assert.equal(result.ordinaryCard.copy.hasCommand, true, JSON.stringify(result.ordinaryCard));
    assert.equal(result.ordinaryCard.copy.hasNoise, false, JSON.stringify(result.ordinaryCard));
    await screenshot(client, CARD_SHOT);

    result.groupChat = await client.eval(`(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const api = window.__hubE2E;
      const now = Date.now();
      const sids = ['sidebar-gc-claude', 'sidebar-gc-kimi', 'sidebar-gc-codex'];
      api.addFakeSessions(sids.map((sid, idx) => ({
        id: sid, kind: ['claude', 'kimi', 'codex'][idx], title: ['Claude', 'Kimi', 'Codex'][idx],
        status: 'idle', createdAt: now + idx, lastMessageTime: now + idx, meetingId: 'sidebar-gc-meeting',
        currentModel: { id: ['claude-opus-5', 'kimi-code/k3', 'gpt-5.6-sol'][idx], displayName: ['Claude Opus 5', 'Kimi K3', 'GPT-5.6-SOL'][idx] },
        effort: idx === 1 ? null : 'max', codexSpeedTier: idx === 2 ? 'fast' : null,
        fastMode: idx === 0 ? true : null, contextPct: 10 + idx,
      })));
      const meeting = {
        id: 'sidebar-gc-meeting', title: '侧栏置底 · AI 群聊', scene: 'general', groupChat: true,
        groupMode: 'fanout', status: 'idle', subSessions: sids, participants: [0, 1, 2],
        focusedSub: sids[0], createdAt: now, updatedAt: now, lastMessageTime: now + 10,
      };
      meetings[meeting.id] = meeting;
      const long = '群聊历史滚动验收内容。'.repeat(18);
      const messages = [];
      const turns = [];
      for (let n = 1; n <= 18; n += 1) {
        messages.push({ id: 'gc-u-' + n, turnNum: n, role: 'user', speaker: '你', content: '第 ' + n + ' 轮问题', createdAt: now + n });
        const by = {};
        sids.forEach((sid, idx) => {
          const cardBody = n === 18 ? '卡片末轮长回答。'.repeat(1200) : long;
          by[sid] = '第 ' + n + ' 轮 ' + ['Claude', 'Kimi', 'Codex'][idx] + ' 回答。' + cardBody
            + (n === 18 && idx === 0
              ? '\\n\\n' + String.fromCharCode(96).repeat(3) + 'bash\\necho GROUP_VISIBLE_COMMAND\\n' + String.fromCharCode(96).repeat(3)
              : '');
          messages.push({ id: 'gc-a-' + n + '-' + idx, turnNum: n, role: 'assistant', sid, speaker: ['Claude', 'Kimi', 'Codex'][idx], content: by[sid], status: 'completed', createdAt: now + n + idx + 1 });
        });
        turns.push({ n, mode: 'group', userInput: '第 ' + n + ' 轮问题', by, byStatus: Object.fromEntries(sids.map(sid => [sid, 'completed'])), timestamp: now + n });
      }
      const state = { currentMode: 'idle', currentTurn: 18, messages, turns, aiStats: {} };
      window.__sidebarBottomState = state;
      const electronIpc = require('electron').ipcRenderer;
      if (!window.__sidebarBottomRealInvoke) {
        window.__sidebarBottomRealInvoke = electronIpc.invoke.bind(electronIpc);
        electronIpc.invoke = (channel, args) => channel === 'groupchat:get-state'
          ? Promise.resolve(window.__sidebarBottomState)
          : window.__sidebarBottomRealInvoke(channel, args);
      }
      renderSessionList();
      await api.selectMeeting(meeting.id, { forceScrollBottom: true });
      await wait(700);
      let messagesEl = document.querySelector('.mr-gc-messages');
      const initialMax = Math.max(0, messagesEl.scrollHeight - messagesEl.clientHeight);
      messagesEl.scrollTop = 120;
      window.MeetingRoom.openMeeting(meeting.id, meeting);
      await wait(650);
      messagesEl = document.querySelector('.mr-gc-messages');
      const preservedTop = messagesEl.scrollTop;
      messagesEl.scrollTop = 0;
      const sidebarItem = document.querySelector('.session-item[data-meeting-id="' + meeting.id + '"]');
      if (!sidebarItem) throw new Error('meeting sidebar item not found');
      sidebarItem.click();
      await wait(750);
      messagesEl = document.querySelector('.mr-gc-messages');
      const maxAfter = Math.max(0, messagesEl.scrollHeight - messagesEl.clientHeight);
      document.querySelector('.mr-gc-msg[data-gc-msg-id="gc-a-18-0"] [data-gc-copy-message]').click();
      await wait(100);
      const copiedText = window.__lastCopiedText;
      return {
        messageCount: messagesEl.querySelectorAll('.mr-gc-msg').length,
        initialMax,
        preservedTop,
        maxAfter,
        scrollTop: messagesEl.scrollTop,
        bottomGap: Math.max(0, maxAfter - messagesEl.scrollTop),
        selected: !!document.querySelector('.session-item.selected[data-meeting-id="' + meeting.id + '"]'),
        copy: {
          length: copiedText.length,
          tail: copiedText.slice(-180),
          hasCommand: copiedText.includes('GROUP_VISIBLE_COMMAND'),
          hasNoise: copiedText.includes(String.fromCharCode(96).repeat(3)) || /bash\\s*·\\s*复制|📋|已复制/iu.test(copiedText),
        },
      };
    })()`);
    assert.ok(result.groupChat.messageCount >= 60, JSON.stringify(result.groupChat));
    assert.ok(result.groupChat.initialMax > 500, JSON.stringify(result.groupChat));
    assert.ok(Math.abs(result.groupChat.preservedTop - 120) <= 3, JSON.stringify(result.groupChat));
    assert.ok(result.groupChat.bottomGap <= 3, JSON.stringify(result.groupChat));
    assert.equal(result.groupChat.copy.hasCommand, true, JSON.stringify(result.groupChat));
    assert.equal(result.groupChat.copy.hasNoise, false, JSON.stringify(result.groupChat));
    await screenshot(client, CHAT_SHOT);

    result.unifiedGroup = await client.eval(`(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const meeting = meetings['sidebar-gc-meeting'];
      window.MeetingRoom.debugRenderGroupChatState(meeting.id, window.__sidebarBottomState);
      await wait(250);
      return {
        legacyCards: document.querySelectorAll('.mr-ft').length,
        legacyViewButtons: document.querySelectorAll('#mr-btn-group-' + 'card-view,#mr-btn-group-' + 'chat-view').length,
        messageCount: document.querySelectorAll('.mr-gc-msg').length,
        retryActions: document.querySelectorAll('[data-gc-retry-answer]').length,
        userResendActions: document.querySelectorAll('[data-gc-resend-turn]').length,
        memberRows: document.querySelectorAll('.mr-gc-member-row').length,
      };
    })()`);
    assert.equal(result.unifiedGroup.legacyCards, 0, JSON.stringify(result.unifiedGroup));
    assert.equal(result.unifiedGroup.legacyViewButtons, 0, JSON.stringify(result.unifiedGroup));
    assert.ok(result.unifiedGroup.messageCount >= 60, JSON.stringify(result.unifiedGroup));
    assert.ok(result.unifiedGroup.retryActions >= 3, JSON.stringify(result.unifiedGroup));
    assert.ok(result.unifiedGroup.userResendActions >= 18, JSON.stringify(result.unifiedGroup));
    assert.equal(result.unifiedGroup.memberRows, 3, JSON.stringify(result.unifiedGroup));
    await screenshot(client, GROUP_CARD_SHOT);

    result.screenshots = { ordinaryCard: CARD_SHOT, groupChat: CHAT_SHOT, groupCards: GROUP_CARD_SHOT };
    result.success = true;
    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (client) await client.close().catch(() => {});
    if (hub) await gracefulQuit(hub);
    const resolved = path.resolve(TEMP_ROOT);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)
        && path.basename(resolved).startsWith('hub-sidebar-bottom-')) {
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
    }
  }
}

main().catch(error => {
  console.error(error && (error.stack || error.message));
  process.exit(1);
});
