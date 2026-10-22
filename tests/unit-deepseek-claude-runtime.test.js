'use strict';
// DeepSeek 跑在 Claude Code 上（2026-10-11）：环境构造、模型名映射、缺 Key、配置目录防封号底线、
// 旧三类 DeepSeek 会话的恢复路由，以及新建面板不再有 ChatGPT 入口。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const profile = require('../core/deepseek-claude-profile');
const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const CLAUDE_MODEL_RE = /claude|opus|sonnet|haiku|fable/i;

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  // SessionManager 的会话独占记录可能还开着句柄；清理失败不影响断言结果。
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {} });
  return dir;
}

function launchEnv(route, model, { configDir, config } = {}) {
  const env = {
    HTTP_PROXY: 'http://127.0.0.1:7890', https_proxy: 'http://127.0.0.1:7890', ALL_PROXY: 'socks5://x',
    ANTHROPIC_API_KEY: 'sk-ant-should-be-removed', ANTHROPIC_MODEL: 'claude-opus-5',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth-should-be-removed', ANTHROPIC_SMALL_FAST_MODEL: 'claude-haiku-4-5',
    CLAUDE_CONFIG_DIR: path.join(os.homedir(), '.claude'),
  };
  const baseEnv = { AI_HUB_DEEPSEEK_CLAUDE_CONFIG_DIR: configDir };
  const result = profile.applyLaunchEnv(env, {
    route, model, baseEnv,
    config: config || { acp: { apiKey: 'tp-key-1234' }, deepseekApiKey: 'ds-key-5678' },
  });
  return { env, result };
}

test('Token Plan route: endpoint, key and every Claude model variable point at the DeepSeek model', t => {
  const configDir = tempDir(t, 'ds-claude-cfg-');
  const { env, result } = launchEnv('tokenplan', 'deepseek-v4.1-flash', { configDir });
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'tp-key-1234');
  for (const key of profile.CLAUDE_MODEL_ENV_KEYS) assert.equal(env[key], 'deepseek-v4.1-flash', key);
  assert.deepEqual(profile.CLAUDE_MODEL_ENV_KEYS, ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']);
  assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, undefined);
  for (const key of ['HTTP_PROXY', 'https_proxy', 'ALL_PROXY']) assert.equal(env[key], undefined, key);
  assert.equal(env.CLAUDE_CONFIG_DIR, path.resolve(configDir));
  assert.deepEqual({ route: result.route, wire: result.wireModel }, { route: 'tokenplan', wire: 'deepseek-v4.1-flash' });
  for (const [key, value] of Object.entries(env)) {
    if (/MODEL/.test(key)) assert.doesNotMatch(String(value), CLAUDE_MODEL_RE, `${key} must not carry a Claude model name`);
  }
});

