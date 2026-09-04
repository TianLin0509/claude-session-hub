'use strict';
// main/ipc/prompt-submit-handlers.js
// 普通会话「下方输入框 → PTY」的闭环发送（2026-09-03）。
//
// 在此之前这条路是**开环**的：renderer 写完 bracketed paste 之后，在 700/900/1100ms
//   三个固定时刻盲发 \r，发完就不管了。长 prompt 时 node-pty 的 inSocket 队列还没排空，
//   三个 \r 全被并进 BP_END 那一块当粘贴尾巴吃掉 —— 内容躺在 CLI 输入框里折叠成
//   [Pasted text +N lines]，没人再按一次回车，也没有任何 UI 提示，用户干等。
//
// 项目里其他调用方早就不走裸 'terminal-input' 了（study-handlers.js 那条注释写得很清楚），
//   agent-league / chatgpt-bridge / chuxin / 群聊派发全部走 group-chat-watcher.sendToPty。
//   这里把最后一条裸路径也接进去，普通会话与群聊从此共用同一套：
//     分块投喂 → 体积自适应 settle（等折叠标记出现就提前收工）→ 单发 \r
//     → 等 Claude UserPromptSubmit / Codex task_started 语义确认 → 缺确认才补一次回车
//     → 仍无确认就如实返回 stuck，由前端亮「补发」按钮。
//
// 非 paste-sensitive 的会话（powershell 等宿主 shell）保持原来的 text + '\r' 直写：
//   它们没有 paste-detect，走 sendToPty 只会白白吃掉几秒等待。

const { isPasteSensitive } = require('../../core/ai-kinds.js');
const groupChatWatcher = require('../../core/group-chat-watcher.js');

// 每个会话串行化。用户连按两下回车时两次 sendToPty 会并发写同一个 PTY，
//   分块投喂下两条 payload 会交错成一团乱码 —— 这是分块引入的新风险，入口挡掉。
const _queues = new Map();

function enqueue(sessionId, task) {
  const prev = _queues.get(sessionId) || Promise.resolve();
  // task 内部自己 catch，所以链上不会有 rejection；仍加 catch 兜底防队列断裂。
  const next = prev.then(task);
  const tail = next.catch(() => {});
  _queues.set(sessionId, tail);
  // 队尾还是自己时才摘链，否则会把排在后面的人一起丢掉。
  tail.then(() => {
    if (_queues.get(sessionId) === tail) _queues.delete(sessionId);
  });
  return next;
}

function firstLine(text) {
  const line = String(text || '').split(/\r?\n/).find(x => String(x || '').trim());
  return line ? line.slice(0, 160) : '';
}

function registerPromptSubmitIpc(ipcMain, deps) {
  const {
    sessionManager,
    logger = console,
  } = deps;

  // 「补发」按钮要重放原文，所以记住每个会话最后一次提交的 prompt。
  //   每会话只留最后一条，且只在内存里 —— 不做持久化，prompt 可能含敏感内容。
  const lastPromptBySid = new Map();

  // sessionManager 没有 close/exit 事件（只 emit output / session-updated /
  //   agent-turn-started / managed-launch），所以不挂监听，改成每次发送时顺手扫一遍：
  //   getSession 返回 null 的就是已经没了的会话。会话数是几十量级，代价可忽略。
  function pruneClosedSessions() {
    for (const sid of lastPromptBySid.keys()) {
      if (!sessionManager.getSession(sid)) lastPromptBySid.delete(sid);
    }
  }

  function resolveKind(sessionId) {
    const session = sessionManager.getSession(sessionId);
    if (!session) return null;
    return session.transcriptKind || session.kind || null;
  }

  ipcMain.handle('session:send-prompt', async (_event, request = {}) => {
    const sessionId = typeof request.sessionId === 'string' ? request.sessionId : '';
    const text = typeof request.text === 'string' ? request.text : '';
    if (!sessionId || !text) return { ok: false, error: 'bad-request' };
    const kind = resolveKind(sessionId);
    if (!kind) return { ok: false, error: 'no-session' };

    // 宿主 shell：没有 paste-detect，直写最快也最准。
    if (!isPasteSensitive(kind)) {
      sessionManager.writeToSession(sessionId, `${text}\r`);
      return { ok: true, sendStatus: 'ok', mode: 'plain-shell', kind };
    }

    pruneClosedSessions();
    lastPromptBySid.set(sessionId, text);
    return enqueue(sessionId, async () => {
      try {
        // requireReady:false —— 输入框就摆在用户面前，CLI 已经在跑；
        //   再走一次 60s 冷启动 ready 轮询会把「打完字立刻发」变成有时干等几十秒。
        const result = await groupChatWatcher.sendToPty(sessionId, text, kind, { requireReady: false });
        if (!result || result === false) {
          return { ok: false, error: 'send-failed', kind };
        }
        const sendStatus = (result && result.sendStatus) || 'ok';
        if (sendStatus === 'stuck') {
          logger.warn(`[prompt-submit] ${kind}(${sessionId.slice(0, 8)}) prompt not acknowledged; renderer will offer manual resend`);
        }
        return {
          ok: true,
          kind,
          sendStatus,
          mode: 'closed-loop',
          enterAttempts: result.enterAttempts || null,
          acknowledgementSource: result.acknowledgementSource || null,
        };
      } catch (error) {
        logger.warn('[prompt-submit] send threw:', error && error.message);
        return { ok: false, error: 'send-threw', message: error && error.message, kind };
      }
    });
  });

  // 「⚠ 未提交 · 补发」按钮。复用群聊那条手动补发路径：它会先用 prompt 首行指纹
  //   判断原文是否还留在输入框里 —— 在 → 只补回车；不在 → 整条重写再提交。
  //   直接盲发回车会在「原文其实没进去」时提交一个空输入框。
  ipcMain.handle('session:resend-prompt', async (_event, request = {}) => {
    const sessionId = typeof request.sessionId === 'string' ? request.sessionId : '';
    if (!sessionId) return { ok: false, error: 'bad-request' };
    const kind = resolveKind(sessionId);
    if (!kind) return { ok: false, error: 'no-session' };
    const prompt = lastPromptBySid.get(sessionId);
    if (!prompt) return { ok: false, error: 'no-prompt' };
    return enqueue(sessionId, async () => {
      try {
        const result = await groupChatWatcher.resendCurrentPrompt({
          sid: sessionId,
          kind,
          prompt,
          promptHeader: firstLine(prompt),
        });
        return { ...result, kind };
      } catch (error) {
        logger.warn('[prompt-submit] resend threw:', error && error.message);
        return { ok: false, error: 'resend-threw', message: error && error.message, kind };
      }
    });
  });

  return {
    _test: { lastPromptBySid, firstLine, enqueue, pruneClosedSessions },
  };
}

module.exports = { registerPromptSubmitIpc };
