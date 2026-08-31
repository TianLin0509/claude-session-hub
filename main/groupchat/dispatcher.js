'use strict';

const groupChatWatcher = require('../../core/group-chat-watcher.js');
const { createTurnCompletionWatcher } = require('../../core/turn-completion-watcher.js');
const pasteTrappedDetector = require('../../core/paste-trapped-detector.js');
const { createAuthBannerMonitor } = require('../../core/host-shell-detector.js');
const { appendHeroPrompt, normalizeHeroAssignments } = require('../../core/hero-prompts.js');
const { isClaudeFamily } = require('../../core/ai-kinds.js');

const RT_TRANSITIONAL_HARD_TIMEOUT_MS = 5 * 60 * 1000;
const PASTE_TRAPPED_TICK_MS = 3000;
const PASTE_TRAPPED_HARD_TIMEOUT_MS = 60_000;
const PASTE_TRAPPED_CODEX_ENTER_RETRIES = 3;
const HOST_SHELL_HEARTBEAT_MS = 10 * 1000;
const HOST_SHELL_CONSECUTIVE_HITS = 2;
const CODEX_AUTO_EXTRACT_DELAY_MS = 3 * 1000;
const CODEX_AUTO_EXTRACT_INTERVAL_MS = 2 * 1000;
const CODEX_PROMPT_SUBMIT_VERIFY_MS = 25 * 1000;
const CODEX_TRANSCRIPT_BIND_GRACE_MS = 90 * 1000;
const CODEX_PROMPT_SUBMIT_RETRY_MAX = 1;
const CODEX_PROMPT_SUBMIT_WAIT_MAX_MS = 16 * 60 * 1000;
const CODEX_PROMPT_SUBMIT_WAIT_EXTEND_MS = 60 * 1000;
const HARD_TIMEOUT_ACTIVE_GRACE_MS = 150 * 1000;
const HARD_TIMEOUT_ACTIVE_EXTEND_MS = 180 * 1000;
const HARD_TIMEOUT_ACTIVE_MAX_EXTRA_MS = 8 * 60 * 1000;
// 中断键：与用户在单 session 终端里按 ESC 完全同一条路径（xterm onData → 'terminal-input'
//   IPC → sessionManager.writeToSession）。claude / codex / gemini 三家 TUI 都用 ESC 取消
//   当前回答；不用 Ctrl+C（codex 连按两次会直接退出 CLI，属于误伤）。
const INTERRUPT_KEY = '\x1b';
const INTERRUPT_KEY_REPEAT = 2;      // 部分 TUI 首个 ESC 只是收起 UI 面板，补一次更稳
const INTERRUPT_KEY_GAP_MS = 120;
// AUTH_FAILURE_RE 已移到 core/host-shell-detector.js 的 createAuthBannerMonitor：
//   旧实现对整个 ring buffer 裸测，AI 回答里提到 "not logged in" 就误杀（2026-07-12）。
const AUTH_DETECT_WINDOW_MS = 120 * 1000;

function parseGroupTargets(userInput, members, participants) {
  const selected = Array.isArray(participants) ? participants : [];
  const selectedMembers = members.filter(m => selected.includes(m.index));
  const mentionRe = /@([A-Za-z0-9_\-\u4e00-\u9fff]+)/g;
  const mentioned = [];
  let m;
  while ((m = mentionRe.exec(userInput || '')) !== null) {
    const token = String(m[1] || '').toLowerCase();
    if (token === 'all' || token === '全部' || token === '所有人') {
      return { targets: members, mentions: ['all'] };
    }
    const hits = members.filter(mem => {
      const keys = [mem.memberId, mem.displayName, mem.kind, ...(mem.aliases || [])]
        .filter(Boolean).map(x => String(x).toLowerCase());
      return keys.includes(token);
    });
    const hit = hits.length === 1 ? hits[0] : null;
    if (hit && !mentioned.some(x => x.sid === hit.sid)) mentioned.push(hit);
  }
  if (mentioned.length > 0) return { targets: mentioned, mentions: mentioned.map(x => x.memberId) };
  return { targets: selectedMembers, mentions: [] };
}

