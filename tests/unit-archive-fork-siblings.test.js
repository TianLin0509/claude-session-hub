'use strict';
// A fork (AI Hub 分支) inherits the source session's cwd. Archiving used to close
// only the session the prompt was raised for, leaving the sibling's PTY holding
// the directory — the rename then fails with EBUSY on Windows, or succeeds and
// strands the sibling on a path that no longer exists.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const HANDLER_SRC = fs.readFileSync(path.join(__dirname, '..', 'main', 'ipc', 'workspace-handlers.js'), 'utf8');
const SESSION_IPC_SRC = fs.readFileSync(path.join(__dirname, '..', 'main', 'ipc', 'session-handlers.js'), 'utf8');

function test(name, fn) {
  try {
    fn();
    console.log(`  OK ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

// Minimal stand-in for the handler's session lookup so the cwd grouping can be
// exercised without an Electron/PTY runtime.
function sessionsSharingCwd(allSessions, source, normalizeKey) {
  return allSessions.filter(session => session
    && !session.meetingId
    && session.cwd
    && normalizeKey(session.cwd) === normalizeKey(source));
}

const { normalizeKey } = require('../core/workspace-service.js');

console.log('Running archive fork-sibling tests...');

test('every session in the archived directory is collected, meeting members excluded', () => {
  const source = 'C:\\Vibe\\_scratch\\inbox-abc';
  const all = [
    { id: 'origin', cwd: source },
    { id: 'fork', cwd: source },
    { id: 'other', cwd: 'C:\\Vibe\\AI\\unrelated' },
    { id: 'member', cwd: source, meetingId: 'm1' },
    { id: 'noCwd' },
  ];
  const picked = sessionsSharingCwd(all, source, normalizeKey).map(s => s.id);
  assert.deepStrictEqual(picked, ['origin', 'fork']);
});

test('cwd matching is case/separator insensitive', () => {
  const all = [{ id: 'a', cwd: 'C:\\Vibe\\_scratch\\Inbox-ABC\\' }];
  const picked = sessionsSharingCwd(all, 'c:/vibe/_scratch/inbox-abc', normalizeKey).map(s => s.id);
  assert.deepStrictEqual(picked, ['a']);
});

test('archive handler groups by cwd instead of the single entity id', () => {
  assert.match(
    HANDLER_SRC,
    /normalizeKey\(session\.cwd\) === normalizeKey\(entity\.source\)/,
    'sessionsForEntity must select by directory for the session scope',
  );
  assert.doesNotMatch(
    HANDLER_SRC,
    /const ids = entity\.scope === 'meeting'\s*\n\s*\? expectedIds\.filter/,
    'the old single-id path must be gone',
  );
  assert.match(HANDLER_SRC, /const snapshots = sessionsForEntity\(entity\);/, 'snapshots drive the close/resume set');
  assert.match(HANDLER_SRC, /const ids = snapshots\.map\(session => session\.id\);/, 'ids must derive from snapshots');
});

test('the group-chat completeness guard stays scoped to meetings', () => {
  assert.match(
    HANDLER_SRC,
    /entity\.scope === 'meeting' && ids\.length !== \(entity\.meeting\.subSessions \|\| \[\]\)\.length/,
    'a fork sibling must not be mistaken for a missing group-chat member',
  );
});

test('fork inherits model and effort from its source', () => {
  assert.match(SESSION_IPC_SRC, /if \(source\.currentModel && source\.currentModel\.id\) opts\.model = source\.currentModel\.id;/);
  assert.match(SESSION_IPC_SRC, /if \(source\.effort\) opts\.effort = source\.effort;/, 'effort must survive branching');
});

test('fork puts the branch marker first and protects a meaningful inherited title', () => {
  // isClaude → isClaudeCli：DeepSeek 也走 claude CLI 的 fork，2026-07-27 接线后一并覆盖。
  assert.match(SESSION_IPC_SRC, /title: formatBranchSessionTitle\(sourceTitle\)/);
  assert.match(SESSION_IPC_SRC, /branchSourceSessionId: source\.id/);
  assert.match(SESSION_IPC_SRC, /autoTitleGenerated: !branchAutoTitlePending/,
    'only a meaningful parent title should lock the initial branch title');
});

if (!process.exitCode) console.log('All archive fork-sibling tests passed.');
