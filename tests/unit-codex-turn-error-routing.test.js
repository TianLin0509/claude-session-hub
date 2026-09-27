'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const tap = fs.readFileSync(path.join(root, 'core', 'transcript-tap.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');

test('real rollout failure shape stays failed in the main snapshot used by reload', () => {
  const { EventEmitter } = require('node:events');
  const { SessionManager } = require('../core/session-manager');
  const sessionManager = Object.create(SessionManager.prototype);
  sessionManager.sessions = new Map([['s', { info: { id:'s', kind:'codex', agentRuntime:'pty', status:'idle' } }]]);
  sessionManager.emit = () => {};
  const completedAt = Date.now();
  sessionManager.noteAgentTurnStarted('s', { startedAt:completedAt-100, turnId:'T' });
  const transcriptTap = new EventEmitter(), sent = [];
  const start = main.indexOf("transcriptTap.on('turn-error',");
  const end = main.indexOf("transcriptTap.on('prompt-submitted',", start);
  require('node:vm').runInNewContext(main.slice(start, end), {
    transcriptTap, sessionManager, completionNotifier:{noteTurnFailed(){}},
    sendToRenderer:(channel,payload)=>sent.push({channel,payload}), console,
  });
  transcriptTap.emit('turn-error', {
    hubSessionId:'s', completedAt, turnId:'T', message:'provider rejected',
    signalSource:'task_complete_error', occurrenceId:'failure-1',
  });
  const truth = sessionManager.getAllSessions()[0].runtimeTruth;
  assert.equal(truth.state, 'failed');
  assert.equal(truth.evidence, 'provider rejected');
  assert.equal(truth.completedAt, completedAt);
  assert.equal(sent[0].payload.failedAt, completedAt);
  assert.equal(sent[0].payload.occurrenceId, 'failure-1');
});

test('Codex task_complete.error has an end-to-end authoritative failure route', () => {
  assert.match(tap, /b\.on\('turn-error', \(ev\) => this\.emit\('turn-error', ev\)\)/,
    'TranscriptTap must forward backend turn errors');
  assert.match(main, /transcriptTap\.on\('turn-error',[\s\S]*?sendToRenderer\('turn-failed-event'/,
    'main must broadcast the authoritative error occurrence');
  assert.match(main, /occurrenceId: ev\.occurrenceId \|\| null/,
    'main must preserve redraw-proof occurrence identity');
  assert.match(renderer, /ipcRenderer\.on\('turn-failed-event',[\s\S]*?raiseStreamDisconnectFailure/,
    'renderer must consume the authoritative failure event');
  assert.match(renderer, /authoritative: true/,
    'rollout failure must outrank PTY text fallback');
});
