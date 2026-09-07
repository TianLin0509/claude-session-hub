'use strict';
/*
 * 工作流「结果采用」单测（2026-09-07 Claude 1）
 * 跑法：node tests/unit-workflow-step-adoption.test.js
 *
 * 复现的是维护者报的这件事：
 *   agent 中途断了 → 步骤失败 → 状态栏显示「已暂停」
 *   agent 自己好了并答完 → 用户点「重提」→ 答案已经在群聊气泡里
 *   用户点「继续」→ **同一个 agent 又被问了一遍**
 *
 * 台账形状照生产真实形状构造：
 *   turn.meta.workflowSteps[] 是结算那一刻的**快照**（failed / textLength 0，永不更新）
 *   turn.by / turn.byStatus 是**活状态**（重提写的就是这里）
 * 旧实现的闸门读快照，所以看不见答案 —— 这正是「退回旧写法会变红」的那一条。
 */
const assert = require('assert');
const path = require('path');
const { createLoopEngine } = require('../main/groupchat/loop-engine.js');
const W = require('../core/workflow-step-result.js');

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('  ✓ ' + name); }
  catch (e) { fail += 1; console.log('  ✗ ' + name + '\n      ' + (e && e.stack || e)); }
}

// ───────────────────────── 一、纯函数判据 ─────────────────────────

async function pureFunctionTests() {
  await t('三种来源都算交货：completed / manual_extracted / manual_paste', () => {
    for (const status of ['completed', 'manual_extracted', 'manual_paste']) {
      assert.strictEqual(W.isAdoptedStatus(status), true, status + ' 应算交货');
    }
  });

  await t('失败态一律不算交货', () => {
    for (const status of ['errored', 'failed', 'absent', 'interrupted', 'superseded', 'timeout']) {
      assert.strictEqual(W.isAdoptedStatus(status), false, status + ' 不该算交货');
    }
  });

  await t('有状态但没正文不算交货（空字符串 / 全空白都不算）', () => {
    const turn = { by: { s1: '   ' }, byStatus: { s1: 'completed' } };
    const view = W.inspectStepResults({ turn, targetSids: ['s1'] });
    assert.strictEqual(view.complete, false);
    assert.deepStrictEqual(view.missingSids, ['s1']);
  });

  await t('turn 还没建时退回消息列表取活状态', () => {
    const messages = [
      { role: 'user', turnNum: 7, content: 'go' },
      { role: 'assistant', turnNum: 7, sid: 's1', status: 'manual_paste', content: '人工粘贴的正文' },
    ];
    const view = W.inspectStepResults({ turn: null, messages, turnNum: 7, targetSids: ['s1'] });
    assert.strictEqual(view.complete, true);
    assert.strictEqual(view.results[0].status, 'manual_paste');
  });

  await t('多席位少一个也不算这一步成交，且 missingSids 只列缺的那个', () => {
    const turn = {
      by: { s1: '审完了', s2: '' },
      byStatus: { s1: 'completed', s2: 'errored' },
    };
    const view = W.inspectStepResults({ turn, targetSids: ['s1', 's2'] });
    assert.strictEqual(view.complete, false);
    assert.strictEqual(view.partial, true);
    assert.deepStrictEqual(view.missingSids, ['s2']);
  });

  await t('同步永远不返回 redispatch —— 重发只能由明确入口发起', () => {
    const turn = { by: {}, byStatus: {} };
    const d = W.decideResumeAction({ turn, targetSids: ['s1'] });
    assert.strictEqual(d.action, 'wait');
    assert.notStrictEqual(d.action, 'redispatch');
  });

  await t('全员有答案 → advance；用户停止 → blocked，且 blocked 优先于 advance', () => {
    const turn = { by: { s1: 'ok' }, byStatus: { s1: 'manual_extracted' } };
    assert.strictEqual(W.decideResumeAction({ turn, targetSids: ['s1'] }).action, 'advance');
    assert.strictEqual(
      W.decideResumeAction({ turn, targetSids: ['s1'], stopped: true }).action, 'blocked');
    assert.strictEqual(
      W.decideResumeAction({ turn, targetSids: ['s1'], discussing: true }).action, 'blocked');
  });

  await t('状态栏文案由同一判据派生：有答案时不再显示「已暂停」', () => {
    const turn = { by: { s1: 'ok' }, byStatus: { s1: 'manual_extracted' } };
    const label = W.describeResumeAction(W.decideResumeAction({ turn, targetSids: ['s1'] }),
      { stepLabel: '第 1 步', nextLabel: 'Codex 2' });
    assert.strictEqual(label.tone, 'ok');
    assert.ok(!/已暂停/.test(label.label), '有答案时标签不该还写「已暂停」：' + label.label);
    assert.ok(/不会再问一遍/.test(label.hint), '预告里必须说清不会重发：' + label.hint);
  });

  await t('没答案时的文案必须预告「不会重发」', () => {
    const label = W.describeResumeAction(
      W.decideResumeAction({ turn: { by: {}, byStatus: {} }, targetSids: ['s1'] }), {});
    assert.ok(/不会重发|找不到就继续等/.test(label.hint), '文案必须说明不发 prompt：' + label.hint);
  });
}

