'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const tap = fs.readFileSync(path.join(root, 'core', 'transcript-tap.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');

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
