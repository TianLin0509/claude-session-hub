'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { TranscriptParserService } = require('../core/transcript-parser-service.js');

function createTranscript() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-worker-'));
  const filePath = path.join(dir, 'large.jsonl');
  const payload = 'y'.repeat(160 * 1024);
  const rows = [];
  for (let i = 0; i < 40; i += 1) {
    rows.push(JSON.stringify({
      type: 'user', uuid: `u-${i}`, timestamp: new Date(1700000000000 + i * 2000).toISOString(),
      message: { content: `prompt-${i}` },
    }));
    rows.push(JSON.stringify({
      type: 'assistant', uuid: `a-${i}`, timestamp: new Date(1700000001000 + i * 2000).toISOString(),
      message: { stop_reason: 'end_turn', content: [{ type: 'text', text: `answer-${i}-${payload}` }] },
    }));
  }
  fs.writeFileSync(filePath, `${rows.join('\n')}\n`);
  return filePath;
}

test('worker service keeps parsing off the caller thread, coalesces, and caches', async (t) => {
  const filePath = createTranscript();
  const service = new TranscriptParserService();
  t.after(() => service.close());

  let eventLoopTicks = 0;
  const timer = setInterval(() => { eventLoopTicks += 1; }, 2);
  const first = service.parse('claude', filePath, { limit: 50, fromTail: true });
  const duplicate = service.parse('claude', filePath, { limit: 50, fromTail: true });
  const [a, b] = await Promise.all([first, duplicate]);
  clearInterval(timer);

  assert.equal(a.turns.length, 50);
  assert.deepEqual(b.turns, a.turns);
  assert.ok(a.meta.workerThreadId > 0, `unexpected worker thread id: ${a.meta.workerThreadId}`);
  assert.ok(eventLoopTicks > 0, 'caller event loop should continue while the worker parses');
  assert.equal(service.getStats().submitted, 1);
  assert.equal(service.getStats().coalesced, 1);

  const cached = await service.parse('claude', filePath, { limit: 50, fromTail: true });
  assert.equal(cached.meta.cacheHit, true);
  assert.equal(service.getStats().cacheHits, 1);
});
