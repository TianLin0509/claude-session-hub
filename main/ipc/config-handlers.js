'use strict';

const fs = require('fs');
const {
  getConfig,
  saveConfig,
  checkMissingConfig,
  getConfigPath,
  DEFAULTS,
} = require('../../core/hub-config.js');

function toMaskedConfig(config) {
  return {
    proxy: config.proxy,
    deepseekApiKey: config.deepseekApiKey ? '***' + config.deepseekApiKey.slice(-4) : '',
    deepseekApiKeySet: !!config.deepseekApiKey,
    glmApiKey: config.glmApiKey ? '***' + config.glmApiKey.slice(-4) : '',
    glmApiKeySet: !!config.glmApiKey,
    glmBaseUrl: config.glmBaseUrl,
    glmModel: config.glmModel,
    gptApiKey: config.gptApiKey ? '***' + config.gptApiKey.slice(-4) : '',
    gptApiKeySet: !!config.gptApiKey,
    gptBaseUrl: config.gptBaseUrl,
    gptModel: config.gptModel,
    kimiApiKey: config.kimiApiKey ? '***' + config.kimiApiKey.slice(-4) : '',
    kimiApiKeySet: !!config.kimiApiKey,
    kimiBaseUrl: config.kimiBaseUrl,
    kimiModel: config.kimiModel,
    qwenApiKey: config.qwenApiKey ? '***' + config.qwenApiKey.slice(-4) : '',
    qwenApiKeySet: !!config.qwenApiKey,
    qwenBaseUrl: config.qwenBaseUrl,
    qwenModel: config.qwenModel,
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
    deepseekApiKey: config.deepseekApiKey || '',
    glmApiKey: config.glmApiKey || '',
    glmBaseUrl: config.glmBaseUrl,
    glmModel: config.glmModel,
    gptApiKey: config.gptApiKey || '',
    gptBaseUrl: config.gptBaseUrl,
    gptModel: config.gptModel,
    kimiApiKey: config.kimiApiKey || '',
    kimiBaseUrl: config.kimiBaseUrl,
    kimiModel: config.kimiModel,
    qwenApiKey: config.qwenApiKey || '',
    qwenBaseUrl: config.qwenBaseUrl,
    qwenModel: config.qwenModel,
    codexBackend: config.codexBackend,
    codexSubscriptionProfile: config.codexSubscriptionProfile,
    codexSubscriptionProfiles: config.codexSubscriptionProfiles || [],
    codexApiKey: config.codexApiKey || '',
    codexApiBaseUrl: config.codexApiBaseUrl,
    codexApiModel: config.codexApiModel,
    packySessionCookie: config.packySessionCookie || '',
    uiToolFoldThreshold: Number.isFinite(config.uiToolFoldThreshold) ? config.uiToolFoldThreshold : 15,
    uiCodeFoldThreshold: Number.isFinite(config.uiCodeFoldThreshold) ? config.uiCodeFoldThreshold : 30,
  };
}

function buildConfigJsonUpdate(existing, newConfig) {
  const merged = {
    ...existing,
    proxy: { http: newConfig.proxy || DEFAULTS.proxy },
    providers: {
      ...(existing.providers || {}),
      deepseek: {
        ...(existing.providers?.deepseek || {}),
        api_key: newConfig.deepseekApiKey || undefined,
      },
      glm: {
        ...(existing.providers?.glm || {}),
        api_key: newConfig.glmApiKey || undefined,
        base_url: newConfig.glmBaseUrl || DEFAULTS.glm_base_url,
        model: newConfig.glmModel || DEFAULTS.glm_model,
      },
      gpt: {
        ...(existing.providers?.gpt || {}),
        api_key: newConfig.gptApiKey || undefined,
        base_url: newConfig.gptBaseUrl || DEFAULTS.gpt_base_url,
        model: newConfig.gptModel || DEFAULTS.gpt_model,
      },
      kimi: {
        ...(existing.providers?.kimi || {}),
        api_key: newConfig.kimiApiKey || undefined,
        base_url: newConfig.kimiBaseUrl || DEFAULTS.kimi_base_url,
        model: newConfig.kimiModel || DEFAULTS.kimi_model,
      },
      qwen: {
        ...(existing.providers?.qwen || {}),
        api_key: newConfig.qwenApiKey || undefined,
        base_url: newConfig.qwenBaseUrl || DEFAULTS.qwen_base_url,
        model: newConfig.qwenModel || DEFAULTS.qwen_model,
      },
      codex: {
        ...(existing.providers?.codex || {}),
        backend: newConfig.codexBackend === 'api' ? 'api' : DEFAULTS.codex_backend,
        subscription_profile: newConfig.codexSubscriptionProfile || DEFAULTS.codex_subscription_profile,
        subscription_profiles: Array.isArray(newConfig.codexSubscriptionProfiles) ? newConfig.codexSubscriptionProfiles : undefined,
        api_key: newConfig.codexApiKey || undefined,
        base_url: newConfig.codexApiBaseUrl || DEFAULTS.codex_api_base_url,
        model: newConfig.codexApiModel || DEFAULTS.codex_api_model,
        provider: DEFAULTS.codex_api_provider,
      },
      packy: {
        ...(existing.providers?.packy || {}),
        session_cookie: newConfig.packySessionCookie || undefined,
      },
    },
  };

  if (!merged.providers.deepseek.api_key) delete merged.providers.deepseek.api_key;
  if (!merged.providers.glm.api_key) delete merged.providers.glm.api_key;
  if (!merged.providers.gpt.api_key) delete merged.providers.gpt.api_key;
  if (!merged.providers.kimi.api_key) delete merged.providers.kimi.api_key;
  if (!merged.providers.qwen.api_key) delete merged.providers.qwen.api_key;
  if (!merged.providers.codex.api_key) delete merged.providers.codex.api_key;
  if (!merged.providers.packy.session_cookie) delete merged.providers.packy.session_cookie;

  return merged;
}

function registerConfigIpc(ipcMain, deps) {
  const {
    attachCodexUsageScope,
    clearCodexJsonlCache,
    clearSessionManagerConfigCache,
    currentCodexUsageScope,
    fetchAndCachePackyAccount,
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
    } catch {}

    const merged = buildConfigJsonUpdate(existing, newConfig);
    saveConfig(merged);
    clearSessionManagerConfigCache();

    if (newConfig.packySessionCookie !== undefined) {
      fetchAndCachePackyAccount().catch(() => {});
    }
    if (newConfig.codexBackend !== undefined || newConfig.codexSubscriptionProfile !== undefined) {
      const scope = currentCodexUsageScope();
      clearCodexJsonlCache();
      sendToRenderer('agent-usage', { codex: attachCodexUsageScope({ usage5h: null, usage7d: null, unavailable: true }, scope) });
      setImmediate(() => scanAgentSessions());
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
