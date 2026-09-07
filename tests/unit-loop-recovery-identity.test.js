'use strict';
// 2026-09-06 合并位 BLOCKERS 的反例测试。两条都是先复现、再守住。
//
// ① 旧裁决绕过身份校验：带身份的证据被拒绝后，老代码仍用 evidence:null 回收同轮文本。
//    合并位实测「评审尝试 2 失败、尝试 1 的旧 PASS 随后出现，最终状态竟是 done」。
//    转录文本本身不带尝试号，所以必须去尝试台账把它绑到一次具体派发上；绑不上就不采用。
//
// ② 没有「可安全重发」的证据：ensureMemberReady 对所有非 dormant 状态直接放行。
//    合并位实测会话持续为 running、第一轮报错且无最终答案时，引擎照样派发了尝试 2。
//    sendToPty 的确认发生在输入之后，证明不了旧任务已经结束。

const assert = require('node:assert/strict');
const test = require('node:test');
const { createLoopEngine } = require('../main/groupchat/loop-engine.js');
const GUARD = require('../core/redispatch-guard.js');

const V = (o) => '<<<VERDICT>>>' + JSON.stringify(o) + '<<<END>>>';
const PASS = V({ decision: 'pass', blockers: [], verified: ['跑了全量'] });

const FAST = {
  stepTextWait: { verdictQuietMs: 10, verdictCapMs: 60, builderQuietMs: 10, builderCapMs: 60 },
  recoveryTickMs: 10,
  recoveryLimits: {
    maxAutoResumes: 1, totalWindowMs: 30_000, quotaWindowMs: 30_000,
    baseBackoffMs: 20, backoffCapMs: 40, blindQuotaBackoffMs: 20, harvestTickMs: 10,
  },
};

/**
 * 造一个带**尝试台账**的 mock orchestrator —— 台账是身份的来源，不给台账就等于
 * 「读不到证据」，两条修复都会拒绝放行。
 */
function harness({ dispatch, turnBy = () => ({}), attempts = () => ({}), workflowSteps = () => [], buffers = () => ({}) }) {
  const wf = {
    steps: [['m1'], ['m2']],
    stepConfigs: [{ name: '工作位', prompt: 'p1' }, { name: '合并位', prompt: 'p2' }],
    loop: { enabled: true, maxRounds: 1 },
  };
  let saved = null;
  const calls = [];
  const notes = [];
  const orchestrator = {
    getState: () => ({
      turns: [{ n: 1, by: turnBy(calls), meta: { workflowSteps: workflowSteps(calls) } }],
      pendingPrompts: {},
      attempts: attempts(calls),
    }),
    appendSystemNote: (turnNum, text, meta) => { notes.push({ text, kind: meta && meta.kind }); return { id: 'n' }; },
  };
  const deps = Object.assign({
    getDispatcher: () => ({
      dispatchGroupChatTurn: async (mid, args) => { calls.push(args); return dispatch(args, calls); },
      interruptMeetingTurn: () => ({ ok: true }),
    }),
    getOrchestrator: () => orchestrator,
    meetingManager: {
      getMeeting: () => ({
        id: 'mtg', groupChat: true, subSessions: ['sB', 'sR'],
        slotSpecs: [{ memberId: 'm1' }, { memberId: 'm2' }],
        serialWorkflow: Object.assign({}, wf, saved ? { loopState: saved } : {}),
      }),
      updateMeeting: (_id, f) => { if (f.serialWorkflow && f.serialWorkflow.loopState) saved = f.serialWorkflow.loopState; },
      getAllMeetings: () => [],
    },
    sessionManager: {
      getSession: (sid) => ({ title: sid, kind: 'codex', status: 'running' }),
      getSessionBuffer: (sid) => (buffers(calls) || {})[sid] || '',
    },
    sendToRenderer: () => {},
    writeReport: () => null,
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  }, FAST);
  return { deps, calls, notes, getSaved: () => saved };
}

const reviewerCalls = (calls) => calls.filter(c => c.targetMemberIds[0] === 'm2');
const builderCalls = (calls) => calls.filter(c => c.targetMemberIds[0] === 'm1');

// 一条已收敛（终态）的尝试记录：证明「上一次派发已经收场」
const settled = (sid, stepIndex, attempt, runId) => ({
  [`a-${sid}-${attempt}`]: {
    attemptId: `a-${sid}-${attempt}`, sid, turnNum: 1, status: 'completed',
    workflowRun: { runId, kind: 'loop', stepIndex, attempt },
  },
});

