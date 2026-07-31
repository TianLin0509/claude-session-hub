'use strict';
// workspace 分层（2026-07-29 第五轮，用户决策 2：「为什么分类根不能当 workspace？」）
//
// 结论是**不该禁**。跨项目的审查/对比/领域规划不属于任何单个项目，分类根正是它们该待的
// 地方（这轮三方审查报告就写在 C:\Vibe\AI\artifacts\）。硬门禁会把正当用途一起堵死。
// 唯一该拦的是聚合根本身：在那里搜索扫穿所有领域、产物落在组织根，根规则明写禁止。

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { WorkspaceService } = require('../core/workspace-service.js');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  OK ${name}`); }
  catch (err) { failed++; console.error(`  FAIL ${name}`); console.error(err.message); }
}

function withTree(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-tier-'));
  try {
    const ws = path.join(root, 'Vibe');
    fs.mkdirSync(ws);
    const svc = new WorkspaceService({
      workspaceRoot: ws,
      registryPath: path.join(root, 'ws.json'),
      logger: { warn() {}, log() {} },
    });
    svc.ensureRoot();
    fn({ root, ws, svc });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

console.log('Running workspace tier tests...');

test('五种层级判定正确', () => {
  withTree(({ root, ws, svc }) => {
    const cases = [
      [ws, 'root'],
      [path.join(ws, 'AI'), 'category'],
      [path.join(ws, 'AI', 'proj'), 'project'],
      [path.join(ws, 'AI', 'proj', 'sub'), 'project'],
      [path.join(ws, '_scratch', 'inbox-x'), 'scratch'],
      [path.join(root, 'outside'), 'external'],
      ['C:\\Users\\lintian\\claude-session-hub', 'external'],
    ];
    for (const [cwd, want] of cases) {
      assert.strictEqual(svc.classifyWorkspace(cwd), want, `${cwd} 应为 ${want}`);
    }
  });
});

test('只有聚合根被拒，分类根放行', () => {
  withTree(({ ws, svc }) => {
    assert.ok(svc.workspaceRejectReason(ws), '聚合根必须给出拒绝理由');
    assert.match(svc.workspaceRejectReason(ws), /组织根/);
    // 这几个都是正当用途，一个都不许拦
    for (const ok of [
      path.join(ws, 'AI'),                       // 领域级跨项目任务
      path.join(ws, 'AI', 'proj'),
      path.join(ws, '_scratch', 'inbox-x'),
      'C:\\Users\\lintian\\claude-session-hub',   // Hub 自己的仓库在工作区外
    ]) {
      assert.strictEqual(svc.workspaceRejectReason(ok), null, `${ok} 不该被拒`);
    }
  });
});

test('_scratch 根自身和其子目录都算 scratch', () => {
  withTree(({ ws, svc }) => {
    // _scratch 虽是 workspaceRoot 的直接子目录，语义上仍属于草稿区，不应标成业务领域。
    assert.strictEqual(svc.classifyWorkspace(svc.getScratchRoot()), 'scratch');
    assert.strictEqual(svc.classifyWorkspace(path.join(ws, '_scratch', 'inbox-y')), 'scratch');
  });
});

test('listWorkspaces 把 tier 带给 UI', () => {
  withTree(({ ws, svc }) => {
    const category = path.join(ws, 'AI');
    const project = path.join(ws, 'AI', 'proj');
    fs.mkdirSync(project, { recursive: true });
    const touched = svc.touchWorkspace(category, { label: 'AI 领域' });
    svc.touchWorkspace(project, { label: '某项目' });

    assert.strictEqual(touched.tier, 'category', '刚选完目录的响应也要有 tier，不能等下一次 list');

    const listed = svc.listWorkspaces();
    const byPath = new Map(listed.items.map(i => [i.path.toLowerCase(), i]));
    assert.strictEqual(byPath.get(category.toLowerCase()).tier, 'category');
    assert.strictEqual(byPath.get(project.toLowerCase()).tier, 'project');
  });
});

test('会话解析链服务端硬拦组织根，但允许分类根', () => {
  withTree(({ ws, svc }) => {
    const category = path.join(ws, 'AI');
    fs.mkdirSync(category);
    assert.throws(() => svc.resolveForSession(ws), /组织根/, '不能只靠 UI 置灰');
    assert.strictEqual(svc.resolveForSession(category, { select: false }).tier, 'category');
  });
});

test('分层信息接进目录选择 IPC 与两处创建 UI', () => {
  const handlers = fs.readFileSync(path.join(__dirname, '..', 'main', 'ipc', 'workspace-handlers.js'), 'utf8');
  const controller = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'workspace-controller.js'), 'utf8');
  const meetingModal = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'meeting-create-modal.js'), 'utf8');
  assert.match(handlers, /workspace:select[\s\S]*?resolveForSession\(cwd/,
    '直接选择目录也必须走服务端拒绝链');
  assert.match(handlers, /workspace:pick[\s\S]*?resolveForSession\(result\.filePaths\[0\]/,
    '系统目录选择框返回后也必须走服务端拒绝链');
  assert.match(controller, /category: '领域工作区'/);
  assert.match(controller, /disabled aria-disabled="true"/, '旧注册表里的组织根要在最近列表置灰');
  assert.match(meetingModal, /workspaceTierLabel\(_meetingWorkspace\.tier\)/,
    '群聊创建框也要显示目录层级，不能只修普通会话');
});

test('归档提示逻辑不受影响（只有 _scratch 里的草稿才提示）', () => {
  withTree(({ ws, svc }) => {
    const category = path.join(ws, 'AI');
    fs.mkdirSync(category, { recursive: true });
    svc.touchWorkspace(category, { label: 'AI 领域', draft: true });
    assert.strictEqual(svc.getArchiveContext(category).required, false,
      '分类根即便被标成 draft 也不该弹归档——它已经在正式分类下了');

    const scratch = svc.createScratchWorkspace({ label: '临时任务' });
    assert.strictEqual(svc.getArchiveContext(scratch.path).required, true);
  });
});

if (failed) process.exitCode = 1;
else console.log('All workspace tier tests passed.');