function createGroupChatDispatcher(deps) {
  const {
    cliReadyDetector,
    getHubDataDir,
    groupchat,
    isCodexBaseKind,
    kindLabels = {},
    logger = console,
    maybeAutoTitleMeetingFromPrompt,
    meetingManager,
    onGroupChatComplete,
    sendToRenderer,
    sessionManager,
    transcriptTap,
  } = deps;

  groupChatWatcher.init({
    sessionManager,
    cliReadyDetector,
    transcriptTap,
    enableSendDiagnostics: process.env.HUB_GROUPCHAT_SEND_DIAGNOSTICS === '1',
  });

  const groupChatTurnQueue = new Map();
  const patchListenersBySid = new Map();
  const activeWatchers = new Map();
  const pasteTrappedMonitors = new Map();
  // 抢占式连发（2026-06-24 道雪）：每个 meeting 的派发序号，单调递增。runGroupChatTurn
  //   完成时比对，若已有更新的轮号 → 自己是被抢占的旧轮，给前端的 turn-complete 带 superseded。
  const meetingDispatchSeq = new Map();
  // 运行中中断（2026-07-29 道雪）：每个 meeting 的中断代际，单调递增。
  //   用于关掉「用户在 sendToPty 还没跑完时就点了停止」的竞态窗口——此刻 activeWatchers
  //   里还没有 watcher 可以结算，如果不记代际，这一轮会在中断之后才开始等待，卡片
  //   永久停在"思考中"（正是 ae64983 修过的那类卡死）。
  const meetingInterruptSeq = new Map();
  // 每个 meeting 当前在飞的真实用户轮数量。中断时用它区分「真的没人在跑」和
  //   「有轮正卡在 sendToPty、watcher 还没建」——后者不能提前把 orchestrator 收回
  //   idle（那一轮马上会自己以 interrupted 收敛），否则 UI 会先闪一下待命再跳回。
  const meetingInFlightTurns = new Map();

  function warn(...args) {
    if (logger && typeof logger.warn === 'function') logger.warn(...args);
  }

  function log(...args) {
    if (logger && typeof logger.log === 'function') logger.log(...args);
  }

  function notifyGroupChatComplete(event, meeting) {
    if (typeof onGroupChatComplete !== 'function') return;
    Promise.resolve(onGroupChatComplete(event, meeting)).catch(error => {
      warn('[group-chat] completion notification failed:', error && error.message);
    });
  }

  function registerPatchListener(sid, watcher) {
    if (!patchListenersBySid.has(sid)) patchListenersBySid.set(sid, new Set());
    patchListenersBySid.get(sid).add(watcher);
  }

  function cancelPatchListenersForSid(sid) {
    const set = patchListenersBySid.get(sid);
    if (!set) return;
    for (const w of set) {
      try { w.cancelPatch?.(); } catch (e) { warn('[patch] cancelPatch threw:', e && e.message); }
    }
    set.clear();
  }

  function unregisterPatchListener(sid, watcher) {
    const set = patchListenersBySid.get(sid);
    if (set) set.delete(watcher);
  }

  function stopPasteTrappedMonitor(sid) {
    const entry = pasteTrappedMonitors.get(sid);
    const intervalId = entry && typeof entry === 'object' ? entry.intervalId : entry;
    if (intervalId) {
      clearInterval(intervalId);
      pasteTrappedMonitors.delete(sid);
    }
    try { pasteTrappedDetector.stop(sid); }
    catch (error) { warn('[paste-trapped] stop failed:', error && error.message); }
  }

  function promptHeaderForRetry(prompt) {
    const line = String(prompt || '').split(/\r?\n/).find(x => String(x || '').trim());
    return line ? line.slice(0, 160) : '';
  }

  function runtimeKindForSession(sid, fallbackKind) {
    const session = sessionManager.getSession(sid);
    return (session && session.transcriptKind) || fallbackKind;
  }

  function hasBoundCodexTranscript(session) {
    return !!(session && (session.transcriptPath || session.codexSid));
  }

  function startPasteTrappedMonitor(sid, kind, meetingId) {
    if (pasteTrappedMonitors.has(sid)) return;
    pasteTrappedDetector.start(sid, Date.now());
    const runtimeKind = runtimeKindForSession(sid, kind);
    const startedAt = Date.now();
    const monitor = { intervalId: null, enterRetries: 0 };
    const intervalId = setInterval(() => {
      try {
        if (Date.now() - startedAt >= PASTE_TRAPPED_HARD_TIMEOUT_MS) {
          stopPasteTrappedMonitor(sid);
          return;
        }
        const buf = sessionManager.getSessionBuffer(sid) || '';
        // The detector needs a monotonic byte counter.  Passing the legacy
        // last-output timestamp made every harmless Codex cursor repaint look
        // like a large streaming delta, so a visibly stable `[Pasted …]`
        // marker could remain "unknown" forever.
        const outputBytes = typeof sessionManager.getGroupChatOutputBytes === 'function'
          ? sessionManager.getGroupChatOutputBytes(sid)
          : sessionManager.getGroupChatLastActivity(sid);
        const r = pasteTrappedDetector.tick(sid, buf, outputBytes);
        if (r === 'stuck') {
          if (isCodexBaseKind(runtimeKind) && monitor.enterRetries < PASTE_TRAPPED_CODEX_ENTER_RETRIES) {
            monitor.enterRetries += 1;
            warn(`[paste-trapped] codex(${sid.slice(0,8)}) paste marker stable; sending retry Enter #${monitor.enterRetries}`);
            try {
              groupChatWatcher._private.writeSubmitSignal(sessionManager, sid, runtimeKind, monitor.enterRetries);
              const meeting = meetingManager.getMeeting(meetingId);
              if (meeting && meeting.groupChat) {
                const orch = groupchat.getOrchestrator(getHubDataDir(), meetingId);
                const turnNum = orch && orch.state && orch.state.currentTurn;
                if (turnNum) orch.setSendStatus(turnNum, sid, 'enter_retry');
              }
            } catch (e) {
              warn('[paste-trapped] codex retry Enter threw:', e && e.message);
            }
            pasteTrappedDetector.start(sid, Date.now());
            return;
          }
          warn(`[paste-trapped] confirmed stuck for ${kind}(${sid.slice(0,8)}) - pushing groupchat-send-stuck IPC`);
          try {
            const meeting = meetingManager.getMeeting(meetingId);
            if (meeting && meeting.groupChat) {
              const orch = groupchat.getOrchestrator(getHubDataDir(), meetingId);
              const turnNum = orch && orch.state && orch.state.currentTurn;
              if (turnNum) orch.setSendStatus(turnNum, sid, 'stuck');
            }
          } catch (e) { warn('[paste-trapped] setSendStatus threw:', e && e.message); }
          sendToRenderer('groupchat-send-stuck', { meetingId, sid, kind });
          stopPasteTrappedMonitor(sid);
        } else if (r === 'ok') {
          stopPasteTrappedMonitor(sid);
        }
      } catch (e) {
        warn('[paste-trapped] tick threw:', e && e.message);
      }
    }, PASTE_TRAPPED_TICK_MS);
    intervalId.unref?.();
    monitor.intervalId = intervalId;
    pasteTrappedMonitors.set(sid, monitor);
  }

  function waitTurnComplete(sid, label, opts = {}) {
    const { meetingId, mode, turnNum, onPartial } = opts;
    const silent = opts.silent === true;
    const disableHardTimeout = opts.disableHardTimeout === true;
    const hardTimeoutMs = Number(opts.hardTimeoutMs) > 0 ? Number(opts.hardTimeoutMs) : RT_TRANSITIONAL_HARD_TIMEOUT_MS;
    const allowActiveExtend = opts.allowActiveExtend !== false;
    const startTs = Date.now();
    const waitSession = sessionManager.getSession(sid);
    const waitKind = waitSession?.transcriptKind || opts.kind || waitSession?.kind || 'unknown';
    const promptSubmitSinceTs = Math.max(0, Number(opts.promptSubmitSinceTs) || (startTs - 1000));
    let codexPromptSubmitted = false;
    let codexPromptSubmittedAt = 0;
    try { transcriptTap.clearLastTokens(sid); }
    catch (error) { warn('[group-chat] clearLastTokens failed:', error && error.message); }

    const watcher = createTurnCompletionWatcher({
      transcriptTap,
      hubSessionId: sid,
      label,
      onSoftAlert: (level) => {
        try {
          if (!silent) {
            sendToRenderer('groupchat-soft-alert', {
              meetingId, turnNum, mode, sid, label, level,
            });
          }
        } catch (error) {
          warn('[group-chat] soft alert delivery failed:', error && error.message);
        }
      },
      onTurnPatched: ({ sid: patchedSid, text, status }) => {
        try {
          if (silent) return;
          const orch = groupchat.getOrchestrator(getHubDataDir(), meetingId);
          const turn = orch.state.turns.find(t => t.n === turnNum);
          const currentStatus = turn?.byStatus?.[patchedSid];
          const finalStatus = (currentStatus === 'manual_extracted') ? 'manual_extracted' : status;
          orch.patchTurnResult(turnNum, patchedSid, { text, status: finalStatus });
          sendToRenderer('groupchat-turn-patched', {
            meetingId, turnNum, sid: patchedSid, charCount: (text || '').length,
          });
        } catch (e) {
          warn('[patch] onTurnPatched threw:', e && e.message);
        }
      },
    });
    activeWatchers.set(sid, watcher);
    registerPatchListener(sid, watcher);

    let streamTimer = null;
    if (typeof onPartial === 'function') {
      streamTimer = setInterval(() => {
        if (watcher.isSettled()) { clearInterval(streamTimer); streamTimer = null; return; }
        const session = sessionManager.getSession(sid);
        const kind = session?.transcriptKind || session?.kind || 'unknown';
        const result = groupChatWatcher.extractStreamingText(sid, kind);
        const hasContent = result.text.length > 10 || result.blocks.length > 0;
        const buf = sessionManager.getSessionBuffer(sid) || '';
        const cleanBufLen = groupChatWatcher.cleanBufLen(buf);
        if (hasContent) {
          try {
            onPartial({
              sid, label, status: 'streaming',
              blocks: result.blocks, source: result.source, text: result.text,
              cleanBufLen,
            });
          } catch (error) {
            warn('[group-chat] streaming partial delivery failed:', error && error.message);
          }
        } else {
          try {
            onPartial({
              sid, label, status: 'streaming',
              blocks: [], source: 'placeholder', text: '',
              cleanBufLen,
            });
          } catch (error) {
            warn('[group-chat] placeholder partial delivery failed:', error && error.message);
          }
        }
      }, 1500);
    }

    let hardTimeout = null;
    if (!disableHardTimeout) {
      const maxHardTimeoutMs = hardTimeoutMs + HARD_TIMEOUT_ACTIVE_MAX_EXTRA_MS;
      const armHardTimeout = (delayMs) => {
        hardTimeout = setTimeout(async () => {
          if (watcher.isSettled()) return;
          if (isCodexBaseKind(waitKind) && opts.prompt) {
            const currentWaitSession = sessionManager.getSession(sid) || waitSession;
            if (hasBoundCodexTranscript(currentWaitSession)) {
              if (!codexPromptSubmitted && transcriptTap && typeof transcriptTap.hasCodexUserMessageSince === 'function') {
                try {
                  codexPromptSubmitted = await transcriptTap.hasCodexUserMessageSince(sid, promptSubmitSinceTs);
                  if (codexPromptSubmitted && !codexPromptSubmittedAt) codexPromptSubmittedAt = Date.now();
                } catch (e) {
                  warn('[group-chat] codex hard-timeout submit probe failed:', e && e.message);
                }
              }
              if (!codexPromptSubmitted) {
                const submitWaitMs = Date.now() - startTs;
                if (submitWaitMs < CODEX_PROMPT_SUBMIT_WAIT_MAX_MS) {
                  const nextDelay = Math.min(CODEX_PROMPT_SUBMIT_WAIT_EXTEND_MS, CODEX_PROMPT_SUBMIT_WAIT_MAX_MS - submitWaitMs);
                  warn(`[group-chat] hard timeout reached for ${label}(${sid.slice(0, 8)}) but Codex prompt submission is not observed yet; extending submit wait ${Math.round(nextDelay / 1000)}s`);
                  armHardTimeout(nextDelay);
                  return;
                }
              } else if (codexPromptSubmittedAt > startTs) {
                const elapsedAfterSubmit = Date.now() - codexPromptSubmittedAt;
                if (elapsedAfterSubmit < hardTimeoutMs) {
                  const nextDelay = Math.min(hardTimeoutMs - elapsedAfterSubmit, HARD_TIMEOUT_ACTIVE_EXTEND_MS);
                  warn(`[group-chat] hard timeout reached for ${label}(${sid.slice(0, 8)}) but Codex prompt was submitted only ${Math.round(elapsedAfterSubmit / 1000)}s ago; extending answer wait ${Math.round(nextDelay / 1000)}s`);
                  armHardTimeout(nextDelay);
                  return;
                }
              }
            } else {
              const submitWaitMs = Date.now() - startTs;
              if (submitWaitMs < CODEX_PROMPT_SUBMIT_WAIT_MAX_MS) {
                const nextDelay = Math.min(CODEX_PROMPT_SUBMIT_WAIT_EXTEND_MS, CODEX_PROMPT_SUBMIT_WAIT_MAX_MS - submitWaitMs);
                warn(`[group-chat] hard timeout reached for ${label}(${sid.slice(0, 8)}) but Codex transcript is not bound yet; extending unbound submit wait ${Math.round(nextDelay / 1000)}s`);
                armHardTimeout(nextDelay);
                return;
              }
            }
          }
          const elapsed = Date.now() - startTs;
          const lastActivity = sessionManager.getGroupChatLastActivity(sid);
          const recentlyActive = lastActivity > startTs && (Date.now() - lastActivity) <= HARD_TIMEOUT_ACTIVE_GRACE_MS;
          if (allowActiveExtend && recentlyActive && elapsed < maxHardTimeoutMs) {
            const nextDelay = Math.min(HARD_TIMEOUT_ACTIVE_EXTEND_MS, maxHardTimeoutMs - elapsed);
            warn(`[group-chat] hard timeout reached for ${label}(${sid.slice(0, 8)}) but PTY was active ${Math.round((Date.now() - lastActivity) / 1000)}s ago; extending ${Math.round(nextDelay / 1000)}s`);
            armHardTimeout(nextDelay);
            return;
          }
          warn(`[group-chat] transitional hard timeout (${Math.round(elapsed / 60000)}min) hit for ${label}(${sid.slice(0, 8)}), forcing skip`);
          watcher.skip();
        }, delayMs);
        hardTimeout.unref?.();
      };
      armHardTimeout(hardTimeoutMs);
    }

    let hostShellHits = 0;
    const authBannerMonitor = createAuthBannerMonitor();
    const hostShellHeartbeat = setInterval(() => {
      if (watcher.isSettled()) { clearInterval(hostShellHeartbeat); return; }
      const buf = sessionManager.getSessionBuffer(sid) || '';
      // 登录失效判定收紧（2026-07-12）：tail + 连续 2 次命中 + 期间 PTY 静默才 confirmed，
      //   防 AI 回答/gh CLI 输出里提到 "not logged in" 等字样时误杀正常回答。
      // 二轮加固（多方审查）：真登录横幅必然出现在 prompt 提交后早期（CLI 拒答即静止）；
      //   轮次开跑 AUTH_DETECT_WINDOW_MS 之后出现的 auth 字样几乎必是回答内容/工具输出，
      //   不再检测——消灭"回答末尾提到 login 短语 + settle 信号迟到"竞态窗口的误杀。
      //   代价：>2min 后才真失效的会话不自动 errored，由 T1/T2 soft-alert 人工兜底。
      if (Date.now() - startTs < AUTH_DETECT_WINDOW_MS
        && authBannerMonitor.tick(buf, sessionManager.getGroupChatLastActivity(sid)) === 'confirmed') {
        warn(`[group-chat] auth failure banner confirmed for ${label}(${sid.slice(0, 8)}) - marking errored`);
        try { watcher.markErrored('auth_required'); }
        catch (e) { warn('[group-chat] markErrored auth_required threw:', e && e.message); }
        return;
      }
      if (groupChatWatcher.checkHostShellTakeover(sid)) {
        hostShellHits += 1;
        if (hostShellHits >= HOST_SHELL_CONSECUTIVE_HITS) {
          warn(`[group-chat] host shell prompt detected for ${label}(${sid.slice(0, 8)}) on hit #${hostShellHits} - CLI self-exited, marking errored`);
          try { watcher.markProcessExit({ code: -1, signal: 'cli_self_exit' }); }
          catch (e) { warn('[group-chat] markProcessExit (heartbeat) threw:', e.message); }
        }
      } else {
        hostShellHits = 0;
      }
    }, HOST_SHELL_HEARTBEAT_MS);
    hostShellHeartbeat.unref?.();

    let codexAutoExtractTimer = null;
    let codexPromptSubmitTimer = null;
    let codexPromptSubmitRetries = 0;
    let onCodexPromptSubmitted = null;
    if (isCodexBaseKind(waitKind) || isClaudeFamily(waitKind)) {
      const sincePromptTs = promptSubmitSinceTs;
      let autoExtractBusy = false;
      codexAutoExtractTimer = setInterval(async () => {
        if (watcher.isSettled()) {
          clearInterval(codexAutoExtractTimer);
          codexAutoExtractTimer = null;
          return;
        }
        if (Date.now() - startTs < CODEX_AUTO_EXTRACT_DELAY_MS) return;
        if (autoExtractBusy) return;
        autoExtractBusy = true;
        try {
          const extracted = await transcriptTap.extractLatestTurn(sid, sincePromptTs);
          const isCodexFinal = isCodexBaseKind(waitKind)
            && extracted?.extractMode === 'final_answer';
          const isClaudeFinal = isClaudeFamily(waitKind)
            && extracted?.source === 'manual_claude_transcript'
            && Number(extracted.completedAt) >= sincePromptTs;
          if ((isCodexFinal || isClaudeFinal) && extracted.text) {
            const signalSource = isCodexFinal
              ? 'codex_auto_extract_final_answer'
              : 'claude_auto_extract_final_answer';
            log(`[group-chat] ${waitKind} auto-extract final answer for ${label}(${sid.slice(0, 8)}) ${extracted.text.length} chars`);
            watcher.completeFromTranscript(extracted.text, signalSource);
          }
        } catch (e) {
          warn('[group-chat] codex auto-extract failed:', e && e.message);
        } finally {
          autoExtractBusy = false;
        }
      }, CODEX_AUTO_EXTRACT_INTERVAL_MS);
      codexAutoExtractTimer.unref?.();

      if (isCodexBaseKind(waitKind) && opts.prompt && transcriptTap && typeof transcriptTap.on === 'function') {
        onCodexPromptSubmitted = (ev) => {
          if (!ev || ev.hubSessionId !== sid) return;
          const submittedAt = Number(ev.submittedAt) || Date.now();
          if (submittedAt >= sincePromptTs) {
            codexPromptSubmitted = true;
            codexPromptSubmittedAt = submittedAt;
          }
        };
        try { transcriptTap.on('prompt-submitted', onCodexPromptSubmitted); }
        catch (error) { warn('[group-chat] prompt-submitted listener registration failed:', error && error.message); }
        const armCodexPromptSubmitCheck = (delayMs) => {
          if (codexPromptSubmitTimer) clearTimeout(codexPromptSubmitTimer);
          codexPromptSubmitTimer = setTimeout(verifyPromptSubmitted, delayMs);
          codexPromptSubmitTimer.unref?.();
        };
        const verifyPromptSubmitted = async () => {
          if (watcher.isSettled() || codexPromptSubmitted) return;
          const currentWaitSession = sessionManager.getSession(sid) || waitSession;
          const boundNow = hasBoundCodexTranscript(currentWaitSession);
          if (!boundNow) {
            const elapsed = Date.now() - startTs;
            if (elapsed < CODEX_TRANSCRIPT_BIND_GRACE_MS) {
              armCodexPromptSubmitCheck(CODEX_TRANSCRIPT_BIND_GRACE_MS - elapsed);
              return;
            }
          }
          if (boundNow && transcriptTap && typeof transcriptTap.hasCodexUserMessageSince === 'function') {
            try {
              codexPromptSubmitted = await transcriptTap.hasCodexUserMessageSince(sid, sincePromptTs);
              if (codexPromptSubmitted && !codexPromptSubmittedAt) codexPromptSubmittedAt = Date.now();
              if (codexPromptSubmitted) return;
            } catch (e) {
              warn('[group-chat] codex prompt submit verification read failed:', e && e.message);
            }
          }
          if (codexPromptSubmitRetries >= CODEX_PROMPT_SUBMIT_RETRY_MAX) return;
          codexPromptSubmitRetries += 1;
          const reason = boundNow ? 'prompt submit not observed' : 'transcript not bound';
          const retryElapsedMs = Date.now() - startTs;
          warn(`[group-chat] codex ${reason} for ${label}(${sid.slice(0, 8)}) after ${Math.round(retryElapsedMs / 1000)}s (bindGrace=${Math.round(CODEX_TRANSCRIPT_BIND_GRACE_MS / 1000)}s); retrying prompt submit #${codexPromptSubmitRetries}`);
          try {
            const retry = await groupChatWatcher.resendCurrentPrompt({
              sid,
              kind: waitKind,
              prompt: opts.prompt,
              promptHeader: promptHeaderForRetry(opts.prompt),
            });
            try {
              const meeting = meetingManager.getMeeting(meetingId);
              if (meeting && meeting.groupChat) {
                const orch = groupchat.getOrchestrator(getHubDataDir(), meetingId);
                orch.setSendStatus(turnNum, sid, retry?.ok ? 'submit_retry' : 'submit_retry_failed');
              }
            } catch (e) { warn('[group-chat] codex prompt submit retry status threw:', e && e.message); }
          } catch (e) {
            warn('[group-chat] codex prompt submit retry threw:', e && e.message);
          }
        };
        armCodexPromptSubmitCheck(CODEX_PROMPT_SUBMIT_VERIFY_MS);
      }
    }

    const cleanupWaitResources = () => {
      if (hardTimeout) clearTimeout(hardTimeout);
      clearInterval(hostShellHeartbeat);
      if (codexAutoExtractTimer) clearInterval(codexAutoExtractTimer);
      if (codexPromptSubmitTimer) clearTimeout(codexPromptSubmitTimer);
      if (onCodexPromptSubmitted && transcriptTap && typeof transcriptTap.removeListener === 'function') {
        try { transcriptTap.removeListener('prompt-submitted', onCodexPromptSubmitted); }
        catch (error) { warn('[group-chat] prompt-submitted listener cleanup failed:', error && error.message); }
      }
      if (streamTimer) clearInterval(streamTimer);
      activeWatchers.delete(sid);
      stopPasteTrappedMonitor(sid);
    };

    return watcher.wait().then(result => {
      cleanupWaitResources();
      setTimeout(() => {
        try { unregisterPatchListener(sid, watcher); }
        catch (e) { warn('[patch] unregisterPatchListener throw:', e && e.message); }
      }, 305_000).unref?.();

      const elapsedMs = Date.now() - startTs;
      result.thinkSec = Math.round(elapsedMs / 100) / 10;
      try { result.tokens = transcriptTap.getLastTokens(sid) || null; }
      catch { result.tokens = null; }

      // 不再等最慢成员才持久化整轮：单个 AI 一结算就先把可用结果写进 messages。
      // 这样后续成员卡住、Hub 崩溃/重启或用户立即点“同步”时，已得到的答案都不会丢。
      if (!silent && meetingId && turnNum) {
        try {
          const orch = groupchat.getOrchestrator(getHubDataDir(), meetingId);
          orch.patchTurnResult(turnNum, sid, {
            text: result.text,
            status: result.status,
            thinkSec: result.thinkSec,
            tokens: result.tokens,
            memberId: opts.memberId,
            speaker: opts.speaker || label,
            sourcePrompt: opts.prompt,
            statusReason: result.reason,
          });
        } catch (e) {
          // 持久化失败不能反向卡死 watcher/整轮；最终 completeTurn 仍有一次落盘机会。
          warn('[group-chat] persist settled participant failed:', e && e.message);
        }
      }

      if (typeof onPartial === 'function') {
        try { onPartial(result); } catch (e) { warn('[group-chat] onPartial error:', e.message); }
      }
      return result;
    }, err => {
      cleanupWaitResources();
      throw err;
    });
  }

  function groupMembersForMeeting(meeting) {
    const subSids = Array.isArray(meeting && meeting.subSessions) ? meeting.subSessions : [];
    const specs = Array.isArray(meeting && meeting.slotSpecs) ? meeting.slotSpecs : [];
    const kindCounts = {};
    for (const sid of subSids) {
      const s = sessionManager.getSession(sid);
      if (!s) continue;
      kindCounts[s.kind] = (kindCounts[s.kind] || 0) + 1;
    }
    const seenKind = {};
    return subSids.map((sid, idx) => {
      const s = sessionManager.getSession(sid);
      if (!s || s.status === 'dormant') return null;
      const spec = specs[idx] || {};
      const kind = s.kind || spec.kind || 'ai';
      seenKind[kind] = (seenKind[kind] || 0) + 1;
      const kindLabel = kindLabels[kind] || kind || 'AI';
      const dupSuffix = kindCounts[kind] > 1 ? String(seenKind[kind]) : '';
      const displayName = s.title || `${kindLabel}${dupSuffix ? ' ' + dupSuffix : ''}`;
      const memberId = `m${idx + 1}`;
      const model = (s.currentModel && s.currentModel.id) || spec.model || null;
      const aliases = [
        memberId,
        displayName,
        kindLabel,
        kind,
        `${kindLabel}${seenKind[kind]}`,
        `${kind}${seenKind[kind]}`,
      ].filter(Boolean);
      return {
        sid,
        index: idx,
        memberId,
        kind,
        model,
        displayName,
        aliases: [...new Set(aliases.map(x => String(x)))],
      };
    }).filter(Boolean);
  }

  async function dispatchInternalPrompt(meetingId, meeting, targetMembers, userInput, turnTimeoutMs) {
    for (const member of targetMembers) {
      try { transcriptTap.clearStreamingBuf(member.sid); }
      catch (error) { warn('[groupchat] internal clearStreamingBuf failed:', error && error.message); }
      cancelPatchListenersForSid(member.sid);
    }
    const _orch = groupchat.getOrchestrator(getHubDataDir(), meetingId);
    // [全量注入] 记录本幕发言前的位置——markDeliveredSilent 用它把各委员「已读位置」停在本幕发言前，
    //   使下一幕 buildDelta 能带上本幕全部委员发言（群聊式全量注入，复用自由群聊 deliveredIdx 机制）。
    const deliveredIdx = _orch.state.messages.length - 1;
    const targets = targetMembers.map(member => {
      const systemPromptText = groupchat.buildSystemPromptText(member.displayName, meeting.scene, {
        kind: member.kind,
      });
      return {
        sid: member.sid,
        kind: member.kind,
        label: member.displayName,
        member,
        deliveredIdx,
        // 点2：首次带 systemPrompt(整套规则)、之后只发增量。[全量注入] includeCommitteeMid:true —— 把
        //   上一幕委员发言全文注入本幕，每个 AI 看到队友调研全文（点评看建库、辩论看点评），不再瞎猜。
        prompt: _orch.buildFirstDelta(member.sid, userInput || '', systemPromptText, { currentUserMessageAppended: false, includeCommitteeMid: true }),
      };
    });
    const sentTargets = [];
    await Promise.all(targets.map(async (t) => {
      try {
        const sendStartedAt = Date.now();
        const sendResult = await groupChatWatcher.sendToPty(t.sid, t.prompt, t.kind);
        if (sendResult && sendResult.ok) {
          t.promptSubmitSinceTs = Math.max(0, sendStartedAt - 1000);
          sentTargets.push(t);
        }
      } catch (e) {
        warn(`[groupchat] internal sendToPty threw for ${t.kind}(${t.sid.slice(0,8)}):`, e && e.message);
      }
    }));
    if (sentTargets.length === 0) return { status: 'no_sent', turnNum: null };
    const settled = await Promise.allSettled(sentTargets.map(t =>
      waitTurnComplete(t.sid, t.label, {
        meetingId,
        mode: 'internal',
        turnNum: 0,
        kind: t.kind,
        prompt: t.prompt,
        promptSubmitSinceTs: t.promptSubmitSinceTs,
        disableHardTimeout: !(Number(turnTimeoutMs) > 0),
        hardTimeoutMs: Number(turnTimeoutMs) > 0 ? Number(turnTimeoutMs) : undefined,
        silent: true,
        allowActiveExtend: false,
      })
    ));
    const results = settled.map((s, i) => {
      // [查看本轮 prompt] 把该委员本幕实际收到的 prompt 带进 result，供 conductor→appendSpeeches 落进消息。
      const _srcPrompt = (sentTargets[i] && sentTargets[i].prompt) || '';
      // [全量注入] 带出 deliveredIdx → markDeliveredSilent 把「已读位置」停在本幕发言前，下一幕看得到本幕发言。
      const _deliveredIdx = sentTargets[i] && sentTargets[i].deliveredIdx;
      return s.status === 'fulfilled'
        ? { ...s.value, sourcePrompt: _srcPrompt, deliveredIdx: _deliveredIdx }
        : { sid: sentTargets[i].sid, label: sentTargets[i].label, status: 'errored', text: '', reason: s.reason?.message || 'Promise rejected', sourcePrompt: _srcPrompt, deliveredIdx: _deliveredIdx };
    });
    // 点2：标记这些委员已收过 systemPrompt → 下一幕 buildFirstDelta 走增量、不再重发整套规则。
    try { _orch.markDeliveredSilent(results); } catch (e) { warn('[committee] markDeliveredSilent threw:', e && e.message); }
    return { status: 'completed', turnNum: null, results, meta: { dispatchMode: 'internal' } };
  }

  // 抢占式结算（2026-06-24 道雪）：用户点发送即放行的核心。新一轮进来时，把这个
  //   meeting 当前所有还在等待回答的 AI（上一轮没答完的）立即结算为 superseded，让它们的
  //   waitTurnComplete Promise 立刻 resolve → 上一轮 runGroupChatTurn 的 Promise.allSettled
  //   立即完成 → 串行队列放行新轮，不再被卡死的 AI 无限期挂起。
  //   只结算属于本 meeting 的 watcher（activeWatchers 以 sid 为键，跨 meeting 不共享 sid）。
  function supersedeActiveWatchersForMeeting(meetingId) {
    const meeting = meetingManager.getMeeting(meetingId);
    const sids = meeting && Array.isArray(meeting.subSessions) ? meeting.subSessions : [];
    let count = 0;
    for (const sid of sids) {
      const watcher = activeWatchers.get(sid);
      if (watcher && !watcher.isSettled()) {
        try { watcher.supersede(); count += 1; }
        catch (e) { warn('[groupchat] supersede watcher threw:', e && e.message); }
      }
    }
    if (count > 0) log(`[groupchat] preempted ${count} in-flight AI(s) for meeting ${meetingId} — user sent next turn`);
    return count;
  }

  // 运行中中断（2026-07-29 道雪）：把「用户在单 session 里按 ESC」这件事批量下发给
  //   本轮所有在跑的成员。顺序刻意是「先结算、再发 ESC」：
  //     ① 先 watcher.interrupt(partialText) —— 状态机立刻收敛到确定态（interrupted），
  //        不依赖 CLI 是否回吐 stop 信号。CLI 挂了 / 不认 ESC 也不会留下永久"思考中"。
  //     ② 再向 PTY 写 ESC —— 让 CLI 真的停下别继续烧 token。
  //   已经流出的半截文本一并落盘（extractStreamingText），中断不等于丢内容。
  function interruptMeetingTurn(meetingId, opts = {}) {
    const key = String(meetingId || '');
    const reason = opts.reason || 'user_interrupt';
    const meeting = meetingManager.getMeeting(meetingId);
    if (!meeting || !meeting.groupChat) {
      return { ok: false, reason: 'not_group_chat_meeting', stopped: [], signaled: [], turnNum: null };
    }
    // 代际先自增：即使此刻还没有 watcher（send 与 wait 之间），正在跑的
    //   runGroupChatTurn 也能在开等之前看到「我已经被中断了」。
    meetingInterruptSeq.set(key, (meetingInterruptSeq.get(key) || 0) + 1);

    const sids = Array.isArray(meeting.subSessions) ? meeting.subSessions : [];
    const stopped = [];
    for (const sid of sids) {
      const watcher = activeWatchers.get(sid);
      if (!watcher || watcher.isSettled()) continue;
      const session = sessionManager.getSession(sid);
      const kind = (session && session.kind) || 'unknown';
      let partialText = '';
      try {
        const streamed = groupChatWatcher.extractStreamingText(sid, kind);
        if (streamed && streamed.text) partialText = String(streamed.text);
      } catch (e) {
        warn('[groupchat] interrupt extractStreamingText threw:', e && e.message);
      }
      try {
        watcher.interrupt(partialText, reason);
        stopped.push(sid);
      } catch (e) {
        warn('[groupchat] interrupt watcher threw:', e && e.message);
      }
    }

    const signaled = signalInterruptToPty(stopped.length > 0 ? stopped : sidsStillBusy(sids));

    // 有轮正卡在 sendToPty（watcher 还没建）时不要抢着收 idle：那一轮马上会在
    //   开等之前读到中断代际并自己以 interrupted 收敛，这里插一脚只会让 UI 闪。
    const pendingDispatch = (meetingInFlightTurns.get(key) || 0) > 0;
    let turnNum = null;
    try {
      const orch = groupchat.getOrchestrator(getHubDataDir(), meetingId);
      turnNum = orch.state.currentTurn || null;
      // 兜底收敛：既没有在跑 watcher、也没有在飞的派发（Hub 重启残留 / 状态悬空）时，
      //   仍把 orchestrator 的进行中轮收回 idle，绝不留"永久思考中"。
      if (stopped.length === 0 && !pendingDispatch && orch.state.currentMode !== 'idle' && turnNum) {
        orch.clearTurnInProgress(turnNum);
      }
    } catch (e) {
      warn('[groupchat] interrupt orchestrator sync threw:', e && e.message);
    }

    log(`[groupchat] user interrupted meeting ${meetingId}: settled ${stopped.length} in-flight AI(s), ESC sent to ${signaled.length}, pendingDispatch=${pendingDispatch}`);
    try {
      sendToRenderer('groupchat-turn-interrupted', {
        meetingId, turnNum, stopped, signaled, reason, pendingDispatch,
      });
    } catch (e) {
      warn('[groupchat] interrupt sendToRenderer threw:', e && e.message);
    }
    return { ok: true, stopped, signaled, turnNum, pendingDispatch };
  }

  // 没有 watcher 但 PTY 可能仍在跑（send 与 wait 之间被叫停）：对本 meeting 里
  //   groupChatReady 过的成员一律补一发 ESC，宁可多按一次也不留失控的 CLI。
  function sidsStillBusy(sids) {
    const out = [];
    for (const sid of sids) {
      try {
        if (sessionManager.getGroupChatReady && sessionManager.getGroupChatReady(sid)) out.push(sid);
      } catch { /* 会话已关闭 */ }
    }
    return out;
  }

  function signalInterruptToPty(sids) {
    const signaled = [];
    for (const sid of sids || []) {
      try {
        sessionManager.writeToSession(sid, INTERRUPT_KEY);
        signaled.push(sid);
        for (let i = 1; i < INTERRUPT_KEY_REPEAT; i += 1) {
          const t = setTimeout(() => {
            try { sessionManager.writeToSession(sid, INTERRUPT_KEY); }
            catch (e) { warn('[groupchat] interrupt repeat write threw:', e && e.message); }
          }, INTERRUPT_KEY_GAP_MS * i);
          t.unref?.();
        }
      } catch (e) {
        warn(`[groupchat] interrupt write to ${String(sid).slice(0, 8)} threw:`, e && e.message);
      }
    }
    return signaled;
  }

  async function dispatchGroupChatTurn(meetingId, args = {}) {
    const key = String(meetingId || '');
    // 真实用户发送（非 silent 内部编排）进来时，先抢占结算上一轮没答完的 AI，再排队 ——
    //   这样上一轮立刻收尾、本轮几乎零延迟开跑。dispatchSeq 供 runGroupChatTurn 判断
    //   自己完成时是否已被更新的轮抢占（决定给前端的 superseded flag）。
    let dispatchSeq = null;
    if (!args.silent) {
      dispatchSeq = (meetingDispatchSeq.get(key) || 0) + 1;
      meetingDispatchSeq.set(key, dispatchSeq);
      try { supersedeActiveWatchersForMeeting(meetingId); }
      catch (e) { warn('[groupchat] preempt supersede threw:', e && e.message); }
    }
    const previous = groupChatTurnQueue.get(key) || Promise.resolve();
    const task = previous.catch(() => {}).then(() => runGroupChatTurn(meetingId, { ...args, _dispatchSeq: dispatchSeq }));
    groupChatTurnQueue.set(key, task);
    task.finally(() => {
      if (groupChatTurnQueue.get(key) === task) groupChatTurnQueue.delete(key);
    }).catch(() => {});
    return task;
  }

  async function runGroupChatTurn(meetingId, {
    userInput,
    turnTimeoutMs,
    targetMemberIds,
    heroIdBySid,
    silent,
    allowActiveExtend,
    appendUserMessage,
    reuseTurnNum,
    dispatchMode,
    workflowRun,
    _dispatchSeq,
  } = {}) {
    const turnStartedAt = Date.now();
    // 在飞派发计数（2026-07-29 道雪）：给 interruptMeetingTurn 区分「真没人在跑」
    //   和「有轮正卡在 sendToPty」。silent 内部编排不计入（不属于用户可见轮）。
    const inFlightKey = String(meetingId || '');
    if (!silent) meetingInFlightTurns.set(inFlightKey, (meetingInFlightTurns.get(inFlightKey) || 0) + 1);
    try {
      const meeting = meetingManager.getMeeting(meetingId);
      if (!meeting || !meeting.groupChat) {
        return { status: 'error', reason: 'not group chat meeting', turnNum: null };
      }
      // 运行中中断的竞态门（2026-07-29 道雪）：记下本轮开跑时的中断代际。
      //   sendToPty 可能要跑几秒，用户在这段窗口点「停止」时 activeWatchers 里还没有
      //   本轮 watcher，中断会落空 → 本轮随后开始等待、永远等不到 → 永久"思考中"。
      const interruptKey = String(meetingId || '');
      const interruptSeqAtStart = meetingInterruptSeq.get(interruptKey) || 0;
      const interruptedSinceStart = () => (meetingInterruptSeq.get(interruptKey) || 0) !== interruptSeqAtStart;
      const members = groupMembersForMeeting(meeting);
      if (members.length === 0) return { status: 'no_subs', turnNum: null };
      // 轻量英雄只接受内置 hero id，不接收 renderer 传来的任意 Prompt 文本。
      // 这样每家 AI 仍可独立选英雄，同时主进程保有最终 Prompt 的可信边界。
      const normalizedHeroIdBySid = normalizeHeroAssignments(
        heroIdBySid,
        members.map(member => member.sid)
      );

      const explicitTargetIds = Array.isArray(targetMemberIds)
        ? targetMemberIds.map(x => String(x || '').toLowerCase()).filter(Boolean)
        : [];
      const routed = explicitTargetIds.length
        ? {
            targets: members.filter(m => explicitTargetIds.includes(String(m.memberId || '').toLowerCase())),
            mentions: explicitTargetIds,
          }
        : parseGroupTargets(userInput || '', members, meeting.participants);
      const targetMembers = routed.targets || [];
      // 2026-07-20 道雪 [修#3d]：被勾选但 dormant/不可达的成员以 absent 合入本轮，
      //   不再静默消失（此前卡片全程"思考中"、轮末查无此人）。仅整组发送时统计；
      //   @ 点名/显式 targetMemberIds 时，未被点到的不算缺席。
      const isRoutedSubset = explicitTargetIds.length > 0 || (routed.mentions && routed.mentions.length > 0);
      let absentMembers = [];
      if (!isRoutedSubset && !silent) {
        const targetSidSet = new Set(targetMembers.map(m => m.sid));
        const checkedIdx = new Set(Array.isArray(meeting.participants) ? meeting.participants : (meeting.subSessions || []).map((_s, i) => i));
        absentMembers = (meeting.subSessions || []).map((sid, idx) => ({ sid, idx }))
          .filter(({ sid, idx }) => checkedIdx.has(idx) && !targetSidSet.has(sid))
          .map(({ sid, idx }) => {
            const s = sessionManager.getSession(sid);
            return { sid, label: (s && (s.title || s.kind)) || `AI ${idx + 1}`, status: 'absent', text: '', reason: 'session_not_ready', deliveredIdx: null };
          });
      }
      if (targetMembers.length === 0 && absentMembers.length === 0) {
        return { status: 'error', reason: '请先勾选至少一位 AI 成员，或用 @ 指定成员', turnNum: null };
      }
      if (silent) {
        return await dispatchInternalPrompt(meetingId, meeting, targetMembers, userInput || '', turnTimeoutMs);
      }
      if (!silent) maybeAutoTitleMeetingFromPrompt(meetingId, userInput || '');

      for (const member of members) {
        try { transcriptTap.clearStreamingBuf(member.sid); }
        catch (error) { warn('[groupchat] clearStreamingBuf failed:', error && error.message); }
      }

      const hubDataDir = getHubDataDir();
      const orch = groupchat.getOrchestrator(hubDataDir, meetingId);
      const requestedTurnNum = Number(reuseTurnNum);
      const isReusedTurn = Number.isInteger(requestedTurnNum) && requestedTurnNum > 0;
      const begin = orch.beginTurn(userInput || '', {
        turnNum: isReusedTurn ? requestedTurnNum : undefined,
        appendUserMessage: appendUserMessage !== false,
      });
      const { turnNum } = begin;
      const deliveredIdx = orch.state.messages.length - 1;
      const targets = targetMembers.map(member => {
        const systemPromptText = groupchat.buildSystemPromptText(member.displayName, meeting.scene, {
          kind: member.kind,
          // 产物写进本群聊的 workspace，而不是 home 下的公共 artifacts 目录。
          workspace: meeting.workspace || null,
        });
        const basePrompt = orch.buildFirstDelta(member.sid, userInput || '', systemPromptText, {
          currentUserMessageAppended: begin.didAppendUserMessage,
        });
        return {
          sid: member.sid,
          kind: member.kind,
          label: member.displayName,
          member,
          deliveredIdx,
          heroId: normalizedHeroIdBySid[member.sid] || null,
          // 英雄块每轮都追加在最终 Prompt 末尾；不能塞进 systemPromptText，后者只在
          // 该 sid 首次进入群聊时发送，无法满足“下一轮一次性注入”。
          prompt: appendHeroPrompt(basePrompt, normalizedHeroIdBySid[member.sid]),
        };
      });

      for (const t of targets) {
        cancelPatchListenersForSid(t.sid);
        try { orch.recordTurnPrompt(turnNum, t.sid, t.prompt, { workflowRun }); }
        catch (e) { warn('[groupchat] recordTurnPrompt threw:', e && e.message); }
      }

      const sentTargets = [];
      const sendFailures = [];
      await Promise.all(targets.map(async (t) => {
        try {
          const sendStartedAt = Date.now();
          const sendResult = await groupChatWatcher.sendToPty(t.sid, t.prompt, t.kind);
          const ok = sendResult && sendResult.ok;
          const sendStatus = sendResult && sendResult.sendStatus;
          try {
            orch.setSendStatus(turnNum, t.sid, sendStatus || (ok ? 'submitted' : 'send_failed'), {
              acknowledgementSource: sendResult && sendResult.acknowledgementSource,
            });
          } catch (e) {
            warn('[groupchat] persist send receipt failed:', e && e.message);
          }
          if (!silent && ok) {
            try {
              sendToRenderer('groupchat-send-ack', {
                meetingId,
                turnNum,
                sid: t.sid,
                kind: t.kind,
                sendStatus: sendStatus || 'ok',
                acknowledgementSource: sendResult && sendResult.acknowledgementSource || null,
                enterAttempts: Number(sendResult && sendResult.enterAttempts) || null,
                ...(sendResult && sendResult.probeDiagnostics ? { probeDiagnostics: sendResult.probeDiagnostics } : {}),
              });
            } catch (e) { warn('[groupchat] send ack telemetry failed:', e && e.message); }
          }
          // The semantic submit watchdog has already sent bounded late Enter
          // recoveries. Surface the escape action immediately for every
          // provider (including Codex); the marker monitor may continue trying
          // in the background, and a later streaming heartbeat clears the UI.
          if (!silent && sendStatus === 'stuck') {
            sendToRenderer('groupchat-send-stuck', { meetingId, sid: t.sid, kind: t.kind });
          }
          if (ok) {
            t.promptSubmitSinceTs = Math.max(0, sendStartedAt - 1000);
            sentTargets.push(t);
            const submitAcknowledged = !!(sendResult && sendResult.acknowledgementSource);
            // A semantic or strong-current-screen acknowledgement proves the
            // paste was submitted. Continuing to scan historical paste markers
            // after that produced false `send-stuck` banners during real work.
            if (!silent && (!submitAcknowledged || sendStatus === 'stuck')) {
              startPasteTrappedMonitor(t.sid, t.kind, meetingId);
            }
          } else {
            const failed = {
              sid: t.sid,
              label: t.label,
              status: 'errored',
              text: '',
              reason: sendResult && sendResult.reason || 'cli_not_ready',
              deliveredIdx: t.deliveredIdx,
              sourcePrompt: t.prompt,
            };
            sendFailures.push(failed);
            if (!silent) sendToRenderer('groupchat-partial-update', { meetingId, turnNum, mode: 'group', ...failed });
          }
        } catch (e) {
          try { orch.setSendStatus(turnNum, t.sid, 'send_exception', { reason: e && e.message }); }
          catch (receiptError) { warn('[groupchat] persist send exception receipt failed:', receiptError && receiptError.message); }
          const failed = {
            sid: t.sid,
            label: t.label,
            status: 'errored',
            text: '',
            reason: e && e.message || 'send_exception',
            deliveredIdx: t.deliveredIdx,
            sourcePrompt: t.prompt,
          };
          sendFailures.push(failed);
          if (!silent) sendToRenderer('groupchat-partial-update', { meetingId, turnNum, mode: 'group', ...failed });
          warn(`[groupchat] turn ${turnNum} sendToPty threw for ${t.kind}(${t.sid.slice(0,8)}):`, e && e.message);
        }
      }));

      if (sentTargets.length === 0) {
        // 2026-07-20 道雪 [修#3d 边界]：全部被勾选成员都 dormant/不可达时，仍以 absent
        //   落轮——让用户看到"缺席"占位，而不是问题发出后整轮凭空回滚消失。
        const immediateFailures = absentMembers.concat(sendFailures);
        if (immediateFailures.length > 0 && !silent) {
          const memberBySid0 = {};
          for (const m of members) memberBySid0[m.sid] = m;
          const turnRecord0 = orch.completeTurn(turnNum, userInput || '', immediateFailures, memberBySid0, {}, {
            dispatchMode: dispatchMode || 'group',
            workflowRun,
          });
          const meta0 = (turnRecord0 && turnRecord0.meta) || { dispatchMode: 'group' };
          sendToRenderer('groupchat-turn-complete', { meetingId, turnNum, mode: 'group', results: immediateFailures, meta: meta0, superseded: false, completedAt: Date.now() });
          notifyGroupChatComplete({
            meetingId,
            turnNum,
            results: immediateFailures,
            meta: meta0,
            durationMs: Date.now() - turnStartedAt,
            superseded: false,
            interrupted: false,
          }, meeting);
          return { status: 'completed', turnNum, results: immediateFailures, meta: meta0 };
        }
        if (isReusedTurn) orch.clearTurnInProgress(turnNum);
        else orch.rollbackTurn(turnNum);
        return { status: 'no_sent', turnNum };
      }

      // 2026-07-21 道雪 [修思考中口径]：把本轮真正发出 prompt 的 sid 列表告诉 renderer——
      //   此前 renderer 用"勾选成员"乐观猜测（triggerGroupChat 的 _gcActiveSids），
      //   @ 点名/部分勾选时没收到提问的 AI 也显示"思考中"。
      if (!silent) {
        try {
          sendToRenderer('groupchat-turn-targets', { meetingId, turnNum, sids: sentTargets.map(t => t.sid) });
        } catch (error) {
          warn('[groupchat] turn target delivery failed:', error && error.message);
        }
      }

      // 内部编排式调用可传 turnTimeoutMs：卡住的成员到点强制 skip，
      // 不阻塞整轮（防 paste-trapped 无限等待）。普通群聊保持无硬超时。
      // 注意：下面的 .map 是同步的，所有 watcher 在 await 之前就已注册进 activeWatchers，
      //   所以「send 期间被中断」可以在这里补一次结算（见 interruptedSinceStart）。
      const settledPromise = Promise.allSettled(sentTargets.map(t =>
        waitTurnComplete(t.sid, t.label, {
          meetingId, mode: 'group', turnNum, kind: t.kind, prompt: t.prompt, promptSubmitSinceTs: t.promptSubmitSinceTs,
          memberId: t.member && t.member.memberId,
          speaker: t.label,
          disableHardTimeout: !(Number(turnTimeoutMs) > 0),
          hardTimeoutMs: Number(turnTimeoutMs) > 0 ? Number(turnTimeoutMs) : undefined,
          allowActiveExtend,
          silent,
          onPartial: silent ? null : (partial) => {
            // 抢占结算的 superseded 是内部信号，不推 partial-update：此刻新一轮已乐观清空
            //   partialBy，推过去会让被抢占的卡片闪一下「已被覆盖」再跳回思考中。旧轮的
            //   superseded 已随 turn-complete 持久化进 state.turns，历史回看可见。
            if (partial.status === 'superseded') return;
            sendToRenderer('groupchat-partial-update', {
              meetingId, turnNum, mode: 'group',
              sid: partial.sid, label: partial.label,
              status: partial.status,
              text: partial.text,
              blocks: partial.blocks,
              source: partial.source,
              thinkSec: partial.thinkSec, tokens: partial.tokens,
              cleanBufLen: partial.cleanBufLen,
              // errored settle 也走 onPartial：带上失败原因，让气泡占位文案能解释"为什么失败"
              reason: partial.reason,
            });
          },
        })
      ));

      // send 期间被中断：watcher 刚同步注册完，立刻补一次结算，否则本轮会开始
      //   等一个已经被用户叫停的回答，卡片永久停在"思考中"。
      if (!silent && interruptedSinceStart()) {
        try { interruptMeetingTurn(meetingId, { reason: 'user_interrupt_during_send' }); }
        catch (e) { warn('[groupchat] late interrupt settle threw:', e && e.message); }
      } else if (!silent && _dispatchSeq != null && meetingDispatchSeq.get(interruptKey) !== _dispatchSeq) {
        // send 期间被下一问抢占（2026-07-29 道雪）：dispatchGroupChatTurn 里的抢占发生在
        //   「本轮还在 sendToPty、activeWatchers 还是空」的窗口时会落空，新一问就要被串行
        //   队列扣到本轮成员自然结算为止（CLI 卡死时可能是几分钟——用户感知就是"追问石沉大海"）。
        //   watcher 刚同步注册完，这里补一次抢占，让追加的提问立刻开跑。
        try { supersedeActiveWatchersForMeeting(meetingId); }
        catch (e) { warn('[groupchat] late preempt supersede threw:', e && e.message); }
      }
      const settled = await settledPromise;

      const results = settled.map((s, i) => s.status === 'fulfilled' ? s.value : {
        sid: sentTargets[i].sid,
        label: sentTargets[i].label,
        status: 'errored',
        text: '',
        reason: s.reason?.message || 'Promise rejected',
      }).map((r, i) => ({
        ...r,
        deliveredIdx: sentTargets[i] && sentTargets[i].deliveredIdx,
      })).concat(absentMembers, sendFailures);
      const memberBySid = {};
      for (const m of members) memberBySid[m.sid] = m;
      if (silent) {
        orch.rollbackTurn(turnNum);
        // 标记已投递：后续幕 buildFirstDelta 走增量，不再每幕重发完整 systemPrompt（含战法规则）。点2。
        try { orch.markDeliveredSilent(results); } catch (e) { warn('[group-chat] markDeliveredSilent threw:', e && e.message); }
        return { status: 'completed', turnNum: null, results, meta: { dispatchMode: 'silent' } };
      }
      const turnRecord = orch.completeTurn(turnNum, userInput || '', results, memberBySid, {}, {
        dispatchMode: dispatchMode || 'group',
        workflowRun,
      });
      const meta = turnRecord.meta || { dispatchMode: 'group' };
      // 被抢占判定：完成时若 meeting 的最新派发序号已超过自己 → 用户已发更新的轮，
      //   本轮是被 supersede 的旧轮。前端据此跳过「清 currentMode」避免抹掉新轮思考态。
      const wasSuperseded = _dispatchSeq != null && meetingDispatchSeq.get(String(meetingId || '')) !== _dispatchSeq;
      // 用户中断判定：本轮任一成员被叫停即视为整轮被中断。串行工作流 / 循环引擎靠
      //   这个返回值决定「不要继续往下一步跑」——否则下一步会拿着空结果继续编排。
      const wasInterrupted = interruptedSinceStart()
        || results.some(r => r && r.status === 'interrupted');
      sendToRenderer('groupchat-turn-complete', { meetingId, turnNum, mode: 'group', results, meta, superseded: wasSuperseded, interrupted: wasInterrupted, completedAt: Date.now() });
      notifyGroupChatComplete({
        meetingId,
        turnNum,
        results,
        meta,
        durationMs: Date.now() - turnStartedAt,
        superseded: wasSuperseded,
        interrupted: wasInterrupted,
      }, meeting);
      return { status: 'completed', turnNum, results, meta, superseded: wasSuperseded, interrupted: wasInterrupted };
    } finally {
      if (!silent) {
        const left = (meetingInFlightTurns.get(inFlightKey) || 1) - 1;
        if (left > 0) meetingInFlightTurns.set(inFlightKey, left);
        else meetingInFlightTurns.delete(inFlightKey);
      }
    }
  }

  function markProcessExitForSession(sessionId, exitInfo) {
    const watcher = activeWatchers.get(sessionId);
    if (!watcher) return false;
    const adapted = exitInfo
      ? { code: typeof exitInfo.exitCode === 'number' ? exitInfo.exitCode : null, signal: exitInfo.signal }
      : { code: null };
    log(`[group-chat] PTY exit detected for sid=${sessionId.slice(0, 8)} (code=${adapted.code} signal=${adapted.signal || 'none'}), notifying watcher`);
    try { watcher.markProcessExit(adapted); } catch (e) {
      warn('[group-chat] markProcessExit threw:', e.message);
    }
    return true;
  }

  return {
    dispatchGroupChatTurn,
    interruptMeetingTurn,
    groupMembersForMeeting,
    getActiveWatchers: () => activeWatchers,
    getGroupChatWatcher: () => groupChatWatcher,
    markProcessExitForSession,
  };
}

module.exports = {
  CODEX_AUTO_EXTRACT_DELAY_MS,
  INTERRUPT_KEY,
  createGroupChatDispatcher,
  _parseGroupTargets: parseGroupTargets,
};
