'use strict';
/*
 * 同席位 / 双席位「实现完成 → 评审等待 → 手动提供评审」的完整验收
 * 跑法：node tests/unit-solo-reviewer-adoption.test.js
 *
 * 2026-09-07 合并位对 e6e4183 的阻断项：
 *   主干的「同席位评审另起一轮」合进来之后，共享的步骤上下文没跟上 ——
 *   它把评审的 attemptId 和**实现那一轮**的 turnNum 拼进同一次写入。后果三连：
 *     ① 正文写回实现那一轮 → 刚落盘的 PROGRESS 被 RESULT 覆盖，工作台交付卡变 null；
 *     ② requestedTurn 与真实当前轮对不上 → 错过评审自己的活 watcher，那一步继续干等；
 *     ③ 而 IPC 还报「流程继续」。
 *   双席位共享一轮，所以看不出来 —— 本文件两种形态都跑，靠对照定位。
 *
 * 台账全部用生产方法造：beginTurn / recordTurnPrompt / completeTurn，
 * 引擎与 watcher 都是真的，只有 dispatcher 是计数替身。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const groupchat = require('../core/group-chat-orchestrator.js');
const devWorkbenchFeed = require('../core/dev-workbench-feed.js');
const { createLoopEngine } = require('../main/groupchat/loop-engine.js');
const { createTurnCompletionWatcher } = require('../core/turn-completion-watcher.js');
const { registerGroupchatRecoveryIpc } = require('../main/ipc/groupchat-recovery-handlers.js');

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('  ✓ ' + name); }
  catch (e) { fail += 1; console.log('  ✗ ' + name + '\n      ' + ((e && e.stack) || e)); }
}

const BUILDER_TEXT = 'PROGRESS: 实现完成\nVERIFIED: 跑了单测\nRISK: 无\nREPORT: 无';
const REVIEW_TEXT = 'RESULT: PASS\nBLOCKERS: none\nVERIFIED: 亲自跑了 dry-run\nNEXT: none';
const silent = () => ({ log: () => {}, warn: () => {}, error: () => {} });

/**
 * 跑到「评审正在等」这一刻停住，把控制权交回来。
 *   solo=true  → 两步都派给 m1（工作位自审），评审会另起一轮
 *   solo=false → 老样子两个人，评审复用工作位那一轮
 */