test('DeepSeek official API route uses its own endpoint, key and model names', t => {
  const configDir = tempDir(t, 'ds-claude-cfg-');
  const flash = launchEnv('api', 'deepseek-v4.1-flash', { configDir });
  assert.equal(flash.env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
  assert.equal(flash.env.ANTHROPIC_AUTH_TOKEN, 'ds-key-5678');
  for (const key of profile.CLAUDE_MODEL_ENV_KEYS) assert.equal(flash.env[key], 'deepseek-flash', key);
  const pro = launchEnv('api', 'deepseek-v4-pro', { configDir });
  for (const key of profile.CLAUDE_MODEL_ENV_KEYS) assert.equal(pro.env[key], 'deepseek-v4-pro', key);
});

test('model mapping: one display id per model, route-specific wire names, aliases fold back', () => {
  assert.equal(profile.DEFAULT_MODEL, 'deepseek-v4.1-flash');
  assert.equal(profile.DEFAULT_ROUTE, 'tokenplan');
  assert.equal(profile.wireModel('deepseek-v4.1-flash', 'tokenplan'), 'deepseek-v4.1-flash');
  assert.equal(profile.wireModel('deepseek-v4.1-flash', 'api'), 'deepseek-flash');
  assert.equal(profile.wireModel('deepseek-v4-pro', 'tokenplan'), 'deepseek-v4-pro');
  assert.equal(profile.wireModel('deepseek-v4-pro', 'api'), 'deepseek-v4-pro');
  assert.equal(profile.wireModel(undefined, undefined), 'deepseek-v4.1-flash');
  for (const id of ['deepseek-flash', 'deepseek-v4-flash', 'DeepSeek-V4.1-Flash']) {
    assert.equal(profile.normalizeModel(id), 'deepseek-v4.1-flash', id);
  }
  assert.equal(profile.normalizeModel('claude-opus-5'), 'deepseek-v4.1-flash');
  assert.equal(profile.isKnownModel('claude-opus-5'), false);
  const { MODEL_OPTIONS_BY_KIND, DEFAULT_MODEL_BY_KIND, modelSwitchStrategy } = require('../core/model-options');
  assert.deepEqual(MODEL_OPTIONS_BY_KIND['deepseek-claude'].map(o => o.id), ['deepseek-v4.1-flash', 'deepseek-v4-pro']);
  assert.equal(DEFAULT_MODEL_BY_KIND['deepseek-claude'], 'deepseek-v4.1-flash');
  assert.equal(modelSwitchStrategy('deepseek-claude'), 'claude-inline');
  // Codex 运行时 DeepSeek：2026-10-13 起默认 V4.1 Flash（官方名 deepseek-flash），切换方式不变
  assert.deepEqual(MODEL_OPTIONS_BY_KIND.deepseek.map(o => o.id), ['deepseek-flash', 'deepseek-v4-pro']);
  assert.equal(modelSwitchStrategy('deepseek'), 'codex-picker');
});

test('missing key fails loudly and never switches to the other route', t => {
  const configDir = tempDir(t, 'ds-claude-cfg-');
  assert.throws(() => launchEnv('tokenplan', null, { configDir, config: { acp: {}, deepseekApiKey: 'ds-key' } }),
    /Token Plan 套餐不可用[\s\S]*未切换到其他接入方式/);
  assert.throws(() => launchEnv('api', null, { configDir, config: { acp: { apiKey: 'tp' }, deepseekApiKey: '' } }),
    /DeepSeek 官方 API不可用[\s\S]*未切换到其他接入方式/);
  assert.throws(() => launchEnv('bogus', null, { configDir }), /接入方式无效/);
  const availability = profile.routeAvailability({ acp: {}, deepseekApiKey: 'ds-key' }, {});
  assert.equal(availability.tokenplan.available, false);
  assert.match(availability.tokenplan.reason, /Token Plan/);
  assert.equal(availability.api.available, true);
  // 未指定时默认 Token Plan
  assert.equal(profile.resolveLaunchRoute(undefined, { acp: { apiKey: 'tp' } }, {}).route, 'tokenplan');
});

test('CLAUDE_CONFIG_DIR is the isolated DeepSeek directory and refuses any Claude login', t => {
  assert.equal(profile.configDir({ USERPROFILE: 'C:\\Users\\x' }), path.join('C:\\Users\\x', '.claude-deepseek'));
  assert.notEqual(path.basename(profile.configDir({ USERPROFILE: 'C:\\Users\\x' })), '.claude');
  const clean = tempDir(t, 'ds-claude-clean-');
  fs.writeFileSync(path.join(clean, '.claude.json'), JSON.stringify({ userID: 'u', projects: {} }));
  assert.deepEqual(profile.claudeLoginEvidence(clean), []);
  assert.doesNotThrow(() => launchEnv('tokenplan', null, { configDir: clean }));

  const withCredentials = tempDir(t, 'ds-claude-creds-');
  fs.writeFileSync(path.join(withCredentials, '.credentials.json'), '{"claudeAiOauth":{}}');
  assert.throws(() => launchEnv('tokenplan', null, { configDir: withCredentials }), /Claude 登录信息[\s\S]*\.credentials\.json/);

  const withOauth = tempDir(t, 'ds-claude-oauth-');
  fs.writeFileSync(path.join(withOauth, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@b' } }));
  assert.throws(() => launchEnv('api', null, { configDir: withOauth }), /oauthAccount/);
});

test('the real ~/.claude-deepseek holds no Claude login (anti-ban floor on this machine)', t => {
  const real = profile.configDir(process.env);
  if (!fs.existsSync(real)) { t.skip('no ~/.claude-deepseek on this machine'); return; }
  assert.deepEqual(profile.claudeLoginEvidence(real), []);
});

test('permission defaults: pin bypass, disable auto mode, mark the auto-default nudge as seen', t => {
  const dir = tempDir(t, 'ds-claude-perm-');
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model: 'x', permissionMode: 'bypassPermissions',
    permissions: { allow: ['Bash(ls)'] }, hooks: { Stop: [] } }));
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, projects: { 'D:/w': { hasTrustDialogAccepted: true } } }));
  assert.deepEqual(profile.ensurePermissionDefaults(dir), { settings: 'written', state: 'written' });
  const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.deepEqual(settings.permissions, { allow: ['Bash(ls)'], defaultMode: 'bypassPermissions', disableAutoMode: 'disable' });
  assert.deepEqual(settings.hooks, { Stop: [] }, 'other settings untouched');
  const state = JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8'));
  assert.equal(state.hasSeenAutoDefaultNudge, true);
  assert.deepEqual(state.projects, { 'D:/w': { hasTrustDialogAccepted: true } });
  // 已经对了就不再写
  const mtimes = ['settings.json', '.claude.json'].map(f => fs.statSync(path.join(dir, f)).mtimeMs);
  assert.deepEqual(profile.ensurePermissionDefaults(dir), { settings: 'unchanged', state: 'unchanged' });
  assert.deepEqual(['settings.json', '.claude.json'].map(f => fs.statSync(path.join(dir, f)).mtimeMs), mtimes);
  assert.deepEqual(fs.readdirSync(dir).filter(f => f.endsWith('.tmp')), []);
});

