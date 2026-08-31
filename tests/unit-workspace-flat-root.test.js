'use strict';
// 平铺工作根（2026-08-31 用户决策）的行为契约。
//
// 这组测试锁的是四件容易被后续改动悄悄破坏的事：
//   1. 没挂 .aiwork-root 标记时，旧行为一字不变（根仍被硬拦、默认落 _scratch）
//   2. 挂了标记之后，根可以直接当 cwd，且默认会话开在根上
//   3. 用户显式要「临时目录」时仍然拿到随机 _scratch\inbox-*
//   4. 根上要有 .vibe-root，否则 Codex 会一路向上收集到盘符根
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { WorkspaceService } = require('../core/workspace-service.js');

function makeService(root, extra = {}) {
  return new WorkspaceService({
    workspaceRoot: root,
    registryPath: path.join(root, '_registry.json'),
    // git init 在单测里没意义，还会拖慢；直接短路。
    initGit: () => false,
    logger: { warn() {}, log() {} },
    ...extra,
  });
}

function tempRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `hub-flat-${label}-`));
}

test('未挂标记时保持旧行为：根被硬拦，默认落 scratch', () => {
  const root = tempRoot('legacy');
  const svc = makeService(root);
  svc.ensureRoot();

  assert.equal(svc.isFlatWorkRoot(), false);

  const reason = svc.workspaceRejectReason(root);
  assert.ok(reason && reason.includes('组织根'), '根应当仍被拒绝');

  const ws = svc.resolveForSession(undefined, { select: false });
  assert.ok(
    svc.isScratchWorkspace(ws.path),
    `默认应落在 _scratch 下，实际 ${ws.path}`,
  );
});

test('挂上 .aiwork-root 之后：根可用，且默认会话开在根上', () => {
  const root = tempRoot('flat');
  const svc = makeService(root);
  svc.ensureRoot();
  fs.writeFileSync(path.join(root, '.aiwork-root'), 'marker');

  assert.equal(svc.isFlatWorkRoot(), true);
  assert.equal(svc.workspaceRejectReason(root), null, '带标记的根不该再被拒绝');

  const ws = svc.resolveForSession(undefined, { select: false });
  assert.equal(
    path.resolve(ws.path).toLowerCase(),
    path.resolve(root).toLowerCase(),
    '平铺模式下默认会话应开在工作根',
  );
  assert.equal(ws.draft, false, '工作根是常驻工作区，不能标成 draft（draft 会触发归档提示）');
});

test('显式要临时目录时仍然拿到随机 scratch 目录', () => {
  const root = tempRoot('scratch');
  const svc = makeService(root);
  svc.ensureRoot();
  fs.writeFileSync(path.join(root, '.aiwork-root'), 'marker');

  const ws = svc.resolveForSession(undefined, { select: false, workspaceMode: 'scratch' });
  assert.ok(svc.isScratchWorkspace(ws.path), `应落在 _scratch，实际 ${ws.path}`);
  assert.match(path.basename(ws.path), /^inbox-\d{8}-\d{6}-/);

  // 两次不能撞名 —— 随机后缀就是干这个的
  const second = svc.resolveForSession(undefined, { select: false, workspaceMode: 'scratch' });
  assert.notEqual(ws.path, second.path);
});

test('ensureDefaultWorkspace 会在根上补 .vibe-root，但不给根 seed AGENTS.md', () => {
  const root = tempRoot('marker');
  const svc = makeService(root);
  svc.ensureRoot();
  fs.writeFileSync(path.join(root, '.aiwork-root'), 'marker');
  // 根上的 AGENTS.md 是源文件，由用户维护；ensureDefaultWorkspace 不该动它。
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# 我自己写的规则\n');

  svc.ensureDefaultWorkspace({ select: false });

  assert.ok(
    fs.existsSync(path.join(root, '.vibe-root')),
    '根上必须有 .vibe-root，否则 Codex 会一路向上收集到盘符根',
  );
  assert.equal(
    fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'),
    '# 我自己写的规则\n',
    '根上的 AGENTS.md 是源文件，不能被 seed 覆盖',
  );
});

test('listWorkspaces 把 flatRoot 透出给 UI', () => {
  const root = tempRoot('listing');
  const svc = makeService(root);
  svc.ensureRoot();

  assert.equal(svc.listWorkspaces().flatRoot, false);
  fs.writeFileSync(path.join(root, '.aiwork-root'), 'marker');
  const listing = svc.listWorkspaces();
  assert.equal(listing.flatRoot, true);
  assert.equal(path.resolve(listing.root).toLowerCase(), path.resolve(root).toLowerCase());
});

// 审阅时抓到的真 bug：renderer 的 createDefaultWorkspace 会传 label:'未命名任务'，
// session-handlers 会传 opts.workspaceLabel，而 touchWorkspace 见到非空 label 就覆盖 ——
// 于是每开一个新会话，工作根在注册表里的名字就被改成「未命名任务」。
test('工作根的显示名不会被会话级 label 覆盖', () => {
  const root = tempRoot('label');
  const svc = makeService(root);
  svc.ensureRoot();
  fs.writeFileSync(path.join(root, '.aiwork-root'), 'marker');

  const expected = path.basename(root);
  const first = svc.ensureDefaultWorkspace({ select: false, label: '未命名任务' });
  assert.equal(first.label, expected);

  // 再开两个会话，名字必须纹丝不动
  svc.resolveForSession(undefined, { select: false, label: '未命名群聊' });
  const third = svc.resolveForSession(undefined, { select: false, label: '随便什么标题' });
  assert.equal(third.label, expected, '工作根名字必须稳定，只跟目录名走');

  assert.equal(svc.getWorkspace(root).label, expected, '注册表里也不能被改');
});

// 归档提示在平铺下必须彻底哑火：工作根 draft=false，老 _scratch 目录也不再算
// 本工作根的 scratch（scratch 根已经跟着 AI_HUB_WORKSPACE_ROOT 搬走了）。
test('平铺下归档提示不触发，且不抛异常', () => {
  const root = tempRoot('archive');
  const svc = makeService(root);
  svc.ensureRoot();
  fs.writeFileSync(path.join(root, '.aiwork-root'), 'marker');

  const ws = svc.ensureDefaultWorkspace({ select: false });
  const ctx = svc.getArchiveContext(ws.path);
  assert.equal(ctx.required, false, '工作根不该触发归档提示');

  // 一个「别的工作根下的」历史 scratch 目录：不属于当前 scratch 根，也不该要求归档
  const legacy = path.join(root, 'legacy-scratch-like');
  fs.mkdirSync(legacy, { recursive: true });
  const legacyWs = svc.touchWorkspace(legacy, { draft: true, select: false });
  assert.equal(svc.isScratchWorkspace(legacyWs.path), false);
  assert.equal(svc.getArchiveContext(legacy).required, false);
});

test('显式传入的 cwd 依然优先于任何默认档', () => {
  const root = tempRoot('explicit');
  const svc = makeService(root);
  svc.ensureRoot();
  fs.writeFileSync(path.join(root, '.aiwork-root'), 'marker');
  const project = path.join(root, 'some-project');
  fs.mkdirSync(project, { recursive: true });

  const ws = svc.resolveForSession(project, { select: false });
  assert.equal(path.resolve(ws.path).toLowerCase(), path.resolve(project).toLowerCase());
});
