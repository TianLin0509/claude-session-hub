const pty = require('node-pty');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { v4: uuid } = require('uuid');
const { EventEmitter } = require('events');
const { getConfig } = require('./hub-config.js');
const { getHubDataDir } = require('./data-dir');
const { isClaudeFamily, isClaudeWebKind, isCodexCliKind, isCodexWebKind } = require('./ai-kinds.js');
const { normalizeDeepSeekModel, deepseekDisplayName } = require('./model-options.js');
const { CodexAppServerClient } = require('./codex-app-server-client.js');
const codexAppRegistry = require('./codex-app-registry.js');

const RING_BUFFER_BYTES = 16384;
const CODEX_REASONING_EFFORT = 'xhigh';
const CODEX_REASONING_CONFIG_ARG = ` -c 'model_reasoning_effort="${CODEX_REASONING_EFFORT}"'`;

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
    DEEPSEEK_API_KEY: config.deepseekApiKey,
    GLM_API_KEY: config.glmApiKey,
    GLM_BASE_URL: config.glmBaseUrl,
    GLM_MODEL: config.glmModel,
    CODEX_BACKEND: config.codexBackend,
    CODEX_SUBSCRIPTION_PROFILE: config.codexSubscriptionProfile,
    CODEX_SUBSCRIPTION_PROFILES: config.codexSubscriptionProfiles,
    CODEX_API_KEY: config.codexApiKey,
    CODEX_API_BASE_URL: config.codexApiBaseUrl,
    CODEX_API_MODEL: config.codexApiModel,
    CODEX_API_PROVIDER: config.codexApiProvider || 'packycode',
    GPT_API_KEY: config.gptApiKey,
    GPT_BASE_URL: config.gptBaseUrl,
    GPT_MODEL: config.gptModel,
    KIMI_API_KEY: config.kimiApiKey,
    KIMI_BASE_URL: config.kimiBaseUrl,
    KIMI_MODEL: config.kimiModel,
    QWEN_API_KEY: config.qwenApiKey,
    QWEN_BASE_URL: config.qwenBaseUrl,
    QWEN_MODEL: config.qwenModel,
    MERIDIAN_URL: config.meridianUrl,
    MERIDIAN_TOKEN: config.meridianToken,
    MERIDIAN_ENABLED: config.meridianEnabled,
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
 * 清空所有代理 env，让子进程对 PackyAPI / DeepSeek / GLM 等国内/中转端点直连。
 * 必须清干净大小写两套——Hub 进程继承的可能是 Clash/Mihomo 设的 7890，
 * 走代理时 60s idle TCP 会被切断（实测 image-2 长 prompt 100% 撞墙）。
 * 详见 ppt-image-studio/docs/packyapi-image2-60s-investigation.html。
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
// 目的：群聊成员的 Claude/DeepSeek/GLM CLI 启动时,
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
//     ❌ 兜不住: 用户自定义 skill (位于 ~/.claude/skills/),如 cli-caller / init / loop /
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
  // v2 (2026-05-04): 仅 --settings 单层兜底 (禁 plugin 内 skill);
  //   用户自定义 skill 由 BASE_RULES 软约束兜底 (详见上方注释)。
  //   旧版 `--disable-slash-commands` 已删,避免误杀 /model /compact 等用户基本操作。
  return ` --settings "${escaped}"`;
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
function dismissCodexRateLimitDialog(homeDir = process.env.USERPROFILE || process.env.HOME || os.homedir(), configDir = null) {
  const configPath = configDir
    ? path.join(configDir, 'config.toml')
    : path.join(homeDir, '.codex', 'config.toml');
  try {
    let content = '';
    try { content = fs.readFileSync(configPath, 'utf8'); } catch { /* 文件不存在 → 视作空 */ }

    // 幂等：key 已存在且为 true → 跳过写盘
    if (/^\s*hide_rate_limit_model_nudge\s*=\s*true\b/m.test(content)) return false;

    let newContent;
    // 已有 [notice] section（任意大小写 / 前后空格）→ 在 section 头之后插入 key
    const noticeMatch = content.match(/^\s*\[notice\]\s*$/m);
    if (noticeMatch) {
      const insertPos = noticeMatch.index + noticeMatch[0].length;
      newContent = content.slice(0, insertPos) + '\nhide_rate_limit_model_nudge = true' + content.slice(insertPos);
    } else {
      // 没 [notice] → 文件末尾追加完整 section
      const sep = (content && !content.endsWith('\n')) ? '\n' : '';
      newContent = content + sep + '\n[notice]\nhide_rate_limit_model_nudge = true\n';
    }

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, newContent, 'utf8');
    console.log(`[hub] dismissed Codex rate-limit dialog at ${configPath}`);
    return true;
  } catch (err) {
    console.warn('[hub] failed to dismiss Codex rate-limit dialog:', err.message);
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
  const model = cv.CODEX_API_MODEL || 'gpt-5.5';
  const projectKey = path.resolve(projectDir || os.homedir());

  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), [
    'disable_response_storage = true',
    `model = ${tomlString(model)}`,
    `model_provider = ${tomlString(provider)}`,
    'model_reasoning_effort = "xhigh"',
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
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
    let cfg = '';
    try { cfg = fs.readFileSync(cfgPath, 'utf8'); } catch {}
    const headerNeedle = `[projects.'${projectKey}']`.toLowerCase();
    if (cfg.toLowerCase().includes(headerNeedle)) return;
    const append = (cfg && !cfg.endsWith('\n') ? '\n' : '')
      + `\n[projects.'${projectKey}']\ntrust_level = "trusted"\n`;
    fs.appendFileSync(cfgPath, append, 'utf8');
  } catch (err) {
    console.warn('[hub] failed to pretrust codex cwd:', err.message);
  }
}

