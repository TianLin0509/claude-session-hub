'use strict';

function registerUsageIpc(ipcMain, deps) {
  const {
    fetchAndCachePackyAccount,
    loadUsageCacheForCurrentConfig,
  } = deps;

  ipcMain.handle('get-usage-cache', () => loadUsageCacheForCurrentConfig());

  ipcMain.handle('refresh-packy-account', async () => {
    return await fetchAndCachePackyAccount();
  });
}

module.exports = {
  registerUsageIpc,
};
