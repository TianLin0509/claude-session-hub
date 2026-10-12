'use strict';
// Token Plan 额度用完 → 千问 / GLM / DeepSeek 旧 Harness 会话改走 DeepSeek API 的副作用一半。
// 判断与状态在 core/token-plan-fallback.js；启动参数的改道在 core/acp-profiles.js。
//
// 三条规矩：
//   1. 改道只靠「休眠 → 按原会话重新启动」，原生历史接着用，群聊成员身份与卡片都保留。
//   2. 重发只走 groupChatWatcher.sendToPty 这条闭环，且只重发「额度墙挡住、没执行」的那一条，一次。
//      群聊成员不自动重发：群聊这一轮已经按失败收尾，由用户点重试（重试时已在 DeepSeek 上）。
//   3. 每次改道都在会话卡片上留一条看得见的提示，写明重置时间与「按量计费」。
const fallback = require('../core/token-plan-fallback');
const { isAcpKind } = require('../core/acp-profiles');

const CONTINUATION_NOTE = '（Hub 提示：上一条消息因阿里云 Token Plan 额度用完没有执行，本会话已改用 DeepSeek API。'
  + '请完成下面这条请求；如果之前已经做了一部分，从中断处接着做。）';

function createTokenPlanFallbackController(deps = {}) {
  const {
    sessionManager, getConfig, dataDir,
    restartSession,
    sendToPty = (...args) => require('../core/group-chat-watcher').sendToPty(...args),
    readUsage = null,
    logger = console,
    now = Date.now,
    settleMs = 500,
  } = deps;
  if (!sessionManager || typeof restartSession !== 'function' || !dataDir) {
    throw new Error('token-plan-fallback-controller 缺少依赖');
  }
  const switching = new Map();
  const lastPrompt = new Map();
  const handled = new Set();

  function routeOf(session) {
    if (!session || !isAcpKind(session.kind)) return null;
    if (fallback.isDeepSeekRouteProfile(session.acpProfileId)) return 'deepseek';
    if (fallback.isTokenPlanRouteProfile(session.acpProfileId)) return 'token-plan';
    return null;
  }
  function notice(sessionId, message) {
    try { sessionManager.getNativeSession?.(sessionId)?.emit('action-error', message); }
    catch (error) { logger.warn('[token-plan-fallback] notice failed:', error.message); }
  }
  function resetText() {
    const at = fallback.exhaustedUntil(dataDir, now());
    return at ? `北京时间 ${fallback.formatReset(at)} 重置` : '重置时间未知';
  }

  function desiredRoute() { return fallback.resolveRoute({ config: getConfig(), dataDir, now: now() }).route; }
  // 两个方向都切：套餐用完 → DeepSeek；到了重置时间（或用量回落）→ 回到套餐，不再多花 DeepSeek 的钱。
  function needsSwitch(sessionId) {
    const current = routeOf(sessionManager.getSession?.(sessionId));
    return !!current && current !== desiredRoute();
  }

  // 同一会话并发的改道请求合并成一次。
  function switchSession(sessionId) {
    if (switching.has(sessionId)) return switching.get(sessionId);
    const task = (async () => {
      const target = desiredRoute();
      const result = await restartSession(sessionId, null, { relaunch: true });
      if (!result || result.ok === false) throw new Error(result?.message || '会话重启失败');
      const session = sessionManager.getSession?.(sessionId);
      if (routeOf(session) !== target) throw new Error('会话重启后线路没有变化');
      const native = sessionManager.getNativeSession?.(sessionId);
      await native?.start?.();
      const model = native?.options?.model || session.currentModel?.id || '';
      notice(sessionId, target === 'deepseek'
        ? fallback.deepseekRouteNotice(model, dataDir, now())
        : `Token Plan 额度已恢复，本会话已切回套餐 · ${model}。`);
      logger.log(`[token-plan-fallback] ${String(sessionId).slice(0, 8)} switched to ${target} (${model})`);
      return session;
    })().finally(() => switching.delete(sessionId));
    switching.set(sessionId, task);
    return task;
  }

  // 发送前调用：线路与套餐状态不符就先切再发。失败时如实抛出，消息不发。
  async function beforeSend(sessionId) {
    if (!needsSwitch(sessionId)) return false;
    // 会话还在答上一轮：不打断它，这条照常进原线路的队列，下一条再切。
    const runtime = sessionManager.getNativeSession?.(sessionId)?.runtime;
    if (runtime && ['starting', 'running', 'waiting'].includes(runtime.state) && runtime.connection === 'connected') return false;
    try { await switchSession(sessionId); return true; }
    catch (error) {
      const toDeepSeek = desiredRoute() === 'deepseek';
      throw Object.assign(new Error((toDeepSeek ? 'Token Plan 额度已用完，切到 DeepSeek API 失败：' : 'Token Plan 额度已恢复，切回套餐失败：')
        + error.message + '；消息未发送'), { notSent: true });
    }
  }

  // resend=false：只切线路不重发（证据只来自用量读数时，失败的这一轮可能与额度无关、已执行了一部分）。
  async function onQuota(sessionId, text, turnKey, { resend = true } = {}) {
    if (handled.has(turnKey)) return;
    handled.add(turnKey);
    if (handled.size > 500) handled.delete(handled.values().next().value);
    fallback.markExhausted(dataDir, { resetsAt: fallback.parseResetAt(text, now()), source: 'session', now: now() });
    const route = fallback.resolveRoute({ config: getConfig(), dataDir, now: now() });
    if (route.route !== 'deepseek') {
      notice(sessionId, `Token Plan 本月额度已用完（${resetText()}）。Hub 没有配置 DeepSeek API Key，不能自动改道；在设置里填好 DeepSeek Key 后重发即可。`);
      return;
    }
    const session = sessionManager.getSession?.(sessionId);
    // 取出即消费：同一条 prompt 最多自动重发一次。
    const prompt = lastPrompt.get(sessionId);
    lastPrompt.delete(sessionId);
    // 让失败的这一轮先在原会话里落盘收尾，再休眠重启。
    await new Promise(resolve => setTimeout(resolve, settleMs));
    // 等待期间用户或群聊重试已经经 beforeSend 切过线路：不再重启，也不重发（新的一轮已经在跑）。
    if (!needsSwitch(sessionId) && !switching.has(sessionId)) return;
    const startedAt = now();
    logger.log(`[token-plan-fallback] ${String(sessionId).slice(0, 8)} quota wall hit; switching (resend=${resend && !session?.meetingId && !!prompt})`);
    try { await switchSession(sessionId); }
    catch (error) {
      logger.warn(`[token-plan-fallback] ${String(sessionId).slice(0, 8)} switch failed after ${now() - startedAt} ms:`, error.message);
      notice(sessionId, `Token Plan 额度已用完，自动切到 DeepSeek API 失败：${error.message}。可手动重启会话后重发。`);
      return;
    }
    logger.log(`[token-plan-fallback] ${String(sessionId).slice(0, 8)} switch took ${now() - startedAt} ms`);
    if (!resend || session?.meetingId || !prompt) return;
    try {
      const receipt = await sendToPty(sessionId, CONTINUATION_NOTE + '\n\n' + prompt, session.kind, {
        requireReady: false, clientSubmissionId: `token-plan-fallback-${now()}`,
      });
      if (!receipt || receipt.ok === false) notice(sessionId, '已切到 DeepSeek API，但自动重发未获确认；请在卡片里核对后再决定是否手动重发。');
    } catch (error) {
      notice(sessionId, `已切到 DeepSeek API，自动重发失败：${error.message}。请手动重发上一条。`);
    }
  }

  async function checkUsageAfterError(sessionId, turnKey) {
    if (typeof readUsage !== 'function' || handled.has(turnKey)) return;
    let snapshot = null;
    try { snapshot = await readUsage(); } catch { return; }
    fallback.observeUsage(dataDir, snapshot, now());
    if (fallback.exhaustedUntil(dataDir, now())) await onQuota(sessionId, '', turnKey, { resend: false });
  }

  // main.js 在把 ACP 生命周期事件交给 transcriptTap 之前调用。Qwen Code 把额度墙包成一条普通回答，
  // 这里统一改成本轮失败，群聊与手机助理才不会把「Quota exhausted」当答卷。
  function filterLifecycle(event) {
    if (!event || !event.hubSessionId) return event;
    const session = sessionManager.getSession?.(event.hubSessionId);
    const route = routeOf(session);
    if (event.type === 'prompt-submitted' && typeof event.text === 'string') {
      // 只为挂在套餐上的会话记下最近一条，供撞墙后重发。
      if (route !== 'token-plan') return event;
      const text = require('../core/memory-index-envelope').splitMemoryIndex(event.text).userText;
      if (text && !text.startsWith(CONTINUATION_NOTE)) lastPrompt.set(event.hubSessionId, text);
      return event;
    }
    if (!['turn-complete', 'turn-error'].includes(event.type) || route !== 'token-plan') return event;
    const turnKey = `${event.hubSessionId}:${event.turnId || event.completedAt || now()}`;
    // 正常回答只认 Qwen 那条短的额度墙原文；讨论 insufficient_quota 的长回答不算。
    const quota = event.type === 'turn-complete'
      ? fallback.isTokenPlanQuotaAnswer(event.text)
      : fallback.isTokenPlanQuotaText([event.message, event.errorInfo, event.text].filter(v => typeof v === 'string').join(' '));
    if (quota) {
      const evidence = [event.text, event.message].filter(v => typeof v === 'string').join(' ');
      void onQuota(event.hubSessionId, evidence, turnKey).catch(error => logger.warn('[token-plan-fallback] quota handling failed:', error.message));
      if (event.type === 'turn-complete') {
        return { ...event, type: 'turn-error', message: String(event.text || '').slice(0, 600), errorInfo: 'token_plan_quota', failedAt: event.completedAt };
      }
      return { ...event, errorInfo: event.errorInfo || 'token_plan_quota' };
    }
    if (event.type === 'turn-error') {
      void checkUsageAfterError(event.hubSessionId, turnKey).catch(error => logger.warn('[token-plan-fallback] usage check failed:', error.message));
    }
    return event;
  }

  function observeUsage(snapshot) {
    try { return fallback.observeUsage(dataDir, snapshot, now()); }
    catch (error) { logger.warn('[token-plan-fallback] usage observe failed:', error.message); return null; }
  }

  return { filterLifecycle, beforeSend, needsSwitch, switchSession, observeUsage, routeOf, CONTINUATION_NOTE };
}

module.exports = { createTokenPlanFallbackController, CONTINUATION_NOTE };
