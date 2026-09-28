'use strict';

// setup.ps1 写的配置键 ←→ Hub 实际读的配置键，契约守卫。
//
// 2026-09-28 查出来的真事：团队一键安装脚本 setup.ps1 把 Claude 的网关配置写进
// `providers.meridian.{url,token}`，而 Hub 唯一的读配置入口 core/hub-config.js 读的是
// `providers.claude.{backend,api_key,base_url}`。全仓检索 providers.meridian 的消费方
// 只有 setup.ps1 自己 —— 也就是说组员照 README 装完，Claude 根本不走团队网关，而
// README 承诺的是"零手工配置走团队共享订阅"。
//
// 这类 bug 没有任何报错：脚本打绿色 OK，Hub 正常启动，只是 Claude 悄悄走了订阅
// 分支。根因是两边分头演进 —— setup.ps1 最后改于 2026-06-12，hub-config.js 改到
// 2026-09-25。所以这里不做字符串比对，而是**真的执行 setup.ps1 里内嵌的那段
// 写配置 JS**，再用 Hub 自己的 getConfig() 读回来，一路断言到 session-manager
// 最终注入给 CLI 的环境变量。脚本和代码哪一边再漂移，合并闸门就会红。
//
// Claude 和 Codex 两条都验（AGENTS.md：CLI 能力平等覆盖，只做 Claude 等于半个功能）。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SETUP_PS1 = path.join(ROOT, 'setup.ps1');

const GATEWAY_URL = 'https://gateway.example.test:8443';
const TOKEN = 'a'.repeat(64);
const CLAUDE_MODEL = 'claude-sonnet-4-5';
const CODEX_MODEL = 'gpt-5.5';

/** 把 setup.ps1 里 `$<名字> = @'...'@` 这段 here-string 原样抠出来。 */
function extractSnippet(varName) {
  const ps1 = fs.readFileSync(SETUP_PS1, 'utf8');
  // 字符串切分而不是正则：here-string 的定界符里全是正则元字符，转义一层层叠
  // 上去只会把测试自己搞坏（本轮已经踩过一次）。
  const marker = `$${varName} = @'`;
  const start = ps1.indexOf(marker);
  assert.ok(start >= 0, `setup.ps1 里找不到 $${varName} 这段内嵌脚本（结构变了就更新本测试）`);
  const bodyStart = ps1.indexOf('\n', start) + 1;
  const end = ps1.indexOf("\n'@", bodyStart);
  assert.ok(end > bodyStart, `$${varName} 的 here-string 没有闭合`);
  return ps1.slice(bodyStart, end);
}

/**
 * 在隔离数据目录里跑一遍 setup.ps1 的写配置逻辑，返回 config.json 的解析结果和目录。
 * 调用方负责清理。
 */
function runMergeScript({ seedConfig } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-setup-contract-'));
  const cfgPath = path.join(dataDir, 'config.json');
  if (seedConfig) fs.writeFileSync(cfgPath, JSON.stringify(seedConfig, null, 2), 'utf8');

  const jsPath = path.join(dataDir, 'merge.js');
  fs.writeFileSync(jsPath, extractSnippet('JsWriteGateway'), 'utf8');
  execFileSync(process.execPath, [jsPath, cfgPath, GATEWAY_URL, TOKEN, CLAUDE_MODEL, CODEX_MODEL], {
    stdio: 'pipe',
  });

  return { dataDir, cfgPath, config: JSON.parse(fs.readFileSync(cfgPath, 'utf8')) };
}

