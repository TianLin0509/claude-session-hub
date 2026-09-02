const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'meeting-room.js'), 'utf8');
const openMeetingMatch = SRC.match(/function openMeeting\s*\(meetingId,\s*meeting,\s*opts\s*=\s*\{\}\)\s*\{[\s\S]*?function closeMeetingPanel\s*\(/);
assert.ok(openMeetingMatch, 'openMeeting block must be present');
const OPEN_MEETING_SRC = openMeetingMatch[0];

assert.match(
  SRC,
  /async function refreshGroupChatPanel\s*\(\s*meeting,\s*opts\s*=\s*\{\}\s*\)/,
  'refreshGroupChatPanel must accept options for open-time scroll behavior'
);

assert.match(
  SRC,
  /forceGroupChatBottom\s*=\s*\(forceMeetingBottom\s*\|\|\s*!!opts\.forceGroupChatBottom\)[\s\S]{0,100}&&\s*!!meeting\.groupChat/,
  'unified group surface force-bottom must accept explicit meeting navigation'
);

assert.match(
  OPEN_MEETING_SRC,
  /refreshGroupChatPanel\s*\(\s*meeting,\s*\{\s*forceMeetingBottom:\s*opts\.forceScrollBottom\s*===\s*true,?\s*\}\s*\)/,
  'openMeeting must forward only an explicit sidebar bottom-pin request'
);

assert.match(
  SRC,
  /forceBottom\s*\|\|\s*snapshot\.stickToBottom/,
  'forced bottom pinning must reuse the same restore path as sticky-bottom refreshes'
);

assert.match(
  SRC,
  /_renderActivePanelFromCache\s*\(meetingData\[meeting\.id\][\s\S]{0,180}forceGroupChatBottom:\s*true[\s\S]{0,100}forceMeetingBottom:\s*true/,
  'a user-authored group question must force both chat and card layouts to the newest content'
);

console.log('meeting-room group chat scroll contract ok');
