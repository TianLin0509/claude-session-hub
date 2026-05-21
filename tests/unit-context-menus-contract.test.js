const assert = require('assert');
const path = require('path');

const {
  createSessionContextMenuController,
  createTerminalContextMenuController,
} = require(path.join(__dirname, '..', 'renderer', 'context-menus.js'));

function makeElement() {
  const listeners = {};
  return {
    style: {},
    dataset: {},
    textContent: '',
    addEventListener(type, fn) { listeners[type] = fn; },
    contains() { return false; },
    getBoundingClientRect() { return { right: 100, bottom: 100, width: 50, height: 30 }; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    _listeners: listeners,
  };
}

async function main() {
  const pinBtn = makeElement();
  pinBtn.dataset.action = 'pin';
  const closeBtn = makeElement();
  closeBtn.dataset.action = 'close';
  const restartBtn = makeElement();
  restartBtn.dataset.action = 'restart';
  const contextMenuEl = makeElement();
  contextMenuEl.querySelector = (selector) => {
    if (selector === '[data-action="pin"]') return pinBtn;
    if (selector === '[data-action="restart"]') return restartBtn;
    return null;
  };
  contextMenuEl.querySelectorAll = () => [pinBtn, closeBtn, restartBtn];

  const sessions = new Map([['s1', { id: 's1', pinned: false, status: 'dormant' }]]);
  const meetings = {};
  let activeSessionId = 's1';
  let rendered = 0;
  let persisted = 0;
  const invoked = [];
  const sent = [];
  const sessionMenu = createSessionContextMenuController({
    document: { addEventListener() {} },
    window: { innerWidth: 800, innerHeight: 600 },
    contextMenuEl,
    sessions,
    meetings,
    ipcRenderer: {
      invoke(channel, sid) { invoked.push({ channel, sid }); return Promise.resolve(); },
      send(channel, payload) { sent.push({ channel, payload }); },
    },
    getActiveSessionId: () => activeSessionId,
    setActiveSessionId: (value) => { activeSessionId = value; },
    getActiveMeetingId: () => null,
    setActiveMeetingId() {},
    closeMeetingPanel() {},
    emptyStateEl: makeElement(),
    renderSessionList: () => { rendered += 1; },
    schedulePersist: () => { persisted += 1; },
    requestAnimationFrameFn: (fn) => fn(),
  });
  sessionMenu.init();
  sessionMenu.open('s1', 10, 20);
  assert.strictEqual(contextMenuEl.style.display, 'block');
  assert.strictEqual(pinBtn.textContent, 'Pin to top');
  pinBtn._listeners.click();
  assert.strictEqual(sessions.get('s1').pinned, true);
  assert.strictEqual(rendered, 1);
  assert.strictEqual(persisted, 1);

  sessionMenu.open('s1', 10, 20);
  await closeBtn._listeners.click();
  assert.strictEqual(activeSessionId, null);
  assert.strictEqual(sessions.has('s1'), false);

  const previewBtn = makeElement();
  previewBtn.dataset.action = 'preview';
  const termCtxMenuEl = makeElement();
  termCtxMenuEl.querySelector = () => previewBtn;
  let previewTarget = '';
  const terminalMenu = createTerminalContextMenuController({
    document: { addEventListener() {} },
    window: { innerWidth: 800, innerHeight: 600 },
    termCtxMenuEl,
    openPreviewPanel: (target) => { previewTarget = target; },
    requestAnimationFrameFn: (fn) => fn(),
  });
  terminalMenu.init();
  terminalMenu.open('  C:\\tmp\\a.md  ', 1, 2);
  previewBtn._listeners.click();
  assert.strictEqual(previewTarget, 'C:\\tmp\\a.md');
  assert.strictEqual(termCtxMenuEl.style.display, 'none');

  console.log('unit-context-menus-contract OK');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