test('permission defaults never invent .claude.json and never overwrite an unparsable file', t => {
  const fresh = tempDir(t, 'ds-claude-perm-fresh-');
  assert.deepEqual(profile.ensurePermissionDefaults(fresh), { settings: 'written', state: 'missing' });
  assert.equal(fs.existsSync(path.join(fresh, '.claude.json')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(fresh, 'settings.json'), 'utf8')).permissions.disableAutoMode, 'disable');
  const broken = tempDir(t, 'ds-claude-perm-broken-');
  fs.writeFileSync(path.join(broken, 'settings.json'), '{"half":');
  fs.writeFileSync(path.join(broken, '.claude.json'), '{"half":');
  assert.deepEqual(profile.ensurePermissionDefaults(broken), { settings: 'unparsable', state: 'unparsable' });
  assert.equal(fs.readFileSync(path.join(broken, 'settings.json'), 'utf8'), '{"half":');
  assert.equal(fs.readFileSync(path.join(broken, '.claude.json'), 'utf8'), '{"half":');
});

test('remembered route lives in Hub config and defaults to Token Plan', () => {
  assert.equal(profile.preferredRoute({}), 'tokenplan');
  assert.equal(profile.preferredRoute({ providers: { deepseek: { route: 'api' } } }), 'api');
  assert.equal(profile.preferredRoute({ providers: { deepseek: { route: 'junk' } } }), 'tokenplan');
  const merged = profile.withPreferredRoute({ providers: { deepseek: { api_key: 'k' }, codex: { a: 1 } } }, 'api');
  assert.deepEqual(merged.providers, { deepseek: { api_key: 'k', route: 'api' }, codex: { a: 1 } });
  assert.throws(() => profile.withPreferredRoute({}, 'x'), /无效/);
});

