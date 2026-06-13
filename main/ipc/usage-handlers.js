'use strict';

function registerUsageIpc(ipcMain, deps) {
  const {
    clearCodexJsonlCache,
    fetchAndCachePackyAccount,
    loadUsageCacheForCurrentConfig,
    refreshClaudeAccountUsage,
    scanAgentSessions,
  } = deps;

  ipcMain.handle('get-usage-cache', () => loadUsageCacheForCurrentConfig());

  ipcMain.handle('refresh-usage-now', async () => {
    const packyPromise = typeof fetchAndCachePackyAccount === 'function'
      ? Promise.resolve().then(() => fetchAndCachePackyAccount()).catch((err) => ({
          enabled: true,
          error: err && err.message ? err.message : 'PackyAPI 账户刷新失败',
        }))
      : Promise.resolve(null);
    if (typeof refreshClaudeAccountUsage === 'function') refreshClaudeAccountUsage();
    if (typeof clearCodexJsonlCache === 'function') clearCodexJsonlCache();
    const agentData = typeof scanAgentSessions === 'function'
      ? (scanAgentSessions({ force: true }) || {})
      : {};
    const packyAccount = await packyPromise;
    return {
      cache: loadUsageCacheForCurrentConfig(),
      agentData,
      packyAccount,
      refreshedAt: Date.now(),
    };
  });

  ipcMain.handle('refresh-packy-account', async () => {
    return await fetchAndCachePackyAccount();
  });
}

module.exports = {
  registerUsageIpc,
};
