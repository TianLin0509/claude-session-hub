'use strict';

// fixture 是 2026-08-28 用 node-pty 起真 Claude Code v2.1.251、在一份新建的
// _scratch 工作区里抓到的原始 PTY 字节（tests/fixtures/claude-trust-dialog-v2.1.251.txt）。
// 别改成手写字符串 —— 这个框的关键特征（CUP 定位 + 词间 CSI nC + 默认高亮在
// "No, exit"）全都只有真字节才带得出来。

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { detectClaudeTrustDialog, renderPtyRows } = require('../core/claude-trust-dialog.js');

const fixture = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'claude-trust-dialog-v2.1.251.txt'),
  'utf8',
);

// --- 版式还原 ---
const rows = renderPtyRows(fixture);
const lines = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, line]) => line.trim());
assert.ok(lines.some(line => line === '❯ No, exit'), '光标应停在 No, exit 上');
assert.ok(lines.some(line => line === 'Yes, I trust this folder'), '应还原出 Yes 选项行');
assert.ok(lines.some(line => /Enter to confirm/.test(line)), '应还原出确认提示行');

// --- 定位与按键 ---
const dialog = detectClaudeTrustDialog(fixture);
assert.ok(dialog, '真实信任框必须被识别');
assert.strictEqual(dialog.trustRow - dialog.cursorRow, 1, 'Yes 选项在光标下一行');
// 这是本次修复的核心断言：默认高亮是 "No, exit"，只发回车等于替用户选退出。
assert.deepStrictEqual(dialog.keys, ['\x1b[B', '\r']);
assert.notDeepStrictEqual(dialog.keys, ['\r']);

// --- 不该误判的输入 ---
assert.strictEqual(detectClaudeTrustDialog(''), null);
assert.strictEqual(detectClaudeTrustDialog('nothing interesting here'), null);
// 正文里出现 trust 但没有选项菜单（例如帮助文本）不能触发。
assert.strictEqual(
  detectClaudeTrustDialog('Quick safety check: is this a project you trust?'),
  null,
  '只有提示语、没有可定位的选项时不得发按键',
);
// 有选项但定不到光标 → 宁可不动手。
assert.strictEqual(
  detectClaudeTrustDialog('Accessing workspace:\nNo, exit\nYes, I trust this folder\nEnter to confirm'),
  null,
  '定位不到光标行时不得发按键',
);

// --- 顺序调换后仍然选对（防止 CLI 以后把 Yes 放到前面） ---
const swapped = [
  '\x1b[2J',
  '\x1b[8;2HAccessing workspace:',
  '\x1b[10;2HQuick safety check: do you trust this project?',
  '\x1b[19;2H❯ No, exit',
  '\x1b[18;4HYes, I trust this folder',
  '\x1b[22;2HEnter to confirm',
].join('');
const swappedDialog = detectClaudeTrustDialog(swapped);
assert.ok(swappedDialog, 'Yes 在上方时也要识别');
assert.deepStrictEqual(swappedDialog.keys, ['\x1b[A', '\r'], 'Yes 在上方应向上移动');

// --- 光标已经落在 Yes 上时只按回车 ---
const alreadyOnYes = [
  '\x1b[2J',
  '\x1b[8;2HAccessing workspace:',
  '\x1b[10;2HQuick safety check',
  '\x1b[19;2H  No, exit',
  '\x1b[20;2H❯ Yes, I trust this folder',
  '\x1b[22;2HEnter to confirm',
].join('');
assert.deepStrictEqual(detectClaudeTrustDialog(alreadyOnYes).keys, ['\r']);

// 终端能力查询 \x1b[>0q 不得被当成正文写进行里。
const rowsWithPrivateCsi = renderPtyRows('\x1b[2J\x1b[6;1H\x1b[>0qHELLO');
assert.strictEqual([...rowsWithPrivateCsi.values()].join('').trim(), 'HELLO');

console.log('unit-claude-trust-dialog: OK');
