'use strict';
// 2026-09-06：循环自愈的判断逻辑。
//
// 维护者要的是「agent 自己恢复了，群聊也能接着跑」；合并位要的是「别在旧 agent 恢复后
// 又重发一遍合并任务」。这两件事的边界全在这个文件里，所以逐条测：
//   · 读迟到答案没有副作用，采用它有 —— 采用前身份必须逐项对上
//   · 用户停止后绝不推进
//   · 额度重置时刻算不准时不许猜，走有界退避
//   · 次数与总时限都到顶后老实暂停，不无限重试

const assert = require('node:assert/strict');
const test = require('node:test');
const R = require('../core/loop-recovery.js');

const TINY = { maxAutoResumes: 2, totalWindowMs: 10_000, quotaWindowMs: 60_000, baseBackoffMs: 100, backoffCapMs: 400, blindQuotaBackoffMs: 500 };

test('分类：用户停止 / 语义结论 / 传输故障 / 额度', () => {
  assert.equal(R.classifyPause({ userStopped: true }), 'user');
  assert.equal(R.classifyPause({ reason: 'interrupted' }), 'semantic');
  assert.equal(R.classifyPause({ reason: 'superseded' }), 'semantic');
  assert.equal(R.classifyPause({ reason: 'workflow_member_missing' }), 'semantic');
  assert.equal(R.classifyPause({ reason: 'response_timeout' }), 'transport');
  assert.equal(R.classifyPause({ reason: 'participant_result_missing' }), 'transport');
  assert.equal(R.classifyPause({ reason: 'reviewer_unavailable' }), 'quota');
  assert.equal(R.classifyPause({ reason: 'step_not_completed', rawText: "You've hit your session limit" }), 'quota');
  assert.equal(R.classifyPause({ reason: '某种没见过的东西' }), 'unknown');
});

test('语义失败、未知失败、用户停止都不自动续跑', () => {
  for (const cls of ['semantic', 'unknown', 'user']) {
    assert.equal(R.planRecovery({ pauseClass: cls, limits: TINY }).action, 'stop', cls + ' 不该自动续');
  }
  assert.equal(R.planRecovery({ pauseClass: 'transport', userStopped: true, limits: TINY }).why, 'user_stopped',
    '用户停止的优先级高于一切');
});

test('传输故障按指数退避，次数用完就停', () => {
  const base = { pauseClass: 'transport', now: 1000, startedAt: 1000, limits: TINY };
  assert.deepEqual(
    [0, 1].map(attempts => R.planRecovery({ ...base, attempts }).waitMs),
    [100, 200],
    '退避应当翻倍',
  );
  assert.equal(R.planRecovery({ ...base, attempts: 2 }).why, 'auto_resume_exhausted');
});

test('总时限到了就停，不管还剩几次', () => {
  const plan = R.planRecovery({ pauseClass: 'transport', attempts: 0, startedAt: 0, now: 20_000, limits: TINY });
  assert.equal(plan.why, 'recovery_window_exhausted');
});

test('任务截止时间已过就不续跑', () => {
  const plan = R.planRecovery({ pauseClass: 'transport', now: 5000, startedAt: 5000, deadlineTs: 4000, limits: TINY });
  assert.equal(plan.why, 'deadline_passed');
});

test('额度：解析得出重置时刻就等到那时，解析不出就有界退避（绝不猜时间）', () => {
  const now = Date.UTC(2026, 8, 6, 12, 0, 0);
  const parsed = R.planRecovery({
    pauseClass: 'quota', now, startedAt: now, limits: { ...TINY, quotaWindowMs: 24 * 3600_000 },
    rawText: "You've hit your session limit · resets 6am (America/Los_Angeles)",
  });
  assert.equal(parsed.why, 'quota_reset_at');
  assert.ok(parsed.waitMs > 0 && parsed.until > now);

  const blind = R.planRecovery({
    pauseClass: 'quota', now, startedAt: now, limits: TINY,
    rawText: '额度用尽，稍后再试',
  });
  assert.equal(blind.why, 'quota_backoff_unparsed');
  assert.equal(blind.waitMs, TINY.blindQuotaBackoffMs, '算不准就走固定退避，不许编一个时间');
});

test('额度重置时间超出自愈时限：直接停，不挂几小时', () => {
  const now = Date.UTC(2026, 8, 6, 12, 0, 0);
  const plan = R.planRecovery({
    pauseClass: 'quota', now, startedAt: now, limits: { ...TINY, quotaWindowMs: 60_000 },
    rawText: 'resets in 5 hours',
  });
  assert.equal(plan.why, 'reset_beyond_window');
});

