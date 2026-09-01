/**
 * Hub 配置加载器
 *
 * 优先级（从高到低）：
 * 1. 环境变量（DEEPSEEK_API_KEY, CLAUDE_PROXY）
 * 2. config.json（~/.claude-session-hub/config.json）
 * 3. 默认值
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { getHubDataDir } = require('./data-dir');
const { DEFAULT_MODEL_BY_KIND } = require('./model-options.js');
const { normalizeConsolidationConfig } = require('./dream-consolidation.js');
const { normalizeNotificationConfig } = require('./completion-notifier.js');
const { normalizeOperationsConfig } = require('./operations-config.js');
const {
  DEFAULT_CARD_FONT_SIZE,
  DEFAULT_CARD_FONT_FAMILY,
  normalizeCardFontSize,
  normalizeCardFontFamily,
} = require('./card-display-config.js');

// 默认值
const DEFAULTS = {
  proxy: 'http://127.0.0.1:7890',
  claude_backend: 'subscription',
  // 同事提供的 Claude-compatible Fable 网关。只预置连接参数；
  // backend 仍默认 subscription，未显式切换时绝不会使用该网关。
  claude_api_base_url: 'http://3.142.133.116:8080',
  claude_api_model: 'claude-fable-5',
  codex_backend: 'subscription',
  codex_subscription_profile: 'default',
  codex_api_base_url: 'https://www.packyapi.com/v1',
  codex_api_model: DEFAULT_MODEL_BY_KIND.codex,
  codex_api_provider: 'packycode',
  ui_tool_fold_threshold: 15,
  ui_code_fold_threshold: 30,
  ui_card_font_size: DEFAULT_CARD_FONT_SIZE,
  ui_card_font_family: DEFAULT_CARD_FONT_FAMILY,
};

/**
 * 加载 config.json
 */
