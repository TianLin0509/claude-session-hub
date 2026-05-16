const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'meeting-room.js'), 'utf8');
const openMeetingMatch = SRC.match(/function openMeeting\s*\(meetingId,\s*meeting\)\s*\{[\s\S]*?function closeMeetingPanel\s*\(/);
assert.ok(openMeetingMatch, 'openMeeting block must be present');
const OPEN_MEETING_SRC = openMeetingMatch[0];

assert.match(
  SRC,
  /async function refreshGroupChatPanel\s*\(\s*meeting,\s*opts\s*=\s*\{\}\s*\)/,
  'refreshGroupChatPanel must accept options for open-time scroll behavior'
);

assert.match(
  SRC,
  /forceGroupChatBottom\s*=\s*!!opts\.forceGroupChatBottom\s*&&\s*!!meeting\.groupChat\s*&&\s*_getGroupViewMode\(\)\s*===\s*['"]chat['"]/,
  'force-bottom option must be scoped to group chat chat view only'
);

assert.match(
  OPEN_MEETING_SRC,
  /refreshGroupChatPanel\s*\(\s*meeting,\s*\{\s*forceGroupChatBottom:\s*true\s*\}\s*\)/,
  'openMeeting must request bottom pinning when the meeting is opened from the sidebar'
);

assert.match(
  SRC,
  /forceBottom\s*\|\|\s*snapshot\.stickToBottom/,
  'forced bottom pinning must reuse the same restore path as sticky-bottom refreshes'
);

console.log('meeting-room group chat scroll contract ok');
