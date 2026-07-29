'use strict';
// 用户反馈：选过「暂留 _scratch」之后，每轮回答结束还是会再弹一次归档框。
// 根因在 closeArchiveModal —— 它把「已问过」标记 delete 掉了，于是下一次
// turn-complete 又满足 maybePromptArchive 的条件。等于用户的决定完全不生效。
// 修复：关闭即视为已决定，本次运行不再问；并落盘到注册表，重启后也不再问。

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { WorkspaceService } = require('../core/workspace-service.js');

const CONTROLLER_SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'workspace-controller.js'), 'utf8');
const HANDLER_SRC = fs.readFileSync(path.join(__dirname, '..', 'main', 'ipc', 'workspace-handlers.js'), 'utf8');

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

function withService(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-dismiss-'));
  // 注册表跟着一起隔离，别把临时 workspace 写进生产 workspaces.json。
  try {
    fn(new WorkspaceService({
      workspaceRoot: root,
      getHubDataDir: () => path.join(root, 'hub-data'),
      initGit: () => true,
    }), root);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

console.log('Running archive dismiss stickiness tests...');

test('dismissing stops the prompt from being required again', () => {
  withService((service) => {
    const scratch = service.createScratchWorkspace({ label: '未命名任务' });
    assert.strictEqual(service.getArchiveContext(scratch.path).required, true, 'first turn must ask');

    service.dismissArchive(scratch.path);
    assert.strictEqual(service.getArchiveContext(scratch.path).required, false,
      'after the user declines, later turns must not ask again');
  });
});

test('the decision survives a fresh service instance (Hub restart)', () => {
  withService((service, root) => {
    const scratch = service.createScratchWorkspace({ label: '未命名任务' });
    service.dismissArchive(scratch.path);
    // 必须指向同一个隔离注册表，模拟的是「同一台机器重启 Hub」。
    const reopened = new WorkspaceService({
      workspaceRoot: root,
      getHubDataDir: () => path.join(root, 'hub-data'),
      initGit: () => true,
    });
    assert.strictEqual(reopened.getArchiveContext(scratch.path).required, false,
      'the dismissal must be persisted, not just in renderer memory');
  });
});

test('dismissal does not touch draft, so explicit archiving still works', () => {
  withService((service, root) => {
    const scratch = service.createScratchWorkspace({ label: '未命名任务' });
    service.dismissArchive(scratch.path);
    assert.strictEqual(service.getWorkspace(scratch.path).draft, true,
      'draft must stay true — the user only declined the prompt, not the ability to archive');
    fs.mkdirSync(path.join(root, 'AI'), { recursive: true });
    const archived = service.archiveDraft(scratch.path, { parent: path.join(root, 'AI'), folderName: 'later' });
    assert.strictEqual(archived.path, path.join(root, 'AI', 'later'));
  });
});

test('other workspaces are unaffected', () => {
  withService((service) => {
    const a = service.createScratchWorkspace({ label: 'A' });
    const b = service.createScratchWorkspace({ label: 'B' });
    service.dismissArchive(a.path);
    assert.strictEqual(service.getArchiveContext(a.path).required, false);
    assert.strictEqual(service.getArchiveContext(b.path).required, true);
  });
});

test('closing the modal marks it asked instead of clearing the mark', () => {
  // 2026-07-29：closeArchiveModal 里改用 key 变量（P1-2 重构），断言跟着放宽到
  // 「关闭时只 add 不 delete」这个真正的不变量。是否真的不再追问由
  // unit-archive-session-chip 真跑 controller 验证。
  const start = CONTROLLER_SRC.indexOf('function closeArchiveModal(');
  assert.ok(start > 0, 'closeArchiveModal must exist');
  const body = CONTROLLER_SRC.slice(start, CONTROLLER_SRC.indexOf('\n  }', start));
  assert.match(body, /archivePromptedKeys\.add\(/, 'closing must remember that the user was already asked');
  assert.doesNotMatch(
    body,
    /archivePromptedKeys\.delete\(/,
    'the old delete is exactly what made it re-ask every turn',
  );
  assert.match(CONTROLLER_SRC, /workspace:dismiss-archive/, 'the decision must be persisted through IPC');
});

test('the dismiss IPC is registered', () => {
  assert.match(HANDLER_SRC, /ipcMain\.handle\('workspace:dismiss-archive'/);
  assert.match(HANDLER_SRC, /workspaceService\.dismissArchive\(args && args\.path\)/);
});

if (!process.exitCode) console.log('All archive dismiss stickiness tests passed.');
