'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Import-time and disk-roundtrip state stay outside the user's Hub library.
const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-meta-identity-transaction-'));
process.env.CLAUDE_HUB_DATA_DIR = path.join(isolated, 'data');
process.env.CLAUDE_HUB_HOME_DIR = path.join(isolated, 'home');
const { SessionManager } = require('../core/session-manager');
const { SessionOpenOwnership, nativeKeys } = require('../core/session-open-ownership');
const store = require('../core/session-store');

const PARENT = '11111111-1111-4111-8111-111111111111';
const CHILD = '22222222-2222-4222-8222-222222222222';
const NEXT = '33333333-3333-4333-8333-333333333333';
function harness(t) {
  const directory = fs.mkdtempSync(path.join(isolated, 'owners-'));
  const owners = new SessionOpenOwnership({ directory, isAlive: pid => pid === process.pid });
  const manager = new SessionManager(); manager.openOwners = owners;
  const env = { CLAUDE_CONFIG_DIR: path.join(directory, 'native') };
  t.after(() => { for (const lease of manager.openLeases?.values() || []) owners.release(lease); owners.close(); });
  const create = (id, nativeId, forkSource) => {
    manager.reserveSessionOpen(id);
    manager._claimNativeOpenIdentity(id, 'codeagent', { resumeCCSessionId: nativeId, forkCCSessionId: forkSource }, env);
    const info = { id, kind: 'codeagent', title: 'unchanged', agentRuntime: 'pty',
      codeagentIdentityPending: !nativeId, ...(nativeId ? { ccSessionId: nativeId } : {}) };
    manager.sessions.set(id, { info, pty: { pid: process.pid } });
    manager._refreshOpenIdentity(id);
    return info;
  };
  const ownerOf = nativeId => owners.db.prepare('SELECT session FROM open_owners WHERE key=?')
    .get(nativeKeys('codeagent', { resumeCCSessionId: nativeId }, env)[0])?.session;
  return { owners, manager, env, create, ownerOf };
}

test('native identity conflict leaves every metadata field and original object unchanged, with no update event', t => {
  const h = harness(t);
  h.create('parent', PARENT);
  const info = h.create('conflict-card', CHILD);
  const before = { ...info }, events = [];
  h.manager.on('session-updated', event => events.push(event));
  assert.throws(() => h.manager.updateSessionMeta('conflict-card', {
    ccSessionId: PARENT, codeagentIdentityPending: false, title: 'must-not-commit', transcriptPath: 'not-committed.jsonl',
  }), error => error.code === 'SESSION_OCCUPIED' && error.owner.session === 'parent');
  assert.equal(h.manager.sessions.get('conflict-card').info, info, 'PTY callbacks retain the original metadata object');
  assert.deepEqual(info, before);
  assert.deepEqual(events, []);
  assert.equal(h.ownerOf(PARENT), 'parent');
  assert.equal(h.ownerOf(CHILD), 'conflict-card', 'existing writer lease is never released on failed mutation');
  store.saveSessionFile('conflict-card', info);
  assert.equal(store.loadSessionFile('conflict-card').ccSessionId, CHILD, 'later persistence cannot save the rejected identity');
});

test('ownership storage error is propagated by identity, and pending/native metadata stays recoverable', t => {
  const h = harness(t), info = h.create('pending-card');
  const before = { ...info }, error = Object.assign(new Error('controlled ownership I/O failure'), { code: 'EIO' });
  const originalAdd = h.owners.add;
  h.owners.add = () => { throw error; };
  let events = 0; h.manager.on('session-updated', () => events++);
  try {
    assert.throws(() => h.manager.updateSessionMeta('pending-card', {
      ccSessionId: CHILD, codeagentIdentityPending: false, transcriptPath: 'child.jsonl',
    }), caught => caught === error);
  } finally { h.owners.add = originalAdd; }
  assert.equal(h.manager.sessions.get('pending-card').info, info);
  assert.deepEqual(info, before);
  assert.equal(events, 0);
  assert.equal(h.owners.owner('pending-card').session, 'pending-card');
  assert.equal(h.ownerOf(CHILD), undefined);
});

