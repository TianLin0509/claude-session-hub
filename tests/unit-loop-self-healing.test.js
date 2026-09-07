'use strict';
// 2026-09-06：循环被打断后能自愈 —— 但不能在旧 agent 恢复后又重发一遍。
//
// 维护者的原话：「群聊中途 Agent 出现异常被打断，群聊就中断了。但实际上 agent 后续
// 自己恢复了（比如网络中断、AI 限额）」。合并位补的边界：读迟到答案没有副作用，
// **采用它并推进流程有副作用**；用户停止后不得推进；额度重置时刻算不准时不许猜。
//
// 这个文件用 mock dispatcher + mock orchestrator 跑真实的循环引擎，验四个场景：
//   ① 超时之后迟到的答案 → 采用它继续跑，**不重发**
//   ② 评审只回一句额度横幅、随后恢复 → 到点自动续跑一次就过
//   ③ 一直不恢复 → 次数用尽后老实暂停，并留下人话原因
//   ④ 自愈等待期间用户点停止 → 立刻停，绝不再发一次

const assert = require('node:assert/strict');
const test = require('node:test');
const { createLoopEngine } = require('../main/groupchat/loop-engine.js');

const V = (o) => '<<<VERDICT>>>' + JSON.stringify(o) + '<<<END>>>';
const PASS = V({ decision: 'pass', blockers: [], verified: ['跑了全量单测'] });
const QUOTA_BANNER = "You've hit your session limit · resets 6am";

// 毫秒级预算：mock 的 agent 不会自己补文本，用生产默认值每一步都要白等
const FAST = {
  stepTextWait: { verdictQuietMs: 20, verdictCapMs: 120, builderQuietMs: 20, builderCapMs: 120 },
  recoveryTickMs: 10,
  recoveryLimits: {
    maxAutoResumes: 2, totalWindowMs: 60_000, quotaWindowMs: 60_000,
    baseBackoffMs: 30, backoffCapMs: 60, blindQuotaBackoffMs: 30, harvestTickMs: 10,
  },
};

/**
 * 照真实 orchestrator 建尝试台账：每派发一次记一条，最后一条为终态、之前的标 superseded。
 * 台账是「上一次派发收场没有」和「这段转录文本归属明不明确」的唯一证据来源 ——
 * 不给台账，引擎会按「无法确认」拒绝重发、也拒绝采用文本（这正是它该有的行为）。
 */
function ledgerOf(calls) {
  const out = {};
  for (const memberId of ['m1', 'm2']) {
    const sid = memberId === 'm1' ? 'sB' : 'sR';
    const mine = calls.filter(c => c.targetMemberIds[0] === memberId);
    mine.forEach((c, i) => {
      const attempt = Number(c.workflowRun && c.workflowRun.attempt) || i + 1;
      out[`a-${sid}-${attempt}`] = {
        attemptId: `a-${sid}-${attempt}`, sid, turnNum: 1,
        status: i === mine.length - 1 ? 'completed' : 'superseded',
        workflowRun: {
          runId: c.workflowRun && c.workflowRun.runId,
          kind: 'loop',
          stepIndex: c.workflowRun && c.workflowRun.stepIndex,
          attempt,
        },
      };
    });
  }
  return out;
}

function harness({ dispatch, turnText = () => '', stepEntries = () => [] }) {
  const wf = {
    steps: [['m1'], ['m2']],
    stepConfigs: [{ name: '工作位', prompt: 'p1' }, { name: '合并位', prompt: 'p2' }],
    loop: { enabled: true, maxRounds: 2 },
  };
  let savedLoopState = null;
  const calls = [];
  const notes = [];
  const orchestrator = {
    getState: () => ({
      turns: [{ n: 1, by: turnText(calls), meta: { workflowSteps: stepEntries(calls) } }],
      pendingPrompts: {},
      attempts: ledgerOf(calls),
    }),
    appendSystemNote: (turnNum, text, meta) => { notes.push({ turnNum, text, kind: meta && meta.kind }); return { id: 'n' + notes.length }; },
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
        serialWorkflow: Object.assign({}, wf, savedLoopState ? { loopState: savedLoopState } : {}),
      }),
      updateMeeting: (_id, fields) => {
        if (fields.serialWorkflow && fields.serialWorkflow.loopState) savedLoopState = fields.serialWorkflow.loopState;
      },
      getAllMeetings: () => [],
    },
    sessionManager: { getSession: (sid) => ({ title: sid, kind: 'codex', status: 'idle' }) },
    sendToRenderer: () => {},
    writeReport: () => null,
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  }, FAST);
  return { deps, calls, notes, getSaved: () => savedLoopState };
}

const builderCalls = (calls) => calls.filter(c => c.targetMemberIds[0] === 'm1');
const reviewerCalls = (calls) => calls.filter(c => c.targetMemberIds[0] === 'm2');