/** 用隔离的 CLAUDE_HUB_DATA_DIR 读一次 Hub 配置，读完把进程 env 和两层缓存都还原。 */
function readHubConfig(dataDir) {
  const hubConfig = require(path.join(ROOT, 'core', 'hub-config.js'));
  const sessionManager = require(path.join(ROOT, 'core', 'session-manager.js'));
  const prev = process.env.CLAUDE_HUB_DATA_DIR;
  // getConfigValue 的优先级是 env > config.json，进程里残留的 HUB_* 变量会盖掉
  // 我们刚写的文件，测试就测了个寂寞。这里全部摘掉，测完还原。
  const envKeys = [
    'HUB_CLAUDE_BACKEND', 'HUB_CLAUDE_API_KEY', 'HUB_CLAUDE_API_BASE_URL', 'HUB_CLAUDE_API_MODEL',
    'HUB_CODEX_BACKEND', 'HUB_CODEX_API_KEY', 'HUB_CODEX_API_BASE_URL', 'HUB_CODEX_API_MODEL',
    'HUB_CODEX_API_PROVIDER',
  ];
  const saved = new Map(envKeys.map((k) => [k, process.env[k]]));
  try {
    process.env.CLAUDE_HUB_DATA_DIR = dataDir;
    for (const k of envKeys) delete process.env[k];
    hubConfig.clearConfigCache();
    sessionManager.clearSessionManagerConfigCache();
    return hubConfig.getConfig();
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_HUB_DATA_DIR;
    else process.env.CLAUDE_HUB_DATA_DIR = prev;
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    hubConfig.clearConfigCache();
    sessionManager.clearSessionManagerConfigCache();
  }
}

test('setup.ps1 写的 Claude 配置，Hub 能读成 api 后端（不是写进没人读的键）', (t) => {
  const { dataDir, config } = runMergeScript();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  // 先看落盘结构：必须写在 providers.claude 下。
  assert.ok(config.providers && config.providers.claude,
    'setup.ps1 没有写 providers.claude —— Hub 只认这个键，写别处等于没写');

  const cfg = readHubConfig(dataDir);
  assert.equal(cfg.claudeBackend, 'api',
    'providers.claude.backend 必须是 api，否则 isClaudeApiBackend 判 false，Claude 走订阅分支');
  assert.equal(cfg.claudeApiKey, TOKEN);
  assert.equal(cfg.claudeApiBaseUrl, GATEWAY_URL.replace(/\/+$/, ''));
  assert.equal(cfg.claudeApiModel, CLAUDE_MODEL);
});

test('setup.ps1 写的 Codex 配置，Hub 能读成 api 后端', (t) => {
  const { dataDir, config } = runMergeScript();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  assert.ok(config.providers && config.providers.codex, 'setup.ps1 没有写 providers.codex');

  const cfg = readHubConfig(dataDir);
  assert.equal(cfg.codexBackend, 'api');
  assert.equal(cfg.codexApiKey, TOKEN);
  assert.equal(cfg.codexApiBaseUrl, `${GATEWAY_URL}/codex/v1`);
  assert.equal(cfg.codexApiModel, CODEX_MODEL);
});

test('这份配置一路走到 CLI 环境变量：Claude 拿到 ANTHROPIC_BASE_URL + AUTH_TOKEN', (t) => {
  const { dataDir } = runMergeScript();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const cfg = readHubConfig(dataDir);
  const { _private } = require(path.join(ROOT, 'core', 'session-manager.js'));
  // session-manager 的 cv 形状（core/session-manager.js 的 _loadConfigValues）。
  const cv = {
    CLAUDE_BACKEND: cfg.claudeBackend,
    CLAUDE_API_KEY: cfg.claudeApiKey,
    CLAUDE_API_BASE_URL: cfg.claudeApiBaseUrl,
    CLAUDE_API_MODEL: cfg.claudeApiModel,
    CODEX_BACKEND: cfg.codexBackend,
    CODEX_API_KEY: cfg.codexApiKey,
  };

  assert.equal(_private.isClaudeApiBackend(cv), true,
    'Claude 必须判成 api 后端，否则团队网关配置等于白写');
  assert.equal(_private.isCodexApiBackend(cv), true, 'Codex 必须判成 api 后端');

  const sessionEnv = {};
  const mode = _private.applyClaudeSessionEnv(sessionEnv, cv);
  assert.equal(mode, 'api');
  assert.equal(sessionEnv.ANTHROPIC_BASE_URL, GATEWAY_URL.replace(/\/+$/, ''));
  assert.equal(sessionEnv.ANTHROPIC_AUTH_TOKEN, TOKEN);
});

test('重跑安装是幂等的：不会抹掉 config.json 里的其它字段', (t) => {
  const seed = {
    providers: { deepseek: { api_key: 'keep-me' } },
    ui: { tool_fold_threshold: 42 },
  };
  const { dataDir, config } = runMergeScript({ seedConfig: seed });
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  assert.equal(config.providers.deepseek.api_key, 'keep-me',
    '重跑 setup.ps1 把用户已有的其它 provider 配置冲掉了');
  assert.equal(config.ui.tool_fold_threshold, 42);
  assert.equal(config.providers.claude.backend, 'api');
});

