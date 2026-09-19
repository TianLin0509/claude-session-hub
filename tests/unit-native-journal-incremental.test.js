'use strict';
// The journal used to re-serialize the whole transcript on every save, so a
// session's file grew with the square of its length: one production journal
// measured 105 MB across 81 records, 98.6% of it repeated frames (2026-09-19).
// These tests hold the two properties that make the incremental form safe —
// the projection is unchanged, and any shape a delta cannot express falls back
// to a whole snapshot.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { NativeAgentJournal, mergeFrames, transcriptDelta } = require('../core/native-agent-journal');

const frame = (uuid, text) => ({ uuid, type: 'assistant', message: { content: [{ type: 'text', text }] } });
const activity = (messages, extra = {}) => ({
  userMessageId: 'activity-a', nativeActivity: true, origin: { kind: 'channel' },
  status: 'running', transcriptMessages: messages, ...extra,
});

function withJournal(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const options = { directory, sessionId: 'session-a' };
  return { options, open: () => new NativeAgentJournal(options),
    size: () => fs.statSync(path.join(directory, 'session-a.jsonl')).size };
}

test('a growing transcript is stored once per frame, not once per save', t => {
  const fixture = withJournal(t, 'hub-journal-growth-');
  const journal = fixture.open();
  const frames = [];
  for (let i = 0; i < 40; i++) {
    frames.push(frame('f' + i, 'x'.repeat(2000)));
    journal.saveActivity(activity([...frames]));
  }
  // Quadratic storage would be ~40 * 40 * 2000 / 2 = 1.6 MB of body text.
  // Linear storage is ~40 * 2000 = 80 KB plus per-record envelopes.
  assert.ok(fixture.size() < 300 * 1024, `journal grew to ${fixture.size()} bytes`);
  const reopened = fixture.open();
  assert.deepEqual(reopened.listActivities()[0].transcriptMessages, frames);
});

test('reopening reproduces the exact frames the caller passed', t => {
  const fixture = withJournal(t, 'hub-journal-projection-');
  const journal = fixture.open();
  const a = frame('a', 'first');
  const b = frame('b', 'second');
  journal.saveActivity(activity([a]));
  journal.saveActivity(activity([a, b]));
  // A revision in place: same identity, new content, no new frame.
  const revised = { ...b, message: { content: [{ type: 'text', text: 'second revised' }] } };
  journal.saveActivity(activity([a, revised], { status: 'completed', finalText: 'done' }));
  const reopened = fixture.open().listActivities()[0];
  assert.deepEqual(reopened.transcriptMessages, [a, revised]);
  assert.equal(reopened.status, 'completed');
  assert.equal(reopened.finalText, 'done');
});

test('a save that changes nothing still reopens with the full transcript', t => {
  const fixture = withJournal(t, 'hub-journal-nochange-');
  const journal = fixture.open();
  const frames = [frame('a', 'one'), frame('b', 'two')];
  journal.saveActivity(activity(frames));
  const afterFirst = fixture.size();
  journal.saveActivity(activity(frames, { status: 'unknown' }));
  assert.ok(fixture.size() - afterFirst < 500, 'an unchanged transcript must not be rewritten');
  const reopened = fixture.open().listActivities()[0];
  assert.deepEqual(reopened.transcriptMessages, frames);
  assert.equal(reopened.status, 'unknown');
});

test('removals and reorderings fall back to a whole snapshot', t => {
  const fixture = withJournal(t, 'hub-journal-fallback-');
  const journal = fixture.open();
  const a = frame('a', 'one'), b = frame('b', 'two'), c = frame('c', 'three');
  journal.saveActivity(activity([a, b, c]));
  journal.saveActivity(activity([a, c]));           // b unprojected by segment resolution
  assert.deepEqual(fixture.open().listActivities()[0].transcriptMessages, [a, c]);
  journal.saveActivity(activity([c, a]));           // reordered
  assert.deepEqual(fixture.open().listActivities()[0].transcriptMessages, [c, a]);
});

test('submission transcripts take the same route as activities', t => {
  const fixture = withJournal(t, 'hub-journal-submission-');
  const journal = fixture.open();
  const frames = [frame('a', 'one')];
  journal.saveSubmission({ submissionId: 's', text: '问题', promptFingerprint: 'f', transcriptMessages: [...frames] });
  frames.push(frame('b', 'two'));
  journal.saveLifecycle({ clientSubmissionId: 's', promptFingerprint: 'f', status: 'completed',
    text: 'answer', transcriptMessages: [...frames] });
  const recovered = fixture.open().list();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].text, '问题');
  assert.equal(recovered[0].finalText, 'answer');
  assert.deepEqual(recovered[0].transcriptMessages, frames);
});

test('unkeyed or duplicated frames are never expressed as a delta', () => {
  const a = frame('a', 'one');
  const unkeyed = { type: 'assistant', message: { content: [] } };
  assert.equal(transcriptDelta([a], [a, unkeyed]), null);
  assert.equal(transcriptDelta([a], [a, a]), null);
  assert.equal(transcriptDelta([], [a]), null);
  assert.equal(transcriptDelta(undefined, [a]), null);
});

test('every accepted delta replays to exactly the caller array', () => {
  const frames = Array.from({ length: 8 }, (_, i) => frame('f' + i, 'body ' + i));
  for (let cut = 1; cut < frames.length; cut++) {
    const previous = frames.slice(0, cut);
    const next = frames.slice(0, cut + 1);
    const delta = transcriptDelta(previous, next);
    assert.notEqual(delta, null, `expected a delta at ${cut}`);
    assert.deepEqual(mergeFrames(previous, delta), next);
  }
});