// ───────────────────── 二、粘贴弹窗的过期判定 ─────────────────────

async function tokenTests() {
  const token = { meetingId: 'm', sid: 's1', runId: 'r1', turnNum: 7, stepIndex: 0 };

  await t('身份一致 → 放行', () => {
    const v = W.validateAdoptionToken(token, { meetingId: 'm', sid: 's1', runId: 'r1', turnNum: 7, stepIndex: 0 });
    assert.strictEqual(v.ok, true);
  });

  await t('流程已推进到下一步 → 拒绝，不许灌进新步骤', () => {
    const v = W.validateAdoptionToken(token, { meetingId: 'm', sid: 's1', runId: 'r1', turnNum: 7, stepIndex: 1 });
    assert.deepStrictEqual([v.ok, v.reason], [false, 'step_advanced']);
  });

  await t('已经换了新一轮 / 新任务 → 拒绝', () => {
    assert.strictEqual(W.validateAdoptionToken(token,
      { meetingId: 'm', sid: 's1', runId: 'r1', turnNum: 8, stepIndex: 0 }).reason, 'turn_advanced');
    assert.strictEqual(W.validateAdoptionToken(token,
      { meetingId: 'm', sid: 's1', runId: 'r2', turnNum: 7, stepIndex: 0 }).reason, 'run_superseded');
  });

  await t('用户已停止 → 拒绝（硬约束：停止之后绝不推进）', () => {
    const v = W.validateAdoptionToken(token,
      { meetingId: 'm', sid: 's1', runId: 'r1', turnNum: 7, stepIndex: 0, stopped: true });
    assert.deepStrictEqual([v.ok, v.reason], [false, 'user_stopped']);
  });

  await t('自动结果先到 → 不覆盖、不重启', () => {
    const v = W.validateAdoptionToken(token,
      { meetingId: 'm', sid: 's1', runId: 'r1', turnNum: 7, stepIndex: 0, alreadyAdopted: true });
    assert.deepStrictEqual([v.ok, v.reason], [false, 'already_adopted']);
    assert.ok(/不覆盖/.test(W.describeAdoptionRejection('already_adopted')));
  });

  await t('每个拒绝原因都有人话', () => {
    for (const reason of ['meeting_mismatch', 'member_mismatch', 'user_stopped',
      'run_superseded', 'turn_advanced', 'step_advanced', 'already_adopted', 'empty_text']) {
      const text = W.describeAdoptionRejection(reason);
      assert.ok(text && text.length > 3 && !/^[a-z_]+$/.test(text), reason + ' 缺人话文案');
    }
  });
}

// ────────── 三、真实循环引擎 + 计数 dispatcher：核心验收「不重复派发」──────────

// 生产真实形状：第 1 步（m1/s1）先失败留下快照，随后被重提补上活状态。
function stateWithStaleSnapshot({ liveStatus = 'manual_extracted', liveText = 'A1 恢复后补上的完整回答' } = {}) {
  return {
    turns: [{
      n: 7,
      runId: null,
      by: { s1: liveText },
      byStatus: { s1: liveStatus },
      meta: {
        workflowSteps: [{
          runId: 'RUN-1',
          kind: 'serial',
          stepIndex: 0,
          attempt: 1,
          targetMemberIds: ['m1'],
          completedAt: 1,
          // ← 结算那一刻拍下的快照，重提不会回头更新它
          results: [{ sid: 's1', status: 'errored', textLength: 0 }],
        }],
      },
    }],
    pendingPrompts: {},
  };
}

