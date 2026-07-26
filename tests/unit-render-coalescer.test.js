'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRenderCoalescer } = require('../renderer/render-coalescer');

test('coalesces a burst into one render and supports deterministic flush', async () => {
  let rendered = 0;
  const coalescer = createRenderCoalescer(() => { rendered += 1; }, { delayMs: 20 });
  for (let i = 0; i < 50; i += 1) coalescer.schedule();
  assert.deepEqual(coalescer.stats(), { requests: 50, renders: 0, pending: true, delayMs: 20 });
  assert.equal(coalescer.flush(), true);
  assert.equal(rendered, 1);
  assert.deepEqual(coalescer.stats(), { requests: 50, renders: 1, pending: false, delayMs: 20 });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(rendered, 1, 'flushed timer must not fire again');
});

test('allows a later burst to schedule a later render', async () => {
  let rendered = 0;
  const coalescer = createRenderCoalescer(() => { rendered += 1; }, { delayMs: 5 });
  coalescer.schedule();
  coalescer.schedule();
  await new Promise(resolve => setTimeout(resolve, 15));
  coalescer.schedule();
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(rendered, 2);
  assert.equal(coalescer.stats().requests, 3);
});
