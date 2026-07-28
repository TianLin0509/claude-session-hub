'use strict';
// A `claude` process started *inside* a Hub session inherits CLAUDE_HUB_SESSION_ID,
// so its Stop hook reports the child's session_id/transcript_path under the parent's
// Hub id. Without a cwd check the Hub rebinds the parent card to the child's
// transcript; once that scratch directory is cleaned up the card view dies with
// "加载历史失败：ENOENT". Observed live on 2026-07-27.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MAIN_SRC = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const { normalizeKey } = require('../core/workspace-service.js');

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

// Mirrors the guard clause so the decision logic itself is exercised.
function shouldRebind(reportedCwd, sessionCwd) {
  if (reportedCwd && sessionCwd && normalizeKey(reportedCwd) !== normalizeKey(sessionCwd)) return false;
  return true;
}

console.log('Running nested-CLI transcript rebind guard tests...');

test('a nested CLI running in a subdirectory cannot steal the binding', () => {
  const sessionCwd = 'C:\\Vibe\\_scratch\\inbox-20260727-004157-5d6346';
  const nestedCwd = `${sessionCwd}\\scratchpad\\tok-probe`;
  assert.strictEqual(shouldRebind(nestedCwd, sessionCwd), false);
});

test('an unrelated directory is rejected too', () => {
  assert.strictEqual(shouldRebind('C:\\Vibe\\AI\\other', 'C:\\Vibe\\_scratch\\inbox-abc'), false);
});

test('the session own hook still rebinds, including after an archive move', () => {
  const cwd = 'C:\\Vibe\\_scratch\\inbox-abc';
  assert.strictEqual(shouldRebind(cwd, cwd), true);
  assert.strictEqual(shouldRebind('c:/vibe/_scratch/inbox-abc/', cwd), true, 'case/separator must not matter');
  // Post-archive the session cwd is updated first, so the next hook matches.
  assert.strictEqual(shouldRebind('C:\\Vibe\\AI\\my-task', 'C:\\Vibe\\AI\\my-task'), true);
});

test('a hook payload without cwd is still accepted (older hook scripts)', () => {
  assert.strictEqual(shouldRebind(undefined, 'C:\\Vibe\\AI\\my-task'), true);
  assert.strictEqual(shouldRebind('', 'C:\\Vibe\\AI\\my-task'), true);
});

test('main.js wires the guard and forwards the hook cwd', () => {
  assert.match(
    MAIN_SRC,
    /if \(fields\.cwd && current\.cwd && normalizeWorkspaceKey\(fields\.cwd\) !== normalizeWorkspaceKey\(current\.cwd\)\)/,
    'updateSessionTranscriptBinding must compare the reported cwd',
  );
  assert.match(
    MAIN_SRC,
    /updateSessionTranscriptBinding\(parsed\.sessionId, \{\s*\n\s*ccSessionId: parsed\.claudeSessionId,\s*\n\s*transcriptPath: parsed\.transcriptPath,\s*\n\s*cwd: parsed\.cwd,/,
    'the hook handler must forward cwd or the guard is dead code',
  );
  assert.match(
    MAIN_SRC,
    /normalizeKey: normalizeWorkspaceKey \} = require\('\.\/core\/workspace-service\.js'\)/,
    'normalizeWorkspaceKey must be imported',
  );
});

if (!process.exitCode) console.log('All nested-CLI transcript rebind guard tests passed.');
