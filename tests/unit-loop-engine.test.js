'use strict';
/*
 * main 循环引擎单测（Phase 2b 进阶，2026-06-29 道雪）
 * 跑法：node tests/unit-loop-engine.test.js
 * mock dispatcher/meetingManager/sessionManager，验证 main 驱动：开发→评审→解析→gate→回灌→持久化→续跑。
 */
const assert = require('assert');
const { createLoopEngine } = require('../main/groupchat/loop-engine.js');

let pass = 0, fail = 0;
function t(name, fn) { return fn().then(() => { pass++; console.log('  ✓ ' + name); }).catch((e) => { fail++; console.log('  ✗ ' + name + '\n      ' + (e && e.message)); }); }
const V = (o) => '<<<VERDICT>>>' + JSON.stringify(o) + '<<<END>>>';

// 工厂：构造一套 mock deps
function mk(opts) {
  opts = opts || {};
  const baseWf = {
    steps: [['m1'], ['m2']],
    stepConfigs: opts.stepConfigs || [],
    loop: Object.assign({ enabled: true, maxRounds: 2, consecutivePass: 1, polish: false }, opts.loop || {}),
  };
  let savedLoopState = opts.initLoopState || null;
  const turnCalls = [];
  let reportHtml = null;
  const deps = {
    getDispatcher: () => ({
      dispatchGroupChatTurn: async (mid, args) => {
        turnCalls.push(args);
        if (typeof opts.dispatch === 'function') return opts.dispatch(mid, args, turnCalls);
        const isBuilder = args.targetMemberIds[0] === 'm1';
        const text = isBuilder ? '本轮做了 X' : V(opts.verdictFor ? opts.verdictFor(turnCalls) : { decision: 'pass', blockers: [], verified: ['ran test'] });
        return { status: 'completed', turnNum: 1, results: [{ sid: isBuilder ? 'sB' : 'sR', text }] };
      },
    }),
    meetingManager: {
      getMeeting: () => ({ id: 'mtg', subSessions: ['sB', 'sR'], serialWorkflow: Object.assign({}, baseWf, savedLoopState ? { loopState: savedLoopState } : {}) }),
      updateMeeting: (id, fields) => { if (fields.serialWorkflow && fields.serialWorkflow.loopState) savedLoopState = fields.serialWorkflow.loopState; },
      getAllMeetings: () => [{ id: 'mtg', serialWorkflow: Object.assign({}, baseWf, savedLoopState ? { loopState: savedLoopState } : {}) }],
    },
    sessionManager: { getSession: (sid) => ({ title: sid, kind: 'codex', status: 'idle' }) },
    sendToRenderer: () => {},
    writeReport: (html) => { reportHtml = html; return 'C:/tmp/report.html'; },
    logger: { log: () => {} },
  };
  return { deps, turnCalls, getSaved: () => savedLoopState, getReport: () => reportHtml };
}

function mkSerial(opts = {}) {
  const steps = opts.steps || [['m1'], ['m2'], ['m1', 'm2']];
  const sessions = new Map([
    ['s1', { id: 's1', title: 'Claude', kind: 'claude', status: 'idle', cwd: 'C:/work', currentModel: { id: 'opus' }, effort: 'high' }],
    ['s2', { id: 's2', title: 'Codex', kind: 'codex', status: 'idle', cwd: 'C:/work', currentModel: { id: 'gpt' }, effort: 'xhigh' }],
  ]);
  const meeting = {
    id: 'serial-mtg',
    groupChat: true,
    subSessions: ['s1', 's2'],
    serialWorkflow: {
      enabled: true,
      steps,
      stepConfigs: steps.map((_step, index) => ({ name: `step-${index + 1}`, prompt: `role-${index + 1}` })),
      loop: { enabled: false },
      ...(opts.serialWorkflow || {}),
    },
  };
  const turnCalls = [];
  const progress = [];
  const resumeCalls = [];
  let dispatchCount = 0;
  const dispatcher = {
    async dispatchGroupChatTurn(_meetingId, args) {
      dispatchCount += 1;
      turnCalls.push(args);
      if (typeof opts.dispatch === 'function') return opts.dispatch(args, dispatchCount);
      const results = args.targetMemberIds.map(memberId => {
        const sid = memberId === 'm1' ? 's1' : 's2';
        return { sid, status: 'completed', text: `${memberId} answer` };
      });
      return { status: 'completed', turnNum: 7, results };
    },
    interruptMeetingTurn: (...args) => {
      if (typeof opts.interrupt === 'function') return opts.interrupt(...args);
      return { ok: true };
    },
  };
  const deps = {
    getDispatcher: () => dispatcher,
    getOrchestrator: () => ({
      getState: () => typeof opts.orchestratorState === 'function'
        ? opts.orchestratorState()
        : (opts.orchestratorState || { turns: [] }),
    }),
    meetingManager: {
      getMeeting: () => meeting,
      getAllMeetings: () => [meeting],
      updateMeeting: (_id, fields) => {
        if (fields.serialWorkflow) meeting.serialWorkflow = fields.serialWorkflow;
        return meeting;
      },
    },
    sessionManager: { getSession: sid => sessions.get(sid) },
    resumeSession: async meta => {
      resumeCalls.push(meta);
      const session = sessions.get(meta.hubId);
      if (session) session.status = 'idle';
      return session || null;
    },
    sendToRenderer: (channel, payload) => progress.push([channel, payload]),
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  };
  return { deps, meeting, sessions, turnCalls, progress, resumeCalls };
}

