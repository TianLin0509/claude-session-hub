'use strict';

// 2026-08-28 用真 Electron 41 抓到的剪贴板形态（决定了这里的每一条断言）：
//   复制文件      → types=['Files']，items 全是 kind:'file'，getData('text/plain')=''，
//                   readText()=''、readImage() 空，webUtils.getPathForFile(f) 给出绝对路径；
//                   clipboard.readBuffer('FileNameW') 是 UTF-16LE + 结尾 NUL，只带第一个文件。
//   截图（位图）  → 同样是 types=['Files'] + items[0].type='image/png'，
//                   但 File 名叫 image.png 且 getPathForFile 返回**空串**。
// 「空串」就是区分真文件与内存位图的唯一判据，也是截图粘贴不被改坏的保证。

const assert = require('assert');
const path = require('path');
const {
  clipboardFilePathFromNative,
  clipboardFilePathsFromPasteEvent,
  createTerminalInputController,
  formatPastedFilePaths,
} = require(path.join(__dirname, '..', 'renderer', 'terminal-input-controller.js'));

// --- 纯函数层 ---
const webUtils = { getPathForFile: (f) => f.__path };
assert.deepStrictEqual(
  clipboardFilePathsFromPasteEvent({ clipboardData: { files: [{ __path: 'C:\\a\\doc.txt' }] } }, webUtils),
  ['C:\\a\\doc.txt'],
);
assert.deepStrictEqual(
  clipboardFilePathsFromPasteEvent({
    clipboardData: { files: [{ __path: 'C:\\a\\1.txt' }, { __path: 'C:\\a\\2 空格.png' }] },
  }, webUtils),
  ['C:\\a\\1.txt', 'C:\\a\\2 空格.png'],
);
// 截图：getPathForFile 空串 → 不算文件，交回图片分支
assert.deepStrictEqual(
  clipboardFilePathsFromPasteEvent({ clipboardData: { files: [{ __path: '' }] } }, webUtils),
  [],
);
assert.deepStrictEqual(clipboardFilePathsFromPasteEvent({ clipboardData: { files: [] } }, webUtils), []);
assert.deepStrictEqual(clipboardFilePathsFromPasteEvent({}, webUtils), []);
// webUtils 缺失（老 Electron / 测试桩）时不得抛异常
assert.deepStrictEqual(clipboardFilePathsFromPasteEvent({ clipboardData: { files: [{}] } }, null), []);

// 多个路径按换行拼：路径里可以有空格，空格分隔会被 CLI 拆错。
assert.strictEqual(formatPastedFilePaths(['C:\\a b\\x.txt', 'C:\\c.png']), 'C:\\a b\\x.txt\nC:\\c.png');
assert.strictEqual(formatPastedFilePaths([]), '');

// FileNameW 是 UTF-16LE 且结尾带 NUL
const nativeBuf = Buffer.from('C:\\Users\\lin\\报告.pdf\u0000', 'utf16le');
assert.strictEqual(
  clipboardFilePathFromNative({ readBuffer: () => nativeBuf }),
  'C:\\Users\\lin\\报告.pdf',
);
assert.strictEqual(clipboardFilePathFromNative({ readBuffer: () => Buffer.alloc(0) }), '');
assert.strictEqual(clipboardFilePathFromNative({ readBuffer: () => { throw new Error('nope'); } }), '');
assert.strictEqual(clipboardFilePathFromNative({}), '');
assert.strictEqual(clipboardFilePathFromNative(null), '');

// --- 控制器层 ---
function makeElement() {
  const listeners = {};
  return {
    style: {}, dataset: {}, children: [], className: '', innerHTML: '',
    appendChild(child) { this.children.push(child); return child; },
    addEventListener(type, fn) { listeners[type] = fn; },
    dispatchEvent(ev) { this.lastEvent = ev; },
    querySelector() { return null; },
    getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }; },
    _listeners: listeners,
  };
}

