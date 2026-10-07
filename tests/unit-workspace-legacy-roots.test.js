'use strict';
// 旧工作根（AI_HUB_LEGACY_WORKSPACE_ROOTS，2026-10-07 C:\AIWork → D:\AIWork）的行为契约：
//   1. 带 .aiwork-root 的旧根本身与其下目录被当作工作区内（不是 external / 不被拒绝）
//   2. 新会话、默认路径仍落在当前根
//   3. 旧根内目录的 AGENTS.md 播种源是旧根自己的 AGENTS.md
//   4. 旧根是常驻根：会话标签不能把它改名
//   5. 没有旧根配置时行为与之前完全一致；没有标记的旧根不参与
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { WorkspaceService } = require('../core/workspace-service.js');
const { sharedWorkspaceRules } = require('../core/memory-rule-files.js');

const same = (a, b) => assert.equal(path.resolve(a).toLowerCase(), path.resolve(b).toLowerCase());

function fixture(label, { legacyMarker = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `hub-legacy-${label}-`));
  const current = path.join(base, 'D-AIWork');
  const legacy = path.join(base, 'C-AIWork');
  fs.mkdirSync(current, { recursive: true });
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(current, '.aiwork-root'), 'marker');
  if (legacyMarker) fs.writeFileSync(path.join(legacy, '.aiwork-root'), 'marker');
  fs.writeFileSync(path.join(current, 'AGENTS.md'), '# current rules\n');
  fs.writeFileSync(path.join(legacy, 'AGENTS.md'), '# legacy rules\n');
  const task = path.join(legacy, '20261001-old-task');
  fs.mkdirSync(task);
  return { base, current, legacy, task, registryPath: path.join(base, 'registry.json') };
}

function service(fx, extra = {}) {
  return new WorkspaceService({
    workspaceRoot: fx.current,
    registryPath: fx.registryPath,
    legacyWorkspaceRoots: [fx.legacy],
    initGit: () => false,
    logger: { warn() {}, log() {} },
    ...extra,
  });
}

test('旧根本身与其下任务目录被接受，分层与当前根一致', () => {
  const fx = fixture('classify');
  const svc = service(fx);
  assert.equal(svc.classifyWorkspace(fx.legacy), 'root');
  assert.equal(svc.workspaceRejectReason(fx.legacy), null);
  assert.equal(svc.classifyWorkspace(fx.task), 'category');
  assert.equal(svc.classifyWorkspace(path.join(fx.task, 'sub')), 'project');
  assert.equal(svc.classifyWorkspace(path.join(fx.legacy, '_scratch', 'inbox-x')), 'scratch');
  assert.equal(svc.isScratchWorkspace(path.join(fx.legacy, '_scratch', 'inbox-x')), true);
  same(svc.workspaceRootFor(fx.task), fx.legacy);
  same(svc.workspaceRootFor(path.join(fx.current, 'x')), fx.current);
  assert.equal(svc.workspaceRootFor(fx.base), null);

  const atRoot = svc.resolveForSession(fx.legacy, { select: false, label: '未命名任务' });
  same(atRoot.path, fx.legacy);
  assert.equal(atRoot.tier, 'root');
  assert.equal(atRoot.permanentRoot, true);
  assert.equal(atRoot.label, path.basename(fx.legacy), '常驻旧根不能被会话占位名改名');
  const inside = svc.resolveForSession(fx.task, { select: false });
  assert.equal(inside.tier, 'category');
  assert.throws(() => svc.renameLabel(fx.legacy, '别的名字'), /平铺工作根/);
  assert.equal(svc.updateSuggestedName(fx.legacy, '某个标题').label, path.basename(fx.legacy));
});

test('新会话与默认路径仍落在当前根', () => {
  const fx = fixture('default');
  const svc = service(fx);
  const ws = svc.resolveForSession(undefined, { select: false });
  same(ws.path, fx.current);
  same(svc.getWorkspaceRoot(), fx.current);
  const listing = svc.listWorkspaces([fx.legacy, fx.task]);
  same(listing.root, fx.current);
  assert.deepEqual(listing.legacyRoots.map(r => r.toLowerCase()), [path.resolve(fx.legacy).toLowerCase()]);
  const legacyItem = listing.items.find(item => path.resolve(item.path).toLowerCase() === path.resolve(fx.legacy).toLowerCase());
  assert.equal(legacyItem.tier, 'root');
  assert.equal(legacyItem.permanentRoot, true);
  const scratch = svc.createScratchWorkspace({ select: false });
  assert.ok(path.resolve(scratch.path).toLowerCase().startsWith(path.join(fx.current, '_scratch').toLowerCase()));
});

