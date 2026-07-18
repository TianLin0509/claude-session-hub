'use strict';

const groupChatWatcher = require('../../core/group-chat-watcher.js');
const { createTurnCompletionWatcher } = require('../../core/turn-completion-watcher.js');
const pasteTrappedDetector = require('../../core/paste-trapped-detector.js');

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
const AUTH_FAILURE_RE = /(not logged in|please run\s+\/login|run\s+\/login|authentication required|login required)/i;

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
    sendToRenderer,
    sessionManager,
    transcriptTap,
  } = deps;

  groupChatWatcher.init({ sessionManager, cliReadyDetector, transcriptTap });

  const groupChatInProgress = new Set();
  const patchListenersBySid = new Map();
  const activeWatchers = new Map();
  const pasteTrappedMonitors = new Map();

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
    const hostShellHeartbeat = setInterval(() => {
      if (watcher.isSettled()) { clearInterval(hostShellHeartbeat); return; }
      const buf = sessionManager.getSessionBuffer(sid) || '';
      if (AUTH_FAILURE_RE.test(buf)) {
        warn(`[group-chat] auth failure detected for ${label}(${sid.slice(0, 8)}) - marking errored`);
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
    const targets = targetMembers.map(member => {
      const committeeSeatKey = meeting.scene === 'committee'
        ? require('../../core/committee-scene.js').SEAT_ORDER[member.index]
        : null;
      const systemPromptText = groupchat.buildSystemPromptText(member.displayName, meeting.scene, {
        kind: member.kind,
        seatKey: committeeSeatKey,
      });
      return {
        sid: member.sid,
        kind: member.kind,
        label: member.displayName,
        member,
        prompt: `${systemPromptText}\n\n${userInput || ''}`,
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
    const results = settled.map((s, i) => s.status === 'fulfilled' ? s.value : {
      sid: sentTargets[i].sid,
      label: sentTargets[i].label,
      status: 'errored',
      text: '',
      reason: s.reason?.message || 'Promise rejected',
    });
    return { status: 'completed', turnNum: null, results, meta: { dispatchMode: 'internal' } };
  }

  async function dispatchGroupChatTurn(meetingId, {
    userInput,
    turnTimeoutMs,
    targetMemberIds,
    silent,
    allowActiveExtend,
    appendUserMessage,
    reuseTurnNum,
    dispatchMode,
  } = {}) {
    if (groupChatInProgress.has(meetingId)) return { status: 'busy', turnNum: null };
    groupChatInProgress.add(meetingId);
    try {
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
        const committeeSeatKey = meeting.scene === 'committee'
          ? require('../../core/committee-scene.js').SEAT_ORDER[member.index]
          : null;
        const systemPromptText = groupchat.buildSystemPromptText(member.displayName, meeting.scene, {
          kind: member.kind,
          seatKey: committeeSeatKey,
        });
        return {
          sid: member.sid,
          kind: member.kind,
          label: member.displayName,
          member,
          deliveredIdx,
          prompt: orch.buildFirstDelta(member.sid, userInput || '', systemPromptText, {
            currentUserMessageAppended: begin.didAppendUserMessage,
          }),
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

      // 投委会等编排式调用可传 turnTimeoutMs：卡住的成员到点强制 skip，
      // 不阻塞整轮（防 paste-trapped 无限等待）。普通群聊保持无硬超时。
      const settled = await Promise.allSettled(sentTargets.map(t =>
        waitTurnComplete(t.sid, t.label, {
          meetingId, mode: 'group', turnNum, kind: t.kind, prompt: t.prompt, promptSubmitSinceTs: t.promptSubmitSinceTs,
          disableHardTimeout: !(Number(turnTimeoutMs) > 0),
          hardTimeoutMs: Number(turnTimeoutMs) > 0 ? Number(turnTimeoutMs) : undefined,
          allowActiveExtend,
          silent,
          onPartial: silent ? null : (partial) => {
            sendToRenderer('groupchat-partial-update', {
              meetingId, turnNum, mode: 'group',
              sid: partial.sid, label: partial.label,
              status: partial.status,
              text: partial.text,
              blocks: partial.blocks,
              source: partial.source,
              thinkSec: partial.thinkSec, tokens: partial.tokens,
              cleanBufLen: partial.cleanBufLen,
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
      }).map((r, i) => ({
        ...r,
        deliveredIdx: sentTargets[i] && sentTargets[i].deliveredIdx,
      }));
      const memberBySid = {};
      for (const m of members) memberBySid[m.sid] = m;
      if (silent) {
        orch.rollbackTurn(turnNum);
        return { status: 'completed', turnNum: null, results, meta: { dispatchMode: 'silent' } };
      }
      const turnRecord = orch.completeTurn(turnNum, userInput || '', results, memberBySid, {}, {
        dispatchMode: dispatchMode || 'group',
      });
      const meta = turnRecord.meta || { dispatchMode: 'group' };
      sendToRenderer('groupchat-turn-complete', { meetingId, turnNum, mode: 'group', results, meta });
      return { status: 'completed', turnNum, results, meta };
    } finally {
      groupChatInProgress.delete(meetingId);
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
    getActiveWatchers: () => activeWatchers,
    getGroupChatWatcher: () => groupChatWatcher,
    markProcessExitForSession,
  };
}

module.exports = {
  CODEX_AUTO_EXTRACT_DELAY_MS,
  createGroupChatDispatcher,
  _parseGroupTargets: parseGroupTargets,
};
