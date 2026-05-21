'use strict';

const defaultSessionArchive = require('../../core/session-archive.js');

function registerArchiveIpc(ipcMain, deps = {}) {
  const sessionArchive = deps.sessionArchive || defaultSessionArchive;
  const logger = deps.logger || console;

  ipcMain.handle('list-past-sessions', async (_e, { limit = 50 } = {}) => {
    try {
      return await sessionArchive.listRecent(limit);
    } catch (e) {
      logger.warn('[群聊] list-past-sessions failed:', e.message);
      return [];
    }
  });

  ipcMain.handle('search-past-sessions', async (_e, { query, limit = 50 } = {}) => {
    try {
      return await sessionArchive.searchAcross(query, { limit });
    } catch (e) {
      logger.warn('[群聊] search-past-sessions failed:', e.message);
      return { hits: [], truncated: false };
    }
  });
}

module.exports = {
  registerArchiveIpc,
};