function mkSerialEngine(orchestratorState, { steps = [['m1'], ['m2']] } = {}) {
  const sessions = new Map([
    ['s1', { id: 's1', title: 'Claude 1', kind: 'claude', status: 'idle', cwd: 'C:/work' }],
    ['s2', { id: 's2', title: 'Codex 2', kind: 'codex', status: 'idle', cwd: 'C:/work' }],
  ]);
  const meeting = {
    id: 'serial-mtg',
    groupChat: true,
    subSessions: ['s1', 's2'],
    serialWorkflow: {
      enabled: true,
      steps,
      stepConfigs: steps.map((_s, i) => ({ name: `step-${i + 1}`, prompt: `role-${i + 1}` })),
      loop: { enabled: false },
    },
  };
  const dispatchedMemberIds = [];
  const deps = {
    stepTextWait: { verdictQuietMs: 20, verdictCapMs: 200, builderQuietMs: 20, builderCapMs: 200 },
    getDispatcher: () => ({
      async dispatchGroupChatTurn(_meetingId, args) {
        dispatchedMemberIds.push(...args.targetMemberIds);
        return {
          status: 'completed',
          turnNum: 7,
          results: args.targetMemberIds.map(memberId => ({
            sid: memberId === 'm1' ? 's1' : 's2',
            status: 'completed',
            text: `${memberId} answer`,
          })),
        };
      },
      interruptMeetingTurn: () => ({ ok: true }),
    }),
    getOrchestrator: () => ({ getState: () => orchestratorState }),
    meetingManager: {
      getMeeting: () => meeting,
      getAllMeetings: () => [meeting],
      updateMeeting: (_id, fields) => { if (fields.serialWorkflow) meeting.serialWorkflow = fields.serialWorkflow; return meeting; },
    },
    sessionManager: { getSession: sid => sessions.get(sid) },
    resumeSession: async () => null,
    sendToRenderer: () => {},
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  };
  return { engine: createLoopEngine(deps), meeting, dispatchedMemberIds };
}

const RESUMABLE = {
  schemaVersion: 1, driver: 'main', kind: 'serial',
  runId: 'RUN-1', goal: '目标', status: 'running',
  nextStepIndex: 0, currentStepIndex: 0, currentTurnNum: 7,
  attemptsByStep: { 0: 1 }, completedSteps: [], startedAt: 1,
  lastError: { stage: 'serial', stepIndex: 0, reason: 'response_timeout', at: 1 },
};

async function engineTests() {
  await t('【核心】重提之后恢复：A1 一次都不再派发，A2 恰好派发一次', async () => {
    const { engine, dispatchedMemberIds } = mkSerialEngine(stateWithStaleSnapshot());
    await engine.runSerial('serial-mtg', null, { ...RESUMABLE });
    assert.strictEqual(dispatchedMemberIds.filter(id => id === 'm1').length, 0,
      'A1 已有回答，绝不该被重新派发；实际派发：' + JSON.stringify(dispatchedMemberIds));
    assert.strictEqual(dispatchedMemberIds.filter(id => id === 'm2').length, 1,
      'A2 应恰好派发一次；实际派发：' + JSON.stringify(dispatchedMemberIds));
  });

  await t('手动粘贴（manual_paste）同样被认成交货，A1 不重跑', async () => {
    const { engine, dispatchedMemberIds } = mkSerialEngine(
      stateWithStaleSnapshot({ liveStatus: 'manual_paste', liveText: '用户从 CLI 粘进来的正文' }));
    await engine.runSerial('serial-mtg', null, { ...RESUMABLE });
    assert.strictEqual(dispatchedMemberIds.filter(id => id === 'm1').length, 0,
      '人工粘贴也是交货，A1 不该被重问；实际：' + JSON.stringify(dispatchedMemberIds));
    assert.strictEqual(dispatchedMemberIds.filter(id => id === 'm2').length, 1);
  });

  await t('活状态是失败态时照旧重发 A1（不能把「没答」当「答了」）', async () => {
    const { engine, dispatchedMemberIds } = mkSerialEngine(
      stateWithStaleSnapshot({ liveStatus: 'errored', liveText: '' }));
    await engine.runSerial('serial-mtg', null, { ...RESUMABLE });
    assert.strictEqual(dispatchedMemberIds.filter(id => id === 'm1').length, 1,
      'A1 真的没答，就该重发一次；实际：' + JSON.stringify(dispatchedMemberIds));
  });

  await t('多席位步骤只补缺口：已答的那位不再被问', async () => {
    const state = {
      turns: [{
        n: 7,
        by: { s1: '已经审完的正文' },
        byStatus: { s1: 'completed' },
        meta: {
          workflowSteps: [{
            runId: 'RUN-1', kind: 'serial', stepIndex: 0, attempt: 1,
            targetMemberIds: ['m1', 'm2'], completedAt: 1,
            results: [
              { sid: 's1', status: 'errored', textLength: 0 },
              { sid: 's2', status: 'errored', textLength: 0 },
            ],
          }],
        },
      }],
      pendingPrompts: {},
    };
    const { engine, dispatchedMemberIds } = mkSerialEngine(state, { steps: [['m1', 'm2']] });
    await engine.runSerial('serial-mtg', null, { ...RESUMABLE });
    assert.strictEqual(dispatchedMemberIds.filter(id => id === 'm1').length, 0,
      'm1 已有回答，不该被重问；实际：' + JSON.stringify(dispatchedMemberIds));
    assert.strictEqual(dispatchedMemberIds.filter(id => id === 'm2').length, 1,
      'm2 是缺口，应恰好补一次；实际：' + JSON.stringify(dispatchedMemberIds));
  });

  await t('恢复不再清零重试计数（loop:resume / serial:resume 契约）', () => {
    const fs = require('fs');
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'main', 'ipc', 'loop-handlers.js'), 'utf8');
    assert.ok(!/stepAttempt:\s*0/.test(source),
      'loop:resume 不许把 stepAttempt 清零 —— 清零等于把「已经试过」抹掉，再点一次就又重跑一轮');
    assert.ok(!/attemptsByStep\[resumeIndex\]\s*=\s*0/.test(source),
      'serial:resume 不许把当前步骤的尝试计数清零');
  });
}


