'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-recency-persistence-'));
process.env.CLAUDE_HUB_DATA_DIR = root;
const store = require('../core/session-store');
const state = require('../core/state-store');
const { latestActivityTime, preserveLatestInteraction } = require('../core/session-recency');
const old = Date.now() - 20 * 3600000, recent = old + 19 * 3600000;

test('closing with an old backend snapshot cannot erase a queued interrupted prompt', async () => {
  store.saveSessionFile('queued', { kind: 'claude', lastMessageTime: old });
  store.markDirty('queued', { kind: 'claude', lastMessageTime: recent, lastRunStartedAt: recent });
  await store.flushSessionForRelease('queued', { kind: 'claude', lastMessageTime: old, runStartedAt: null });
  const disk = store.loadSessionFile('queued');
  assert.equal(disk.lastMessageTime, recent);
  assert.equal(disk.runStartedAt, null);
});
test('older metadata writes preserve interaction time in both sync and async paths', async () => {
  store.saveSessionFile('saved', { lastMessageTime: recent });
  store.markDirtySync('saved', { title: 'new title', lastMessageTime: old });
  assert.equal(store.loadSessionFile('saved').lastMessageTime, recent);
  await store.markDirtyImmediate('saved', { title: 'newer title', lastMessageTime: old });
  assert.equal(store.loadSessionFile('saved').lastMessageTime, recent);
  assert.equal(store.loadSessionFile('saved').title, 'newer title');
});
test('next owner rereads the latest disk interaction clock', () => {
  store.saveSessionFile('owner', { lastMessageTime: old });
  const file = path.join(root, 'sessions', 'owner.json');
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...disk, lastMessageTime: recent }));
  store.resumeSessionWrites('owner');
  store.markDirtySync('owner', { title: 'resumed', lastMessageTime: old });
  assert.equal(store.loadSessionFile('owner').lastMessageTime, recent);
});
test('metadata LWW and latest interaction merge independently in either order', () => {
  const a = { hubId: 'merge', title: 'latest title', updatedAt: recent + 100, lastMessageTime: old, runStartedAt: null };
  const b = { hubId: 'merge', title: 'old title', updatedAt: recent, lastMessageTime: recent, runStartedAt: recent };
  for (const [disk, mem] of [[a, b], [b, a]]) {
    const s = state.mergeState({ sessions: [disk] }, { sessions: [mem] }).sessions[0];
    assert.equal(s.title, 'latest title');
    assert.equal(s.lastMessageTime, recent);
    assert.equal(s.runStartedAt, null);
  }
});
test('boot repairs previously stale snapshots from the surviving state.json clock', () => {
  fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify({ version: 1, cleanShutdown: true,
    sessions: [{ hubId: 'boot', lastMessageTime: recent, updatedAt: recent }], meetings: [] }));
  store.saveSessionFile('boot', { lastMessageTime: old, updatedAt: recent + 100 });
  const loaded = state.loadAndSelfHeal({ sessionStore: store });
  assert.equal(loaded.sessions.find(s => s.hubId === 'boot').lastMessageTime, recent);
});
test('opening, changing metadata and terminal redraw do not pretend to be interaction', () => {
  const result = preserveLatestInteraction({ lastMessageTime: old, updatedAt: Date.now(), lastOutputAt: Date.now() });
  assert.equal(latestActivityTime(result), old);
  assert.equal(preserveLatestInteraction({ lastMessageTime: old, runStartedAt: null }, { lastRunStartedAt: recent }).lastMessageTime, recent);
});
