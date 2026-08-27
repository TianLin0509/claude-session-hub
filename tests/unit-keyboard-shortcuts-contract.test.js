const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createKeyboardShortcuts } = require('../renderer/keyboard-shortcuts.js');

function makeEvent(overrides) {
  return {
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    key: '',
    code: '',
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
    ...overrides,
  };
}

test('Ctrl+N creates a Claude session', () => {
  const calls = [];
  const shortcuts = createKeyboardShortcuts({
    document: { addEventListener: () => {} },
    ipcRenderer: { invoke: (...args) => calls.push(args) },
    clipboard: { writeText: () => {} },
    sessions: new Map(),
    terminalCache: new Map(),
    getActiveSessionId: () => null,
    getCurrentFontSize: () => 16,
    selectSession: () => {},
    escapeToHome: () => {},
    toggleSidebar: () => {},
    openTerminalSearch: () => {},
    setFontSize: () => {},
  });

  const e = makeEvent({ key: 'n' });
  shortcuts.handleKeydown(e);
  assert.strictEqual(e.defaultPrevented, true);
  assert.deepStrictEqual(calls, [['create-session', 'claude']]);
});

test('Ctrl+W uses the shared close-as-sleep action', () => {
  const closed = [];
  const shortcuts = createKeyboardShortcuts({
    document: { addEventListener: () => {} },
    ipcRenderer: { invoke: () => { throw new Error('shared close action should be used'); } },
    clipboard: { writeText: () => {} },
    sessions: new Map([['busy', { id: 'busy', kind: 'codex', status: 'running' }]]),
    terminalCache: new Map(),
    getActiveSessionId: () => 'busy',
    getCurrentFontSize: () => 16,
    selectSession: () => {},
    escapeToHome: () => {},
    toggleSidebar: () => {},
    openTerminalSearch: () => {},
    setFontSize: () => {},
    closeSession: sessionId => { closed.push(sessionId); },
  });

  const e = makeEvent({ key: 'w' });
  shortcuts.handleKeydown(e);
  assert.strictEqual(e.defaultPrevented, true);
  assert.deepStrictEqual(closed, ['busy']);
});

test('Ctrl+O is global in PTY/editable controls but does not reset quick-open itself', () => {
  let opened = 0;
  const shortcuts = createKeyboardShortcuts({
    document: { addEventListener: () => {} },
    ipcRenderer: { invoke: () => {} },
    clipboard: { writeText: () => {} },
    sessions: new Map(),
    terminalCache: new Map(),
    getActiveSessionId: () => null,
    getCurrentFontSize: () => 16,
    selectSession: () => {},
    escapeToHome: () => {},
    toggleSidebar: () => {},
    openTerminalSearch: () => {},
    openPreviewQuickOpen: () => { opened += 1; },
    setFontSize: () => {},
  });

  const bodyEvent = makeEvent({ key: 'o', target: { tagName: 'DIV' } });
  shortcuts.handleKeydown(bodyEvent);
  assert.strictEqual(bodyEvent.defaultPrevented, true);
  assert.strictEqual(opened, 1);

  const inputEvent = makeEvent({ key: 'o', target: { tagName: 'TEXTAREA' } });
  shortcuts.handleKeydown(inputEvent);
  assert.strictEqual(inputEvent.defaultPrevented, true);
  assert.strictEqual(opened, 2, 'xterm/floating input focus must not make the advertised shortcut a dead key');

  const quickInputEvent = makeEvent({
    key: 'o',
    target: { tagName: 'INPUT', id: 'preview-quick-open-input' },
  });
  shortcuts.handleKeydown(quickInputEvent);
  assert.strictEqual(quickInputEvent.defaultPrevented, false);
  assert.strictEqual(opened, 2);
});

test('preview quick/find inputs suppress unrelated Hub shortcuts', () => {
  const calls = [];
  const shortcuts = createKeyboardShortcuts({
    document: { addEventListener: () => {} },
    ipcRenderer: { invoke: (...args) => calls.push(args) },
    clipboard: { writeText: () => {} },
    sessions: new Map([['active', { id: 'active', kind: 'codex' }]]),
    terminalCache: new Map(),
    getActiveSessionId: () => 'active',
    getCurrentFontSize: () => 16,
    selectSession: () => {}, escapeToHome: () => {}, toggleSidebar: () => calls.push(['sidebar']),
    openTerminalSearch: () => calls.push(['terminal-search']), setFontSize: () => {},
    closeSession: id => calls.push(['close', id]),
  });
  const layer = { tagName: 'INPUT', closest: selector => selector.includes('#preview-quick-open') ? {} : null };
  for (const key of ['f', 'w', 'n', 'b']) shortcuts.handleKeydown(makeEvent({ key, target: layer }));
  assert.deepStrictEqual(calls, []);
});

// 2026-08-27：改动审阅驾驶舱已整体删除，原来那条「驾驶舱打开时压制后台快捷键」
// 的用例随之移除；其余弹窗的压制由 unit-modal-layer-guard 覆盖。

