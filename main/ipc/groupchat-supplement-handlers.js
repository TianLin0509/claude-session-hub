'use strict';
/*
 * 群聊插话（用户补充）· IPC
 * ────────────────────────────────────────────────────────────────────────────
 *
 * 修的是这个：开发群聊的循环跑起来之后，你在群聊输入框打一句话，renderer 走的是
 * `loop:start`，主进程看到循环已在跑就返回 already_running，消息被退回输入框 ——
 * 你以为说了，其实一个字都没送出去，也没落盘。
 *
 * 这条路的语义是「给当前任务补一句话」，不是「开一个新任务」：
 *   1. 先落盘（原文、身份、顺序都留在群聊消息里，看得见也查得到）；
 *   2. 当前正在跑的那位即时收到 —— 现代 CLI 支持在回答中接新 prompt，
 *      走的是和派工一样的闭环提交（分块 → settle → 语义确认 → 有界补回车），
 *      **不是**盲发回车；
 *   3. 待命的那位不唤醒，只在账本里记一格；它下次真的被派工时，
 *      dispatcher 把没送到的原文补进 prompt。
 *
 * 它不开新一轮、不抢占当前步骤、不重置返工预算、不改阶段。
 * 送不出去就如实返回，账本保留待确认 —— 不提前标已读，也不盲目重发。
 */

// 即时注入时给一层很薄的框，让 agent 知道这是维护者插的一句话，
// 不是新的任务书，也不是「该交接了」的信号。刻意短：长了会挤占它正在做的事。
function wrapImmediate(text) {
  return [
    '## 维护者插话（不是新任务，也不是交接信号）',
    String(text || ''),
    '按当前阶段职责消化这句话；不要因此重置任务、重做已完成的部分，或提前交接。',
  ].join('\n');
}

function registerGroupchatSupplementIpc(ipcMain, deps) {
  const {
    getActiveWatchers,
    getHubDataDir,
    groupchat,
    groupChatWatcher,
    logger = console,
    meetingManager,
    sendToRenderer = () => {},
    sessionManager,
  } = deps || {};
  if (!ipcMain || !groupchat || !meetingManager || !sessionManager) return;

  /** 现在真的在跑的成员。以 dispatcher 的活跃 watcher 为准，它才是「这一刻谁在回答」。 */
  function runningSidsOf(memberSids) {
    const watchers = typeof getActiveWatchers === 'function' ? getActiveWatchers() : null;
    if (!watchers || typeof watchers.get !== 'function') return [];
    return memberSids.filter(sid => {
      const watcher = watchers.get(sid);
      if (!watcher) return false;
      return typeof watcher.isSettled === 'function' ? !watcher.isSettled() : true;
    });
  }

  ipcMain.handle('groupchat:user-supplement', async (_event, args = {}) => {
    const meetingId = typeof args.meetingId === 'string' ? args.meetingId : '';
    const text = typeof args.text === 'string' ? args.text : '';
    if (!meetingId || !text.trim()) return { ok: false, reason: 'invalid_args' };
    const meeting = meetingManager.getMeeting(meetingId);
    if (!meeting || !meeting.groupChat) return { ok: false, reason: 'group_chat_not_found' };

    let orch;
    try { orch = groupchat.getOrchestrator(getHubDataDir(), meetingId); }
    catch (error) {
      logger.warn('[groupchat-supplement] orchestrator unavailable:', error && error.message);
      return { ok: false, reason: 'meeting_state_unavailable' };
    }

    // 收件人是群里所有成员，休眠的也算 —— 它被唤醒派工时会补收，
    // 但**不为了刷「全员已读」额外唤醒它**。
    const memberSids = (Array.isArray(meeting.subSessions) ? meeting.subSessions : [])
      .map(sid => String(sid || '').trim()).filter(Boolean);
    if (!memberSids.length) return { ok: false, reason: 'no_members' };

    const added = orch.appendUserSupplement(text, { recipientSids: memberSids, source: 'input-box' });
    if (!added) return { ok: false, reason: 'empty_text' };

    const deliveredNow = [];
    const failures = [];
    for (const sid of runningSidsOf(memberSids)) {
      const session = sessionManager.getSession(sid);
      const kind = session ? (session.transcriptKind || session.kind) : null;
      if (!kind) { failures.push({ sid, reason: 'no_session' }); continue; }
      try {
        // requireReady:false —— CLI 正在回答，本来就活着；再走一次冷启动轮询只会白等。
        const result = await groupChatWatcher.sendToPty(sid, wrapImmediate(text), kind, { requireReady: false });
        if (result && result.ok) {
          orch.markUserSupplementsDelivered(sid, [added.seq]);
          deliveredNow.push(sid);
        } else {
          failures.push({ sid, reason: (result && result.reason) || 'send_failed', sendStatus: result && result.sendStatus });
        }
      } catch (error) {
        failures.push({ sid, reason: (error && error.message) || 'send_exception' });
      }
    }

    try {
      sendToRenderer('groupchat-user-supplement', {
        meetingId, seq: added.seq, revision: orch.state.revision,
        deliveredNow, pendingCount: memberSids.length - deliveredNow.length,
      });
    } catch (error) { logger.warn('[groupchat-supplement] renderer notify failed:', error && error.message); }

    return {
      ok: true,
      seq: added.seq,
      deliveredNow,
      // 没即时送到的不是「失败」，是「等它下次运行时补」。前端要按这个说人话。
      pendingSids: memberSids.filter(sid => !deliveredNow.includes(sid)),
      failures,
    };
  });
}

module.exports = { registerGroupchatSupplementIpc, _test: { wrapImmediate } };