/**
 * 照真实 orchestrator 的做法建台账：每派发一次就记一条，旧的标 superseded。
 * 台账记的是「派发过几次」，这正是判断「这段转录文本归属是否明确」的依据。
 */
function ledgerFromCalls(calls, memberId, sid, stepIndex) {
  const mine = calls.filter(c => c.targetMemberIds[0] === memberId);
  const out = {};
  mine.forEach((c, i) => {
    const attempt = Number(c.workflowRun && c.workflowRun.attempt) || i + 1;
    out[`a-${sid}-${attempt}`] = {
      attemptId: `a-${sid}-${attempt}`, sid, turnNum: 1,
      status: i === mine.length - 1 ? 'completed' : 'superseded',
      workflowRun: { runId: c.workflowRun.runId, kind: 'loop', stepIndex, attempt },
    };
  });
  return out;
}

test('① 旧尝试的 PASS 不能绕过身份校验把流程判成通过', async () => {
  // 场景完全照合并位的复现：评审尝试 2 失败；转录里躺着尝试 1 留下的旧 PASS。
  // 台账里这个席位最后一次派发是 attempt 1（旧的），而当前期望 attempt ≥ 2。
  const h = harness({
    dispatch: async (args) => {
      if (args.targetMemberIds[0] === 'm1') {
        return { status: 'completed', turnNum: 1, results: [{ sid: 'sB', status: 'completed', text: 'PROGRESS: 改完了' }] };
      }
      // 评审每次都失败（拿不到结果）
      return { status: 'completed', turnNum: 1, results: [{ sid: 'sR', status: 'errored', text: '' }] };
    },
    // 时序照合并位的复现：尝试 1 派发、尝试 2 派发并失败之后，尝试 1 的旧 PASS 才浮现。
    // 这一刻这段 PASS 到底出自哪一次派发，转录本身给不出答案 —— 这就是「身份不足」。
    turnBy: (calls) => (reviewerCalls(calls).length >= 2
      ? { sB: 'PROGRESS: 改完了', sR: PASS }
      : { sB: 'PROGRESS: 改完了' }),
    // 台账照实记：派发过几次就有几条。派发过 2 次 → 这段 PASS 归属不明
    attempts: (calls) => ledgerFromCalls(calls, 'm2', 'sR', 1),
  });
  const engine = createLoopEngine(h.deps);
  const state = await engine.runLoop('mtg', '目标');

  assert.notEqual(state.status, 'done',
    '旧尝试的 PASS 绝不能让流程判成通过 —— 这正是合并位复现的那条回落路径');
  assert.ok(['paused', 'reviewer_unavailable'].includes(state.status),
    `应当老实停下等人，实际 status=${state.status}`);
});

test('①b 台账里没有对应记录（身份不足）时，同轮文本一律不采用', async () => {
  const h = harness({
    dispatch: async (args) => {
      if (args.targetMemberIds[0] === 'm1') {
        return { status: 'completed', turnNum: 1, results: [{ sid: 'sB', status: 'errored', text: '' }] };
      }
      return { status: 'completed', turnNum: 1, results: [{ sid: 'sR', status: 'completed', text: PASS }] };
    },
    turnBy: () => ({ sB: 'PROGRESS: 一份来历不明的文本' }),
    attempts: () => ({}),                // 台账为空 = 绑不上身份
  });
  const engine = createLoopEngine(h.deps);
  const state = await engine.runLoop('mtg', '目标');
  assert.notEqual(state.status, 'done', '绑不上身份的文本不能推进流程');
});

test('①c 身份对得上（台账记的是当前尝试）时，迟到答案仍然可以采用', async () => {
  // 反向对照：修复不能矫枉过正，把正常的迟到回收也一起堵死。
  let runIdSeen = null;
  let answered = false;
  const h = harness({
    dispatch: async (args) => {
      if (args.targetMemberIds[0] === 'm1') {
        runIdSeen = args.workflowRun.runId;
        setTimeout(() => { answered = true; }, 15);
        return { status: 'completed', turnNum: 1, results: [{ sid: 'sB', status: 'errored', text: '' }] };
      }
      return { status: 'completed', turnNum: 1, results: [{ sid: 'sR', status: 'completed', text: PASS }] };
    },
    turnBy: () => (answered ? { sB: 'PROGRESS: 我只是转录慢了一步' } : {}),
    // 台账记的就是当前这次派发（attempt 1），身份对得上
    attempts: () => (runIdSeen ? settled('sB', 0, 1, runIdSeen) : {}),
  });
  const engine = createLoopEngine(h.deps);
  const state = await engine.runLoop('mtg', '目标');
  assert.equal(state.status, 'done', '身份对得上的迟到答案应当照常被采用');
  assert.equal(builderCalls(h.calls).length, 1, '而且不重发 prompt');
});

