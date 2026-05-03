const assert = require('assert');
const fs = require('fs'); const path = require('path'); const os = require('os'); const cp = require('child_process');
const { getPanelData } = require('../core/worktree/index');
const { _resetCacheForTest } = require('../core/worktree/git-probe');

function mkRepo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-'));
  cp.execSync('git init -q -b main', { cwd: d });
  cp.execSync('git config user.email t@t && git config user.name t', { cwd: d, shell: true });
  fs.writeFileSync(path.join(d, 'x.txt'), '1');
  cp.execSync('git add . && git commit -q -m init', { cwd: d, shell: true });
  return d;
}

(async () => {
  _resetCacheForTest();
  const dir = mkRepo();
  const r = await getPanelData({
    activeSessionId: 'S1',
    allSessions: [{ sessionId: 'S1', cwd: dir, sessionLabel: 'test' }],
    force: true,
  });
  assert.strictEqual(r.active.isRepo, true);
  assert.strictEqual(r.peers.length, 0);
  assert.strictEqual(r.conflict.color, 'green');
  console.log('  ✓ orchestrator smoke');
  process.exit(0);
})();
