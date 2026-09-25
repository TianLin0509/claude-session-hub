'use strict';

// PTY Claude 的原生身份什么时候可以跟着 CLI 换。
//
// 顶层 CLI 在 TUI 里执行 /clear、/resume，或者退出后在同一个 shell 里重新启动，
// 都会换一个新的 session_id。嵌套进程（模型在 Bash 工具里跑的 `claude -p`）和
// 子代理会继承 CLAUDE_HUB_SESSION_ID，它们的 hook 同样带着别的 session_id 打进来。
// 两者只看 SessionStart 分不开。
//
// 真机实测（2026-09-25，Claude Code TUI）的事件顺序：
//   /clear：SessionEnd(旧 id, reason=clear) → 约 0.6s 后 SessionStart(新 id, source=clear)
//   /exit ：SessionEnd(旧 id, reason=prompt_input_exit)
// 判据：只有「当前绑定的会话自己先宣布结束」之后的新 SessionStart 才允许改绑。
// 嵌套进程或子代理不可能替已绑定的会话发出 SessionEnd，所以串线仍然被拒绝。

const SWITCH_SOURCES = new Set(['clear', 'resume']);
// CLI 真正退出的原因；之后在同一个 shell 里重新启动的 claude 才算接班。
const EXIT_REASONS = new Set(['prompt_input_exit', 'logout', 'other', 'bypass_permissions_disabled']);
const SWITCH_WINDOW_MS = 30_000;

function createClaudeIdentitySwitch({ now = () => Date.now(), windowMs = SWITCH_WINDOW_MS } = {}) {
  const ended = new Map(); // hubSessionId -> { id, reason, at }
  return {
    /**
     * @returns {{action:'record-end'|'rebind'|'same'|'ignore', why?:string}}
     */
    observe(hubSessionId, { event, boundId, incomingId, source = null, reason = null, agentId = null } = {}) {
      if (!hubSessionId || !incomingId) return { action: 'ignore', why: 'no-identity' };
      if (agentId) return { action: 'ignore', why: 'subagent' };
      if (event === 'session-end') {
        if (!boundId || incomingId !== boundId) return { action: 'ignore', why: 'foreign-end' };
        ended.set(hubSessionId, { id: boundId, reason: reason || null, at: now() });
        return { action: 'record-end' };
      }
      if (event !== 'session-start') return { action: 'ignore', why: 'not-lifecycle' };
      if (!boundId || incomingId === boundId) return { action: 'same' };
      const end = ended.get(hubSessionId);
      if (!end || end.id !== boundId) return { action: 'ignore', why: 'bound-session-still-running' };
      const src = String(source || '');
      const accepted = SWITCH_SOURCES.has(src)
        ? now() - end.at <= windowMs
        : src === 'startup' && EXIT_REASONS.has(String(end.reason || ''));
      if (!accepted) return { action: 'ignore', why: `unproven-${src || 'unknown'}-after-${end.reason || 'end'}` };
      ended.delete(hubSessionId);
      return { action: 'rebind' };
    },
    forget(hubSessionId) { ended.delete(hubSessionId); },
    _ended: ended,
  };
}

// /clear 不触发 UserPromptSubmit，提交闭环等不到「开工」确认，会补回车再报 stuck。
// 它真正的确认是 Hub 跟随到了新身份（main.js 在改绑成功时 emit 这个事件）。
function observeClaudeClearCommand(manager, sessionId) {
  let result = null;
  const listener = event => { if (event && event.sessionId === sessionId) result = { ok: true }; };
  manager.on('claude-identity-switched', listener);
  return {
    async wait(timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      while (!result && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 60));
      return result || { ok: false, message: '未收到 Claude /clear 后的新会话身份，请检查终端' };
    },
    dispose() { manager.removeListener('claude-identity-switched', listener); },
  };
}

module.exports = { createClaudeIdentitySwitch, observeClaudeClearCommand, SWITCH_WINDOW_MS, EXIT_REASONS };