test('global search modal suppresses background Hub shortcuts', () => {
  const calls = [];
  const searchModal = { hidden: false, style: { display: 'flex' }, classList: { contains: () => false } };
  const shortcuts = createKeyboardShortcuts({
    document: {
      addEventListener: () => {},
      getElementById: id => id === 'search-modal' ? searchModal : null,
    },
    ipcRenderer: { invoke: (...args) => calls.push(args) },
    clipboard: { writeText: () => {} },
    sessions: new Map([['active', { id: 'active', kind: 'codex' }]]),
    terminalCache: new Map(),
    getActiveSessionId: () => 'active',
    getCurrentFontSize: () => 16,
    selectSession: () => calls.push(['select']),
    escapeToHome: () => calls.push(['home']),
    toggleSidebar: () => calls.push(['sidebar']),
    openTerminalSearch: () => calls.push(['terminal-search']),
    openPreviewQuickOpen: () => calls.push(['quick-open']),
    setFontSize: () => calls.push(['font']),
    closeSession: () => calls.push(['close']),
  });
  for (const key of ['o', 'k', 'n', 'w', 'b', 'f']) {
    const event = makeEvent({ key, target: { tagName: 'INPUT' } });
    shortcuts.handleKeydown(event);
    assert.equal(event.defaultPrevented, false);
  }
  assert.deepStrictEqual(calls, []);
});

test('Ctrl+Shift+B forks the active session', () => {
  const calls = [];
  const shortcuts = createKeyboardShortcuts({
    document: { addEventListener: () => {} },
    ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve({ ok: true }); } },
    clipboard: { writeText: () => {} },
    sessions: new Map([['claude-source', { id: 'claude-source', kind: 'claude', title: '架构复盘' }]]),
    terminalCache: new Map(),
    getActiveSessionId: () => 'claude-source',
    getCurrentFontSize: () => 16,
    selectSession: () => {},
    escapeToHome: () => {},
    toggleSidebar: () => {},
    openTerminalSearch: () => {},
    setFontSize: () => {},
  });

  const e = makeEvent({ key: 'B', code: 'KeyB', shiftKey: true });
  shortcuts.handleKeydown(e);
  assert.strictEqual(e.defaultPrevented, true);
  assert.strictEqual(e.propagationStopped, true);
  assert.deepStrictEqual(calls, [['fork-session', {
    sourceSessionId: 'claude-source',
    sourceTitle: '架构复盘',
  }]]);
});

test('daily branch button can target the session shown in the header', async () => {
  const calls = [];
  const shortcuts = createKeyboardShortcuts({
    document: { addEventListener: () => {} },
    ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve({ ok: true }); } },
    clipboard: { writeText: () => {} },
    sessions: new Map([
      ['claude-button', { id: 'claude-button', kind: 'claude', title: '无线算法策略' }],
      ['other-active', { id: 'other-active', kind: 'codex' }],
    ]),
    terminalCache: new Map(),
    getActiveSessionId: () => 'other-active',
    getCurrentFontSize: () => 16,
    selectSession: () => {},
    escapeToHome: () => {},
    toggleSidebar: () => {},
    openTerminalSearch: () => {},
    setFontSize: () => {},
  });

  await shortcuts.forkSession('claude-button');
  assert.deepStrictEqual(calls, [['fork-session', {
    sourceSessionId: 'claude-button',
    sourceTitle: '无线算法策略',
  }]]);
});

test('terminal header exposes a one-click branch button through the shared provider capability', () => {
  const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  assert.match(rendererSource, /forkBtn\.className = 'btn-zoom btn-fork-session'/);
  assert.match(rendererSource, /forkBtn\.textContent = '分支'/);
  assert.match(rendererSource, /forkBtn\.addEventListener\('click', \(\) => \{\s*void keyboardShortcuts\.forkSession\(sessionId\);\s*\}\)/);
  assert.match(rendererSource, /const canForkSession = supportsForkSession\(session\)/);
});

test('DeepSeek on the Codex runtime reaches the same fork IPC as Codex', async () => {
  const calls = [];
  const shortcuts = createKeyboardShortcuts({
    document: { addEventListener: () => {} },
    ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve({ ok: true }); } },
    clipboard: { writeText: () => {} },
    sessions: new Map([['deepseek-source', {
      id: 'deepseek-source', kind: 'deepseek', codexSid: 'native-ds', title: 'DeepSeek 复盘',
    }]]),
    terminalCache: new Map(),
    getActiveSessionId: () => 'deepseek-source',
    getCurrentFontSize: () => 16,
    selectSession: () => {}, escapeToHome: () => {}, toggleSidebar: () => {},
    openTerminalSearch: () => {}, setFontSize: () => {},
  });

  await shortcuts.forkSession('deepseek-source');
  assert.deepStrictEqual(calls, [['fork-session', {
    sourceSessionId: 'deepseek-source', sourceTitle: 'DeepSeek 复盘',
  }]]);
});

test('session cycling follows sidebar sort order', () => {
  const selected = [];
  const sessions = new Map([
    ['old', { id: 'old', createdAt: 1, lastMessageTime: 10 }],
    ['pin', { id: 'pin', pinned: true, createdAt: 1, lastMessageTime: 1 }],
    ['new', { id: 'new', createdAt: 2, lastMessageTime: 20 }],
  ]);
  const shortcuts = createKeyboardShortcuts({
    document: { addEventListener: () => {} },
    ipcRenderer: { invoke: () => {} },
    clipboard: { writeText: () => {} },
    sessions,
    terminalCache: new Map(),
    getActiveSessionId: () => 'pin',
    getCurrentFontSize: () => 16,
    selectSession: (id) => selected.push(id),
    escapeToHome: () => {},
    toggleSidebar: () => {},
    openTerminalSearch: () => {},
    setFontSize: () => {},
  });

  assert.deepStrictEqual(shortcuts.getSortedVisibleSessionIds(), ['pin', 'new', 'old']);
  shortcuts.cycleSession(1);
  assert.deepStrictEqual(selected, ['new']);
});
