const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mroom-'));
process.env.CLAUDE_HUB_DATA_DIR = TEMP;

// IMPORTANT: invalidate require cache so meeting-store sees new env
delete require.cache[require.resolve('../core/data-dir')];
delete require.cache[require.resolve('../core/meeting-store')];
delete require.cache[require.resolve('../core/meeting-room')];

const { MeetingRoomManager } = require('../core/meeting-room');
const { loadMeetingFile, flushAll } = require('../core/meeting-store');

(async () => {
  const mgr = new MeetingRoomManager();
  const m = mgr.createMeeting();
  assert.strictEqual(m.completionNotificationEnabled, false, 'new meeting notification defaults off');
  assert.strictEqual(m.autoTitlePending, true, 'blank meeting title should allow auto title');
  assert.strictEqual(m.userRenamed, false, 'blank meeting title is not user renamed');
  const named = mgr.createMeeting({ title: '用户自定义房间' });
  assert.strictEqual(named.autoTitlePending, false, 'custom meeting title should not allow auto title');
  assert.strictEqual(named.userRenamed, true, 'custom meeting title is user renamed');
  mgr.addSubSession(m.id, 'sid-A');
  mgr.appendTurn(m.id, 'sid-A', 'hello world', 1000);
  mgr.appendTurn(m.id, 'user', 'reply', 2000);
  mgr.updateMeeting(m.id, { bottomed: true });
  assert.strictEqual(mgr.getMeeting(m.id).bottomed, true);
  assert.strictEqual(mgr.getMeeting(m.id).pinned, false);
  mgr.updateMeeting(m.id, { pinned: true });
  assert.strictEqual(mgr.getMeeting(m.id).pinned, true);
  assert.strictEqual(mgr.getMeeting(m.id).bottomed, false, 'placing a meeting at top clears bottom placement');
  mgr.updateMeeting(m.id, { bottomed: true });
  assert.strictEqual(mgr.getMeeting(m.id).pinned, false, 'placing a meeting at bottom clears top placement');

  await flushAll();

  const persisted = loadMeetingFile(m.id);
  assert.ok(persisted, 'meeting file persisted');
  assert.strictEqual(persisted._timeline.length, 2, 'timeline length 2');
  assert.strictEqual(persisted._timeline[0].text, 'hello world');
  assert.strictEqual(persisted._timeline[1].text, 'reply');
  assert.strictEqual(persisted._nextIdx, 2);
  assert.strictEqual(persisted.lastCompletedAt, 2000, 'latest AI reply time persisted');
  assert.strictEqual(persisted.lastMessageTime, 2000, 'legacy activity time stays in sync on completion');
  assert.strictEqual(persisted.bottomed, true, 'meeting bottom placement persists independently');
  console.log('PASS T2.1 mutation triggers persist');

  // T2.2: loadTimelineLazy populates in-memory
  const mgr2 = new MeetingRoomManager();
  mgr2.restoreMeeting({ id: m.id, title: 'recover', subSessions: ['sid-A'], layout: 'focus', lastCompletedAt: 2000 });
  assert.strictEqual(mgr2.getMeeting(m.id).lastCompletedAt, 2000, 'restore keeps latest reply time');
  const before = mgr2.getTimeline(m.id);
  assert.strictEqual(before.length, 0, 'restoreMeeting starts empty');
  mgr2.loadTimelineLazy(m.id);
  const after = mgr2.getTimeline(m.id);
  assert.strictEqual(after.length, 2, 'loadTimelineLazy fills timeline');
  console.log('PASS T2.2 loadTimelineLazy');

  console.log('ALL meeting-room-persist tests PASS');
  fs.rmSync(TEMP, { recursive: true, force: true });
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
