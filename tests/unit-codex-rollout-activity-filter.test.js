'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  MAX_CARD_ACTIVITY_LINE_BYTES,
  codexLineFilter,
  streamCodexJsonlRecordsSync,
} = require('../core/codex-rollout-reader.js');

function commandRecord(stdout) {
  return {
    timestamp: '2026-09-03T10:00:01.000Z',
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      turn_id: 'turn-1',
      item: {
        type: 'CommandExecution',
        id: 'command-1',
        command: ['powershell.exe', '-Command', 'npm test'],
        status: 'completed',
        stdout,
        exit_code: 0,
      },
    },
  };
}

test('card activity records are retained only while one JSONL row stays bounded', (t) => {
  const small = JSON.stringify(commandRecord('12 tests passed'));
  assert.equal(codexLineFilter(small, { final: true, lineBytes: small.length }, 'turns'), true);
  assert.equal(codexLineFilter(small.slice(0, 200), {
    final: false,
    lineBytes: MAX_CARD_ACTIVITY_LINE_BYTES + 1,
    prefixBytes: MAX_CARD_ACTIVITY_LINE_BYTES,
    maxPrefixBytes: MAX_CARD_ACTIVITY_LINE_BYTES,
  }, 'turns'), false);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-codex-activity-filter-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'rollout.jsonl');
  fs.writeFileSync(file, [
    small,
    JSON.stringify(commandRecord('x'.repeat(MAX_CARD_ACTIVITY_LINE_BYTES + 4096))),
  ].join('\n') + '\n', 'utf8');
  const records = [];
  const stats = streamCodexJsonlRecordsSync(file, obj => records.push(obj), {
    profile: 'turns',
    maxPrefixBytes: MAX_CARD_ACTIVITY_LINE_BYTES,
  });
  assert.equal(records.length, 1);
  assert.equal(stats.skippedRecords, 1);
  assert.ok(stats.maxBufferedLineBytes <= MAX_CARD_ACTIVITY_LINE_BYTES);
});
