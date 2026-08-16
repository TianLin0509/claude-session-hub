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
    assert.deepStrictEqual(listing.recommended, [], 'recommendations only include real category directories');
  });
});

test('existing AI, Wireless, and Stock category roots are recommended ahead of history', () => {
  withService((service, root) => {
    for (const directory of ['AI', 'Wireless', 'Stock']) fs.mkdirSync(path.join(root, directory), { recursive: true });
    const listing = service.listWorkspaces();
    assert.deepStrictEqual(listing.recommended.map(item => item.label), ['AI', 'Wireless', '投研']);
    assert.deepStrictEqual(listing.recommended.map(item => item.path), [
      path.join(root, 'AI'),
      path.join(root, 'Wireless'),
      path.join(root, 'Stock'),
    ]);
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
    /\.\.\.\(isClaude && CLAUDE_EFFORT_LEVELS\.has\(opts\.effort\) \? \{ effort: opts\.effort \} : \{\}\)/,
    'only a validated Claude effort may be persisted for resume/archive-restart',
  );
});

test('modal markup carries the recent list, model picker and effort picker', () => {
  assert.equal(Buffer.from(CONTROLLER_SRC, 'utf8').includes(0), false, 'workspace controller source must not contain raw NUL bytes');
  for (const id of [
    'new-session-recent',
    'new-session-recommended',
    'new-session-recommended-section',
    'new-session-model',
    'new-session-effort',
    'new-session-effort-field',
    'new-session-mcp',
    'new-session-mcp-field',
    'new-session-tuning',
    'new-session-pick-path',
  ]) {
    assert.ok(INDEX_SRC.includes(`id="${id}"`), `index.html must define #${id}`);
  }
  assert.ok(INDEX_SRC.includes('class="session-create-body"'), 'body must be a separate scroll container');
  // fast 开关（Claude 专属）与档位提示条也是这套弹窗的固定构件。
  for (const id of ['new-session-fast', 'new-session-fast-field', 'new-session-tuning-note']) {
    assert.ok(INDEX_SRC.includes(`id="${id}"`), `index.html must define #${id}`);
  }
  assert.ok(INDEX_SRC.includes('id="new-session-fast" checked'), 'fast 默认必须是勾上的');
  // 思考强度/MCP 的选项改成动态填充了：Claude 是固定枚举，Codex 按**模型**来
  // （gpt-5.6-sol 到 ultra，gpt-5.5 只到 xhigh，见 core/codex-model-catalog.js）。
  // 写死一份必然给某些模型多出或少掉档位，所以这里校验 JS 侧的来源而不是 HTML。
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
    assert.ok(new RegExp(`\\['${level}'`).test(CONTROLLER_SRC), `Claude effort 选项必须提供 ${level}`);
  }
  assert.match(
    CONTROLLER_SRC,
    /function effortOptionsFor\(kind, modelId\)/,
    'Codex 的档位必须跟着选中的模型走，不能只看 kind',
  );
  assert.match(
    CONTROLLER_SRC,
    /codexTuningCatalog/,
    '档位来源必须是 codex-cli 自己的模型目录，不是 Hub 里写死的表',
  );
  assert.match(
    CONTROLLER_SRC,
    /const CODEX_TIER_KINDS = new Set\(\['codex', 'deepseek'\]\)/,
    'Codex 的 fast 是 service_tier，必须有自己的控件',
  );
});

test('recent workspaces are primary; the OS folder dialog is only the fallback', () => {
  assert.doesNotMatch(
    CONTROLLER_SRC,
    /workspaceMode === 'existing' && !existingWorkspace\) void chooseExistingPath\(\)/,
    'switching to 选择已有路径 must not auto-open the system dialog',
  );
  assert.match(CONTROLLER_SRC, /workspace:list/, 'recent list must come from workspace:list');
  assert.match(CONTROLLER_SRC, /data-recent-path/, 'recent entries must be clickable');
  assert.match(CONTROLLER_SRC, /data-recommended-path/, 'recommended category roots must be clickable');
  assert.match(CONTROLLER_SRC, /listing && listing\.recommended/, 'recommended roots must come from workspace:list');
  assert.match(
    CONTROLLER_SRC,
    /if \(pick\) pick\.addEventListener\('click', \(\) => void chooseExistingPath\(\)\)/,
    '浏览文件夹… must still reach the OS dialog',
  );
});

test('only flags the selected CLI understands are sent', () => {
  // 思考强度：Claude 走 --effort，Codex/DeepSeek 走 -c model_reasoning_effort。
  // 三家都有这个旋钮，但 Gemini / Kimi / PowerShell 没有，不能乱传。
  assert.match(
    CONTROLLER_SRC,
    /const EFFORT_KINDS = new Set\(\['claude', 'codex', 'deepseek'\]\)/,
    'effort applies to the three kinds whose CLI has a reasoning dial',
  );
  // fastMode（--settings）是 Claude Code 独有的机制，所以那个复选框只给 Claude。
  // 但 Codex **也有** fast —— 是 service_tier（priority 通道，1.5× 速度），
  // 走 CODEX_TIER_KINDS 那个独立控件。两者别混成一个开关。
  assert.match(CONTROLLER_SRC, /const FAST_KINDS = new Set\(\['claude'\]\)/, 'fastMode checkbox is Claude-only');
  assert.match(
    CONTROLLER_SRC,
    /if \(tuning\.showCodexTier && tuning\.codexSpeedTier !== 'inherit'\)/,
    'Codex 的 service_tier 只在用户显式选了非 inherit 时才传',
  );
  assert.match(
    CONTROLLER_SRC,
    /if \(tuning\.modelOptions\.length > 0 && tuning\.model\) opts\.model = tuning\.model/,
    'model is only sent for kinds that have a model list',
  );
  assert.match(
    CONTROLLER_SRC,
    /if \(tuning\.showEffort && tuning\.effort\) opts\.effort = tuning\.effort/,
    'effort is only sent for kinds that understand it',
  );
  assert.match(
    CONTROLLER_SRC,
    /if \(tuning\.showMcp\) opts\.mcpProfile = tuning\.mcpProfile/,
    'Claude and Codex both receive an explicit lean/browser/wireless/full MCP profile',
  );
  // 只在显式关掉时才传 fastMode，不传 = 沿用 session-manager 的"默认开"。
  assert.match(
    CONTROLLER_SRC,
    /if \(tuning\.showFast && tuning\.fastMode === false\) opts\.fastMode = false/,
    'fastMode must only be sent when the user explicitly turns it off',
  );
  // 默认档位不能漂：Codex 保持历史的 lean，Claude 必须是 full（= 全量继承 = 改动前行为）。
  assert.match(
    CONTROLLER_SRC,
    /const DEFAULT_MCP_BY_KIND = \{ claude: 'full', codex: 'lean', deepseek: 'lean' \}/,
    'Claude 默认 full，不能静默改成 lean 让会话少工具',
  );
  assert.match(CONTROLLER_SRC, /function resolveSessionTuning\(kind, modelId, selection = \{\}\)/,
    '新建 Session 与群聊成员必须共用一份动态调优定义');
  assert.match(CONTROLLER_SRC, /function buildSessionTuningOpts\(kind, modelId, selection = \{\}\)/,
    'provider-specific 参数过滤必须可供两个创建入口复用');
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
