const pty = require('node-pty');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const { EventEmitter } = require('events');
const { getConfig } = require('./hub-config.js');
const { getHubDataDir } = require('./data-dir');
const { isClaudeFamily, isCodexCliKind, isKimiCliKind } = require('./ai-kinds.js');
const {
  nativeSessionIdentity,
  supportsRecoverableSession,
} = require('./session-capabilities.js');
const {
  normalizeDeepSeekModel,
  normalizeCodexSessionModel,
  deepseekDisplayName,
  normalizeLegacyDeepSeekClaudeModel,
  legacyDeepSeekClaudeDisplayName,
  DEFAULT_MODEL_BY_KIND,
} = require('./model-options.js');
const {
  ensureDeepSeekCodexProfile,
} = require('./deepseek-codex-profile.js');
const { ensureMemoryLink } = require('./claude-memory-link.js');
const { isSyntheticUserEntry, textFromContent } = require('./synthetic-user-filter.js');
const { TerminalSnapshot } = require('./terminal-snapshot.js');
const { CodexXtermScrollbackRewriter } = require('./codex-xterm-scrollback-rewriter.js');
const { compareLatestReplyDesc } = require('./session-recency.js');
const { detectHostShellTakeover } = require('./host-shell-detector.js');
const { sanitizeNightGuardState } = require('./night-guard-state.js');
const {
  DEFAULT_CLAUDE_MCP_PROFILE,
  WIRELESS_MCP_NAMES,
  buildClaudeMcpProfileArgs,
  normalizeClaudeMcpProfile,
} = require('./claude-mcp-profile.js');
const {
  CODEX_SPEED_TIERS,
  buildCodexSpeedTierArg,
  normalizeCodexSpeedTier,
} = require('./codex-speed-tier.js');
const {
  buildCodexContextWindowArg,
  normalizeCodexContextWindow,
  resolveCodexContextWindow,
} = require('./codex-context-window.js');

// Renderer 首次懒挂载、reload 或 surface 丢失后的降级恢复会用这个环形缓冲的
// 终端数据重建 xterm。16KB 装不下 Codex/Kimi 这类 TUI 的一整帧全屏重绘
// （带色彩的一帧几十 KB 很常见），尾切之后 `\x1b[2J` 和大部分绘制字节被丢掉、
// 只剩若干条 `\x1b[<行>;1H` 绝对定位序列 —— 重放出来就是"内容落在指定行、
// 上方全是空行"。实测（tests/e2e-terminal-rehydrate-cdp.js）：16KB 下重建时，
// 400 行内容只剩 227 行（保全率 56.8%）；256KB 下 400 行和 2000 行都是 100%。
// 取 1MB 是给带 ANSI 色彩的 TUI 输出留余量（同样内容字节数可达纯文本数倍）。
// 代价很小：每会话一个字符串，远低于多留一个 xterm + WebGL 实例。
const RING_BUFFER_BYTES = 1024 * 1024;
// A synchronized ConPTY repaint normally completes in the same burst. If a
// malformed/truncated frame does not, fail open quickly so preservation logic
// can never make the CLI appear frozen.
const TERMINAL_REWRITER_FLUSH_MS = 50;

// 试过两种"起点对齐"，都已放弃，记在这里免得有人再走一遍：
//   1) 对齐到最后一次 \x1b[2J 全屏清屏 —— 实测是**倒退**。Codex/Kimi 每次重绘都清屏，
//      最后一次清屏往往就在缓冲末尾，对齐过去等于把整个滚动回缓冲丢光。
//   2) 剥掉开头被切剩的 CSI 参数残尾（形如 "38;5;196m"）—— 无法与正常文本可靠区分，
//      正文以数字开头时会吃掉真实内容，风险大于收益。
// 2026-07-30 根治：正常路径改由 TerminalSnapshot 在主进程持续解析完整 xterm 状态；
// 这个 1MB 原始尾部只保留为 snapshot 初始化失败时的降级兜底，不再承担长会话恢复。
// Claude CLI `--effort` 的合法枚举；弹窗传入的值必须在此集合内才会被拼进命令行。
const CLAUDE_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const CODEX_MCP_PROFILES = new Set(['none', 'lean', 'browser', 'wireless', 'full']);
const DEFAULT_IDLE_SUSPEND_MS = 5 * 60 * 60 * 1000;
// One default for ordinary/group Codex sessions and every new/resume/fork/relaunch path.
const CODEX_REASONING_EFFORT = 'max';
// Codex 的思考深度档位。2026-08-16 查 ~/.codex/models_cache.json 实测：
// gpt-5.6-sol/terra 支持 low/medium/high/xhigh/max/ultra，5.5/5.4 只到 xhigh。
// （早先以为 xhigh 是 Claude --effort 专属、Codex 会报错 —— 错的，每个模型都支持；
//   而且还有比 max 更高的 ultra："最大推理 + 自动任务分派"。）
// 这里是"语法层"白名单，真正按模型过滤在 core/codex-model-catalog.js，
// UI 也据此动态出选项；这一层只保证不会把乱字符串拼进命令行。
const CODEX_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const BARE_CODEX_COMMAND_RE = /^codex(?:\.cmd|\.exe)?$/i;
function normalizeCodexEffort(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return CODEX_EFFORT_LEVELS.has(normalized) ? normalized : CODEX_REASONING_EFFORT;
}
function buildCodexReasoningConfigArg(effort = CODEX_REASONING_EFFORT) {
  return [
    ` -c 'model_reasoning_effort="${effort}"'`,
    ` -c 'approval_policy="never"'`,
    ` -c 'sandbox_mode="danger-full-access"'`,
    ` -c 'windows.sandbox="unelevated"'`,
    ` -c 'notice.hide_full_access_warning=true'`,
  ].join('');
}
const CODEX_REASONING_CONFIG_ARG = buildCodexReasoningConfigArg(CODEX_REASONING_EFFORT);

// 打包后 __dirname 指向 app.asar 内部，外部进程（claude/codex CLI）读不到。
// 用 asarUnpack 解压副本 + 路径替换，源码模式 __dirname 不含 app.asar，noop。
function resolveAsarUnpacked(filename) {
  const baseDir = __dirname.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
  return path.join(baseDir, filename);
}

// 配置从 hub-config.js 加载（优先级：env > config.json > secrets.toml）
// 老用户无感知：如果 config.json 不存在，自动 fallback 到 secrets.toml
function _loadConfigValues() {
  const config = getConfig();
  return {
    CLAUDE_PROXY: config.proxy,
    CLAUDE_BACKEND: config.claudeBackend,
    CLAUDE_API_KEY: config.claudeApiKey,
    CLAUDE_API_BASE_URL: config.claudeApiBaseUrl,
    CLAUDE_API_MODEL: config.claudeApiModel,
    DEEPSEEK_API_KEY: config.deepseekApiKey,
    CODEX_BACKEND: config.codexBackend,
    CODEX_SUBSCRIPTION_PROFILE: config.codexSubscriptionProfile,
    CODEX_SUBSCRIPTION_PROFILES: config.codexSubscriptionProfiles,
    CODEX_API_KEY: config.codexApiKey,
    CODEX_API_BASE_URL: config.codexApiBaseUrl,
    CODEX_API_MODEL: config.codexApiModel,
    CODEX_API_PROVIDER: config.codexApiProvider || 'packycode',
  };
}
// 惰性求值：首次使用时加载，之后缓存
let _configValues = null;
function getConfigValues() {
  if (!_configValues) _configValues = _loadConfigValues();
  return _configValues;
}
function clearSessionManagerConfigCache() {
  _configValues = null;
}

/**
 * 清空所有代理 env，让子进程对 DeepSeek 等国内/中转端点直连。
 * 必须清干净大小写两套——Hub 进程继承的可能是 Clash/Mihomo 设的 7890，
 * 走代理时长流式请求可能被 60s idle TCP 切断。
 */
function clearProxyEnv(env) {
  delete env.HTTP_PROXY;
  delete env.HTTPS_PROXY;
  delete env.ALL_PROXY;
  delete env.NO_PROXY;
  delete env.http_proxy;
  delete env.https_proxy;
  delete env.all_proxy;
  delete env.no_proxy;
}

/**
 * 海外订阅 CLI 的唯一代理出口。先清掉 Hub 父进程可能继承的
 * ALL_PROXY / 小写 proxy 变量，再同时写入大小写 HTTP(S)_PROXY。
 * 否则不同 CLI / HTTP 库的变量优先级不同，界面看着是 7890，
 * 实际仍可能拾取父进程的另一个代理。
 */
function applyProxyEnv(env, proxy) {
  clearProxyEnv(env);
  const value = String(proxy || '').trim();
  if (!value) return false;
  env.HTTP_PROXY = value;
  env.HTTPS_PROXY = value;
  env.http_proxy = value;
  env.https_proxy = value;
  env.NO_PROXY = 'localhost,127.0.0.1';
  env.no_proxy = 'localhost,127.0.0.1';
  return true;
}

function quotePowerShellLiteral(value) {
  return `'${String(value == null ? '' : value).replace(/'/g, "''")}'`;
}

