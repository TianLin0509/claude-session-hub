const assert = require('assert');
const fs = require('fs');
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
  const deleteBtn = makeElement();
  deleteBtn.dataset.action = 'delete';
  const contextMenuEl = makeElement();
  contextMenuEl.querySelector = (selector) => {
    if (selector === '[data-action="pin"]') return pinBtn;
    if (selector === '[data-action="restart"]') return restartBtn;
    if (selector === '[data-action="close"]') return closeBtn;
    if (selector === '[data-action="delete"]') return deleteBtn;
    return null;
  };
  contextMenuEl.querySelectorAll = () => [pinBtn, closeBtn, restartBtn, deleteBtn];

  const sessions = new Map([['s1', {
    id: 's1', kind: 'codex', codexSid: 'native-1', pinned: false, status: 'dormant',
  }]]);
  const meetings = {};
  let activeSessionId = 's1';
  let rendered = 0;
  let persisted = 0;
  const invoked = [];
  const sent = [];
  const notices = [];
  const wakes = [];
  const sessionMenu = createSessionContextMenuController({
    document: { addEventListener() {} },
    window: { innerWidth: 800, innerHeight: 600, confirm: () => true },
    contextMenuEl,
    sessions,
    meetings,
    ipcRenderer: {
      invoke(channel, sid) {
        invoked.push({ channel, sid });
        if (channel === 'restart-session') {
          return Promise.resolve({ ok: false, message: '尚未绑定原生会话 ID' });
        }
        return Promise.resolve({ ok: true });
      },
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
    notify: message => { notices.push(message); },
    wakeDormantSession: async (sid) => { wakes.push(sid); return { id: sid }; },
    requestAnimationFrameFn: (fn) => fn(),
  });
  sessionMenu.init();
  sessionMenu.open('s1', 10, 20);
  assert.strictEqual(contextMenuEl.style.display, 'block');
  assert.strictEqual(pinBtn.textContent, 'Pin to top');
  assert.strictEqual(closeBtn.style.display, 'none', 'dormant sessions cannot be closed twice');
  assert.strictEqual(restartBtn.textContent, '唤醒会话');
  assert.strictEqual(deleteBtn.style.display, '', 'dormant cards retain an explicit permanent-delete action');
  pinBtn._listeners.click();
  assert.strictEqual(sessions.get('s1').pinned, true);
  assert.strictEqual(rendered, 1);
  assert.strictEqual(persisted, 1);

  sessionMenu.open('s1', 10, 20);
  await restartBtn._listeners.click();
  assert.deepStrictEqual(wakes, ['s1']);
  assert.deepStrictEqual(invoked, [], 'dormant Restart must wake through resume-session instead of calling live restart');

  sessionMenu.open('s1', 10, 20);
  await deleteBtn._listeners.click();
  assert.strictEqual(activeSessionId, null);
  assert.strictEqual(sessions.has('s1'), false);

  sessions.set('s2', {
    id: 's2', title: 'Busy Codex', kind: 'codex', codexSid: 'native-2',
    status: 'running', _agentWorking: true, gcWorking: true,
  });
  sessionMenu.open('s2', 10, 20);
  assert.strictEqual(closeBtn.style.display, '');
  assert.strictEqual(closeBtn.textContent, '关闭并休眠');
  assert.strictEqual(restartBtn.textContent, '重启并继续当前会话');
  await restartBtn._listeners.click();
  assert.deepStrictEqual(invoked.at(-1), { channel: 'restart-session', sid: 's2' });
  assert.deepStrictEqual(notices, ['尚未绑定原生会话 ID']);

  sessionMenu.open('s2', 10, 20);
  await closeBtn._listeners.click();
  assert.deepStrictEqual(invoked.at(-1), { channel: 'close-session', sid: 's2' });
  assert.deepStrictEqual(notices, ['尚未绑定原生会话 ID'], 'running state must not block an explicit user close');

  sessionMenu.open('s2', 10, 20);
  await deleteBtn._listeners.click();
  assert.deepStrictEqual(invoked.at(-1), { channel: 'delete-session', sid: 's2' });

  sessions.set('protected', {
    id: 'protected', title: '初心投研任务', kind: 'codex',
    codexSid: 'native-protected', status: 'running', purpose: 'chuxin-research',
  });
  sessionMenu.open('protected', 10, 20);
  assert.strictEqual(restartBtn.style.display, 'none',
    'protected Chuxin research sessions must not advertise an operation the backend rejects');

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

  const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  assert.match(rendererSource, /createTerminalContextMenuController\([\s\S]*?openPathInHub\(target, \{[\s\S]*?cwd: getSessionCwd\(activeSessionId\)/,
    'terminal selection preview must resolve relative paths through the active session cwd');

  console.log('unit-context-menus-contract OK');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
