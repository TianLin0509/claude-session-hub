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

  await t('步骤超时/失败进入 paused，不能残留 running', async () => {
    const m = mk({ dispatch: async () => ({ status: 'timeout', reason: 'builder_timeout' }) });
    const eng = createLoopEngine(m.deps);
    const st = await eng.runLoop('mtg', 'g', null);
    assert(st.status === 'paused', 'status=' + st.status);
    assert(st.lastError && st.lastError.stage === 'builder' && /timeout/.test(st.lastError.reason));
    assert(m.getSaved().status === 'paused', '持久化状态应为 paused');
  });

  console.log('\n──────────────');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  if (fail > 0) process.exit(1);
}
main();
