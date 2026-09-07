'use strict';
/**
 * 循环自愈的判断逻辑（纯函数，不碰 IO、不碰会话）。
 *
 * 要解决的事（2026-09-06 维护者报）：群聊中途 agent 被打断——网络抖一下、额度到顶——
 * 循环就停在那里等人点「恢复」；而实际上 agent 过一会儿自己就好了，甚至答案后来还
 * 补进了转录，Hub 却已经不看了。
 *
 * 两条腿，边界完全不同：
 *   腿一「迟到答案回收」是**只读**的：重新去看这一步的证据/转录有没有补上来。
 *   腿二「自动续跑」是**有副作用**的：它会再发一次 prompt。所以门槛必须高得多 ——
 *     必须是传输/可用性类失败、必须没被用户接管、必须没超次数和总时限、
 *     而且额度类要么解析出可靠的重置时刻，要么走有界退避，**绝不猜一个时间去重发**。
 *
 * 语义类失败（阻断项没解决、轮次用尽、用户停止、讨论阶段）永远不自动续 ——
 * 那不是故障，是结论。
 */

// 传输/可用性类：换个时间或换个人就可能好。判据来自 dispatcher/watcher 实际会给出的 reason。
const TRANSPORT_REASONS = [
  'response_timeout',
  'participant_result_missing',
  'step_not_completed',
  'transcript_binding_pending',
  'send_failed',
  'cli_self_exit',
  'pty exit',
  'promise rejected',
  'reviewer_unavailable',
  'errored',
  'no_subs',
];

// 明确不该自动续的：这些是人的决定或流程结论。
const SEMANTIC_REASONS = [
  'interrupted',
  'superseded',
  'stopped_user',
  'dev_discuss_phase',
  'workflow_member_missing',
  'loop_requires_builder_and_reviewer',
  'serial_workflow_not_enabled',
  'group_chat_not_found',
  'workflow_state_persist_failed',
];

const QUOTA_HINTS = [
  /session limit/i, /usage limit/i, /rate limit/i, /quota/i, /too many requests/i,
  /额度/, /限流/, /用量已达/,
];

const DEFAULT_LIMITS = {
  maxAutoResumes: 3,            // K：自动重发的次数上限
  totalWindowMs: 30 * 60_000,   // 传输类总时限：超过就老实暂停
  quotaWindowMs: 6 * 60 * 60_000, // 额度类总时限：解析出重置时刻时才可能用满
  harvestTickMs: 60_000,        // 迟到答案的巡检间隔
  baseBackoffMs: 60_000,        // 传输类退避基数（指数，封顶 backoffCapMs）
  backoffCapMs: 5 * 60_000,
  blindQuotaBackoffMs: 10 * 60_000, // 解析不出重置时刻时的固定退避——不猜时间
};

function limitsWith(overrides) {
  return Object.assign({}, DEFAULT_LIMITS, overrides || {});
}

function looksLikeQuota(text) {
  const s = String(text || '');
  return QUOTA_HINTS.some(re => re.test(s));
}

/** 这次暂停属于哪一类：user / semantic / quota / transport / unknown。 */
function classifyPause({ reason, rawText, userStopped } = {}) {
  if (userStopped) return 'user';
  const r = String(reason || '').toLowerCase();
  if (SEMANTIC_REASONS.some(x => r.includes(x.toLowerCase()))) return 'semantic';
  if (r.includes('reviewer_unavailable') || looksLikeQuota(rawText)) return 'quota';
  if (TRANSPORT_REASONS.some(x => r.includes(x.toLowerCase()))) return 'transport';
  return 'unknown';
}

// ── 额度重置时刻的解析 ──────────────────────────────────────────────────────
//
// 只认「能算准」的写法。CLI 横幅常见形如：
//   You've hit your session limit · resets 6am (America/Los_Angeles)
//   try again in 45 minutes
// 带时区名的用 Intl 精确换算（Node 自带完整 ICU），不是估算；时区名不认识就返回 null。
// 返回 null 的含义是「不知道」，调用方必须走有界退避，而不是编一个时间出来。

