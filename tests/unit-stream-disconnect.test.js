'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  appendStreamDisconnectChunk,
  detectStreamDisconnect,
  hasStreamDisconnectIssue,
} = require('../core/stream-disconnect.js');

test('detects Codex stream disconnect output through ANSI decoration', () => {
  const issue = detectStreamDisconnect(
    '\x1b[31m■ stream disconnected before completion: error sending request for url\x1b[0m',
  );
  assert.equal(issue.type, 'stream-disconnected');
  assert.match(issue.message, /stream disconnected before completion/i);
});

test('detects Claude Code final connection dropped banner', () => {
  const issue = detectStreamDisconnect('\x1b[33mAPI Error: Connection dropped (ECONNRESET)\x1b[0m\r\n');
  assert.ok(issue);
  assert.equal(issue.type, 'stream-disconnected');
  assert.match(issue.message, /Connection dropped \(ECONNRESET\)/i);
});

test('detects a stream error split across PTY chunks', () => {
  const first = appendStreamDisconnectChunk('', '■ stream discon');
  assert.equal(first.issue, null);
  const second = appendStreamDisconnectChunk(first.tail, 'nected before completion: ECONNRESET\r\n');
  assert.equal(second.issue.type, 'stream-disconnected');
  assert.match(second.issue.message, /ECONNRESET/i);
});

test('does not treat ordinary assistant prose as a network failure', () => {
  assert.equal(detectStreamDisconnect(
    '我们可以在文档里解释 stream disconnected before completion 这句报错。',
  ), null);
  assert.equal(detectStreamDisconnect('› stream disconnected before completion: 请解释原因'), null);
  assert.equal(detectStreamDisconnect('The stream completed successfully.'), null);
});

test('does not treat Claude HTTP, auth, or rate-limit request failures as a disconnect', () => {
  assert.equal(detectStreamDisconnect('API Error: Request failed with status code 429'), null);
  assert.equal(detectStreamDisconnect('API Error: Request failed with status code 401'), null);
  assert.equal(detectStreamDisconnect('API Error: Invalid API key'), null);
});

test('connection issue helper requires the explicit persisted type', () => {
  assert.equal(hasStreamDisconnectIssue({ connectionIssue: { type: 'stream-disconnected' } }), true);
  assert.equal(hasStreamDisconnectIssue({ connectionIssue: { type: 'other' } }), false);
});
