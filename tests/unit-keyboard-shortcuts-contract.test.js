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

test('Ctrl+Shift+B forks the active session', () => {
  const calls = [];
  const shortcuts = createKeyboardShortcuts({
    document: { addEventListener: () => {} },
    ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve({ ok: true }); } },
    clipboard: { writeText: () => {} },
    sessions: new Map([['claude-source', { id: 'claude-source', kind: 'claude' }]]),
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
  assert.deepStrictEqual(calls, [['fork-session', 'claude-source']]);
});

test('daily branch button can target the session shown in the header', async () => {
  const calls = [];
  const shortcuts = createKeyboardShortcuts({
    document: { addEventListener: () => {} },
    ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve({ ok: true }); } },
    clipboard: { writeText: () => {} },
    sessions: new Map([
      ['claude-button', { id: 'claude-button', kind: 'claude' }],
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
  assert.deepStrictEqual(calls, [['fork-session', 'claude-button']]);
});

test('terminal header exposes a one-click branch button for Claude and Codex', () => {
  const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  assert.match(rendererSource, /forkBtn\.className = 'btn-zoom btn-fork-session'/);
  assert.match(rendererSource, /forkBtn\.textContent = '分支'/);
  assert.match(rendererSource, /forkBtn\.addEventListener\('click', \(\) => \{\s*void keyboardShortcuts\.forkSession\(sessionId\);\s*\}\)/);
  assert.match(rendererSource, /session\.kind === 'claude'[\s\S]*session\.kind === 'claude-resume'[\s\S]*isCodexKind\(session\.kind\)/);
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
