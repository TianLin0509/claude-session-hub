'use strict';

const assert = require('node:assert/strict');
const { TerminalSnapshot, COMPACT_THRESHOLD_BYTES } = require('../core/terminal-snapshot.js');

(async () => {
  let frame = '\x1b[?25l\x1b[2J\x1b[H';
  for (let row = 1; row <= 40; row += 1) {
    frame += `\x1b[${row};1HROW-${row} ${'x'.repeat(170)}`;
  }
  frame += '\x1b[40;1HPROCESS-COMPACTION-FINAL\x1b[?25h';
  const payload = frame.repeat(Math.ceil((COMPACT_THRESHOLD_BYTES + 64 * 1024) / frame.length));
  assert.ok(Buffer.byteLength(payload, 'utf8') > COMPACT_THRESHOLD_BYTES);

  const snapshot = new TerminalSnapshot({ cols: 200, rows: 40, scrollback: 10000 });
  try {
    snapshot.write(payload, 42);
    const saved = await snapshot.snapshot();
    assert.equal(saved.seq, 42);
    assert.equal(saved.source, 'ordered-vt-fast-snapshot');
    assert.match(saved.text, /PROCESS-COMPACTION-FINAL/);
    assert.equal(saved.operations, null);
  } finally {
    snapshot.dispose();
  }
  console.log('unit-terminal-snapshot-compactor-process OK');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
