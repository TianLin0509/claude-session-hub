'use strict';
// 存储根（2026-10-07 C: → D:）：env 解析、去重、默认值，以及依赖它的落盘位置。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const storageRoots = require('../core/storage-roots.js');
const { writeLoopReport } = require('../core/loop-report-file.js');
const { createDesktopOrganizer } = require('../core/desktop-organizer.js');
const { moveEntry } = require('../core/cross-volume-move.js');

const key = value => path.resolve(value).toLowerCase();

test('workspaceRoot：env 优先并去空白，未设置时回落到调用方给的 fallback', () => {
  assert.equal(storageRoots.workspaceRoot({ env: { AI_HUB_WORKSPACE_ROOT: '  D:\\AIWork  ' } }), path.resolve('D:\\AIWork'));
  assert.equal(storageRoots.workspaceRoot({ env: { AI_HUB_WORKSPACE_ROOT: '   ' }, fallback: 'C:/AIWork' }), path.resolve('C:/AIWork'));
  assert.equal(storageRoots.workspaceRoot({ env: {}, fallback: 'C:/AIWork' }), path.resolve('C:/AIWork'));
  assert.equal(storageRoots.workspaceRoot({ env: {} }), null);
});

test('legacyWorkspaceRoots：按 path.delimiter 拆分、去空白、去重、排除当前根', () => {
  const env = {
    AI_HUB_WORKSPACE_ROOT: 'D:\\AIWork',
    AI_HUB_LEGACY_WORKSPACE_ROOTS: [' C:\\AIWork ', '', 'c:\\aiwork\\', 'D:\\AIWork', 'C:\\Vibe'].join(path.delimiter),
  };
  const roots = storageRoots.legacyWorkspaceRoots({ env });
  assert.deepEqual(roots.map(key), [key('C:\\AIWork'), key('C:\\Vibe')]);
  assert.deepEqual(storageRoots.legacyWorkspaceRoots({ env: {} }), []);
  // 显式传入 current 时以它为准
  assert.deepEqual(storageRoots.legacyWorkspaceRoots({ env, current: 'C:\\AIWork' }).map(key), [key('D:\\AIWork'), key('C:\\Vibe')]);
});

test('artifactsRoot：env 优先，默认 ~/AI-Artifacts', () => {
  const home = path.resolve('/fake-home');
  assert.equal(storageRoots.artifactsRoot({ env: { AI_HUB_ARTIFACTS_ROOT: ' D:\\AI-Artifacts ' }, home }), path.resolve('D:\\AI-Artifacts'));
  assert.equal(storageRoots.artifactsRoot({ env: {}, home }), path.join(home, 'AI-Artifacts'));
});

test('trustedFileRoots：数据目录、当前根、旧根、产物根与旧产物位置，去重', () => {
  const home = path.resolve('/fake-home');
  const roots = storageRoots.trustedFileRoots({
    dataDir: path.join(home, '.claude-session-hub'),
    home,
    env: {
      AI_HUB_WORKSPACE_ROOT: 'D:\\AIWork',
      AI_HUB_LEGACY_WORKSPACE_ROOTS: 'C:\\AIWork',
      AI_HUB_ARTIFACTS_ROOT: 'D:\\AI-Artifacts',
    },
  }).map(key);
  assert.deepEqual(roots, [
    key(path.join(home, '.claude-session-hub')),
    key('D:\\AIWork'),
    key('C:\\AIWork'),
    key('D:\\AI-Artifacts'),
    key(path.join(home, 'AI-Artifacts')),
    key(path.join(home, 'Desktop', 'claude-artifacts')),
  ]);
  // 未配置任何新 env：与旧硬编码集合一致（C:/AIWork + ~/AI-Artifacts + 桌面旧目录 + dataDir），且不重复
  const legacy = storageRoots.trustedFileRoots({ dataDir: path.join(home, 'data'), home, env: {} }).map(key);
  assert.deepEqual(legacy, [
    key(path.join(home, 'data')),
    key('C:/AIWork'),
    key(path.join(home, 'AI-Artifacts')),
    key(path.join(home, 'Desktop', 'claude-artifacts')),
  ]);
});

test('循环报告写到产物根，文件名带 YYYYMMDD 前缀，不落桌面', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-loop-report-'));
  const now = new Date(2026, 9, 7, 8, 9, 10);
  const file = writeLoopReport('<html>ok</html>', { root, now });
  assert.equal(path.dirname(file), root);
  assert.match(path.basename(file), /^20261007-loop-report-\d+\.html$/);
  assert.equal(fs.readFileSync(file, 'utf8'), '<html>ok</html>');
  // 默认根跟随 AI_HUB_ARTIFACTS_ROOT
  const saved = process.env.AI_HUB_ARTIFACTS_ROOT;
  process.env.AI_HUB_ARTIFACTS_ROOT = path.join(root, 'env-artifacts');
  try {
    const envFile = writeLoopReport('<html>env</html>');
    assert.equal(path.dirname(envFile), path.join(root, 'env-artifacts'));
    assert.ok(!/[\\/]Desktop[\\/]/i.test(envFile));
  } finally {
    if (saved === undefined) delete process.env.AI_HUB_ARTIFACTS_ROOT; else process.env.AI_HUB_ARTIFACTS_ROOT = saved;
  }
});

