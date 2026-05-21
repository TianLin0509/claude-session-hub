'use strict';

const fs = require('fs');
const path = require('path');
const { shell } = require('electron');

const READ_FILE_EXTS = new Set([
  '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl',
  '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp', '.cs',
  '.txt', '.log', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.sh', '.bat', '.ps1', '.xml', '.sql', '.r', '.rb', '.php',
  '.swift', '.kt', '.lua', '.zig', '.asm', '.css', '.scss', '.less',
]);

function registerPathIpc(ipcMain) {
  ipcMain.handle('open-path', async (_e, filePath) => {
    if (typeof filePath !== 'string' || !filePath.trim()) return 'empty path';
    try {
      return await shell.openPath(filePath);
    } catch (e) {
      return String(e && e.message || e);
    }
  });

  ipcMain.handle('read-file', async (_e, filePath) => {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return { error: 'invalid path' };
    const ext = path.extname(filePath).toLowerCase();
    if (!READ_FILE_EXTS.has(ext)) return { error: 'unsupported extension' };
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.size > 5 * 1024 * 1024) return { error: 'file too large (>5MB)' };
      const content = await fs.promises.readFile(filePath, 'utf-8');
      return { content };
    } catch (e) {
      return { error: String(e && e.message || e) };
    }
  });

  ipcMain.handle('open-external-url', async (_e, url) => {
    if (!url || !/^https?:\/\//i.test(url)) return { success: false };
    await shell.openExternal(url);
    return { success: true };
  });
}

module.exports = {
  READ_FILE_EXTS,
  registerPathIpc,
};
