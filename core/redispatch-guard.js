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

// ── 「台账是终态」≠「CLI 结束了」（2026-09-06 合并位的阻断项）────────────────
//
// 硬超时那条链路结算出来的是 status:'failed' + signalSource:'hard_timeout'：
// 台账确实到了终态，但那只是**Hub 不等了**，CLI 那边的任务很可能还在跑。
// 拿它当「可以重发」的授权，就会在旧任务还在跑的时候又发一遍 —— 正是要防的事。
//
// 所以判据反过来写：**只认能正面证明「CLI 这一次已经结束」的信号**，白名单之外一律不算。
// 认不出的新信号源会落到「不确认」，那是安全的方向。

// Hub 单方面放弃等待，CLI 状态未知。
const HUB_GAVE_UP_SOURCES = new Set(['hard_timeout', 'idle_timer', 'watchdog']);
const HUB_GAVE_UP_REASONS = /response_timeout|hard[_\s-]?timeout|timed?[_\s-]?out/i;

// CLI 自己给出的结束信号（或我们确知它已经停了）。
const CLI_ENDED_SOURCES = new Set([
  'stop_hook',                        // Claude 的停止钩子：这一轮真的收尾了
  'stop_reason_terminal',
  'idle_timer_terminal',              // 转录已判终态（不是传输层的 idle 猜测）
  'claude_auto_extract_final_answer',
  'codex_task_complete',
  'provider_final',
  'process_exit_clean',               // 进程退出 = 肯定不在跑了
  'cli_self_exit',
  'pty_exit',
]);

/**
 * 这条尝试记录能不能正面证明「CLI 这一次已经结束」。
 * 证明不了就返回 false —— 包括所有认不出的信号源。
 */
function attemptConfirmsCliEnded(attempt) {
  if (!attempt) return true;
  const status = String(attempt.status || '');
  if (status === 'absent') return true;          // 从来没派出去，自然没在跑
  if (status === 'interrupted') return true;     // 我们主动打断过，CLI 已停
  const source = String(attempt.signalSource || '');
  const reason = String(attempt.reason || '');
  if (HUB_GAVE_UP_SOURCES.has(source) || HUB_GAVE_UP_REASONS.test(reason)) return false;
  if (status === 'completed') return true;       // 拿到了最终结果
  // failed / superseded：只有白名单里的信号源才算 CLI 确认结束
  return CLI_ENDED_SOURCES.has(source);
}

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
function attemptsFor(attempts, { sid, turnNum } = {}) {
  const all = attempts && typeof attempts === 'object' ? Object.values(attempts) : [];
  return all.filter(a => a && a.sid === sid && Number(a.turnNum) === Number(turnNum));
}

function inFlightAttempts(attempts, { sid, turnNum } = {}) {
  return attemptsFor(attempts, { sid, turnNum }).filter(a => !isTerminalAttemptStatus(a.status));
}

/**
 * 这个席位这一轮**最后**那次派发。
 * 只看最后一次，是因为「后面还有一次派发」本身就说明 CLI 接住了新的 prompt ——
 * 更早那些 superseded 记录再纠结也没有意义，而且每次重发都会新增一条 superseded，
 * 一并计较的话第二次自动续跑就会被自己永久堵死（实测踩到）。
 * 真正危险的情形不会被漏掉：最后一次要是硬超时，它自己就是未确认的。
 */
function latestAttempt(attempts, { sid, turnNum } = {}) {
  const list = attemptsFor(attempts, { sid, turnNum });
  if (!list.length) return null;
  const rank = (a) => {
    const wf = a && a.workflowRun;
    if (wf && Number(wf.attempt) > 0) return Number(wf.attempt);
    return Number(a && (a.updatedAt || a.createdAt || a.dispatchAt)) || 0;
  };
  return list.reduce((best, a) => (best === null || rank(a) >= rank(best) ? a : best), null);
}

/** 最后一次派发到了终态、却没有任何「CLI 已结束」的正面证据 —— 最典型的就是硬超时。 */
function unconfirmedAttempts(attempts, { sid, turnNum } = {}) {
  const last = latestAttempt(attempts, { sid, turnNum });
  if (!last || !isTerminalAttemptStatus(last.status)) return [];
  return attemptConfirmsCliEnded(last) ? [] : [last];
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
  // 台账到了终态也不够 —— 硬超时只是 Hub 不等了，CLI 那边可能还在跑。
  const unconfirmed = unconfirmedAttempts(attempts, { sid, turnNum });
  if (unconfirmed.length) {
    return {
      ok: false,
      why: 'cli_end_unconfirmed',
      detail: `${unconfirmed[0].status}/${unconfirmed[0].signalSource || unconfirmed[0].reason || 'unknown'}`,
    };
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
  if (verdict.why === 'cli_end_unconfirmed') return '上一次只是 Hub 停止了等待，没有 CLI 已结束的证据，先继续观察，不重发';
  if (verdict.why === 'cli_still_busy') return 'CLI 仍在跑任务，先继续观察，不重发';
  return '无法确认席位已空闲，先继续观察，不重发';
}

module.exports = {
  BUSY_MARKERS,
  BUSY_TAIL_CHARS,
  HUB_GAVE_UP_SOURCES,
  CLI_ENDED_SOURCES,
  looksBusy,
  attemptsFor,
  latestAttempt,
  attemptConfirmsCliEnded,
  inFlightAttempts,
  unconfirmedAttempts,
  canRedispatch,
  canRedispatchStep,
  describeBlock,
};
