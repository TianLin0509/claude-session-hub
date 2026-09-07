'use strict';
/**
 * 「这一步现在可以安全地重发吗？」—— 发送之前的状态证据与重发互斥（纯函数，不碰 IO）。
 *
 * 2026-09-06 合并位的阻断项：`ensureMemberReady` 对所有非 dormant 状态直接放行；
 * 会话持续为 running、第一轮报错且没有最终答案时，引擎照样派发了尝试 2。
 * 而 `sendToPty` 的确认发生在**输入之后**，它证明的是「这一次提交被 CLI 收下了」，
 * 不能证明「上一次任务已经结束」。两者解决的不是同一个问题。
 *
 * 这里要的是**发送之前的正向证据**，判据只用两条硬事实，都不是「静默了多久」：
 *   ① 尝试台账：这个席位在这一轮还有没有未收敛（非终态）的尝试。台账是持久化的
 *      客观记录，比任何时间窗都可靠。
 *   ② CLI 自己吐出来的忙碌标记：TUI 在跑任务时会显示 "esc to interrupt" 这类字样。
 *      它出现 = 明确在忙。**它不出现不等于空闲**，所以只当否决票用，不当放行票。
 *
 * 拿不到证据时的态度：**不放行**。合并位的原话是「无法确认时继续观察或明确暂停」——
 * 所以这里返回 ok:false + why:'cannot_confirm_idle'，由调用方继续观察，
 * 观察预算耗尽再明确暂停。宁可慢，也不要在旧任务还在跑的时候又发一遍。
 */

const { isTerminalAttemptStatus } = require('./groupchat-attempt-protocol.js');

// CLI 正在跑任务时才会出现的字样。只用来否决，不用来放行。
const BUSY_MARKERS = {
  claude: [/esc to interrupt/i, /\besc\b.{0,12}\binterrupt\b/i],
  deepseek: [/esc to interrupt/i],
  kimi: [/esc to interrupt/i],
  codex: [/esc to interrupt/i, /\bWorking\b/],
  gemini: [/esc to cancel/i, /esc to interrupt/i],
};

// 只看 buffer 末尾：TUI 会重绘，历史里出现过的忙碌标记不代表现在在忙。
const BUSY_TAIL_CHARS = 2000;

function looksBusy(buffer, kind) {
  const tail = String(buffer || '').slice(-BUSY_TAIL_CHARS);
  if (!tail) return false;
  const patterns = BUSY_MARKERS[String(kind || '').toLowerCase()] || [];
  return patterns.some(re => re.test(tail));
}

/**
 * 这个席位在这一轮的尝试收敛了没有。
 * 只看同 sid + 同 turnNum 的记录：非终态就是「上一次派发还没收场」。
 */
function inFlightAttempts(attempts, { sid, turnNum } = {}) {
  const all = attempts && typeof attempts === 'object' ? Object.values(attempts) : [];
  return all.filter(a => a
    && a.sid === sid
    && Number(a.turnNum) === Number(turnNum)
    && !isTerminalAttemptStatus(a.status));
}

/**
 * 现在可不可以给这个席位重发。
 *   attempts     orchestrator 的尝试台账（state.attempts）
 *   sid/turnNum  席位与轮次
 *   buffer/kind  PTY 缓冲与 CLI 类型（可选；给忙碌标记用）
 *   ledgerKnown  台账是否真的可读（false = 拿不到证据，一律不放行）
 * 返回 { ok, why }
 */
function canRedispatch({ attempts, sid, turnNum, buffer, kind, ledgerKnown = true } = {}) {
  if (!sid || !Number(turnNum)) return { ok: false, why: 'cannot_confirm_idle' };
  if (!ledgerKnown) return { ok: false, why: 'cannot_confirm_idle' };
  const pending = inFlightAttempts(attempts, { sid, turnNum });
  if (pending.length) {
    return { ok: false, why: 'attempt_still_in_flight', detail: pending[0].status };
  }
  if (looksBusy(buffer, kind)) return { ok: false, why: 'cli_still_busy' };
  return { ok: true, why: 'previous_attempt_settled' };
}

/** 一整步（可能有多个席位）都能重发才算能重发。 */
function canRedispatchStep(seats = []) {
  for (const seat of seats) {
    const verdict = canRedispatch(seat);
    if (!verdict.ok) return Object.assign({ sid: seat && seat.sid }, verdict);
  }
  return { ok: true, why: 'previous_attempt_settled' };
}

function describeBlock(verdict) {
  if (!verdict || verdict.ok) return '';
  if (verdict.why === 'attempt_still_in_flight') return '上一次派发还没收场，先继续观察，不重发';
  if (verdict.why === 'cli_still_busy') return 'CLI 仍在跑任务，先继续观察，不重发';
  return '无法确认席位已空闲，先继续观察，不重发';
}

module.exports = {
  BUSY_MARKERS,
  BUSY_TAIL_CHARS,
  looksBusy,
  inFlightAttempts,
  canRedispatch,
  canRedispatchStep,
  describeBlock,
};
