'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'meeting-room.js'), 'utf8');
const loopHandlers = fs.readFileSync(path.join(root, 'main', 'ipc', 'loop-handlers.js'), 'utf8');

console.log('Running groupchat renderer concurrency contract tests...');

assert.match(renderer, /function _nextGcSendGeneration\(meetingId\)/,
  'all send modes should allocate a request generation synchronously');
assert.match(renderer, /function _isCurrentGcSend\(meetingId, generation\)/,
  'async completions need a shared latest-generation guard');
assert.match(renderer, /_gcInFlightQuestion\[[^\]]+\]\s*=\s*\{[\s\S]{0,220}generation/,
  'the recoverable in-flight question must own its generation');
assert.match(renderer, /function _restoreInterruptedQuestion\(meetingId, detail, expectedGeneration\)/,
  'interrupt recovery must accept the generation it is allowed to restore');
assert.match(renderer, /if\s*\(expectedGeneration\s*!=\s*null\s*&&\s*Number\(pending\.generation\)\s*!==\s*Number\(expectedGeneration\)\)\s*return false/,
  'interrupt recovery must reject an older request trying to restore a newer draft');

const triggerStart = renderer.indexOf('function triggerGroupChat');
const serialStart = renderer.indexOf('async function runSerialWorkflow');
const triggerSrc = renderer.slice(triggerStart, serialStart);
assert.match(triggerSrc, /if\s*\(!_isCurrentGcSend\(mid, myGeneration\)\)/,
  'normal groupchat completion must discard stale generations before mutating UI state');
assert.match(triggerSrc, /result\s*&&\s*result\.superseded/,
  'a superseded normal dispatch must not be treated as an ordinary completed turn');

const serialEnd = renderer.indexOf('// === 循环工作流', serialStart);
const serialSrc = renderer.slice(serialStart, serialEnd);
assert.match(serialSrc, /generation:\s*myGeneration[\s\S]{0,80}=\s*_beginGcInFlightQuestion/,
  'serial workflow must own one generation across all steps');
assert.match(serialSrc, /result\s*&&\s*result\.superseded/,
  'serial workflow must stop immediately when a newer send supersedes a step');
assert.match(serialSrc, /if\s*\(!_isCurrentGcSend\(m\.id, myGeneration\)\)/,
  'serial cleanup must not clobber a newer normal send');

assert.match(renderer, /activeMeetingId\s*&&\s*activeMeetingId\s*!==\s*meetingId[\s\S]{0,180}_clearQuoteChips\(\)/,
  'switching meetings must clear quote chips before they can leak into another room');

const partialHandler = renderer.slice(renderer.indexOf("ipcRenderer.on('groupchat-partial-update'"));
assert.match(partialHandler, /turnNum/,
  'partial updates need their turn number for stale-event filtering');
assert.match(partialHandler, /clientGeneration/,
  'partial updates need their renderer request generation for exact stale-event filtering');
assert.match(partialHandler, /_isStaleGcEvent/,
  'late partial updates from an older turn must be ignored');

const closeStart = renderer.indexOf('function closeMeetingPanel');
const closeEnd = renderer.indexOf('// Card optimization Task 10', closeStart);
const closeSrc = renderer.slice(closeStart, closeEnd);
assert.ok(!/_inputBound\s*=\s*false/.test(closeSrc),
  'closing and reopening a static panel must not bind send/interrupt/workflow listeners twice');
assert.match(closeSrc, /mr-interrupt-btn[\s\S]{0,120}hidden\s*=\s*true/,
  'closing the panel should explicitly hide the global interrupt button');
assert.match(renderer, /function _updateInterruptButton\(meeting\)\s*\{[\s\S]{0,180}meeting\.id\s*!==\s*activeMeetingId/,
  'background room progress must not change the active room interrupt button');

assert.match(renderer, /payload\.stage\s*===\s*'done'[\s\S]{0,240}pending\.mode\s*===\s*'loop'/,
  'an old loop completion may only clean up the loop question it owns');
assert.match(loopHandlers, /runLoop\([^;]+\)\.catch\(/,
  'detached loop runs must catch rejections instead of creating unhandled promises');

console.log('Groupchat renderer concurrency contract: ok');