test('setup.ps1 不再把 Claude 凭据写进 Hub 不读的 providers.meridian', () => {
  const { dataDir, config } = runMergeScript();
  try {
    // meridian 块可以留作来源记录，但不能是凭据的唯一落点，也不该再放 token。
    const meridian = (config.providers && config.providers.meridian) || {};
    assert.equal(meridian.token, undefined,
      'providers.meridian 里不要再存 token：Hub 不读它，留着只会让人以为配好了');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 网关失败 → 切回自己账号。Codex 2 在轮次1 审查里复现的问题：脚本嘴上说
// "own-account mode"，config.json 里两路 backend 仍是 api，Hub 照样往死掉的
// 网关发请求。切换必须真的落到 Hub 读得到的那个开关上。
// ---------------------------------------------------------------------------

/** 跑 setup.ps1 里 $JsUseOwnAccount 那段，把已有配置切回自己账号。 */
function runOwnAccountScript(dataDir) {
  const cfgPath = path.join(dataDir, 'config.json');
  const jsPath = path.join(dataDir, 'own-account.js');
  fs.writeFileSync(jsPath, extractSnippet('JsUseOwnAccount'), 'utf8');
  const stdout = execFileSync(process.execPath, [jsPath, cfgPath], { stdio: 'pipe' }).toString();
  return { stdout, config: JSON.parse(fs.readFileSync(cfgPath, 'utf8')) };
}

test('-UseOwnAccount 真的把 Hub 读到的后端从 api 切回 subscription', (t) => {
  const { dataDir } = runMergeScript();               // 先装成网关模式
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const before = readHubConfig(dataDir);
  assert.equal(before.claudeBackend, 'api', '前置条件：先是网关模式');
  assert.equal(before.codexBackend, 'api');

  const { stdout, config } = runOwnAccountScript(dataDir);
  assert.match(stdout, /switched: claude,codex/);

  const after = readHubConfig(dataDir);
  assert.equal(after.claudeBackend, 'subscription',
    '切换后 Hub 仍读到 api，就等于嘴上说个人账号、实际还在打网关');
  assert.equal(after.codexBackend, 'subscription', 'Codex 也要一起切，不能只切 Claude');

  // 凭据留在盘上，方便将来 -Token 一键切回去；但后端开关必须已经移走。
  assert.equal(config.providers.claude.api_key, TOKEN, '不应删除凭据，只移后端开关');
  assert.equal(config.providers.claude.base_url, GATEWAY_URL.replace(/\/+$/, ''));

  const { _private } = require(path.join(ROOT, 'core', 'session-manager.js'));
  const cv = {
    CLAUDE_BACKEND: after.claudeBackend,
    CLAUDE_API_KEY: after.claudeApiKey,
    CLAUDE_API_BASE_URL: after.claudeApiBaseUrl,
    CODEX_BACKEND: after.codexBackend,
    CODEX_API_KEY: after.codexApiKey,
  };
  assert.equal(_private.isClaudeApiBackend(cv), false);
  assert.equal(_private.isCodexApiBackend(cv), false);

  const sessionEnv = { ANTHROPIC_BASE_URL: 'stale', ANTHROPIC_AUTH_TOKEN: 'stale' };
  const mode = _private.applyClaudeSessionEnv(sessionEnv, cv);
  assert.notEqual(mode, 'api');
  assert.equal(sessionEnv.ANTHROPIC_BASE_URL, undefined,
    '切回自己账号后不能再往 CLI 注入网关地址');
  assert.equal(sessionEnv.ANTHROPIC_AUTH_TOKEN, undefined);
});

test('没有 api 配置时切换是安全的空操作', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-own-account-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dataDir, 'config.json'),
    JSON.stringify({ providers: { deepseek: { api_key: 'keep-me' } } }, null, 2), 'utf8');

  const { stdout, config } = runOwnAccountScript(dataDir);
  assert.match(stdout, /switched: none/);
  assert.equal(config.providers.deepseek.api_key, 'keep-me', '不得殃及其它 provider');
});
