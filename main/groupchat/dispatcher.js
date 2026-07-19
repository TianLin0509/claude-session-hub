'use strict';

const groupChatWatcher = require('../../core/group-chat-watcher.js');
const { createTurnCompletionWatcher } = require('../../core/turn-completion-watcher.js');
const pasteTrappedDetector = require('../../core/paste-trapped-detector.js');
const { createAuthBannerMonitor } = require('../../core/host-shell-detector.js');

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

function appendWorkflowStepPrompt(basePrompt, meeting, workflowStepIndex, memberId) {
  const stepIndex = Number(workflowStepIndex);
  if (!Number.isInteger(stepIndex) || stepIndex < 0) return basePrompt;
  const stepPrompts = meeting && meeting.serialWorkflow && meeting.serialWorkflow.stepPrompts;
  const promptByMember = Array.isArray(stepPrompts) ? stepPrompts[stepIndex] : null;
  const raw = promptByMember && typeof promptByMember === 'object' ? promptByMember[memberId] : '';
  const extraPrompt = typeof raw === 'string' ? raw.trim().slice(0, 12_000) : '';
  if (!extraPrompt) return basePrompt;
  return `${basePrompt}\n\n## 串行工作流：本步骤追加要求（仅给当前 AI）\n${extraPrompt}`;
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
    sendToRenderer,
    sessionManager,
    transcriptTap,
  } = deps;

  groupChatWatcher.init({ sessionManager, cliReadyDetector, transcriptTap });

  const groupChatTurnQueue = new Map();
  const patchListenersBySid = new Map();
  const activeWatchers = new Map();
  const activeWatcherContexts = new Map();
  const pasteTrappedMonitors = new Map();
  // 抢占式连发（2026-06-24 道雪）：每个 meeting 的派发序号，单调递增。runGroupChatTurn
  //   完成时比对，若已有更新的轮号 → 自己是被抢占的旧轮，给前端的 turn-complete 带 superseded。
  const meetingDispatchSeq = new Map();

  function warn(...args) {
    if (logger && typeof logger.warn === 'function') logger.warn(...args);
  }

  function log(...args) {
    if (logger && typeof logger.log === 'function') logger.log(...args);
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
    try { pasteTrappedDetector.stop(sid); } catch {}
  }

  function promptHeaderForRetry(prompt) {
    const line = String(prompt || '').split(/\r?\n/).find(x => String(x || '').trim());
    return line ? line.slice(0, 160) : '';
  }

  function hasBoundCodexTranscript(session) {
    return !!(session && (session.transcriptPath || session.codexSid));
  }

  function startPasteTrappedMonitor(sid, kind, meetingId) {
    if (pasteTrappedMonitors.has(sid)) return;
    pasteTrappedDetector.start(sid, Date.now());
    const startedAt = Date.now();
    const monitor = { intervalId: null, enterRetries: 0 };
    const intervalId = setInterval(() => {
      try {
        if (Date.now() - startedAt >= PASTE_TRAPPED_HARD_TIMEOUT_MS) {
          stopPasteTrappedMonitor(sid);
          return;
        }
        const buf = sessionManager.getSessionBuffer(sid) || '';
        const activity = sessionManager.getGroupChatLastActivity(sid);
        const r = pasteTrappedDetector.tick(sid, buf, activity);
        if (r === 'stuck') {
          if (isCodexBaseKind(kind) && monitor.enterRetries < PASTE_TRAPPED_CODEX_ENTER_RETRIES) {
            monitor.enterRetries += 1;
            warn(`[paste-trapped] codex(${sid.slice(0,8)}) paste marker stable; sending retry Enter #${monitor.enterRetries}`);
            try {
              groupChatWatcher._private.writeSubmitSignal(sessionManager, sid, kind, monitor.enterRetries);
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
    const waitKind = opts.kind || waitSession?.kind || 'unknown';
    const promptSubmitSinceTs = Math.max(0, Number(opts.promptSubmitSinceTs) || (startTs - 1000));
    let codexPromptSubmitted = false;
    let codexPromptSubmittedAt = 0;
    try { transcriptTap.clearLastTokens(sid); } catch {}

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
        } catch {}
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
    activeWatcherContexts.set(sid, {
      watcher,
      meetingId: String(meetingId || ''),
      turnNum,
      startedAt: Number(opts.startedAt) || startTs,
    });
    registerPatchListener(sid, watcher);

    let streamTimer = null;
    if (typeof onPartial === 'function') {
      streamTimer = setInterval(() => {
        if (watcher.isSettled()) { clearInterval(streamTimer); streamTimer = null; return; }
        const session = sessionManager.getSession(sid);
        const kind = session?.kind || 'unknown';
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
          } catch {}
        } else {
          try {
            onPartial({
              sid, label, status: 'streaming',
              blocks: [], source: 'placeholder', text: '',
              cleanBufLen,
            });
          } catch {}
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
    if (isCodexBaseKind(waitKind)) {
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
          if (extracted?.extractMode === 'final_answer' && extracted.text) {
            log(`[group-chat] codex auto-extract final_answer for ${label}(${sid.slice(0, 8)}) ${extracted.text.length} chars`);
            watcher.completeFromTranscript(extracted.text, 'codex_auto_extract_final_answer');
          }
        } catch (e) {
          warn('[group-chat] codex auto-extract failed:', e && e.message);
        } finally {
          autoExtractBusy = false;
        }
      }, CODEX_AUTO_EXTRACT_INTERVAL_MS);
      codexAutoExtractTimer.unref?.();

      if (opts.prompt && transcriptTap && typeof transcriptTap.on === 'function') {
        onCodexPromptSubmitted = (ev) => {
          if (!ev || ev.hubSessionId !== sid) return;
          const submittedAt = Number(ev.submittedAt) || Date.now();
          if (submittedAt >= sincePromptTs) {
            codexPromptSubmitted = true;
            codexPromptSubmittedAt = submittedAt;
          }
        };
        try { transcriptTap.on('prompt-submitted', onCodexPromptSubmitted); } catch {}
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
        try { transcriptTap.removeListener('prompt-submitted', onCodexPromptSubmitted); } catch {}
      }
      if (streamTimer) clearInterval(streamTimer);
      if (activeWatchers.get(sid) === watcher) activeWatchers.delete(sid);
      if (activeWatcherContexts.get(sid)?.watcher === watcher) activeWatcherContexts.delete(sid);
      stopPasteTrappedMonitor(sid);
    };

    return watcher.wait().then(result => {
      cleanupWaitResources();
      setTimeout(() => {
        try { unregisterPatchListener(sid, watcher); }
        catch (e) { warn('[patch] unregisterPatchListener throw:', e && e.message); }
      }, 305_000).unref?.();

      const elapsedMs = Date.now() - startTs;
      result.startedAt = Number(opts.startedAt) || startTs;
      if (!Number.isFinite(Number(result.completedAt))) result.completedAt = Date.now();
      result.thinkSec = Math.round(elapsedMs / 100) / 10;
      try { result.tokens = transcriptTap.getLastTokens(sid) || null; }
      catch { result.tokens = null; }

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
      try { transcriptTap.clearStreamingBuf(member.sid); } catch {}
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
    let count = 0;
    for (const [sid, context] of activeWatcherContexts) {
      if (!context || context.meetingId !== String(meetingId || '')) continue;
      const watcher = context.watcher;
      if (watcher && !watcher.isSettled()) {
        try { watcher.supersede(); count += 1; }
        catch (e) { warn('[groupchat] supersede watcher threw:', e && e.message); }
      }
    }
    if (count > 0) log(`[groupchat] preempted ${count} in-flight AI(s) for meeting ${meetingId} — user sent next turn`);
    return count;
  }

  function interruptGroupChatTurn(meetingId) {
    const meetingKey = String(meetingId || '');
    const interruptedSids = [];
    const writeFailures = [];
    let turnNum = null;
    for (const [sid, context] of activeWatcherContexts) {
      if (!context || context.meetingId !== meetingKey) continue;
      const watcher = context.watcher;
      if (!watcher || watcher.isSettled()) continue;
      turnNum = turnNum || context.turnNum || null;
      try { sessionManager.writeToSession(sid, '\x03'); }
      catch (e) {
        writeFailures.push({ sid, reason: (e && e.message) || 'write_failed' });
        warn(`[groupchat] Ctrl+C write failed for ${sid}:`, e && e.message);
      }
      try {
        watcher.interrupt();
        interruptedSids.push(sid);
      } catch (e) {
        warn(`[groupchat] interrupt watcher failed for ${sid}:`, e && e.message);
      }
      stopPasteTrappedMonitor(sid);
    }
    if (interruptedSids.length === 0) {
      return { ok: false, status: 'idle', reason: 'no_active_turn', interruptedSids: [] };
    }
    log(`[groupchat] interrupted ${interruptedSids.length} in-flight AI(s) for meeting ${meetingKey}`);
    return { ok: true, status: 'interrupted', turnNum, interruptedSids, writeFailures };
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
    silent,
    allowActiveExtend,
    appendUserMessage,
    reuseTurnNum,
    dispatchMode,
    workflowStepIndex,
    clientGeneration,
    _dispatchSeq,
  } = {}) {
    {
      const meeting = meetingManager.getMeeting(meetingId);
      if (!meeting || !meeting.groupChat) {
        return { status: 'error', reason: 'not group chat meeting', turnNum: null };
      }
      const members = groupMembersForMeeting(meeting);
      if (members.length === 0) return { status: 'no_subs', turnNum: null };

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
      if (targetMembers.length === 0) {
        return { status: 'error', reason: '请先勾选至少一位 AI 成员，或用 @ 指定成员', turnNum: null };
      }
      if (silent) {
        return await dispatchInternalPrompt(meetingId, meeting, targetMembers, userInput || '', turnTimeoutMs);
      }
      if (!silent) maybeAutoTitleMeetingFromPrompt(meetingId, userInput || '');

      for (const member of members) {
        try { transcriptTap.clearStreamingBuf(member.sid); } catch {}
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
        });
        const basePrompt = orch.buildFirstDelta(member.sid, userInput || '', systemPromptText, {
          currentUserMessageAppended: begin.didAppendUserMessage,
          currentTurnNum: turnNum,
        });
        return {
          sid: member.sid,
          kind: member.kind,
          label: member.displayName,
          member,
          deliveredIdx,
          prompt: appendWorkflowStepPrompt(basePrompt, meeting, workflowStepIndex, member.memberId),
        };
      });

      for (const t of targets) {
        cancelPatchListenersForSid(t.sid);
        try { orch.recordTurnPrompt(turnNum, t.sid, t.prompt); }
        catch (e) { warn('[groupchat] recordTurnPrompt threw:', e && e.message); }
      }

      const sentTargets = [];
      await Promise.all(targets.map(async (t) => {
        try {
          const sendStartedAt = Date.now();
          const sendResult = await groupChatWatcher.sendToPty(t.sid, t.prompt, t.kind);
          const ok = sendResult && sendResult.ok;
          const sendStatus = sendResult && sendResult.sendStatus;
          if (!silent && sendStatus === 'stuck' && !isCodexBaseKind(t.kind)) {
            sendToRenderer('groupchat-send-stuck', { meetingId, sid: t.sid, kind: t.kind });
          }
          if (ok) {
            t.startedAt = sendStartedAt;
            t.promptSubmitSinceTs = Math.max(0, sendStartedAt - 1000);
            sentTargets.push(t);
            if (!silent && (sendStatus !== 'stuck' || isCodexBaseKind(t.kind))) {
              startPasteTrappedMonitor(t.sid, t.kind, meetingId);
            }
          }
        } catch (e) {
          warn(`[groupchat] turn ${turnNum} sendToPty threw for ${t.kind}(${t.sid.slice(0,8)}):`, e && e.message);
        }
      }));

      if (sentTargets.length === 0) {
        if (isReusedTurn) orch.clearTurnInProgress(turnNum);
        else orch.rollbackTurn(turnNum);
        return { status: 'no_sent', turnNum };
      }

      // 内部编排式调用可传 turnTimeoutMs：卡住的成员到点强制 skip，
      // 不阻塞整轮（防 paste-trapped 无限等待）。普通群聊保持无硬超时。
      const settled = await Promise.allSettled(sentTargets.map(t =>
        waitTurnComplete(t.sid, t.label, {
          meetingId, mode: 'group', turnNum, kind: t.kind, prompt: t.prompt, promptSubmitSinceTs: t.promptSubmitSinceTs,
          startedAt: t.startedAt,
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
              clientGeneration,
              sid: partial.sid, label: partial.label,
              status: partial.status,
              text: partial.text,
              blocks: partial.blocks,
              source: partial.source,
              thinkSec: partial.thinkSec, tokens: partial.tokens,
              startedAt: partial.startedAt || t.startedAt,
              completedAt: partial.completedAt,
              cleanBufLen: partial.cleanBufLen,
              // errored settle 也走 onPartial：带上失败原因，让气泡占位文案能解释"为什么失败"
              reason: partial.reason,
            });
          },
        })
      ));

      const results = settled.map((s, i) => s.status === 'fulfilled' ? s.value : {
        sid: sentTargets[i].sid,
        label: sentTargets[i].label,
        status: 'errored',
        text: '',
        reason: s.reason?.message || 'Promise rejected',
        startedAt: sentTargets[i].startedAt,
        completedAt: Date.now(),
      }).map((r, i) => ({
        ...r,
        deliveredIdx: sentTargets[i] && sentTargets[i].deliveredIdx,
      }));
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
        workflowStepIndex,
      });
      const meta = turnRecord.meta || { dispatchMode: 'group' };
      // 被抢占判定：完成时若 meeting 的最新派发序号已超过自己 → 用户已发更新的轮，
      //   本轮是被 supersede 的旧轮。前端据此跳过「清 currentMode」避免抹掉新轮思考态。
      const wasSuperseded = _dispatchSeq != null && meetingDispatchSeq.get(String(meetingId || '')) !== _dispatchSeq;
      const wasInterrupted = results.some(r => r && r.status === 'interrupted');
      const finalStatus = wasInterrupted ? 'interrupted' : 'completed';
      sendToRenderer('groupchat-turn-complete', {
        meetingId, turnNum, mode: 'group', results, meta,
        clientGeneration,
        status: finalStatus,
        superseded: wasSuperseded,
      });
      return { status: finalStatus, turnNum, results, meta, superseded: wasSuperseded, clientGeneration };
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
    interruptGroupChatTurn,
    groupMembersForMeeting,
    getActiveWatchers: () => activeWatchers,
    getGroupChatWatcher: () => groupChatWatcher,
    markProcessExitForSession,
  };
}

module.exports = {
  CODEX_AUTO_EXTRACT_DELAY_MS,
  createGroupChatDispatcher,
  _parseGroupTargets: parseGroupTargets,
  _appendWorkflowStepPrompt: appendWorkflowStepPrompt,
};