test('SessionManager launches deepseek-claude as a real PTY Claude Code with DeepSeek env', async t => {
  const root = tempDir(t, 'ds-claude-sm-');
  const dataDir = path.join(root, 'data');
  const configDir = path.join(root, 'claude-deepseek');
  const cwd = path.join(root, 'work');
  for (const dir of [dataDir, configDir, cwd]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    acp: { apiKey: 'tp-unit-key' }, providers: { deepseek: { api_key: 'ds-unit-key' } } }));
  const saved = {};
  for (const key of ['CLAUDE_HUB_DATA_DIR', 'CLAUDE_HUB_HOME_DIR', 'AI_HUB_DEEPSEEK_CLAUDE_CONFIG_DIR', 'DEEPSEEK_API_KEY',
    'ANTHROPIC_API_KEY', 'AI_HUB_TOKEN_PLAN_KEY']) saved[key] = process.env[key];
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  Object.assign(process.env, { CLAUDE_HUB_DATA_DIR: dataDir, CLAUDE_HUB_HOME_DIR: path.join(root, 'home'),
    AI_HUB_DEEPSEEK_CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_API_KEY: 'sk-ant-leak' });
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.AI_HUB_TOKEN_PLAN_KEY;
  require('../core/hub-config').clearConfigCache();

  const pty = require('node-pty');
  const spawned = [];
  t.mock.method(pty, 'spawn', (file, args, options) => {
    const dataHandlers = [];
    const fake = { file, args, options, pid: 424242, writes: [],
      onData(fn) { dataHandlers.push(fn); return { dispose() { const i = dataHandlers.indexOf(fn); if (i >= 0) dataHandlers.splice(i, 1); } }; },
      onExit() { return { dispose() {} }; },
      write(data) { fake.writes.push(String(data)); },
      resize() {}, kill() {}, emitData(data) { for (const fn of [...dataHandlers]) fn(data); } };
    spawned.push(fake);
    return fake;
  });
  const { SessionManager } = require('../core/session-manager');
  const manager = new SessionManager();
  const launches = [];
  t.after(() => {
    for (const { info } of launches) { try { manager.closeSession(info.id); } catch {} }
    try { manager.openOwners?.close(); } catch {}
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  });
  for (const [route, model, wire, url, key] of [
    ['tokenplan', undefined, 'deepseek-v4.1-flash', 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic', 'tp-unit-key'],
    ['api', 'deepseek-v4.1-flash', 'deepseek-flash', 'https://api.deepseek.com/anthropic', 'ds-unit-key'],
    ['api', 'deepseek-v4-pro', 'deepseek-v4-pro', 'https://api.deepseek.com/anthropic', 'ds-unit-key'],
  ]) {
    const info = manager.createSession('deepseek-claude', { cwd, deepseekRoute: route, ...(model ? { model } : {}) });
    const fake = spawned[spawned.length - 1];
    launches.push({ info, fake });
    assert.equal(fake.file, 'powershell.exe', 'runs a real PTY shell, not the native stream-json driver');
    assert.equal(info.agentRuntime, 'pty');
    assert.equal(info.runtimeBackend, null);
    assert.equal(info.kind, 'deepseek-claude');
    assert.equal(info.deepseekRoute, route);
    assert.equal(info.currentModel.id, model || 'deepseek-v4.1-flash');
    assert.equal(info.effort, 'high', 'Claude Code --effort default high');
    assert.equal(info.mcpProfile, 'none');
    assert.match(info.ccSessionId, /^[0-9a-f-]{36}$/, 'identity is pre-assigned like Claude PTY');
    const env = fake.options.env;
    assert.equal(env.ANTHROPIC_BASE_URL, url);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, key);
    for (const name of profile.CLAUDE_MODEL_ENV_KEYS) assert.equal(env[name], wire, name);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
    assert.equal(path.resolve(env.CLAUDE_CONFIG_DIR), path.resolve(configDir));
    assert.equal(env.CLAUDE_HUB_SESSION_ID, info.id, 'hook attribution like Claude sessions');
    // 启动命令：首屏安静后写入一次
    fake.emitData('PS> ');
    await new Promise(resolve => setTimeout(resolve, 300));
    const cmd = fake.writes.join('');
    assert.match(cmd, /^ claude /);
    assert.match(cmd, new RegExp(`--model ${wire.replace(/\./g, '\\.')}(?:\\s|$)`));
    assert.match(cmd, /--effort high/);
    assert.match(cmd, new RegExp(`--session-id ${info.ccSessionId}`));
    // ~/.claude-deepseek 不继承主 Claude 的 defaultMode；不带参数会落进 auto 模式（2026-10-13 实测）。
    assert.match(cmd, /--permission-mode bypassPermissions(?:\s|$)/, 'DeepSeek sessions launch in bypass, not the CLI default auto mode');
    const models = [...cmd.matchAll(/--model (\S+)/g)].map(m => m[1]);
    assert.deepEqual(models, [wire], 'exactly one --model and it is the DeepSeek wire name');
    for (const value of models) assert.doesNotMatch(value, CLAUDE_MODEL_RE, 'launch command carries no Claude model name');
    // 原地重拉（新的 Claude 进程）同样带旁路
    const before = fake.writes.length;
    assert.equal(manager.relaunchCli(info.id), true);
    const relaunch = fake.writes.slice(before).join('');
    assert.match(relaunch, / claude --model /);
    assert.match(relaunch, /--permission-mode bypassPermissions(?:\s|$)/, 'in-place relaunch keeps bypass');
  }
  assert.equal(fs.existsSync(path.join(configDir, '.credentials.json')), false);
  // 每次启动都把独立配置目录的权限默认值钉住（Claude Code 升级后的「改默认为 auto」询问不再出现）
  const pinned = JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8'));
  assert.deepEqual(pinned.permissions, { defaultMode: 'bypassPermissions', disableAutoMode: 'disable' });
});