test('旧根内目录播种旧根自己的 AGENTS.md；共享规则按旧根收集', () => {
  const fx = fixture('seed');
  const svc = service(fx);
  assert.equal(svc.seedUngovernedAgentsFile(fx.task), true);
  const seeded = fs.readFileSync(path.join(fx.task, 'AGENTS.md'), 'utf8');
  assert.match(seeded, /# legacy rules/);
  assert.doesNotMatch(seeded, /# current rules/);
  assert.ok(seeded.includes(`自动复制自 ${path.join(fx.legacy, 'AGENTS.md')}`));
  assert.equal(svc.seedUngovernedAgentsFile(fx.legacy), false, '根本身不播种');

  const deep = path.join(fx.task, 'deep');
  fs.mkdirSync(deep);
  const rules = sharedWorkspaceRules({ session: { cwd: deep, kind: 'kimi' }, workspaceService: svc, homeDir: fx.base });
  assert.ok(rules.some(rule => /# legacy rules/.test(rule.content)), JSON.stringify(rules));
});

test('没有旧根配置时行为不变：旧根目录视为 external，不播种', () => {
  const fx = fixture('none');
  const svc = service(fx, { legacyWorkspaceRoots: [] });
  assert.equal(svc.classifyWorkspace(fx.legacy), 'external');
  assert.equal(svc.classifyWorkspace(fx.task), 'external');
  assert.equal(svc.workspaceRejectReason(fx.legacy), null);
  assert.equal(svc.workspaceRootFor(fx.task), null);
  assert.equal(svc.seedUngovernedAgentsFile(fx.task), false);
  assert.equal(svc.classifyWorkspace(fx.current), 'root');
  assert.equal(svc.classifyWorkspace(path.join(fx.current, 'a')), 'category');
  const ws = svc.resolveForSession(fx.legacy, { select: false, label: '未命名任务' });
  assert.equal(ws.permanentRoot, undefined);
  assert.equal(ws.label, '未命名任务');
});

test('没有 .aiwork-root 标记的旧根不参与', () => {
  const fx = fixture('nomarker', { legacyMarker: false });
  const svc = service(fx);
  assert.deepEqual(svc.getLegacyWorkspaceRoots(), []);
  assert.equal(svc.classifyWorkspace(fx.task), 'external');
});

test('未注入 workspaceRoot 时从 env 读取当前根与旧根', () => {
  const fx = fixture('env');
  const saved = { root: process.env.AI_HUB_WORKSPACE_ROOT, legacy: process.env.AI_HUB_LEGACY_WORKSPACE_ROOTS };
  process.env.AI_HUB_WORKSPACE_ROOT = fx.current;
  process.env.AI_HUB_LEGACY_WORKSPACE_ROOTS = [fx.legacy, fx.current, ''].join(path.delimiter);
  try {
    const svc = new WorkspaceService({ registryPath: fx.registryPath, initGit: () => false, logger: { warn() {}, log() {} } });
    same(svc.getWorkspaceRoot(), fx.current);
    assert.deepEqual(svc.getLegacyWorkspaceRoots().map(r => r.toLowerCase()), [path.resolve(fx.legacy).toLowerCase()]);
    assert.equal(svc.classifyWorkspace(fx.task), 'category');
    // 注入 workspaceRoot 的实例（单测常用）不读 env 旧根
    const injected = new WorkspaceService({ workspaceRoot: fx.current, registryPath: fx.registryPath, initGit: () => false });
    assert.deepEqual(injected.getLegacyWorkspaceRoots(), []);
  } finally {
    if (saved.root === undefined) delete process.env.AI_HUB_WORKSPACE_ROOT; else process.env.AI_HUB_WORKSPACE_ROOT = saved.root;
    if (saved.legacy === undefined) delete process.env.AI_HUB_LEGACY_WORKSPACE_ROOTS; else process.env.AI_HUB_LEGACY_WORKSPACE_ROOTS = saved.legacy;
  }
});
