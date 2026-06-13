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
    meridianUrl: config.meridianUrl,
    meridianToken: config.meridianToken ? '***' + config.meridianToken.slice(-4) : '',
    meridianTokenSet: !!config.meridianToken,
    meridianEnabled: !!config.meridianEnabled,
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
    meridianUrl: config.meridianUrl || '',
    meridianToken: config.meridianToken || '',
    meridianEnabled: !!config.meridianEnabled,
    uiToolFoldThreshold: Number.isFinite(config.uiToolFoldThreshold) ? config.uiToolFoldThreshold : 15,
    uiCodeFoldThreshold: Number.isFinite(config.uiCodeFoldThreshold) ? config.uiCodeFoldThreshold : 30,
  };
}

function buildConfigJsonUpdate(existing, newConfig) {
  // 2026-06-14 修复部分提交数据丢失：config-modal 全量提交始终带全部字段，而 Meridian
  //   弹窗(theme-controller)只发 3 个 meridian 字段。旧逻辑对每个 provider 字段无条件
  //   `newConfig.X || default/undefined`，使部分提交把未提交的 deepseek/glm/gpt/kimi/qwen
  //   api_key、各 base_url/model、proxy、packy cookie 全部重置/抹掉。
  //   修法：仅当 newConfig 显式带了该字段(hasOwnProperty)才用其值，否则保留 existing。
  //   全量提交所有 key 都在 → 行为与旧版完全一致(零回归)；部分提交其余字段原样保留。
  //   codex/meridian 块与 meridian relay 联动且为在制功能，本次不动。
  const H = (k) => Object.prototype.hasOwnProperty.call(newConfig, k);
  const merged = {
    ...existing,
    proxy: { http: H('proxy') ? (newConfig.proxy || DEFAULTS.proxy) : (existing.proxy?.http || DEFAULTS.proxy) },
    providers: {
      ...(existing.providers || {}),
      deepseek: {
        ...(existing.providers?.deepseek || {}),
        api_key: H('deepseekApiKey') ? (newConfig.deepseekApiKey || undefined) : existing.providers?.deepseek?.api_key,
      },
      glm: {
        ...(existing.providers?.glm || {}),
        api_key: H('glmApiKey') ? (newConfig.glmApiKey || undefined) : existing.providers?.glm?.api_key,
        base_url: H('glmBaseUrl') ? (newConfig.glmBaseUrl || DEFAULTS.glm_base_url) : (existing.providers?.glm?.base_url || DEFAULTS.glm_base_url),
        model: H('glmModel') ? (newConfig.glmModel || DEFAULTS.glm_model) : (existing.providers?.glm?.model || DEFAULTS.glm_model),
      },
      gpt: {
        ...(existing.providers?.gpt || {}),
        api_key: H('gptApiKey') ? (newConfig.gptApiKey || undefined) : existing.providers?.gpt?.api_key,
        base_url: H('gptBaseUrl') ? (newConfig.gptBaseUrl || DEFAULTS.gpt_base_url) : (existing.providers?.gpt?.base_url || DEFAULTS.gpt_base_url),
        model: H('gptModel') ? (newConfig.gptModel || DEFAULTS.gpt_model) : (existing.providers?.gpt?.model || DEFAULTS.gpt_model),
      },
      kimi: {
        ...(existing.providers?.kimi || {}),
        api_key: H('kimiApiKey') ? (newConfig.kimiApiKey || undefined) : existing.providers?.kimi?.api_key,
        base_url: H('kimiBaseUrl') ? (newConfig.kimiBaseUrl || DEFAULTS.kimi_base_url) : (existing.providers?.kimi?.base_url || DEFAULTS.kimi_base_url),
        model: H('kimiModel') ? (newConfig.kimiModel || DEFAULTS.kimi_model) : (existing.providers?.kimi?.model || DEFAULTS.kimi_model),
      },
      qwen: {
        ...(existing.providers?.qwen || {}),
        api_key: H('qwenApiKey') ? (newConfig.qwenApiKey || undefined) : existing.providers?.qwen?.api_key,
        base_url: H('qwenBaseUrl') ? (newConfig.qwenBaseUrl || DEFAULTS.qwen_base_url) : (existing.providers?.qwen?.base_url || DEFAULTS.qwen_base_url),
        model: H('qwenModel') ? (newConfig.qwenModel || DEFAULTS.qwen_model) : (existing.providers?.qwen?.model || DEFAULTS.qwen_model),
      },
      codex: (() => {
        // Meridian 启用时联动 codex 走团队 relay（OpenAI 兼容 /codex/v1）
        const meridianActive = !!newConfig.meridianEnabled && newConfig.meridianUrl && newConfig.meridianToken;
        const baseCodex = {
          ...(existing.providers?.codex || {}),
          backend: newConfig.codexBackend === 'api' ? 'api' : DEFAULTS.codex_backend,
          subscription_profile: newConfig.codexSubscriptionProfile || DEFAULTS.codex_subscription_profile,
          subscription_profiles: Array.isArray(newConfig.codexSubscriptionProfiles) ? newConfig.codexSubscriptionProfiles : undefined,
          api_key: newConfig.codexApiKey || undefined,
          base_url: newConfig.codexApiBaseUrl || DEFAULTS.codex_api_base_url,
          model: newConfig.codexApiModel || DEFAULTS.codex_api_model,
          provider: DEFAULTS.codex_api_provider,
        };
        if (meridianActive) {
          baseCodex.backend = 'api';
          baseCodex.base_url = `${newConfig.meridianUrl.replace(/\/+$/, '')}/codex/v1`;
          baseCodex.api_key = newConfig.meridianToken;
          baseCodex.model = 'gpt-5.5';
          baseCodex.provider = 'meridian';
        }
        return baseCodex;
      })(),
      packy: {
        ...(existing.providers?.packy || {}),
        session_cookie: H('packySessionCookie') ? (newConfig.packySessionCookie || undefined) : existing.providers?.packy?.session_cookie,
      },
      meridian: {
        ...(existing.providers?.meridian || {}),
        url: newConfig.meridianUrl || undefined,
        token: newConfig.meridianToken || undefined,
        enabled: newConfig.meridianEnabled === undefined ? (existing.providers?.meridian?.enabled || false) : !!newConfig.meridianEnabled,
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
  if (!merged.providers.meridian.url && !merged.providers.meridian.token) delete merged.providers.meridian;

  return merged;
}

/**
 * Test Meridian VPS proxy health and auth in two steps:
 *   1. GET /healthz - URL reachability
 *   2. POST /v1/messages with 5-token micro-request - token auth + end-to-end
 */
async function testMeridianHealth(url, token) {
  const result = { healthOk: false, authOk: false, latencyMs: 0, model: '', errorMessage: '' };
  if (!url || !token) {
    result.errorMessage = 'URL 和 Token 都必填';
    return result;
  }
  const base = String(url).trim().replace(/\/+$/, '');

  try {
    const r1 = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(8000) });
    result.healthOk = r1.ok;
    if (!r1.ok) {
      result.errorMessage = `健康检查失败：HTTP ${r1.status}`;
      return result;
    }
  } catch (e) {
    result.errorMessage = `URL 不可达：${e.message || e}`;
    return result;
  }

  try {
    const t0 = Date.now();
    const r2 = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': token,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 5,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: AbortSignal.timeout(30000),
    });
    result.latencyMs = Date.now() - t0;
    if (r2.ok) {
      const data = await r2.json();
      result.authOk = true;
      result.model = data.model || '';
    } else if (r2.status === 401) {
      result.errorMessage = 'Token 鉴权失败（401）';
    } else {
      const text = await r2.text().catch(() => '');
      result.errorMessage = `请求失败 HTTP ${r2.status}：${text.slice(0, 200)}`;
    }
  } catch (e) {
    result.errorMessage = `请求失败：${e.message || e}`;
  }

  return result;
}