test('missing key at creation throws instead of silently using the other route', async t => {
  const root = tempDir(t, 'ds-claude-sm-nokey-');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ providers: { deepseek: { api_key: 'ds-only' } } }));
  const saved = { a: process.env.CLAUDE_HUB_DATA_DIR, b: process.env.AI_HUB_DEEPSEEK_CLAUDE_CONFIG_DIR, c: process.env.AI_HUB_TOKEN_PLAN_KEY };
  t.after(() => {
    if (saved.a === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = saved.a;
    if (saved.b === undefined) delete process.env.AI_HUB_DEEPSEEK_CLAUDE_CONFIG_DIR; else process.env.AI_HUB_DEEPSEEK_CLAUDE_CONFIG_DIR = saved.b;
    if (saved.c === undefined) delete process.env.AI_HUB_TOKEN_PLAN_KEY; else process.env.AI_HUB_TOKEN_PLAN_KEY = saved.c;
    require('../core/hub-config').clearConfigCache();
  });
  process.env.CLAUDE_HUB_DATA_DIR = dataDir;
  process.env.AI_HUB_DEEPSEEK_CLAUDE_CONFIG_DIR = path.join(root, 'cfg');
  delete process.env.AI_HUB_TOKEN_PLAN_KEY;
  require('../core/hub-config').clearConfigCache();
  const pty = require('node-pty');
  let spawns = 0;
  t.mock.method(pty, 'spawn', () => { spawns++; throw new Error('must not spawn'); });
  const { SessionManager } = require('../core/session-manager');
  const manager = new SessionManager();
  t.after(() => {
    try { manager.openOwners?.close(); } catch {}
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  });
  assert.throws(() => manager.createSession('deepseek-claude', { cwd: root, deepseekRoute: 'tokenplan' }),
    /Token Plan 套餐不可用/);
  assert.equal(spawns, 0);
});

