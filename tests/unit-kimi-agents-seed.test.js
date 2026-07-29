'use strict';
// core/workspace-service.js 的 seedUngovernedAgentsFile 单测。
// 背景：Kimi / Codex 无 .git 时只读 cwd 自己的 AGENTS.md（2026-07-29 探针实测），
// 未 git init 的项目目录里起会话会只剩全局约定。Hub 在 spawn 前给这种目录补根规则副本。

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { WorkspaceService } = (() => {
  const mod = require('../core/workspace-service.js');
  return mod.WorkspaceService ? mod : { WorkspaceService: mod };
})();

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

function withService(fn, opts = {}) {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-seed-')));
  const root = path.join(tmp, 'vibe');
  fs.mkdirSync(root, { recursive: true });
  if (opts.rootAgents !== false) {
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# ROOT RULES\n', 'utf8');
  }
  const svc = new WorkspaceService({
    workspaceRoot: root,
    registryPath: path.join(tmp, 'workspaces.json'),
    getHubDataDir: () => path.join(tmp, 'hub-data'),
    isIsolatedHub: () => true,
    initGit: () => true,
  });
  try {
    fn({ svc, root, tmp });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log('Running seedUngovernedAgentsFile tests...');

test('无 .git 且无 AGENTS.md 的工作区目录 → 补副本', () => {
  withService(({ svc, root }) => {
    const proj = path.join(root, 'AI', 'no-git-proj');
    fs.mkdirSync(proj, { recursive: true });
    assert.strictEqual(svc.seedUngovernedAgentsFile(proj), true);
    const text = fs.readFileSync(path.join(proj, 'AGENTS.md'), 'utf8');
    assert.ok(text.includes('# ROOT RULES'), '副本应含根规则正文');
    assert.ok(text.includes('自动复制自'), '副本应带来源注释头');
  });
});

test('cwd 自己有 .git → 不插手', () => {
  withService(({ svc, root }) => {
    const proj = path.join(root, 'git-proj');
    fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
    assert.strictEqual(svc.seedUngovernedAgentsFile(proj), false);
    assert.ok(!fs.existsSync(path.join(proj, 'AGENTS.md')));
  });
});

test('祖先有 .git（cwd 是其子目录）→ 不插手', () => {
  withService(({ svc, root }) => {
    const proj = path.join(root, 'git-proj');
    const deep = path.join(proj, 'src', 'deep');
    fs.mkdirSync(deep, { recursive: true });
    fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
    assert.strictEqual(svc.seedUngovernedAgentsFile(deep), false);
    assert.ok(!fs.existsSync(path.join(deep, 'AGENTS.md')));
  });
});

test('cwd 已有 AGENTS.md → 不覆盖', () => {
  withService(({ svc, root }) => {
    const proj = path.join(root, 'has-own');
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, 'AGENTS.md'), 'OWN', 'utf8');
    assert.strictEqual(svc.seedUngovernedAgentsFile(proj), false);
    assert.strictEqual(fs.readFileSync(path.join(proj, 'AGENTS.md'), 'utf8'), 'OWN');
  });
});

test('工作区外的目录 → 不碰', () => {
  withService(({ svc, tmp }) => {
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    assert.strictEqual(svc.seedUngovernedAgentsFile(outside), false);
    assert.ok(!fs.existsSync(path.join(outside, 'AGENTS.md')));
  });
});

test('根 AGENTS.md 不存在 → 返回 false 且不创建', () => {
  withService(({ svc, root }) => {
    const proj = path.join(root, 'no-root-rules');
    fs.mkdirSync(proj, { recursive: true });
    assert.strictEqual(svc.seedUngovernedAgentsFile(proj), false);
    assert.ok(!fs.existsSync(path.join(proj, 'AGENTS.md')));
  }, { rootAgents: false });
});

test('原有 seedScratchAgentsFile 行为不变（scratch 照常播种）', () => {
  withService(({ svc, root }) => {
    const scratch = path.join(root, '_scratch', 'inbox-test');
    fs.mkdirSync(scratch, { recursive: true });
    assert.strictEqual(svc.seedScratchAgentsFile(scratch), true);
    const text = fs.readFileSync(path.join(scratch, 'AGENTS.md'), 'utf8');
    assert.ok(text.includes('# ROOT RULES'));
    // 第二遍不覆盖
    fs.writeFileSync(path.join(scratch, 'AGENTS.md'), 'EDITED', 'utf8');
    assert.strictEqual(svc.seedScratchAgentsFile(scratch), false);
    assert.strictEqual(fs.readFileSync(path.join(scratch, 'AGENTS.md'), 'utf8'), 'EDITED');
  });
});
