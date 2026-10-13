'use strict';
// 写作成员专用的 Codex 配置目录（core/writing/codex-writing-home.js）与 Claude 写作启动参数。
// 2026-10-11 田哥要求：写作成员的上下文完全为写作而生，不带个人协作约定、记忆、技能清单、插件。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const homes = require('../core/writing/codex-writing-home.js');
const { buildClaudeNativeArgs, claudeNativeResumeConfig } = require('../core/claude-native-launch.js');

function tmp(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), `writing-home-${tag}-`)); }
function auth(account, refreshed, token = 'x') {
  return JSON.stringify({ OPENAI_API_KEY: null, tokens: { account_id: account, refresh_token: token }, last_refresh: refreshed }, null, 2);
}

const SOURCE_CONFIG = `forced_login_method = "chatgpt"
model = "gpt-6-astra"
model_reasoning_effort = "high"
developer_instructions = "写代码前先跑测试"
notify = [
  "C:\\\\x\\\\computer-use.exe",
  "turn-ended",
]
features.tool_suggest = true
project_root_markers = [".git", ".vibe-root"]

[features]
memories = true

[mcp_servers.playwright]
command = "npx"

[plugins."browser@openai-bundled"]
enabled = true

[marketplaces.openai-bundled]
source = "x"

[model_providers.deepseek]
name = "DeepSeek"
env_key = "DEEPSEEK_API_KEY"

[windows]
sandbox = "elevated"

[projects.'c:\\users\\lintian']
trust_level = "trusted"

[memories]
enabled = true
`;

test('写作配置：只带模型与接口，关掉记忆、技能说明、插件和项目文档；保留 Hub 自己写的信任表', () => {
  const existing = `[projects."C:\\\\AIWork\\\\写作台\\\\a"]\ntrust_level = "trusted"\n\n[hooks.state.'C:\\\\w\\\\hooks.json:stop:0:0']\ntrusted_hash = "abc"\n\n[mcp_servers.old]\ncommand = "x"\n`;
  const text = homes.buildWritingConfig(SOURCE_CONFIG, existing);
  for (const keep of ['model = "gpt-6-astra"', 'model_reasoning_effort = "high"', 'forced_login_method = "chatgpt"',
    '[model_providers.deepseek]', 'env_key = "DEEPSEEK_API_KEY"', '[windows]', 'project_root_markers']) assert.ok(text.includes(keep), keep);
  for (const drop of ['developer_instructions', 'computer-use', '[mcp_servers', '[plugins', '[marketplaces', "c:\\users\\lintian'", '[memories]\nenabled = true'])
    assert.ok(!text.includes(drop), `不带：${drop}`);
  for (const setting of ['project_doc_max_bytes = 0', 'memories = false', 'plugins = false', 'apps = false', 'include_instructions = false',
    'include_permissions_instructions = false', 'include_collaboration_mode_instructions = false']) assert.ok(text.includes(setting), setting);
  assert.ok(text.includes('写作台') && text.includes('trusted_hash = "abc"'), 'Hub 写进来的信任目录与 hook 信任保留');
  assert.strictEqual((text.match(/^\[features\]$/gm) || []).length, 1, '只有一个 [features] 表');
  assert.ok(!text.includes('turn-ended') && !text.includes('features.tool_suggest'), '多行数组整条丢掉；点号写法的功能开关不带（会和 [features] 表冲突）');
  require('../core/toml-statements').scanTomlStatements(text);
  // 根级键必须在第一个表头之前，否则 TOML 会把它们归到前一张表里
  const firstTable = text.search(/^\[/m);
  assert.ok(text.indexOf('project_doc_max_bytes = 0') < firstTable && text.indexOf('model = "gpt-6-astra"') < firstTable);
});

test('写作目录：没有全局规则；登录文件与原账号是同一个文件；DeepSeek 单独一个目录', () => {
  const root = tmp('a');
  const hub = path.join(root, 'hub');
  const source = path.join(root, '.codex');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'config.toml'), SOURCE_CONFIG);
  fs.writeFileSync(path.join(source, 'AGENTS.md'), '# 个人协作约定');
  fs.writeFileSync(path.join(source, 'auth.json'), auth('acc-1', '2026-10-10T00:00:00Z'));
  const first = homes.prepareWritingCodexHome({ sourceHome: source, hubDataDir: hub, family: 'codex' });
  assert.strictEqual(path.dirname(first.home), path.join(hub, 'writing-codex-homes'));
  assert.ok(/^codex-codex-[0-9a-f]{8}$/.test(path.basename(first.home)), '每个订阅账号各一个写作目录');
  assert.ok(homes.isWritingHome(first.home, hub) && !homes.isWritingHome(source, hub));
  assert.strictEqual(first.auth, 'linked');
  assert.ok(!fs.existsSync(path.join(first.home, 'AGENTS.md')), '不放个人协作约定');
  // 原地刷新令牌（Codex 的写法），两边看到同一份
  fs.writeFileSync(path.join(source, 'auth.json'), auth('acc-1', '2026-10-11T00:00:00Z', 'new'));
  assert.ok(fs.readFileSync(path.join(first.home, 'auth.json'), 'utf8').includes('"new"'));
  // 有人往写作目录塞了规则文件，下次启动清掉
  fs.writeFileSync(path.join(first.home, 'AGENTS.md'), '# 混进来的规则');
  homes.prepareWritingCodexHome({ sourceHome: source, hubDataDir: hub, family: 'codex' });
  assert.ok(!fs.existsSync(path.join(first.home, 'AGENTS.md')));
  const ds = homes.prepareWritingCodexHome({ sourceHome: source, hubDataDir: hub, family: 'deepseek' });
  assert.strictEqual(ds.home, path.join(hub, 'writing-codex-homes', 'deepseek'));
  const second = path.join(root, 'second');
  fs.mkdirSync(second);
  fs.writeFileSync(path.join(second, 'auth.json'), auth('acc-2', '2026-10-10T00:00:00Z'));
  const other = homes.prepareWritingCodexHome({ sourceHome: second, hubDataDir: hub });
  assert.notStrictEqual(other.home, first.home, '换账号用另一个写作目录：旧账号会话刷新令牌不会写进新账号');
  assert.ok(fs.readFileSync(path.join(first.home, 'auth.json'), 'utf8').includes('acc-1'));
  const noAuth = path.join(root, 'ds-profile');
  fs.mkdirSync(noAuth);
  fs.writeFileSync(path.join(noAuth, 'config.toml'), 'model = "deepseek-v4-pro"\nmodel_provider = "deepseek"\n');
  assert.strictEqual(homes.prepareWritingCodexHome({ sourceHome: noAuth, hubDataDir: hub, family: 'deepseek' }).auth, 'none', 'DeepSeek 用环境变量里的 key，没有登录文件');
});

