'use strict';

function snapshotDebug(getSnapshot) {
  try {
    return { ok: true, snapshot: getSnapshot() };
  } catch (err) {
    return { ok: false, reason: 'snapshot_failed', detail: err.message };
  }
}

function registerGroupchatQueryIpc(ipcMain, deps) {
  const {
    getHubDataDir,
    groupchat,
    transcriptTap,
  } = deps;

  ipcMain.handle('groupchat:get-state', (_e, { meetingId }) => {
    const orch = groupchat.getOrchestrator(getHubDataDir(), meetingId);
    return orch.getState();
  });

  ipcMain.handle('groupchat:search-raw', (_e, { meetingId, query, limit } = {}) => {
    const orch = groupchat.getOrchestrator(getHubDataDir(), meetingId);
    return orch.searchRaw(query, limit);
  });

  ipcMain.handle('groupchat:read-raw', (_e, { meetingId, messageId } = {}) => {
    const orch = groupchat.getOrchestrator(getHubDataDir(), meetingId);
    return orch.readRaw(messageId);
  });

  ipcMain.handle('groupchat-codex-debug-state', async () =>
    snapshotDebug(() => transcriptTap.getCodexDebugSnapshot())
  );

  ipcMain.handle('groupchat-gemini-debug-state', async () =>
    snapshotDebug(() => transcriptTap.getGeminiDebugSnapshot())
  );

  // B1（2026-07-29）：与 codex/gemini 镜像。排查"Claude 卡片恒思考中"时要能看到
  //   tail 到底建起来没有、由哪条通道建的（register / prompt_hook / cwd_discovery /
  //   stop_hook），以及当前累积了几个 block。
  ipcMain.handle('groupchat-claude-debug-state', async () =>
    snapshotDebug(() => transcriptTap.getClaudeDebugSnapshot())
  );
}

module.exports = {
  registerGroupchatQueryIpc,
  snapshotDebug,
};