test('successful identity update owns the new alias before publishing and preserves existing writer aliases', t => {
  const h = harness(t), info = h.create('successful-card', CHILD);
  let published;
  h.manager.once('session-updated', event => {
    assert.equal(h.ownerOf(NEXT), 'successful-card', 'no event is published before the new lease is acquired');
    assert.equal(h.manager.sessions.get('successful-card').info, info);
    published = event;
  });
  const result = h.manager.updateSessionMeta('successful-card', { ccSessionId: NEXT, title: 'committed' });
  assert.equal(info.ccSessionId, NEXT); assert.equal(info.title, 'committed');
  assert.equal(result.ccSessionId, NEXT); assert.equal(published.ccSessionId, NEXT);
  assert.equal(h.ownerOf(CHILD), 'successful-card', 'old native writer may still be alive until process exit');
  assert.equal(h.ownerOf(NEXT), 'successful-card');
  assert.throws(() => h.owners.claim('duplicate-next', nativeKeys('codeagent', { resumeCCSessionId: NEXT }, h.env)),
    error => error.code === 'SESSION_OCCUPIED');
  store.saveSessionFile('successful-card', info);
  const saved = store.loadSessionFile('successful-card');
  assert.equal(saved.ccSessionId, NEXT); assert.equal(saved.title, 'committed');
});

test('correct child identity binds beside its parent while the real parent alias remains exclusive', t => {
  const h = harness(t);
  h.create('parent', PARENT);
  const branch = h.create('branch', undefined, PARENT);
  const result = h.manager.updateSessionMeta('branch', { ccSessionId: CHILD, codeagentIdentityPending: false });
  assert.equal(result.ccSessionId, CHILD); assert.equal(branch.codeagentIdentityPending, false);
  assert.equal(h.ownerOf(PARENT), 'parent'); assert.equal(h.ownerOf(CHILD), 'branch');
  assert.throws(() => h.owners.claim('duplicate-parent', nativeKeys('codeagent', { resumeCCSessionId: PARENT }, h.env)),
    error => error.code === 'SESSION_OCCUPIED');
});

test('public CodeAgent metadata keeps the original fork parent snapshot, with no field for an ordinary session', () => {
  const manager = new SessionManager();
  const branch = { id: 'branch', kind: 'codeagent', ccSessionId: CHILD, codeagentForkSourceSessionId: PARENT };
  assert.equal(manager._toPublic(branch).codeagentForkSourceSessionId, PARENT);
  for (const value of [undefined, null, '']) {
    const plain = manager._toPublic({ id: 'plain', kind: 'codeagent', codeagentForkSourceSessionId: value });
    assert.equal(Object.hasOwn(plain, 'codeagentForkSourceSessionId'), false);
  }
});

test('renderer persistence with a missing fork snapshot cannot erase the live authoritative source on disk', () => {
  const { handlePersistSessions } = require('../main/ipc/persistence-handlers');
  const id = 'fork-persist-roundtrip';
  const live = { id, kind: 'codeagent', ccSessionId: CHILD, codeagentForkSourceSessionId: PARENT, codeagentModelPick: false };
  let previous = [{ ...live, hubId: id, title: 'before', updatedAt: 1 }];
  store.saveSessionFile(id, previous[0]);
  const rendererCopy = { hubId: id, kind: 'codeagent', ccSessionId: CHILD, title: 'after', updatedAt: 1 };
  handlePersistSessions([rendererCopy], [], {
    getImmersiveByMeeting: () => ({}),
    getLastPersistedMeetingIds: () => new Set(), getLastPersistedMeetings: () => [],
    getLastPersistedSessionIds: () => new Set([id]), getLastPersistedSessions: () => previous,
    setLastPersistedMeetingIds() {}, setLastPersistedMeetings() {}, setLastPersistedSessionIds() {},
    setLastPersistedSessions: value => { previous = value; },
    meetingManager: { getAllMeetings: () => [], getMeetingMemberships: () => [], getMeeting: () => null },
    meetingStore: {}, sessionStore: store, stateStore: { save() {} },
    getLiveSession: () => live, sessionManager: { getSession: () => live },
  });
  store.flushAll();
  const disk = store.loadSessionFile(id, { strict: true });
  assert.equal(disk.title, 'after', 'the real persistence update ran');
  assert.equal(disk.codeagentForkSourceSessionId, PARENT);
  assert.equal(previous[0].codeagentForkSourceSessionId, PARENT);
  assert.equal(live.ccSessionId, CHILD);
});
