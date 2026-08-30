'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  parseBridgeOutput,
  registerChatgptBridgeIpc,
  resolveChatgptBridgeRuntime,
  normalizeMessageIds,
  validateText,
} = require('../main/ipc/chatgpt-bridge-handlers.js');
const { createChatgptBridgeController } = require('../renderer/chatgpt-bridge-controller.js');
const { createPathLinkContextMenuController } = require('../renderer/path-link-context-menu.js');
const { createCardSelectionContextMenuController } = require('../renderer/card-selection-context-menu.js');

test('bridge parser preserves successful content and structured errors', () => {
  const success = parseBridgeOutput(JSON.stringify({
    ok: true,
    new: true,
    content: '公司消息',
  }), '', 0);
  assert.equal(success.ok, true);
  assert.equal(success.content, '公司消息');

  const failure = parseBridgeOutput(JSON.stringify({
    ok: false,
    error: { code: 'login_required', message: '请登录' },
  }), '', 2);
  assert.equal(failure.ok, false);
  assert.equal(failure.code, 'login_required');
  assert.equal(failure.error, '请登录');
  assert.equal(parseBridgeOutput('not-json', 'bad', 1).code, 'invalid_response');
});

test('bridge runtime honors explicit existing paths', () => {
  const pythonPath = 'C:\\tools\\python.exe';
  const bridgePath = 'C:\\tools\\bridge.py';
  const existing = new Set([pythonPath, bridgePath]);
  assert.deepEqual(resolveChatgptBridgeRuntime({
    env: {
      CHATGPT_BRIDGE_PYTHON: pythonPath,
      CHATGPT_BRIDGE_SCRIPT: bridgePath,
      LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
    },
    homeDir: 'C:\\Users\\test',
    existsSync: candidate => existing.has(candidate),
  }), { pythonPath, bridgePath });
});

test('text validation rejects empty and oversized content', () => {
  assert.equal(validateText('').code, 'empty_content');
  assert.equal(validateText('x'.repeat(1024 * 1024 + 1)).code, 'content_too_large');
  assert.equal(validateText('正常内容').ok, true);
});

test('message id normalization is bounded and removes duplicates', () => {
  assert.deepEqual(normalizeMessageIds([' msg-1 ', 'msg-1', '', null, 'msg-2']), ['msg-1', 'msg-2']);
  assert.deepEqual(normalizeMessageIds('msg-1'), []);
});

test('IPC pull-and-send peeks, sends to the bound session, then acknowledges', async () => {
  const handlers = new Map();
  const calls = [];
  const sent = [];
  registerChatgptBridgeIpc({
    handle(channel, handler) { handlers.set(channel, handler); },
  }, {
    sessionManager: {
      getSession(id) { return id === 's1' ? { id, kind: 'codex' } : undefined; },
    },
    async runBridge(args, options = {}) {
      calls.push({ args, input: options.input || '' });
      if (args[0] === 'pull') {
        return {
          ok: true,
          new: true,
          content: '公司发来的原始文字',
          count: 1,
          message_ids: ['msg-company-7'],
          items: [{ message_id: 'msg-company-7', turn: 7 }],
        };
      }
      if (args[0] === 'ack') return { ok: true, acknowledged_message_ids: ['msg-company-7'] };
      if (args[0] === 'push') return { ok: true, sent: true };
      return { ok: true };
    },
    async sendPrompt(sessionId, text, kind) {
      sent.push({ sessionId, text, kind });
      return true;
    },
  });

  const result = await handlers.get('chatgpt-bridge:pull-and-send')(null, { sessionId: 's1' });
  assert.equal(result.ok, true);
  assert.equal(result.sent, true);
  assert.equal(result.acknowledged, true);
  assert.deepEqual(sent, [{ sessionId: 's1', text: '公司发来的原始文字', kind: 'codex' }]);
  assert.deepEqual(calls.slice(0, 2).map(call => call.args), [
    ['pull', '--peek'],
    ['ack', '--message-id', 'msg-company-7'],
  ]);

  const pushed = await handlers.get('chatgpt-bridge:push')(null, { text: '发到公司' });
  assert.equal(pushed.ok, true);
  assert.equal(calls.at(-1).input, '发到公司');
  assert.equal((await handlers.get('chatgpt-bridge:pull-and-send')(null, { sessionId: 'missing' })).code, 'session_not_found');
});

