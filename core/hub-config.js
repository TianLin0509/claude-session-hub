/**
 * Hub 配置加载器
 *
 * 优先级（从高到低）：
 * 1. 环境变量（DEEPSEEK_API_KEY, GLM_API_KEY, GLM_BASE_URL, GLM_MODEL, CLAUDE_PROXY）
 * 2. config.json（~/.claude-session-hub/config.json）
 * 3. secrets.toml（兼容老用户：C:\LinDangAgent\secrets.toml）
 *
 * 老用户无感知：如果 config.json 不存在或未配置某项，自动 fallback 到 secrets.toml。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { getHubDataDir } = require('./data-dir');

// 默认值
const DEFAULTS = {
  proxy: 'http://127.0.0.1:7890',
  glm_base_url: 'https://mydamoxing.cn',
  glm_model: 'glm-5.1',
  codex_backend: 'subscription',
  codex_api_base_url: 'https://www.packyapi.com/v1',
  codex_api_model: 'gpt-5.5',
  codex_api_provider: 'packycode',
};

// 兼容老用户的 secrets.toml 路径
const LEGACY_SECRETS_PATH = 'C:\\LinDangAgent\\secrets.toml';

/**
 * 从 secrets.toml 格式文件读取值
 */
function readTomlValue(filepath, key) {
  try {
    const content = fs.readFileSync(filepath, 'utf8');
    const match = content.match(new RegExp(key + '\\s*=\\s*["\']([^"\']+)["\']'));
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

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
 * 获取配置值（优先级：env > config.json > secrets.toml > default）
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

  // 3. secrets.toml（兼容老用户）
  const tomlValue = readTomlValue(LEGACY_SECRETS_PATH, envKey);
  if (tomlValue) {
    return tomlValue;
  }

  // 4. 默认值
  return defaultValue;
}

/**
 * 规范化 base URL（去掉末尾斜杠）
 */
function normalizeBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

// 导出配置值（惰性求值，首次访问时计算）
let _cachedConfig = null;

function getConfig() {
  if (_cachedConfig) return _cachedConfig;

  _cachedConfig = {
    proxy: getConfigValue('proxy', 'CLAUDE_PROXY', 'proxy.http', DEFAULTS.proxy),
    deepseekApiKey: getConfigValue('deepseekApiKey', 'DEEPSEEK_API_KEY', 'providers.deepseek.api_key', ''),
    glmApiKey: getConfigValue('glmApiKey', 'GLM_API_KEY', 'providers.glm.api_key', ''),
    glmBaseUrl: normalizeBaseUrl(getConfigValue('glmBaseUrl', 'GLM_BASE_URL', 'providers.glm.base_url', DEFAULTS.glm_base_url)),
    glmModel: getConfigValue('glmModel', 'GLM_MODEL', 'providers.glm.model', DEFAULTS.glm_model),
    codexBackend: getConfigValue('codexBackend', 'HUB_CODEX_BACKEND', 'providers.codex.backend', DEFAULTS.codex_backend),
    codexApiKey: getConfigValue('codexApiKey', 'HUB_CODEX_API_KEY', 'providers.codex.api_key', ''),
    codexApiBaseUrl: normalizeBaseUrl(getConfigValue('codexApiBaseUrl', 'HUB_CODEX_API_BASE_URL', 'providers.codex.base_url', DEFAULTS.codex_api_base_url)),
    codexApiModel: getConfigValue('codexApiModel', 'HUB_CODEX_API_MODEL', 'providers.codex.model', DEFAULTS.codex_api_model),
    codexApiProvider: getConfigValue('codexApiProvider', 'HUB_CODEX_API_PROVIDER', 'providers.codex.provider', DEFAULTS.codex_api_provider),
    feishuCodex: {
      token: getConfigValue('feishuCodexToken', 'HUB_FEISHU_CODEX_TOKEN', 'channels.feishuCodex.token', ''),
      appId: getConfigValue('feishuAppId', 'HUB_FEISHU_APP_ID', 'channels.feishuCodex.app_id', ''),
      appSecret: getConfigValue('feishuAppSecret', 'HUB_FEISHU_APP_SECRET', 'channels.feishuCodex.app_secret', ''),
      domain: getConfigValue('feishuDomain', 'HUB_FEISHU_DOMAIN', 'channels.feishuCodex.domain', 'feishu'),
      defaultCwd: getConfigValue('feishuCodexCwd', 'HUB_FEISHU_CODEX_CWD', 'channels.feishuCodex.cwd', ''),
      replyInThread: getConfigValue('feishuReplyInThread', 'HUB_FEISHU_REPLY_IN_THREAD', 'channels.feishuCodex.reply_in_thread', '1') !== '0',
      ws: getConfigValue('feishuWs', 'HUB_FEISHU_WS', 'channels.feishuCodex.ws', '1') !== '0',
    },
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

  // DeepSeek 和 GLM 都是可选功能，不强制要求
  // 但如果用户想用，需要配置
  if (!config.deepseekApiKey) {
    missing.push({ key: 'deepseek', label: 'DeepSeek API Key', required: false });
  }
  if (!config.glmApiKey) {
    missing.push({ key: 'glm', label: 'GLM API Key', required: false });
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
  LEGACY_SECRETS_PATH,
};
