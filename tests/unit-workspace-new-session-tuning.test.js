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
const RENDERER_SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
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
    'Claude and Codex both receive an explicit MCP profile, including Codex none',
  );
  // fastMode 只有"关"需要写字段（session-manager 全链路按 === false 判断）。
  // 2026-09-05 默认改成关之后，这条常态会写出 false，语义不变。
  assert.match(
    CONTROLLER_SRC,
    /if \(tuning\.showFast && tuning\.fastMode === false\) opts\.fastMode = false/,
    'fastMode must only be sent when it is off',
  );
  // 默认档位不能漂。2026-08-29 起三家统一 None：用户要求「只有我提到的时候才
  // 加载 superRAN」，而 superran 每个进程恒定提交 2.66 GB，默认加载是内存杀手。
  assert.match(
    CONTROLLER_SRC,
    /const DEFAULT_MCP_BY_KIND = \{ claude: 'none', codex: 'none', deepseek: 'none' \}/,
    '三家默认都必须是 None（不加载任何 MCP）',
  );
  // 2026-09-05：用户要求 Claude / Codex 两家的 fast 默认都关掉。
  // Codex 这一侧就是 service_tier=standard（显式关 Fast），不是 inherit ——
  // inherit 会跟着 ~/.codex/config.toml 走，那份配置里可能还开着 priority。
  assert.match(
    CONTROLLER_SRC,
    /const DEFAULT_CODEX_SPEED_BY_KIND = \{ codex: 'standard', deepseek: 'inherit' \}/,
    'Codex 默认必须显式关 Fast，且不能改变 DeepSeek 的继承语义',
  );
  assert.match(
    CONTROLLER_SRC,
    /if \(typeof tuning\.contextMax === 'number'\) opts\.contextMax = tuning\.contextMax/,
    'Sol 的 1M context 必须真正进入创建参数',
  );
  // 2026-09-05：Claude / Codex 默认思考强度从 max 降到 high。DeepSeek 没被点名，
  // 必须继续落在通用 DEFAULT_EFFORT('max')，所以这里同时守"没有 deepseek 键"。
  assert.match(
    CONTROLLER_SRC,
    /const DEFAULT_EFFORT_BY_KIND = \{ claude: 'high', codex: 'high' \}/,
    'Claude 与 Codex 的默认思考强度必须是 high',
  );
  assert.match(
    CONTROLLER_SRC,
    /const DEFAULT_EFFORT = 'max';/,
    '未点名的 kind 仍回落到通用默认 max',
  );
  assert.match(
    CONTROLLER_SRC,
    /function defaultEffortFor\(kind\) \{ return DEFAULT_EFFORT_BY_KIND\[kind\] \|\| DEFAULT_EFFORT; \}/,
    '默认强度必须按 kind 取，不能再有裸 DEFAULT_EFFORT 分支',
  );
  assert.doesNotMatch(
    CONTROLLER_SRC,
    /selectedEffort = \(saved && saved\.effort\) \|\| DEFAULT_EFFORT;/,
    '记忆回放也要走按 kind 的默认，否则切到 Claude 会拿回 max',
  );
  // 2026-09-05：Claude Fast 默认关。它更快出字，但交互式会话可能不落 transcript
  // （2026-06-11 实测），当默认值弊大于利。
  assert.match(
    CONTROLLER_SRC,
    /const DEFAULT_FAST_MODE = false;/,
    'Claude Fast 默认必须关闭',
  );
  // 下拉里的「默认」二字必须跟着真正的默认走。改了默认却留着旧标注，用户看到的
  // 是「选中 high，但 max 那行写着默认」——比不标注更糟。
  assert.match(CONTROLLER_SRC, /\['high', 'high · 默认'\]/, 'Claude 强度下拉必须把默认标在 high');
  assert.doesNotMatch(CONTROLLER_SRC, /'max · 默认/, 'max 不再是默认，不能继续标默认');
  assert.match(CONTROLLER_SRC, /\['standard', 'Standard · 默认，显式关闭 Fast'\]/,
    'Codex 速度通道必须把默认标在 Standard');
  assert.doesNotMatch(CONTROLLER_SRC, /'Fast · 默认/, 'Fast 不再是默认，不能继续标默认');
  assert.match(
    CONTROLLER_SRC,
    /fastMode: typeof selection\.fastMode === 'boolean' \? selection\.fastMode : DEFAULT_FAST_MODE/,
    '群聊成员卡片的 fast 初值必须来自同一个常量',
  );
  assert.doesNotMatch(
    CONTROLLER_SRC,
    /let selectedFastMode = true;/,
    '单会话弹窗不能再把 fast 初值写死成开',
  );
  assert.match(
    CONTROLLER_SRC,
    /estimatedMaxEffectiveContextWindow/,
    '创建界面必须把模型目录的预计有效窗口说清楚，不能把 1M 请求冒充已生效',
  );
  assert.match(CONTROLLER_SRC, /function resolveSessionTuning\(kind, modelId, selection = \{\}\)/,
    '新建 Session 与群聊成员必须共用一份动态调优定义');
  assert.match(CONTROLLER_SRC, /function buildSessionTuningOpts\(kind, modelId, selection = \{\}\)/,
    'provider-specific 参数过滤必须可供两个创建入口复用');
});

test('renderer persists and restores per-session speed and MCP tuning', () => {
  assert.match(RENDERER_SRC, /if \(typeof session\.fastMode === 'boolean'\) local\.fastMode = session\.fastMode/);
  assert.match(RENDERER_SRC, /if \(session\.codexSpeedTier\) local\.codexSpeedTier = session\.codexSpeedTier/);
  assert.match(RENDERER_SRC, /fastMode: typeof s\.fastMode === 'boolean' \? s\.fastMode : null/);
  assert.match(RENDERER_SRC, /codexSpeedTier: s\.codexSpeedTier \|\| null/);
  assert.match(RENDERER_SRC, /fastMode: typeof meta\.fastMode === 'boolean' \? meta\.fastMode : null/);
  assert.match(RENDERER_SRC, /codexSpeedTier: meta\.codexSpeedTier \|\| null/);
  assert.match(RENDERER_SRC, /contextEffectiveMax: typeof s\.contextEffectiveMax === 'number'/);
  assert.match(RENDERER_SRC, /contextEffectiveMax: typeof meta\.contextEffectiveMax === 'number'/);
  assert.doesNotMatch(RENDERER_SRC, /defaultCodexSpeedFor\(kind\)(?!\s*\{)/,
    'all default speed decisions must include the selected model capability');
  // 这条守的是上下文 chip 的悬浮说明必须把两个数分开讲：运行时实际给的窗口，
  // 和 Hub 启动时请求的窗口。两者会不一致，混成一个数就看不出模型降了档。
  // 2026-09-04：ce73d83 重排信息架构时把文案里的 "Codex " 前缀去掉了（这个 chip
  // 现在对所有 CLI 都显示，带 Codex 反而是错的），盯死旧文案的断言因此变红。
  // 改成盯这两个数必须同时在场，不再盯前缀。
  assert.match(RENDERER_SRC, /运行时有效窗口 \$\{s\.contextEffectiveMax/,
    '上下文提示必须给出运行时实际有效窗口');
  assert.match(RENDERER_SRC, /Hub 启动请求 \$\{s\.contextMax/,
    '上下文提示必须同时给出 Hub 启动时请求的窗口，好让降档一眼可见');
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
