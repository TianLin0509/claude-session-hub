'use strict';

const fs = require('fs');
const {
  getConfig,
  saveConfig,
  checkMissingConfig,
  getConfigPath,
  DEFAULTS,
} = require('../../core/hub-config.js');
const {
  normalizeCardFontSize,
  normalizeCardFontFamily,
} = require('../../core/card-display-config.js');

function toMaskedConfig(config) {
  return {
    proxy: config.proxy,
    claudeBackend: config.claudeBackend,
    claudeApiKey: config.claudeApiKey ? '***' + config.claudeApiKey.slice(-4) : '',
    claudeApiKeySet: !!config.claudeApiKey,
    claudeApiBaseUrl: config.claudeApiBaseUrl,
    claudeApiModel: config.claudeApiModel,
    deepseekApiKey: config.deepseekApiKey ? '***' + config.deepseekApiKey.slice(-4) : '',
    deepseekApiKeySet: !!config.deepseekApiKey,
    codexBackend: config.codexBackend,
    codexSubscriptionProfile: config.codexSubscriptionProfile,
    codexSubscriptionProfiles: config.codexSubscriptionProfiles || [],
    codexApiKey: config.codexApiKey ? '***' + config.codexApiKey.slice(-4) : '',
    codexApiKeySet: !!config.codexApiKey,
    codexApiBaseUrl: config.codexApiBaseUrl,
    codexApiModel: config.codexApiModel,
  };
}

function toEditableConfig(config) {
  return {
    proxy: config.proxy,
    claudeBackend: config.claudeBackend,
    claudeApiKey: config.claudeApiKey || '',
    claudeApiBaseUrl: config.claudeApiBaseUrl,
    claudeApiModel: config.claudeApiModel,
    deepseekApiKey: config.deepseekApiKey || '',
    codexBackend: config.codexBackend,
    codexSubscriptionProfile: config.codexSubscriptionProfile,
    codexSubscriptionProfiles: config.codexSubscriptionProfiles || [],
    codexApiKey: config.codexApiKey || '',
    codexApiBaseUrl: config.codexApiBaseUrl,
    codexApiModel: config.codexApiModel,
    uiToolFoldThreshold: Number.isFinite(config.uiToolFoldThreshold) ? config.uiToolFoldThreshold : 15,
    uiCodeFoldThreshold: Number.isFinite(config.uiCodeFoldThreshold) ? config.uiCodeFoldThreshold : 30,
    cardFontSize: normalizeCardFontSize(config.cardFontSize),
    cardFontFamily: normalizeCardFontFamily(config.cardFontFamily),
  };
}

