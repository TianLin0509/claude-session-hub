'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  parseBridgeOutput,
  registerChatgptBridgeIpc,
  resolveChatgptBridgeRuntime,
  validateText,
} = require('../main/ipc/chatgpt-bridge-handlers.js');
const { createChatgptBridgeController } = require('../renderer/chatgpt-bridge-controller.js');
const { createPathLinkContextMenuController } = require('../renderer/path-link-context-menu.js');

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
          max_turn: 7,
          items: [{ turn: 7 }],
        };
      }
      if (args[0] === 'ack') return { ok: true, acknowledged_turn: 7 };
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
    ['ack', '--turn', '7'],
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
      return { ok: true, new: true, content: '不能丢失', count: 1, max_turn: 9, items: [{ turn: 9 }] };
    },
    async sendPrompt() { return { ok: true, sendStatus: 'stuck' }; },
  });
  const result = await handlers.get('chatgpt-bridge:pull-and-send')(null, { sessionId: 's1' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'pty_send_failed');
  assert.deepEqual(calls, [['pull', '--peek']], 'failed delivery must remain unacknowledged for retry');
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

test('renderer controller exposes one-click pull and latest-answer push', async () => {
  const pull = makeElement('chatgpt-bridge-pull');
  const push = makeElement('chatgpt-bridge-push');
  const body = makeElement('body');
  const invocations = [];
  const document = {
    body,
    createElement: () => makeElement(),
    getElementById(id) {
      if (id === pull.id) return pull;
      if (id === push.id) return push;
      return null;
    },
  };
  const controller = createChatgptBridgeController({
    document,
    window: { setTimeout: () => 1, clearTimeout() {} },
    ipcRenderer: {
      async invoke(channel, payload) {
        invocations.push({ channel, payload });
        if (channel === 'chatgpt-bridge:pull-and-send') return { ok: true, new: true, sent: true, count: 1 };
        return { ok: true, sent: true };
      },
    },
    getActiveSessionId: () => 's1',
    getLatestAssistantText: () => '最近回答',
  });
  assert.equal(controller.init(), true);
  await pull._listeners.click();
  await push._listeners.click();
  assert.deepEqual(invocations, [
    { channel: 'chatgpt-bridge:pull-and-send', payload: { sessionId: 's1' } },
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

test('Hub UI exposes bridge buttons, card action, path action, and terminal selection action', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
  const card = fs.readFileSync(path.join(root, 'renderer', 'turn-card-renderer.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
  assert.match(html, /id="chatgpt-bridge-pull"/);
  assert.match(html, /id="chatgpt-bridge-push"/);
  assert.match(html, /data-action="sync-chatgpt"[^>]*>同步选中文字到公司 ChatGPT/);
  assert.match(html, /data-action="sync-chatgpt"[^>]*>同步内容到公司 ChatGPT/);
  assert.match(card, /data-action="sync-chatgpt" title="同步此回答到公司 ChatGPT"/);
  assert.match(renderer, /#msg-overlay > \.turn-card:not\(\.user\)/,
    'latest-answer push must select assistant cards, whose class is turn-card without .user');
});