async function runUntilReviewerWaits(solo) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-solo-adopt-'));
  const meetingId = 'mtg-solo-adopt';
  groupchat._private.resetCache();
  const orch = groupchat.getOrchestrator(dataDir, meetingId);

  const sessions = new Map([
    ['s1', { id: 's1', title: 'Claude 1', kind: 'claude', status: 'idle', cwd: 'C:/work' }],
    ['s2', { id: 's2', title: 'Codex 2', kind: 'codex', status: 'idle', cwd: 'C:/work' }],
  ]);
  const meeting = {
    id: meetingId,
    groupChat: true,
    scene: 'dev',
    subSessions: ['s1', 's2'],
    slotSpecs: [{ memberId: 'm1' }, { memberId: 'm2' }],
    serialWorkflow: {
      enabled: true,
      devPhase: 'build',
      steps: [['m1'], [solo ? 'm1' : 'm2']],
      stepConfigs: [{ name: '实现', prompt: 'author' }, { name: '评审', prompt: 'reviewer' }],
      loop: { enabled: true, maxRounds: 2, consecutivePass: 1, polish: false },
    },
  };

  const watchers = new Map();
  const dispatchedMemberIds = [];
  let builderTurnNum = null;
  let reviewerTurnNum = null;
  let reviewerReceipt = null;
  let reviewerWatcher = null;
  let signalReady;
  const reviewerWaiting = new Promise(r => { signalReady = r; });

  const dispatcher = {
    async dispatchGroupChatTurn(_meetingId, args) {
      const stepIndex = Number(args.workflowRun.stepIndex);
      // 同席位时两步都是 m1，只按成员数派发次数分不清是哪一步 —— 按步骤记。
      for (const memberId of args.targetMemberIds) dispatchedMemberIds.push(`${memberId}@${stepIndex}`);
      const reviewerPhase = stepIndex % 2 === 1;
      const sid = (reviewerPhase && !solo) ? 's2' : 's1';
      // 照生产：没有 reuseTurnNum 就开新的一轮（主干的同席位修复正是靠这个）。
      const turnNum = args.reuseTurnNum
        || orch.beginTurn(args.userInput, {
          runId: args.workflowRun.runId,
          appendUserMessage: args.appendUserMessage,
        }).turnNum;
      const receipt = orch.recordTurnPrompt(turnNum, sid, args.userInput, {
        workflowRun: args.workflowRun,
        memberId: sid === 's1' ? 'm1' : 'm2',
      });
      let result;
      if (reviewerPhase) {
        reviewerTurnNum = turnNum;
        reviewerReceipt = receipt;
        reviewerWatcher = createTurnCompletionWatcher({
          transcriptTap: new EventEmitter(), hubSessionId: sid, kind: 'claude',
          label: '评审', attempt: receipt,
        });
        watchers.set(sid, reviewerWatcher);
        const waiting = reviewerWatcher.wait();
        signalReady();
        result = await waiting;               // 停在这里等人工采用
        watchers.delete(sid);
      } else {
        builderTurnNum = turnNum;
        result = { sid, status: 'completed', text: BUILDER_TEXT };
      }
      result = { ...result, attemptId: receipt.attemptId };
      orch.completeTurn(turnNum, args.userInput, [result], { s1: 'm1', s2: 'm2' }, {},
        { runId: args.workflowRun.runId, workflowRun: args.workflowRun });
      return {
        status: ['completed', 'manual_extracted', 'manual_paste'].includes(result.status) ? 'completed' : result.status,
        turnNum,
        results: [result],
      };
    },
    interruptMeetingTurn: () => ({ ok: true }),
  };

  const meetingManager = {
    getMeeting: () => meeting,
    getAllMeetings: () => [meeting],
    updateMeeting: (_id, fields) => { if (fields.serialWorkflow) meeting.serialWorkflow = fields.serialWorkflow; return meeting; },
  };
  const sessionManager = { getSession: sid => sessions.get(sid) || null };
  const loopEngine = createLoopEngine({
    stepTextWait: { verdictQuietMs: 20, verdictCapMs: 200, builderQuietMs: 20, builderCapMs: 200 },
    getDispatcher: () => dispatcher,
    getOrchestrator: () => orch,
    meetingManager,
    sessionManager,
    resumeSession: async () => null,
    sendToRenderer: () => {},
    logger: silent(),
  });

  const ipc = (() => {
    const handlers = new Map();
    return {
      handle: (channel, fn) => handlers.set(channel, fn),
      invoke: (channel, args) => handlers.get(channel)({}, args),
    };
  })();
  registerGroupchatRecoveryIpc(ipc, {
    dispatchGroupChatTurn: dispatcher.dispatchGroupChatTurn,
    getHubDataDir: () => dataDir,
    getActiveWatchers: () => watchers,
    groupchat,
    groupChatWatcher: { extractStreamingText: () => null, resendCurrentPrompt: async () => ({ ok: true }) },
    isWorkflowRunning: mid => loopEngine.isRunning(mid),
    getLoopEngine: () => loopEngine,
    meetingManager,
    sendToRenderer: () => {},
    sessionManager,
    transcriptTap: { extractLatestTurn: async () => null },
    logger: silent(),
  });

  const enginePromise = loopEngine.runLoop(meetingId, '同席位采用验收');
  await Promise.race([
    reviewerWaiting,
    enginePromise.then(r => { throw new Error('引擎在评审等待之前就结束了：' + JSON.stringify(r)); }),
  ]);

  return {
    ipc, orch, meeting, meetingId, dataDir, loopEngine, enginePromise, watchers,
    dispatchedMemberIds,
    get builderTurnNum() { return builderTurnNum; },
    get reviewerTurnNum() { return reviewerTurnNum; },
    get reviewerReceipt() { return reviewerReceipt; },
    get reviewerWatcher() { return reviewerWatcher; },
  };
}

async function cleanup(env) {
  try { env.loopEngine.stopLoop(env.meetingId); } catch (e) { /* 已经停了 */ }
  const w = env.reviewerWatcher;
  if (w && !w.isSettled()) w.markErrored('test_cleanup');
  await Promise.race([env.enginePromise, new Promise(r => setTimeout(r, 1500))]);
}

async function adoptionScenario(solo) {
  const env = await runUntilReviewerWaits(solo);
  const sid = solo ? 's1' : 's2';
  try {
    const before = await env.ipc.invoke('workflow:step-context', { meetingId: env.meetingId });
    const response = await env.ipc.invoke('groupchat-adopt-pasted-result', {
      meetingId: env.meetingId, sid, text: REVIEW_TEXT,
      token: { meetingId: env.meetingId, sid, runId: before.runId, stepIndex: before.stepIndex, turnNum: before.turnNum },
    });
    await new Promise(r => setTimeout(r, 120));

    const builderTurn = env.orch.state.turns.find(x => x.n === env.builderTurnNum);
    const summary = devWorkbenchFeed.summarizeGroupState(env.orch.state);
    return {
      env, before, response, sid,
      builderTurnNum: env.builderTurnNum,
      reviewerTurnNum: env.reviewerTurnNum,
      builderSaved: builderTurn && builderTurn.by && builderTurn.by.s1,
      watcherSettled: env.reviewerWatcher.isSettled(),
      reviewAttempt: env.orch.getAttempt(env.reviewerReceipt.attemptId),
      workbench: summary,
      dispatched: env.dispatchedMemberIds.slice(),
    };
  } finally {
    await cleanup(env);
  }
}