test('登录文件链接被换掉：同一账号保留较新的令牌；换了账号直接改链，不回写', () => {
  const root = tmp('b');
  const hub = path.join(root, 'hub');
  const source = path.join(root, '.codex');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'config.toml'), 'model = "gpt-6-astra"\n');
  fs.writeFileSync(path.join(source, 'auth.json'), auth('acc-1', '2026-10-10T00:00:00Z', 'old'));
  const { home } = homes.prepareWritingCodexHome({ sourceHome: source, hubDataDir: hub });
  const dst = path.join(home, 'auth.json');
  // 别的程序用改名覆盖的方式写了写作目录的登录文件 → 链接断开，且写作这边更新
  fs.unlinkSync(dst);
  fs.writeFileSync(dst, auth('acc-1', '2026-10-12T00:00:00Z', 'newer'));
  assert.strictEqual(homes.linkAuth(source, home), 'linked');
  assert.ok(fs.readFileSync(path.join(source, 'auth.json'), 'utf8').includes('"newer"'), '同一账号：较新的令牌写回原账号');
  // 田哥切换到另一个账号目录：写作目录里的旧账号令牌不能写进新账号
  const other = path.join(root, 'second');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'auth.json'), auth('acc-2', '2026-10-01T00:00:00Z', 'second'));
  assert.strictEqual(homes.linkAuth(other, home), 'linked');
  assert.ok(fs.readFileSync(path.join(other, 'auth.json'), 'utf8').includes('"second"'), '换账号不回写');
  assert.ok(fs.readFileSync(dst, 'utf8').includes('acc-2'));
});