test('桌面整理默认归档目录在产物根下（不再写死 C:/VibeData）', () => {
  const home = path.resolve('/fake-home');
  const saved = process.env.AI_HUB_ARTIFACTS_ROOT;
  try {
    delete process.env.AI_HUB_ARTIFACTS_ROOT;
    const byHome = createDesktopOrganizer({ home });
    assert.equal(byHome.artifacts, path.join(home, 'AI-Artifacts'));
    assert.equal(byHome.archive, path.join(home, 'AI-Artifacts', 'Desktop-Archive'));
    process.env.AI_HUB_ARTIFACTS_ROOT = 'D:\\AI-Artifacts';
    const byEnv = createDesktopOrganizer({ home });
    assert.equal(byEnv.artifacts, path.resolve('D:\\AI-Artifacts'));
    assert.equal(byEnv.archive, path.join(path.resolve('D:\\AI-Artifacts'), 'Desktop-Archive'));
    const injected = createDesktopOrganizer({ home, artifactsRoot: path.resolve('/x/arts') });
    assert.equal(injected.archive, path.join(path.resolve('/x/arts'), 'Desktop-Archive'));
    // testRoot 行为不变
    const t = createDesktopOrganizer({ testRoot: path.resolve('/t') });
    assert.equal(t.archive, path.join(path.resolve('/t'), 'Desktop-Archive'));
    assert.equal(t.artifacts, path.join(path.resolve('/t'), 'AI-Artifacts'));
  } finally {
    if (saved === undefined) delete process.env.AI_HUB_ARTIFACTS_ROOT; else process.env.AI_HUB_ARTIFACTS_ROOT = saved;
  }
});

function exdev() {
  const error = new Error('EXDEV: cross-device link not permitted');
  error.code = 'EXDEV';
  return error;
}

test('跨盘（EXDEV）时桌面整理退为复制+删除，撤销同样可用', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hub-desktop-exdev-'));
  const desktop = path.join(root, 'Desktop');
  await fsp.mkdir(path.join(desktop, 'claude-artifacts'), { recursive: true });
  await fsp.writeFile(path.join(desktop, 'report.pptx'), 'original');
  await fsp.writeFile(path.join(desktop, 'claude-artifacts', 'old.html'), 'old');
  const origLink = fsp.link, origRename = fsp.rename;
  fsp.link = async () => { throw exdev(); };
  fsp.rename = async (a, b) => { if (await fsp.lstat(a).then(s => s.isDirectory())) throw exdev(); return origRename(a, b); };
  try {
    const service = createDesktopOrganizer({ testRoot: root });
    const plan = await service.scan();
    const result = await service.execute({ id: plan.id, keys: plan.items.map(row => row.key) });
    assert.equal(result.moved, 2, JSON.stringify(result.rows));
    const fileRow = result.rows.find(row => row.name === 'report.pptx');
    const dirRow = result.rows.find(row => row.name === 'claude-artifacts');
    assert.equal(await fsp.readFile(fileRow.target, 'utf8'), 'original');
    assert.equal(await fsp.readFile(path.join(dirRow.target, 'old.html'), 'utf8'), 'old');
    assert.ok(dirRow.target.startsWith(path.join(root, 'AI-Artifacts', '历史桌面产物')));
    assert.equal(fs.existsSync(path.join(desktop, 'report.pptx')), false);
    assert.equal(fs.existsSync(path.join(desktop, 'claude-artifacts')), false);
    const undo = await service.undo();
    assert.equal(undo.restored, 2);
    assert.equal(await fsp.readFile(path.join(desktop, 'report.pptx'), 'utf8'), 'original');
    assert.equal(await fsp.readFile(path.join(desktop, 'claude-artifacts', 'old.html'), 'utf8'), 'old');
  } finally {
    fsp.link = origLink; fsp.rename = origRename;
  }
});

test('跨盘移动：目标已存在不覆盖；目录内含链接时拒绝且原件保留', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hub-xvol-'));
  const origRename = fsp.rename;
  fsp.rename = async () => { throw exdev(); };
  try {
    await fsp.writeFile(path.join(root, 'a.txt'), 'A');
    await fsp.writeFile(path.join(root, 'b.txt'), 'B');
    await assert.rejects(moveEntry(path.join(root, 'a.txt'), path.join(root, 'b.txt')), /EEXIST/);
    assert.equal(await fsp.readFile(path.join(root, 'a.txt'), 'utf8'), 'A');
    await moveEntry(path.join(root, 'a.txt'), path.join(root, 'c.txt'));
    assert.equal(await fsp.readFile(path.join(root, 'c.txt'), 'utf8'), 'A');
    assert.equal(fs.existsSync(path.join(root, 'a.txt')), false);

    const src = path.join(root, 'dir');
    await fsp.mkdir(path.join(src, 'inner'), { recursive: true });
    await fsp.writeFile(path.join(src, 'inner', 'x.txt'), 'X');
    const linkTarget = path.join(root, 'elsewhere');
    await fsp.mkdir(linkTarget);
    await fsp.symlink(linkTarget, path.join(src, 'inner', 'jl'), 'junction');
    await assert.rejects(moveEntry(src, path.join(root, 'moved')), /链接/);
    assert.equal(fs.existsSync(path.join(root, 'moved')), false);
    assert.equal(await fsp.readFile(path.join(src, 'inner', 'x.txt'), 'utf8'), 'X');
    assert.ok(fs.existsSync(linkTarget));
  } finally {
    fsp.rename = origRename;
    // 先只摘链接本身，再清临时目录：总入口拒绝递归清理含 reparse point 的目录。
    try { await fsp.unlink(path.join(root, 'dir', 'inner', 'jl')); } catch {}
    if (!fs.existsSync(path.join(root, 'dir', 'inner', 'jl'))) await fsp.rm(root, { recursive: true, force: true });
  }
});