test('old DeepSeek sessions keep their original runtimes on resume', () => {
  const resume = read('main/ipc/resume-session-handlers.js');
  // Codex 运行时 deepseek：codexSid / rollout 走 Codex；迁移前 Claude 兼容走 deepseekLegacyClaude。
  assert.match(resume, /const isLegacyDeepSeek = isDeepSeek && !!meta\.ccSessionId && !meta\.codexSid;/);
  assert.match(resume, /const isCodexRuntime = isCodexBaseKind\(meta\.kind\) && !isLegacyDeepSeek;/);
  assert.match(resume, /\.\.\.\(isLegacyDeepSeek \? \{ deepseekLegacyClaude: true \} : \{\}\)/);
  assert.match(resume, /\.\.\.\(meta\.deepseekRoute \? \{ deepseekRoute: meta\.deepseekRoute \} : \{\}\)/);
  const kinds = require('../core/ai-kinds');
  assert.equal(kinds.isCodexCliKind('deepseek'), true, 'Codex-runtime DeepSeek stays on Codex');
  assert.equal(kinds.isClaudeFamily('deepseek'), false);
  assert.equal(kinds.isClaudeFamily('deepseek-claude'), true);
  assert.equal(kinds.isCodexCliKind('deepseek-claude'), false);
  assert.equal(require('../core/acp-profiles').isAcpKind('deepseek-acp'), true, 'DSH sessions keep the ACP runtime');
  const { runtimeKindForSession, sessionProviderFamily, sessionModelId } = require('../core/session-capabilities');
  assert.equal(sessionProviderFamily({ kind: 'deepseek', codexSid: 'x', ccSessionId: null }), 'codex');
  assert.equal(runtimeKindForSession({ kind: 'deepseek', ccSessionId: 'c' }), 'deepseek-legacy');
  assert.equal(sessionProviderFamily({ kind: 'deepseek', ccSessionId: 'c' }), 'claude');
  assert.equal(sessionProviderFamily({ kind: 'deepseek-claude', ccSessionId: 'c' }), 'claude');
  assert.equal(sessionModelId({ kind: 'deepseek-claude', currentModel: { id: 'deepseek-flash' } }), 'deepseek-v4.1-flash');
  // session-manager：三类旧会话各自的分支
  const sm = read('core/session-manager.js');
  assert.match(sm, /const isDeepSeekLegacy = isDeepSeek && !!opts\.deepseekLegacyClaude;/);
  assert.match(sm, /: isNativeClaude \? createNativeClaudeDriver\(id, kind, opts, spawnCwd, sessionEnv, isDeepSeekLegacy\)/);
  assert.match(sm, /const isNativeClaude = \(isClaude && nativeAgentRuntime\) \|\| isDeepSeekLegacy;/,
    'only the legacy compatibility path uses the native driver; deepseek-claude is PTY');
  // 分支沿用 DeepSeek on Claude Code 与接入方式
  const { planSessionFork } = require('../core/session-fork-plan');
  const plan = planSessionFork({ source: { id: 's1', kind: 'deepseek-claude', ccSessionId: '11111111-1111-4111-8111-111111111111',
    cwd: 'C:\\w', deepseekRoute: 'api', currentModel: { id: 'deepseek-v4-pro' } }, siblingPool: [], runtimeKind: 'deepseek-claude' });
  assert.equal(plan.ok, true);
  assert.equal(plan.kind, 'deepseek-claude');
  assert.equal(plan.opts.deepseekRoute, 'api');
  assert.equal(plan.opts.forkCCSessionId, '11111111-1111-4111-8111-111111111111');
});

