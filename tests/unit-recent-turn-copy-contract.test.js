'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const html = read('renderer/index.html');
const renderer = read('renderer/renderer.js');
assert.doesNotMatch(html, /id="recent-turn-copy(?:-[^"]+)?"/, 'retired toolbar must not occupy the conversation stage');
assert.doesNotMatch(renderer, /recentTurnCopyController|createRecentTurnCopyController/, 'retired toolbar must not remount after navigation');
assert.match(renderer, /formatRecentConversation\(entries, count\)/, 'conversation branching keeps its text formatter');
assert.match(renderer, /createCardMultiSelectController/, 'per-card multi-selection remains available');
console.log('removed toolbar integration contract ok');
