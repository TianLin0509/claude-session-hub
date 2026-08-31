'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(ROOT, 'renderer', 'meeting-room.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'renderer', 'styles', 'meeting-room-chat-flow.css'), 'utf8');

console.log('Running live groupchat membership UI contract tests...');

assert.match(renderer, /const _gcPendingUserMessageByMeeting = \{\}/, 'pending user messages need per-meeting state');
assert.match(renderer, /function _rememberPendingUserMessage\(/, 'send paths need one pending-message helper');
assert.match(renderer, /function _restoreQuestionAndPreserveDraft\(/,
  'failed sends must preserve both the failed question and an in-progress next draft');
assert.match(renderer, /const partialBy = state && state\._partialBy \? state\._partialBy : \{\}/,
  'dispatched members should show thinking before the first partial update');
assert.match(renderer, /data-gc-member-remove-sid=/, 'member rows need a remove action');
assert.match(renderer, /data-gc-add-member=/, 'member sidebar needs an add action');
assert.match(renderer, /if \(!meeting \|\| meeting\.subSessions\.length >= 3\) return;/, 'future group rooms keep the Claude/Codex/DeepSeek three-provider cap');
assert.match(renderer, /\['claude', 'codex', 'deepseek'\]\.filter/, 'group add menu only offers the supported provider trio');
assert.match(renderer, /response\.meeting/, 'participant writes must consume the explicit meeting response');
assert.match(renderer, /return state !== 'expanded'/, 'member sidebar should default to collapsed');
assert.doesNotMatch(renderer, /alert\('\?\?\?\?: '/, 'participant errors must not show mojibake');
assert.match(css, /\.mr-gc-member-remove/, 'remove action needs dedicated styling');
assert.match(css, /\.mr-gc-member > img/, 'member avatars need bounded sizing');

console.log('  OK pending user message is isolated per meeting');
console.log('  OK live add/remove controls are present');
console.log('  OK participant IPC response contract is explicit');
console.log('  OK UI wording and error text are readable');