test('new-session panel defaults to DSH while legacy Claude routes remain compatible', () => {
  const html = read('renderer/index.html');
  assert.doesNotMatch(html, /data-kind="chatgpt"/);
  assert.doesNotMatch(html, /chatgpt-web-panel/);
  const route = html.match(/<select id="new-session-deepseek-route"[^>]*>([\s\S]*?)<\/select>/);
  assert.ok(route, 'DeepSeek route select exists');
  assert.deepEqual([...route[1].matchAll(/value="([^"]+)"/g)].map(m => m[1]), ['tokenplan', 'api']);
  assert.doesNotMatch(route[1], /Codex CLI|旧 Harness/);
  assert.match(html, /data-kind="deepseek"[^>]*>.*DeepSeek<\/button>/);
  const controller = read('renderer/workspace-controller.js');
  assert.doesNotMatch(controller, /chatgpt: 'ChatGPT'/);
  assert.match(controller, /if \(DEEPSEEK_PANEL_KINDS\.has\(kind\)\) return 'deepseek-acp';/);
  assert.match(controller, /'deepseek-claude': 'DeepSeek · Claude Code'/);
  assert.match(controller, /if \(selectedKind === 'deepseek-claude'\) opts\.deepseekRoute = deepseekRoute;/);
  const modal = read('renderer/meeting-create-modal.js');
  assert.match(modal, /HIDDEN_CREATE_KINDS = new Set\(\['chatgpt', 'deepseek', 'deepseek-claude'\]\)/);
  assert.doesNotMatch(modal, /Codex CLI · DeepSeek API|Token Plan · 旧 Harness/);
  const room = read('renderer/meeting-room.js');
  assert.match(room, /\['claude', 'codex', 'deepseek-acp', 'qwen', 'glm', 'gemini'/);
  assert.doesNotMatch(room, /\['claude', 'codex', 'deepseek', 'qwen', 'deepseek-acp'/);
});

// ── Token Plan 额度用完：与 DeepSeek 旧 Harness 同一套改道（core/token-plan-fallback.js）──
const fallback = require('../core/token-plan-fallback');
const { createTokenPlanFallbackController, CONTINUATION_NOTE } = require('../main/token-plan-fallback-controller');
const QUOTA_RAW = 'Your token-plan 1-month quota has been exhausted. The quota will reset at 10-12 16:00:00 UTC.';

function ccHarness(t, { deepseekApiKey = 'ds-key', route = 'tokenplan' } = {}) {
  const dataDir = tempDir(t, 'ds-claude-fb-');
  const session = { id: 's1', kind: 'deepseek-claude', deepseekRoute: route, deepseekActiveRoute: route,
    currentModel: { id: 'deepseek-v4.1-flash', displayName: 'DS V4.1 Flash · Token Plan' } };
  const restarts = [], sends = [], notices = [];
  const controller = createTokenPlanFallbackController({
    sessionManager: { getSession: () => session, getNativeSession: () => null },
    dataDir, settleMs: 0, logger: { log() {}, warn() {} },
    getConfig: () => ({ deepseekApiKey }),
    notify: (id, message) => notices.push([id, message]),
    restartSession: async (id, overrides, options) => {
      restarts.push([id, overrides, options]);
      const planRoute = fallback.resolveRoute({ config: { deepseekApiKey }, dataDir, kind: session.kind }).route;
      session.deepseekActiveRoute = session.deepseekRoute === 'tokenplan' && planRoute === 'deepseek' ? 'api' : session.deepseekRoute;
      return { id };
    },
    sendToPty: async (id, text, kind, options) => { sends.push({ id, text, kind, options }); return { ok: true }; },
  });
  return { controller, session, restarts, sends, notices, dataDir };
}

test('Claude Code DeepSeek on Token Plan: quota wall reroutes to the official API and resends once', async t => {
  const h = ccHarness(t);
  assert.equal(fallback.canFallback('deepseek-claude'), true);
  assert.equal(h.controller.routeOf(h.session), 'token-plan');
  h.controller.onClaudeHook('s1', 'prompt', { prompt: '回复 OK' });
  assert.equal(h.controller.onClaudeHook('s1', 'stop-failure', { error: 'rate_limit',
    lastAssistantMessage: 'API Error: 429 {"error":{"type":"insufficient_quota","message":"' + QUOTA_RAW + '"}}', turnId: 't1' }), true);
  // 同一轮的 Stop 也带同样原文：不重复改道
  h.controller.onClaudeHook('s1', 'stop-failure', { error: 'rate_limit', lastAssistantMessage: 'API Error: 429 ' + QUOTA_RAW, turnId: 't1' });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(h.restarts, [['s1', null, { relaunch: true }]]);
  assert.equal(h.session.deepseekActiveRoute, 'api');
  assert.equal(h.controller.routeOf(h.session), 'deepseek');
  assert.equal(h.sends.length, 1);
  assert(h.sends[0].text.startsWith(CONTINUATION_NOTE) && h.sends[0].text.endsWith('回复 OK'));
  assert.equal(h.sends[0].options.requireReady, true, 'PTY Claude Code waits for its TUI after the restart');
  assert.match(h.notices.at(-1)[1], /暂用 DeepSeek API/);
  assert(fallback.exhaustedUntil(h.dataDir) > 0);
});

test('Claude Code DeepSeek chosen on the official API never takes part in the fallback', () => {
  const h = ccHarness(t_stub(), { route: 'api' });
  assert.equal(h.controller.routeOf(h.session), null);
  assert.equal(h.controller.onClaudeHook('s1', 'stop-failure', { lastAssistantMessage: QUOTA_RAW }), false);
});
function t_stub() { return { after() {} }; }

test('Claude Code DeepSeek without a DeepSeek key waits for the reset and refuses sends with the reason', async t => {
  const h = ccHarness(t, { deepseekApiKey: '' });
  fallback.markExhausted(h.dataDir, { resetsAt: Date.now() + 3600_000 });
  await assert.rejects(h.controller.beforeSend('s1'), /Token Plan 本月额度已用完[\s\S]*没有配置 DeepSeek API Key[\s\S]*消息未发送/);
  assert.deepEqual(h.restarts, []);
});

test('launch while the plan is exhausted starts on the official API and keeps the user choice', async t => {
  const root = tempDir(t, 'ds-claude-fb-sm-');
  const dataDir = path.join(root, 'data'), configDir = path.join(root, 'cfg');
  fs.mkdirSync(dataDir, { recursive: true }); fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ acp: { apiKey: 'tp' }, providers: { deepseek: { api_key: 'ds' } } }));
  fallback.markExhausted(dataDir, { resetsAt: Date.now() + 3600_000 });
  const saved = { a: process.env.CLAUDE_HUB_DATA_DIR, b: process.env.AI_HUB_DEEPSEEK_CLAUDE_CONFIG_DIR };
  process.env.CLAUDE_HUB_DATA_DIR = dataDir; process.env.AI_HUB_DEEPSEEK_CLAUDE_CONFIG_DIR = configDir;
  require('../core/hub-config').clearConfigCache();
  const pty = require('node-pty');
  const spawned = [];
  t.mock.method(pty, 'spawn', (file, args, options) => {
    const fake = { options, pid: 1, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, write() {}, resize() {}, kill() {} };
    spawned.push(fake); return fake;
  });
  const { SessionManager } = require('../core/session-manager');
  const manager = new SessionManager();
  const notices = [];
  manager.on('session-notice', event => notices.push(event));
  let info;
  t.after(() => {
    try { if (info) manager.closeSession(info.id); } catch {}
    try { manager.openOwners?.close(); } catch {}
    if (saved.a === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = saved.a;
    if (saved.b === undefined) delete process.env.AI_HUB_DEEPSEEK_CLAUDE_CONFIG_DIR; else process.env.AI_HUB_DEEPSEEK_CLAUDE_CONFIG_DIR = saved.b;
    require('../core/hub-config').clearConfigCache();
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  });
  info = manager.createSession('deepseek-claude', { cwd: root, deepseekRoute: 'tokenplan' });
  assert.equal(info.deepseekRoute, 'tokenplan', 'the user choice is kept for the switch back');
  assert.equal(info.deepseekActiveRoute, 'api');
  assert.equal(spawned[0].options.env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
  assert.equal(spawned[0].options.env.ANTHROPIC_MODEL, 'deepseek-flash');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.match(notices[0] && notices[0].message || '', /暂用 DeepSeek API/);
});

test('without a CLAUDE_HUB_DATA_DIR the e2e proxy override is ignored', t => {
  const configDir = tempDir(t, 'ds-claude-cfg-');
  const env = {};
  profile.applyLaunchEnv(env, { route: 'tokenplan', config: { acp: { apiKey: 'k' } },
    baseEnv: { AI_HUB_DEEPSEEK_CLAUDE_CONFIG_DIR: configDir, AI_HUB_E2E_DEEPSEEK_ROUTE_PROXY: 'http://127.0.0.1:9' } });
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic');
});
