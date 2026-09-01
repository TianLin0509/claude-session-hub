'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const { WorkspaceService } = require('../core/workspace-service.js');

const WORKER_FLAG = '--workspace-registry-worker';

function makeService(root, registryPath) {
  return new WorkspaceService({
    workspaceRoot: root,
    registryPath,
    initGit: () => false,
    logger: { warn() {}, error() {}, log() {} },
  });
}

function runWorker() {
  const [, , , mode, root, registryPath, workerRaw, loopsRaw] = process.argv;
  const worker = Number(workerRaw);
  const loops = Number(loopsRaw);
  const svc = makeService(root, registryPath);
  for (let i = 0; i < loops; i += 1) {
    if (mode === 'same-root') {
      svc.ensureDefaultWorkspace({ label: `session-${worker}-${i}`, select: false });
    } else {
      svc.touchWorkspace(path.join(root, 'projects', `w${worker}-${i}`), {
        label: `worker-${worker}-${i}`,
        select: false,
      });
    }
  }
}

function spawnWorker({ mode, root, registryPath, worker, loops }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      __filename,
      WORKER_FLAG,
      mode,
      root,
      registryPath,
      String(worker),
      String(loops),
    ], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ worker, code, stderr }));
  });
}

function fixture(label, workers, loops, { createProjects = false } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), `hub-workspace-${label}-`));
  const root = path.join(temp, 'AIWork');
  const registryPath = path.join(temp, 'workspaces.json');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, '.aiwork-root'), 'marker\n', 'utf8');
  if (createProjects) {
    for (let worker = 0; worker < workers; worker += 1) {
      for (let i = 0; i < loops; i += 1) {
        fs.mkdirSync(path.join(root, 'projects', `w${worker}-${i}`), { recursive: true });
      }
    }
  }
  return { temp, root, registryPath };
}

if (process.argv[2] === WORKER_FLAG) {
  try {
    runWorker();
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  }
} else {
  test('拿不到跨进程锁时显式失败，绝不降级成无锁覆盖', () => {
    const fx = fixture('busy', 1, 1, { createProjects: true });
    try {
      const svc = new WorkspaceService({
        workspaceRoot: fx.root,
        registryPath: fx.registryPath,
        initGit: () => false,
        acquireRegistryLock: () => null,
        releaseRegistryLock: () => {},
        logger: { warn() {}, error() {}, log() {} },
      });
      assert.throws(
        () => svc.touchWorkspace(path.join(fx.root, 'projects', 'w0-0'), { select: false }),
        error => error && error.code === 'WORKSPACE_REGISTRY_BUSY',
      );
      assert.equal(fs.existsSync(fx.registryPath), false);
    } finally {
      fs.rmSync(fx.temp, { recursive: true, force: true });
    }
  });

  test('多个 Hub 并发登记 workspace 时零 EPERM、零丢条目', async () => {
    const workers = 6;
    const loops = 40;
    const fx = fixture('many', workers, loops, { createProjects: true });
    try {
      const results = await Promise.all(Array.from({ length: workers }, (_, worker) => spawnWorker({
        mode: 'many', root: fx.root, registryPath: fx.registryPath, worker, loops,
      })));
      assert.deepEqual(results.map(row => row.code), Array(workers).fill(0),
        results.map(row => row.stderr).filter(Boolean).join('\n'));
      const registry = JSON.parse(fs.readFileSync(fx.registryPath, 'utf8'));
      assert.equal(registry.workspaces.length, workers * loops);
      assert.equal(new Set(registry.workspaces.map(row => path.resolve(row.path).toLowerCase())).size, workers * loops);
    } finally {
      fs.rmSync(fx.temp, { recursive: true, force: true });
    }
  });

  test('多个 Hub 同时新建 flat-root Session 时全部成功且根只保留一条稳定记录', async () => {
    const workers = 6;
    const loops = 60;
    const fx = fixture('flat', workers, loops);
    try {
      const results = await Promise.all(Array.from({ length: workers }, (_, worker) => spawnWorker({
        mode: 'same-root', root: fx.root, registryPath: fx.registryPath, worker, loops,
      })));
      assert.deepEqual(results.map(row => row.code), Array(workers).fill(0),
        results.map(row => row.stderr).filter(Boolean).join('\n'));
      const registry = JSON.parse(fs.readFileSync(fx.registryPath, 'utf8'));
      assert.equal(registry.workspaces.length, 1);
      assert.equal(path.resolve(registry.workspaces[0].path).toLowerCase(), path.resolve(fx.root).toLowerCase());
      assert.equal(registry.workspaces[0].label, path.basename(fx.root));
      assert.equal(registry.workspaces[0].permanentRoot, true);
      assert.equal(registry.workspaces[0].draft, false);
    } finally {
      fs.rmSync(fx.temp, { recursive: true, force: true });
    }
  });
}
