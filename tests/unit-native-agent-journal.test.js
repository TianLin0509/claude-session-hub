'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('background activity has a durable identity separate from user submission receipts', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-native-activity-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const options = { directory, sessionId: 'session-a' };
  const journal = new NativeAgentJournal(options);
  journal.saveActivity({ userMessageId: 'activity-a', nativeActivity: true, origin: { kind: 'channel' }, status: 'running' });
  journal.saveActivity({ userMessageId: 'activity-a', nativeActivity: true, origin: { kind: 'channel' }, status: 'completed', finalText: '后台结果' });
  const reopened = new NativeAgentJournal(options);
  assert.equal(reopened.list().length, 0);
  assert.equal(reopened.listActivities()[0].finalText, '后台结果');
});
const { NativeAgentJournal } = require('../core/native-agent-journal');

test('submission identity, exact text and terminal receipt survive reopening', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-native-journal-'));
  const options = { directory, sessionId: 'session-a' };
  const journal = new NativeAgentJournal(options);
  const text = '  中文\r\n- 🧪 \n  ';
  journal.saveSubmission({ submissionId: 'a', text, promptFingerprint: 'exact', sendStatus: 'queued' });
  journal.saveLifecycle({ clientSubmissionId: 'a', promptFingerprint: 'exact', status: 'completed', resultId: 'result-a', text: 'assistant answer' });
  const recovered = new NativeAgentJournal(options).list();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].text, text);
  assert.equal(recovered[0].status, 'completed');
  assert.equal(recovered[0].resultId, 'result-a');
  assert.equal(recovered[0].finalText, 'assistant answer');
});

test('same identity with changed body is rejected before a write', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-native-journal-'));
  const journal = new NativeAgentJournal({ directory, sessionId: 'session-a' });
  journal.saveSubmission({ submissionId: 'a', promptFingerprint: 'one' });
  const before = fs.readFileSync(journal.filePath, 'utf8');
  assert.throws(() => journal.saveSubmission({ submissionId: 'a', promptFingerprint: 'two' }), /identity changed/);
  assert.equal(fs.readFileSync(journal.filePath, 'utf8'), before);
});

test('truncated or wrong-session journal is explicit failure, never an empty history', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-native-journal-'));
  const options = { directory, sessionId: 'session-a' };
  const file = path.join(directory, 'session-a.jsonl');
  fs.writeFileSync(file, '{"version":1');
  assert.throws(() => new NativeAgentJournal(options), /incomplete final record/);
  fs.writeFileSync(file, JSON.stringify({ version: 1, sequence: 1, sessionId: 'session-b', type: 'submission', data: {} }) + '\n');
  assert.throws(() => new NativeAgentJournal(options), /Invalid native journal/);
  assert.throws(() => new NativeAgentJournal({ directory, sessionId: '../escape' }), /Invalid Hub session ID/);
});

test('write failure propagates and cannot advance in-memory truth', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-native-journal-'));
  const journal = new NativeAgentJournal({ directory, sessionId: 'session-a' });
  fs.mkdirSync(journal.filePath);
  assert.throws(() => journal.saveSubmission({ submissionId: 'a', text: 'not saved' }));
  assert.equal(journal.entries.length, 0);
  assert.equal(journal.records.size, 0);
});

test('invalid UTF-8 and an out-of-date writer are rejected explicitly', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-native-journal-'));
  const options = { directory, sessionId: 'session-a' };
  const a = new NativeAgentJournal(options);
  const b = new NativeAgentJournal(options);
  a.saveSubmission({ submissionId: 'one' });
  assert.throws(() => b.saveSubmission({ submissionId: 'two' }), /changed outside its owner/);
  fs.writeFileSync(a.filePath, Buffer.from([0xff, 0x0a]));
  assert.throws(() => new NativeAgentJournal(options), /encoded data/);
});