test('② 上一次派发未收场时不得重发（会话是 running 也不算证据）', async () => {
  let runIdSeen = null;
  const h = harness({
    dispatch: async (args) => {
      runIdSeen = args.workflowRun.runId;
      return { status: 'completed', turnNum: 1, results: [{ sid: 'sB', status: 'errored', text: '' }] };
    },
    // 台账里这次派发仍是非终态 = 上一次任务还没收场
    attempts: () => (runIdSeen ? {
      'a-live': { attemptId: 'a-live', sid: 'sB', turnNum: 1, status: 'running',
        workflowRun: { runId: runIdSeen, kind: 'loop', stepIndex: 0, attempt: 1 } },
    } : {}),
  });
  const engine = createLoopEngine(h.deps);
  const state = await engine.runLoop('mtg', '目标');

  assert.equal(builderCalls(h.calls).length, 1,
    '上一次派发还没收场就不能发尝试 2 —— 会话状态是 running 不构成「可以重发」的证据');
  assert.notEqual(state.status, 'done');
});

test('②b CLI 还在吐忙碌标记时不得重发', async () => {
  let runIdSeen = null;
  const h = harness({
    dispatch: async (args) => {
      runIdSeen = args.workflowRun.runId;
      return { status: 'completed', turnNum: 1, results: [{ sid: 'sB', status: 'errored', text: '' }] };
    },
    attempts: () => (runIdSeen ? settled('sB', 0, 1, runIdSeen) : {}),   // 台账说收场了
    buffers: () => ({ sB: '一些输出...\nesc to interrupt' }),            // 但 CLI 明说还在跑
  });
  const engine = createLoopEngine(h.deps);
  await engine.runLoop('mtg', '目标');
  assert.equal(builderCalls(h.calls).length, 1, '忙碌标记是明确的否决票');
});

test('②c 证据齐了（上一次已收场、CLI 不忙）才允许重发', async () => {
  let runIdSeen = null;
  const h = harness({
    dispatch: async (args, calls) => {
      runIdSeen = args.workflowRun.runId;
      if (args.targetMemberIds[0] === 'm1') {
        const nth = builderCalls(calls).length;
        return nth === 1
          ? { status: 'completed', turnNum: 1, results: [{ sid: 'sB', status: 'errored', text: '' }] }
          : { status: 'completed', turnNum: 1, results: [{ sid: 'sB', status: 'completed', text: 'PROGRESS: 第二次成了' }] };
      }
      return { status: 'completed', turnNum: 1, results: [{ sid: 'sR', status: 'completed', text: PASS }] };
    },
    attempts: () => (runIdSeen ? settled('sB', 0, 1, runIdSeen) : {}),
    buffers: () => ({ sB: '空闲的屏幕，没有忙碌标记' }),
  });
  const engine = createLoopEngine(h.deps);
  const state = await engine.runLoop('mtg', '目标');
  assert.equal(builderCalls(h.calls).length, 2, '证据齐了就该正常重试，别矫枉过正');
  assert.equal(state.status, 'done');
});

// ── 守门判据本身（纯函数）──────────────────────────────────────────────────
test('重发判据：拿不到台账一律不放行', () => {
  assert.equal(GUARD.canRedispatch({ sid: 's', turnNum: 1, ledgerKnown: false }).why, 'cannot_confirm_idle');
  assert.equal(GUARD.canRedispatch({ sid: '', turnNum: 1, attempts: {} }).why, 'cannot_confirm_idle');
});

