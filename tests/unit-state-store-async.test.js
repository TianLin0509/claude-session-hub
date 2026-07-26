'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('debounced state save uses the async queue and flushes deterministically', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-state-async-'));
  process.env.CLAUDE_HUB_DATA_DIR = dir;
  const modulePath = require.resolve('../core/state-store.js');
  delete require.cache[modulePath];
  const stateStore = require(modulePath);
  stateStore.save({
    version: 1,
    cleanShutdown: false,
    sessions: [{ hubId: 'async-1', title: 'Async', updatedAt: Date.now() }],
    meetings: [],
    immersiveByMeeting: {},
  });
  await stateStore.flushPending();
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(raw.sessions[0].hubId, 'async-1');
});