function tzOffsetMs(ts, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = {};
  for (const p of dtf.formatToParts(new Date(ts))) parts[p.type] = p.value;
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second),
  );
  return asUtc - ts;
}

/** 在指定时区里，找 now 之后最近的一个 hh:mm。时区无效返回 null。 */
function nextLocalTime(now, hour, minute, timeZone) {
  try {
    const offset = tzOffsetMs(now, timeZone);
    const local = new Date(now + offset);
    let guess = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour, minute, 0) - offset;
    // 换算回来后再用目标时刻自己的偏移校正一次（跨夏令时边界时会差一小时）
    guess -= (tzOffsetMs(guess, timeZone) - offset);
    if (guess <= now) {
      guess += 24 * 3_600_000;
      const corrected = guess - (tzOffsetMs(guess, timeZone) - tzOffsetMs(guess - 24 * 3_600_000, timeZone));
      guess = corrected;
    }
    return guess > now ? guess : null;
  } catch (error) {
    return null;   // 时区名不认识：算不准就说不知道
  }
}

function parseQuotaResetAt(text, now = Date.now(), fallbackTimeZone = null) {
  const s = String(text || '');
  if (!s) return null;

  // "try again in 45 minutes" / "in 2 hours"
  const rel = /(?:try again|retry|resets?)\s+in\s+(\d+)\s*(second|minute|hour)s?/i.exec(s);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const ms = unit === 'second' ? 1000 : unit === 'minute' ? 60_000 : 3_600_000;
    return n > 0 ? now + n * ms : null;
  }

  // "resets 6am (America/Los_Angeles)" / "resets at 6:30 pm"
  const abs = /resets?\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?/i.exec(s);
  if (abs) {
    let hour = Number(abs[1]) % 12;
    if (abs[3].toLowerCase() === 'p') hour += 12;
    const minute = Number(abs[2] || 0);
    const tzMatch = /\(([A-Za-z]+\/[A-Za-z_+\-0-9]+)\)/.exec(s);
    const timeZone = tzMatch ? tzMatch[1] : fallbackTimeZone;
    if (!timeZone) return null;    // 没有时区就算不准，宁可说不知道
    return nextLocalTime(now, hour, minute, timeZone);
  }
  return null;
}

/**
 * 下一步该做什么。
 * 入参全是纯数据，方便逐条测：
 *   pauseClass  classifyPause 的结果
 *   attempts    已经自动续跑过几次
 *   startedAt   进入自愈的时刻
 *   now / deadlineTs / rawText / limits
 * 返回 { action: 'harvest' | 'wait' | 'redispatch' | 'stop', waitMs, until, why }
 */
function planRecovery(input = {}) {
  const limits = limitsWith(input.limits);
  // 用 isFinite 而不是 ||：时间戳 0 是合法值（单测里就用 0 起算），|| 会把它当缺省
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const startedAt = Number.isFinite(Number(input.startedAt)) ? Number(input.startedAt) : now;
  const attempts = Math.max(0, Number(input.attempts) || 0);
  const pauseClass = input.pauseClass || 'unknown';

  if (input.userStopped) return { action: 'stop', why: 'user_stopped' };
  if (pauseClass === 'user') return { action: 'stop', why: 'user_stopped' };
  if (pauseClass === 'semantic') return { action: 'stop', why: 'not_a_transport_failure' };
  if (pauseClass === 'unknown') return { action: 'stop', why: 'unclassified_failure' };
  if (input.deadlineTs && now >= Number(input.deadlineTs)) return { action: 'stop', why: 'deadline_passed' };

  const windowMs = pauseClass === 'quota' ? limits.quotaWindowMs : limits.totalWindowMs;
  if (now - startedAt >= windowMs) return { action: 'stop', why: 'recovery_window_exhausted' };
  if (attempts >= limits.maxAutoResumes) return { action: 'stop', why: 'auto_resume_exhausted' };

  if (pauseClass === 'quota') {
    const resetAt = parseQuotaResetAt(input.rawText, now, input.fallbackTimeZone);
    if (resetAt && resetAt > now) {
      if (resetAt - startedAt > windowMs) return { action: 'stop', why: 'reset_beyond_window' };
      return { action: 'wait', waitMs: resetAt - now, until: resetAt, why: 'quota_reset_at' };
    }
    // 解析不出就固定退避，绝不猜一个时间点去重发
    return { action: 'wait', waitMs: limits.blindQuotaBackoffMs, until: now + limits.blindQuotaBackoffMs, why: 'quota_backoff_unparsed' };
  }

  const backoff = Math.min(limits.backoffCapMs, limits.baseBackoffMs * Math.pow(2, attempts));
  return { action: 'wait', waitMs: backoff, until: now + backoff, why: 'transport_backoff' };
}

