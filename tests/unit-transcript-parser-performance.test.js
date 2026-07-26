'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { parseClaudeTranscriptToTurns } = require('../core/claude-transcript-parser.js');

function createLargeSparseTurnTranscript() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-read-bound-'));
  const filePath = path.join(dir, 'large.jsonl');
  const payload = 'x'.repeat(480 * 1024);
  const rows = [];
  for (let i = 0; i < 19; i += 1) {
    rows.push(JSON.stringify({
      type: 'user', uuid: `u-${i}`, timestamp: new Date(1700000000000 + i * 2000).toISOString(),
      message: { content: `prompt-${i}-${payload}` },
    }));
    rows.push(JSON.stringify({
      type: 'assistant', uuid: `a-${i}`, timestamp: new Date(1700000001000 + i * 2000).toISOString(),
      message: { stop_reason: 'end_turn', content: [{ type: 'text', text: `answer-${i}-${payload}` }] },
    }));
  }
  fs.writeFileSync(filePath, `${rows.join('\n')}\n`);
  return filePath;
}

test('strict tail history performs one bounded probe then one full read', () => {
  const filePath = createLargeSparseTurnTranscript();
  assert.ok(fs.statSync(filePath).size > 16 * 1024 * 1024);

  const originalReadSync = fs.readSync;
  const originalReadFileSync = fs.readFileSync;
  let tailReads = 0;
  let fullReads = 0;
  fs.readSync = function patchedReadSync(...args) {
    tailReads += 1;
    return originalReadSync.apply(this, args);
  };
  fs.readFileSync = function patchedReadFileSync(...args) {
    fullReads += 1;
    return originalReadFileSync.apply(this, args);
  };

  try {
    const turns = parseClaudeTranscriptToTurns(filePath, { limit: 50, fromTail: true });
    assert.equal(turns.length, 38);
    assert.equal(tailReads, 1, 'must not expand through overlapping tail windows');
    assert.equal(fullReads, 1, 'strict completeness needs only one full read');
  } finally {
    fs.readSync = originalReadSync;
    fs.readFileSync = originalReadFileSync;
  }
});