async function main() {
  let insertedText = '';
  const document = {
    body: makeElement(),
    createElement: makeElement,
    execCommand(_cmd, _showUi, value) { insertedText = value; },
  };
  const invoked = [];
  let nativeBuffer = Buffer.alloc(0);
  let imageEmpty = true;
  const terminalCache = new Map([['s1', { terminal: { paste(value) { this.pasted = value; } } }]]);
  const controller = createTerminalInputController({
    document,
    window: { innerWidth: 800, innerHeight: 600 },
    ipcRenderer: {
      async invoke(channel) { invoked.push(channel); return 'C:\\hub\\images\\shot.png'; },
      send() {},
    },
    clipboard: {
      readImage() { return { isEmpty: () => imageEmpty }; },
      readText() { return ''; },
      readBuffer() { return nativeBuffer; },
    },
    terminalCache,
    webUtils,
    EventCtor: class FakeEvent { constructor(type) { this.type = type; } },
    requestAnimationFrameFn: (fn) => fn(),
    setTimeoutFn: (fn) => { fn(); return 1; },
    clearTimeoutFn: () => {},
  });

  // xterm Ctrl+V：剪贴板里是文件 → 粘绝对路径，且不该去存截图
  nativeBuffer = Buffer.from('C:\\work\\spec.docx\u0000', 'utf16le');
  imageEmpty = false; // 图片文件同时也会让 readImage 非空，路径分支必须赢
  await controller.handlePasteForSession('s1');
  assert.strictEqual(terminalCache.get('s1').terminal.pasted, 'C:\\work\\spec.docx');
  assert.strictEqual(invoked.includes('save-clipboard-image'), false);

  // xterm Ctrl+V：只有位图 → 仍旧走 save-clipboard-image
  nativeBuffer = Buffer.alloc(0);
  await controller.handlePasteForSession('s1');
  assert.strictEqual(terminalCache.get('s1').terminal.pasted, 'C:\\hub\\images\\shot.png');
  assert.ok(invoked.includes('save-clipboard-image'));

  // 输入框：复制的文件（任意类型）→ 插入绝对路径
  const input = makeElement();
  controller.attachContenteditablePasteImage(input);
  insertedText = '';
  const invokedBefore = invoked.length;
  const fileEvent = {
    clipboardData: {
      files: [{ __path: 'C:\\work\\报表.xlsx' }],
      items: [{ kind: 'file', type: 'application/vnd.ms-excel' }],
      getData() { return ''; },
    },
    preventDefault() { this.prevented = true; },
  };
  await input._listeners.paste(fileEvent);
  assert.strictEqual(insertedText, 'C:\\work\\报表.xlsx');
  assert.strictEqual(fileEvent.prevented, true);
  assert.strictEqual(invoked.length, invokedBefore, '复制文件不该触发 save-clipboard-image');

  // 输入框：复制的图片文件也粘它自己的路径，而不是另存一份
  insertedText = '';
  await input._listeners.paste({
    clipboardData: {
      files: [{ __path: 'D:\\shots\\bug.png' }],
      items: [{ kind: 'file', type: 'image/png' }],
      getData() { return ''; },
    },
    preventDefault() {},
  });
  assert.strictEqual(insertedText, 'D:\\shots\\bug.png');
  assert.strictEqual(invoked.length, invokedBefore);

  // 输入框：截图（位图，getPathForFile 空串）→ 行为不变，仍走 save-clipboard-image
  insertedText = '';
  await input._listeners.paste({
    clipboardData: {
      files: [{ __path: '' }],
      items: [{ kind: 'file', type: 'image/png' }],
      getData() { return ''; },
    },
    preventDefault() {},
  });
  assert.strictEqual(insertedText, 'C:\\hub\\images\\shot.png');
  assert.strictEqual(invoked.length, invokedBefore + 1);

  // 输入框：纯文本粘贴行为不变
  insertedText = '';
  await input._listeners.paste({
    clipboardData: { files: [], items: [], getData: (t) => (t === 'text/plain' ? 'hello' : '') },
    preventDefault() {},
  });
  assert.strictEqual(insertedText, 'hello');

  console.log('unit-clipboard-file-paste: OK');
}

main().catch(err => { console.error(err); process.exit(1); });
