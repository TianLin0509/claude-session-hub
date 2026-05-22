const test = require('node:test');
const assert = require('node:assert');
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
    preventDefault() { this.defaultPrevented = true; },
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
