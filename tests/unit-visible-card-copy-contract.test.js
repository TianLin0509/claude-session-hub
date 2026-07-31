'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const helper = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'visible-card-text.js'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
const meetingRoom = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'meeting-room.js'), 'utf8');

assert.match(helper, /function extractVisibleCardText\s*\(/);
assert.match(helper, /clone\.querySelectorAll\([\s\S]{0,280}'button'/,
  'visible-text extractor must remove interactive buttons from the cloned body');
assert.match(helper, /\.code-toggle/,
  'visible-text extractor must remove code fold labels');
assert.match(helper, /annotation\[encoding="application\/x-tex"\]/,
  'KaTeX must collapse to one source formula instead of copying visual + accessibility text twice');

const ordinaryCopyStart = renderer.indexOf("if (action === 'copy')", renderer.indexOf('D5 操作按钮 click'));
const ordinaryCopyBody = renderer.slice(ordinaryCopyStart, ordinaryCopyStart + 800);
assert.match(ordinaryCopyBody, /extractVisibleCardText\(card\.querySelector\('\.turn-body'\)\)/,
  'ordinary session card copy must use rendered answer body');
assert.doesNotMatch(ordinaryCopyBody, /turn\.toolCalls|```/,
  'ordinary card copy must not rebuild raw markdown/tool-call fences');

const hoverStart = meetingRoom.indexOf('async function _handleSlotHoverAction');
const hoverBody = meetingRoom.slice(hoverStart, hoverStart + 1500);
assert.match(hoverBody, /extractVisibleCardText\([\s\S]{0,160}\.mr-ft-preview/,
  'group card hover copy must copy only the preview body');

const messageStart = meetingRoom.indexOf('async function _handleGcMessageCopy');
const messageBody = meetingRoom.slice(messageStart, messageStart + 500);
assert.match(messageBody, /extractVisibleCardText\(msgEl\?\.querySelector\('\.mr-gc-bubble'\)\)/,
  'group chat bubble copy must strip code-copy controls inside the bubble');

console.log('visible card copy contract ok');