function buildConfigJsonUpdate(existing, newConfig) {
  // 2026-06-14 修复部分提交数据丢失：config-modal 全量提交始终带全部字段。旧逻辑对每个 provider 字段无条件
  //   `newConfig.X || default/undefined`，使部分提交把未提交的 deepseek
  //   api_key、各 base_url/model、proxy、packy cookie 全部重置/抹掉。
  //   修法：仅当 newConfig 显式带了该字段(hasOwnProperty)才用其值，否则保留 existing。
  //   全量提交所有 key 都在 → 行为与旧版完全一致(零回归)；部分提交其余字段原样保留。
  const H = (k) => Object.prototype.hasOwnProperty.call(newConfig, k);
  const merged = {
    ...existing,
    proxy: { http: H('proxy') ? (newConfig.proxy || DEFAULTS.proxy) : (existing.proxy?.http || DEFAULTS.proxy) },
    providers: {
      ...(existing.providers || {}),
      claude: {
        ...(existing.providers?.claude || {}),
        backend: H('claudeBackend')
          ? (newConfig.claudeBackend === 'api' ? 'api' : DEFAULTS.claude_backend)
          : (existing.providers?.claude?.backend || DEFAULTS.claude_backend),
        api_key: H('claudeApiKey')
          ? (newConfig.claudeApiKey || undefined)
          : existing.providers?.claude?.api_key,
        base_url: H('claudeApiBaseUrl')
          ? (newConfig.claudeApiBaseUrl || DEFAULTS.claude_api_base_url)
          : (existing.providers?.claude?.base_url || DEFAULTS.claude_api_base_url),
        model: H('claudeApiModel')
          ? (newConfig.claudeApiModel || DEFAULTS.claude_api_model)
          : (existing.providers?.claude?.model || DEFAULTS.claude_api_model),
      },
      deepseek: {
        ...(existing.providers?.deepseek || {}),
        api_key: H('deepseekApiKey') ? (newConfig.deepseekApiKey || undefined) : existing.providers?.deepseek?.api_key,
      },
      codex: (() => {
        return {
          ...(existing.providers?.codex || {}),
          backend: newConfig.codexBackend === 'api' ? 'api' : DEFAULTS.codex_backend,
          subscription_profile: newConfig.codexSubscriptionProfile || DEFAULTS.codex_subscription_profile,
          subscription_profiles: Array.isArray(newConfig.codexSubscriptionProfiles) ? newConfig.codexSubscriptionProfiles : undefined,
          api_key: newConfig.codexApiKey || undefined,
          base_url: newConfig.codexApiBaseUrl || DEFAULTS.codex_api_base_url,
          model: newConfig.codexApiModel || DEFAULTS.codex_api_model,
          provider: DEFAULTS.codex_api_provider,
        };
      })(),
    },
    ui: {
      ...(existing.ui || {}),
      card_font_size: H('cardFontSize')
        ? normalizeCardFontSize(newConfig.cardFontSize)
        : normalizeCardFontSize(existing.ui?.card_font_size),
      card_font_family: H('cardFontFamily')
        ? normalizeCardFontFamily(newConfig.cardFontFamily)
        : normalizeCardFontFamily(existing.ui?.card_font_family),
    },
  };

  if (!merged.providers.claude.api_key) delete merged.providers.claude.api_key;
  if (!merged.providers.claude.base_url) delete merged.providers.claude.base_url;
  if (!merged.providers.deepseek.api_key) delete merged.providers.deepseek.api_key;
  if (!merged.providers.codex.api_key) delete merged.providers.codex.api_key;

  return merged;
}

function registerConfigIpc(ipcMain, deps) {
  const {
    attachCodexUsageScope,
    clearCodexJsonlCache,
    clearSessionManagerConfigCache,
    currentCodexUsageScope,
    scanAgentSessions,
    sendToRenderer,
  } = deps;

  ipcMain.handle('get-hub-config', () => toMaskedConfig(getConfig()));

  ipcMain.handle('get-hub-config-raw', () => toEditableConfig(getConfig()));

  ipcMain.handle('save-hub-config', (_e, newConfig) => {
    const configPath = getConfigPath();
    let existing = {};
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      existing = JSON.parse(raw);
    } catch (e) {
      // ENOENT = 配置文件还不存在（首次运行），existing={} 合法，继续保存。
      // 其它错误（文件被锁 EBUSY/EPERM、JSON 损坏等）说明现有配置确实读不到——
      // 此时若用空对象合并，部分字段提交（如 Meridian 弹窗只发 3 个字段）会静默
      // 抹掉其它 provider 的已存 API key。宁可中止本次保存，也不能静默覆盖。
      if (!e || e.code !== 'ENOENT') {
        console.error('[config] save-hub-config: 读取现有配置失败，已中止保存以防覆盖其它字段:', e && e.message);
        return { success: false, error: 'config_read_failed' };
      }
    }

    const merged = buildConfigJsonUpdate(existing, newConfig);
    saveConfig(merged);
    clearSessionManagerConfigCache();

    if (newConfig.codexBackend !== undefined || newConfig.codexSubscriptionProfile !== undefined) {
      const scope = currentCodexUsageScope();
      clearCodexJsonlCache();
      sendToRenderer('agent-usage', { codex: attachCodexUsageScope({ usage5h: null, usage7d: null, unavailable: true }, scope) });
      setImmediate(() => {
        Promise.resolve(scanAgentSessions()).catch(error => {
          console.warn('[config] usage rescan failed:', error && error.message);
        });
      });
    }
    return { success: true };
  });

  ipcMain.handle('check-config-missing', () => {
    return checkMissingConfig();
  });

  ipcMain.handle('get-config-path', () => {
    return getConfigPath();
  });

}

module.exports = {
  buildConfigJsonUpdate,
  registerConfigIpc,
  toEditableConfig,
  toMaskedConfig,
};