async function main() {
  console.log('loop-engine');

  await t('一轮 pass → done（驱动+解析+gate+持久化+晨报）', async () => {
    const m = mk();
    const eng = createLoopEngine(m.deps);
    const st = await eng.runLoop('mtg', '实现 add 函数', null);
    assert(st && st.status === 'done', 'status=' + (st && st.status));
    assert(st.round === 1, 'round=' + st.round);
    assert(m.turnCalls.length === 2, '应 2 次 turn（开发+评审），实际 ' + m.turnCalls.length);
    assert(m.turnCalls[0].targetMemberIds[0] === 'm1' && m.turnCalls[0].appendUserMessage === true, '第1次=开发');
    assert(m.turnCalls[1].targetMemberIds[0] === 'm2' && m.turnCalls[1].reuseTurnNum === 1, '第2次=评审复用 turn');
    assert(m.getSaved() && m.getSaved().status === 'done', '已持久化 done');
    assert(m.getReport() && /循环工作流复盘/.test(m.getReport()), '晨报已生成');
  });

  await t('第一轮 fail → 回灌 → 第二轮 pass → done(round=2)', async () => {
    // 评审：第一次 fail（turnCalls 含 2 = 第1轮评审），之后 pass
    const m = mk({ verdictFor: (calls) => calls.length <= 2 ? { decision: 'fail', blockers: [{ what: '缺测试' }], verified: ['看了代码'] } : { decision: 'pass', blockers: [], verified: ['ran test'] } });
    const eng = createLoopEngine(m.deps);
    const st = await eng.runLoop('mtg', 'g', null);
    assert(st.round === 2 && st.status === 'done', 'round=' + st.round + ' status=' + st.status);
    // 第二轮开发应收到回灌的阻断项
    const round2Builder = m.turnCalls[2];
    assert(/缺测试/.test(round2Builder.userInput), '第2轮开发 prompt 应含回灌阻断项');
  });

  await t('两轮都 fail → stopped_max', async () => {
    const m = mk({ verdictFor: () => ({ decision: 'fail', blockers: [{ what: 'x' }], verified: ['v'] }) });
    const eng = createLoopEngine(m.deps);
    const st = await eng.runLoop('mtg', 'g', null);
    assert(st.status === 'stopped_max' && st.round === 2, 'status=' + st.status + ' round=' + st.round);
  });

  await t('续跑：从持久化 round=1 继续', async () => {
    const m = mk({ loop: { maxRounds: 3 }, verdictFor: () => ({ decision: 'pass', blockers: [], verified: ['v'] }) });
    const eng = createLoopEngine(m.deps);
    const st = await eng.runLoop('mtg', null, { status: 'running', round: 1, consecutiveGreen: 0, phase: 'reaching', goal: '续跑目标', history: [{ round: 1, pass: false, blockers: [{ what: 'old' }] }] });
    assert(st.round === 2, '续跑应从 round 1 推进到 2，实际 ' + st.round);
    assert(st.goal === '续跑目标', 'goal 恢复');
    // 续跑首轮开发应回灌上一轮(round1)的阻断项
    assert(/old/.test(m.turnCalls[0].userInput), '续跑首轮应回灌 history 末轮阻断项');
  });

  await t('防并发：同 meeting 不起两个循环', async () => {
    const m = mk({ verdictFor: () => ({ decision: 'pass', blockers: [], verified: ['v'] }) });
    const eng = createLoopEngine(m.deps);
    const p1 = eng.runLoop('mtg', 'g', null);
    const p2 = await eng.runLoop('mtg', 'g', null); // 第二个应立即 null（已 running）
    assert(p2 === null, '并发第二个应返回 null');
    await p1;
  });

  await t('模板步骤 prompt 会分别注入执行者和评审者', async () => {
    const m = mk({ stepConfigs: [{ prompt: '只实现核心路径' }, { prompt: '重点验证边界输入' }] });
    const eng = createLoopEngine(m.deps);
    const st = await eng.runLoop('mtg', 'g', null);
    assert(st.status === 'done');
    assert(/只实现核心路径/.test(m.turnCalls[0].userInput));
    assert(/重点验证边界输入/.test(m.turnCalls[1].userInput));
  });

  await t('循环步骤使用模板配置的独立超时，不截断长实现与全量审查', async () => {
    const m = mk({
      stepConfigs: [
        { prompt: '实现', timeoutMs: 30 * 60 * 1000 },
        { prompt: '审查', timeoutMs: 25 * 60 * 1000 },
      ],
    });
    const eng = createLoopEngine(m.deps);
    const st = await eng.runLoop('mtg', 'g', null);
    assert.strictEqual(st.status, 'done');
    assert.strictEqual(m.turnCalls[0].turnTimeoutMs, 30 * 60 * 1000);
    assert.strictEqual(m.turnCalls[1].turnTimeoutMs, 25 * 60 * 1000);
  });

  await t('步骤超时/失败进入 paused，不能残留 running', async () => {
    const m = mk({ dispatch: async () => ({ status: 'timeout', reason: 'builder_timeout' }) });
    const eng = createLoopEngine(m.deps);
    const st = await eng.runLoop('mtg', 'g', null);
    assert(st.status === 'paused', 'status=' + st.status);
    assert(st.lastError && st.lastError.stage === 'builder' && /timeout/.test(st.lastError.reason));
    assert(m.getSaved().status === 'paused', '持久化状态应为 paused');
  });

  await t('普通串行 N 步由 main 驱动、逐步持久化并复用一个可见 turn', async () => {
    const m = mkSerial();
    const eng = createLoopEngine(m.deps);
    const state = await eng.runSerial('serial-mtg', 'deliver feature', null);
    assert.strictEqual(state.status, 'done');
    assert.strictEqual(state.nextStepIndex, 3);
    assert.strictEqual(m.turnCalls.length, 3);
    assert.strictEqual(m.turnCalls[0].appendUserMessage, true);
    assert.strictEqual(m.turnCalls[1].appendUserMessage, false);
    assert.strictEqual(m.turnCalls[1].reuseTurnNum, 7);
    assert.ok(m.turnCalls.every(call => call.workflowRun && call.workflowRun.runId === state.runId));
    assert.strictEqual(m.meeting.serialWorkflow.serialRunState.status, 'done');
    assert.ok(m.progress.some(([channel, payload]) => channel === 'workflow:progress' && payload.stage === 'done'));
  });

  await t('串行步骤空结果不会假装成功：自动重试一次后暂停并保留检查点', async () => {
    const m = mkSerial({
      steps: [['m1'], ['m2']],
      dispatch: async (args) => ({
        status: 'completed',
        turnNum: 9,
        results: args.targetMemberIds.map(id => ({ sid: id === 'm1' ? 's1' : 's2', status: 'errored', text: '', reason: 'send_stuck' })),
      }),
    });
    const eng = createLoopEngine(m.deps);
    const state = await eng.runSerial('serial-mtg', 'g', null);
    assert.strictEqual(state.status, 'paused');
    assert.strictEqual(state.nextStepIndex, 0);
    assert.strictEqual(state.attemptsByStep[0], 2);
    assert.strictEqual(m.turnCalls.length, 2);
    assert.match(state.lastError.reason, /send_stuck/);
  });

  await t('崩溃窗恢复以 orchestrator workflow evidence 去重，不重复执行已完成步骤', async () => {
    const persisted = {
      runId: 'serial-existing-run',
      goal: 'resume safely',
      status: 'running',
      nextStepIndex: 0,
      currentStepIndex: 0,
      currentTurnNum: null,
      attemptsByStep: { 0: 1 },
      completedSteps: [],
      startedAt: Date.now() - 1000,
    };
    const m = mkSerial({
      steps: [['m1'], ['m2']],
      orchestratorState: {
        turns: [{
          n: 11,
          by: { s1: 'already done' },
          byStatus: { s1: 'completed' },
          meta: { workflowSteps: [{
            runId: 'serial-existing-run',
            stepIndex: 0,
            completedAt: Date.now() - 500,
            results: [{ sid: 's1', status: 'completed', textLength: 12 }],
          }] },
        }],
      },
    });
    const eng = createLoopEngine(m.deps);
    const state = await eng.runSerial('serial-mtg', null, persisted);
    assert.strictEqual(state.status, 'done');
    assert.strictEqual(m.turnCalls.length, 1, 'only step 2 should dispatch');
    assert.deepStrictEqual(m.turnCalls[0].targetMemberIds, ['m2']);
    assert.strictEqual(m.turnCalls[0].reuseTurnNum, 11);
    assert.ok(state.completedSteps.some(step => step.stepIndex === 0 && step.recovered));
  });

  await t('崩溃发生在派发中时复用 pending turn，不重复追加用户问题', async () => {
    const persisted = {
      runId: 'serial-pending-run', goal: 'resume pending', status: 'running',
      nextStepIndex: 0, currentStepIndex: 0, currentTurnNum: null,
      attemptsByStep: { 0: 1 }, completedSteps: [], startedAt: Date.now() - 1000,
    };
    const m = mkSerial({
      steps: [['m1']],
      orchestratorState: {
        turns: [],
        pendingPrompts: {
          13: { s1: { workflowRun: { runId: 'serial-pending-run', stepIndex: 0 } } },
        },
      },
    });
    const eng = createLoopEngine(m.deps);
    const state = await eng.runSerial('serial-mtg', null, persisted);
    assert.strictEqual(state.status, 'done');
    assert.strictEqual(m.turnCalls.length, 1);
    assert.strictEqual(m.turnCalls[0].reuseTurnNum, 13);
    assert.strictEqual(m.turnCalls[0].appendUserMessage, false);
  });

  await t('休眠成员走普通 Session 原生恢复元数据，不用残缺 createSession', async () => {
    const m = mkSerial({ steps: [['m1']] });
    m.sessions.get('s1').status = 'dormant';
    const eng = createLoopEngine(m.deps);
    const state = await eng.runSerial('serial-mtg', 'wake safely', null);
    assert.strictEqual(state.status, 'done');
    assert.strictEqual(m.resumeCalls.length, 1);
    assert.strictEqual(m.resumeCalls[0].hubId, 's1');
    assert.strictEqual(m.resumeCalls[0].cwd, 'C:/work');
    assert.strictEqual(m.resumeCalls[0].currentModel.id, 'opus');
    assert.strictEqual(m.resumeCalls[0].effort, 'high');
  });

  await t('50 步串行压力：间歇 send failure 有界重试后完整收敛且不丢检查点', async () => {
    const steps = Array.from({ length: 50 }, (_v, index) => [index % 2 === 0 ? 'm1' : 'm2']);
    const attempts = new Map();
    const m = mkSerial({
      steps,
      dispatch: async (args) => {
        const index = args.workflowRun.stepIndex;
        const seen = (attempts.get(index) || 0) + 1;
        attempts.set(index, seen);
        if (index % 7 === 0 && seen === 1) return { status: 'no_sent', reason: 'synthetic_transport_gap' };
        const memberId = args.targetMemberIds[0];
        return {
          status: 'completed',
          turnNum: 21,
          results: [{ sid: memberId === 'm1' ? 's1' : 's2', status: 'completed', text: `step-${index}-ok` }],
        };
      },
    });
    const eng = createLoopEngine(m.deps);
    const state = await eng.runSerial('serial-mtg', '50-step stress', null);
    assert.strictEqual(state.status, 'done');
    assert.strictEqual(state.nextStepIndex, 50);
    assert.strictEqual(state.completedSteps.length, 50);
    assert.strictEqual(m.turnCalls.length, 58, '8 synthetic first-attempt failures should add exactly 8 bounded retries');
    assert.strictEqual(m.meeting.serialWorkflow.serialRunState.completedSteps.length, 50);
  });

  await t('停止工作流会立即中断当前 dispatcher，不等待步骤硬超时', async () => {
    let release = null;
    const m = mkSerial({
      steps: [['m1'], ['m2']],
      dispatch: async () => new Promise(resolve => { release = resolve; }),
      interrupt: () => {
        if (release) release({ status: 'completed', turnNum: 31, interrupted: true, results: [{ sid: 's1', status: 'interrupted', text: '' }] });
        return { ok: true };
      },
    });
    const eng = createLoopEngine(m.deps);
    const pending = eng.runSerial('serial-mtg', 'stop quickly', null);
    for (let i = 0; !release && i < 20; i += 1) await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(eng.stopLoop('serial-mtg', { interrupt: true }), true);
    const state = await pending;
    assert.strictEqual(state.status, 'stopped_user');
    assert.strictEqual(eng.isRunning('serial-mtg'), false);
  });

  console.log('\n──────────────');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  if (fail > 0) process.exit(1);
}
main();
