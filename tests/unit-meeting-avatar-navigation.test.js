'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const meeting = fs.readFileSync(path.join(root, 'renderer', 'meeting-room.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'renderer', 'styles', 'meeting-room-chat-flow.css'), 'utf8');

assert.match(renderer,
  /window\.openMeetingMemberSession\s*=\s*function[\s\S]*?selectSession\(sessionId,\s*\{\s*forceScrollBottom:\s*true\s*\}\)/,
  'renderer must expose an explicit meeting-to-main-session bridge');
assert.match(renderer,
  /MeetingRoom\.getActiveMeetingId\(\)[\s\S]*?MeetingRoom\.closeMeetingPanel\(\)/,
  'session selection must release meeting-room lifecycle state, not only hide its DOM');

assert.match(meeting,
  /mr-ft-avatar mr-session-jump[\s\S]*?data-gc-open-session=/,
  'card-view AI avatar must carry its child session id');
assert.match(meeting,
  /mr-gc-ob-avatar mr-session-jump[\s\S]*?data-gc-open-session=/,
  'empty-state AI avatar must carry its child session id');
assert.match(meeting,
  /mr-gc-avatar mr-session-jump[\s\S]*?data-gc-open-session=/,
  'chat-message AI avatar must carry its child session id');

assert.match(meeting,
  /_closestInPanel\(ev\.target, '\[data-gc-open-session\]', panel\)[\s\S]*?_openMeetingMemberSession/,
  'delegated click must open the requested child session');
assert.match(meeting,
  /panel\.addEventListener\('keydown'[\s\S]*?ev\.key !== 'Enter'[\s\S]*?ev\.key !== ' '[\s\S]*?_openMeetingMemberSession/,
  'keyboard activation must match mouse activation');
assert.match(css, /\.mr-session-jump\s*\{[\s\S]*?cursor:\s*pointer/,
  'clickable avatars need a visible navigation affordance');

console.log('meeting avatar navigation contract: OK');
