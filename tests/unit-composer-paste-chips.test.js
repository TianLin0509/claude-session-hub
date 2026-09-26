'use strict';

// 长文本粘贴块的纯函数部分：行数、收块门槛、标记展开（含丢失可见）、以及接线契约。
// DOM 行为（插入、光标、退格、撤销、悬停、复制、发送）由 tests/e2e-composer-paste-chip-cdp.js 在真实 Hub 里验收。

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const chips = require('../renderer/composer-paste-chips.js');

assert.strictEqual(chips.countLines(''), 0);
assert.strictEqual(chips.countLines('a'), 1);
assert.strictEqual(chips.countLines('a\nb'), 2);
assert.strictEqual(chips.countLines('a\nb\n'), 2, 'trailing newline does not add a line');

assert.strictEqual(chips.shouldCollapsePaste('短句'), false);
assert.strictEqual(chips.shouldCollapsePaste(Array(9).fill('x').join('\n')), false, '9 lines stay inline');
assert.strictEqual(chips.shouldCollapsePaste(Array(10).fill('x').join('\n')), true, '10 lines collapse');
assert.strictEqual(chips.shouldCollapsePaste('x'.repeat(2000)), true, 'one very long line collapses');
assert.strictEqual(chips.shouldCollapseReplace(Array(50).fill('x').join('\n')), false, 'recalled history stays editable');
assert.strictEqual(chips.shouldCollapseReplace(Array(200).fill('x').join('\n')), true);

const original = '第一行\r不是换行符\n第二行  孤立的私用区字符\n';
const id = chips.registerPaste(original);
assert.match(id, /^p[a-z0-9]+$/);
assert.deepStrictEqual(chips.pasteEntry(id), { text: original, lines: 2, chars: original.length });
const raw = `前${chips.MARK_START}${id}${chips.MARK_END}后`;
assert.strictEqual(chips.hasPasteMarkers(raw), true);
assert.strictEqual(chips.expandPasteMarkers(raw), `前${original}后`, 'expansion is byte-exact');
assert.strictEqual(chips.expandPasteMarkers('普通文字'), '普通文字');
assert.strictEqual(chips.hasPasteMarkers('普通文字  x'), false, 'a stray private-use char is not a marker');
assert.strictEqual(chips.expandPasteMarkers(`${chips.MARK_START}pmissing${chips.MARK_END}`), '[粘贴内容已丢失]',
  'a lost chip must be visible, never silently sent as empty text');
const second = chips.registerPaste('第二段');
assert.notStrictEqual(second, id);
assert.strictEqual(chips.expandPasteMarkers(raw + chips.MARK_START + second + chips.MARK_END), `前${original}后第二段`);

// 接线契约：发送/草稿走展开后的文字；只有会话输入框开启收块；复制经过展开。
// 生产检出是 CRLF（autocrlf），worktree 是 LF：源码统一成 LF 再做文本断言。
const readSource = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8').replace(/\r\n/g, '\n');
const renderer = readSource('renderer', 'renderer.js');
assert.match(renderer, /function readContenteditablePlainText\(el\) \{\n\s+return pasteChips\.expandPasteMarkers\(readContenteditableRawText\(el\)\);/);
assert.match(renderer, /attachContenteditablePasteImage\(inputBox, \{ collapseLongText: true \}\)/);
assert.match(renderer, /createClipboardController\(\{[^}]*expandText: pasteChips\.expandPasteMarkers/);
const sendStart = renderer.indexOf('function sendInput()');
assert.ok(sendStart > 0);
assert.match(renderer.slice(sendStart, sendStart + 200), /const userText = readContenteditablePlainText\(inputBox\);/);
// 群聊输入框也开启了粘贴块（2026-09-26）。它的前提是：发送读展开后的原文，写回输入框一律经
// _renderComposerRaw（直接赋 textContent 会把块变成一串可见的 id）。
const meetingRoom = readSource('renderer', 'meeting-room.js');
assert.match(meetingRoom, /attachContenteditablePasteImage\(inputBox, \{ collapseLongText: true \}\)/);
assert.match(meetingRoom, /const userText = box \? readContenteditablePlainText\(box\)\.trim\(\) : '';/, 'group send must expand chips');
const rawWrites = meetingRoom.split('\n').filter(line => /\b(input|inp|box|inputBox)\.textContent = (?!''|q;)/.test(line));
assert.deepStrictEqual(rawWrites.map(line => line.trim()),
  ["else inputBox.textContent = match.text.slice(0, match.start) + inserted + spacer + suffix;"],
  'only the non-group mention path may assign textContent directly; group composer writes go through _renderComposerRaw');

// renderComposerValue：标记还原成块；大段纯文本整段收块；小段纯文本原样。用最小 DOM 替身验证。
function fakeDocument() {
  const make = (tag, text) => {
    const node = { tagName: tag, nodeType: tag ? 1 : 3, children: [], dataset: {}, className: '', contentEditable: 'inherit',
      appendChild(child) { this.children.push(child); return child; } };
    Object.defineProperty(node, 'textContent', {
      get() { return tag ? this.children.map(c => c.textContent).join('') : text; },
      set(value) { if (tag) { this.children = value ? [make(null, String(value))] : []; } else { text = String(value); } },
    });
    return node;
  };
  return { createElement: tag => make(tag.toUpperCase()), createTextNode: text => make(null, text), make };
}
{
  const document = fakeDocument();
  const box = document.createElement('div');
  const idA = chips.registerPaste('甲\n乙');
  chips.renderComposerValue(box, `前${chips.MARK_START}${idA}${chips.MARK_END}后`, { document });
  assert.deepStrictEqual(box.children.map(c => c.tagName || 'text'), ['text', 'SPAN', 'text']);
  assert.strictEqual(box.children[1].className, 'fi-paste-chip');
  assert.strictEqual(box.children[1].contentEditable, 'false');
  assert.strictEqual(chips.expandPasteMarkers(box.textContent), '前甲\n乙后');

  const big = Array(250).fill('长行').join('\n');
  chips.renderComposerValue(box, big, { document });
  assert.deepStrictEqual(box.children.map(c => c.tagName || 'text'), ['SPAN'], 'large plain text becomes one chip');
  assert.strictEqual(chips.expandPasteMarkers(box.textContent), big, 'and still expands to the exact text');
  assert.match(box.children[0].dataset.label, /250 行/);

  chips.renderComposerValue(box, '短句\n第二行', { document });
  assert.deepStrictEqual(box.children.map(c => c.tagName || 'text'), ['text'], 'small plain text stays editable text');
  assert.strictEqual(box.textContent, '短句\n第二行');

  chips.renderComposerValue(box, `${chips.MARK_START}pgone${chips.MARK_END}`, { document });
  assert.strictEqual(box.textContent, '[粘贴内容已丢失]', 'a lost chip renders visibly');
}

console.log('unit-composer-paste-chips: all passed');