test('恢复旧写作会话：记录不在写作目录时，Hub 留在原目录（按 id 查会话记录）', () => {
  const root = tmp('c');
  const sessions = path.join(root, 'sessions', '2026', '10', '11');
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, 'rollout-2026-10-11T22-07-03-01a12b49-df04.jsonl'), '{}\n');
  assert.strictEqual(homes.hasRollout(root, '01a12b49-df04'), true);
  assert.strictEqual(homes.hasRollout(root, 'ffff'), false);
  assert.strictEqual(homes.hasRollout(path.join(root, 'nope'), '01a12b49'), false);
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'session-manager.js'), 'utf8');
  assert.ok(src.includes("isCleanPurpose(opts.purpose) && !webRoute") && require('../core/session-scenes').isCleanPurpose('writing')
    && src.includes('hasRollout(target, resumeSid)'), '启动时按写作用途（及场景会话）换目录，旧会话留在原目录');
  assert.ok(src.includes('historyInWritingHome') && src.includes('historySqliteHomeSync(historyHome'), '换账号后恢复写作会话走跨账号恢复');
  assert.ok(src.includes('if (isNativeCodex) {') && src.includes('writingContextWarning'), '原生后端不换目录，并写明降级');
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  assert.ok(renderer.includes('写作上下文降级'), '降级在状态栏看得见');
  assert.ok(src.includes('instructions: !writingCodexHome'), '写作目录不同步个人规则正文');
  assert.ok(src.includes("!(require('./session-scenes').isCleanPurpose(opts.purpose) && contextKind !== 'codex')"), 'Claude 写作成员（及场景会话）不同步个人规则');
});

test('个人规则同步：instructions:false 只同步守卫，不写规则正文', () => {
  const root = tmp('d');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(home, '.agents', 'USER_CONTEXT.md'), '# 个人协作约定\n');
  const dataDir = path.join(home, '.claude-session-hub');
  const native = path.join(dataDir, 'writing-codex-homes', 'codex');
  const { syncNativeUserContext } = require('../core/agent-user-context.js');
  const env = { CLAUDE_HUB_HOME_DIR: home, USERPROFILE: home };
  const result = syncNativeUserContext({ kind: 'codex', nativeHome: native, env, dataDir, instructions: false });
  assert.ok(result && result.path === null);
  assert.ok(!fs.existsSync(path.join(native, 'AGENTS.md')));
  const normal = syncNativeUserContext({ kind: 'codex', nativeHome: path.join(dataDir, 'x'), env, dataDir });
  assert.ok(fs.existsSync(normal.path), '其他会话照常同步');
});

test('Claude 写作启动参数：系统提示整份替换，关技能，只留写作工具；恢复时带回同样的参数', () => {
  const args = buildClaudeNativeArgs({ model: 'opus', effort: 'high', systemPromptFile: 'C:\\w\\AGENTS.md',
    appendSystemPromptFile: 'C:\\other.md', disableSlashCommands: true, noChrome: true, tools: ['Read', 'Write', 'WebSearch'] });
  assert.ok(args.includes('--no-chrome'), '不带浏览器扩展说明');
  assert.ok(args.includes('--system-prompt-file') && args[args.indexOf('--system-prompt-file') + 1] === 'C:\\w\\AGENTS.md');
  assert.ok(!args.includes('--append-system-prompt-file'), '替换就不再追加');
  assert.ok(args.includes('--disable-slash-commands'));
  assert.strictEqual(args[args.indexOf('--tools') + 1], 'Read,Write,WebSearch');
  assert.throws(() => buildClaudeNativeArgs({ model: 'opus', effort: null, tools: ['Read;rm'] }), /tool name/);
  const plain = buildClaudeNativeArgs({ model: 'opus', effort: null, appendSystemPromptFile: 'C:\\x.md' });
  assert.ok(plain.includes('--append-system-prompt-file') && !plain.includes('--tools') && !plain.includes('--disable-slash-commands') && !plain.includes('--no-chrome'), '其他会话不受影响');
  const resume = claudeNativeResumeConfig({ systemPromptFile: 'C:\\w\\AGENTS.md', disableSlashCommands: true, claudeTools: ['Read'] });
  assert.deepStrictEqual(resume, { systemPromptFile: 'C:\\w\\AGENTS.md', disableSlashCommands: true, claudeTools: ['Read'] });
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'session-manager.js'), 'utf8');
  assert.strictEqual((src.match(/systemPromptFile: opts\.systemPromptFile/g) || []).length, 2, 'PTY 与原生两条启动路径都接上');
  assert.strictEqual((src.match(/outputStyle: String\(opts\.claudeOutputStyle\)/g) || []).length, 2, '两条路径都用回默认输出风格');
});