test('重发判据：非终态尝试 = 还没收场；终态 + 不忙 = 可以重发', () => {
  const live = { a: { sid: 's', turnNum: 1, status: 'running' } };
  const done = { a: { sid: 's', turnNum: 1, status: 'completed' } };
  assert.equal(GUARD.canRedispatch({ attempts: live, sid: 's', turnNum: 1 }).why, 'attempt_still_in_flight');
  assert.equal(GUARD.canRedispatch({ attempts: done, sid: 's', turnNum: 1 }).ok, true);
  assert.equal(GUARD.canRedispatch({ attempts: {}, sid: 's', turnNum: 1 }).ok, true, '这一轮没派过就没有未收场的东西');
  // 别的轮次/别的席位的在飞尝试不影响本轮判断
  assert.equal(GUARD.canRedispatch({
    attempts: { a: { sid: 's', turnNum: 9, status: 'running' } }, sid: 's', turnNum: 1,
  }).ok, true);
});

test('忙碌标记只当否决票，且只看 buffer 末尾', () => {
  assert.equal(GUARD.looksBusy('esc to interrupt', 'claude'), true);
  assert.equal(GUARD.looksBusy('esc to interrupt', 'codex'), true);
  assert.equal(GUARD.looksBusy('一切正常', 'claude'), false);
  assert.equal(GUARD.looksBusy('', 'claude'), false, '没有 buffer 不等于在忙（它不是放行票，也不是否决票）');
  const stale = 'esc to interrupt' + 'x'.repeat(GUARD.BUSY_TAIL_CHARS + 100);
  assert.equal(GUARD.looksBusy(stale, 'claude'), false, '历史里出现过不代表现在在忙');
});

// ─────────────────────────────────────────────────────────────────────────────
// 第二轮 BLOCKERS（2026-09-06）：测试台账与生产状态不一致，导致上面三条修得不彻底。
//   ③ 硬超时结算出来的是 status:'failed' + signalSource:'hard_timeout' ——
//      台账**已经是终态**，但那只是 Hub 不等了，CLI 那边可能还在跑。
//   ④ Dispatched 标志是函数内局部变量，Hub 重启后一律 false，恢复入口直接绕过守门。
//   ⑤ completeTurn 失败时同样会写 workflowSteps，一刀切拒绝会把正常的单次回收堵死。
// ─────────────────────────────────────────────────────────────────────────────

// 生产里硬超时留下的真实形状
const hardTimeoutAttempt = (sid, stepIndex, attempt, runId) => ({
  [`a-${sid}-${attempt}`]: {
    attemptId: `a-${sid}-${attempt}`, sid, turnNum: 1,
    status: 'failed', signalSource: 'hard_timeout', reason: 'response_timeout',
    workflowRun: { runId, kind: 'loop', stepIndex, attempt },
  },
});

test('③ 硬超时的台账是终态，但不授权重发（Hub 停止等待 ≠ CLI 结束）', async () => {
  let runIdSeen = null;
  const h = harness({
    dispatch: async (args) => {
      runIdSeen = args.workflowRun.runId;
      return { status: 'completed', turnNum: 1, results: [{ sid: 'sB', status: 'errored', text: '' }] };
    },
    // 台账已是终态 failed，但信号源是 hard_timeout；会话仍 running、没有忙碌标记
    attempts: () => (runIdSeen ? hardTimeoutAttempt('sB', 0, 1, runIdSeen) : {}),
    buffers: () => ({ sB: '看起来很安静的一屏' }),
  });
  const engine = createLoopEngine(h.deps);
  const state = await engine.runLoop('mtg', '目标');

  assert.equal(builderCalls(h.calls).length, 1,
    'failed/hard_timeout 只说明 Hub 不等了，不能拿它当「CLI 已结束」去授权重发');
  assert.notEqual(state.status, 'done');
});

test('③b CLI 自己确认结束（进程退出）才放行重发', async () => {
  let runIdSeen = null;
  const h = harness({
    dispatch: async (args, calls) => {
      runIdSeen = args.workflowRun.runId;
      if (args.targetMemberIds[0] === 'm1') {
        return builderCalls(calls).length === 1
          ? { status: 'completed', turnNum: 1, results: [{ sid: 'sB', status: 'errored', text: '' }] }
          : { status: 'completed', turnNum: 1, results: [{ sid: 'sB', status: 'completed', text: 'PROGRESS: 第二次成了' }] };
      }
      return { status: 'completed', turnNum: 1, results: [{ sid: 'sR', status: 'completed', text: PASS }] };
    },
    attempts: () => (runIdSeen ? {
      'a-exit': { attemptId: 'a-exit', sid: 'sB', turnNum: 1,
        status: 'failed', signalSource: 'process_exit_clean', reason: 'cli_self_exit',
        workflowRun: { runId: runIdSeen, kind: 'loop', stepIndex: 0, attempt: 1 } },
    } : {}),
  });
  const engine = createLoopEngine(h.deps);
  const state = await engine.runLoop('mtg', '目标');
  assert.equal(builderCalls(h.calls).length, 2, 'CLI 确认结束了就该正常重试');
  assert.equal(state.status, 'done');
});