test('IPC never acknowledges content when PTY reports a stuck send', async () => {
  const handlers = new Map();
  const calls = [];
  registerChatgptBridgeIpc({
    handle(channel, handler) { handlers.set(channel, handler); },
  }, {
    sessionManager: { getSession: () => ({ id: 's1', kind: 'codex' }) },
    async runBridge(args) {
      calls.push(args);
      return { ok: true, new: true, content: '不能丢失', count: 1, message_ids: ['msg-stuck-9'], items: [{ message_id: 'msg-stuck-9', turn: 9 }] };
    },
    async sendPrompt() { return { ok: true, sendStatus: 'stuck' }; },
  });
  const result = await handlers.get('chatgpt-bridge:pull-and-send')(null, { sessionId: 's1' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'pty_send_failed');
  assert.deepEqual(calls, [['pull', '--peek']], 'failed delivery must remain unacknowledged for retry');
});

test('IPC input pull peeks with file download and acknowledges only on explicit confirmation', async () => {
  const handlers = new Map();
  const calls = [];
  registerChatgptBridgeIpc({
    handle(channel, handler) { handlers.set(channel, handler); },
  }, {
    async runBridge(args) {
      calls.push(args);
      if (args[0] === 'pull') {
        return { ok: true, new: true, content: 'C:\\VibeData\\ChatGPTBridge\\inbox\\task.md', message_ids: ['file-msg-1'] };
      }
      return { ok: true, acknowledged_message_ids: ['file-msg-1'] };
    },
  });
  const pulled = await handlers.get('chatgpt-bridge:pull-for-input')();
  assert.equal(pulled.new, true);
  assert.deepEqual(calls, [['pull', '--peek', '--download-files']], 'peek must not consume before renderer insertion');
  const acked = await handlers.get('chatgpt-bridge:ack')(null, { messageIds: ['file-msg-1', 'file-msg-1'] });
  assert.equal(acked.ok, true);
  assert.deepEqual(calls.at(-1), ['ack', '--message-id', 'file-msg-1']);
});

function makeElement(id = '') {
  const listeners = {};
  return {
    id,
    style: {},
    dataset: {},
    disabled: false,
    textContent: '',
    children: [],
    addEventListener(type, handler) { listeners[type] = handler; },
    appendChild(child) { this.children.push(child); },
    setAttribute(name, value) { this[name] = value; },
    _listeners: listeners,
  };
}

test('renderer controller inserts before acknowledging and remains usable without a top toolbar', async () => {
  const body = makeElement('body');
  const invocations = [];
  const order = [];
  const document = {
    body,
    createElement: () => makeElement(),
    getElementById() { return null; },
  };
  const controller = createChatgptBridgeController({
    document,
    window: { setTimeout: () => 1, clearTimeout() {} },
    ipcRenderer: {
      async invoke(channel, payload) {
        invocations.push({ channel, payload });
        if (channel === 'chatgpt-bridge:pull-for-input') {
          return { ok: true, new: true, content: '公司任务', file_count: 0, message_ids: ['msg-input-1'] };
        }
        if (channel === 'chatgpt-bridge:ack') {
          order.push('ack');
          return { ok: true };
        }
        return { ok: true, sent: true };
      },
    },
    getActiveSessionId: () => 's1',
    getLatestAssistantText: async () => '最近回答',
  });
  assert.equal(controller.init(), true);
  const pulled = await controller.pullForInput(async (content) => {
    assert.equal(content, '公司任务');
    order.push('insert');
    return true;
  });
  assert.equal(pulled.acknowledged, true);
  await controller.pushLatest();
  assert.deepEqual(order, ['insert', 'ack']);
  assert.deepEqual(invocations, [
    { channel: 'chatgpt-bridge:pull-for-input', payload: undefined },
    { channel: 'chatgpt-bridge:ack', payload: { messageIds: ['msg-input-1'] } },
    { channel: 'chatgpt-bridge:push', payload: { text: '最近回答' } },
  ]);
  assert.equal(body.children.length, 1, 'controller should reuse one live status toast');
});

test('path menu sends URL text directly and reads local text files before push', async () => {
  const body = makeElement('body');
  const pushed = [];
  const controller = createPathLinkContextMenuController({
    document: { body, createElement: () => makeElement(), addEventListener() {} },
    window: { setTimeout: () => 1, clearTimeout() {}, innerWidth: 1200, innerHeight: 800 },
    menuEl: { style: {}, querySelectorAll: () => [], querySelector: () => null },
    clipboard: { writeText() {} },
    shell: {},
    ipcRenderer: {
      async invoke(channel) {
        if (channel === 'read-file') return { content: '本地文本正文' };
        return { success: true };
      },
    },
    normalizeLocalPathForOpen: value => value,
    getSessionCwd: () => 'C:\\tmp',
    getActiveSessionId: () => 's1',
    requestAnimationFrameFn: fn => fn(),
    pushToChatgpt: async (text, label) => {
      pushed.push({ text, label });
      return { ok: true };
    },
  });
  await controller.runAction('sync-chatgpt', { absPath: 'https://example.test/context', isUrl: true });
  await controller.runAction('sync-chatgpt', { absPath: 'C:\\tmp\\notes.md', isUrl: false });
  assert.deepEqual(pushed, [
    { text: 'https://example.test/context', label: 'https://example.test/context' },
    { text: '本地文本正文', label: 'notes.md' },
  ]);
});

test('card selection menu copies or syncs exactly the selected text', async () => {
  const copied = [];
  const pushed = [];
  const controller = createCardSelectionContextMenuController({
    document: {},
    window: {},
    menuEl: {},
    clipboard: { writeText(text) { copied.push(text); } },
    requestAnimationFrameFn: fn => fn(),
    pushToChatgpt: async (text, label) => {
      pushed.push({ text, label });
      return { ok: true };
    },
  });
  assert.equal((await controller.runAction('copy', '精确选区')).ok, true);
  assert.equal((await controller.runAction('sync-chatgpt', '精确选区')).ok, true);
  assert.deepEqual(copied, ['精确选区']);
  assert.deepEqual(pushed, [{ text: '精确选区', label: '卡片选中文字' }]);
});

test('Hub UI exposes card/company, composer pull, and selection actions without a top bridge toolbar', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
  const card = fs.readFileSync(path.join(root, 'renderer', 'turn-card-renderer.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
  assert.doesNotMatch(html, /id="chatgpt-bridge-(?:pull|push)"/,
    'the old top-level bridge toolbar must be removed');
  assert.match(html, /id="card-selection-context-menu"[\s\S]*?data-action="copy"[\s\S]*?data-action="sync-chatgpt"/);
  assert.match(renderer, /bridgePullBtn\.className = 'fi-bridge-pull'/);
  assert.match(renderer, /chatgptBridgeController\.pullForInput/);
  assert.doesNotMatch(renderer, /button\.className = 'fi-preset-chip'/,
    'unused task preset buttons must not be generated');
  assert.match(renderer, /ipcRenderer\.invoke\('get-last-assistant-text', activeSessionId\)/,
    'PTY view must fall back to the current session transcript for latest-answer push');
  assert.match(html, /data-action="sync-chatgpt"[^>]*>同步选中文字到公司 ChatGPT/);
  assert.match(html, /data-action="sync-chatgpt"[^>]*>同步内容到公司 ChatGPT/);
  assert.match(card, /data-action="sync-chatgpt" title="同步此回答到公司 ChatGPT">公司<\/button>/);
  assert.match(renderer, /#msg-overlay > \.turn-card:not\(\.user\)/,
    'latest-answer push must select assistant cards, whose class is turn-card without .user');
});
