'use strict';
// Covers the new-session modal upgrades (recent workspaces / landing-path footer /
// model+effort picker) and the draft regression that used to strand scratch
// workspaces in _scratch by silently clearing the first-turn archive prompt.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { WorkspaceService } = require('../core/workspace-service.js');

const SESSION_MANAGER_SRC = fs.readFileSync(path.join(__dirname, '..', 'core', 'session-manager.js'), 'utf8');
const CONTROLLER_SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'workspace-controller.js'), 'utf8');
const INDEX_SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-tuning-'));
  try {
    // getHubDataDir 必须一起注入：注册表落盘走的是它，只注入 workspaceRoot 的话
    // 假 workspace 会被写进用户生产的 ~/.claude-session-hub/workspaces.json。
    fn(new WorkspaceService({
      workspaceRoot: root,
      getHubDataDir: () => path.join(root, 'hub-data'),
      initGit: () => true,
    }), root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

console.log('Running new-session tuning + draft regression tests...');

test('listWorkspaces exposes scratchRoot so the footer can preview the landing path', () => {
  withService((service, root) => {
    const listing = service.listWorkspaces();
    assert.strictEqual(listing.scratchRoot, path.join(root, '_scratch'));
    assert.strictEqual(listing.root, path.resolve(root));
  });
});

test('touchWorkspace never clears draft — only archiveDraft may', () => {
  withService((service, root) => {
    const scratch = service.createScratchWorkspace({ label: '未命名任务' });
    assert.strictEqual(scratch.draft, true);

    // A reconnect / workspace:select round trip must not downgrade the draft.
    service.touchWorkspace(scratch.path, { select: false });
    service.touchWorkspace(scratch.path, { draft: false, select: false });
    assert.strictEqual(service.getWorkspace(scratch.path).draft, true, 'draft must survive a stray draft:false');
    assert.strictEqual(service.getArchiveContext(scratch.path).required, true, 'archive prompt must still be required');

    fs.mkdirSync(path.join(root, 'AI'), { recursive: true });
    const archived = service.archiveDraft(scratch.path, { parent: path.join(root, 'AI'), folderName: 'my-task' });
    assert.strictEqual(archived.draft, false, 'archiveDraft is the only path that clears draft');
    assert.strictEqual(archived.path, path.join(root, 'AI', 'my-task'));
  });
});

test('Claude command uses the validated opts.effort and falls back to max', () => {
  assert.match(
    SESSION_MANAGER_SRC,
    /const CLAUDE_EFFORT_LEVELS = new Set\(\['low', 'medium', 'high', 'xhigh', 'max'\]\)/,
    'effort enum must be declared as a whitelist',
  );
  assert.match(
    SESSION_MANAGER_SRC,
    /const effort = CLAUDE_EFFORT_LEVELS\.has\(opts\.effort\) \? opts\.effort : 'max'/,
    'out-of-enum effort must fall back to max instead of reaching the PTY command line',
  );
  assert.match(
    SESSION_MANAGER_SRC,
    /effortFlag = process\.env\.CLAUDE_HUB_NO_EFFORT_MAX === '1' \? '' : ` --effort \$\{effort\}`/,
    'the kill switch must still win over an explicit effort',
  );
  assert.match(
    SESSION_MANAGER_SRC,
    /\.\.\.\(CLAUDE_EFFORT_LEVELS\.has\(opts\.effort\) \? \{ effort: opts\.effort \} : \{\}\)/,
    'effort must be persisted on the session so resume/archive-restart keeps the level',
  );
});

test('modal markup carries the recent list, model picker and effort picker', () => {
  for (const id of [
    'new-session-recent',
    'new-session-model',
    'new-session-effort',
    'new-session-effort-field',
    'new-session-tuning',
    'new-session-pick-path',
  ]) {
    assert.ok(INDEX_SRC.includes(`id="${id}"`), `index.html must define #${id}`);
  }
  assert.ok(INDEX_SRC.includes('class="session-create-body"'), 'body must be a separate scroll container');
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
    assert.ok(INDEX_SRC.includes(`value="${level}"`), `effort select must offer ${level}`);
  }
});

test('recent workspaces are primary; the OS folder dialog is only the fallback', () => {
  assert.doesNotMatch(
    CONTROLLER_SRC,
    /workspaceMode === 'existing' && !existingWorkspace\) void chooseExistingPath\(\)/,
    'switching to 选择已有路径 must not auto-open the system dialog',
  );
  assert.match(CONTROLLER_SRC, /workspace:list/, 'recent list must come from workspace:list');
  assert.match(CONTROLLER_SRC, /data-recent-path/, 'recent entries must be clickable');
  assert.match(
    CONTROLLER_SRC,
    /if \(pick\) pick\.addEventListener\('click', \(\) => void chooseExistingPath\(\)\)/,
    '浏览文件夹… must still reach the OS dialog',
  );
});

test('only flags the selected CLI understands are sent', () => {
  assert.match(CONTROLLER_SRC, /const EFFORT_KINDS = new Set\(\['claude'\]\)/, 'effort is Claude-only');
  assert.match(
    CONTROLLER_SRC,
    /if \(modelOptionsFor\(selectedKind\)\.length > 0 && selectedModel\) opts\.model = selectedModel/,
    'model is only sent for kinds that have a model list',
  );
  assert.match(
    CONTROLLER_SRC,
    /if \(EFFORT_KINDS\.has\(selectedKind\) && selectedEffort\) opts\.effort = selectedEffort/,
    'effort is only sent for Claude',
  );
});

test('the modal opens as flex so the body can scroll and the footer stays reachable', () => {
  assert.match(
    CONTROLLER_SRC,
    /menuEl\.style\.display = 'flex';/,
    "inline display:block would override the CSS flex column and clip the create button",
  );
  assert.doesNotMatch(CONTROLLER_SRC, /menuEl\.style\.display = 'block';/);
});

test('footer previews the real landing path', () => {
  assert.match(CONTROLLER_SRC, /function targetPathPreview\(\)/, 'footer must compute a concrete target path');
  assert.match(CONTROLLER_SRC, /path\.join\(scratchRoot, 'inbox-…'\)/, 'scratch mode must show the scratch root');
});

if (!process.exitCode) console.log('All new-session tuning + draft regression tests passed.');
