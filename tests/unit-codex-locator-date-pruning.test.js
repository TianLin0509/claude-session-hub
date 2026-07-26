'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  findCodexRolloutByCwd,
  findCodexRolloutBySid,
} = require('../core/codex-transcript-parser.js');

function dateDir(root, date) {
  return path.join(
    root,
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  );
}

function uuidV7At(ms, tail = '000000000001') {
  const prefix = Math.floor(ms).toString(16).padStart(12, '0').slice(-12);
  return `${prefix.slice(0, 8)}-${prefix.slice(8)}-7000-8000-${tail}`;
}

function writeRollout(dir, sid, cwd, at) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = at.toISOString().replace(/[:.]/g, '-').replace('Z', '').slice(0, 19);
  const file = path.join(dir, `rollout-${stamp}-${sid}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({
    timestamp: at.toISOString(),
    type: 'session_meta',
    payload: {
      id: sid,
      session_id: sid,
      cwd,
      originator: 'codex-tui',
      source: 'cli',
      thread_source: 'user',
    },
  })}\n`, 'utf8');
  fs.utimesSync(file, at, at);
  return file;
}

test('Codex locators prune structured roots to the relevant date directories', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-codex-date-prune-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'workspace');
  const now = new Date();
  const sid = uuidV7At(now.getTime());
  const currentDir = dateDir(root, now);
  const target = writeRollout(currentDir, sid, cwd, now);
  const oldDate = new Date(now.getTime() - 30 * 86400000);
  const oldDir = dateDir(root, oldDate);
  writeRollout(oldDir, uuidV7At(oldDate.getTime(), '000000000002'), cwd, oldDate);

  const originalReaddirSync = fs.readdirSync;
  const visited = [];
  fs.readdirSync = function trackedReaddirSync(dir, ...args) {
    visited.push(path.resolve(dir));
    return originalReaddirSync.call(this, dir, ...args);
  };
  t.after(() => { fs.readdirSync = originalReaddirSync; });

  assert.strictEqual(findCodexRolloutBySid(sid, root), target);
  assert.strictEqual(findCodexRolloutByCwd(cwd, root, { sinceMs: now.getTime() }), target);
  assert.ok(visited.includes(path.resolve(currentDir)), JSON.stringify(visited));
  assert.ok(!visited.includes(path.resolve(oldDir)), JSON.stringify(visited));
  assert.ok(!visited.includes(path.resolve(root)), JSON.stringify(visited));
});
