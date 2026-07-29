'use strict';
// 注册表隔离回归（2026-07-28）。
//
// 事故：WorkspaceService 只有 workspaceRoot 能注入，getRegistryPath() 却硬走
// getHubDataDir()。三个单测把 workspace 建在临时目录、条目却写进用户生产的
// ~/.claude-session-hub/workspaces.json —— 每跑一次脏一批。实测生产库 74 条里
// 48 条是测试残留（ws-tuning-* / hub-seed-* / ws-dismiss-* 三个前缀，正好对应
// 那三个没隔离的测试文件），selectedPath 还被改成了一个已被删除的临时目录。
//
// 这里锁三件事：
//   1. registryPath / getHubDataDir 两条注入口都真的生效；
//   2. selectedPath 指向不存在的目录时会自愈；
//   3. 【最重要】任何构造 WorkspaceService 的测试都必须隔离注册表 —— 源码级扫描，
//      防止将来又有人只注入 workspaceRoot 就交上来。

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { WorkspaceService } = require('../core/workspace-service.js');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('  OK ' + name); }
  catch (error) { failed += 1; console.error('  FAIL ' + name + '\n    ' + (error && error.message)); }
}

function withTempRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-registry-iso-'));
  try { return fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

console.log('Running workspace registry isolation tests...');

test('registryPath 注入后，注册表落在指定文件而不是 Hub 数据目录', () => {
  withTempRoot(root => {
    const registryPath = path.join(root, 'custom', 'registry.json');
    const service = new WorkspaceService({
      workspaceRoot: path.join(root, 'ws'),
      registryPath,
      initGit: () => true,
    });
    service.createScratchWorkspace({ label: '未命名任务' });
    assert.strictEqual(service.getRegistryPath(), path.resolve(registryPath));
    assert(fs.existsSync(registryPath), '注册表应写到注入的路径');
    const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    assert.strictEqual(parsed.workspaces.length, 1);
  });
});

test('getHubDataDir 注入后，注册表落在该数据目录下', () => {
  withTempRoot(root => {
    const dataDir = path.join(root, 'hub-data');
    const service = new WorkspaceService({
      workspaceRoot: path.join(root, 'ws'),
      getHubDataDir: () => dataDir,
      initGit: () => true,
    });
    service.createScratchWorkspace({ label: '未命名任务' });
    assert.strictEqual(service.getRegistryPath(), path.join(dataDir, 'workspaces.json'));
    assert(fs.existsSync(path.join(dataDir, 'workspaces.json')));
  });
});

test('registryPath 优先于 getHubDataDir', () => {
  withTempRoot(root => {
    const registryPath = path.join(root, 'win.json');
    const service = new WorkspaceService({
      workspaceRoot: path.join(root, 'ws'),
      registryPath,
      getHubDataDir: () => path.join(root, 'ignored'),
      initGit: () => true,
    });
    assert.strictEqual(service.getRegistryPath(), path.resolve(registryPath));
  });
});

test('selectedPath 指向已消失的目录时自愈为 null', () => {
  withTempRoot(root => {
    const registryPath = path.join(root, 'registry.json');
    const wsRoot = path.join(root, 'ws');
    fs.mkdirSync(wsRoot, { recursive: true });
    fs.writeFileSync(registryPath, JSON.stringify({
      schemaVersion: 1,
      selectedPath: path.join(root, 'gone-forever'),
      workspaces: [],
    }), 'utf8');
    const service = new WorkspaceService({ workspaceRoot: wsRoot, registryPath, initGit: () => true });
    assert.strictEqual(service.listWorkspaces().selectedPath, null,
      'selectedPath 指向不存在的目录必须被清空，否则会一直传给 renderer');
  });
});

test('目录仍存在时 selectedPath 不受影响', () => {
  withTempRoot(root => {
    const registryPath = path.join(root, 'registry.json');
    const wsRoot = path.join(root, 'ws');
    const alive = path.join(root, 'alive');
    fs.mkdirSync(wsRoot, { recursive: true });
    fs.mkdirSync(alive, { recursive: true });
    fs.writeFileSync(registryPath, JSON.stringify({
      schemaVersion: 1,
      selectedPath: alive,
      workspaces: [{ id: 'a', path: alive, label: 'alive', createdAt: 1, lastUsedAt: 1 }],
    }), 'utf8');
    const service = new WorkspaceService({ workspaceRoot: wsRoot, registryPath, initGit: () => true });
    assert.strictEqual(service.listWorkspaces().selectedPath, alive);
  });
});

// —— 结构约束：防止事故复发 ——
test('所有构造 WorkspaceService 的测试都必须隔离注册表', () => {
  const dir = __dirname;
  const offenders = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.test.js') || name === path.basename(__filename)) continue;
    const src = fs.readFileSync(path.join(dir, name), 'utf8');
    if (!src.includes('new WorkspaceService(')) continue;
    // 构造点必须能看到注册表隔离的注入口之一
    if (!src.includes('getHubDataDir') && !src.includes('registryPath')) {
      offenders.push(name);
      continue;
    }
    // 逐个构造点检查：不能出现「只给 workspaceRoot」的裸构造
    const bare = src.match(/new WorkspaceService\(\{[^}]*\}\)/g) || [];
    for (const call of bare) {
      if (!/getHubDataDir|registryPath/.test(call)) {
        offenders.push(`${name} -> ${call.replace(/\s+/g, ' ').slice(0, 90)}`);
      }
    }
  }
  assert.deepStrictEqual(offenders, [],
    '这些测试会把条目写进用户生产的 workspaces.json，必须注入 getHubDataDir 或 registryPath');
});

if (failed > 0) {
  console.error(`workspace registry isolation: ${failed} FAILED`);
  process.exitCode = 1;
} else {
  console.log('All workspace registry isolation tests passed.');
}
