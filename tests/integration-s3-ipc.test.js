'use strict';
// spec2/S3 integration assertion：确认 main.js 已注册
//   1. ipcMain.handle('parse-session-transcript', ...)
//   2. transcriptTap.on('turn-complete') 内广播 'turn-complete-event' 给 renderer
//
// 这是 grep 风格的"代码存在性"断言——IPC 真实行为属于 E2E（S10），此处不做。
// 目的：防止后续 refactor 误删 spec2/S3 接入点。

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const mainJsPath = path.join(__dirname, '..', 'main.js');
const src = fs.readFileSync(mainJsPath, 'utf-8');

// 1. parse-session-transcript handle
assert.match(
  src,
  /ipcMain\.handle\(\s*['"]parse-session-transcript['"]/,
  'main.js should register ipcMain.handle("parse-session-transcript", ...)'
);

// 2. turn-complete-event broadcast (literal channel name)
assert.match(
  src,
  /sendToRenderer\(\s*['"]turn-complete-event['"]|webContents\.send\(\s*['"]turn-complete-event['"]/,
  'main.js should broadcast "turn-complete-event" to renderer'
);

// 3. parser require
assert.match(
  src,
  /require\(\s*['"]\.\/core\/claude-transcript-parser(?:\.js)?['"]\s*\)/,
  'main.js should require ./core/claude-transcript-parser'
);

// 4. transcriptTap turn-complete listener still in place（不能被 S3 误改替换掉）
assert.match(
  src,
  /transcriptTap\.on\(\s*['"]turn-complete['"]/,
  'transcriptTap.on("turn-complete", ...) listener must remain registered'
);

// 5. meeting-timeline-updated 仍在广播（spec2 S3 0 改动承诺：圆桌路径不破）
assert.match(
  src,
  /sendToRenderer\(\s*['"]meeting-timeline-updated['"]/,
  'main.js should still broadcast meeting-timeline-updated (spec2 zero-regression for roundtable)'
);

console.log('OK: spec2/S3 IPC assertions passed');