/**
 * Fetch Meridian telemetry ring buffer (HTTP API, not SQLite) and
 * aggregate the last-24h token usage for the Hub UI progress bar.
 */
async function getMeridianUsage(url, token) {
  if (!url || !token) return { ok: false, errorMessage: 'URL 和 Token 都必填' };
  const base = String(url).trim().replace(/\/+$/, '');
  try {
    const r = await fetch(`${base}/telemetry/requests`, {
      headers: { 'x-api-key': token },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return { ok: false, errorMessage: `HTTP ${r.status}` };
    const rows = await r.json();
    if (!Array.isArray(rows)) return { ok: false, errorMessage: 'response shape unexpected' };
    const cutoff = Date.now() - 24 * 3600 * 1000;
    const today = rows.filter(row => (row.timestamp || 0) > cutoff);
    const totals = today.reduce((s, row) => ({
      requests: s.requests + 1,
      input: s.input + (row.inputTokens || 0),
      output: s.output + (row.outputTokens || 0),
      cacheRead: s.cacheRead + (row.cacheReadInputTokens || 0),
    }), { requests: 0, input: 0, output: 0, cacheRead: 0 });
    return {
      ok: true,
      daily: totals,
      limits: { input: 50_000_000, output: 5_000_000 },
    };
  } catch (e) {
    return { ok: false, errorMessage: e.message || String(e) };
  }
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

  ipcMain.handle('test-meridian-health', async (_e, { url, token } = {}) => {
    return await testMeridianHealth(url, token);
  });

  ipcMain.handle('get-meridian-usage', async (_e, { url, token } = {}) => {
    return await getMeridianUsage(url, token);
  });
}

module.exports = {
  buildConfigJsonUpdate,
  registerConfigIpc,
  toEditableConfig,
  toMaskedConfig,
};