test('④ 重启恢复不能绕过守门：已派发要从持久化证据认出来', async () => {
  // 模拟 Hub 重启后从持久化状态续跑：loopState 里 stepAttempt 已是 1，
  // 台账里尝试 1 仍挂着 running。局部变量此刻一律是 false，只信它就会直接发尝试 2。
  const persisted = {
    runId: 'loop-resumed', goal: '目标', status: 'running', phase: 'reaching',
    round: 0, consecutiveGreen: 0, suggestionPool: [], history: [],
    currentStep: 'builder', currentTurnNum: 1, stepAttempt: 1, attempt: 1,
  };
  const h = harness({
    dispatch: async () => ({ status: 'completed', turnNum: 1, results: [{ sid: 'sB', status: 'errored', text: '' }] }),
    attempts: () => ({
      'a-live': { attemptId: 'a-live', sid: 'sB', turnNum: 1, status: 'running',
        workflowRun: { runId: 'loop-resumed', kind: 'loop', stepIndex: 0, attempt: 1 } },
    }),
  });
  const engine = createLoopEngine(h.deps);
  const state = await engine.runLoop('mtg', '目标', persisted);

  assert.equal(builderCalls(h.calls).length, 0,
    '恢复入口必须先过守门：尝试 1 还挂着 running，绝不能直接把尝试 2 发出去');
  assert.notEqual(state.status, 'done');
});

test('④b 重启恢复时若上一次确已收场，照常继续跑', async () => {
  const persisted = {
    runId: 'loop-resumed-ok', goal: '目标', status: 'running', phase: 'reaching',
    round: 0, consecutiveGreen: 0, suggestionPool: [], history: [],
    currentStep: 'builder', currentTurnNum: 1, stepAttempt: 1, attempt: 1,
  };
  const h = harness({
    dispatch: async (args) => (args.targetMemberIds[0] === 'm1'
      ? { status: 'completed', turnNum: 1, results: [{ sid: 'sB', status: 'completed', text: 'PROGRESS: 恢复后做完了' }] }
      : { status: 'completed', turnNum: 1, results: [{ sid: 'sR', status: 'completed', text: PASS }] }),
    attempts: () => ({
      'a-done': { attemptId: 'a-done', sid: 'sB', turnNum: 1, status: 'completed', signalSource: 'stop_hook',
        workflowRun: { runId: 'loop-resumed-ok', kind: 'loop', stepIndex: 0, attempt: 1 } },
    }),
  });
  const engine = createLoopEngine(h.deps);
  const state = await engine.runLoop('mtg', '目标', persisted);
  assert.equal(state.status, 'done', '恢复守门不能把正常续跑也堵死');
});

test('⑤ 单次派发 + 失败的步骤证据：迟到的答案仍要能安全回收', async () => {
  // completeTurn 失败时同样会写 workflowSteps（textLength 0），而后来补进转录的
  // 完整文本不会回头更新这份摘要。一刀切拒绝会把这种正常回收堵死。
  let runIdSeen = null;
  let answered = false;
  const h = harness({
    dispatch: async (args) => {
      if (args.targetMemberIds[0] === 'm1') {
        runIdSeen = args.workflowRun.runId;
        setTimeout(() => { answered = true; }, 15);
        return { status: 'completed', turnNum: 1, results: [{ sid: 'sB', status: 'errored', text: '' }] };
      }
      return { status: 'completed', turnNum: 1, results: [{ sid: 'sR', status: 'completed', text: PASS }] };
    },
    // 真实的失败步骤证据：记录在，但 textLength 为 0
    workflowSteps: () => (runIdSeen ? [{
      runId: runIdSeen, kind: 'loop', stepIndex: 0, attempt: 1,
      results: [{ sid: 'sB', status: 'errored', textLength: 0 }],
    }] : []),
    // 转录随后补上了完整答案
    turnBy: () => (answered ? { sB: 'PROGRESS: 我其实做完了，只是转录慢了一步' } : {}),
    // 只派发过一次 → 文本归属明确
    attempts: () => (runIdSeen ? settled('sB', 0, 1, runIdSeen) : {}),
  });
  const engine = createLoopEngine(h.deps);
  const state = await engine.runLoop('mtg', '目标');

  assert.equal(state.status, 'done',
    '失败的步骤摘要不该挡住迟到回收 —— 它记的是当时那一刻，不会随转录补丁更新');
  assert.equal(builderCalls(h.calls).length, 1, '而且是回收，不是重发');
});

