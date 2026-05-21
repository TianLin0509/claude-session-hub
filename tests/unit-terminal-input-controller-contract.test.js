const assert = require('assert');
const path = require('path');

const { createTerminalInputController } = require(path.join(__dirname, '..', 'renderer', 'terminal-input-controller.js'));

function makeElement() {
  const listeners = {};
  return {
    style: {},
    dataset: {},
    children: [],
    className: '',
    innerHTML: '',
    appendChild(child) { this.children.push(child); return child; },
    addEventListener(type, fn) { listeners[type] = fn; },
    dispatchEvent(ev) { this.lastEvent = ev; },
    querySelector() { return null; },
    getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }; },
    _listeners: listeners,
  };
}

async function main() {
  const body = makeElement();
  let insertedText = '';
  const document = {
    body,
    createElement: makeElement,
    execCommand(cmd, _showUi, value) {
      assert.strictEqual(cmd, 'insertText');
      insertedText = value;
    },
  };
  const sent = [];
  const invoked = [];
  let imageEmpty = true;
  let clipboardText = 'plain text';
  const terminalCache = new Map([['s1', { terminal: { paste(value) { this.pasted = value; } } }]]);
  const controller = createTerminalInputController({
    document,
    window: { innerWidth: 800, innerHeight: 600 },
    ipcRenderer: {
      async invoke(channel) { invoked.push(channel); return 'C:\\tmp\\clip.png'; },
      send(channel, payload) { sent.push({ channel, payload }); },
    },
    clipboard: {
      readImage() { return { isEmpty: () => imageEmpty }; },
      readText() { return clipboardText; },
    },
    terminalCache,
    EventCtor: class FakeEvent { constructor(type, init) { this.type = type; this.init = init; } },
    requestAnimationFrameFn: (fn) => fn(),
    setTimeoutFn: (fn) => { fn(); return 1; },
    clearTimeoutFn: () => {},
  });

  await controller.handlePasteForSession('s1');
  assert.strictEqual(terminalCache.get('s1').terminal.pasted, 'plain text');

  imageEmpty = false;
  await controller.handlePasteForSession('s1');
  assert.strictEqual(terminalCache.get('s1').terminal.pasted, 'C:\\tmp\\clip.png');
  assert.ok(invoked.includes('save-clipboard-image'));

  const input = makeElement();
  controller.attachContenteditablePasteImage(input);
  await input._listeners.paste({
    clipboardData: { items: [{ kind: 'file', type: 'image/png' }] },
    preventDefault() { this.prevented = true; },
  });
  assert.strictEqual(insertedText, 'C:\\tmp\\clip.png');
  assert.strictEqual(input.lastEvent.type, 'input');

  assert.strictEqual(
    controller.extractPathAtPosition('see C:\\tmp\\clip.png now', 12),
    'C:\\tmp\\clip.png'
  );

  const terminal = {
    buffer: { active: { baseY: 10, cursorY: 2, cursorX: 8 } },
    getSelectionPosition: () => ({ start: { x: 4, y: 12 }, end: { x: 8, y: 12 } }),
    getSelection: () => 'test',
    clearSelection() {},
  };
  assert.deepStrictEqual(controller.getInputLineSelection(terminal), { startCol: 4, endCol: 8, text: 'test' });
  assert.strictEqual(controller.deleteInputSelection(terminal, 's1', '!'), true);
  assert.deepStrictEqual(sent.pop(), { channel: 'terminal-input', payload: { sessionId: 's1', data: '\x7f\x7f\x7f\x7f!' } });

  console.log('unit-terminal-input-controller-contract OK');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
