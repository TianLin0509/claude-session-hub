'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  isPathInsideRoot,
  listWorkspaceDirectory,
} = require('../core/file-manager-directory.js');
const { registerPathIpc } = require('../main/ipc/path-handlers.js');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-file-manager-'));
test.after(() => {
  const resolved = path.resolve(tempRoot);
  const tempBase = path.resolve(os.tmpdir()) + path.sep;
  if (resolved.startsWith(tempBase) && path.basename(resolved).startsWith('hub-file-manager-')) {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

test('workspace directory listing is root-scoped, complete and directory-first', async () => {
  fs.mkdirSync(path.join(tempRoot, 'folder-10'));
  fs.mkdirSync(path.join(tempRoot, 'folder-2'));
  fs.writeFileSync(path.join(tempRoot, 'zeta.zip'), 'zip');
  fs.writeFileSync(path.join(tempRoot, 'alpha.md'), '# alpha', 'utf8');
  fs.writeFileSync(path.join(tempRoot, '.hidden.json'), '{}', 'utf8');

  const result = await listWorkspaceDirectory({ root: tempRoot, directory: tempRoot });
  assert.equal(result.ok, true);
  assert.equal(result.total, 5);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.entries.map(entry => entry.name), [
    'folder-2', 'folder-10', '.hidden.json', 'alpha.md', 'zeta.zip',
  ]);
  assert.deepEqual(result.entries.slice(0, 2).map(entry => entry.type), ['directory', 'directory']);
  assert.equal(result.entries.find(entry => entry.name === '.hidden.json').hidden, true);
  assert.equal(result.entries.find(entry => entry.name === 'alpha.md').extension, '.md');
  assert.ok(result.entries.every(entry => path.isAbsolute(entry.path)));
});

test('directory listing reports truncation instead of silently claiming completeness', async () => {
  const result = await listWorkspaceDirectory({ root: tempRoot, directory: tempRoot, limit: 2 });
  assert.equal(result.ok, true);
  assert.equal(result.entries.length, 2);
  assert.equal(result.total, 5);
  assert.equal(result.truncated, true);
});

test('directory listing rejects paths outside the active workspace root', async () => {
  const outside = path.dirname(tempRoot);
  assert.equal(isPathInsideRoot(tempRoot, outside), false);
  const result = await listWorkspaceDirectory({ root: tempRoot, directory: outside });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'outside_root');
});

test('nested links and junctions are not recursively expanded', async () => {
  const linkedPath = path.join(tempRoot, 'linked-dir');
  const result = await listWorkspaceDirectory({ root: tempRoot, directory: linkedPath }, {
    async lstat() {
      return { isSymbolicLink: () => true, isDirectory: () => false };
    },
    async stat() {
      throw new Error('nested link must be rejected before stat follows it');
    },
    async readdir() {
      throw new Error('nested link must be rejected before readdir follows it');
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'link_not_browsable');
});

test('file manager IPC validates payload and delegates to the directory service', async () => {
  const handlers = new Map();
  const calls = [];
  registerPathIpc({ handle(channel, handler) { handlers.set(channel, handler); } }, {
    async listWorkspaceDirectory(payload) {
      calls.push(payload);
      return { ok: true, entries: [], total: 0, truncated: false };
    },
  });
  assert.ok(handlers.has('file-manager:list-directory'));
  const invalid = await handlers.get('file-manager:list-directory')(null, null);
  assert.equal(invalid.code, 'invalid_payload');
  const valid = await handlers.get('file-manager:list-directory')(null, {
    root: tempRoot,
    directory: tempRoot,
    limit: 123,
  });
  assert.equal(valid.ok, true);
  assert.deepEqual(calls, [{ root: tempRoot, directory: tempRoot, limit: 123 }]);
});