// ─────────── 四、按钮语义契约：名字必须说清后果 ───────────

async function contractTests() {
  const fs = require('fs');
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const room = read('renderer/meeting-room.js');
  const handlers = read('main/ipc/groupchat-recovery-handlers.js');

  await t('状态栏不再挂那个含义含糊的「已暂停 · 继续」入口', () => {
    assert.ok(!/data-loop-resume/.test(room),
      '「已暂停 · 继续」会重发 prompt，不能留在状态栏当默认动作');
    assert.ok(!/data-serial-resume/.test(room), '串行侧同上');
    assert.ok(/data-step-sync/.test(room) && /data-step-paste/.test(room),
      '要换成「同步回答」与「手动提供回答」两个说得清后果的入口');
  });

  await t('「同步回答」调的是不发 prompt 的那个 IPC', () => {
    const seg = room.slice(room.indexOf("data-step-sync]"), room.indexOf("data-step-paste]"));
    assert.ok(/workflow:sync-step/.test(seg), '同步入口必须走 workflow:sync-step');
    assert.ok(!/loop:resume|serial:resume|groupchat-resend/.test(seg),
      '同步入口不许直接调恢复或重发 —— 那才是「点一下又重跑一轮」的来源');
  });

  await t('粘贴弹窗提交时带 token，主进程按 token 再核一次', () => {
    const seg = room.slice(room.indexOf('_openStepPasteDialog'));
    assert.ok(/groupchat-adopt-pasted-result/.test(seg), '粘贴走独立的采用入口');
    assert.ok(/token\s*[,:]/.test(seg), '提交必须带打开弹窗那一刻的身份 token');
    assert.ok(/validateAdoptionToken/.test(handlers), '主进程必须校验 token，不能只信前端');
  });

  await t('手动粘贴如实标注来源，不冒充 provider 自动完成', () => {
    assert.ok(/origin === 'paste' \? 'manual_paste'/.test(handlers),
      '粘贴的结果状态必须是 manual_paste');
    assert.ok(/origin === 'paste' \? 'manual_paste'/.test(handlers) || /adoptedSignal/.test(handlers),
      'signalSource 也要如实记');
  });

  await t('三种来源共用一个写入口（不留「卡片好了、循环没动」的分叉）', () => {
    assert.ok(/function adoptStepResult\(/.test(handlers), '必须有统一采用入口');
    const calls = (handlers.match(/adoptStepResult\(\{/g) || []).length;
    assert.ok(calls >= 2, '重提与粘贴都要走它，实际调用点：' + calls);
  });

  await t('orchestrator 认识 manual_paste（否则台账把它当失败）', () => {
    const orch = read('core/group-chat-orchestrator.js');
    assert.ok(/manual_paste: ATTEMPT_COMPLETED/.test(orch), '状态映射缺 manual_paste');
    assert.ok(/MANUAL_RESULT_STATUSES/.test(orch),
      '人工结果守卫要同时覆盖 manual_extracted 与 manual_paste，否则粘贴的答案会被迟到的失败信号顶掉');
  });
}

async function main() {
  console.log('Running workflow step adoption tests...');
  await pureFunctionTests();
  await tokenTests();
  await engineTests();
  await contractTests();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
