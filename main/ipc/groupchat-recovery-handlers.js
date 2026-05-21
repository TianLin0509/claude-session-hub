'use strict';

function registerGroupchatRecoveryIpc(ipcMain, deps) {
  const {
    getHubDataDir,
    getActiveWatchers,
    groupchat,
    groupChatWatcher,
    logger = console,
    meetingManager,
    sessionManager,
  } = deps;

  ipcMain.handle('groupchat-resend-prompt', async (_e, { meetingId, sid } = {}) => {
    if (!meetingId || !sid) return { ok: false, reason: 'invalid_args' };
    const meeting = meetingManager.getMeeting(meetingId);
    if (!meeting || !meeting.groupChat) return { ok: false, reason: 'group_chat_not_found' };
    const orch = groupchat.getOrchestrator(getHubDataDir(), meetingId);
    const turnNum = orch.state.currentTurn;
    if (!turnNum || orch.state.currentMode === 'idle') {
      return { ok: false, reason: 'no_active_turn' };
    }
    const active = orch.getActivePrompt(turnNum);
    if (!active || !active.promptBy || !active.promptBy[sid]) {
      return { ok: false, reason: 'no_active_prompt' };
    }
    const session = sessionManager.getSession(sid);
    const kind = session ? session.kind : 'unknown';
    try {
      return await groupChatWatcher.resendCurrentPrompt({
        sid,
        kind,
        prompt: active.promptBy[sid],
        promptHeader: '',
        timing: { ENTER_RETRY_GAP_MS: 150, POST_ENTER_VERIFY_MS: 500 },
      });
    } catch (err) {
      logger.error('[groupchat-resend-prompt] threw:', err);
      return { ok: false, reason: 'exception', detail: err.message };
    }
  });

  ipcMain.handle('groupchat-skip-participant', async (_e, { sid } = {}) => {
    if (!sid) return { ok: false, reason: 'missing sid' };
    const watcher = getActiveWatchers().get(sid);
    if (!watcher) return { ok: false, reason: 'not_active' };
    watcher.skip();
    return { ok: true };
  });

  ipcMain.handle('groupchat-resend-participant', async () => {
    return {
      ok: false,
      reason: 'unsupported',
      detail: 'group chat uses resend-prompt, manual extract, and skip recovery actions',
    };
  });
}

module.exports = {
  registerGroupchatRecoveryIpc,
};