test('重置时刻解析：带时区名的按该时区精确算，认不出的时区返回不知道', () => {
  const now = Date.UTC(2026, 8, 6, 12, 0, 0);           // 05:00 洛杉矶（夏令时 UTC-7）
  const at6am = R.parseQuotaResetAt("resets 6am (America/Los_Angeles)", now);
  assert.equal(at6am, Date.UTC(2026, 8, 6, 13, 0, 0), '洛杉矶 6:00 = UTC 13:00');

  const already = R.parseQuotaResetAt('resets 4am (America/Los_Angeles)', now);
  assert.equal(already, Date.UTC(2026, 8, 7, 11, 0, 0), '当天已过就顺延到明天');

  assert.equal(R.parseQuotaResetAt('resets 6am (Mars/Olympus)', now), null, '认不出的时区不许算');
  assert.equal(R.parseQuotaResetAt('resets 6am', now), null, '没有时区就说不知道');
  assert.equal(R.parseQuotaResetAt('try again in 45 minutes', now), now + 45 * 60_000);
  assert.equal(R.parseQuotaResetAt('随便一句话', now), null);
});

test('迟到答案：身份逐项对上才可以采用', () => {
  const expect = { runId: 'run-1', stepIndex: 1, turnNum: 7, attempt: 2 };
  const evidence = { entry: { runId: 'run-1', stepIndex: 1, attempt: 2 }, turnNum: 7 };
  const done = (t) => /RESULT:/.test(t);

  assert.equal(R.canAdoptLateAnswer({ evidence, expect, text: 'RESULT: PASS', isDone: done }).ok, true);
  assert.equal(R.canAdoptLateAnswer({
    evidence: { entry: { runId: 'run-OTHER', stepIndex: 1, attempt: 2 }, turnNum: 7 }, expect, text: 'RESULT: PASS', isDone: done,
  }).why, 'run_mismatch');
  assert.equal(R.canAdoptLateAnswer({
    evidence: { entry: { runId: 'run-1', stepIndex: 0, attempt: 2 }, turnNum: 7 }, expect, text: 'RESULT: PASS', isDone: done,
  }).why, 'step_mismatch');
  assert.equal(R.canAdoptLateAnswer({
    evidence: { entry: { runId: 'run-1', stepIndex: 1, attempt: 2 }, turnNum: 6 }, expect, text: 'RESULT: PASS', isDone: done,
  }).why, 'turn_mismatch', '旧轮迟到不能串到新轮');
  assert.equal(R.canAdoptLateAnswer({
    evidence: { entry: { runId: 'run-1', stepIndex: 1, attempt: 1 }, turnNum: 7 }, expect, text: 'RESULT: PASS', isDone: done,
  }).why, 'stale_attempt', '旧尝试迟到不能覆盖新尝试');
  assert.equal(R.canAdoptLateAnswer({ evidence, expect, text: '   ', isDone: done }).why, 'no_text');
  assert.equal(R.canAdoptLateAnswer({ evidence, expect, text: '我还在跑测试', isDone: done }).why, 'step_contract_unmet',
    '文本在但没达成这一步的完成判据，不能算数');
  assert.equal(R.canAdoptLateAnswer({
    evidence, expect: { ...expect, userStopped: true }, text: 'RESULT: PASS', isDone: done,
  }).why, 'user_stopped', '用户停止后绝不推进');
});

test('每个动作都能说出一句人话（不许静默重试）', () => {
  const wait = R.planRecovery({ pauseClass: 'transport', now: 0, startedAt: 0, limits: TINY });
  const text = R.describePlan(wait, { attempt: 1, stepLabel: '合并位审查' });
  assert.match(text, /第 2 次自动续跑/);
  assert.match(text, /可点停止/);
  const stop = R.planRecovery({ pauseClass: 'transport', attempts: 9, now: 0, startedAt: 0, limits: TINY });
  assert.match(R.describePlan(stop, { stepLabel: '合并位审查' }), /停止自愈并暂停 · 自动续跑次数已用完/);
});

// ── 工作台的可见性（自愈中不能显示成「出错暂停，等你处理」）──────────────────
const DP = require('../renderer/dev-progress.js');

test('自愈进行中：看板显示「等待自愈中」并带倒计时，不是「等你处理」', () => {
  const stage = DP.deriveStage({
    serialWorkflow: {
      loop: { maxRounds: 3 },
      loopState: { status: 'paused', round: 1, recovering: { step: '合并位审查', why: 'quota_reset_at', until: Date.now() + 5 * 60_000, attempt: 2 } },
    },
  });
  assert.equal(stage.key, 'selfHealing');
  assert.match(stage.label, /等待自愈中（合并位审查）/);
  assert.match(stage.label, /约 \d+ 分钟后重试/, '要让维护者知道还要等多久');
  assert.equal(stage.recovering.attempt, 2);
});

test('自愈时间已过 / 没有自愈状态：回到原来的说法，不会永远挂着', () => {
  const expired = DP.deriveStage({
    serialWorkflow: { loopState: { status: 'paused', recovering: { step: 'x', until: Date.now() - 1000 } } },
  });
  assert.equal(expired.key, 'paused');
  assert.equal(DP.deriveStage({ serialWorkflow: { loopState: { status: 'paused' } } }).key, 'paused');
});

console.log('unit-loop-recovery OK');