const CODEX_MANAGED_MCP_NAMES = ['ai-team', 'arena_research'];

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

  // Injected by main: the chosen hook HTTP port + per-launch auth token.
  hookPort = null;
  hookToken = null;

  constructor() {
    super();
  }

  // Callbacks
  onData = (sessionId, data) => {};
  onSessionClosed = (sessionId) => {};

  // opts: { id?, title?, cwd?, resumeCCSessionId?, useContinue? }
  //   id:                 reuse a previous hub session id (dormant wake)
  //   title:              override default title (dormant wake preserves name)
  //   cwd:                launch cwd; defaults to user home
  //   resumeCCSessionId:  when set, runs `claude --resume <id>`
  //   useContinue:        when set, runs `claude --continue` (Claude fallback)
  //   useResume:          generic resume flag for codex/gemini → uses sid/index if provided, else --last/latest
  //   codexSid:           when set + kind=='codex' + useResume, runs `codex resume <sid>` precisely (T8 new)
  //   geminiChatId:       Gemini 8charId from chats/session-*.json (T8 new, used for index lookup)
  //   geminiProjectRoot:  required for Gemini resume (T8 new, used as cwd for correct project scoping)
  createSession(kind = 'powershell', opts = {}) {
    const id = opts.id || uuid();
    const isClaude = kind === 'claude' || kind === 'claude-resume' || isClaudeWebKind(kind);
    const isClaudeWeb = isClaudeWebKind(kind);
    const isGemini = kind === 'gemini' || kind === 'gemini-resume';
    const isCodex = isCodexCliKind(kind);
    const isCodexWeb = isCodexWebKind(kind);
    const isCodexApp = kind === 'codex-app';
    const isDeepSeek = kind === 'deepseek' || kind === 'deepseek-resume';
    const isGlm = kind === 'glm' || kind === 'glm-resume';
    const isGpt = kind === 'gpt' || kind === 'gpt-resume';
    const isKimi = kind === 'kimi' || kind === 'kimi-resume';
    const isQwen = kind === 'qwen' || kind === 'qwen-resume';
    const isAgent = isClaude || isGemini || isCodex || isCodexApp || isDeepSeek || isGlm || isGpt || isKimi || isQwen;
    let title;
    if (opts.title) title = opts.title;
    else if (kind === 'claude') title = `Claude ${++this.claudeCounter}`;
    else if (kind === 'claude-resume') title = `Claude Resume ${++this.resumeCounter}`;
    else if (kind === 'claude-web') { this.claudeWebCounter = (this.claudeWebCounter || 0) + 1; title = `Claude Web ${this.claudeWebCounter}`; }
    else if (kind === 'claude-web-resume') title = `Claude Web Resume ${++this.resumeCounter}`;
    else if (kind === 'gemini') { this.geminiCounter = (this.geminiCounter || 0) + 1; title = `Gemini ${this.geminiCounter}`; }
    else if (kind === 'codex') { this.codexCounter = (this.codexCounter || 0) + 1; title = `Codex ${this.codexCounter}`; }
    else if (kind === 'codex-web') { this.codexWebCounter = (this.codexWebCounter || 0) + 1; title = `Codex Web ${this.codexWebCounter}`; }
    else if (kind === 'codex-app') { this.codexAppCounter = (this.codexAppCounter || 0) + 1; title = `Codex App ${this.codexAppCounter}`; }
    else if (kind === 'deepseek') { this.deepseekCounter = (this.deepseekCounter || 0) + 1; title = `DeepSeek ${this.deepseekCounter}`; }
    else if (kind === 'glm') { this.glmCounter = (this.glmCounter || 0) + 1; title = `GLM ${this.glmCounter}`; }
    else if (kind === 'gpt') { this.gptCounter = (this.gptCounter || 0) + 1; title = `GPT ${this.gptCounter}`; }
    else if (kind === 'kimi') { this.kimiCounter = (this.kimiCounter || 0) + 1; title = `Kimi ${this.kimiCounter}`; }
    else if (kind === 'qwen') { this.qwenCounter = (this.qwenCounter || 0) + 1; title = `Qwen ${this.qwenCounter}`; }
    else if (kind === 'gemini-resume') title = `Gemini Resume ${++this.resumeCounter}`;
    else if (kind === 'codex-resume') title = `Codex Resume ${++this.resumeCounter}`;
    else if (kind === 'codex-web-resume') title = `Codex Web Resume ${++this.resumeCounter}`;
    else if (kind === 'deepseek-resume') title = `DeepSeek Resume ${++this.resumeCounter}`;
    else if (kind === 'glm-resume') title = `GLM Resume ${++this.resumeCounter}`;
    else if (kind === 'gpt-resume') title = `GPT Resume ${++this.resumeCounter}`;
    else if (kind === 'kimi-resume') title = `Kimi Resume ${++this.resumeCounter}`;
    else if (kind === 'qwen-resume') title = `Qwen Resume ${++this.resumeCounter}`;
    else title = `PowerShell ${++this.psCounter}`;

    const sessionEnv = { ...process.env };
    let codexProfile = null;

    if (isClaude) {
      const cv = getConfigValues();
      if (cv.MERIDIAN_ENABLED && cv.MERIDIAN_URL && cv.MERIDIAN_TOKEN) {
        // Meridian VPS proxy mode: route Claude Code through team-shared Max
        // via the Anthropic-compatible endpoint at https://meridian host:8443.
        // ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN are exactly the same pattern
        // Claude Code uses for any 3rd-party-compatible backend.
        delete sessionEnv.ANTHROPIC_API_KEY;
        delete sessionEnv.ANTHROPIC_API_BASE_URL;
        delete sessionEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL;
        delete sessionEnv.ANTHROPIC_MODEL;
        sessionEnv.ANTHROPIC_BASE_URL = cv.MERIDIAN_URL;
        sessionEnv.ANTHROPIC_AUTH_TOKEN = cv.MERIDIAN_TOKEN;
        // Meridian endpoint is plain HTTPS, do NOT route through local proxy.
        // (CLAUDE_PROXY 7890 is for direct-to-Anthropic with VPN; not needed here.)
        delete sessionEnv.HTTP_PROXY;
        delete sessionEnv.HTTPS_PROXY;
        sessionEnv.NO_PROXY = 'localhost,127.0.0.1';
      } else {
        // Force subscription OAuth (Claude Max): strip custom-endpoint env vars
        // that would otherwise route Claude Code to cc-switch / CCR.
        delete sessionEnv.ANTHROPIC_BASE_URL;
        delete sessionEnv.ANTHROPIC_API_BASE_URL;
        delete sessionEnv.ANTHROPIC_AUTH_TOKEN;
        delete sessionEnv.ANTHROPIC_API_KEY;
        delete sessionEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL;
        delete sessionEnv.ANTHROPIC_MODEL;
        sessionEnv.HTTP_PROXY = cv.CLAUDE_PROXY;
        sessionEnv.HTTPS_PROXY = cv.CLAUDE_PROXY;
        sessionEnv.NO_PROXY = 'localhost,127.0.0.1';
      }
      // Attribution + auth for the Stop/UserPromptSubmit hook script (both modes)
      sessionEnv.CLAUDE_HUB_SESSION_ID = id;
      if (this.hookPort) sessionEnv.CLAUDE_HUB_PORT = String(this.hookPort);
      if (this.hookToken) sessionEnv.CLAUDE_HUB_TOKEN = this.hookToken;
      // Propagate data-dir override so the statusline script writes its cache
      // into the isolated test dir instead of the production ~/.claude-session-hub.
      if (process.env.CLAUDE_HUB_DATA_DIR) {
        sessionEnv.CLAUDE_HUB_DATA_DIR = process.env.CLAUDE_HUB_DATA_DIR;
      }
    } else if (isGemini || isCodex) {
      const cv = getConfigValues();
      if (isCodex && isCodexApiBackend(cv)) {
        // Codex API 模式走 PackyAPI，必须直连，否则代理 60s idle 切长任务
        clearProxyEnv(sessionEnv);
        sessionEnv.CODEX_HOME = getCodexApiHome();
      } else {
        if (isCodex) {
          codexProfile = resolveCodexSubscriptionProfile(cv, opts.codexProfile);
          if (codexProfile.home) {
            sessionEnv.CODEX_HOME = codexProfile.home;
          } else {
            delete sessionEnv.CODEX_HOME;
          }
        }
        // Gemini 走 google.com / Codex 订阅走 openai.com，需走代理过 GFW
        sessionEnv.HTTP_PROXY = cv.CLAUDE_PROXY;
        sessionEnv.HTTPS_PROXY = cv.CLAUDE_PROXY;
        sessionEnv.NO_PROXY = 'localhost,127.0.0.1';
      }
    } else if (isDeepSeek) {
      const cv = getConfigValues();
      // DeepSeek API 国内直连，不走代理
      clearProxyEnv(sessionEnv);
      // 让 Claude Code CLI 连接 DeepSeek 的 Anthropic 兼容端点
      sessionEnv.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic';
      sessionEnv.ANTHROPIC_AUTH_TOKEN = cv.DEEPSEEK_API_KEY;
      // 清除可能继承的 Anthropic 认证，防止冲突
      delete sessionEnv.ANTHROPIC_API_KEY;
      delete sessionEnv.ANTHROPIC_API_BASE_URL;
      // 隔离 transcript/settings/history，防止与 Claude 会话互相污染
      sessionEnv.CLAUDE_CONFIG_DIR = path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.claude-deepseek');
      // Hub hook 集成
      sessionEnv.CLAUDE_HUB_SESSION_ID = id;
      if (this.hookPort) sessionEnv.CLAUDE_HUB_PORT = String(this.hookPort);
      if (this.hookToken) sessionEnv.CLAUDE_HUB_TOKEN = this.hookToken;
      if (process.env.CLAUDE_HUB_DATA_DIR) {
        sessionEnv.CLAUDE_HUB_DATA_DIR = process.env.CLAUDE_HUB_DATA_DIR;
      }
    } else if (isGlm) {
      const cv = getConfigValues();
      clearProxyEnv(sessionEnv);
      sessionEnv.ANTHROPIC_BASE_URL = cv.GLM_BASE_URL;
      sessionEnv.ANTHROPIC_AUTH_TOKEN = cv.GLM_API_KEY;
      delete sessionEnv.ANTHROPIC_API_KEY;
      delete sessionEnv.ANTHROPIC_API_BASE_URL;
      sessionEnv.CLAUDE_CONFIG_DIR = path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.claude-glm');
      sessionEnv.CLAUDE_HUB_SESSION_ID = id;
      if (this.hookPort) sessionEnv.CLAUDE_HUB_PORT = String(this.hookPort);
      if (this.hookToken) sessionEnv.CLAUDE_HUB_TOKEN = this.hookToken;
      if (process.env.CLAUDE_HUB_DATA_DIR) {
        sessionEnv.CLAUDE_HUB_DATA_DIR = process.env.CLAUDE_HUB_DATA_DIR;
      }
    } else if (isGpt) {
      const cv = getConfigValues();
      // PackyAPI 国内直连，不走代理（VPN 60s idle 会切断长任务）
      clearProxyEnv(sessionEnv);
      sessionEnv.ANTHROPIC_BASE_URL = cv.GPT_BASE_URL;
      sessionEnv.ANTHROPIC_AUTH_TOKEN = cv.GPT_API_KEY;
      delete sessionEnv.ANTHROPIC_API_KEY;
      delete sessionEnv.ANTHROPIC_API_BASE_URL;
      sessionEnv.CLAUDE_CONFIG_DIR = path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.claude-packy-gpt');
      sessionEnv.CLAUDE_HUB_SESSION_ID = id;
      if (this.hookPort) sessionEnv.CLAUDE_HUB_PORT = String(this.hookPort);
      if (this.hookToken) sessionEnv.CLAUDE_HUB_TOKEN = this.hookToken;
      if (process.env.CLAUDE_HUB_DATA_DIR) {
        sessionEnv.CLAUDE_HUB_DATA_DIR = process.env.CLAUDE_HUB_DATA_DIR;
      }
    } else if (isKimi) {
      const cv = getConfigValues();
      clearProxyEnv(sessionEnv);
      sessionEnv.ANTHROPIC_BASE_URL = cv.KIMI_BASE_URL;
      sessionEnv.ANTHROPIC_AUTH_TOKEN = cv.KIMI_API_KEY;
      delete sessionEnv.ANTHROPIC_API_KEY;
      delete sessionEnv.ANTHROPIC_API_BASE_URL;
      sessionEnv.CLAUDE_CONFIG_DIR = path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.claude-packy-kimi');
      sessionEnv.CLAUDE_HUB_SESSION_ID = id;
      if (this.hookPort) sessionEnv.CLAUDE_HUB_PORT = String(this.hookPort);
      if (this.hookToken) sessionEnv.CLAUDE_HUB_TOKEN = this.hookToken;
      if (process.env.CLAUDE_HUB_DATA_DIR) {
        sessionEnv.CLAUDE_HUB_DATA_DIR = process.env.CLAUDE_HUB_DATA_DIR;
      }
    } else if (isQwen) {
      const cv = getConfigValues();
      clearProxyEnv(sessionEnv);
      sessionEnv.ANTHROPIC_BASE_URL = cv.QWEN_BASE_URL;
      sessionEnv.ANTHROPIC_AUTH_TOKEN = cv.QWEN_API_KEY;
      delete sessionEnv.ANTHROPIC_API_KEY;
      delete sessionEnv.ANTHROPIC_API_BASE_URL;
      sessionEnv.CLAUDE_CONFIG_DIR = path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.claude-packy-qwen');
      sessionEnv.CLAUDE_HUB_SESSION_ID = id;
      if (this.hookPort) sessionEnv.CLAUDE_HUB_PORT = String(this.hookPort);
      if (this.hookToken) sessionEnv.CLAUDE_HUB_TOKEN = this.hookToken;
      if (process.env.CLAUDE_HUB_DATA_DIR) {
        sessionEnv.CLAUDE_HUB_DATA_DIR = process.env.CLAUDE_HUB_DATA_DIR;
      }
    }

    // Merge extra env vars (used by TeamSessionManager for MCP config etc.)
    if (opts.extraEnv) {
      Object.assign(sessionEnv, opts.extraEnv);
    }

    const shellArgs = isAgent ? ['-NoProfile', '-NoLogo'] : [];
    // cwd fallback order: opts.cwd (if exists) -> user home. We stat-check to
    // avoid node-pty failing if the stored cwd was later deleted/moved.
    let spawnCwd = opts.cwd;
    if (spawnCwd) {
      try { fs.accessSync(spawnCwd); } catch { spawnCwd = null; }
    }
    if (!spawnCwd) spawnCwd = process.env.USERPROFILE || process.env.HOME || '.';

    if (isCodexApp) {
      const cv = getConfigValues();
      const cmid = opts.model || (isCodexApiBackend(cv) ? cv.CODEX_API_MODEL : 'gpt-5.5');
      const now = Date.now();
      const info = {
        id,
        kind,
        title,
        status: 'idle',
        lastMessageTime: opts.lastMessageTime || now,
        lastOutputPreview: opts.lastOutputPreview || '',
        unreadCount: 0,
        createdAt: now,
        cwd: spawnCwd,
        meetingId: opts.meetingId || null,
        currentModel: { id: cmid, displayName: cmid.toUpperCase() },
        ...(opts.autoTitleGenerated ? { autoTitleGenerated: true } : {}),
      };
      const pendingTimers = [];
      const clientEnv = { ...sessionEnv };
      if (isCodexApiBackend(cv)) {
        clearProxyEnv(clientEnv);
        clientEnv.CODEX_HOME = ensureCodexApiProfile(cv, spawnCwd);
      } else {
        const profile = resolveCodexSubscriptionProfile(cv, opts.codexProfile);
        if (profile.home) {
          clientEnv.CODEX_HOME = profile.home;
          ensureCodexCwdTrusted(spawnCwd, profile.home);
        } else {
          delete clientEnv.CODEX_HOME;
          ensureCodexCwdTrusted(spawnCwd);
        }
        clientEnv.HTTP_PROXY = cv.CLAUDE_PROXY;
        clientEnv.HTTPS_PROXY = cv.CLAUDE_PROXY;
        clientEnv.NO_PROXY = 'localhost,127.0.0.1';
      }
      const appClient = new CodexAppServerClient({
        sessionId: id,
        cwd: spawnCwd,
        model: cmid,
        env: clientEnv,
      });
      this.sessions.set(id, {
        info,
        pty: null,
        appClient,
        pendingTimers,
        ringBuffer: '',
        groupChatReady: true,
        groupChatLastActivity: now,
      });
      codexAppRegistry.setClient(id, appClient);
      appClient.on('output', ({ data }) => {
        const entry = this.sessions.get(id);
        if (!entry) return;
        entry.groupChatLastActivity = Date.now();
        this._appendToRingBuffer(id, data);
        this.onData(id, data);
        this._outputSeq += 1;
        this.emit('output', { sessionId: id, seq: this._outputSeq, data });
      });
      appClient.on('session-bound', (ev) => {
        const entry = this.sessions.get(id);
        if (!entry) return;
        entry.info.codexAppThreadId = ev.threadId;
        this.emit('session-updated', this._toPublic(entry.info));
      });
      appClient.on('exit', (exitInfo) => {
        const entry = this.sessions.get(id);
        if (!entry || entry.appClient !== appClient) return;
        this.sessions.delete(id);
        codexAppRegistry.deleteClient(id);
        this.onSessionClosed(id, entry.info ? entry.info.meetingId : null, exitInfo);
      });
      appClient.start().catch((e) => {
        appClient.emit('output', { sessionId: id, data: `[codex-app] start failed: ${e.message}\r\n` });
      });
      return { ...info };
    }

    let codexSessionsRoot = null;
    if (isCodex) {
      const cv = getConfigValues();
      if (isCodexApiBackend(cv)) {
        sessionEnv.CODEX_HOME = ensureCodexApiProfile(cv, spawnCwd);
        // API 模式 codex 把 rollout 写到 isolated home（不写 ~/.codex/sessions）。
        // 记到 info 让 transcript-tap 注册时把这个 root 加进 CodexTap 的扫描列表。
        codexSessionsRoot = path.join(sessionEnv.CODEX_HOME, 'sessions');
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

    if (isDeepSeek || isGlm || isGpt || isKimi || isQwen) {
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
      conptyInheritCursor: isCodex ? false : !opts.noInheritCursor,
    });

    let currentModel = null;
    if (isClaude) {
      // 默认 Opus 4.7 1M；AI 群聊 Modal 选 sonnet-4.5 等时透传 opts.model。
      const mid = opts.model || 'claude-opus-4-7[1m]';
      currentModel = { id: mid, displayName: mid };
    } else if (isGemini) {
      const mid = opts.model || 'gemini-3-pro-preview';
      currentModel = { id: mid, displayName: SessionManager.geminiDisplayName(mid) };
    } else if (isCodex) {
      const cv = getConfigValues();
      // opts.model（modal/picker 用户选择）必须最高优先级；只有未传时才落到 backend 默认 / 'gpt-5.5'。
      // 旧写法 `isCodexApiBackend ? cv.CODEX_API_MODEL : (opts.model || ...)` 在 packy api 模式下
      // 强制覆盖用户选择，AI 群聊选 5.4/5.3 实际跑出来都是 5.5。
      const cmid = opts.model || (isCodexApiBackend(cv) ? cv.CODEX_API_MODEL : 'gpt-5.5');
      currentModel = { id: cmid, displayName: cmid.toUpperCase() };
    } else if (isDeepSeek) {
      const mid = normalizeDeepSeekModel(opts.model);
      currentModel = { id: mid, displayName: deepseekDisplayName(mid) };
    } else if (isGlm) {
      const cv = getConfigValues();
      const mid = opts.model || cv.GLM_MODEL;
      currentModel = { id: mid, displayName: mid.toLowerCase().includes('5.1') ? 'GLM 5.1' : mid };
    } else if (isGpt) {
      const cv = getConfigValues();
      const mid = opts.model || cv.GPT_MODEL || 'gpt-5.4-high';
      currentModel = { id: mid, displayName: mid.toUpperCase() };
    } else if (isKimi) {
      const cv = getConfigValues();
      const mid = opts.model || cv.KIMI_MODEL || 'kimi-k2.5';
      currentModel = { id: mid, displayName: mid };
    } else if (isQwen) {
      const cv = getConfigValues();
      const mid = opts.model || cv.QWEN_MODEL || 'qwen3.6-plus';
      currentModel = { id: mid, displayName: mid };
    }

    const now = Date.now();
    const info = {
      id,
      kind,
      title,
      status: 'idle',
      lastMessageTime: opts.lastMessageTime || now,
      lastOutputPreview: opts.lastOutputPreview || '',
      unreadCount: 0,
      createdAt: now,
      cwd: spawnCwd,
      meetingId: opts.meetingId || null,
      currentModel,
      codexSessionsRoot,
      ...(isCodex && codexProfile ? { codexProfile: codexProfile.id, codexProfileLabel: codexProfile.label } : {}),
      ...(opts.codexSid ? { codexSid: opts.codexSid } : {}),
      ...(isCodex && (kind === 'codex-resume' || kind === 'codex-web-resume' || opts.codexResumePicker || (opts.useResume && !opts.codexSid)) ? { codexAllowMtimeFallback: true } : {}),
      ...(opts.autoTitleGenerated ? { autoTitleGenerated: true } : {}),
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
    this.sessions.set(id, { info, pty: ptyProcess, pendingTimers, ringBuffer: '', groupChatReady: false, groupChatLastActivity: 0 });

    ptyProcess.onData((data) => {
      const entry = this.sessions.get(id);
      if (entry) entry.groupChatLastActivity = Date.now();
      this._appendToRingBuffer(id, data);
      this.onData(id, data);
      this._outputSeq += 1;
      this.emit('output', { sessionId: id, seq: this._outputSeq, data });
    });

    ptyProcess.onExit((exitInfo) => {
      const entry = this.sessions.get(id);
      // Guard against id reuse: if a fresh session has already taken this id
      // (e.g., via restart-session reusing old.id), the entry's pty will be
      // the new one, NOT this ptyProcess. In that case the new session is
      // alive — we must not delete its Map entry or fire onSessionClosed
      // for the new session.
      if (!entry || entry.pty !== ptyProcess) return;
      const mid = entry.info ? entry.info.meetingId : null;
      this.sessions.delete(id);
      // Stage 2 P1-1：把 exit code/signal 透传给 onSessionClosed，
      //   让 main.js 能把"PTY 异常退出"作为 L2 完成信号通知群聊 watcher。
      //   exitInfo 来自 node-pty：{ exitCode: number, signal: number | undefined }
      //   老调用方只用前两参（id, mid），无需调整；第 3 参可选。
      this.onSessionClosed(id, mid, exitInfo || null);
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
      const model = opts.model || 'claude-opus-4-7[1m]';
      let cmd;
      if (opts.resumeCCSessionId) {
        cmd = ` claude --resume ${opts.resumeCCSessionId} --model ${model}`;
      } else if (opts.useContinue) {
        cmd = ` claude --continue --model ${model}`;
      } else if (kind === 'claude-resume' || kind === 'claude-web-resume') {
        cmd = ` claude --resume --model ${model}`;
      } else {
        cmd = ` claude --model ${model}`;
      }
      // Claude Web 模式：用 --system-prompt-file 完全替换默认 system prompt，
      // 从根上消除 CC 默认的 terse / no preamble 风格偏置，加载 web 风格指令。
      // 注意：与 --append-system-prompt-file 可共存（前者替换、后者追加），但本期
      // claude-web 不进群聊，不会触发同时注入场景。
      if (isClaudeWeb) {
        const promptPath = resolveAsarUnpacked('claude-web-prompt.md');
        cmd += ` --system-prompt-file "${promptPath.replace(/\\/g, '\\\\')}"`;
      }
      // Append system prompt file if provided (TeamSessionManager injects character prompt)
      if (opts.appendSystemPromptFile) {
        cmd += ` --append-system-prompt-file "${opts.appendSystemPromptFile.replace(/\\/g, '\\\\')}"`;
      }
      // Append MCP config file if provided (TeamSessionManager injects MCP server config)
      if (opts.mcpConfigFile) {
        cmd += ` --mcp-config "${opts.mcpConfigFile.replace(/\\/g, '\\\\')}"`;
      }
      // 群聊成员：禁 skill + plugin（保留 auto-memory / CLAUDE.md / OAuth）
      cmd += buildGroupChatIsolationFlags(opts.meetingId);
      // 默认开启 fast 模式（仅 Opus 4.6/4.7/4.8 生效，非 Opus 会被忽略）。
      // 通过 --settings 叠加用户既有 settings；用户仍可在 session 内 /fast 关闭。
      // 用 settings 文件而非 inline JSON，规避 PS 5.1 向 native exe 传内嵌双引号的 quoting bug。
      const fastSettingsPath = resolveAsarUnpacked('claude-fast-settings.json');
      cmd += ` --settings "${fastSettingsPath.replace(/\\/g, '\\\\')}"`;
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
      if (kind === 'gemini-resume') {
        cmd += ' --resume latest';
      } else if (opts.useResume) {
        if (opts.geminiChatId && opts.geminiChatId.length > 8) {
          // Level 1: precise resume by full UUID (e.g. "3eab55d9-8019-4485-a47e-07f93e288be5")
          cmd += ` --resume ${opts.geminiChatId}`;
        } else {
          // Level 2: 8charId (old state.json format) or no chatId → fall back to latest
          cmd += ' --resume latest';
        }
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

    if (isCodex) {
      ensureCodexMcpEntries(sessionEnv.CODEX_HOME || null, opts.codexMcpEntries, CODEX_MANAGED_MCP_NAMES);
      dismissCodexUpdatePrompt(undefined, sessionEnv.CODEX_HOME || null);
      dismissCodexRateLimitDialog(undefined, sessionEnv.CODEX_HOME || null);
      const cv = getConfigValues();
      const codexModel = opts.model || (isCodexApiBackend(cv) ? cv.CODEX_API_MODEL : 'gpt-5.5');
      const codexInstructionFile = opts.codexInstructionFile || (isCodexWeb ? resolveAsarUnpacked('codex-web-prompt.md') : null);
      let cmd;
      if (kind === 'codex-resume' || kind === 'codex-web-resume' || opts.codexResumePicker) {
        // codex resume 无参 = picker by default
        cmd = ` codex resume --dangerously-bypass-approvals-and-sandbox --model ${codexModel}${CODEX_REASONING_CONFIG_ARG}`;
      } else if (opts.useResume && opts.codexSid) {
        // Level 1: precise resume by sid
        cmd = ` codex resume ${opts.codexSid} --dangerously-bypass-approvals-and-sandbox --model ${codexModel}${CODEX_REASONING_CONFIG_ARG}`;
      } else if (opts.useResume) {
        // Level 2 degradation: no sid recorded → use --last
        cmd = ` codex resume --last --dangerously-bypass-approvals-and-sandbox --model ${codexModel}${CODEX_REASONING_CONFIG_ARG}`;
      } else {
        // Research mode：完全 bypass approvals + sandbox（含 MCP 工具调用、shell 命令、文件写）
        // 避免任何 "Allow ... ?" 弹窗阻塞投研讨论流程；
        // 安全约束完全靠 prompt/covenant 软约束（已强化"不要改代码 / 不要 git / 不要删除"）
        // opts.model 让 meeting-create-modal 选定的非默认 model（如 gpt-5.4）生效。
        if (opts.codexBypassApprovals) {
          cmd = ` codex --dangerously-bypass-approvals-and-sandbox --model ${codexModel}${CODEX_REASONING_CONFIG_ARG}`;
        } else {
          cmd = ` codex --dangerously-bypass-approvals-and-sandbox --model ${codexModel}${CODEX_REASONING_CONFIG_ARG}`;
        }
        // 注：曾尝试 --no-alt-screen 改善观感，实测无明显改善 + Enter 提交失效 → 撤回。
        // 渲染观感问题改由"持久化 AI 群聊面板"（直接展示干净回答预览）绕过。
      }
      if (codexInstructionFile) {
        cmd += ` -c "model_instructions_file=${codexInstructionFile.replace(/\\/g, '\\\\')}"`;
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

    if (isDeepSeek) {
      let cmd;
      // --permission-mode bypassPermissions 跳过信任文件夹 + 工具权限等所有弹窗，
      // 让 DeepSeek 会话和 Claude 会话一样直接启动（~/.claude-deepseek 是隔离配置，
      // 不像 ~/.claude 有历史累积的信任状态，必须靠 CLI 参数兜底）。
      if (kind === 'deepseek-resume') {
        const model = normalizeDeepSeekModel(opts.model);
        cmd = ` claude --resume --model ${model} --permission-mode bypassPermissions`;
      } else if (opts.resumeCCSessionId) {
        const model = normalizeDeepSeekModel(opts.model);
        cmd = ` claude --resume ${opts.resumeCCSessionId} --model ${model} --permission-mode bypassPermissions`;
      } else if (opts.useContinue) {
        const model = normalizeDeepSeekModel(opts.model);
        cmd = ` claude --continue --model ${model} --permission-mode bypassPermissions`;
      } else {
        cmd = ` claude --model ${normalizeDeepSeekModel(opts.model)} --permission-mode bypassPermissions`;
      }
      // 群聊投研场景 MCP server 注入（与 isClaude 分支同款；2026-05-28 补齐 DS/GLM/GPT/Kimi/Qwen 五家漏接）
      if (opts.mcpConfigFile) {
        cmd += ` --mcp-config "${opts.mcpConfigFile.replace(/\\/g, '\\\\')}"`;
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

    if (isGlm) {
      const cv = getConfigValues();
      let cmd;
      if (kind === 'glm-resume') {
        const model = opts.model || cv.GLM_MODEL;
        cmd = ` claude --resume --model ${model} --permission-mode bypassPermissions`;
      } else if (opts.resumeCCSessionId) {
        const model = opts.model || cv.GLM_MODEL;
        cmd = ` claude --resume ${opts.resumeCCSessionId} --model ${model} --permission-mode bypassPermissions`;
      } else if (opts.useContinue) {
        const model = opts.model || cv.GLM_MODEL;
        cmd = ` claude --continue --model ${model} --permission-mode bypassPermissions`;
      } else {
        cmd = ` claude --model ${opts.model || cv.GLM_MODEL} --permission-mode bypassPermissions`;
      }
      // 群聊投研场景 MCP server 注入（与 isClaude 分支同款；2026-05-28 补齐 DS/GLM/GPT/Kimi/Qwen 五家漏接）
      if (opts.mcpConfigFile) {
        cmd += ` --mcp-config "${opts.mcpConfigFile.replace(/\\/g, '\\\\')}"`;
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

    if (isGpt) {
      const cv = getConfigValues();
      let cmd;
      if (kind === 'gpt-resume') {
        const model = opts.model || cv.GPT_MODEL || 'gpt-5.4-high';
        cmd = ` claude --resume --model ${model} --permission-mode bypassPermissions`;
      } else if (opts.resumeCCSessionId) {
        const model = opts.model || cv.GPT_MODEL || 'gpt-5.4-high';
        cmd = ` claude --resume ${opts.resumeCCSessionId} --model ${model} --permission-mode bypassPermissions`;
      } else if (opts.useContinue) {
        const model = opts.model || cv.GPT_MODEL || 'gpt-5.4-high';
        cmd = ` claude --continue --model ${model} --permission-mode bypassPermissions`;
      } else {
        cmd = ` claude --model ${opts.model || cv.GPT_MODEL || 'gpt-5.4-high'} --permission-mode bypassPermissions`;
      }
      // 群聊投研场景 MCP server 注入（与 isClaude 分支同款；2026-05-28 补齐 DS/GLM/GPT/Kimi/Qwen 五家漏接）
      if (opts.mcpConfigFile) {
        cmd += ` --mcp-config "${opts.mcpConfigFile.replace(/\\/g, '\\\\')}"`;
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
      const cv = getConfigValues();
      let cmd;
      if (kind === 'kimi-resume') {
        const model = opts.model || cv.KIMI_MODEL || 'kimi-k2.5';
        cmd = ` claude --resume --model ${model} --permission-mode bypassPermissions`;
      } else if (opts.resumeCCSessionId) {
        const model = opts.model || cv.KIMI_MODEL || 'kimi-k2.5';
        cmd = ` claude --resume ${opts.resumeCCSessionId} --model ${model} --permission-mode bypassPermissions`;
      } else if (opts.useContinue) {
        const model = opts.model || cv.KIMI_MODEL || 'kimi-k2.5';
        cmd = ` claude --continue --model ${model} --permission-mode bypassPermissions`;
      } else {
        cmd = ` claude --model ${opts.model || cv.KIMI_MODEL || 'kimi-k2.5'} --permission-mode bypassPermissions`;
      }
      // 群聊投研场景 MCP server 注入（与 isClaude 分支同款；2026-05-28 补齐 DS/GLM/GPT/Kimi/Qwen 五家漏接）
      if (opts.mcpConfigFile) {
        cmd += ` --mcp-config "${opts.mcpConfigFile.replace(/\\/g, '\\\\')}"`;
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

    if (isQwen) {
      const cv = getConfigValues();
      let cmd;
      if (kind === 'qwen-resume') {
        const model = opts.model || cv.QWEN_MODEL || 'qwen3.6-plus';
        cmd = ` claude --resume --model ${model} --permission-mode bypassPermissions`;
      } else if (opts.resumeCCSessionId) {
        const model = opts.model || cv.QWEN_MODEL || 'qwen3.6-plus';
        cmd = ` claude --resume ${opts.resumeCCSessionId} --model ${model} --permission-mode bypassPermissions`;
      } else if (opts.useContinue) {
        const model = opts.model || cv.QWEN_MODEL || 'qwen3.6-plus';
        cmd = ` claude --continue --model ${model} --permission-mode bypassPermissions`;
      } else {
        cmd = ` claude --model ${opts.model || cv.QWEN_MODEL || 'qwen3.6-plus'} --permission-mode bypassPermissions`;
      }
      // 群聊投研场景 MCP server 注入（与 isClaude 分支同款；2026-05-28 补齐 DS/GLM/GPT/Kimi/Qwen 五家漏接）
      if (opts.mcpConfigFile) {
        cmd += ` --mcp-config "${opts.mcpConfigFile.replace(/\\/g, '\\\\')}"`;
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

    return { ...info };
  }

  closeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    for (const t of session.pendingTimers) clearTimeout(t);
    if (session.appClient) {
      this.sessions.delete(sessionId);
      codexAppRegistry.deleteClient(sessionId);
      try { session.appClient.close(); } catch {}
      this.onSessionClosed(sessionId, session.info ? session.info.meetingId : null, { code: 0, signal: 'client_close' });
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

  writeToSession(sessionId, data) {
    const s = this.sessions.get(sessionId);
    if (s && s.appClient) return s.appClient.handleInput(data);
    if (s && s.pty) s.pty.write(data);
  }

  resizeSession(sessionId, cols, rows) {
    const s = this.sessions.get(sessionId);
    if (s && s.pty) s.pty.resize(Math.max(cols, 60), rows);
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
  relaunchCli(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s || !s.pty) return false;
    const kind = s.info && s.info.kind;
    const modelId = s.info && s.info.currentModel && s.info.currentModel.id;
    const meetingId = s.info && s.info.meetingId;
    // 群聊成员：复用 buildGroupChatIsolationFlags 输出 (v2 后仅 --settings,不含
    //   --disable-slash-commands;详见该函数注释)。
    // 用 isClaudeFamily 同时覆盖主 kind 与 *-resume 形态（含 gpt/kimi/qwen 跑在 Claude CLI 上）。
    const baseKind = (typeof kind === 'string') ? kind.replace(/-resume$/, '') : kind;
    const isClaudeCli = isClaudeFamily(baseKind);
    const isolation = isClaudeCli ? buildGroupChatIsolationFlags(meetingId) : '';
    let cmd;
    if (isCodexCliKind(kind)) {
      // relaunch：API 模式时 codex 用 isolated CODEX_HOME，从 info.codexSessionsRoot 反推
      const codexConfigDir = s.info && s.info.codexSessionsRoot ? path.dirname(s.info.codexSessionsRoot) : null;
      dismissCodexUpdatePrompt(undefined, codexConfigDir);
      dismissCodexRateLimitDialog(undefined, codexConfigDir);
      cmd = ` codex --dangerously-bypass-approvals-and-sandbox --model ${modelId || 'gpt-5.5'}${CODEX_REASONING_CONFIG_ARG}`;
      if (isCodexWebKind(kind)) {
        const promptPath = resolveAsarUnpacked('codex-web-prompt.md');
        cmd += ` -c "model_instructions_file=${promptPath.replace(/\\/g, '\\\\')}"`;
      }
      cmd += '\r\n';
    } else if (kind === 'gemini' || kind === 'gemini-resume') {
      cmd = ` gemini --approval-mode yolo --model ${modelId || 'gemini-3-pro-preview'}\r\n`;
    } else if (kind === 'claude' || kind === 'claude-resume') {
      cmd = ` claude --model ${modelId || 'claude-opus-4-7[1m]'}${isolation}\r\n`;
    } else if (kind === 'deepseek' || kind === 'deepseek-resume') {
      cmd = ` claude --model ${normalizeDeepSeekModel(modelId)} --permission-mode bypassPermissions${isolation}\r\n`;
    } else if (kind === 'glm' || kind === 'glm-resume') {
      const cv = getConfigValues();
      cmd = ` claude --model ${modelId || cv.GLM_MODEL || 'glm-5.1'} --permission-mode bypassPermissions${isolation}\r\n`;
    } else if (kind === 'gpt' || kind === 'gpt-resume') {
      const cv = getConfigValues();
      cmd = ` claude --model ${modelId || cv.GPT_MODEL || 'gpt-5.4-high'} --permission-mode bypassPermissions${isolation}\r\n`;
    } else if (kind === 'kimi' || kind === 'kimi-resume') {
      const cv = getConfigValues();
      cmd = ` claude --model ${modelId || cv.KIMI_MODEL || 'kimi-k2.5'} --permission-mode bypassPermissions${isolation}\r\n`;
    } else if (kind === 'qwen' || kind === 'qwen-resume') {
      const cv = getConfigValues();
      cmd = ` claude --model ${modelId || cv.QWEN_MODEL || 'qwen3.6-plus'} --permission-mode bypassPermissions${isolation}\r\n`;
    } else {
      return false;
    }
    s.pty.write(cmd);
    // 重置 group-chat 快路径缓存：CLI 是新启动，必须重新走冷启动流程
    s.groupChatReady = false;
    return true;
  }

  getAllSessions() {
    return Array.from(this.sessions.values())
      .map(s => ({ ...s.info }))
      .sort((a, b) => b.lastMessageTime - a.lastMessageTime || b.createdAt - a.createdAt);
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
      lastOutputPreview: info.lastOutputPreview,
      ...(info.pinned !== undefined ? { pinned: info.pinned } : {}),
      ...(info.ccSessionId !== undefined ? { ccSessionId: info.ccSessionId } : {}),
      ...(info.transcriptPath !== undefined ? { transcriptPath: info.transcriptPath } : {}),
      ...(info.currentModel ? { model: info.currentModel.id } : {}),
      ...(info.currentModel ? { currentModel: info.currentModel } : {}),
      ...(info.codexAppThreadId !== undefined ? { codexAppThreadId: info.codexAppThreadId } : {}),
      ...(typeof info.contextPct === 'number' ? { contextPct: info.contextPct } : {}),
      ...(typeof info.contextUsed === 'number' ? { contextUsed: info.contextUsed } : {}),
      ...(typeof info.contextMax === 'number' ? { contextMax: info.contextMax } : {}),
      ...(info.userRenamed ? { userRenamed: true } : {}),
      ...(info.autoTitleGenerated ? { autoTitleGenerated: true } : {}),
    };
  }

  // Returns array of public session objects for renderer IPC.
  listSessions() {
    return Array.from(this.sessions.values())
      .map(s => this._toPublic(s.info))
      .sort((a, b) => b.lastMessageTime - a.lastMessageTime);
  }

  // Appends data to the session's ring buffer, capping at RING_BUFFER_BYTES (tail-slice).
  // After truncation, trims any lone low-surrogate left at the start of the buffer
  // that could result from cutting a UTF-16 surrogate pair at the boundary.
  // Extracted as a named method so tests can drive it without spawning a real PTY.
  _appendToRingBuffer(id, data) {
    const s = this.sessions.get(id);
    if (!s) return;
    let rb = (s.ringBuffer || '') + data;
    if (rb.length > RING_BUFFER_BYTES) {
      rb = rb.slice(rb.length - RING_BUFFER_BYTES);
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

  dispose() {
    for (const s of this.sessions.values()) {
      for (const t of s.pendingTimers) clearTimeout(t);
      if (s.appClient) {
        try { s.appClient.close(); } catch {}
      } else if (s.pty) {
        s.pty.kill();
      }
    }
    for (const id of this.sessions.keys()) codexAppRegistry.deleteClient(id);
    this.sessions.clear();
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
//   kind:    'claude' | 'claude-resume' | 'deepseek' | 'glm' | 'codex' | 'gemini'
//   sourcePath: kind-specific transcript file path
//
// 2026-05-02 修复：deepseek/glm 跑在 Claude CLI 上，transcript JSONL shape 与 Claude
//   完全一致，原本应复用 'claude' 分支但代码里完全没分支 → resume 时 AI 群聊历史上下文
//   注入失败。下面把 Claude 家族判定改为 isClaudeFamily helper（已在文件顶部 require）。
async function readTranscriptTail(kind, sourcePath, n = 10) {
  if (!sourcePath) return null;
  // T13 fix: refuse oversized transcripts (>5MB) to avoid main-process memory spike
  // (readFileSync + split allocates ~2x file size in RAM).
  try {
    const stat = require('fs').statSync(sourcePath);
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
      const obj = JSON.parse(require('fs').readFileSync(sourcePath, 'utf-8'));
      const msgs = Array.isArray(obj.messages) ? obj.messages.slice(-n) : [];
      const joined = msgs.map(m => {
        if (m.type === 'user') return `USER: ${(m.content||[]).map(c=>c.text).filter(Boolean).join('')}`;
        if (m.type === 'gemini') return `ASSISTANT: ${typeof m.content==='string'?m.content:''}`;
        return null;
      }).filter(Boolean).join('\n\n');
      return joined.length > MAX_INJECT ? joined.slice(0, MAX_INJECT) + '\n[CONTEXT TRUNCATED]' : joined;
    }
    // JSONL: tail N lines
    const lines = require('fs').readFileSync(sourcePath, 'utf-8').trim().split('\n').slice(-n*2);
    const out = [];
    for (const line of lines) {
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (isClaudeFamily(kind)) {
        // Claude 家族（claude/claude-resume/deepseek/glm）共享同一 JSONL shape
        if (obj.type === 'user' && obj.message?.content) {
          out.push(`USER: ${typeof obj.message.content === 'string' ? obj.message.content : JSON.stringify(obj.message.content)}`);
        }
        if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
          const txt = obj.message.content.filter(c => c.type === 'text').map(c => c.text).join('');
          if (txt) out.push(`ASSISTANT: ${txt}`);
        }
      } else if (kind === 'codex' || kind === 'codex-web') {
        if (obj.type === 'event_msg' && obj.payload?.type === 'task_complete' && obj.payload?.last_agent_message) {
          out.push(`ASSISTANT: ${obj.payload.last_agent_message}`);
        } else if (obj.type === 'response_item' && obj.payload?.role === 'user' && obj.payload?.content) {
          out.push(`USER: ${typeof obj.payload.content === 'string' ? obj.payload.content : JSON.stringify(obj.payload.content)}`);
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

module.exports = { SessionManager, readTranscriptTail, dismissCodexUpdatePrompt, dismissCodexRateLimitDialog, clearSessionManagerConfigCache };