// ── 守门判据本身（第二轮）────────────────────────────────────────────────────
test('判据：Hub 放弃等待 vs CLI 确认结束', () => {
  const t = (a) => GUARD.attemptConfirmsCliEnded(a);
  assert.equal(t({ status: 'failed', signalSource: 'hard_timeout' }), false, '硬超时 = Hub 不等了');
  assert.equal(t({ status: 'failed', reason: 'response_timeout' }), false, '按 reason 也要认出来');
  assert.equal(t({ status: 'failed', signalSource: 'process_exit_clean' }), true, '进程退出 = 确实结束了');
  assert.equal(t({ status: 'failed', signalSource: '某个没见过的信号' }), false, '认不出的一律不算确认');
  assert.equal(t({ status: 'failed' }), false, '没有信号源就是没有证据');
  assert.equal(t({ status: 'completed', signalSource: 'stop_hook' }), true);
  assert.equal(t({ status: 'interrupted' }), true, '我们主动打断过，CLI 已停');
  assert.equal(t({ status: 'absent' }), true, '从没派出去');
  // 即便 completed，只要信号源说明是 Hub 放弃等待，也不算确认
  assert.equal(t({ status: 'completed', signalSource: 'hard_timeout' }), false);
});

test('判据：终态但未确认的尝试会挡住重发', () => {
  const ledger = { a: { sid: 's', turnNum: 1, status: 'failed', signalSource: 'hard_timeout' } };
  const verdict = GUARD.canRedispatch({ attempts: ledger, sid: 's', turnNum: 1 });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.why, 'cli_end_unconfirmed');
  assert.match(GUARD.describeBlock(verdict), /Hub 停止了等待/);
});

test('判据：只由最后一次派发定夺，早先的 superseded 不参与', () => {
  // 每次重发都会新增一条 superseded；一并计较的话第二次自动续跑会被自己永久堵死
  //（unit-loop-self-healing ③ 实测踩到）。而真正危险的情形不会漏：最后一次要是
  // 硬超时，它自己就是未确认的。
  const withSuperseded = {
    a1: { sid: 's', turnNum: 1, status: 'superseded', workflowRun: { attempt: 1 } },
    a2: { sid: 's', turnNum: 1, status: 'completed', signalSource: 'stop_hook', workflowRun: { attempt: 2 } },
  };
  assert.equal(GUARD.canRedispatch({ attempts: withSuperseded, sid: 's', turnNum: 1 }).ok, true);
  assert.equal(GUARD.latestAttempt(withSuperseded, { sid: 's', turnNum: 1 }).workflowRun.attempt, 2);

  const lastOneTimedOut = {
    a1: { sid: 's', turnNum: 1, status: 'superseded', workflowRun: { attempt: 1 } },
    a2: { sid: 's', turnNum: 1, status: 'failed', signalSource: 'hard_timeout', workflowRun: { attempt: 2 } },
  };
  assert.equal(GUARD.canRedispatch({ attempts: lastOneTimedOut, sid: 's', turnNum: 1 }).why, 'cli_end_unconfirmed',
    '最后一次是硬超时就必须挡住 —— 这条不能被「只看最后一次」放过去');

  // 没有 workflowRun.attempt 时按时间戳排
  const byTime = {
    a1: { sid: 's', turnNum: 1, status: 'failed', signalSource: 'hard_timeout', updatedAt: 100 },
    a2: { sid: 's', turnNum: 1, status: 'completed', updatedAt: 200 },
  };
  assert.equal(GUARD.canRedispatch({ attempts: byTime, sid: 's', turnNum: 1 }).ok, true);
});

console.log('unit-loop-recovery-identity OK');
