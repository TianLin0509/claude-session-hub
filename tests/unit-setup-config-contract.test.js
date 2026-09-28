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
const { execFileSync, spawnSync } = require('node:child_process');

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

/** 把 setup.ps1 内嵌的配置工具落到磁盘，返回它的路径。 */
function materializeConfigTool(dir) {
  const jsPath = path.join(dir, 'hub-config-tool.js');
  fs.writeFileSync(jsPath, extractSnippet('JsConfigTool'), 'utf8');
  return jsPath;
}

/** 按子命令跑一次配置工具；不抛，把退出码和输出都交给调用方断言。 */
function runConfigTool(dir, args) {
  const res = spawnSync(process.execPath, [materializeConfigTool(dir), ...args], {
    encoding: 'utf8', windowsHide: true,
  });
  return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

/**
 * 在隔离数据目录里跑一遍 setup.ps1 的写配置逻辑，返回 config.json 的解析结果和目录。
 * 调用方负责清理。
 */
function runMergeScript({ seedConfig } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-setup-contract-'));
  const cfgPath = path.join(dataDir, 'config.json');
  if (seedConfig) fs.writeFileSync(cfgPath, JSON.stringify(seedConfig, null, 2), 'utf8');

  execFileSync(process.execPath,
    [materializeConfigTool(dataDir), 'write-gateway', cfgPath, GATEWAY_URL, TOKEN, CLAUDE_MODEL, CODEX_MODEL],
    { stdio: 'pipe' });

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

/** 跑配置工具的 use-own-account 子命令，把已有配置切回自己账号。 */
function runOwnAccountScript(dataDir) {
  const cfgPath = path.join(dataDir, 'config.json');
  const stdout = execFileSync(process.execPath,
    [materializeConfigTool(dataDir), 'use-own-account', cfgPath], { stdio: 'pipe' }).toString();
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

// ---------------------------------------------------------------------------
// 损坏的 config.json 必须明确失败，且原文件一个字节都不许动。
//
// Codex 2 轮次2 审查复现：原来三段脚本各自 `try{...}catch(e){}` 吞掉解析错误，
// 然后拿 {} 覆盖写回 —— 用户的网关凭据和其它配置被抹平，安装器还照常打印
// `switched: none` 和 SETUP COMPLETE。core/hub-config.js 的
// readConfigJsonForUpdate 注释里写着同样的教训，这个脚本照犯不误。
//
// 规则：ENOENT（首次安装）是唯一可以当成空配置的情况。
// ---------------------------------------------------------------------------

/** 造一个隔离数据目录，写入指定的原始字节。 */
function seedRawConfig(raw) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-config-guard-'));
  const cfgPath = path.join(dataDir, 'config.json');
  if (raw !== undefined) fs.writeFileSync(cfgPath, raw, 'utf8');
  return { dataDir, cfgPath };
}

const DAMAGED_CASES = [
  ['截断的 JSON（磁盘写到一半 / 手改坏了）',
    '{"providers":{"claude":{"backend":"api","api_key":"REAL-KEY","base_url":"https://gw"'],
  ['根不是对象', '["not", "an", "object"]'],
  ['纯文本', 'this is not json at all'],
];

for (const [label, raw] of DAMAGED_CASES) {
  for (const cmd of ['write-gateway', 'use-own-account']) {
    test(`${cmd} 遇到${label}：非零退出且原文件字节不变`, (t) => {
      const { dataDir, cfgPath } = seedRawConfig(raw);
      t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

      const before = fs.readFileSync(cfgPath);
      const args = cmd === 'write-gateway'
        ? [cmd, cfgPath, GATEWAY_URL, TOKEN, CLAUDE_MODEL, CODEX_MODEL]
        : [cmd, cfgPath];
      const res = runConfigTool(dataDir, args);

      assert.notEqual(res.code, 0,
        `${cmd} 必须失败退出，否则 setup.ps1 会继续打印成功`);
      assert.match(`${res.stderr}${res.stdout}`, /Nothing was written/,
        '错误信息要让人知道文件没被动过');
      assert.deepEqual(fs.readFileSync(cfgPath), before,
        '原配置被改写了 —— 这正是轮次2 的 P1 缺陷');
      assert.ok(!fs.existsSync(`${cfgPath}.tmp-${process.pid}`), '不该留下临时文件');
    });
  }
}

test('config.json 不存在时照常初始化（ENOENT 是唯一可当空配置的情况）', (t) => {
  const { dataDir, cfgPath } = seedRawConfig(undefined);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const res = runConfigTool(dataDir, ['write-gateway', cfgPath, GATEWAY_URL, TOKEN, CLAUDE_MODEL, CODEX_MODEL]);
  assert.equal(res.code, 0, `${res.stderr}${res.stdout}`);

  const cfg = readHubConfig(dataDir);
  assert.equal(cfg.claudeBackend, 'api');
  assert.equal(cfg.claudeApiKey, TOKEN);
});

test('空文件也当成首次安装，不算损坏', (t) => {
  const { dataDir, cfgPath } = seedRawConfig('   \n');
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const res = runConfigTool(dataDir, ['use-own-account', cfgPath]);
  assert.equal(res.code, 0, `${res.stderr}${res.stdout}`);
  assert.match(res.stdout, /switched: none/);
});

test('写入前会备份旧文件，且正常字段一个不丢', (t) => {
  const { dataDir, cfgPath } = seedRawConfig(JSON.stringify({
    providers: { deepseek: { api_key: 'keep-me' } },
    ui: { tool_fold_threshold: 42 },
  }, null, 2));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const before = fs.readFileSync(cfgPath, 'utf8');
  const res = runConfigTool(dataDir, ['write-gateway', cfgPath, GATEWAY_URL, TOKEN, CLAUDE_MODEL, CODEX_MODEL]);
  assert.equal(res.code, 0, `${res.stderr}${res.stdout}`);

  const after = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.equal(after.providers.deepseek.api_key, 'keep-me');
  assert.equal(after.ui.tool_fold_threshold, 42);
  assert.equal(after.providers.claude.backend, 'api');
  assert.equal(fs.readFileSync(`${cfgPath}.backup`, 'utf8'), before,
    '写坏时得有东西可以还原');
});

test('read-mode 遇到损坏配置报 error，而不是谎称走自己账号', (t) => {
  const { dataDir, cfgPath } = seedRawConfig('{"providers": broken');
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const res = runConfigTool(dataDir, ['read-mode', cfgPath]);
  // 只是展示用，不该让安装挂掉；但必须说不知道。
  assert.equal(res.code, 0);
  const parsed = JSON.parse(res.stdout);
  assert.ok(parsed.error, 'read-mode 把损坏配置读成了空配置，收尾汇总就会显示成"自己账号"');
  assert.equal(parsed.claude, undefined);
});

// ---------------------------------------------------------------------------
// 嵌套 provider 的类型也要校验，不能只看根。
//
// Codex 2 轮次3 审查复现：`{"providers":[]}` / `{"providers":"wrong-type"}` 跑
// write-gateway 会退出 0 并打印 written，但读回来 Claude/Codex 都不是 api 后端。
// 原因是这段代码不在 strict 模式：给字符串属性赋值静默无效，给数组挂命名属性
// 又会被 JSON.stringify 丢掉。于是"配置成功"和"根本没配上"同时成立。
//
// 约定：undefined / null = 还没配过，按首次配置初始化（两者都不含用户数据）；
//       数组 / 字符串 / 数字 / 布尔 = 结构损坏，非零退出且原字节不变。
// ---------------------------------------------------------------------------

const BAD_SLOT_VALUES = [
  ['数组', '[]'],
  ['字符串', '"wrong-type"'],
  ['数字', '123'],
  ['布尔', 'true'],
];

for (const [label, literal] of BAD_SLOT_VALUES) {
  test(`providers 是${label}：write-gateway 必须失败且不动原文件`, (t) => {
    const { dataDir, cfgPath } = seedRawConfig(`{"providers":${literal}}`);
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const before = fs.readFileSync(cfgPath);

    const res = runConfigTool(dataDir,
      ['write-gateway', cfgPath, GATEWAY_URL, TOKEN, CLAUDE_MODEL, CODEX_MODEL]);
    assert.notEqual(res.code, 0, `退出 0 就意味着"写成功了但其实没写上"：\n${res.stdout}${res.stderr}`);
    assert.match(`${res.stderr}${res.stdout}`, /providers must be a JSON object/);
    assert.deepEqual(fs.readFileSync(cfgPath), before, '原文件必须原样保留');
  });

  test(`providers.claude 是${label}：write-gateway 必须失败，不能只配上 Codex`, (t) => {
    const { dataDir, cfgPath } = seedRawConfig(
      `{"providers":{"claude":${literal},"codex":{"api_key":"old"}}}`);
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const before = fs.readFileSync(cfgPath);

    const res = runConfigTool(dataDir,
      ['write-gateway', cfgPath, GATEWAY_URL, TOKEN, CLAUDE_MODEL, CODEX_MODEL]);
    assert.notEqual(res.code, 0, 'Claude 配不上却整体报成功，正是轮次3 的 P2 缺陷');
    assert.match(`${res.stderr}${res.stdout}`, /providers\.claude must be a JSON object/);
    assert.deepEqual(fs.readFileSync(cfgPath), before);
  });

  test(`providers.codex 是${label}：use-own-account 也要失败`, (t) => {
    const { dataDir, cfgPath } = seedRawConfig(
      `{"providers":{"claude":{"backend":"api","api_key":"k"},"codex":${literal}}}`);
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const before = fs.readFileSync(cfgPath);

    const res = runConfigTool(dataDir, ['use-own-account', cfgPath]);
    assert.notEqual(res.code, 0);
    assert.match(`${res.stderr}${res.stdout}`, /providers\.codex must be a JSON object/);
    assert.deepEqual(fs.readFileSync(cfgPath), before, '别把 claude 切了却留下半截状态');
  });

  test(`read-mode 遇到 providers 是${label}：报 error 而不是"自己账号"`, (t) => {
    const { dataDir, cfgPath } = seedRawConfig(`{"providers":${literal}}`);
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

    const res = runConfigTool(dataDir, ['read-mode', cfgPath]);
    assert.equal(res.code, 0, 'read-mode 只用于展示，不该让安装挂掉');
    const parsed = JSON.parse(res.stdout);
    assert.ok(parsed.error, '读成"没配过"就会在收尾汇总里谎报成走自己账号');
    assert.equal(parsed.claude, undefined);
  });
}

test('providers 缺失或为 null：按首次配置初始化，写得进去', (t) => {
  for (const seed of ['{}', '{"providers":null}', '{"providers":{"claude":null}}']) {
    const { dataDir, cfgPath } = seedRawConfig(seed);
    try {
      const res = runConfigTool(dataDir,
        ['write-gateway', cfgPath, GATEWAY_URL, TOKEN, CLAUDE_MODEL, CODEX_MODEL]);
      assert.equal(res.code, 0, `${seed} 应当可初始化：\n${res.stdout}${res.stderr}`);
      const cfg = readHubConfig(dataDir);
      assert.equal(cfg.claudeBackend, 'api', seed);
      assert.equal(cfg.codexBackend, 'api', seed);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }
});

test('providers 里无关的键保持原样，即使它们不是对象', (t) => {
  const { dataDir, cfgPath } = seedRawConfig(JSON.stringify({
    providers: { claude: { note: 'keep' }, some_flag: 'a string is fine here' },
  }, null, 2));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const res = runConfigTool(dataDir,
    ['write-gateway', cfgPath, GATEWAY_URL, TOKEN, CLAUDE_MODEL, CODEX_MODEL]);
  assert.equal(res.code, 0, `只校验要写的那几层，别牵连别人：\n${res.stdout}${res.stderr}`);

  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.equal(cfg.providers.some_flag, 'a string is fine here');
  assert.equal(cfg.providers.claude.note, 'keep', '同一个块里原有的字段不该被抹掉');
  assert.equal(cfg.providers.claude.backend, 'api');
});