/**
 * 迟到的答案能不能采用。
 * 读是没有副作用的，**采用它并推进流程是有副作用的**，所以身份必须逐项对上：
 * 同一个 run、同一步、同一个会话，而且这一步自己的完成判据也要成立。
 * 「旧尝试迟到」在这里被挡住：证据里的 attempt 大于当前尝试号才是新的，小的一律不采用。
 */
function canAdoptLateAnswer({ evidence, expect, text, isDone } = {}) {
  const e = expect || {};
  if (e.userStopped) return { ok: false, why: 'user_stopped' };
  if (evidence) {
    const entry = evidence.entry || {};
    if (String(entry.runId || '') !== String(e.runId || '')) return { ok: false, why: 'run_mismatch' };
    if (Number(entry.stepIndex) !== Number(e.stepIndex)) return { ok: false, why: 'step_mismatch' };
    if (e.turnNum && Number(evidence.turnNum) !== Number(e.turnNum)) return { ok: false, why: 'turn_mismatch' };
    if (Number(entry.attempt) > 0 && Number(e.attempt) > 0 && Number(entry.attempt) < Number(e.attempt)) {
      return { ok: false, why: 'stale_attempt' };
    }
  }
  const body = String(text || '').trim();
  if (!body) return { ok: false, why: 'no_text' };
  if (typeof isDone === 'function' && !isDone(body)) return { ok: false, why: 'step_contract_unmet' };
  return { ok: true, why: 'late_answer_adopted' };
}

/** 给人看的一行中文，进群聊和工作台。永远不要静默重试。 */
function describePlan(plan, context = {}) {
  const attempt = Number(context.attempt) || 0;
  const stepLabel = context.stepLabel || '本步';
  if (!plan) return '';
  if (plan.action === 'wait') {
    const mins = Math.max(1, Math.round((plan.waitMs || 0) / 60_000));
    const untilText = plan.until ? new Date(plan.until).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
    const why = plan.why === 'quota_reset_at' ? `额度限制，等到 ${untilText} 重置`
      : plan.why === 'quota_backoff_unparsed' ? `额度限制，横幅里没有能算准的重置时刻，先等 ${mins} 分钟再试`
        : `连接或响应中断，${mins} 分钟后重试`;
    return `${stepLabel}：第 ${attempt + 1} 次自动续跑 · ${why}（随时可点停止）`;
  }
  if (plan.action === 'stop') {
    const why = plan.why === 'auto_resume_exhausted' ? '自动续跑次数已用完'
      : plan.why === 'recovery_window_exhausted' ? '自愈时限已到'
        : plan.why === 'reset_beyond_window' ? '额度重置时间超出自愈时限'
          : plan.why === 'deadline_passed' ? '任务截止时间已过'
            : plan.why === 'user_stopped' ? '你已停止本轮'
              : plan.why === 'not_a_transport_failure' ? '这不是连接类故障，需要人来判断'
                : '无法判定的失败，停下等人处理';
    return `${stepLabel}：停止自愈并暂停 · ${why}`;
  }
  return '';
}

module.exports = {
  DEFAULT_LIMITS,
  TRANSPORT_REASONS,
  SEMANTIC_REASONS,
  limitsWith,
  looksLikeQuota,
  classifyPause,
  parseQuotaResetAt,
  nextLocalTime,
  planRecovery,
  canAdoptLateAnswer,
  describePlan,
};
