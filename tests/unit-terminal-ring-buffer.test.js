'use strict';
// Chunked terminal tail buffer (2026-10-11): same contents as the old
// "concatenate then slice(-limit)" string buffer, without copying the whole
// buffer on every PTY chunk.

const assert = require('node:assert');
const { TerminalRingBuffer } = require('../core/terminal-ring-buffer.js');
const { SessionManager } = require('../core/session-manager.js');

function test(name, fn) {
  try { fn(); console.log(`  OK ${name}`); }
  catch (err) { console.error(`  FAIL ${name}`); console.error(err.stack || err.message); process.exitCode = 1; }
}

// The pre-2026-10-11 implementation, verbatim, as the oracle.
function legacyAppend(rb, data, ringLimit) {
  rb = (rb || '') + data;
  if (rb.length > ringLimit) {
    rb = rb.slice(rb.length - ringLimit);
    let i = 0;
    while (i < rb.length && i < 4) {
      const cc = rb.charCodeAt(i);
      if (cc >= 0xDC00 && cc <= 0xDFFF) { i++; continue; }
      if (cc >= 0xD800 && cc <= 0xDBFF) {
        const next = rb.charCodeAt(i + 1);
        if (!(next >= 0xDC00 && next <= 0xDFFF)) { i++; continue; }
      }
      break;
    }
    if (i > 0) rb = rb.slice(i);
  }
  return rb;
}

function seededRandom(seed) {
  let x = seed >>> 0;
  return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; };
}

const ALPHABET = ['a', 'b', '\x1b[0m', '\r\n', '中', '😀', '\uD83D', '\uDE00', '\uDC00', 'xyz'];

test('matches the legacy buffer for random chunk streams, limits and reads', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const rnd = seededRandom(seed);
    const limit = 1 + Math.floor(rnd() * 64);
    const ring = new TerminalRingBuffer('');
    let legacy = '';
    for (let step = 0; step < 200; step++) {
      let chunk = '';
      const parts = Math.floor(rnd() * 6);
      for (let p = 0; p < parts; p++) chunk += ALPHABET[Math.floor(rnd() * ALPHABET.length)];
      legacy = legacyAppend(legacy, chunk, limit);
      ring.append(chunk, limit);
      assert.strictEqual(ring.length, legacy.length, `length seed=${seed} step=${step}`);
      // Read at random points: reading must not change later behaviour.
      if (rnd() < 0.3) assert.strictEqual(ring.toString(), legacy, `content seed=${seed} step=${step}`);
    }
    assert.strictEqual(ring.toString(), legacy, `final content seed=${seed}`);
  }
});

test('handles chunks larger than the limit and a shrinking limit', () => {
  const ring = new TerminalRingBuffer('seed');
  let legacy = 'seed';
  for (const [chunk, limit] of [['0123456789', 4], ['', 2], ['ab', 8], ['x'.repeat(50), 8], ['', 3]]) {
    ring.append(chunk, limit);
    legacy = legacyAppend(legacy, chunk, limit);
    assert.strictEqual(ring.toString(), legacy);
  }
});

test('many small appends past the limit keep exactly the tail without growing', () => {
  const ring = new TerminalRingBuffer('');
  let all = '';
  for (let i = 0; i < 20000; i++) { const c = `<${i}>`; ring.append(c, 1000); all += c; }
  assert.strictEqual(ring.toString(), all.slice(-1000));
  assert.ok(ring._chunks.length - ring._head < 1100, 'consumed chunks must be released');
});

test('SessionManager keeps ringBuffer a plain string for readers and assignment', () => {
  const mgr = Object.create(SessionManager.prototype);
  mgr.sessions = new Map();
  const entry = { ringBuffer: 'start:', ringBufferLimit: 12 };
  mgr.sessions.set('s', entry);
  mgr._appendToRingBuffer('s', 'abc');
  assert.strictEqual(entry.ringBuffer, 'start:abc');
  assert.strictEqual(mgr.getSessionBuffer('s'), 'start:abc');
  mgr._appendToRingBuffer('s', 'defghij');
  assert.strictEqual(entry.ringBuffer, legacyAppend('start:abc', 'defghij', 12));
  assert.strictEqual(entry.outputChars, 10);
  assert.strictEqual(mgr.getSessionOutputSince('s', 3), 'abcdefghij'.slice(-7));
  assert.strictEqual({ ...entry }.ringBuffer, entry.ringBuffer, 'spread copies the string');
  entry.ringBuffer = 'reset';
  mgr._appendToRingBuffer('s', '!');
  assert.strictEqual(entry.ringBuffer, 'reset!');
});
