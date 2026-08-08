'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  AUTO_SUSPEND_CHECK_MS,
  AUTO_SUSPEND_IDLE_MS,
  AUTO_SUSPEND_REASON,
  collectProtectedSessionIds,
  createSessionAutoSuspendScheduler,
} = require('../main/session-auto-suspend.js');

test('automatic suspend defaults to five idle hours and a five-minute sweep', () => {
  assert.equal(AUTO_SUSPEND_IDLE_MS, 5 * 60 * 60 * 1000);
  assert.equal(AUTO_SUSPEND_CHECK_MS, 5 * 60 * 1000);
  assert.equal(AUTO_SUSPEND_REASON, 'idle-timeout');
});

test('main process starts the scheduler and stops it before quit', () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(mainSource, /createSessionAutoSuspendScheduler\s*\(/);
  assert.match(mainSource, /sessionAutoSuspendScheduler\.start\(\)/);
  assert.match(mainSource, /app\.on\('before-quit',[\s\S]*sessionAutoSuspendScheduler\?\.stop\(\)/);
});

test('active group-chat watchers and running loop members are protected', () => {
  const activeWatchers = new Map([
    ['watching', { isSettled: () => false }],
    ['finished', { isSettled: () => true }],
  ]);
  const protectedIds = collectProtectedSessionIds({
    groupChatDispatcher: { getActiveWatchers: () => activeWatchers },
    loopEngine: { isRunning: meetingId => meetingId === 'looping' },
    meetingManager: {
      getAllMeetings: () => [
        { id: 'looping', subSessions: ['builder', 'reviewer'] },
        { id: 'idle-room', subSessions: ['idle-member'] },
      ],
    },
  });

  assert.deepEqual([...protectedIds].sort(), ['builder', 'reviewer', 'watching']);
});

test('scheduler includes idle meeting members but excludes protected work', () => {
  const calls = [];
  let intervalCallback = null;
  let intervalDelay = null;
  let unrefCount = 0;
  let cleared = null;
  const timer = { unref: () => { unrefCount += 1; } };
  const protectedIds = new Set(['active-task']);
  const scheduler = createSessionAutoSuspendScheduler({
    sessionManager: {
      suspendIdleSessions: options => {
        calls.push(options);
        return { ok: true, count: 1, requested: ['idle-meeting-member'] };
      },
    },
    getProtectedSessionIds: () => protectedIds,
    now: () => 123456,
    logger: { log() {}, warn() {} },
    setIntervalFn: (callback, delay) => {
      intervalCallback = callback;
      intervalDelay = delay;
      return timer;
    },
    clearIntervalFn: value => { cleared = value; },
  });

  assert.equal(scheduler.start(), timer);
  assert.equal(scheduler.start(), timer, 'start should be idempotent');
  assert.equal(intervalDelay, AUTO_SUSPEND_CHECK_MS);
  assert.equal(unrefCount, 1);
  intervalCallback();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].idleMs, AUTO_SUSPEND_IDLE_MS);
  assert.equal(calls[0].now, 123456);
  assert.equal(calls[0].excludeMeeting, false);
  assert.equal(calls[0].excludeFocused, true);
  assert.equal(calls[0].excludePinned, true);
  assert.equal(calls[0].excludeSessionIds, protectedIds);
  assert.equal(calls[0].reason, AUTO_SUSPEND_REASON);
  assert.equal(scheduler.stop(), true);
  assert.equal(cleared, timer);
  assert.equal(scheduler.stop(), false);
});
