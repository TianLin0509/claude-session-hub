'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dispatcherPath = path.join(root, 'main', 'groupchat', 'dispatcher.js');
const mainPath = path.join(root, 'main.js');
const dispatcherSrc = fs.readFileSync(dispatcherPath, 'utf8');
const mainSrc = fs.readFileSync(mainPath, 'utf8');
const { _parseGroupTargets } = require(dispatcherPath);

const members = [
  {
    sid: 's1',
    index: 0,
    memberId: 'm1',
    kind: 'codex',
    displayName: 'Codex',
    aliases: ['m1', 'Codex', 'codex'],
  },
  {
    sid: 's2',
    index: 1,
    memberId: 'm2',
    kind: 'gemini',
    displayName: 'Gemini',
    aliases: ['m2', 'Gemini', 'gemini'],
  },
];

assert.deepStrictEqual(
  _parseGroupTargets('@all please answer', members, [0]).targets.map(m => m.sid),
  ['s1', 's2'],
  '@all should target every active member'
);

assert.deepStrictEqual(
  _parseGroupTargets('@Gemini 你怎么看', members, [0]).targets.map(m => m.sid),
  ['s2'],
  '@displayName should override selected participants'
);

assert.deepStrictEqual(
  _parseGroupTargets('普通问题', members, [0]).targets.map(m => m.sid),
  ['s1'],
  'without mentions, selected participants should be used'
);

assert.ok(/createGroupChatDispatcher\(\{[\s\S]*kindLabels:\s*KIND_LABELS[\s\S]*transcriptTap[\s\S]*\}\)/.test(mainSrc),
  'main.js should initialize the dispatcher with explicit dependencies');

assert.ok(/markProcessExitForSession\(sessionId,\s*exitInfo\)/.test(mainSrc),
  'PTY process exit should still be forwarded to active groupchat watchers');

assert.ok(/getActiveWatchers:\s*groupChatDispatcher\.getActiveWatchers/.test(mainSrc),
  'recovery IPC should receive the dispatcher-owned active watcher registry');

assert.ok(/groupChatWatcher:\s*groupChatDispatcher\.getGroupChatWatcher\(\)/.test(mainSrc),
  'recovery IPC should keep using the same initialized groupchat watcher');

assert.ok(/activeWatchers\.set\(sid,\s*watcher\)/.test(dispatcherSrc) &&
  /activeWatchers\.delete\(sid\)/.test(dispatcherSrc),
  'dispatcher should own watcher lifecycle registration and cleanup');

console.log('Groupchat dispatcher contract: ok');