function resolveKimiExecutable(env = process.env) {
  const configured = env.KIMI_CODE_BIN || env.KIMI_BIN;
  const candidates = [
    configured,
    process.platform === 'win32' ? path.join(os.homedir(), '.kimi-code', 'bin', 'kimi.exe') : null,
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return 'kimi';
}

function kimiCommandPrefix(env = process.env) {
  const executable = resolveKimiExecutable(env);
  return executable === 'kimi' ? ' kimi' : ` & ${quotePowerShellLiteral(executable)}`;
}

function isKimiModelConfigured(modelAlias, env = process.env) {
  const homeDir = env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
  const configPath = path.join(homeDir, 'config.toml');
  let configText;
  try { configText = fs.readFileSync(configPath, 'utf8'); } catch { return false; }
  const escaped = String(modelAlias || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*\\[models\\.(?:"${escaped}"|'${escaped}')\\]\\s*$`, 'm').test(configText);
}

function kimiModelArg(modelAlias, env = process.env) {
  return isKimiModelConfigured(modelAlias, env)
    ? ` --model ${quotePowerShellLiteral(modelAlias)}`
    : '';
}

function isClaudeApiBackend(cv) {
  return cv.CLAUDE_BACKEND === 'api' && !!cv.CLAUDE_API_KEY;
}

// fast 默认开（保持历史行为），但新建会话弹窗可以显式关掉。
// 关的理由是真实存在的：2026-06-11 实测 fastMode 交互式会话不落盘 transcript jsonl，
// transcript-tap 拿不到 turn 文本 → 卡片视图收不到回复。以前只能靠全局环境变量
// CLAUDE_HUB_NO_FAST=1 一刀切，现在可以按会话选。
function shouldUseClaudeFastSettings(cv, opts = {}) {
  if (opts && opts.fastMode === false) return false;
  return process.env.CLAUDE_HUB_NO_FAST !== '1' && !isClaudeApiBackend(cv || getConfigValues());
}

function applyClaudeSessionEnv(sessionEnv, cv) {
  if (isClaudeApiBackend(cv)) {
    // Custom Claude-compatible endpoints must be reached directly. Do not
    // inherit Clash/VPS proxy env, which can cut long-running API streams.
    clearProxyEnv(sessionEnv);
    if (cv.CLAUDE_API_BASE_URL) {
      sessionEnv.ANTHROPIC_BASE_URL = cv.CLAUDE_API_BASE_URL;
    } else {
      delete sessionEnv.ANTHROPIC_BASE_URL;
    }
    sessionEnv.ANTHROPIC_AUTH_TOKEN = cv.CLAUDE_API_KEY;
    sessionEnv.CLAUDE_CODE_ATTRIBUTION_HEADER = '0';
    sessionEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    sessionEnv.CLAUDE_CODE_DISABLE_TERMINAL_TITLE = '1';
    // Claude.ai account connectors cannot authenticate while an API token is
    // active. Disable that connector source explicitly so Claude Code does not
    // emit the expected-but-noisy auth-precedence warning on every Fable start.
    sessionEnv.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
    delete sessionEnv.ANTHROPIC_API_BASE_URL;
    delete sessionEnv.ANTHROPIC_API_KEY;
    delete sessionEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL;
    delete sessionEnv.ANTHROPIC_MODEL;
    return 'api';
  }

  // Subscription OAuth (Claude Max): strip custom-endpoint env vars that would
  // otherwise route Claude Code to cc-switch / CCR, then use the configured
  // local proxy chain for claude.ai/Anthropic.
  delete sessionEnv.ANTHROPIC_BASE_URL;
  delete sessionEnv.ANTHROPIC_API_BASE_URL;
  delete sessionEnv.ANTHROPIC_AUTH_TOKEN;
  delete sessionEnv.ANTHROPIC_API_KEY;
  delete sessionEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL;
  delete sessionEnv.ANTHROPIC_MODEL;
  applyProxyEnv(sessionEnv, cv.CLAUDE_PROXY);
  return 'subscription';
}

function resolveClaudeLaunchModel(cv, requestedModel) {
  // The meeting creator always submits the subscription default model even
  // when the user never touched its model picker. Treat that value as an
  // implicit default so switching the global backend really does make Fable
  // the default for both 1:1 and group-chat Claude sessions. A genuinely
  // different per-session selection still wins.
  if (isClaudeApiBackend(cv) && cv.CLAUDE_API_MODEL
      && (!requestedModel || requestedModel === DEFAULT_MODEL_BY_KIND.claude)) {
    return cv.CLAUDE_API_MODEL;
  }
  if (requestedModel) return requestedModel;
  return DEFAULT_MODEL_BY_KIND.claude;
}

function toClaudeProjectKey(projectDir) {
  return path.resolve(projectDir || os.homedir()).replace(/\\/g, '/');
}

function ensureClaudeBypassAndTrust(claudeDir, projectDir) {
  if (!claudeDir) return;
  try {
    fs.mkdirSync(claudeDir, { recursive: true });

    const settingsPath = path.join(claudeDir, 'settings.json');
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}
    if (settings.permissionMode !== 'bypassPermissions') {
      settings.permissionMode = 'bypassPermissions';
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    }

    const statePath = path.join(claudeDir, '.claude.json');
    let state = {};
    try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}
    if (!state || typeof state !== 'object' || Array.isArray(state)) state = {};
    if (!state.projects || typeof state.projects !== 'object' || Array.isArray(state.projects)) {
      state.projects = {};
    }

    // 顶级 state：跳过 BypassPermissions 全屏警告菜单 + onboarding。
    // 缺这些字段时 claude CLI 首次启动会弹 "WARNING: Bypass Permissions mode" 全屏菜单
    // 要求按 2+Enter 通过 — conpty alt-screen 下方向键模拟不靠谱，普通用户体感"卡住"。
    // 字段名参考主 ~/.claude.json（生产 Claude 长期 accept 后的实际状态）。
    state.bypassPermissionsModeAccepted = true;
    state.skipDangerousModePermissionPrompt = true;
    state.hasCompletedOnboarding = true;

    const projectKey = toClaudeProjectKey(projectDir);
    const existing = state.projects[projectKey] && typeof state.projects[projectKey] === 'object'
      ? state.projects[projectKey]
      : {};
    state.projects[projectKey] = {
      allowedTools: Array.isArray(existing.allowedTools) ? existing.allowedTools : [],
      mcpContextUris: Array.isArray(existing.mcpContextUris) ? existing.mcpContextUris : [],
      mcpServers: existing.mcpServers && typeof existing.mcpServers === 'object' ? existing.mcpServers : {},
      enabledMcpjsonServers: Array.isArray(existing.enabledMcpjsonServers) ? existing.enabledMcpjsonServers : [],
      disabledMcpjsonServers: Array.isArray(existing.disabledMcpjsonServers) ? existing.disabledMcpjsonServers : [],
      ...existing,
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
    };
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.warn('[hub] failed to pretrust Claude config:', err.message);
  }
}

// 群聊 CLI 隔离 — 软隔离方案 (2026-05-02 / v2 白名单优化 2026-05-04 道雪)
// 目的：群聊成员的 Claude/DeepSeek CLI 启动时,
//   `--settings <path>`  merge 一份"全 plugin disabled"的 settings.json
//   （只覆盖 enabledPlugins 字段，不动主目录的 hooks/permissions/statusLine 等）。
// 不动 CLAUDE_CONFIG_DIR — auto-memory / CLAUDE.md / OAuth 凭证全部继续共享。
// 仅当 opts.meetingId 存在（即群聊成员）时启用,主桌 Claude 会话不受影响。
//
// ⚠ settings 兜底盲区 (v2 修订 · 2026-05-04 道雪):
//   `enabledPlugins` 仅对 **plugin 内的 skill** 生效。
//     ✅ 兜得住: superpowers 全家 (plan/brainstorming/TDD/debugging/SDD/post-refactor-verify/
//        simplify/review/security-review)、code-review/security-guidance/codex/
//        feature-dev/skill-creator/claude-md-management 等 23 个 plugin。
//     ❌ 兜不住: 用户自定义 skill (位于 ~/.claude/skills/),如 init / loop /
//        schedule / design-review。它们不属于任何 plugin,settings 完全无法禁用。
//   这部分必须靠 BASE_RULES (core/group-chat-scenes.js) 软约束兜底,详见该文件
//   "AI 禁止主动调用" 段。
//
// 历史 (v1 · 2026-05-02):
//   原方案另加 `--disable-slash-commands` (CLI 参数) 一刀切禁用所有斜杠命令,
//   误杀 /model /compact /help /clear /config 等用户基本操作 (用户反馈痛点)。
//   v2 删除该参数,改靠 settings 禁 plugin + BASE_RULES 软约束自定义 skill 双层兜底。
const _GROUP_CHAT_DISABLE_PLUGINS = {
  'hookify@claude-plugins-official': false,
  'code-review@claude-plugins-official': false,
  'security-guidance@claude-plugins-official': false,
  'commit-commands@claude-plugins-official': false,
  'pyright-lsp@claude-plugins-official': false,
  'feature-dev@claude-plugins-official': false,
  'claude-md-management@claude-plugins-official': false,
  'skill-creator@claude-plugins-official': false,
  'frontend-design@claude-plugins-official': false,
  'codex@openai-codex': false,
  'superpowers@claude-plugins-official': false,
  'harness@harness-marketplace': false,
  'differential-review@trailofbits-skills': false,
  'property-based-testing@trailofbits-skills': false,
  'supply-chain-risk-auditor@trailofbits-skills': false,
  'sharp-edges@trailofbits-skills': false,
  'variant-analysis@trailofbits-skills': false,
  'modern-python@trailofbits-skills': false,
  'second-opinion@trailofbits-skills': false,
  'git-cleanup@trailofbits-skills': false,
  'gh-cli@trailofbits-skills': false,
  'context7@context7': false,
  'ui-ux-pro-max@ui-ux-pro-max-skill': false,
};

function ensureGroupChatSettings(hubDataDir) {
  const fp = path.join(hubDataDir, 'group-chat-claude-settings.json');
  const content = JSON.stringify({ enabledPlugins: _GROUP_CHAT_DISABLE_PLUGINS }, null, 2);
  try {
    let cur = '';
    try { cur = fs.readFileSync(fp, 'utf8'); } catch {}
    if (cur !== content) {
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, content, 'utf8');
    }
  } catch (err) {
    console.warn('[hub] failed to write group chat settings:', err.message);
  }
  return fp;
}

function buildGroupChatIsolationFlags(meetingId) {
  if (!meetingId) return '';
  const settingsPath = ensureGroupChatSettings(getHubDataDir());
  // settings 路径含反斜杠 — Claude CLI 在 PowerShell 下接受双反斜杠转义
  const escaped = settingsPath.replace(/\\/g, '\\\\');
  // 这里只隔离群聊里的 skill / plugin。MCP 是否 strict 现在由每位成员自己的
  // mcpProfile 决定，不能再在这里无条件覆盖用户在创建弹窗里的选择。
  return ` --settings "${escaped}"`;
}

function buildClaudeMeetingMcpArgs({
  mcpConfigFile,
  mcpProfile,
  cwd,
  hubDataDir,
  homeDir,
  fsModule,
} = {}) {
  const profile = normalizeClaudeMcpProfile(mcpProfile);
  const mandatoryFiles = typeof mcpConfigFile === 'string' && mcpConfigFile
    ? [mcpConfigFile]
    : [];
  const quoteConfig = value => `"${String(value).replace(/\\/g, '\\\\')}"`;

  // Full = 继承全部用户 MCP。research/群聊通信配置仍以额外 config 合并进去，
  // 但不加 strict，否则所谓 Full 实际会把全局 MCP 全部挡掉。
  if (profile === 'full') {
    return {
      args: mandatoryFiles.length ? ` --mcp-config ${mandatoryFiles.map(quoteConfig).join(' ')}` : '',
      profile,
      keptServers: [],
      configPaths: mandatoryFiles,
    };
  }

  const profilePlan = buildClaudeMcpProfileArgs({
    mcpProfile: profile,
    cwd,
    hubDataDir,
    homeDir,
    ...(fsModule ? { fsModule } : {}),
  });
  // 生成过滤配置失败时沿用 buildClaudeMcpProfileArgs 的 fail-open 语义：宁可 Full，
  // 也不能只剩群聊 MCP 却静默丢掉用户工具。
  if (!profilePlan.configPath) {
    return {
      args: mandatoryFiles.length ? ` --mcp-config ${mandatoryFiles.map(quoteConfig).join(' ')}` : '',
      profile: 'full',
      keptServers: [],
      configPaths: mandatoryFiles,
    };
  }
  const configPaths = [...mandatoryFiles, profilePlan.configPath];
  return {
    args: ` --mcp-config ${configPaths.map(quoteConfig).join(' ')} --strict-mcp-config`,
    profile,
    keptServers: profilePlan.keptServers,
    configPaths,
  };
}

// dismissCodexUpdatePrompt — 阻止 codex CLI 启动时弹 "Update available! X -> Y" 提示。
//
// 历史 bug：codex 在 alt-screen TUI 弹 update prompt 阻塞主循环，AI 群聊发 prompt 时
// 字符进 update 选择菜单 → codex 选 "1.Update now" 自动跑 npm install -g → 升级完
// codex 自退、PowerShell 接管 PTY → Hub 的 prompt 被 PowerShell 当命令执行 + 解析失败。
//
// 修：写 dismissed_version = latest_version 到 codex 的 version.json，让 prompt 静默。
//
// 默认对订阅模式 ~/.codex/version.json；API 模式（isolated CODEX_HOME）必须显式传
// configDir 指向 <hubDataDir>/codex-api-profile，否则 dismiss 写到错误位置不生效。
function dismissCodexUpdatePrompt(homeDir = process.env.USERPROFILE || process.env.HOME || os.homedir(), configDir = null) {
  const versionPath = configDir
    ? path.join(configDir, 'version.json')
    : path.join(homeDir, '.codex', 'version.json');
  try {
    let state = {};
    try { state = JSON.parse(fs.readFileSync(versionPath, 'utf8')); } catch {}
    if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
    if (!state.latest_version || state.dismissed_version === state.latest_version) return false;

    state.dismissed_version = state.latest_version;
    fs.mkdirSync(path.dirname(versionPath), { recursive: true });
    fs.writeFileSync(versionPath, JSON.stringify(state), 'utf8');
    console.log(`[hub] dismissed Codex update prompt for ${state.latest_version} at ${versionPath}`);
    return true;
  } catch (err) {
    console.warn('[hub] failed to dismiss Codex update prompt:', err.message);
    return false;
  }
}

// dismissCodexRateLimitDialog — 阻止 codex CLI 启动后弹 rate-limit / model-switch
// dialog（"Press enter to confirm or esc to go back" / "never show again"）。
//
// 历史 bug（2026-05-05 道雪 实测确认）：codex 启动后某些条件（rate-limit 接近 / 模型
//   配额计数）会弹一个 TUI dialog 拦住 alt-screen 输入。Hub 主路径 sendToPty 的字符
//   写到 dialog 而不是输入框 → \r 被 dialog 当确认按钮 → prompt 留输入框未提交 →
//   用户看到"输入框卡 prompt"现象，需手动点 [📤 发送]。
//
// 修：写 hide_rate_limit_model_nudge = true 到 config.toml 的 [notice] 段，永久关闭
//   该 dialog（OpenAI 官方 opt-out 机制，见 developers.openai.com/codex/config-reference）。
//
// 行为：幂等。若 key 已是 true 直接返回 false（无需写盘）。文件不存在则创建。
//   有 [notice] section 时在 section 内追加 key；没有时文件末尾追加完整 section。
//
// 默认对订阅模式 ~/.codex/config.toml；API 模式（isolated CODEX_HOME）必须显式传
//   configDir，否则 dismiss 写到错误位置不生效（同 dismissCodexUpdatePrompt 约定）。
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function ensureTomlSectionKey(content, sectionName, key, value) {
  const src = String(content || '');
  const desiredLine = `${key} = ${value}`;
  const headerRe = new RegExp(`^\\s*\\[${escapeRegExp(sectionName)}\\]\\s*$`, 'im');
  const headerMatch = src.match(headerRe);

  if (!headerMatch) {
    const sep = src ? (src.endsWith('\n') ? '\n' : '\n\n') : '';
    return {
      content: src + sep + `[${sectionName}]\n${desiredLine}\n`,
      changed: true,
    };
  }

  const sectionStart = headerMatch.index + headerMatch[0].length;
  const tail = src.slice(sectionStart);
  const nextHeaderMatch = tail.match(/\n\s*\[[^\]]+\]\s*$/m);
  const sectionEnd = nextHeaderMatch ? sectionStart + nextHeaderMatch.index : src.length;
  const section = src.slice(sectionStart, sectionEnd);
  const desiredRe = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*${escapeRegExp(value)}\\s*$`, 'im');
  if (desiredRe.test(section)) {
    return { content: src, changed: false };
  }

  const keyRe = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=.*$`, 'im');
  if (keyRe.test(section)) {
    const nextSection = section.replace(keyRe, desiredLine);
    return {
      content: src.slice(0, sectionStart) + nextSection + src.slice(sectionEnd),
      changed: true,
    };
  }

  return {
    content: src.slice(0, sectionStart) + `\n${desiredLine}` + src.slice(sectionStart),
    changed: true,
  };
}

function dismissCodexRateLimitDialog(homeDir = process.env.USERPROFILE || process.env.HOME || os.homedir(), configDir = null) {
  const configPath = configDir
    ? path.join(configDir, 'config.toml')
    : path.join(homeDir, '.codex', 'config.toml');
  try {
    let content = '';
    try { content = fs.readFileSync(configPath, 'utf8'); } catch { /* 文件不存在 → 视作空 */ }

    // 幂等：key 已存在且为 true → 跳过写盘
    let newContent = content;
    // 已有 [notice] section（任意大小写 / 前后空格）→ 在 section 头之后插入 key
    const noticeMatch = content.match(/^\s*\[notice\]\s*$/m);
    if (noticeMatch && !/^\s*hide_rate_limit_model_nudge\s*=\s*true\b/m.test(content)) {
      const insertPos = noticeMatch.index + noticeMatch[0].length;
      newContent = content.slice(0, insertPos) + '\nhide_rate_limit_model_nudge = true' + content.slice(insertPos);
    } else if (!noticeMatch && !/^\s*hide_rate_limit_model_nudge\s*=\s*true\b/m.test(content)) {
      // 没 [notice] → 文件末尾追加完整 section
      const sep = (content && !content.endsWith('\n')) ? '\n' : '';
      newContent = content + sep + '\n[notice]\nhide_rate_limit_model_nudge = true\n';
    }

    const requiredKeys = [
      ['notice', 'hide_rate_limit_model_nudge', 'true'],
      ['notice', 'hide_full_access_warning', 'true'],
      ['windows', 'sandbox', '"unelevated"'],
    ];
    let changed = false;
    for (const [section, key, value] of requiredKeys) {
      const next = ensureTomlSectionKey(newContent, section, key, value);
      newContent = next.content;
      changed = changed || next.changed;
    }
    if (!changed) return false;

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, newContent, 'utf8');
    console.log(`[hub] ensured Codex silent full-access config at ${configPath}`);
    return true;
  } catch (err) {
    console.warn('[hub] failed to ensure Codex silent full-access config:', err.message);
    return false;
  }
}

function tomlString(value) {
  return JSON.stringify(String(value || ''));
}

function tomlArray(values) {
  return '[' + (Array.isArray(values) ? values : []).map(tomlString).join(', ') + ']';
}

function getCodexApiHome() {
  return path.join(getHubDataDir(), 'codex-api-profile');
}

function ensureCodexApiProfile(cv, projectDir) {
  const codexHome = getCodexApiHome();
  const provider = cv.CODEX_API_PROVIDER || 'packycode';
  const baseUrl = cv.CODEX_API_BASE_URL || 'https://www.packyapi.com/v1';
  const model = cv.CODEX_API_MODEL || DEFAULT_MODEL_BY_KIND.codex;
  const projectKey = path.resolve(projectDir || os.homedir());

  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), [
    'disable_response_storage = true',
    `model = ${tomlString(model)}`,
    `model_provider = ${tomlString(provider)}`,
    `model_reasoning_effort = ${tomlString(CODEX_REASONING_EFFORT)}`,
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    '',
    '[notice]',
    'hide_rate_limit_model_nudge = true',
    'hide_full_access_warning = true',
    '',
    '[windows]',
    'sandbox = "unelevated"',
    '',
    `[model_providers.${provider}]`,
    `base_url = ${tomlString(baseUrl)}`,
    `name = ${tomlString(provider)}`,
    'requires_openai_auth = true',
    'wire_api = "responses"',
    '',
    `[projects.${tomlString(projectKey)}]`,
    'trust_level = "trusted"',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({
    OPENAI_API_KEY: cv.CODEX_API_KEY || '',
  }), 'utf8');
  return codexHome;
}

function isCodexApiBackend(cv) {
  return cv.CODEX_BACKEND === 'api' && !!cv.CODEX_API_KEY;
}

function resolveDefaultCodexModel(cv) {
  return isCodexApiBackend(cv) && cv.CODEX_API_MODEL
    ? cv.CODEX_API_MODEL
    : DEFAULT_MODEL_BY_KIND.codex;
}

function expandHomePath(p) {
  const raw = String(p || '').trim();
  if (!raw) return '';
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(os.homedir(), raw.slice(2));
  return raw;
}

function resolveCodexSubscriptionProfile(cv, requestedId) {
  const profiles = Array.isArray(cv.CODEX_SUBSCRIPTION_PROFILES) ? cv.CODEX_SUBSCRIPTION_PROFILES : [];
  const fallback = profiles.find(p => p && p.id === 'default') || { id: 'default', label: '主账号', home: '' };
  const wanted = String(requestedId || cv.CODEX_SUBSCRIPTION_PROFILE || fallback.id || 'default').trim();
  const selected = profiles.find(p => p && p.id === wanted) || fallback;
  const home = expandHomePath(selected.home);
  return {
    id: selected.id || 'default',
    label: selected.label || selected.id || 'Codex',
    home: home ? path.resolve(home) : '',
  };
}

// 订阅模式 codex CLI 0.125.0 对未 trust 的 cwd 启动时会弹
// "Do you trust the contents of this directory? 1.Yes 2.No" 阻塞 TUI 主循环，
// 永远不写 ~/.codex/sessions/.../rollout-*.jsonl → CodexTap _bound 永远空。
// 修：spawn 前幂等追加 [projects.'<cwd>'] trust_level = "trusted" 到主 config.toml。
function ensureCodexCwdTrusted(projectDir, configDir = null) {
  if (!projectDir) return;
  try {
    const codexHome = configDir || path.join(os.homedir(), '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
    const cfgPath = path.join(codexHome, 'config.toml');
    const projectKey = path.resolve(projectDir);
    // Codex CLI 0.137-0.144 normalizes Windows cwd to lower-case before the
    // trust lookup. Store one normalized key instead of appending both cases.
    const trustKey = projectKey.toLowerCase();
    let cfg = '';
    try { cfg = fs.readFileSync(cfgPath, 'utf8'); } catch {}
    const existingKeys = Array.from(cfg.matchAll(/^\[projects\.'([^']+)'\]\s*$/gm), match => match[1]);
    if (existingKeys.includes(trustKey)) return;
    const append = (cfg && !cfg.endsWith('\n') ? '\n' : '')
      + `\n[projects.'${trustKey}']\ntrust_level = "trusted"\n`;
    fs.appendFileSync(cfgPath, append, 'utf8');
  } catch (err) {
    console.warn('[hub] failed to pretrust codex cwd:', err.message);
  }
}

// These servers are room-scoped. Never leave a persistent copy in the user's
// global Codex config: an ordinary Codex session must not discover room tools.
// chuxin_knowledge is a legacy standalone registration removed during launch.
const CODEX_MANAGED_MCP_NAMES = ['ai-team', 'arena_research', 'chuxin_knowledge'];

function listCodexMcpServerNames(configDir) {
  try {
    const codexHome = configDir || path.join(os.homedir(), '.codex');
    const cfg = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    const names = new Set();
    for (const line of cfg.split(/\r?\n/)) {
      const match = line.trim().match(/^\[mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))(?:\.|\])/);
      const name = match && (match[1] || match[2] || match[3]);
      if (name && /^[A-Za-z0-9_-]+$/.test(name)) names.add(name);
    }
    return [...names];
  } catch {
    return [];
  }
}

function normalizeCodexMcpProfile(value) {
  const normalized = String(value || 'lean').trim().toLowerCase();
  return CODEX_MCP_PROFILES.has(normalized) ? normalized : 'lean';
}

function resolveCodexMcpProfile(kind, value) {
  const fallback = String(kind || '').replace(/-resume$/, '') === 'deepseek' ? 'lean' : 'none';
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  return CODEX_MCP_PROFILES.has(normalized) ? normalized : fallback;
}

function resolveCodexSpeedTier(kind, value) {
  const fallback = String(kind || '').replace(/-resume$/, '') === 'deepseek' ? 'inherit' : 'fast';
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  return CODEX_SPEED_TIERS.has(normalized) ? normalized : fallback;
}

function isPathInside(candidate, root) {
  if (!candidate || !root) return false;
  const resolvedCandidate = path.resolve(String(candidate)).toLowerCase();
  const resolvedRoot = path.resolve(String(root)).toLowerCase();
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(resolvedRoot + path.sep);
}

function isWirelessWorkspace(cwd) {
  const wirelessRoot = process.env.AI_HUB_WIRELESS_ROOT || 'C:\\Vibe\\Wireless';
  return isPathInside(cwd, wirelessRoot);
}

// None disables every configured server, including workspace and room-scoped
// entries. Other profiles retain the existing selective behavior.
function buildCodexMcpIsolationArgs(configDir, options = {}) {
  const names = listCodexMcpServerNames(configDir);
  const allowed = new Set((options.allowedNames || [])
    .map(name => String(name || '').trim())
    .filter(Boolean));

  const profile = normalizeCodexMcpProfile(options.mcpProfile);
  if (profile === 'full') return '';
  if (profile === 'none') allowed.clear();
  if (profile === 'browser') allowed.add('playwright');
  if (profile !== 'none' && (profile === 'wireless' || isWirelessWorkspace(options.cwd))) {
    // 只写 superwireless 是个空转 bug：用户 ~/.codex/config.toml 里这个 server
    // 实际叫 superran，于是 wireless 档把唯一想留的那个也禁掉了。两个名字都放行。
    WIRELESS_MCP_NAMES.forEach(name => allowed.add(name));
  }
  return names
    .filter(name => !allowed.has(name))
    .map(name => ` -c 'mcp_servers.${name}.enabled=false'`)
    .join('');
}

function buildCodexGroupMcpIsolationArgs(configDir, meetingId, allowedNames = CODEX_MANAGED_MCP_NAMES) {
  if (!meetingId) return '';
  return buildCodexMcpIsolationArgs(configDir, { meetingId, allowedNames });
}

function getSessionResumeIdentity(info) {
  const identity = nativeSessionIdentity(info);
  return identity ? identity.value : null;
}

function supportsRecoverableSuspend(info) {
  return supportsRecoverableSession(info);
}

function buildCodexEphemeralMcpArgs(entries) {
  const out = [];
  const seen = new Set();
  const literal = (value) => `'${String(value == null ? '' : value).replace(/'/g, "''")}'`;
  const literalArray = (values) => `[${(Array.isArray(values) ? values : []).map(literal).join(', ')}]`;
  for (const entry of Array.isArray(entries) ? entries : []) {
    const name = String(entry && entry.name || '').trim();
    if (!/^[A-Za-z0-9_-]+$/.test(name) || seen.has(name)) continue;
    seen.add(name);
    // Codex is launched through PowerShell's npm shim. Outer double quotes +
    // TOML literal strings survive both parsing layers; JSON-style arrays do
    // not and are silently interpreted as a scalar string.
    const add = (expression) => {
      const escaped = String(expression).replace(/`/g, '``').replace(/\$/g, '`$').replace(/"/g, '`"');
      out.push(` -c "${escaped}"`);
    };
    add(`mcp_servers.${name}.command=${literal(entry.command || '')}`);
    add(`mcp_servers.${name}.args=${literalArray(entry.args || [])}`);
    const env = entry.env && typeof entry.env === 'object' ? entry.env : {};
    for (const key of Object.keys(env).sort()) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      add(`mcp_servers.${name}.env.${key}=${literal(env[key])}`);
    }
  }
  return out.join('');
}

function stripCodexMcpEntries(cfg, names) {
  const managed = new Set((names || []).map(name => String(name || '').trim()).filter(Boolean));
  if (managed.size === 0 || !cfg) return cfg || '';
  const lines = cfg.split(/\r?\n/);
  const kept = [];
  let skipping = false;
  for (const line of lines) {
    const section = line.trim().match(/^\[([^\]]+)\]$/);
    if (section) {
      const name = section[1].match(/^mcp_servers\.([^.]+)(?:\.|$)/)?.[1] || '';
      skipping = managed.has(name);
    }
    if (!skipping) kept.push(line);
  }
  return kept.join('\n').replace(/\s+$/u, '');
}

function ensureCodexMcpEntries(configDir, entries, managedNames = []) {
  const safeEntries = Array.isArray(entries) ? entries : [];
  if (safeEntries.length === 0 && (!Array.isArray(managedNames) || managedNames.length === 0)) return;
  try {
    const codexHome = configDir || path.join(os.homedir(), '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
    const cfgPath = path.join(codexHome, 'config.toml');
    let cfg = '';
    try { cfg = fs.readFileSync(cfgPath, 'utf8'); } catch {}
    cfg = stripCodexMcpEntries(cfg, managedNames);

    for (const entry of safeEntries) {
      const name = String(entry && entry.name || '').trim();
      if (!/^[A-Za-z0-9_-]+$/.test(name)) continue;
      cfg = stripCodexMcpEntries(cfg, [name]);

      const env = entry.env && typeof entry.env === 'object' ? entry.env : {};
      const block = [
        '',
        `[mcp_servers.${name}]`,
        `command = ${tomlString(entry.command || '')}`,
        `args = ${tomlArray(entry.args || [])}`,
      ];
      const envKeys = Object.keys(env).sort();
      if (envKeys.length > 0) {
        block.push('', `[mcp_servers.${name}.env]`);
        for (const key of envKeys) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
          block.push(`${key} = ${tomlString(env[key])}`);
        }
      }
      cfg += (cfg ? '\n' : '') + block.join('\n') + '\n';
    }
    fs.writeFileSync(cfgPath, cfg, 'utf8');
  } catch (err) {
    console.warn('[hub] failed to configure Codex MCP entries:', err.message);
  }
}

class SessionManager extends EventEmitter {
  sessions = new Map();
  focusedSessionId = null;
  claudeCounter = 0;
  resumeCounter = 0;
  psCounter = 0;
  _outputSeq = 0;
  _lastWrite = null;
  _managedLaunchAudit = [];
  _isShuttingDown = false;
  _shutdownDrainPromise = null;
  _shutdownExitWaiters = new Map();
  _shutdownDrainedSessions = new Map();

  // Injected by main: the chosen hook HTTP port + per-launch auth token.
  hookPort = null;
  hookToken = null;

  constructor() {
    super();
  }

  // Callbacks
  onData = (sessionId, data) => {};
  onSessionClosed = (sessionId) => {};
  onSessionSuspended = (sessionId) => {};

  // opts: { id?, title?, cwd?, resumeCCSessionId?, forkCCSessionId?, useContinue? }
  //   id:                 reuse a previous hub session id (dormant wake)
  //   title:              override default title (dormant wake preserves name)
  //   cwd:                launch cwd; defaults to user home
  //   resumeCCSessionId:  when set, runs `claude --resume <id>`
  //   forkCCSessionId:    when set, runs `claude --resume <id> --fork-session`
  //   useContinue:        when set, runs `claude --continue` (Claude fallback)
  //   useResume:          generic resume flag for codex/gemini → uses sid/index if provided, else --last/latest
  //   codexSid:           when set + kind=='codex' + useResume, runs `codex resume <sid>` precisely (T8 new)
  //   codexForkSid:       when set + kind=='codex', runs `codex fork <sid>` into a fresh task
  //   geminiChatId:       Gemini 8charId from chats/session-*.json (T8 new, used for index lookup)
  //   geminiProjectRoot:  required for Gemini resume (T8 new, used as cwd for correct project scoping)
  createSession(kind = 'powershell', opts = {}) {
    if (this._isShuttingDown) {
      throw new Error('Hub is shutting down; refusing to create a new PTY');
    }
    const id = opts.id || uuid();
    const isClaude = kind === 'claude' || kind === 'claude-resume';
    const isGemini = kind === 'gemini' || kind === 'gemini-resume';
    const isDeepSeek = kind === 'deepseek' || kind === 'deepseek-resume';
    // New DeepSeek sessions use Codex. Persisted pre-migration sessions carry a
    // Claude ccSessionId and opt into this compatibility runtime so their history
    // remains resumable instead of being silently discarded.
    const isDeepSeekLegacy = isDeepSeek && !!opts.deepseekLegacyClaude;
    const isCodex = kind === 'codex' || kind === 'codex-resume';
    const isCodexRuntime = isCodex || (isDeepSeek && !isDeepSeekLegacy);
    const isKimi = isKimiCliKind(kind);
    const isAgent = isClaude || isGemini || isCodexRuntime || isDeepSeekLegacy || isKimi;
    let title;
    if (opts.title) title = opts.title;
    else if (kind === 'claude') title = `Claude ${++this.claudeCounter}`;
    else if (kind === 'claude-resume') title = `Claude Resume ${++this.resumeCounter}`;
    else if (kind === 'gemini') { this.geminiCounter = (this.geminiCounter || 0) + 1; title = `Gemini ${this.geminiCounter}`; }
    else if (kind === 'codex') { this.codexCounter = (this.codexCounter || 0) + 1; title = `Codex ${this.codexCounter}`; }
    else if (kind === 'deepseek') { this.deepseekCounter = (this.deepseekCounter || 0) + 1; title = `DeepSeek ${this.deepseekCounter}`; }
    else if (kind === 'kimi') { this.kimiCounter = (this.kimiCounter || 0) + 1; title = `Kimi ${this.kimiCounter}`; }
    else if (kind === 'gemini-resume') title = `Gemini Resume ${++this.resumeCounter}`;
    else if (kind === 'codex-resume') title = `Codex Resume ${++this.resumeCounter}`;
    else if (kind === 'deepseek-resume') title = `DeepSeek Resume ${++this.resumeCounter}`;
    else if (kind === 'kimi-resume') title = `Kimi Resume ${++this.resumeCounter}`;
    else title = `PowerShell ${++this.psCounter}`;

    const sessionEnv = { ...process.env };
    let codexProfile = null;

    if (isClaude) {
      const cv = getConfigValues();
      applyClaudeSessionEnv(sessionEnv, cv);
      // Attribution + auth for the Stop/UserPromptSubmit hook script (both modes)
      sessionEnv.CLAUDE_HUB_SESSION_ID = id;
      if (this.hookPort) sessionEnv.CLAUDE_HUB_PORT = String(this.hookPort);
      if (this.hookToken) sessionEnv.CLAUDE_HUB_TOKEN = this.hookToken;
      // Propagate data-dir override so the statusline script writes its cache
      // into the isolated test dir instead of the production ~/.claude-session-hub.
      if (process.env.CLAUDE_HUB_DATA_DIR) {
        sessionEnv.CLAUDE_HUB_DATA_DIR = process.env.CLAUDE_HUB_DATA_DIR;
      }
    } else if (isDeepSeekLegacy) {
      const cv = getConfigValues();
      clearProxyEnv(sessionEnv);
      sessionEnv.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic';
      sessionEnv.ANTHROPIC_AUTH_TOKEN = cv.DEEPSEEK_API_KEY;
      delete sessionEnv.ANTHROPIC_API_KEY;
      delete sessionEnv.ANTHROPIC_API_BASE_URL;
      sessionEnv.CLAUDE_CONFIG_DIR = path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.claude-deepseek');
      sessionEnv.CLAUDE_HUB_SESSION_ID = id;
      if (this.hookPort) sessionEnv.CLAUDE_HUB_PORT = String(this.hookPort);
      if (this.hookToken) sessionEnv.CLAUDE_HUB_TOKEN = this.hookToken;
      if (process.env.CLAUDE_HUB_DATA_DIR) sessionEnv.CLAUDE_HUB_DATA_DIR = process.env.CLAUDE_HUB_DATA_DIR;
    } else if (isGemini || isCodex) {
      const cv = getConfigValues();
      if (isCodex && isCodexApiBackend(cv)) {
        // Codex API 模式走 PackyAPI，必须直连，否则代理 60s idle 切长任务
        clearProxyEnv(sessionEnv);
        sessionEnv.CODEX_HOME = getCodexApiHome();
      } else {
        if (isCodex) {
          if (opts.meetingId) {
            // 群聊 Codex 统一用默认 ~/.codex/，记忆汇合到一处方便管理
            // 跟 Hub 直开 Codex 共享 1.9MB 历史记忆库
            delete sessionEnv.CODEX_HOME;
          } else {
            // 非群聊（Hub 直开 Codex）保留原有 profile 逻辑
            codexProfile = resolveCodexSubscriptionProfile(cv, opts.codexProfile);
            if (codexProfile.home) {
              sessionEnv.CODEX_HOME = codexProfile.home;
            } else {
              delete sessionEnv.CODEX_HOME;
            }
          }
        }
        // Gemini 走 google.com / Codex 订阅走 openai.com，需走代理过 GFW
        applyProxyEnv(sessionEnv, cv.CLAUDE_PROXY);
      }
    } else if (isDeepSeek) {
      const cv = getConfigValues();
      // V4 Pro / Flash 的 Responses API 国内直连。Key 只走 env_key，不落进
      // config.toml / auth.json；CODEX_HOME 在拿到真实 cwd 后再生成。
      clearProxyEnv(sessionEnv);
      sessionEnv.DEEPSEEK_API_KEY = cv.DEEPSEEK_API_KEY;
      delete sessionEnv.ANTHROPIC_API_KEY;
      delete sessionEnv.ANTHROPIC_API_BASE_URL;
      delete sessionEnv.ANTHROPIC_BASE_URL;
      delete sessionEnv.ANTHROPIC_AUTH_TOKEN;
      delete sessionEnv.CLAUDE_CONFIG_DIR;
    } else if (isKimi) {
      // Kimi Code 会员登录与会话目录由官方 CLI 管理；国内端点默认直连，
      // 避免继承 Hub 的 Gemini/Codex 海外代理后让长流式请求被中途切断。
      clearProxyEnv(sessionEnv);
    }

    // Merge extra env vars (used by TeamSessionManager for MCP config etc.)
    if (opts.extraEnv) {
      Object.assign(sessionEnv, opts.extraEnv);
    }

    const shellArgs = isAgent ? ['-NoProfile', '-NoLogo'] : [];
    // cwd fallback order: opts.cwd (if exists) -> user home. We stat-check to
    // avoid node-pty failing if the stored cwd was later deleted/moved.
    //
    // 2026-07-29 三方审查：workspace 迁到 C:\Vibe 之后，唤醒一个 cwd 已失效的休眠会话会
    // 悄悄落回 Home 起 PTY——UI 零提示、session 记录还显示旧路径，于是「规则没注入 / 记忆
    // 是空的 / 产物写错地方」在 Home 这个聚合根上同时发生，而现场没有任何线索指向 cwd。
    // fallback 本身要保留（否则 node-pty 直接抛错更难用），但必须留痕：日志 + 会话上标记，
    // 让 UI 能把「这个会话已回落到 Home」显示出来。
    let spawnCwd = opts.cwd;
    // dormant 会话若上一轮已经回落，后续 resume 的 cwd=Home 本身是有效目录，必须把
    // 原始失败路径继续带着，否则警告会在第二次唤醒时凭空消失。
    let cwdFellBack = opts.cwdFellBackFrom ? String(opts.cwdFellBackFrom) : null;
    if (spawnCwd) {
      try {
        if (!fs.statSync(spawnCwd).isDirectory()) throw new Error('cwd is not a directory');
      } catch {
        cwdFellBack = spawnCwd;
        spawnCwd = null;
      }
    }
    if (!spawnCwd) {
      spawnCwd = process.env.USERPROFILE || process.env.HOME || '.';
      if (cwdFellBack) {
        console.warn(`[cwd] 会话 ${id} 的 cwd 已失效，回落到 ${spawnCwd}：${cwdFellBack}`);
      }
    }

    // Claude 与旧 DeepSeek-Claude 的入口从这里把 cwd 的
    // memory 桶链到规范记忆库，否则每个 _scratch\inbox-* 都是零记忆开局。
    // 不能让 Codex / Kimi / PowerShell 的启动顺带迁移 Claude 的记忆目录：这段逻辑现在
    // 可能合并真实目录并换 junction，必须只由真正消费该机制的 CLI 触发。
    // 隔离 Hub / E2E 不碰用户主目录的记忆库。
    let memoryLinkWarning = null;
    if (!process.env.CLAUDE_HUB_DATA_DIR) {
      if (isClaude || isDeepSeekLegacy) {
        // ensureMemoryLink **从不 throw** —— 四种保护（错链 / 非普通文件 / memory 是文件 /
        // 锁竞争）全部收进 result.errors 返回。原先这里只写了个 catch 就把返回值丢了，
        // 于是那些保护一条都到不了用户：会话照常起，记忆却接在错误的库上或压根没接，
        // 现场没有任何线索。而同一轮里 cwd 回落已经有了完整的留痕链路，标准不该不一致。
        // 走同一条通道：session 上留痕 → 持久化白名单 → resume → 侧栏/弹窗。
        try {
          const memResult = ensureMemoryLink(spawnCwd, {
            projectRootDirs: [isDeepSeekLegacy ? '.claude-deepseek' : '.claude'],
          });
          if (memResult && memResult.errors.length) {
            memoryLinkWarning = memResult.errors.join('；');
            console.warn('[memory] link 未完成：', memoryLinkWarning);
          }
          if (memResult && (memResult.merged.length || memResult.conflicts.length)) {
            console.log(`[memory] 回收孤岛：并入 ${memResult.merged.length} 条，冲突另存 ${memResult.conflicts.length} 条`);
          }
        } catch (error) {
          memoryLinkWarning = error && error.message ? error.message : String(error);
          console.warn('[memory] ensureMemoryLink failed:', memoryLinkWarning);
        }
      }
      // Kimi 无 .git 时只读 cwd 自己的 AGENTS.md（2026-07-29 探针实测）——给工作区内
      // 「无 git 且无 AGENTS.md」的目录补一份根规则副本；有 git 根的目录不插手。
      if (isKimi && this.workspaceService) {
        try { this.workspaceService.seedUngovernedAgentsFile(spawnCwd); } catch (error) {
          console.warn('[kimi] seedUngovernedAgentsFile failed:', error && error.message);
        }
      }
    }

    if (isClaude) {
      const cv = getConfigValues();
      opts.model = resolveClaudeLaunchModel(cv, opts.model);
    }

    let codexSessionsRoot = null;
    if (isDeepSeek && !isDeepSeekLegacy) {
      const profile = ensureDeepSeekCodexProfile(spawnCwd);
      sessionEnv.CODEX_HOME = profile.codexHome;
      codexSessionsRoot = path.join(profile.codexHome, 'sessions');
      codexProfile = { id: 'deepseek-api', label: 'DeepSeek API · Codex' };
    } else if (isCodex) {
      const cv = getConfigValues();
      if (isCodexApiBackend(cv)) {
        sessionEnv.CODEX_HOME = ensureCodexApiProfile(cv, spawnCwd);
        // API 模式 codex 把 rollout 写到 isolated home（不写 ~/.codex/sessions）。
        // 记到 info 让 transcript-tap 注册时把这个 root 加进 CodexTap 的扫描列表。
        codexSessionsRoot = path.join(sessionEnv.CODEX_HOME, 'sessions');
      } else if (opts.meetingId) {
        // 隔离 Hub / E2E 若显式传入 CODEX_HOME，必须继续使用它；否则群聊
        // 会把临时 scratch 写进用户全局 ~/.codex/config.toml 的 trust 表。
        // 生产 Hub 没有隔离 data dir 时仍沿用默认 ~/.codex，共享原生 memory。
        if (process.env.CLAUDE_HUB_DATA_DIR && process.env.CODEX_HOME) {
          sessionEnv.CODEX_HOME = process.env.CODEX_HOME;
          ensureCodexCwdTrusted(spawnCwd, process.env.CODEX_HOME);
          codexSessionsRoot = path.join(process.env.CODEX_HOME, 'sessions');
        } else {
          delete sessionEnv.CODEX_HOME;
          ensureCodexCwdTrusted(spawnCwd);
          // codexSessionsRoot 保持 null，让 CodexTap 扫默认 ~/.codex/sessions
        }
      } else {
        codexProfile = codexProfile || resolveCodexSubscriptionProfile(cv, opts.codexProfile);
        if (codexProfile.home) {
          sessionEnv.CODEX_HOME = codexProfile.home;
          ensureCodexCwdTrusted(spawnCwd, codexProfile.home);
          // 非默认订阅账号也有独立 rollout root，否则 CodexTap 只扫 ~/.codex/sessions。
          codexSessionsRoot = path.join(codexProfile.home, 'sessions');
        } else {
          delete sessionEnv.CODEX_HOME;
          ensureCodexCwdTrusted(spawnCwd);
        }
      }
    }

    if (isDeepSeekLegacy) {
      ensureClaudeBypassAndTrust(sessionEnv.CLAUDE_CONFIG_DIR, spawnCwd);
    }

    const ptyProcess = pty.spawn('powershell.exe', shellArgs, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: spawnCwd,
      env: sessionEnv,
      useConpty: true,
      // conptyInheritCursor=true kills PTY output for headless sessions (no
      // renderer xterm attached). TeamSessionManager sets noInheritCursor for
      // background character sessions. Normal user sessions don't set it, so
      // the default stays true for backward compatibility.
      // Codex's TUI does dense cursor-addressed redraws; inheriting the host
      // cursor makes Windows ConPTY more prone to transient cursor ghosts.
      conptyInheritCursor: (isCodexRuntime || isKimi) ? false : !opts.noInheritCursor,
    });

    // Claude 共享 ~/.claude.json（当前会话也在用的活跃文件，spawn 时写它有 race 风险），
    // 故不像 DeepSeek/Codex 那样预写 trust；改为检测「trust this folder」信任对话框自动发
    // Enter 确认（默认高亮项=Yes proceed，一次性、race-free）。避免新 meeting workspace 卡
    // trust dialog 致 cli 永不 ready（群聊里该 Claude 全程 no_sent，如投委会主席）。
    if (isClaude) {
      let _trustDone = false;
      let _trustBuf = '';
      const _trustSub = ptyProcess.onData((d) => {
        if (_trustDone) return;
        _trustBuf = (_trustBuf + d).slice(-4000);
        // PTY buffer 在单词间插了 ANSI 光标移动序列（trust[1Cthis[1Cfolder），
        // 连续匹配永不命中 → 先 strip CSI（含 final 字母）+ 去非字母，再匹配连续字母串。
        const _alpha = _trustBuf.replace(/\[[^A-Za-z]*[A-Za-z]/g, '').toLowerCase().replace(/[^a-z]/g, '');
        if ((_alpha.includes('trustthisfolder') || _alpha.includes('trustthefiles')) && _alpha.includes('toconfirm')) {
          _trustDone = true;
          try { ptyProcess.write('\r'); } catch {}
          try { _trustSub.dispose(); } catch {}
        }
      });
      setTimeout(() => { if (!_trustDone) { try { _trustSub.dispose(); } catch {} } }, 45000);
    }

    let currentModel = null;
    if (isClaude) {
      // 默认走 DEFAULT_MODEL_BY_KIND.claude（当前 Opus 4.8 1M）；
      // AI 群聊 Modal 选 sonnet-4.5 等时透传 opts.model。
      const mid = opts.model || DEFAULT_MODEL_BY_KIND.claude;
      currentModel = { id: mid, displayName: mid };
    } else if (isGemini) {
      const mid = opts.model || 'gemini-3-pro-preview';
      currentModel = { id: mid, displayName: SessionManager.geminiDisplayName(mid) };
    } else if (isCodex) {
      const cv = getConfigValues();
      // opts.model（modal/picker 用户选择）必须最高优先级；只有未传时才落到 backend 默认 / DEFAULT_MODEL_BY_KIND.codex。
      // 旧写法 `isCodexApiBackend ? cv.CODEX_API_MODEL : (opts.model || ...)` 在 packy api 模式下
      // 强制覆盖用户选择，AI 群聊选 5.4/5.3 实际跑出来都是 5.5。
      const cmid = normalizeCodexSessionModel(opts.model || resolveDefaultCodexModel(cv));
      currentModel = { id: cmid, displayName: cmid.toUpperCase() };
    } else if (isDeepSeek) {
      const mid = isDeepSeekLegacy
        ? normalizeLegacyDeepSeekClaudeModel(opts.model)
        : normalizeDeepSeekModel(opts.model);
      currentModel = {
        id: mid,
        displayName: isDeepSeekLegacy
          ? legacyDeepSeekClaudeDisplayName(mid)
          : deepseekDisplayName(mid),
      };
    } else if (isKimi) {
      const mid = opts.model || DEFAULT_MODEL_BY_KIND.kimi;
      currentModel = { id: mid, displayName: mid === 'kimi-code/k3' || mid === 'k3' ? 'Kimi K3' : mid };
    }

    const effectiveCodexMcpProfile = isCodexRuntime
      ? resolveCodexMcpProfile(kind, opts.mcpProfile)
      : null;
    const effectiveCodexSpeedTier = isCodexRuntime
      ? resolveCodexSpeedTier(kind, opts.codexSpeedTier)
      : null;
    const normalizedContextMax = normalizeCodexContextWindow(opts.contextMax);
    const effectiveContextMax = isCodexRuntime
      ? (normalizedContextMax || resolveCodexContextWindow(currentModel && currentModel.id, null))
      : (typeof opts.contextMax === 'number' ? opts.contextMax : null);
    const initialNightGuard = sanitizeNightGuardState(opts.nightGuard);

    const now = Date.now();
    const info = {
      id,
      kind,
      title,
      status: 'idle',
      connectionIssue: null,
      lastMessageTime: opts.lastMessageTime || now,
      lastOutputPreview: opts.lastOutputPreview || '',
      unreadCount: 0,
      ...(opts.pinned ? { pinned: true } : {}),
      createdAt: now,
      cwd: spawnCwd,
      // 原 cwd 失效被迫回落时留痕，UI 据此提示「这个会话没跑在它原来的目录里」。
      ...(cwdFellBack ? { cwdFellBackFrom: cwdFellBack } : {}),
      // 必须显式携带 null：resume 时 renderer 会用 {...旧会话, ...新会话} 合并；若成功
      // 场景省略字段，旧的 warning 会继续粘在 UI 上，即使本轮检测已经恢复正常。
      memoryLinkWarning: memoryLinkWarning || null,
      ...(opts.workspaceLabel ? { workspaceLabel: String(opts.workspaceLabel) } : {}),
      meetingId: opts.meetingId || null,
      // Delivery is opt-in per conversation. Never inherit the former global
      // switch into a newly-created session.
      completionNotificationEnabled: opts.completionNotificationEnabled === true,
      ...(initialNightGuard ? { nightGuard: initialNightGuard } : {}),
      ...(opts.purpose ? { purpose: String(opts.purpose) } : {}),
      ...(opts.researchSessionId ? { researchSessionId: String(opts.researchSessionId) } : {}),
      ...(opts.chuxinTaskId ? { chuxinTaskId: String(opts.chuxinTaskId) } : {}),
      ...(Array.isArray(opts.heroIds) ? { heroIds: opts.heroIds.slice(0, 4).map(String) } : {}),
      ...(opts.promptPolicyVersion ? { promptPolicyVersion: String(opts.promptPolicyVersion) } : {}),
      ...(opts.hiddenFromSidebar ? { hiddenFromSidebar: true } : {}),
      currentModel,
      ...(typeof opts.contextPct === 'number' ? { contextPct: opts.contextPct } : {}),
      ...(typeof opts.contextUsed === 'number' ? { contextUsed: opts.contextUsed } : {}),
      ...(typeof effectiveContextMax === 'number' ? { contextMax: effectiveContextMax } : {}),
      // contextMax is the launch request and must remain stable for
      // resume/fork/relaunch. Codex reports the clamped effective value later
      // through token_count; keep that observation in a separate field.
      ...(typeof opts.contextEffectiveMax === 'number' ? { contextEffectiveMax: opts.contextEffectiveMax } : {}),
      ...(typeof opts.contextEffectiveObservedAt === 'number'
        ? { contextEffectiveObservedAt: opts.contextEffectiveObservedAt }
        : {}),
      codexSessionsRoot,
      // registerSessionForTap uses this internal routing hint while the public
      // kind remains "deepseek" for branding and family identity.
      ...(isDeepSeekLegacy ? { transcriptKind: kind === 'deepseek-resume' ? 'deepseek-legacy-resume' : 'deepseek-legacy' } : {}),
      ...(isCodexRuntime && codexProfile ? { codexProfile: codexProfile.id, codexProfileLabel: codexProfile.label } : {}),
      ...(isCodexRuntime ? { mcpProfile: effectiveCodexMcpProfile } : {}),
      // 速度通道必须连同 inherit 一起落盘，否则显式选择"跟随全局"的会话在
      // resume/relaunch 后会被 Codex 新默认 Fast 覆盖。
      ...(isCodexRuntime ? { codexSpeedTier: effectiveCodexSpeedTier } : {}),
      // Claude 家族的 MCP 档位默认 full（全量继承，与改动前一致），与 Codex 的
      // none 默认各走各的。落到 info 是为了 resume/fork/relaunch 能沿用。
      ...(isClaudeFamily(kind) && !isDeepSeekLegacy
        ? { mcpProfile: normalizeClaudeMcpProfile(opts.mcpProfile) } : {}),
      // 迁移前的 DeepSeek 仍跑 Claude CLI。旧群聊没有 profile 字段时按历史的
      // strict/空全局 MCP 语义回落 Lean；恢复与原地 relaunch 都据此重建。
      ...(isDeepSeekLegacy
        ? { mcpProfile: normalizeClaudeMcpProfile(opts.mcpProfile || 'lean') } : {}),
      // fast 只对 Claude 家族有意义；显式关掉才落盘，避免给老会话凭空加字段。
      ...(opts.fastMode === false ? { fastMode: false } : {}),
      // 记录经过 runtime 白名单归一化的 effort，让 resume / fork / relaunch
      // 沿用同一档位。不要直接存 opts.effort：否则非法 IPC 值虽然首次启动会
      // 回落，却会污染元数据并在后续恢复时再次扩散。
      ...(isClaude && CLAUDE_EFFORT_LEVELS.has(opts.effort) ? { effort: opts.effort } : {}),
      ...(isCodexRuntime && opts.effort ? { effort: normalizeCodexEffort(opts.effort) } : {}),
      ...(opts.codexSid ? { codexSid: opts.codexSid } : {}),
      ...(opts.geminiChatId ? { geminiChatId: opts.geminiChatId } : {}),
      ...(opts.geminiProjectHash ? { geminiProjectHash: opts.geminiProjectHash } : {}),
      ...(opts.geminiProjectRoot ? { geminiProjectRoot: opts.geminiProjectRoot } : {}),
      ...(opts.kimiSid ? { kimiSid: opts.kimiSid } : {}),
      ...(opts.kimiSessionDir ? { kimiSessionDir: opts.kimiSessionDir } : {}),
      ...(isCodexRuntime && (kind.endsWith('-resume') || opts.codexResumePicker || (opts.useResume && !opts.codexSid)) ? { codexAllowMtimeFallback: true } : {}),
      ...(opts.userRenamed ? { userRenamed: true } : {}),
      ...(opts.autoTitleGenerated ? { autoTitleGenerated: true } : {}),
      ...(opts.branchSourceSessionId ? { branchSourceSessionId: String(opts.branchSourceSessionId) } : {}),
      ...(Number.isInteger(Number(opts.branchIndex)) && Number(opts.branchIndex) > 0
        ? { branchIndex: Number(opts.branchIndex) }
        : {}),
      ...(typeof opts.branchAutoTitlePending === 'boolean'
        ? { branchAutoTitlePending: opts.branchAutoTitlePending }
        : {}),
      // Spec 3 · W3 resume bug fix (a)：resume 启动时立即写入已知 ccSessionId，
      // 不等 Stop hook 第一次回调。否则 spawn 到第一次 Stop 之间 (~数秒) 卡片视图
      // 拿不到 ccSessionId → IPC parse-session-transcript 返 'transcript not found' → 空白。
      // 普通新建（非 resume）opts.resumeCCSessionId 为 undefined，info.ccSessionId 也为 undefined，
      // _toPublic 的 `info.ccSessionId !== undefined` 检查会跳过该字段，行为不变。
      ...(opts.resumeCCSessionId ? { ccSessionId: opts.resumeCCSessionId } : {}),
      ...(opts.resumeTranscriptPath ? { transcriptPath: opts.resumeTranscriptPath } : {}),
    };

    const pendingTimers = [];
    // groupChatReady：群聊"快路径"缓存，CLI 首次 ready 后置 true，
    //   后续 groupChatWatcher.sendToPty 跳过 8s/8s/5s 硬 sleep；活性兜底失败时重置 false。
    // groupChatLastActivity：PTY 最近一次产出输出的 ms 时间戳，用于活性兜底判断。
    let terminalSnapshot = null;
    try {
      terminalSnapshot = new TerminalSnapshot({ cols: 120, rows: 30, scrollback: 10000 });
    } catch (error) {
      // Dependency/init failure must not prevent the CLI from starting. The old
      // The terminal ring remains available as an explicit degraded fallback.
      console.warn('[terminal-snapshot] init failed, using terminal ring fallback:', error && error.message);
    }
    this.sessions.set(id, {
      info,
      pty: ptyProcess,
      codexMcpEntries: effectiveCodexMcpProfile !== 'none' && Array.isArray(opts.codexMcpEntries)
        ? opts.codexMcpEntries.map((entry) => ({ ...entry, env: { ...(entry.env || {}) } }))
        : [],
      // Claude 群聊的 research / 通信 MCP 在 CLI 原地 relaunch 时也要继续存在。
      claudeMcpConfigFile: typeof opts.mcpConfigFile === 'string' ? opts.mcpConfigFile : null,
      pendingTimers,
      ringBuffer: '',
      terminalSnapshot,
      // Codex's inline TUI uses partial-region scrolls that xterm.js drops
      // instead of committing to scrollback. Transform once at the shared PTY
      // boundary so the renderer, terminal-ring fallback, and TerminalSnapshot all see
      // the same lossless terminal stream. Legacy DeepSeek runs Claude and is
      // deliberately excluded; new DeepSeek uses the Codex runtime.
      terminalOutputRewriter: isCodexRuntime ? new CodexXtermScrollbackRewriter({
        cols: 120,
        rows: 30,
        // On Windows, ConPTY consumes Codex's original region-scroll command
        // before node-pty sees it and emits a synchronized home-based repaint.
        // The rewriter handles that serialized form as well as raw VT streams.
        conptySerialized: process.platform === 'win32',
      }) : null,
      terminalOutputFlushTimer: null,
      lastOutputSeq: 0,
      groupChatReady: false,
      groupChatLastActivity: 0,
      startedAt: now,
      lastInputAt: 0,
      lastOutputAt: 0,
      suspendRequestedAt: 0,
      suspendReason: null,
    });

    const deliverTerminalData = (terminalData) => {
      if (!terminalData) return;
      const current = this.sessions.get(id);
      if (!current || current.pty !== ptyProcess) return;
      this._appendToRingBuffer(id, terminalData);
      this._outputSeq += 1;
      const seq = this._outputSeq;
      current.lastOutputSeq = seq;
      if (current.terminalSnapshot) current.terminalSnapshot.write(terminalData, seq);
      this.onData(id, terminalData, seq);
      this.emit('output', { sessionId: id, seq, data: terminalData });
    };

    const scheduleTerminalOutputFlush = (entry) => {
      if (!entry || !entry.terminalOutputRewriter || !entry.terminalOutputRewriter.hasPending()) return;
      entry.terminalOutputFlushTimer = setTimeout(() => {
        const current = this.sessions.get(id);
        if (!current || current.pty !== ptyProcess || !current.terminalOutputRewriter) return;
        current.terminalOutputFlushTimer = null;
        try {
          deliverTerminalData(current.terminalOutputRewriter.flush());
        } catch (error) {
          // Timed fail-open is best-effort; never let preservation affect PTY
          // liveness even if a future rewriter implementation regresses.
          console.warn('[codex-scrollback] pending output flush failed:', error && error.message);
        }
      }, TERMINAL_REWRITER_FLUSH_MS);
    };

    ptyProcess.onData((data) => {
      const entry = this.sessions.get(id);
      // Match the exit-path id-reuse guard: late bytes from an old PTY must
      // never mutate the replacement session's rewriter or terminal state.
      if (!entry || entry.pty !== ptyProcess) return;
      entry.groupChatLastActivity = Date.now();
      entry.lastOutputAt = entry.groupChatLastActivity;
      if (entry.terminalOutputFlushTimer) {
        clearTimeout(entry.terminalOutputFlushTimer);
        entry.terminalOutputFlushTimer = null;
      }
      let terminalData = data;
      if (entry.terminalOutputRewriter) {
        try {
          terminalData = entry.terminalOutputRewriter.write(data);
        } catch (error) {
          // Display preservation must never be allowed to interrupt the PTY.
          console.warn('[codex-scrollback] rewrite failed, passing raw output:', error && error.message);
          let pending = '';
          try { pending = entry.terminalOutputRewriter.flush(); } catch {}
          entry.terminalOutputRewriter = null;
          terminalData = pending + data;
        }
      }
      deliverTerminalData(terminalData);
      scheduleTerminalOutputFlush(entry);
    });

    ptyProcess.onExit((exitInfo) => {
      const entry = this.sessions.get(id);
      if (entry && entry.pty === ptyProcess && entry.terminalOutputFlushTimer) {
        clearTimeout(entry.terminalOutputFlushTimer);
        entry.terminalOutputFlushTimer = null;
      }
      if (entry && entry.pty === ptyProcess && entry.terminalOutputRewriter) {
        try { deliverTerminalData(entry.terminalOutputRewriter.flush()); } catch {}
      }
      this._handlePtyExit(id, ptyProcess, exitInfo);
    });

    if (kind === 'powershell') {
      ptyProcess.write('Set-PSReadLineOption -PredictionViewStyle ListView 2>$null; clear\r\n');
    }

    if (isClaude) {
      // 所有路径（fresh / resume / continue）都显式传 --model，
      // 防止 user-level ~/.claude/settings.local.json 的 model 字段（被 /model 命令污染）
      // 影响 resume 出来的 session。Claude CLI 的 --resume 仅恢复 transcript 对话历史，
      // 不从 transcript 反推 model 设置；下一条消息的 model 解析顺序为
      // CLI --model > env > settings 文件，所以必须显式覆盖。
      // opts.model 让 meeting-create-modal 选定的非默认 model（如 sonnet-4.5）生效。
      const model = opts.model || DEFAULT_MODEL_BY_KIND.claude;
      // 默认 --effort max：用户偏好"立花道雪工作台"所有 Claude 会话上 max effort。
      // settings.json 持久档为 effortLevel: max（CLI --effort 合法枚举：low/medium/high/xhigh/max；
      // ultracode 不是合法 --effort 枚举值，旧注释把它当 enum 是错的）。
      // 这里 --effort max 与 settings.effortLevel=max 同值，作为"防御性显式指定"——
      //   防止 settings.local.json 或 /effort 命令污染把会话降到低档。
      // ultracode 是独立的 per-turn 关键词触发器（在 prompt 里输入 "ultracode" 字面词
      //   即可本回合 opt-in workflow tool + xhigh effort），由 settings.json 的
      //   `workflowKeywordTriggerEnabled` 控制（默认 on，无需显式写）。注意：UI/遥测
      //   名为 ultracodeKeywordTrigger，但 on-disk key 实际是 workflowKeywordTriggerEnabled。
      //   --effort max 不会阻塞该触发器，因为触发器是会话内独立 toggle，与启动 flag 解耦。
      // CLAUDE_HUB_NO_EFFORT_MAX=1 可关启动期注入。
      // opts.effort 让新建会话弹窗选定的档位生效（枚举外的值一律忽略，回落 max，
      // 避免把非法字符串拼进 PTY 命令行）。
      const effort = CLAUDE_EFFORT_LEVELS.has(opts.effort) ? opts.effort : 'max';
      const effortFlag = process.env.CLAUDE_HUB_NO_EFFORT_MAX === '1' ? '' : ` --effort ${effort}`;
      let cmd;
      if (opts.forkCCSessionId) {
        cmd = ` claude --resume ${opts.forkCCSessionId} --fork-session --model ${model}${effortFlag}`;
      } else if (opts.resumeCCSessionId) {
        cmd = ` claude --resume ${opts.resumeCCSessionId} --model ${model}${effortFlag}`;
      } else if (opts.useContinue) {
        cmd = ` claude --continue --model ${model}${effortFlag}`;
      } else if (kind === 'claude-resume') {
        cmd = ` claude --resume --model ${model}${effortFlag}`;
      } else {
        cmd = ` claude --model ${model}${effortFlag}`;
      }
      // Append system prompt file if provided (TeamSessionManager injects character prompt)
      if (opts.appendSystemPromptFile) {
        cmd += ` --append-system-prompt-file "${opts.appendSystemPromptFile.replace(/\\/g, '\\\\')}"`;
      }
      // 群聊按成员选择 MCP 档位，同时把 research/通信 MCP 合并进同一个
      // --mcp-config 列表；它们是房间能力，不能被 Lean/Browser/Wireless 过滤掉。
      if (opts.meetingId) {
        const mcpPlan = buildClaudeMeetingMcpArgs({
          mcpConfigFile: opts.mcpConfigFile,
          mcpProfile: opts.mcpProfile,
          cwd: spawnCwd,
          hubDataDir: getHubDataDir(),
        });
        cmd += mcpPlan.args;
        console.log(`[claude-mcp] ${kind} 群聊档位=${mcpPlan.profile} 保留=${mcpPlan.keptServers.join(',') || '(无额外全局 MCP)'}`);
      // Append MCP config file if provided (TeamSessionManager injects MCP server config)
      } else if (opts.mcpConfigFile) {
        cmd += ` --mcp-config "${opts.mcpConfigFile.replace(/\\/g, '\\\\')}"`;
      } else {
        // 单人会话的 MCP 加载档位（对标 Codex 的 lean/browser/wireless/full）。
        // 默认 full = 全量继承 = 改动前的行为；选了别的档才生成过滤后的 config。
        const mcpPlan = buildClaudeMcpProfileArgs({
          mcpProfile: opts.mcpProfile,
          cwd: spawnCwd,
          hubDataDir: getHubDataDir(),
        });
        if (mcpPlan.args) {
          cmd += mcpPlan.args;
          console.log(`[claude-mcp] ${kind} 档位=${mcpPlan.profile} 保留=${mcpPlan.keptServers.join(',') || '(无)'}`);
        }
      }
      // 群聊成员：禁 skill + plugin（保留 auto-memory / CLAUDE.md / OAuth）
      cmd += buildGroupChatIsolationFlags(opts.meetingId);
      // 默认开启 fast 模式（仅 Opus 4.6/4.7/4.8 生效，非 Opus 会被忽略）。
      // 通过 --settings 叠加用户既有 settings；用户仍可在 session 内 /fast 关闭。
      // 用 settings 文件而非 inline JSON，规避 PS 5.1 向 native exe 传内嵌双引号的 quoting bug。
      // 2026-06-11：实测 fastMode 交互式会话不落盘 transcript jsonl（/exit 后仍空），
      //   导致 transcript-tap 拿不到 turn 文本 → 卡片同步收不到回复。
      //   CLAUDE_HUB_NO_FAST=1 可全局禁用 fast 注入；
      //   新建会话弹窗的「快速模式」开关则是按会话关（opts.fastMode === false）。
      const cv = getConfigValues();
      if (shouldUseClaudeFastSettings(cv, opts)) {
        const fastSettingsPath = resolveAsarUnpacked('claude-subscription-fast-settings.json');
        cmd += ` --settings "${fastSettingsPath.replace(/\\/g, '\\\\')}"`;
      }
      cmd += '\r\n';
      let sent = false;
      let debounceTimer = null;
      const watcher = ptyProcess.onData(() => {
        if (sent) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          if (sent) return;
          sent = true;
          watcher.dispose();
          const s = this.sessions.get(id);
          if (s) s.pty.write(cmd);
        }, 200);
      });
      const safetyTimer = setTimeout(() => {
        if (sent) return;
        sent = true;
        watcher.dispose();
        if (debounceTimer) clearTimeout(debounceTimer);
        const s = this.sessions.get(id);
        if (s) s.pty.write(cmd);
      }, 3000);
      pendingTimers.push(safetyTimer);
    }

    if (isGemini) {
      let cmd = ' gemini --approval-mode yolo';
      cmd += ` --model ${opts.model || 'gemini-3-pro-preview'}`;
      if (opts.useResume && opts.geminiChatId && opts.geminiChatId.length > 8) {
        // Level 1: precise resume by full UUID.  The native id wins even when
        // the persisted public kind is gemini-resume.
        cmd += ` --resume ${opts.geminiChatId}`;
      } else if (kind === 'gemini-resume' || opts.useResume) {
        // Level 2: 8charId (old state.json format) or no chatId → fall back to latest
        cmd += ' --resume latest';
      }
      cmd += '\r\n';
      let sent = false;
      let debounceTimer = null;
      const watcher = ptyProcess.onData(() => {
        if (sent) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          if (sent) return;
          sent = true;
          watcher.dispose();
          const s = this.sessions.get(id);
          if (s) s.pty.write(cmd);
        }, 200);
      });
      const safetyTimer = setTimeout(() => {
        if (sent) return;
        sent = true;
        watcher.dispose();
        if (debounceTimer) clearTimeout(debounceTimer);
        const s = this.sessions.get(id);
        if (s) s.pty.write(cmd);
      }, 3000);
      pendingTimers.push(safetyTimer);
    }

    if (isCodexRuntime) {
      // Remove legacy room MCP blocks left by older Hub versions. Current room
      // entries are injected only into this CLI command below.
      ensureCodexMcpEntries(sessionEnv.CODEX_HOME || null, [], CODEX_MANAGED_MCP_NAMES);
      dismissCodexUpdatePrompt(undefined, sessionEnv.CODEX_HOME || null);
      dismissCodexRateLimitDialog(undefined, sessionEnv.CODEX_HOME || null);
      const cv = getConfigValues();
      const codexModel = isDeepSeek
        ? normalizeDeepSeekModel(opts.model)
        : normalizeCodexSessionModel(opts.model || resolveDefaultCodexModel(cv));
      // Codex 的 model_reasoning_effort 是推理深度；fast 则由下面独立的
      // service_tier 控制，两者都不能和 Claude fastMode 混为一谈。
      // 非法值一律回落 max；群聊与普通 Session 一样尊重逐成员的 effort / service_tier。
      const codexReasoningArg = buildCodexReasoningConfigArg(normalizeCodexEffort(opts.effort))
        + buildCodexSpeedTierArg(effectiveCodexSpeedTier)
        + buildCodexContextWindowArg(effectiveContextMax);
      const codexInstructionFile = opts.codexInstructionFile || null;
      let cmd;
      if (opts.codexForkSid) {
        cmd = ` codex fork ${opts.codexForkSid} --dangerously-bypass-approvals-and-sandbox --model ${codexModel}${codexReasoningArg}`;
      } else if (opts.useResume && opts.codexSid) {
        // Level 1: precise resume by sid
        cmd = ` codex resume ${opts.codexSid} --dangerously-bypass-approvals-and-sandbox --model ${codexModel}${codexReasoningArg}`;
      } else if (kind.endsWith('-resume') || opts.codexResumePicker) {
        // Native id is unknown: show the picker.  Exact ids must win even when
        // the persisted public kind is "codex-resume" or "deepseek-resume".
        cmd = ` codex resume --dangerously-bypass-approvals-and-sandbox --model ${codexModel}${codexReasoningArg}`;
      } else if (opts.useResume) {
        // Level 2 degradation: no sid recorded → use --last
        cmd = ` codex resume --last --dangerously-bypass-approvals-and-sandbox --model ${codexModel}${codexReasoningArg}`;
      } else {
        // Research mode：完全 bypass approvals + sandbox（含 MCP 工具调用、shell 命令、文件写）
        // 避免任何 "Allow ... ?" 弹窗阻塞投研讨论流程；
        // 安全约束完全靠 prompt/covenant 软约束（已强化"不要改代码 / 不要 git / 不要删除"）
        // opts.model 让 meeting-create-modal 选定的非默认 model（如 gpt-5.4）生效。
        if (opts.codexBypassApprovals) {
          cmd = ` codex --dangerously-bypass-approvals-and-sandbox --model ${codexModel}${codexReasoningArg}`;
        } else {
          cmd = ` codex --dangerously-bypass-approvals-and-sandbox --model ${codexModel}${codexReasoningArg}`;
        }
        // 注：曾尝试 --no-alt-screen 改善观感，实测无明显改善 + Enter 提交失效 → 撤回。
        // 渲染观感问题改由"持久化 AI 群聊面板"（直接展示干净回答预览）绕过。
      }
      if (codexInstructionFile) {
        cmd += ` -c "model_instructions_file=${codexInstructionFile.replace(/\\/g, '\\\\')}"`;
      }
      const effectiveCodexMcpEntries = effectiveCodexMcpProfile === 'none' ? [] : opts.codexMcpEntries;
      cmd += buildCodexEphemeralMcpArgs(effectiveCodexMcpEntries);
      const allowedGroupMcpNames = [
        ...(effectiveCodexMcpProfile === 'none' ? [] : CODEX_MANAGED_MCP_NAMES),
        ...(Array.isArray(effectiveCodexMcpEntries) ? effectiveCodexMcpEntries.map(entry => entry && entry.name) : []),
      ];
      cmd += buildCodexMcpIsolationArgs(sessionEnv.CODEX_HOME || null, {
        meetingId: opts.meetingId,
        cwd: spawnCwd,
        mcpProfile: effectiveCodexMcpProfile,
        allowedNames: allowedGroupMcpNames,
      });
      if (opts.useResume && opts.codexSid && typeof opts.codexInitialPrompt === 'string'
          && opts.codexInitialPrompt.trim()) {
        cmd += ` ${quotePowerShellLiteral(opts.codexInitialPrompt.trim())}`;
      }
      cmd += '\r\n';
      let sent = false;
      let debounceTimer = null;
      const watcher = ptyProcess.onData(() => {
        if (sent) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          if (sent) return;
          sent = true;
          watcher.dispose();
          this._writeManagedCodexLaunch(id, cmd, 'create-pty-ready');
        }, 200);
      });
      const safetyTimer = setTimeout(() => {
        if (sent) return;
        sent = true;
        watcher.dispose();
        if (debounceTimer) clearTimeout(debounceTimer);
        this._writeManagedCodexLaunch(id, cmd, 'create-safety-timeout');
      }, 3000);
      pendingTimers.push(safetyTimer);

      // picker 模式下把 Filter 从 Cwd 切到 All，让所有目录的历史会话都列出来
      if (kind.endsWith('-resume') || opts.codexResumePicker) {
        this._autoExpandResumePicker(id, ptyProcess, {
          marker: /Resume a previous session|Filter:\s*\[?Cwd\]?/i,
          key: '\x1b[C',   // Right
        });
      }
    }

    if (isDeepSeekLegacy) {
      let cmd;
      // 仅用于恢复迁移前的 Claude transcript。新 DeepSeek 会话已经在上面的
      // isCodexRuntime 分支通过 Responses API 启动。
      if (opts.forkCCSessionId) {
        // DeepSeek 也是 claude CLI，--fork-session 同样可用；接上之后分支功能不再是
        // Claude/Codex 专属（Kimi CLI 没有 fork 能力，只有 --session/--continue）。
        const model = normalizeLegacyDeepSeekClaudeModel(opts.model);
        cmd = ` claude --resume ${opts.forkCCSessionId} --fork-session --model ${model} --permission-mode bypassPermissions`;
      } else if (opts.resumeCCSessionId) {
        const model = normalizeLegacyDeepSeekClaudeModel(opts.model);
        cmd = ` claude --resume ${opts.resumeCCSessionId} --model ${model} --permission-mode bypassPermissions`;
      } else if (kind === 'deepseek-resume') {
        const model = normalizeLegacyDeepSeekClaudeModel(opts.model);
        cmd = ` claude --resume --model ${model} --permission-mode bypassPermissions`;
      } else if (opts.useContinue) {
        const model = normalizeLegacyDeepSeekClaudeModel(opts.model);
        cmd = ` claude --continue --model ${model} --permission-mode bypassPermissions`;
      } else {
        cmd = ` claude --model ${normalizeLegacyDeepSeekClaudeModel(opts.model)} --permission-mode bypassPermissions`;
      }
      // 迁移前的 DeepSeek 群聊同样按成员档位合并投研 MCP；无历史字段时 Lean
      // 保持原先 strict 隔离行为，避免恢复老会话后突然拉起全部全局 MCP。
      if (opts.meetingId) {
        const mcpPlan = buildClaudeMeetingMcpArgs({
          mcpConfigFile: opts.mcpConfigFile,
          mcpProfile: opts.mcpProfile || 'lean',
          cwd: spawnCwd,
          hubDataDir: getHubDataDir(),
        });
        cmd += mcpPlan.args;
      // 群聊投研场景 MCP server 注入（与 isClaude 分支同款；2026-05-28 补齐 DS/GLM/GPT/Kimi/Qwen 五家漏接）
      } else if (opts.mcpConfigFile) {
        cmd += ` --mcp-config "${opts.mcpConfigFile.replace(/\\/g, '\\\\')}"`;
      }
      // P0.4 STEP 1 补齐：5 家 Claude-family 都拼 --append-system-prompt-file
      if (opts.appendSystemPromptFile) {
        cmd += ` --append-system-prompt-file "${opts.appendSystemPromptFile.replace(/\\/g, '\\\\')}"`;
      }
      // 群聊成员：禁 skill + plugin
      cmd += buildGroupChatIsolationFlags(opts.meetingId);
      cmd += '\r\n';
      let sent = false;
      let debounceTimer = null;
      const watcher = ptyProcess.onData(() => {
        if (sent) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          if (sent) return;
          sent = true;
          watcher.dispose();
          const s = this.sessions.get(id);
          if (s) s.pty.write(cmd);
        }, 200);
      });
      const safetyTimer = setTimeout(() => {
        if (sent) return;
        sent = true;
        watcher.dispose();
        if (debounceTimer) clearTimeout(debounceTimer);
        const s = this.sessions.get(id);
        if (s) s.pty.write(cmd);
      }, 3000);
      pendingTimers.push(safetyTimer);
    }

    if (isKimi) {
      const model = opts.model || DEFAULT_MODEL_BY_KIND.kimi;
      // 首次 OAuth 前，官方 CLI 尚未把 managed K3 alias 写入 config.toml；此时强传
      // `--model kimi-code/k3` 会在 TUI 出现前直接退出，用户反而无法输入 /login。
      // 未配置时先启动原生登录 TUI；OAuth 完成后官方刷新会写入该 alias，后续启动再显式锁 K3。
      let cmd = `${kimiCommandPrefix(sessionEnv)} --yolo${kimiModelArg(model, sessionEnv)}`;
      if (opts.useResume && opts.kimiSid) {
        cmd += ` --session ${quotePowerShellLiteral(opts.kimiSid)}`;
      } else if (kind === 'kimi-resume' || opts.kimiResumePicker) {
        cmd += ' --session';
      } else if (opts.useContinue) {
        cmd += ' --continue';
      }
      cmd += '\r\n';
      let sent = false;
      let debounceTimer = null;
      const watcher = ptyProcess.onData(() => {
        if (sent) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          if (sent) return;
          sent = true;
          watcher.dispose();
          const s = this.sessions.get(id);
          if (s) s.pty.write(cmd);
        }, 200);
      });
      const safetyTimer = setTimeout(() => {
        if (sent) return;
        sent = true;
        watcher.dispose();
        if (debounceTimer) clearTimeout(debounceTimer);
        const s = this.sessions.get(id);
        if (s) s.pty.write(cmd);
      }, 3000);
      pendingTimers.push(safetyTimer);

      // picker 模式下按 Ctrl+A 展开全部会话（默认只列当前目录）。
      // marker 必须够窄：这两条只在 picker 的页脚/空态里出现。曾经把 `Sessions\b`
      // 也算作命中，但那个词在正常输出里也可能出现，一旦误判就会往用户的实时会话里
      // 打进一个 Ctrl+A（TUI 里通常是行首/全选），属于可见的干扰。
      if (kind === 'kimi-resume' || opts.kimiResumePicker) {
        this._autoExpandResumePicker(id, ptyProcess, {
          marker: /Ctrl\+A\s+all|No sessions found/i,
          key: '\x01',   // Ctrl+A
        });
      }
    }

    return { ...info };
  }

  _handlePtyExit(sessionId, ptyProcess, exitInfo) {
    const shutdownWaiter = this._shutdownExitWaiters.get(sessionId);
    const isShutdownExit = !!(shutdownWaiter && shutdownWaiter.pty === ptyProcess);
    const entry = this.sessions.get(sessionId);
    // Guard against id reuse: if a fresh session has already taken this id
    // (e.g., via restart-session reusing old.id), the entry's pty will be the
    // new one. Never delete that replacement when the old PTY exits late.
    if (!entry || entry.pty !== ptyProcess) {
      if (isShutdownExit) {
        this._shutdownExitWaiters.delete(sessionId);
        shutdownWaiter.resolve(exitInfo || null);
      }
      return false;
    }
    const meetingId = entry.info ? entry.info.meetingId : null;
    const wasSuspended = !!entry.suspendRequestedAt;
    const dormantInfo = wasSuspended
      ? {
        ...entry.info,
        status: 'dormant',
        suspendedAt: entry.suspendRequestedAt,
        suspendReason: entry.suspendReason || 'manual',
      }
      : null;
    if (entry.terminalSnapshot) entry.terminalSnapshot.dispose();
    this.sessions.delete(sessionId);
    // App shutdown is process cleanup, not a user request to delete or suspend
    // a logical session. Preserve meeting membership and persisted cards; the
    // final shutdown flush writes the same logical state that existed before
    // PTY drainage began.
    if (isShutdownExit) {
      this._shutdownExitWaiters.delete(sessionId);
      shutdownWaiter.resolve(exitInfo || null);
      const shutdownDormantInfo = {
        ...entry.info,
        status: 'dormant',
        suspendedAt: Date.now(),
        suspendReason: 'shutdown-cancelled',
      };
      if (shutdownWaiter.timedOut) {
        this.onSessionSuspended(sessionId, meetingId, shutdownDormantInfo, exitInfo || null);
      } else {
        this._shutdownDrainedSessions.set(sessionId, {
          meetingId,
          session: shutdownDormantInfo,
          exitInfo: exitInfo || null,
        });
      }
      return true;
    }
    if (wasSuspended) {
      this.onSessionSuspended(sessionId, meetingId, dormantInfo, exitInfo || null);
    } else {
      this.onSessionClosed(sessionId, meetingId, exitInfo || null);
    }
    return true;
  }

  closeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    // An explicit close wins over an in-flight suspend request.
    session.suspendRequestedAt = 0;
    for (const t of session.pendingTimers) clearTimeout(t);
    if (!session.pty) {
      if (session.terminalSnapshot) session.terminalSnapshot.dispose();
      this.sessions.delete(sessionId);
      this.onSessionClosed(sessionId, null, { noPty: true });
      return;
    }
    session.pty.kill();
    // Do NOT delete from this.sessions here — the onExit handler does it.
    // The guard in onExit (entry.pty !== ptyProcess) requires the entry to
    // still be present so it can confirm the dying pty owns the entry.
    // Deleting early makes onExit see entry=undefined and return early, so
    // onSessionClosed never fires and the renderer never receives
    // `session-closed` — which is exactly the "X button does nothing" bug.
  }

  closeSessionRecoverably(sessionId, options = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { ok: false, error: 'session-not-found', message: '会话不存在或已经休眠' };
    }
    if (!supportsRecoverableSuspend(session.info)) {
      this.closeSession(sessionId);
      return { ok: true, sessionId, action: 'closed', recoverable: false };
    }
    const result = this.suspendSession(sessionId, {
      ...options,
      reason: options.reason || 'user-close',
    });
    return result && result.ok
      ? { ...result, action: 'suspended', recoverable: true }
      : result;
  }

  suspendSession(sessionId, options = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { ok: false, error: 'session-not-found', message: '会话不存在或已经休眠' };
    }
    if (session.suspendRequestedAt) {
      return { ok: false, error: 'suspend-pending', message: '会话正在进入休眠' };
    }
    if (session.info && session.info.purpose === 'chuxin-research') {
      return { ok: false, error: 'protected-session', message: '初心投研任务不能从这里休眠' };
    }
    if (!getSessionResumeIdentity(session.info)) {
      return {
        ok: false,
        error: 'native-session-id-missing',
        message: '尚未绑定原生会话 ID，请等待本轮完成后再休眠',
      };
    }
    if (options.excludePinned && session.info && session.info.pinned) {
      return { ok: false, error: 'pinned', message: '置顶会话不会被批量休眠' };
    }
    if (options.excludeMeeting && session.info && session.info.meetingId) {
      return { ok: false, error: 'meeting-member', message: '群聊成员不会被批量休眠' };
    }
    if (options.excludeFocused && this.focusedSessionId === sessionId) {
      return { ok: false, error: 'focused', message: '当前会话不会被批量休眠' };
    }
    const excludedSessionIds = options.excludeSessionIds;
    const isExplicitlyExcluded = excludedSessionIds instanceof Set
      ? excludedSessionIds.has(sessionId)
      : Array.isArray(excludedSessionIds) && excludedSessionIds.includes(sessionId);
    if (isExplicitlyExcluded) {
      return { ok: false, error: 'active-task', message: '会话仍有后台任务，已跳过休眠' };
    }

    const now = Number(options.now) || Date.now();
    const lastActivityAt = Math.max(
      Number(session.startedAt) || 0,
      Number(session.lastInputAt) || 0,
      Number(session.lastOutputAt) || 0,
    );
    const minIdleMs = Math.max(0, Number(options.minIdleMs) || 0);
    if (minIdleMs > 0 && now - lastActivityAt < minIdleMs) {
      return { ok: false, error: 'recently-active', message: '会话最近仍有活动，已跳过' };
    }

    for (const timer of session.pendingTimers || []) clearTimeout(timer);
    session.suspendRequestedAt = now;
    session.suspendReason = typeof options.reason === 'string' && options.reason.trim()
      ? options.reason.trim()
      : 'manual';
    session.info.status = 'suspending';
    try {
      if (!session.pty) {
        const dormantInfo = {
          ...session.info,
          status: 'dormant',
          suspendedAt: now,
          suspendReason: session.suspendReason,
        };
        if (session.terminalSnapshot) session.terminalSnapshot.dispose();
        this.sessions.delete(sessionId);
        this.onSessionSuspended(sessionId, session.info.meetingId || null, dormantInfo, { noPty: true });
      } else {
        session.pty.kill();
      }
      return { ok: true, sessionId, lastActivityAt, reason: session.suspendReason };
    } catch (error) {
      session.suspendRequestedAt = 0;
      session.suspendReason = null;
      session.info.status = 'idle';
      return { ok: false, error: 'kill-failed', message: error && error.message ? error.message : String(error) };
    }
  }

  suspendIdleSessions(options = {}) {
    const idleMs = Math.max(60 * 1000, Number(options.idleMs) || DEFAULT_IDLE_SUSPEND_MS);
    const now = Number(options.now) || Date.now();
    const requested = [];
    const skipped = {};
    for (const sessionId of [...this.sessions.keys()]) {
      const result = this.suspendSession(sessionId, {
        now,
        minIdleMs: idleMs,
        excludePinned: options.excludePinned !== false,
        excludeMeeting: options.excludeMeeting !== false,
        excludeFocused: options.excludeFocused !== false,
        excludeSessionIds: options.excludeSessionIds,
        reason: options.reason || 'bulk-idle',
      });
      if (result.ok) requested.push(sessionId);
      else skipped[result.error || 'unknown'] = (skipped[result.error || 'unknown'] || 0) + 1;
    }
    return { ok: true, requested, count: requested.length, idleMs, skipped };
  }

  renameSession(sessionId, title, opts = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    session.info.title = title;
    if (opts.userRenamed === true) session.info.userRenamed = true;
    return { ...session.info };
  }

  updateSessionMeta(sessionId, fields = {}) {
    const session = this.sessions.get(sessionId);
    if (!session || !fields || typeof fields !== 'object') return undefined;
    Object.assign(session.info, fields);
    this.emit('session-updated', this._toPublic(session.info));
    return { ...session.info };
  }

  // Record proof that Hub actually wrote a managed Codex command. Never retain
  // the command itself: ephemeral MCP arguments can contain paths or env values.
  // A SHA-256 plus the normalized policy fields is enough to distinguish a Hub
  // launch from a later bare `codex` while keeping the audit safe to persist.
  _recordManagedCodexLaunch(sessionId, command, trigger) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.info) return null;
    const runtimeKind = session.info.transcriptKind || session.info.kind;
    if (!isCodexCliKind(runtimeKind)) return null;
    const now = Date.now();
    const info = session.info;
    const record = {
      schemaVersion: 1,
      ts: new Date(now).toISOString(),
      epochMs: now,
      sessionId,
      kind: info.kind,
      runtimeKind,
      trigger: String(trigger || 'managed-launch'),
      model: info.currentModel && info.currentModel.id ? info.currentModel.id : null,
      effort: info.effort || CODEX_REASONING_EFFORT,
      speedTier: info.codexSpeedTier || resolveCodexSpeedTier(runtimeKind, null),
      contextRequested: typeof info.contextMax === 'number' ? info.contextMax : null,
      mcpProfile: info.mcpProfile || resolveCodexMcpProfile(runtimeKind, null),
      mcpDisabled: (info.mcpProfile || resolveCodexMcpProfile(runtimeKind, null)) === 'none',
      commandSha256: crypto.createHash('sha256').update(String(command || ''), 'utf8').digest('hex'),
    };
    this._managedLaunchAudit.push(record);
    if (this._managedLaunchAudit.length > 100) this._managedLaunchAudit.splice(0, this._managedLaunchAudit.length - 100);
    this.emit('managed-launch', { ...record });
    return record;
  }

  _writeManagedCodexLaunch(sessionId, command, trigger) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.pty) return false;
    session.pty.write(command);
    this._recordManagedCodexLaunch(sessionId, command, trigger);
    return true;
  }

  getManagedLaunchAudit(sessionId = null) {
    return this._managedLaunchAudit
      .filter(record => !sessionId || record.sessionId === sessionId)
      .map(record => ({ ...record }));
  }

  // A managed Codex card owns more than a PowerShell process: its model,
  // reasoning, speed tier, context request and MCP isolation all live on the
  // Hub-built launch command. If Codex exits and the PTY falls back to the host
  // shell, typing a bare `codex` used to silently discard that entire contract.
  // Track only the current host-shell line and replace that exact command with
  // relaunchCli(); normal shell commands and all input inside the Codex TUI pass
  // through untouched.
  _interceptBareCodexHostLaunch(sessionId, s, data) {
    const runtimeKind = (s.info && s.info.transcriptKind) || (s.info && s.info.kind);
    if (!isCodexCliKind(runtimeKind)) return false;

    const chunk = String(data || '').replace(/\x1b\[(?:200|201)~/g, '');
    if (!chunk) return false;

    let line = s.hostShellInputLine;
    if (typeof line !== 'string') {
      if (!detectHostShellTakeover(s.ringBuffer)) return false;
      line = '';
    }

    for (let i = 0; i < chunk.length; i += 1) {
      const ch = chunk[i];
      if (ch === '\x03' || ch === '\x15') { // Ctrl+C / Ctrl+U
        line = '';
        continue;
      }
      if (ch === '\x08' || ch === '\x7f') {
        line = line.slice(0, -1);
        continue;
      }
      if (ch === '\x1b') {
        s.hostShellInputLine = null;
        return false;
      }
      if (ch === '\r' || ch === '\n') {
        const trailing = chunk.slice(i + 1).replace(/[\r\n]/g, '');
        const isBareCodex = BARE_CODEX_COMMAND_RE.test(line.trim()) && trailing.length === 0;
        s.hostShellInputLine = null;
        if (!isBareCodex) return false;

        // Earlier character-by-character input may already be echoed at the
        // prompt. Clear it before sending the full managed launch command.
        s.pty.write('\x15');
        const relaunched = this.relaunchCli(sessionId, { trigger: 'bare-codex-guard' });
        if (relaunched) {
          this._lastWrite = {
            sessionId,
            data: '<managed-codex-relaunch>',
            target: 'managed-relaunch',
            ts: Date.now(),
          };
          return true;
        }
        return false;
      }
      if (ch >= ' ') line += ch;
    }

    s.hostShellInputLine = line;
    return false;
  }

  writeToSession(sessionId, data) {
    const s = this.sessions.get(sessionId);
    if (s && s.pty) {
      const inputAt = Date.now();
      s.lastInputAt = inputAt;
      if (this._interceptBareCodexHostLaunch(sessionId, s, data)) return;
      this._lastWrite = { sessionId, data, target: 'pty', ts: inputAt };
      s.pty.write(data);
    }
  }

  getLastWrite() {
    return this._lastWrite ? { ...this._lastWrite } : null;
  }

  resizeSession(sessionId, cols, rows) {
    const s = this.sessions.get(sessionId);
    if (s && s.pty) {
      const safeCols = Math.max(cols, 60);
      s.pty.resize(safeCols, rows);
      if (s.terminalSnapshot) s.terminalSnapshot.resize(safeCols, rows);
      if (s.terminalOutputRewriter) s.terminalOutputRewriter.resize(safeCols, rows);
    }
  }

  // 「恢复历史会话」picker 默认只列当前目录的会话。会话以前都在用户主目录下时
  // 这没问题，改用 C:\Vibe\_scratch\* 之后就意味着 picker 里几乎什么都看不到。
  // Codex 和 Kimi 的 picker 各自内置了"看全部"的开关，这里在 picker 画出来之后
  // 替用户按一下，恢复"凭记忆挑会话、不用先想路径"的用法。
  //   Codex：顶部 `Filter: [Cwd] All`，右方向键切到 All
  //   Kimi ：底部 `Ctrl+A all`
  // Claude CLI 没有对应开关（footer 只有 Ctrl+B 切 git 分支），只能靠 Hub 侧栏。
  _autoExpandResumePicker(id, ptyProcess, { marker, key, timeoutMs = 20000 }) {
    let done = false;
    let buf = '';
    const finish = (send) => {
      if (done) return;
      done = true;
      try { watcher.dispose(); } catch {}
      clearTimeout(timer);
      if (!send) return;
      const s = this.sessions.get(id);
      if (s && s.pty) s.pty.write(key);
    };
    const watcher = ptyProcess.onData((d) => {
      if (done) return;
      buf = (buf + d).slice(-8000);
      if (marker.test(buf)) setTimeout(() => finish(true), 350);
    });
    // picker 没出现（比如直接恢复了某个会话）就安静放弃，绝不乱按键
    const timer = setTimeout(() => finish(false), timeoutMs);
    return () => finish(false);
  }

  setFocusedSession(sessionId) {
    this.focusedSessionId = sessionId;
  }

  markRead(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.info.unreadCount = 0;
      this.emit('session-updated', this._toPublic(session.info));
    }
  }

  getSession(sessionId) {
    const s = this.sessions.get(sessionId);
    return s ? { ...s.info } : undefined;
  }

  // 群聊快路径缓存：首次 groupChatWatcher.waitCliReady 通过后置 true，后续 groupChatWatcher.sendToPty 跳过冷启动 sleep。
  getGroupChatReady(sessionId) {
    const s = this.sessions.get(sessionId);
    return s ? !!s.groupChatReady : false;
  }

  setGroupChatReady(sessionId, ready) {
    const s = this.sessions.get(sessionId);
    if (s) s.groupChatReady = !!ready;
  }

  // 返回 PTY 最近一次产出输出的 ms 时间戳，用于 groupChatWatcher.sendToPty 活性兜底（write 后 300ms 内有无 echo）。
  getGroupChatLastActivity(sessionId) {
    const s = this.sessions.get(sessionId);
    return s ? (s.groupChatLastActivity || 0) : 0;
  }

  // FIX-F（2026-05-01）：在已存在的 PTY 上重新启动 CLI 进程（不重 spawn PTY）。
  //   场景：CLI 自我退出（Codex 自动更新 / Gemini OAuth refresh / Claude panic），
  //   PTY 控制权回到宿主 shell（PowerShell / bash），ring buffer 末尾是 host prompt。
  //   往 PTY 写启动命令重新拉起 CLI；不带 resume，启动新 session（context 干净）。
  //   命令前导空格抑制 shell 历史记录，避免污染。
  // 返回 true 已写命令，false 找不到 session 或 kind 不支持。
  relaunchCli(sessionId, options = {}) {
    const s = this.sessions.get(sessionId);
    if (!s || !s.pty) return false;
    const kind = s.info && s.info.kind;
    const modelId = s.info && s.info.currentModel && s.info.currentModel.id;
    const meetingId = s.info && s.info.meetingId;
    // 群聊成员：复用 buildGroupChatIsolationFlags 输出 (v2 后仅 --settings,不含
    //   --disable-slash-commands;详见该函数注释)。
    // 用 isClaudeFamily 同时覆盖主 kind 与 *-resume 形态。
    const runtimeKind = (s.info && s.info.transcriptKind) || kind;
    const baseKind = (typeof runtimeKind === 'string') ? runtimeKind.replace(/-resume$/, '') : runtimeKind;
    const isClaudeCli = isClaudeFamily(baseKind);
    const isolation = isClaudeCli ? buildGroupChatIsolationFlags(meetingId) : '';
    let cmd;
    if (isCodexCliKind(runtimeKind)) {
      // relaunch：API 模式时 codex 用 isolated CODEX_HOME，从 info.codexSessionsRoot 反推
      const codexConfigDir = s.info && s.info.codexSessionsRoot ? path.dirname(s.info.codexSessionsRoot) : null;
      dismissCodexUpdatePrompt(undefined, codexConfigDir);
      dismissCodexRateLimitDialog(undefined, codexConfigDir);
      // relaunch 要沿用会话自己选过的档位；群聊成员也不例外。
      const codexRelaunchModel = modelId || DEFAULT_MODEL_BY_KIND.codex;
      const codexReasoningArg = buildCodexReasoningConfigArg(normalizeCodexEffort(s.info && s.info.effort))
        + buildCodexSpeedTierArg(resolveCodexSpeedTier(runtimeKind, s.info && s.info.codexSpeedTier))
        + buildCodexContextWindowArg(resolveCodexContextWindow(codexRelaunchModel, s.info && s.info.contextMax));
      ensureCodexMcpEntries(codexConfigDir, [], CODEX_MANAGED_MCP_NAMES);
      const resumeSid = options.resume === true && s.info && s.info.codexSid
        ? String(s.info.codexSid).trim()
        : '';
      cmd = resumeSid
        ? ` codex resume ${quotePowerShellLiteral(resumeSid)} --dangerously-bypass-approvals-and-sandbox --model ${codexRelaunchModel}${codexReasoningArg}`
        : ` codex --dangerously-bypass-approvals-and-sandbox --model ${codexRelaunchModel}${codexReasoningArg}`;
      const relaunchMcpProfile = resolveCodexMcpProfile(runtimeKind, s.info && s.info.mcpProfile);
      const relaunchMcpEntries = relaunchMcpProfile === 'none' ? [] : s.codexMcpEntries;
      cmd += buildCodexEphemeralMcpArgs(relaunchMcpEntries);
      cmd += buildCodexMcpIsolationArgs(codexConfigDir, {
        meetingId,
        cwd: s.info && s.info.cwd,
        mcpProfile: relaunchMcpProfile,
        allowedNames: relaunchMcpProfile === 'none'
          ? []
          : [...CODEX_MANAGED_MCP_NAMES, ...(relaunchMcpEntries || []).map((entry) => entry && entry.name)],
      });
      if (resumeSid && typeof options.prompt === 'string' && options.prompt.trim()) {
        cmd += ` ${quotePowerShellLiteral(options.prompt.trim())}`;
      }
      cmd += '\r\n';
    } else if (kind === 'gemini' || kind === 'gemini-resume') {
      cmd = ` gemini --approval-mode yolo --model ${modelId || 'gemini-3-pro-preview'}\r\n`;
    } else if (kind === 'claude' || kind === 'claude-resume') {
      // 默认 --effort max（CLAUDE_HUB_NO_EFFORT_MAX=1 可关），但会话显式
      // 选过档位时必须沿用，不能在 CLI 原地重拉后静默回到 max。
      // 默认 model 跟随 DEFAULT_MODEL_BY_KIND.claude（当前 Opus 4.8 1M）。
      // 默认叠 fast 模式 settings（CLAUDE_HUB_NO_FAST=1 可关）—— 与 createSession
      //   spawn block 对齐，防止 relaunch 后丢 fast 状态。
      //   会话自己关过 fast（info.fastMode === false）时也要沿用，否则 relaunch
      //   会把用户显式关掉的开关又打开。
      const effort = CLAUDE_EFFORT_LEVELS.has(s.info && s.info.effort) ? s.info.effort : 'max';
      const effortFlag = process.env.CLAUDE_HUB_NO_EFFORT_MAX === '1' ? '' : ` --effort ${effort}`;
      let fastFlag = '';
      const cv = getConfigValues();
      if (shouldUseClaudeFastSettings(cv, { fastMode: s.info && s.info.fastMode })) {
        const fastSettingsPath = resolveAsarUnpacked('claude-subscription-fast-settings.json');
        fastFlag = ` --settings "${fastSettingsPath.replace(/\\/g, '\\\\')}"`;
      }
      // 单人和群聊都沿用自己的 MCP 档位；群聊额外恢复 research/通信 config。
      const mcpPlan = meetingId
        ? buildClaudeMeetingMcpArgs({
          mcpConfigFile: s.claudeMcpConfigFile,
          mcpProfile: s.info && s.info.mcpProfile,
          cwd: s.info && s.info.cwd,
          hubDataDir: getHubDataDir(),
        })
        : buildClaudeMcpProfileArgs({
          mcpProfile: s.info && s.info.mcpProfile,
          cwd: s.info && s.info.cwd,
          hubDataDir: getHubDataDir(),
        });
      const mcpFlag = mcpPlan && mcpPlan.args ? mcpPlan.args : '';
      cmd = ` claude --model ${modelId || DEFAULT_MODEL_BY_KIND.claude}${effortFlag}${fastFlag}${mcpFlag}${isolation}\r\n`;
    } else if (kind === 'deepseek' || kind === 'deepseek-resume') {
      const mcpPlan = meetingId ? buildClaudeMeetingMcpArgs({
        mcpConfigFile: s.claudeMcpConfigFile,
        mcpProfile: (s.info && s.info.mcpProfile) || 'lean',
        cwd: s.info && s.info.cwd,
        hubDataDir: getHubDataDir(),
      }) : null;
      const mcpFlag = mcpPlan && mcpPlan.args ? mcpPlan.args : '';
      cmd = ` claude --model ${normalizeLegacyDeepSeekClaudeModel(modelId)} --permission-mode bypassPermissions${mcpFlag}${isolation}\r\n`;
    } else if (isKimiCliKind(kind)) {
      cmd = `${kimiCommandPrefix(process.env)} --yolo${kimiModelArg(modelId || DEFAULT_MODEL_BY_KIND.kimi, process.env)}\r\n`;
    } else {
      return false;
    }
    s.pty.write(cmd);
    if (isCodexCliKind(runtimeKind)) {
      this._recordManagedCodexLaunch(sessionId, cmd, options.trigger || 'relaunch');
    }
    // 重置 group-chat 快路径缓存：CLI 是新启动，必须重新走冷启动流程
    s.groupChatReady = false;
    return true;
  }

  getAllSessions() {
    return Array.from(this.sessions.values())
      .map(s => ({ ...s.info }))
      .sort(compareLatestReplyDesc);
  }

  // Returns the public shape used by renderer IPC and 'session-updated' events.
  _toPublic(info) {
    return {
      id: info.id,
      title: info.title,
      kind: info.kind,
      cwd: info.cwd,
      unreadCount: info.unreadCount,
      lastMessageTime: info.lastMessageTime,
      ...(typeof info.lastCompletedAt === 'number' ? { lastCompletedAt: info.lastCompletedAt } : {}),
      lastOutputPreview: info.lastOutputPreview,
      ...(info.pinned !== undefined ? { pinned: info.pinned } : {}),
      ...(info.ccSessionId !== undefined ? { ccSessionId: info.ccSessionId } : {}),
      ...(info.transcriptPath !== undefined ? { transcriptPath: info.transcriptPath } : {}),
      ...(info.codexSid !== undefined ? { codexSid: info.codexSid } : {}),
      ...(info.codexSessionsRoot !== undefined ? { codexSessionsRoot: info.codexSessionsRoot } : {}),
      ...(info.codexAllowMtimeFallback ? { codexAllowMtimeFallback: true } : {}),
      ...(info.codexProfile !== undefined ? { codexProfile: info.codexProfile } : {}),
      ...(info.codexProfileLabel !== undefined ? { codexProfileLabel: info.codexProfileLabel } : {}),
      ...(info.mcpProfile !== undefined ? { mcpProfile: info.mcpProfile } : {}),
      ...(info.fastMode !== undefined ? { fastMode: info.fastMode } : {}),
      ...(info.effort !== undefined ? { effort: info.effort } : {}),
      ...(info.codexSpeedTier !== undefined ? { codexSpeedTier: info.codexSpeedTier } : {}),
      ...(info.geminiChatId !== undefined ? { geminiChatId: info.geminiChatId } : {}),
      ...(info.geminiProjectHash !== undefined ? { geminiProjectHash: info.geminiProjectHash } : {}),
      ...(info.geminiProjectRoot !== undefined ? { geminiProjectRoot: info.geminiProjectRoot } : {}),
      ...(info.kimiSid !== undefined ? { kimiSid: info.kimiSid } : {}),
      ...(info.kimiSessionDir !== undefined ? { kimiSessionDir: info.kimiSessionDir } : {}),
      ...(info.currentModel ? { model: info.currentModel.id } : {}),
      ...(info.currentModel ? { currentModel: info.currentModel } : {}),
      ...(info.effort ? { effort: info.effort } : {}),
      ...(typeof info.contextPct === 'number' ? { contextPct: info.contextPct } : {}),
      ...(typeof info.contextUsed === 'number' ? { contextUsed: info.contextUsed } : {}),
      ...(typeof info.contextMax === 'number' ? { contextMax: info.contextMax } : {}),
      ...(typeof info.contextEffectiveMax === 'number' ? { contextEffectiveMax: info.contextEffectiveMax } : {}),
      ...(typeof info.contextEffectiveObservedAt === 'number'
        ? { contextEffectiveObservedAt: info.contextEffectiveObservedAt }
        : {}),
      ...(info.userRenamed ? { userRenamed: true } : {}),
      ...(info.autoTitleGenerated ? { autoTitleGenerated: true } : {}),
      ...(info.branchSourceSessionId ? { branchSourceSessionId: info.branchSourceSessionId } : {}),
      ...(Number.isInteger(Number(info.branchIndex)) && Number(info.branchIndex) > 0
        ? { branchIndex: Number(info.branchIndex) }
        : {}),
      ...(typeof info.branchAutoTitlePending === 'boolean'
        ? { branchAutoTitlePending: info.branchAutoTitlePending }
        : {}),
      ...(info.status !== undefined ? { status: info.status } : {}),
      connectionIssue: info.connectionIssue || null,
      ...(sanitizeNightGuardState(info.nightGuard)
        ? { nightGuard: sanitizeNightGuardState(info.nightGuard) }
        : {}),
      ...(info.readOnly ? { readOnly: true } : {}),
      ...(info.provider ? { provider: info.provider } : {}),
      ...(info.nativeSession ? { nativeSession: info.nativeSession } : {}),
      ...(info.purpose ? { purpose: info.purpose } : {}),
      ...(info.researchSessionId ? { researchSessionId: info.researchSessionId } : {}),
      ...(info.chuxinTaskId ? { chuxinTaskId: info.chuxinTaskId } : {}),
      ...(Array.isArray(info.heroIds) ? { heroIds: info.heroIds } : {}),
      ...(info.promptPolicyVersion ? { promptPolicyVersion: info.promptPolicyVersion } : {}),
      ...(info.hiddenFromSidebar ? { hiddenFromSidebar: true } : {}),
      completionNotificationEnabled: info.completionNotificationEnabled === true,
    };
  }

  // Returns array of public session objects for renderer IPC.
  listSessions() {
    return Array.from(this.sessions.values())
      .map(s => this._toPublic(s.info))
      .sort(compareLatestReplyDesc);
  }

  // Appends terminal-facing PTY data to the session's ring buffer, capping at
  // RING_BUFFER_BYTES (tail-slice). Codex data has already passed through the
  // xterm scrollback-safety rewrite; other runtimes remain byte-for-byte.
  // After truncation, trims any lone low-surrogate left at the start of the buffer
  // that could result from cutting a UTF-16 surrogate pair at the boundary.
  // Extracted as a named method so tests can drive it without spawning a real PTY.
  _appendToRingBuffer(id, data) {
    const s = this.sessions.get(id);
    if (!s) return;
    let rb = (s.ringBuffer || '') + data;
    const ringLimit = Number(s.ringBufferLimit || RING_BUFFER_BYTES);
    if (rb.length > ringLimit) {
      rb = rb.slice(rb.length - ringLimit);
      // Trim leading lone low-surrogates (unpaired 0xDC00–0xDFFF) left by the cut.
      // A high surrogate (0xD800–0xDBFF) at position 0 is fine only if it's
      // immediately followed by a low surrogate; otherwise drop it too.
      let i = 0;
      while (i < rb.length && i < 4) {
        const cc = rb.charCodeAt(i);
        // Lone low-surrogate — definitely unpaired, drop it
        if (cc >= 0xDC00 && cc <= 0xDFFF) { i++; continue; }
        // High surrogate followed by something that is NOT a low surrogate — drop it
        if (cc >= 0xD800 && cc <= 0xDBFF) {
          const next = rb.charCodeAt(i + 1);
          if (!(next >= 0xDC00 && next <= 0xDFFF)) { i++; continue; }
        }
        break;
      }
      if (i > 0) rb = rb.slice(i);
    }
    s.ringBuffer = rb;
  }

  // Returns the ring-buffer string for a session, '' if exists but empty,
  // null if session not found.
  getSessionBuffer(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    return s.ringBuffer || '';
  }

  // Renderer 可以先拿一个带序号的原子尾部快照，再只接收更大的 seq，
  // 避免终端按需创建时既丢启动输出又把并发到达的 chunk 重复写入。
  getSessionBufferSnapshot(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    if (s.terminalSnapshot) {
      return s.terminalSnapshot.snapshot().then((snapshot) => (
        snapshot || { text: s.ringBuffer || '', seq: s.lastOutputSeq || this._outputSeq }
      )).catch((error) => {
        console.warn('[terminal-snapshot] serialize failed, using terminal ring fallback:', error && error.message);
        return { text: s.ringBuffer || '', seq: s.lastOutputSeq || this._outputSeq };
      });
    }
    return { text: s.ringBuffer || '', seq: s.lastOutputSeq || this._outputSeq };
  }

  dispose() {
    for (const s of this.sessions.values()) {
      for (const t of s.pendingTimers) clearTimeout(t);
      if (s.terminalOutputFlushTimer) clearTimeout(s.terminalOutputFlushTimer);
      if (s.terminalSnapshot) s.terminalSnapshot.dispose();
      if (s.pty) {
        s.pty.kill();
      }
    }
    this.sessions.clear();
  }

  // Electron must not tear down Node while node-pty still has a
  // ThreadSafeFunction exit callback in flight. On Windows that race aborts the
  // process with 0xc0000409 / FAST_FAIL_FATAL_APP_EXIT. Register every waiter
  // before killing any PTY, then keep the JS environment alive until the
  // existing onExit path has completed for all of them.
  disposeGracefully(options = {}) {
    if (this._shutdownDrainPromise) return this._shutdownDrainPromise;

    this._isShuttingDown = true;
    const logger = options.logger || console;
    const configuredWarnAfterMs = Number(options.warnAfterMs);
    const warnAfterMs = Number.isFinite(configuredWarnAfterMs)
      ? Math.max(0, configuredWarnAfterMs)
      : 5000;
    const configuredDrainTimeoutMs = Number(options.drainTimeoutMs);
    const drainTimeoutMs = Number.isFinite(configuredDrainTimeoutMs)
      ? Math.max(100, configuredDrainTimeoutMs)
      : 15_000;
    const startedAt = Date.now();
    const entries = [...this.sessions.entries()];

    this._shutdownDrainPromise = (async () => {
      const waits = [];
      const killErrors = [];

      // Set up all waiters first. A native exit callback cannot run JS until
      // this synchronous setup yields, so no PTY can escape between snapshot
      // and waiter registration.
      for (const [sessionId, session] of entries) {
        for (const timer of session.pendingTimers || []) clearTimeout(timer);
        if (session.terminalOutputFlushTimer) {
          clearTimeout(session.terminalOutputFlushTimer);
          session.terminalOutputFlushTimer = null;
        }
        if (!session.pty) {
          if (session.terminalSnapshot) session.terminalSnapshot.dispose();
          this.sessions.delete(sessionId);
          this._shutdownDrainedSessions.set(sessionId, {
            meetingId: session.info && session.info.meetingId || null,
            session: {
              ...session.info,
              status: 'dormant',
              suspendedAt: Date.now(),
              suspendReason: 'shutdown-cancelled',
            },
            exitInfo: { noPty: true },
          });
          continue;
        }
        waits.push(new Promise((resolve) => {
          this._shutdownExitWaiters.set(sessionId, { pty: session.pty, resolve });
        }));
      }

      for (const [sessionId, session] of entries) {
        if (!session.pty) continue;
        try {
          session.pty.kill();
        } catch (error) {
          // Do not pretend this PTY is drained. Its already-registered onExit
          // waiter remains authoritative and prevents unsafe teardown.
          killErrors.push({ sessionId, message: error && error.message ? error.message : String(error) });
          logger.warn('[shutdown] PTY kill failed; waiting for native exit callback:', sessionId, error && error.message);
        }
      }

      let warningTimer = null;
      if (waits.length > 0 && warnAfterMs > 0) {
        warningTimer = setTimeout(() => {
          const pendingIds = [...this._shutdownExitWaiters.keys()];
          logger.warn(`[shutdown] still draining ${pendingIds.length} PTY session(s): ${pendingIds.join(', ')}`);
        }, warnAfterMs);
        if (typeof warningTimer.unref === 'function') warningTimer.unref();
      }

      let timeoutTimer = null;
      const drained = waits.length === 0
        ? true
        : await Promise.race([
          Promise.all(waits).then(() => true),
          new Promise(resolve => {
            timeoutTimer = setTimeout(() => resolve(false), drainTimeoutMs);
          }),
        ]);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (warningTimer) clearTimeout(warningTimer);
      if (!drained) {
        const pendingSessionIds = [...this._shutdownExitWaiters.keys()];
        for (const sessionId of pendingSessionIds) {
          const waiter = this._shutdownExitWaiters.get(sessionId);
          if (waiter) waiter.timedOut = true;
        }
        for (const [sessionId, drainedSession] of this._shutdownDrainedSessions) {
          this.onSessionSuspended(
            sessionId,
            drainedSession.meetingId,
            drainedSession.session,
            drainedSession.exitInfo,
          );
        }
        this._shutdownDrainedSessions.clear();
        logger.error?.(`[shutdown] PTY drain timed out after ${drainTimeoutMs}ms: ${pendingSessionIds.join(', ')}`);
        this._isShuttingDown = false;
        return {
          safeToQuit: false,
          drainedPtyCount: waits.length - pendingSessionIds.length,
          pendingSessionIds,
          killErrors,
          durationMs: Date.now() - startedAt,
          error: 'pty_drain_timeout',
        };
      }
      this._shutdownExitWaiters.clear();
      this._shutdownDrainedSessions.clear();
      this.sessions.clear();

      return {
        safeToQuit: true,
        drainedPtyCount: waits.length,
        killErrors,
        durationMs: Date.now() - startedAt,
      };
    })();

    const activeDrain = this._shutdownDrainPromise;
    void activeDrain.then((result) => {
      if (result && result.safeToQuit === false && this._shutdownDrainPromise === activeDrain) {
        this._shutdownDrainPromise = null;
      }
    });
    return activeDrain;
  }

  static geminiDisplayName(id) {
    if (!id) return 'Gemini';
    return id
      .replace(/^gemini-/, 'Gemini ')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase())
      .replace(/^Gemini (\d)/, 'Gemini $1');
  }

  // Strip ANSI escape codes from terminal output for pattern matching.
  static stripAnsi(str) {
    return str.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-Za-z]|\x1b\[[\?]?[0-9;]*[a-zA-Z]/g, '');
  }
}

// Read tail N turns from a CLI transcript file and format into a prompt-injectable
// context block. Returns null if file unavailable or no usable turns.
//   kind:    'claude' | 'deepseek-legacy' | 'deepseek' | 'codex' | 'gemini'
//   sourcePath: kind-specific transcript file path
//
// DeepSeek now uses the Codex rollout shape. Only the internal deepseek-legacy
// runtime retains Claude's JSONL shape for pre-migration transcript recovery.
async function readTranscriptTail(kind, sourcePath, n = 10) {
  if (!sourcePath) return null;
  // T13 fix: refuse oversized transcripts (>5MB) to avoid main-process memory spike
  // (readFileSync + split allocates ~2x file size in RAM).
  try {
    const stat = await fs.promises.stat(sourcePath);
    if (stat.size > 5 * 1024 * 1024) {
      console.warn(`[hub] readTranscriptTail skipping ${sourcePath} (${(stat.size/1024/1024).toFixed(1)}MB > 5MB cap)`);
      return null;
    }
  } catch { return null; }
  // T13 fix: cap injected context at 50KB so an oversized join doesn't overflow PTY buffer.
  const MAX_INJECT = 50 * 1024;
  try {
    if (kind === 'gemini' && sourcePath.endsWith('.json') && !sourcePath.endsWith('.jsonl')) {
      // Gemini old format: single JSON file
      const obj = JSON.parse(await fs.promises.readFile(sourcePath, 'utf-8'));
      const msgs = Array.isArray(obj.messages) ? obj.messages.slice(-n) : [];
      const joined = msgs.map(m => {
        if (m.type === 'user') return `USER: ${(m.content||[]).map(c=>c.text).filter(Boolean).join('')}`;
        if (m.type === 'gemini') return `ASSISTANT: ${typeof m.content==='string'?m.content:''}`;
        return null;
      }).filter(Boolean).join('\n\n');
      return joined.length > MAX_INJECT ? joined.slice(0, MAX_INJECT) + '\n[CONTEXT TRUNCATED]' : joined;
    }
    // JSONL: tail N lines
    const lines = (await fs.promises.readFile(sourcePath, 'utf-8')).trim().split('\n').slice(-n*2);
    const out = [];
    for (const line of lines) {
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (isClaudeFamily(kind)) {
        // Claude and migration-only deepseek-legacy share one JSONL shape.
        if (obj.type === 'user' && obj.message?.content) {
          const userText = typeof obj.message.content === 'string' ? obj.message.content : textFromContent(obj.message.content);
          if (!isSyntheticUserEntry(obj, userText)) out.push(`USER: ${userText}`);
        }
        if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
          const txt = obj.message.content.filter(c => c.type === 'text').map(c => c.text).join('');
          if (txt) out.push(`ASSISTANT: ${txt}`);
        }
      } else if (isCodexCliKind(kind)) {
        if (obj.type === 'event_msg' && obj.payload?.type === 'task_complete' && obj.payload?.last_agent_message) {
          out.push(`ASSISTANT: ${obj.payload.last_agent_message}`);
        } else if (obj.type === 'response_item' && obj.payload?.role === 'user' && obj.payload?.content) {
          const userText = textFromContent(obj.payload.content);
          if (!isSyntheticUserEntry(obj, userText)) out.push(`USER: ${userText}`);
        }
      } else if (kind === 'gemini') {
        if (obj.type === 'user') {
          out.push(`USER: ${(obj.content||[]).map(c => c.text).filter(Boolean).join('')}`);
        }
        if (obj.type === 'gemini') {
          out.push(`ASSISTANT: ${typeof obj.content === 'string' ? obj.content : ''}`);
        }
      }
    }
    const joined = out.slice(-n).join('\n\n');
    return joined.length > MAX_INJECT ? joined.slice(0, MAX_INJECT) + '\n[CONTEXT TRUNCATED]' : joined;
  } catch (e) {
    console.warn(`[hub] readTranscriptTail(${kind}) failed:`, e.message);
    return null;
  }
}

module.exports = {
  SessionManager,
  readTranscriptTail,
  dismissCodexUpdatePrompt,
  dismissCodexRateLimitDialog,
  clearSessionManagerConfigCache,
  _private: {
    ensureCodexCwdTrusted,
    clearProxyEnv,
    applyProxyEnv,
    isClaudeApiBackend,
    shouldUseClaudeFastSettings,
    applyClaudeSessionEnv,
    resolveClaudeLaunchModel,
    quotePowerShellLiteral,
    resolveKimiExecutable,
    kimiCommandPrefix,
    isKimiModelConfigured,
    kimiModelArg,
    buildGroupChatIsolationFlags,
    buildClaudeMeetingMcpArgs,
    listCodexMcpServerNames,
    normalizeCodexMcpProfile,
    resolveCodexMcpProfile,
    normalizeCodexEffort,
    normalizeCodexSpeedTier,
    resolveCodexSpeedTier,
    buildCodexSpeedTierArg,
    buildCodexContextWindowArg,
    normalizeClaudeMcpProfile,
    buildClaudeMcpProfileArgs,
    isWirelessWorkspace,
    buildCodexMcpIsolationArgs,
    buildCodexGroupMcpIsolationArgs,
    buildCodexEphemeralMcpArgs,
    stripCodexMcpEntries,
    getSessionResumeIdentity,
    supportsRecoverableSuspend,
    DEFAULT_IDLE_SUSPEND_MS,
  },
};