test('① 迟到的答案会被采用并继续往下跑，不重发 prompt', async () => {
  let builderAnswered = false;
  const h = harness({
    dispatch: async (args) => {
      if (args.targetMemberIds[0] === 'm1') {
        // 工作位这一步「超时」：结算回来是空的错误结果
        setTimeout(() => { builderAnswered = true; }, 20);   // 20ms 后转录里补上了答案
        return { status: 'completed', turnNum: 1, results: [{ sid: 'sB', status: 'errored', text: '' }] };
      }
      return { status: 'completed', turnNum: 1, results: [{ sid: 'sR', status: 'completed', text: PASS }] };
    },
    turnText: () => (builderAnswered ? { sB: 'PROGRESS: 我其实做完了，只是转录慢了一步' } : {}),
  });
  const engine = createLoopEngine(h.deps);
  const state = await engine.runLoop('mtg', '目标');

  assert.equal(builderCalls(h.calls).length, 1, '迟到答案被回收后不得再发一次 prompt');
  assert.equal(state.status, 'done', '应当正常跑完，而不是停在 paused');
  assert.ok(h.notes.some(n => /回收|其实已经到了/.test(n.text)),
    '回收动作必须在群聊里留下可见记录');
});

test('② 评审只回额度横幅、随后恢复 → 自动续跑一次就过，并留下可见记录', async () => {
  const h = harness({
    dispatch: async (args, calls) => {
      if (args.targetMemberIds[0] === 'm1') {
        return { status: 'completed', turnNum: 1, results: [{ sid: 'sB', status: 'completed', text: 'PROGRESS: 改完了' }] };
      }
      const nth = reviewerCalls(calls).length;
      return {
        status: 'completed', turnNum: 1,
        results: [{ sid: 'sR', status: 'completed', text: nth === 1 ? QUOTA_BANNER : PASS }],
      };
    },
  });
  const engine = createLoopEngine(h.deps);
  const state = await engine.runLoop('mtg', '目标');

  assert.equal(reviewerCalls(h.calls).length, 2, '额度恢复后应当自动重发一次评审');
  assert.equal(state.status, 'done');
  const note = h.notes.find(n => /自动续跑/.test(n.text));
  assert.ok(note, '自动续跑必须留下一行可见记录，不能静默重试');
  assert.match(note.text, /额度限制/);
  assert.match(note.text, /可点停止/, '要告诉用户随时可以中止');
});

test('②b 额度横幅里没有能算准的重置时刻时，走有界退避而不是猜一个时间', async () => {
  const h = harness({
    dispatch: async (args, calls) => {
      if (args.targetMemberIds[0] === 'm1') {
        return { status: 'completed', turnNum: 1, results: [{ sid: 'sB', status: 'completed', text: 'PROGRESS: ok' }] };
      }
      const nth = reviewerCalls(calls).length;
      return { status: 'completed', turnNum: 1, results: [{ sid: 'sR', status: 'completed', text: nth === 1 ? '额度已用尽' : PASS }] };
    },
  });
  const engine = createLoopEngine(h.deps);
  const state = await engine.runLoop('mtg', '目标');
  assert.equal(state.status, 'done');
  assert.match(h.notes.find(n => /自动续跑/.test(n.text)).text, /没有能算准的重置时刻/);
});

test('③ 一直不恢复 → 次数用尽后老实暂停，给出人话原因', async () => {
  const h = harness({
    dispatch: async (args) => {
      if (args.targetMemberIds[0] === 'm1') {
        return { status: 'completed', turnNum: 1, results: [{ sid: 'sB', status: 'completed', text: 'PROGRESS: ok' }] };
      }
      return { status: 'completed', turnNum: 1, results: [{ sid: 'sR', status: 'completed', text: QUOTA_BANNER }] };
    },
  });
  const engine = createLoopEngine(h.deps);
  const state = await engine.runLoop('mtg', '目标');

  assert.equal(state.status, 'reviewer_unavailable', '不能无限重试，也不能假装成功');
  // K=2：首发 + 2 次自动续跑
  assert.equal(reviewerCalls(h.calls).length, 3, '自动续跑次数必须封顶');
  assert.ok(h.notes.some(n => /停止自愈并暂停 · 自动续跑次数已用完/.test(n.text)), '停下来的原因要写成人话');
});

test('④ 自愈等待期间用户点停止：立刻停，绝不再发一次', async () => {
  let engine = null;
  const h = harness({
    dispatch: async (args) => {
      if (args.targetMemberIds[0] === 'm1') {
        // 第一次就失败，进入自愈等待；等待期间用户点停止
        setTimeout(() => engine && engine.stopLoop('mtg'), 15);
        return { status: 'completed', turnNum: 1, results: [{ sid: 'sB', status: 'errored', text: '' }] };
      }
      return { status: 'completed', turnNum: 1, results: [{ sid: 'sR', status: 'completed', text: PASS }] };
    },
  });
  engine = createLoopEngine(h.deps);
  const state = await engine.runLoop('mtg', '目标');

  assert.equal(builderCalls(h.calls).length, 1, '用户停止后不得再发一次 prompt');
  assert.notEqual(state.status, 'done');
  assert.ok(!h.notes.some(n => /第 2 次自动续跑/.test(n.text)), '停止之后不该再宣布下一次续跑');
});

test('⑤ 语义失败（成员缺失）不进入自愈，直接暂停', async () => {
  const h = harness({
    dispatch: async () => ({ status: 'error', reason: 'workflow_member_missing', turnNum: null }),
  });
  const engine = createLoopEngine(h.deps);
  const started = Date.now();
  const state = await engine.runLoop('mtg', '目标');
  assert.equal(state.status, 'paused');
  assert.ok(Date.now() - started < 3000, '语义失败不该在自愈里空等');
  assert.equal(builderCalls(h.calls).length, 2, '只走原有的两次快速传输重试，不额外自动续跑');
});

console.log('unit-loop-self-healing OK');
