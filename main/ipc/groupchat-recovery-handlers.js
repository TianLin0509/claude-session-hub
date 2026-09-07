'use strict';

const { isCodexCliKind } = require('../../core/ai-kinds.js');
const WSR = require('../../core/workflow-step-result.js');
const DevDiscuss = require('../../core/dev-discuss.js');
const { resumeWorkflowRun } = require('../groupchat/workflow-resume.js');

function registerGroupchatRecoveryIpc(ipcMain, deps) {
  const {
    dispatchGroupChatTurn,
    getHubDataDir,
    getActiveWatchers,
    groupchat,
    groupChatWatcher,
    isWorkflowRunning = () => false,
    getLoopEngine = () => null,
    logger = console,
    meetingManager,
    sendToRenderer,
    sessionManager,
    transcriptTap,
  } = deps;

  // ── 统一的「采用本步回答」写入口（2026-09-07 Claude 1）────────────────────
  // 三种来源汇到这一条路：provider 自动完成、用户点「同步回答」（从转录读回来）、
  // 用户手动粘贴。以前粘贴/重提只更新气泡，循环那边读的是另一份证据，于是出现
  // 「卡片好了、循环没动」，再点「继续」还会把同一个成员重新问一遍。
  //
  // 两条写法分支只是**时机**不同，写的是同一份活状态：
  //   watcher 还活着 → manualExtract 结算它，等在上面的 dispatch Promise 直接 resolve，
  //                    循环自己就推进到下一步；
  //   watcher 已经不在 → 写进 orchestrator 的 turn/消息，随后「同步回答」唤醒引擎，
  //                     由活状态闸门推过去（引擎判定只认这份活状态）。
  // 采用来源如实记在 signalSource 上：手动粘贴永远标成 manual_paste，
  // 不冒充 provider 的自动完成事件。
  function adoptStepResult({
    meetingId, orch, meeting, session, sid, text, sourceLabel = null, extractMode = null,
    providerTurnIdHint = null, requestedTurn = null, readCurrentTurn = () => null,
    origin = 'extract',
  }) {
    const adoptedStatus = origin === 'paste' ? 'manual_paste' : 'manual_extracted';
    const adoptedSignal = origin === 'paste' ? 'manual_paste' : 'manual';
    // watcher settle 只允许作用于"当前进行中的轮"：用户点旧轮的「重新提取」时，
    //   绝不能把旧轮文本结算进正在飞行的新轮（watcher 劫持 = 新轮答案被旧内容顶掉）。
    // 二轮加固（多方审查）：currentTurn 在 await extractLatestTurn 之后**重读**——
    //   提取期间用户可能已发下一轮（抢占式连发），旧快照会把旧轮文本 settle 进新轮 watcher。
    //   orch 存在但 currentTurn 无效（如投委会 internal 阶段 currentTurn=0）时，带 turnNum
    //   的请求不放行 watcher（internal watcher 不属于任何编号轮），走 patch 路径。
    const watcher = getActiveWatchers().get(sid);
    const freshCurrentTurn = readCurrentTurn();
    const watcherOwnsRequestedTurn = requestedTurn === null
      || (freshCurrentTurn !== null ? requestedTurn === freshCurrentTurn : !orch);
    if (watcher && watcherOwnsRequestedTurn) {
      watcher.manualExtract(text);
      return { ok: true, text: text, source: sourceLabel, mode: 'watcher_settle', extractMode: extractMode || null };
    }

    if (meetingId) {
      try {
        if (orch) {
          const turns = Array.isArray(orch.state.turns) ? orch.state.turns : [];
          const targetTurn = requestedTurn !== null
            ? turns.find(t => t && t.n === requestedTurn)
            : turns[turns.length - 1];
          if (targetTurn) {
            const attemptId = targetTurn.attemptIdBy && targetTurn.attemptIdBy[sid];
            const providerTurnId = targetTurn.providerTurnIdBy && targetTurn.providerTurnIdBy[sid];
            const patched = orch.patchTurnResult(targetTurn.n, sid, {
              text: text,
              status: adoptedStatus,
              ...(attemptId ? { attemptId } : {}),
              ...(targetTurn.runId ? { runId: targetTurn.runId } : {}),
              ...(providerTurnId ? { providerTurnId } : {}),
              signalSource: adoptedSignal,
            });
            if (patched) {
              const revision = typeof orch.reserveRevision === 'function'
                ? orch.reserveRevision('manual_result_published', {
                    attemptId, runId: targetTurn.runId, turnNum: targetTurn.n, sid, status: adoptedStatus,
                  })
                : null;
              sendToRenderer('groupchat-turn-patched', {
                meetingId,
                turnNum: targetTurn.n,
                ...(targetTurn.runId ? { runId: targetTurn.runId } : {}),
                ...(attemptId ? { attemptId } : {}),
                sid,
                charCount: (text || '').length,
                ...(revision ? { revision } : {}),
              });
              return { ok: true, text: text, source: sourceLabel, mode: 'patch_groupchat_turn', extractMode: extractMode || null };
            }
          }
          // turns 只在全员结算后创建。当前/中断轮已有用户消息时，直接把成功提取的
          // 文本写入该轮的持久消息，优先保住可用结果，而不是误报“状态文件损坏”。
          const recoverTurnNum = requestedTurn !== null ? requestedTurn : freshCurrentTurn;
          const recoverUserMsg = recoverTurnNum !== null
            ? (orch.state.messages || []).find(m => m && m.role === 'user' && Number(m.turnNum) === Number(recoverTurnNum))
            : null;
          if (recoverUserMsg) {
            const memberIndex = meeting && Array.isArray(meeting.subSessions)
              ? meeting.subSessions.indexOf(sid)
              : -1;
            const memberSpec = memberIndex >= 0 && Array.isArray(meeting.slotSpecs)
              ? meeting.slotSpecs[memberIndex]
              : null;
            const pendingReceipt = orch.state.pendingPrompts
              && orch.state.pendingPrompts[String(recoverTurnNum)]
              && orch.state.pendingPrompts[String(recoverTurnNum)][sid];
            const patched = orch.patchTurnResult(recoverTurnNum, sid, {
              text: text,
              status: adoptedStatus,
              memberId: memberIndex >= 0 ? ((memberSpec && memberSpec.memberId) || `m${memberIndex + 1}`) : undefined,
              speaker: session?.title || session?.kind || 'AI',
              ...(pendingReceipt && pendingReceipt.attemptId ? { attemptId: pendingReceipt.attemptId } : {}),
              ...(pendingReceipt && pendingReceipt.runId ? { runId: pendingReceipt.runId } : {}),
              ...(providerTurnIdHint || (pendingReceipt && pendingReceipt.providerTurnId)
                ? { providerTurnId: providerTurnIdHint || pendingReceipt.providerTurnId }
                : {}),
              signalSource: adoptedSignal,
            });
            if (patched) {
              const revision = typeof orch.reserveRevision === 'function'
                ? orch.reserveRevision('manual_result_published', {
                    attemptId: pendingReceipt && pendingReceipt.attemptId,
                    runId: pendingReceipt && pendingReceipt.runId,
                    turnNum: recoverTurnNum,
                    sid,
                    status: adoptedStatus,
                  })
                : null;
              sendToRenderer('groupchat-turn-patched', {
                meetingId,
                turnNum: recoverTurnNum,
                ...(pendingReceipt && pendingReceipt.runId ? { runId: pendingReceipt.runId } : {}),
                ...(pendingReceipt && pendingReceipt.attemptId ? { attemptId: pendingReceipt.attemptId } : {}),
                sid,
                charCount: (text || '').length,
                ...(revision ? { revision } : {}),
              });
              return { ok: true, text: text, source: sourceLabel, mode: 'recover_inflight_turn', extractMode: extractMode || null };
            }
          }
          // 群聊调用（带 meetingId）但目标轮不存在/patch 失败：诚实报错。
          //   旧行为返回 ok:true + mode:'text_only'，UI 显示"已同步"但气泡纹丝不动
          //   ——用户感知就是"重新提取失败/没反应"。
          return {
            ok: false,
            reason: 'turn_not_found',
            detail: `提取到 ${text.length} 字，但第 ${requestedTurn !== null ? requestedTurn : '(最新)'} 轮不在群聊记录中，无法写回。可能该轮已被回滚或状态文件损坏。`,
          };
        }
      } catch (err) {
        logger.warn('[manual-extract] patch lastTurn failed:', err.message);
        return { ok: false, reason: 'patch_failed', detail: err.message };
      }
    }

    return { ok: true, text: text, source: sourceLabel, mode: 'text_only', extractMode: extractMode || null };
  }

  // 「重提 / 同步回答」的提取链。抽成具名函数是为了让 workflow:sync-step 能直接复用，
  //   而不是在两处各写一份提取逻辑 —— 那正是「三种来源各走各的路」的老毛病。
  async function runManualExtract({ meetingId, sid, sincePromptTs, turnNum } = {}) {
    if (!sid) return { ok: false, reason: 'missing_sid' };

    const session = sessionManager.getSession(sid);
    const kind = session?.kind || 'unknown';
    const runtimeKind = session?.transcriptKind || kind;

    // 2026-07-12 道雪：轮次窗口改由 orchestrator 状态推导，不再信 renderer 的
    //   _gcTurnStartTs（那是"当前轮"的开始时间，对旧轮重提取完全错位；Hub 重启后是 0）。
    //   u{n}.createdAt 做下界、u{n+1}（该轮之后首条用户消息）做上界。
    const requestedTurn = Number.isFinite(Number(turnNum)) ? Number(turnNum) : null;
    let orch = null;
    let meeting = null;
    if (meetingId) {
      try {
        meeting = meetingManager.getMeeting(meetingId);
        if (meeting) orch = groupchat.getOrchestrator(getHubDataDir(), meetingId);
      } catch (err) {
        logger.warn('[manual-extract] orchestrator load failed:', err && err.message);
      }
      // 二轮加固（多方审查）：群聊调用拿不到 orchestrator 时诚实失败——旧行为会静默
      //   绕过旧轮拒绝/窗口推导，最后走 text_only 假成功（UI"已同步"但气泡不变）。
      if (!orch) {
        return { ok: false, reason: 'meeting_state_unavailable', detail: '群聊状态不可用（meeting 不存在或状态文件读取失败），无法定位轮次写回。' };
      }
    }
    const readCurrentTurn = () => (orch && Number.isFinite(orch.state.currentTurn) && orch.state.currentTurn > 0
      ? orch.state.currentTurn : null);
    let effectiveSince = Math.max(0, Number(sincePromptTs) || 0);
    let untilTs = null;
    let isLatestTurn = true;
    const orchCurrentTurn = readCurrentTurn();
    if (orch && requestedTurn !== null) {
      const msgs = Array.isArray(orch.state.messages) ? orch.state.messages : [];
      const userMsg = msgs.find(m => m && m.id === `u${requestedTurn}` && m.role === 'user');
      if (userMsg && Number.isFinite(userMsg.createdAt)) effectiveSince = userMsg.createdAt;
      const nextUser = msgs.find(m => m && m.role === 'user' && Number(m.turnNum) > requestedTurn);
      if (nextUser && Number.isFinite(nextUser.createdAt)) untilTs = nextUser.createdAt;
      if (orchCurrentTurn !== null && requestedTurn < orchCurrentTurn) isLatestTurn = false;
      // 二轮加固：要精确重提取"旧轮"但该轮用户消息缺失（被回滚/旧 schema 无 turnNum）
      //   → 无法建立轮次窗口，提取必然错位，诚实拒绝。当前轮保留宽松兜底（语义本就是"抓最新"）。
      if (!isLatestTurn && !userMsg) {
        return {
          ok: false,
          reason: 'turn_window_unavailable',
          detail: `第 ${requestedTurn} 轮的用户消息不在群聊记录中，无法建立提取窗口（可能已被回滚或为旧版本数据）。旧轮内容请点「原文」核对。`,
        };
      }
    }

    // 非 Codex 后端只能读"最新回答"，对旧轮重提取会拿到最新轮内容 → 张冠李戴。
    //   诚实拒绝，提示用户用「原文」核对旧轮，而不是静默写错数据。
    if (!isLatestTurn && !isCodexCliKind(runtimeKind)) {
      return {
        ok: false,
        reason: 'old_turn_resync_unsupported',
        detail: `该 AI（kind=${kind}）的 transcript 只能读取最新一轮回答，无法精确重提取第 ${requestedTurn} 轮（会误拿最新轮内容）。旧轮内容请点「原文」核对。`,
      };
    }

    let extracted = null;
    try {
      extracted = await transcriptTap.extractLatestTurn(sid, effectiveSince, { untilTs });
    } catch (err) {
      return { ok: false, reason: 'extract_failed', detail: err.message };
    }
    if (!extracted || !extracted.text) {
      // PTY/streaming 兜底只对"最新轮"有意义：旧轮内容早已不在流式缓冲里。
      if (isLatestTurn) {
        try {
          const fromPty = groupChatWatcher.extractStreamingText(sid, runtimeKind);
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
    }
    if (!extracted || !extracted.text) {
      const extractMode = extracted?.extractMode || null;
      let detail;
      if (extractMode === 'no_rollout_bound') {
        detail = `Codex rollout 文件尚未绑定（kind=${kind}）。可能原因：（a）当天目录 ~/.codex/sessions/<今日>/ 还没新文件；（b）codex spawn 时的 cwd 与 rollout session_meta.cwd 不一致；（c）timestamp 超出绑定窗口 [-10s, +5min]。建议：等 5-10s（codex 通常 spawn 后才写 rollout 首行），或点"🔧 进 shell"看真实 PTY 输出确认 codex 是否真的启动了。`;
      } else if (extractMode === 'no_task_complete_yet') {
        detail = `Codex 已绑定 rollout 但${isLatestTurn ? '' : `第 ${requestedTurn} 轮窗口内`} task_complete 事件${isLatestTurn ? '尚未写入' : '未找到'}（kind=${kind}）。可能原因：（a）codex 仍在思考；（b）codex 在等 MCP 工具确认弹窗（如 ai-team team_respond），需要进 shell 点"Allow"；（c）codex 多 task 场景含 3s debounce，最后一个 task 完成后才 emit。建议：点"🔧 进 shell"看 codex 当前是否被 confirm 弹窗阻塞。`;
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

    const adopted = adoptStepResult({
      meetingId, orch, meeting, session, sid,
      text: extracted.text,
      sourceLabel: extracted.source,
      extractMode: extracted.extractMode || null,
      providerTurnIdHint: extracted.turnId || null,
      requestedTurn,
      readCurrentTurn,
      origin: 'extract',
    });
    return adopted;
  }

  ipcMain.handle('groupchat-manual-extract', async (_e, args = {}) => runManualExtract(args || {}));

  ipcMain.handle('groupchat-resend-prompt', async (_e, { meetingId, sid, turnNum: requestedTurnNum } = {}) => {
    if (!meetingId || !sid) return { ok: false, reason: 'invalid_args' };
    const meeting = meetingManager.getMeeting(meetingId);
    if (!meeting || !meeting.groupChat) return { ok: false, reason: 'group_chat_not_found' };
    const orch = groupchat.getOrchestrator(getHubDataDir(), meetingId);
    const parsedTurnNum = Number(requestedTurnNum);
    const turnNum = Number.isInteger(parsedTurnNum) && parsedTurnNum > 0
      ? parsedTurnNum
      : orch.state.currentTurn;
    if (!turnNum) {
      return { ok: false, reason: 'no_turn_yet' };
    }
    const userMsg = (orch.state.messages || []).find(
      m => m && m.id === `u${turnNum}` && m.role === 'user'
    );
    // Prefer the exact durable prompt prepared by the dispatcher (system
    // instructions + incremental context + optional hero).  A historical
    // settled message also carries sourcePrompt.  Raw user text is only the
    // final legacy fallback; resending it alone silently changes semantics.
    const activePrompt = typeof orch.getActivePrompt === 'function'
      ? orch.getActivePrompt(turnNum, sid)
      : null;
    const assistantMsg = (orch.state.messages || []).find(
      m => m && m.role === 'assistant' && Number(m.turnNum) === Number(turnNum) && m.sid === sid
    );
    const promptText = activePrompt?.prompt || assistantMsg?.sourcePrompt || (userMsg && userMsg.content);
    if (!promptText) {
      return { ok: false, reason: 'no_user_input' };
    }
    const session = sessionManager.getSession(sid);
    const kind = session ? (session.transcriptKind || session.kind) : 'unknown';
    try {
      return await groupChatWatcher.resendCurrentPrompt({
        sid,
        kind,
        prompt: promptText,
        promptHeader: String(promptText).split(/\r?\n/).find(line => line.trim())?.slice(0, 160) || '',
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

  ipcMain.handle('groupchat-resend-participant', async (_e, { meetingId, sid, turnNum: requestedTurnNum } = {}) => {
    if (!meetingId || !sid) return { ok: false, reason: 'invalid_args' };
    if (typeof dispatchGroupChatTurn !== 'function') return { ok: false, reason: 'retry_unavailable' };
    const meeting = meetingManager.getMeeting(meetingId);
    if (!meeting || !meeting.groupChat) return { ok: false, reason: 'group_chat_not_found' };
    if (isWorkflowRunning(meetingId)) return { ok: false, reason: 'workflow_running' };
    const activeWatcher = getActiveWatchers().get(sid);
    if (activeWatcher && !activeWatcher.isSettled()) return { ok: false, reason: 'participant_still_running' };
    const orch = groupchat.getOrchestrator(getHubDataDir(), meetingId);
    if (orch.state.currentMode && orch.state.currentMode !== 'idle') {
      return { ok: false, reason: 'turn_still_running' };
    }
    const parsedTurnNum = Number(requestedTurnNum);
    const turnNum = Number.isInteger(parsedTurnNum) && parsedTurnNum > 0
      ? parsedTurnNum
      : orch.state.currentTurn;
    const userMsg = (orch.state.messages || []).find(
      m => m && m.role === 'user' && Number(m.turnNum) === Number(turnNum)
    );
    if (!userMsg || !String(userMsg.content || '').trim()) return { ok: false, reason: 'no_user_input' };
    const memberIndex = Array.isArray(meeting.subSessions) ? meeting.subSessions.indexOf(sid) : -1;
    if (memberIndex < 0) return { ok: false, reason: 'participant_not_in_meeting' };
    const memberSpec = Array.isArray(meeting.slotSpecs) ? meeting.slotSpecs[memberIndex] : null;
    const memberId = (memberSpec && memberSpec.memberId) || `m${memberIndex + 1}`;
    try {
      const result = await dispatchGroupChatTurn(meetingId, {
        userInput: userMsg.content,
        targetMemberIds: [memberId],
        reuseTurnNum: turnNum,
        appendUserMessage: false,
        dispatchMode: 'retry',
        // 「重新让本成员回答」同样不设死墙钟：到点强杀只会再造一条假终态。
        //   等不下去时用「停止」，或者「手动提供回答」把 CLI 里的正文直接给进来。
      });
      const participantResult = result && Array.isArray(result.results)
        ? result.results.find(item => item && item.sid === sid)
        : null;
      const success = !!(result && result.status === 'completed'
        && participantResult
        && ['completed', 'manual_extracted'].includes(participantResult.status)
        && String(participantResult.text || '').trim());
      return {
        ok: success,
        result,
        participant: participantResult,
        ...(success ? {} : { reason: participantResult?.reason || participantResult?.status || result?.reason || result?.status || 'retry_failed' }),
      };
    } catch (err) {
      logger.error('[groupchat-resend-participant] threw:', err);
      return { ok: false, reason: 'exception', detail: err && err.message };
    }
  });
  // -- 状态栏 / 粘贴弹窗共用的「当前这一步是什么情况」--------------------------
  // 状态栏那个 chip 以前直读 loopState.status，是出事那一刻写下的字：
  //   答案后来补进来了，它还写着「已暂停」，用户看不出点下去是推进还是重跑。
  // 现在标签和引擎行为都从 decideResumeAction 这一个判据派生，不可能再对不上。
  function describeWorkflowStep(meetingId) {
    const meeting = meetingManager.getMeeting(meetingId);
    if (!meeting || !meeting.groupChat) return { ok: false, reason: 'group_chat_not_found' };
    const workflow = meeting.serialWorkflow || {};
    const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
    const loopState = workflow.loopState || null;
    const serialState = workflow.serialRunState || null;

    let kind = null; let stepIndex = null; let turnNum = null; let runId = null; let status = null;
    let targetMemberIds = [];
    if (loopState && ['running', 'paused', 'stopped_user'].includes(loopState.status)) {
      kind = 'loop';
      status = loopState.status;
      runId = loopState.runId || null;
      turnNum = Number(loopState.currentTurnNum) || null;
      const round = Math.max(0, Number(loopState.round) || 0);
      const reviewerPhase = String(loopState.currentStep || '') === 'reviewer';
      stepIndex = round * 2 + (reviewerPhase ? 1 : 0);
      targetMemberIds = (steps[reviewerPhase ? 1 : 0] || []).filter(Boolean);
    } else if (serialState && ['running', 'paused', 'stopped_user'].includes(serialState.status)) {
      kind = 'serial';
      status = serialState.status;
      runId = serialState.runId || null;
      turnNum = Number(serialState.currentTurnNum) || null;
      const raw = serialState.currentStepIndex !== null && serialState.currentStepIndex !== undefined
        ? Number(serialState.currentStepIndex)
        : Number(serialState.nextStepIndex);
      stepIndex = Number.isFinite(raw) ? raw : 0;
      targetMemberIds = (steps[stepIndex] || []).filter(Boolean);
    } else {
      return { ok: true, kind: null, active: false };
    }

    const specs = Array.isArray(meeting.slotSpecs) ? meeting.slotSpecs : [];
    const subSessions = Array.isArray(meeting.subSessions) ? meeting.subSessions : [];
    const sidForMember = (memberId) => {
      let index = specs.findIndex((spec, i) => String((spec && spec.memberId) || ('m' + (i + 1))) === String(memberId));
      if (index < 0) {
        const legacy = /^m(\d+)$/.exec(String(memberId || ''));
        index = legacy ? Number(legacy[1]) - 1 : -1;
      }
      return index >= 0 ? (subSessions[index] || null) : null;
    };

    let orchState = null;
    try {
      const orch = groupchat.getOrchestrator(getHubDataDir(), meetingId);
      orchState = orch && (typeof orch.getState === 'function' ? orch.getState() : orch.state);
      if (!turnNum && orchState && Number(orchState.currentTurn) > 0) turnNum = Number(orchState.currentTurn);
    } catch (err) {
      logger.warn('[workflow-step-context] orchestrator load failed:', err && err.message);
    }
    const turn = orchState ? ((orchState.turns || []).find(t => t && Number(t.n) === Number(turnNum)) || null) : null;

    const members = targetMemberIds.map(memberId => {
      const sid = sidForMember(memberId);
      const session = sid ? sessionManager.getSession(sid) : null;
      const result = WSR.liveResultFor({ turn, messages: orchState && orchState.messages, turnNum, sid });
      return {
        memberId,
        sid,
        label: (session && (session.title || session.kind)) || memberId,
        hasResult: WSR.resultIsUsable(result),
        status: result.status,
        textLength: result.textLength,
      };
    });

    const decision = WSR.decideResumeAction({
      turn,
      messages: orchState && orchState.messages,
      turnNum,
      targetSids: members.map(m => m.sid).filter(Boolean),
      stopped: status === 'stopped_user',
      discussing: DevDiscuss.isDiscussing(meeting),
    });
    const nextStep = steps[Number(stepIndex) + 1] || [];
    const nextLabel = nextStep.map(id => {
      const sid = sidForMember(id);
      const session = sid ? sessionManager.getSession(sid) : null;
      return (session && (session.title || session.kind)) || id;
    }).join(' / ');
    const chip = WSR.describeResumeAction(decision, {
      stepLabel: '第 ' + (Number(stepIndex) + 1) + ' 步',
      nextLabel,
    });

    return {
      ok: true,
      active: true,
      kind,
      status,
      runId,
      stepIndex,
      turnNum,
      members,
      decision: { action: decision.action, why: decision.why, missingSids: decision.missingSids || [] },
      chip,
      running: !!isWorkflowRunning(meetingId),
    };
  }

  ipcMain.handle('workflow:step-context', async (_e, { meetingId } = {}) => {
    try {
      if (!meetingId) return { ok: false, reason: 'no_meeting_id' };
      return describeWorkflowStep(meetingId);
    } catch (err) {
      logger.error('[workflow:step-context] threw:', err);
      return { ok: false, reason: 'exception', detail: err && err.message };
    }
  });

  // -- 「同步回答」：只找答案，永远不发 prompt --------------------------------
  // 有答案就采用并把流程接上；没有就如实说「还没找到，可以手动粘贴」，继续等。
  // 它替代了原来那个含义含糊的「已暂停 · 继续」——那个按钮会清零重试计数并重新派发，
  // 于是 agent 明明已经答完了还被再问一遍（2026-09-07 维护者实测）。
  ipcMain.handle('workflow:sync-step', async (_e, { meetingId } = {}) => {
    if (!meetingId) return { ok: false, reason: 'no_meeting_id' };
    const before = describeWorkflowStep(meetingId);
    if (!before.ok) return before;
    if (!before.active) return { ok: false, reason: 'no_active_step' };
    if (before.decision.action === 'blocked') {
      return { ok: false, reason: before.decision.why, detail: before.chip.hint };
    }
    // 注意：拆掉死墙钟之后，「正在跑」多数时候的真实含义是「正在等这一步的回答」。
    //   所以这里不能再一律拒绝 —— 那会把用户唯一的救援入口挡在门外。
    //   等待中采用是安全的：watcher 还活着，adoptStepResult 会用 manualExtract 结算它，
    //   等在上面的 dispatch Promise 直接 resolve，引擎自己就往下走，无需再唤醒一次。
    const engineAlreadyRunning = !!before.running;

    // 缺口席位逐个再找一次转录。这里复用 groupchat-manual-extract 的整条提取链，
    //   包括它对旧轮、身份和 final_answer 的既有判据 —— 自动侧一个字都没放松。
    const tried = [];
    if (before.decision.action !== 'advance') {
      for (const member of before.members) {
        if (member.hasResult || !member.sid) continue;
        try {
          const outcome = await runManualExtract({
            meetingId, sid: member.sid, turnNum: before.turnNum,
          });
          tried.push({
            sid: member.sid, label: member.label,
            ok: !!(outcome && outcome.ok),
            reason: outcome && (outcome.reason || null),
            detail: outcome && (outcome.detail || null),
          });
        } catch (err) {
          tried.push({ sid: member.sid, label: member.label, ok: false, reason: (err && err.message) || 'exception' });
        }
      }
    }

    const after = describeWorkflowStep(meetingId);
    if (!after.ok || !after.active) return after;
    if (after.decision.action !== 'advance') {
      return {
        ok: true,
        adopted: false,
        advanced: false,
        reason: 'awaiting_result',
        tried,
        context: after,
        message: after.chip.hint,
      };
    }
    const resumed = engineAlreadyRunning
      ? { ok: true, alreadyRunning: true }
      : resumeWorkflowRun(getLoopEngine(), meetingId, { logger });
    return {
      ok: true,
      adopted: tried.some(item => item.ok),
      advanced: !!resumed.ok,
      tried,
      context: after,
      message: resumed.ok
        ? '已采用本步回答，流程继续（不会再问一遍）'
        : ('已采用本步回答，但流程没能自动继续：' + (resumed.reason || 'unknown')),
      ...(resumed.ok ? {} : { resumeReason: resumed.reason }),
    };
  });

  // -- 手动粘贴：人已经亲眼看过 CLI 里的回答，直接给 -------------------------
  // 自动提取拿不到的场景是真实存在的：用户自己在 CLI 里敲了「继续」，provider 开的是
  // 新 turn，attemptEventMatches 的 provider_turn_mismatch 会正当地拒掉那个事件；
  // Codex 的 task_complete 也可能还没落盘。那时候人就是唯一的判据。
  // 这里**不放宽自动提取的匹配规则**，只是另开一条明确标注为人工的路径。
  ipcMain.handle('groupchat-adopt-pasted-result', async (_e, { meetingId, sid, text, token } = {}) => {
    try {
      if (!meetingId || !sid) return { ok: false, reason: 'invalid_args' };
      const body = String(text == null ? '' : text);
      if (!body.trim()) {
        return { ok: false, reason: 'empty_text', detail: WSR.describeAdoptionRejection('empty_text'), keepText: true };
      }
      const context = describeWorkflowStep(meetingId);
      if (!context.ok) return context;
      if (!context.active) return { ok: false, reason: 'no_active_step' };

      const member = (context.members || []).find(item => item && item.sid === sid) || null;
      const verdict = WSR.validateAdoptionToken(token || {}, {
        meetingId,
        sid,
        runId: context.runId,
        turnNum: context.turnNum,
        stepIndex: context.stepIndex,
        stopped: context.status === 'stopped_user' || context.decision.action === 'blocked',
        alreadyAdopted: !!(member && member.hasResult),
      });
      if (!verdict.ok) {
        return { ok: false, reason: verdict.reason, detail: WSR.describeAdoptionRejection(verdict.reason), keepText: true };
      }

      const meeting = meetingManager.getMeeting(meetingId);
      const session = sessionManager.getSession(sid);
      let orch = null;
      try { orch = groupchat.getOrchestrator(getHubDataDir(), meetingId); }
      catch (err) { logger.warn('[adopt-paste] orchestrator load failed:', err && err.message); }
      if (!orch) return { ok: false, reason: 'meeting_state_unavailable', keepText: true };

      const readCurrentTurn = () => (Number.isFinite(orch.state.currentTurn) && orch.state.currentTurn > 0
        ? orch.state.currentTurn : null);
      const adopted = adoptStepResult({
        meetingId, orch, meeting, session, sid,
        text: body,
        sourceLabel: 'manual_paste',
        requestedTurn: context.turnNum,
        readCurrentTurn,
        origin: 'paste',
      });
      if (!adopted || !adopted.ok) return { ...(adopted || { ok: false, reason: 'adopt_failed' }), keepText: true };

      const after = describeWorkflowStep(meetingId);
      let resumed = { ok: false, reason: 'not_needed' };
      if (after.ok && after.active && after.decision.action === 'advance' && !after.running) {
        resumed = resumeWorkflowRun(getLoopEngine(), meetingId, { logger });
      }
      return {
        ok: true,
        adopted: true,
        mode: adopted.mode,
        advanced: !!resumed.ok,
        context: after,
        message: resumed.ok
          ? '已采用你提供的回答，流程继续（原成员不会被再问一遍）'
          : ((after.ok && after.active && after.decision.action !== 'advance')
            ? '已保存你提供的回答；本步还有成员没交回答，继续等'
            : '已采用你提供的回答'),
      };
    } catch (err) {
      logger.error('[groupchat-adopt-pasted-result] threw:', err);
      return { ok: false, reason: 'exception', detail: err && err.message, keepText: true };
    }
  });
}

module.exports = {
  registerGroupchatRecoveryIpc,
};
