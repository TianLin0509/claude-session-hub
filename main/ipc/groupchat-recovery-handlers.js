'use strict';

function registerGroupchatRecoveryIpc(ipcMain, deps) {
  const {
    getHubDataDir,
    getActiveWatchers,
    groupchat,
    groupChatWatcher,
    logger = console,
    meetingManager,
    sendToRenderer,
    sessionManager,
    transcriptTap,
  } = deps;

  ipcMain.handle('groupchat-manual-extract', async (_e, { meetingId, sid, sincePromptTs, turnNum } = {}) => {
    if (!sid) return { ok: false, reason: 'missing_sid' };

    let extracted = null;
    try {
      extracted = await transcriptTap.extractLatestTurn(sid, sincePromptTs || 0);
    } catch (err) {
      return { ok: false, reason: 'extract_failed', detail: err.message };
    }
    const session = sessionManager.getSession(sid);
    const kind = session?.kind || 'unknown';
    if (!extracted || !extracted.text) {
      try {
        const fromPty = groupChatWatcher.extractStreamingText(sid, kind);
        if (fromPty && fromPty.text && fromPty.text.trim().length > 0) {
          extracted = {
            text: fromPty.text,
            source: fromPty.source || 'pty_buffer',
            extractMode: 'pty_buffer_fallback',
          };
        }
      } catch (err) {
        logger.warn('[manual-extract] PTY fallback failed:', err && err.message);
      }
    }
    if (!extracted || !extracted.text) {
      const extractMode = extracted?.extractMode || null;
      let detail;
      if (extractMode === 'no_rollout_bound') {
        detail = `Codex rollout 文件尚未绑定（kind=${kind}）。可能原因：（a）当天目录 ~/.codex/sessions/<今日>/ 还没新文件；（b）codex spawn 时的 cwd 与 rollout session_meta.cwd 不一致；（c）timestamp 超出绑定窗口 [-10s, +5min]。建议：等 5-10s（codex 通常 spawn 后才写 rollout 首行），或点"🔧 进 shell"看真实 PTY 输出确认 codex 是否真的启动了。`;
      } else if (extractMode === 'no_task_complete_yet') {
        detail = `Codex 已绑定 rollout 但 task_complete 事件尚未写入（kind=${kind}）。可能原因：（a）codex 仍在思考；（b）codex 在等 MCP 工具确认弹窗（如 ai-team team_respond），需要进 shell 点"Allow"；（c）codex 多 task 场景含 3s debounce，最后一个 task 完成后才 emit。建议：点"🔧 进 shell"看 codex 当前是否被 confirm 弹窗阻塞。`;
      } else {
        detail = `transcript 中没有可读的 last assistant 内容（kind=${kind}）。可能原因：CLI 还没真正回答 / transcript 路径未绑定 / Stop hook 没触发且 idle-timer 还没到期。建议稍等几秒重试，或点"🔧 进 shell"看真实 PTY 输出。`;
      }
      return {
        ok: false,
        reason: 'no_content',
        extractMode,
        detail,
      };
    }

    const watcher = getActiveWatchers().get(sid);
    if (watcher) {
      watcher.manualExtract(extracted.text);
      return { ok: true, text: extracted.text, source: extracted.source, mode: 'watcher_settle', extractMode: extracted.extractMode || null };
    }

    if (meetingId) {
      try {
        const meeting = meetingManager.getMeeting(meetingId);
        if (meeting) {
          const orch = groupchat.getOrchestrator(getHubDataDir(), meetingId);
          const turns = Array.isArray(orch.state.turns) ? orch.state.turns : [];
          const requestedTurn = Number.isFinite(Number(turnNum)) ? Number(turnNum) : null;
          const lastTurn = requestedTurn
            ? turns.find(t => t && t.n === requestedTurn)
            : turns[turns.length - 1];
          if (lastTurn) {
            const patched = orch.patchTurnResult(lastTurn.n, sid, {
              text: extracted.text,
              status: 'manual_extracted',
            });
            if (patched) {
              sendToRenderer('groupchat-turn-patched', {
                meetingId,
                turnNum: lastTurn.n,
                sid,
                charCount: (extracted.text || '').length,
              });
              return { ok: true, text: extracted.text, source: extracted.source, mode: 'patch_groupchat_turn', extractMode: extracted.extractMode || null };
            }
          }
        }
      } catch (err) {
        logger.warn('[manual-extract] patch lastTurn failed:', err.message);
      }
    }

    return { ok: true, text: extracted.text, source: extracted.source, mode: 'text_only', extractMode: extracted.extractMode || null };
  });

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
