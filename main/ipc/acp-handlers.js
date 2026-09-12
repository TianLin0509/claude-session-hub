'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { getConfigPath, getConfig, clearConfigCache } = require('../../core/hub-config');
const { ACP_KINDS, PLAN_BASE_URL } = require('../../core/acp-profiles');
function publicSettings(config) {
  const value = config.acp || {};
  return { nodePath: value.nodePath || '', baseURL: value.baseURL || PLAN_BASE_URL,
    apiKeySet: !!value.apiKey, providers: value.providers || {} };
}
function registerAcpIpc(ipcMain) {
  ipcMain.handle('acp:settings:get', () => publicSettings(getConfig()));
  ipcMain.handle('acp:settings:save', (_event, request = {}) => {
    try {
      const configPath = getConfigPath();
      let config = {};
      try { config = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '')); }
      catch (error) { if (error.code !== 'ENOENT') throw new Error('现有配置无法读取，未覆盖'); }
      const previous = config.acp || {};
      const providers = {};
      for (const kind of ACP_KINDS) {
        const value = request.providers?.[kind] || previous.providers?.[kind] || {};
        providers[kind] = {};
        for (const key of ['entryPath','backendPath','bridgePath','model','mcpConfigPath']) {
          if (value[key] != null && typeof value[key] !== 'string') throw new Error('配置字段必须是文字');
          providers[kind][key] = (value[key] || '').trim();
        }
      }
      if (request.apiKey != null && typeof request.apiKey !== 'string') throw new Error('Key 格式无效');
      config.acp = { nodePath: String(request.nodePath || previous.nodePath || '').trim(),
        baseURL: PLAN_BASE_URL, providers, apiKey: request.apiKey?.trim() || previous.apiKey || '' };
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      const temp = configPath + '.' + randomUUID() + '.tmp';
      fs.writeFileSync(temp, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temp, configPath);
      clearConfigCache();
      return { ok: true, settings: publicSettings(config) };
    } catch (error) { return { ok: false, message: error.message }; }
  });
}
module.exports = { registerAcpIpc, publicSettings };
