'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerWorkspaceIpc } = require('../main/ipc/workspace-handlers');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-project-registry-'));
function project(name) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.agents'));
  fs.writeFileSync(path.join(dir, '.agents/project.json'), JSON.stringify({ name: 'AI HUB', trunk: 'master' }));
  return dir;
}
const main = project('main'), clone = project('clone'), data = path.join(root, 'data');
fs.mkdirSync(data);
fs.writeFileSync(path.join(data, 'prepared-projects.json'), JSON.stringify({ schemaVersion: 1, projects: [
  { id: 'main', name: 'AI HUB', path: main, source: 'project-prep', registeredAt: 1 },
], migrations: [] }));
const handlers = new Map();
registerWorkspaceIpc({ handle: (name, fn) => handlers.set(name, fn) }, {
  workspaceService: { getRegistryPath: () => path.join(data, 'workspaces.json'), getWorkspaceRoot: () => root,
    listWorkspaces: () => ({ items: [{ path: main }, { path: clone }] }) },
  sessionManager: { getAllSessions: () => [{ cwd: clone }] }, meetingManager: { getAllMeetings: () => [] },
});
assert.deepEqual(handlers.get('workspace:prepared-projects')(null).items.map(p => p.path), [main],
  'Only formally registered roots may enter the shared IPC, even when a clone has copied project-prep files');
console.log('prepared registry IPC excludes unregistered clone: PASS');

const { PreparedProjectRegistry, prepared, hash } = require('../core/prepared-project-registry');
const cp = require('node:child_process');
const registry = new PreparedProjectRegistry({ dataDir: data });
assert.equal(registry.register(main).changed, false);
assert.equal(registry.register(main + path.sep).changed, false);
const alias = path.join(root, 'alias');
fs.symlinkSync(main, alias, process.platform === 'win32' ? 'junction' : 'dir');
assert.equal(registry.register(alias).changed, false, 'realpath aliases do not duplicate identity');
if (process.platform === 'win32') fs.rmdirSync(alias); else fs.unlinkSync(alias);
assert(fs.existsSync(main), 'removing alias preserves its target');
if (process.platform === 'win32') assert.equal(registry.register(main.toUpperCase()).changed, false);
const linked = path.join(root, 'linked'); fs.mkdirSync(linked); fs.writeFileSync(path.join(linked, '.git'), 'gitdir: ../main/.git/worktrees/linked');
assert.throws(() => registry.register(linked), /project-prep/);
assert.throws(() => registry.register(root), /project-prep/);
assert.throws(() => registry.register('relative'), /绝对路径/);
assert.deepEqual(registry.list().items.map(i => i.path), [main]);
const plan = { schemaVersion: 1, id: 'migration-test', entries: [
  { ...prepared(clone), decision: 'retain', reason: 'Explicitly prepared second project; identical name is legal' },
  { path: linked, decision: 'exclude', reason: 'Linked worktree belongs to main' },
  { path: root, decision: 'pending', reason: 'Unconfirmed' },
] };
assert.equal(registry.preview(plan).length, 3);
assert.equal(registry.read().projects.length, 1, 'preview does not write');
const migrated = registry.migrate(plan);
assert.equal(registry.read().projects.length, 2);
assert(migrated.backup && fs.existsSync(migrated.backup));
assert.equal(registry.migrate(plan).changed, false);
assert.throws(() => registry.migrate({ ...plan, entries: [] }), /内容已变化/);
const digest = hash(fs.readFileSync(registry.file));
assert.throws(() => registry.restore(migrated.backup, 'wrong'), /后续变化/);
registry.restore(migrated.backup, digest);
assert.deepEqual(registry.list().items.map(p => p.path), [main]);
const previousDataDir = process.env.CLAUDE_HUB_DATA_DIR;
try {
  process.env.CLAUDE_HUB_DATA_DIR = data;
  const locator = require('../core/prepared-project-registry').projectLocator({ serialWorkflow: { workRoot: true, projectLocator: 'STALE_CLONE' } });
  assert(locator.includes(main) && !locator.includes(clone) && !locator.includes('STALE_CLONE'));
  assert.match(locator, /唯一命中就直接使用/);
} finally {
  if (previousDataDir === undefined) delete process.env.CLAUDE_HUB_DATA_DIR;
  else process.env.CLAUDE_HUB_DATA_DIR = previousDataDir;
}
const configPath = path.join(clone, '.agents/project.json');
fs.appendFileSync(configPath, '\n');
assert.throws(() => registry.preview(plan), /配置已变化/);
const good = fs.readFileSync(registry.file);
fs.writeFileSync(registry.file, '{broken');
assert.throws(() => registry.list(), /读取失败/);
assert.throws(() => registry.register(main), /读取失败/);
assert.equal(fs.readFileSync(registry.file, 'utf8'), '{broken', 'bad registry must not be replaced');
fs.writeFileSync(registry.file, good);
const cfg = fs.readFileSync(path.join(main, '.agents/project.json'));
fs.writeFileSync(path.join(main, '.agents/project.json'), '{}');
assert.throws(() => registry.list(), /name/);
fs.writeFileSync(path.join(main, '.agents/project.json'), cfg);
assert.throws(() => new PreparedProjectRegistry({ dataDir: path.join(root, 'absent') }).list(), /尚未登记/);

// Actual independent CLI processes must serialize read-modify-write.
async function concurrent() {
  const dirs = Array.from({ length: 6 }, (_, i) => project('parallel-' + i));
  const cli = path.resolve(__dirname, '../scripts/prepared-projects.js');
  await Promise.all(dirs.map(dir => new Promise((resolve, reject) => {
    cp.execFile(process.execPath, [cli, 'register', dir, '--data-dir', data], { windowsHide: true },
      (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(JSON.parse(stdout)));
  })));
  assert.equal(registry.read().projects.length, 7);
  const result = cp.spawnSync(process.execPath, [cli, 'register', root, '--data-dir', data], { encoding: 'utf8', windowsHide: true });
  assert.notEqual(result.status, 0, 'CLI validation failures propagate');
  const lockPath = registry.file + '.lock';
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid }));
  try { assert.throws(() => registry.register(clone), /正忙|不可写/); }
  finally { fs.unlinkSync(lockPath); }
  console.log('registry validation, aliases, migration, rollback CAS, corruption, CLI and concurrency: PASS');
}
concurrent().catch(error => { console.error(error); process.exitCode = 1; });