function assertAdoption(d, { solo }) {
  const shape = JSON.stringify({
    solo, builderTurnNum: d.builderTurnNum, reviewerTurnNum: d.reviewerTurnNum,
    contextTurn: d.before.turnNum, turnSource: d.before.turnSource, response: d.response,
  });
  // ① 步骤上下文必须落在评审自己那一轮
  assert.strictEqual(d.before.turnNum, d.reviewerTurnNum, '步骤上下文的轮号必须是评审自己的：' + shape);
  assert.strictEqual(d.before.turnResolved, true, '轮号必须是从这一步自己的证据解析出来的：' + shape);
  // ② 尝试与轮次同源
  assert.strictEqual(Number(d.reviewAttempt.turnNum), Number(d.before.turnNum),
    'attempt.turnNum 与写入目标轮必须一致：' + shape);
  // ③ 实现正文与工作台交付卡都留得住
  assert.strictEqual(d.builderSaved, BUILDER_TEXT, '评审的采用不许覆盖实现报告：' + shape);
  const card = d.workbench && d.workbench.card;
  assert.ok(card && card.progress === '实现完成' && card.verified === '跑了单测',
    '工作台交付卡必须还在（被评审覆盖时它会变 null）：' + JSON.stringify(card));
  assert.strictEqual(String(card.sid), 's1', '交付卡应当仍然来自工作位那条消息：' + JSON.stringify(card));
  // ④ 评审那一步真的被接住了
  assert.strictEqual(d.watcherSettled, true, '活 watcher 必须被采用结算，否则那一步会一直干等：' + shape);
  assert.strictEqual(d.response.ok, true, shape);
  assert.strictEqual(d.response.adopted, true, shape);
  assert.strictEqual(d.response.advanced, true, '真的接住了才允许报「流程继续」：' + shape);
  assert.strictEqual(d.response.mode, 'watcher_settle', '应当结算活 watcher，而不是绕去补台账：' + shape);
  // ⑤ 不需要再问原成员：实现那一步和评审那一步各派发恰好一次
  assert.strictEqual(d.dispatched.filter(x => x === 'm1@0').length, 1,
    '实现那一步只该派发一次：' + JSON.stringify(d.dispatched));
  const reviewerMember = solo ? 'm1' : 'm2';
  assert.strictEqual(d.dispatched.filter(x => x === `${reviewerMember}@1`).length, 1,
    '评审那一步只该派发一次（采用之后不许再问一遍）：' + JSON.stringify(d.dispatched));
  assert.strictEqual(d.dispatched.length, 2, '一共只该有两次派发：' + JSON.stringify(d.dispatched));
}

async function main() {
  console.log('Running solo/two-seat reviewer adoption tests...');

  await t('双席位对照：评审与实现共享一轮，手动提供评审能接上（老行为不回退）', async () => {
    assertAdoption(await adoptionScenario(false), { solo: false });
  });

  await t('同席位：评审另起一轮，手动提供评审写进自己那一轮、不覆盖实现报告', async () => {
    const d = await adoptionScenario(true);
    assert.notStrictEqual(d.reviewerTurnNum, d.builderTurnNum,
      '同席位时评审必须另起一轮（主干 7e71608 的前提），否则本用例没有意义');
    assertAdoption(d, { solo: true });
  });

  await t('轮号读取退回「先用 currentTurnNum」的写法会让上面变红（防复发）', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main', 'groupchat', 'workflow-step-context.js'), 'utf8');
    assert.ok(/fallbackTurnNum = Number\(loopState\.currentTurnNum\)/.test(src),
      'currentTurnNum 只能当兜底，不能直接赋给 turnNum');
    assert.ok(!/\bturnNum = Number\(loopState\.currentTurnNum\)/.test(src),
      '一旦把 currentTurnNum 直接当作步骤轮号，同席位就会把评审写进实现那一轮');
    assert.ok(/turnSource = 'step_receipt'/.test(src) && /turnResolved/.test(src),
      '轮号来源必须可判定：只有出自这一步自己的证据才允许写入');
    const handlers = fs.readFileSync(path.join(__dirname, '..', 'main', 'ipc', 'groupchat-recovery-handlers.js'), 'utf8');
    assert.ok(/attempt_turn_mismatch/.test(handlers), '采用前要拒绝 attempt.turnNum 与目标轮不一致的组合');
    assert.ok(/engine_still_waiting/.test(handlers), '没接住等待就不许报「流程继续」');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
