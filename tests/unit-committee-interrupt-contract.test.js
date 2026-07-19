'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createCommitteeConductor } = require('../main/groupchat/committee-conductor.js');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'main', 'groupchat', 'committee-conductor.js'),
  'utf8',
);

function create(dispatchResult) {
  return createCommitteeConductor({
    dispatchGroupChatTurn: async () => dispatchResult,
    meetingManager: { getMeeting: () => null },
    sessionManager: { getSession: () => null },
    logger: { log() {}, warn() {} },
  });
}

(async () => {
  const superseded = create({ status: 'completed', superseded: true, results: [] });
  assert.strictEqual(typeof superseded._dispatchForTest, 'function', 'test hook should expose the real dispatch guard');
  await assert.rejects(
    superseded._dispatchForTest('m1', 'old act'),
    err => err && err.committeeAbort === true && err.status === 'superseded',
    'a completed-but-superseded act must terminate the whole committee workflow',
  );

  const interrupted = create({ status: 'interrupted', results: [] });
  await assert.rejects(
    interrupted._dispatchForTest('m1', 'chair act'),
    err => err && err.committeeAbort === true && err.status === 'interrupted',
    'an interrupted act must be terminal, not eligible for chair retry',
  );

  assert.match(source, /function cancelCommitteeSession\(meetingId, status = 'interrupted'\)/,
    'committee cancellation must also work between individual AI dispatches');
  assert.match(source, /if\s*\(isCommitteeAbort\(e\)\)\s*throw e;[\s\S]{0,180}20s 后重试/,
    'chair retry must rethrow terminal interruption before sleeping/retrying');
  assert.match(source, /const checkDeadline = \(stage\) => \{[\s\S]{0,100}throwIfCommitteeCancelled\(meetingId\)/,
    'stage boundaries must observe a user cancellation even when no watcher is active');

  console.log('Committee supersede/interrupt contract: ok');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
