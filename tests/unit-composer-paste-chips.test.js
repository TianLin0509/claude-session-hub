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
const meetingRoom = readSource('renderer', 'meeting-room.js');
assert.ok(!/collapseLongText/.test(meetingRoom), 'group chat composer reads innerText directly; it must not get chips yet');

console.log('unit-composer-paste-chips: all passed');
