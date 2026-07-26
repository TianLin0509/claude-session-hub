'use strict';

const path = require('path');
const { normalizeKey } = require('../../core/workspace-service.js');

function registerWorkspaceIpc(ipcMain, deps) {
  const {
    dialog,
    meetingManager,
    sendToRenderer,
    sessionManager,
    shell,
    workspaceService,
  } = deps;

  function activePaths() {
    const sessionPaths = sessionManager.getAllSessions()
      .filter(session => session && session.cwd)
      .map(session => session.cwd);
    const meetingPaths = meetingManager && typeof meetingManager.getAllMeetings === 'function'
      ? meetingManager.getAllMeetings().map(meeting => meeting && meeting.workspace).filter(Boolean)
      : [];
    return [...sessionPaths, ...meetingPaths];
  }

  ipcMain.handle('workspace:list', () => workspaceService.listWorkspaces(activePaths()));

  ipcMain.handle('workspace:create-scratch', (_event, opts = {}) => {
    const workspace = workspaceService.createScratchWorkspace({ ...opts, select: false });
    sendToRenderer('workspace-updated', { workspace });
    return workspace;
  });

  ipcMain.handle('workspace:select', (_event, cwd) => {
    const workspace = workspaceService.touchWorkspace(cwd, { select: false });
    sendToRenderer('workspace-updated', { workspace });
    return workspace;
  });

  ipcMain.handle('workspace:pick', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择 AI Hub workspace',
      defaultPath: workspaceService.getWorkspaceRoot(),
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '使用此文件夹',
    });
    if (!result || result.canceled || !result.filePaths || !result.filePaths[0]) return null;
    const workspace = workspaceService.touchWorkspace(result.filePaths[0], { select: false });
    sendToRenderer('workspace-updated', { workspace });
    return workspace;
  });

  ipcMain.handle('workspace:rename-label', (_event, args = {}) => {
    const workspace = workspaceService.renameLabel(args.path, args.label);
    sendToRenderer('workspace-updated', { workspace });
    return workspace;
  });

  ipcMain.handle('workspace:reveal', async (_event, cwd) => {
    const target = path.resolve(String(cwd || ''));
    const known = workspaceService.listWorkspaces(activePaths()).items
      .some(item => normalizeKey(item.path) === normalizeKey(target));
    if (!known) return { ok: false, error: 'unknown-workspace' };
    const error = await shell.openPath(target);
    return error ? { ok: false, error } : { ok: true };
  });
}

module.exports = { registerWorkspaceIpc };