function loadConfigJson() {
  const configPath = path.join(getHubDataDir(), 'config.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * 获取配置值（优先级：env > config.json > default）
 */
function getConfigValue(key, envKey, configPath, defaultValue) {
  // 1. 环境变量
  if (process.env[envKey]) {
    return process.env[envKey];
  }

  // 2. config.json
  const config = loadConfigJson();
  const configValue = configPath.split('.').reduce((obj, k) => obj && obj[k], config);
  if (configValue !== undefined && configValue !== null && configValue !== '') {
    return configValue;
  }

  // 3. 默认值
  return defaultValue;
}

/**
 * 规范化 base URL（去掉末尾斜杠）
 */
function normalizeBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function defaultCodexSubscriptionProfiles() {
  return [
    { id: 'default', label: '主账号', home: '' },
    { id: 'second', label: '新账号', home: path.join(os.homedir(), '.codex-profiles', 'second') },
  ];
}

function normalizeCodexSubscriptionProfiles(profiles) {
  const byId = new Map(defaultCodexSubscriptionProfiles().map(p => [p.id, p]));
  if (Array.isArray(profiles)) {
    for (const p of profiles) {
      if (!p || typeof p !== 'object') continue;
      const id = String(p.id || '').trim();
      if (!id) continue;
      byId.set(id, {
        id,
        label: String(p.label || p.name || id).trim() || id,
        home: String(p.home || '').trim(),
      });
    }
  }
  return [...byId.values()];
}

// 导出配置值（惰性求值，首次访问时计算）
let _cachedConfig = null;

function getConfig() {
  if (_cachedConfig) return _cachedConfig;
  const rawConfig = loadConfigJson();
  const codexProvider = (rawConfig.providers && rawConfig.providers.codex) || {};
  const codexSubscriptionProfiles = normalizeCodexSubscriptionProfiles(codexProvider.subscription_profiles);

  _cachedConfig = {
    proxy: getConfigValue('proxy', 'CLAUDE_PROXY', 'proxy.http', DEFAULTS.proxy),
    claudeBackend: getConfigValue('claudeBackend', 'HUB_CLAUDE_BACKEND', 'providers.claude.backend', DEFAULTS.claude_backend),
    claudeApiKey: getConfigValue('claudeApiKey', 'HUB_CLAUDE_API_KEY', 'providers.claude.api_key', ''),
    claudeApiBaseUrl: normalizeBaseUrl(getConfigValue('claudeApiBaseUrl', 'HUB_CLAUDE_API_BASE_URL', 'providers.claude.base_url', DEFAULTS.claude_api_base_url)),
    claudeApiModel: getConfigValue('claudeApiModel', 'HUB_CLAUDE_API_MODEL', 'providers.claude.model', DEFAULTS.claude_api_model),
    deepseekApiKey: getConfigValue('deepseekApiKey', 'DEEPSEEK_API_KEY', 'providers.deepseek.api_key', ''),
    codexBackend: getConfigValue('codexBackend', 'HUB_CODEX_BACKEND', 'providers.codex.backend', DEFAULTS.codex_backend),
    codexSubscriptionProfile: getConfigValue('codexSubscriptionProfile', 'HUB_CODEX_PROFILE', 'providers.codex.subscription_profile', DEFAULTS.codex_subscription_profile),
    codexSubscriptionProfiles,
    codexApiKey: getConfigValue('codexApiKey', 'HUB_CODEX_API_KEY', 'providers.codex.api_key', ''),
    codexApiBaseUrl: normalizeBaseUrl(getConfigValue('codexApiBaseUrl', 'HUB_CODEX_API_BASE_URL', 'providers.codex.base_url', DEFAULTS.codex_api_base_url)),
    codexApiModel: getConfigValue('codexApiModel', 'HUB_CODEX_API_MODEL', 'providers.codex.model', DEFAULTS.codex_api_model),
    codexApiProvider: getConfigValue('codexApiProvider', 'HUB_CODEX_API_PROVIDER', 'providers.codex.provider', DEFAULTS.codex_api_provider),
    uiToolFoldThreshold: parseInt(getConfigValue('uiToolFoldThreshold', 'HUB_UI_TOOL_FOLD', 'ui.tool_fold_threshold', DEFAULTS.ui_tool_fold_threshold), 10),
    uiCodeFoldThreshold: parseInt(getConfigValue('uiCodeFoldThreshold', 'HUB_UI_CODE_FOLD', 'ui.code_fold_threshold', DEFAULTS.ui_code_fold_threshold), 10),
    cardFontSize: normalizeCardFontSize(getConfigValue('cardFontSize', 'HUB_UI_CARD_FONT_SIZE', 'ui.card_font_size', DEFAULTS.ui_card_font_size)),
    cardFontFamily: normalizeCardFontFamily(getConfigValue('cardFontFamily', 'HUB_UI_CARD_FONT_FAMILY', 'ui.card_font_family', DEFAULTS.ui_card_font_family)),
    // 回答完成通知；飞书接收对象可由 config.json 或 HUB_NOTIFY_FEISHU_TARGET 提供。
    notifications: normalizeNotificationConfig(rawConfig.notifications),
    // 梦境系统（dream-consolidation）配置段，config.json 的 consolidation 键。
    consolidation: normalizeConsolidationConfig(rawConfig.consolidation),
    // 工作台运维：服务器健康检查和安全恢复 worktree 根目录。
    operations: normalizeOperationsConfig(rawConfig.operations),
  };

  return _cachedConfig;
}

/**
 * 清除缓存（用于测试或配置更新后重新加载）
 */
function clearConfigCache() {
  _cachedConfig = null;
}

/**
 * 保存配置到 config.json
 */
function saveConfig(config) {
  const configPath = path.join(getHubDataDir(), 'config.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  clearConfigCache();
}

/**
 * 获取 config.json 路径
 */
function getConfigPath() {
  return path.join(getHubDataDir(), 'config.json');
}

/**
 * 检查是否缺少必要配置（用于首次启动向导）
 */
function checkMissingConfig() {
  const config = getConfig();
  const missing = [];

  // DeepSeek 是可选功能，不强制要求
  // 但如果用户想用，需要配置
  if (!config.deepseekApiKey) {
    missing.push({ key: 'deepseek', label: 'DeepSeek API Key', required: false });
  }

  return missing;
}

module.exports = {
  getConfig,
  clearConfigCache,
  saveConfig,
  getConfigPath,
  checkMissingConfig,
  DEFAULTS,
};
