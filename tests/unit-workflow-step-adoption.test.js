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
function stateWithStaleSnapshot({
  liveStatus = 'manual_extracted',
  liveText = 'A1 恢复后补上的完整回答',
  settledAt = 1000,
  // patchTurnResult 每次都会盖 lastPatchedAt / patchedAt。默认让它晚于步骤结算时刻，
  //   也就是「人是在这一步失败之后才把答案补进来的」——这正是要认的那种情形。
  patchedAt = 2000,
} = {}) {
  return {
    turns: [{
      n: 7,
      runId: null,
      by: { s1: liveText },
      byStatus: { s1: liveStatus },
      lastPatchedAt: patchedAt,
      meta: {
        workflowSteps: [{
          runId: 'RUN-1',
          kind: 'serial',
          stepIndex: 0,
          attempt: 1,
          targetMemberIds: ['m1'],
          completedAt: settledAt,
          // ← 结算那一刻拍下的快照，重提不会回头更新它
          results: [{ sid: 's1', status: 'errored', textLength: 0 }],
        }],
      },
    }],
    messages: [
      { id: 'u7', role: 'user', turnNum: 7, content: '第 1 步任务' },
      { id: 'a7-m1', role: 'assistant', turnNum: 7, sid: 's1', status: liveStatus, content: liveText, patchedAt },
    ],
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
        lastPatchedAt: 2000,
        meta: {
          workflowSteps: [{
            runId: 'RUN-1', kind: 'serial', stepIndex: 0, attempt: 1,
            targetMemberIds: ['m1', 'm2'], completedAt: 1000,
            results: [
              { sid: 's1', status: 'errored', textLength: 0 },
              { sid: 's2', status: 'errored', textLength: 0 },
            ],
          }],
        },
      }],
      messages: [
        { id: 'u7', role: 'user', turnNum: 7, content: 'go' },
        { id: 'a7-m1', role: 'assistant', turnNum: 7, sid: 's1', status: 'completed', content: '已经审完的正文', patchedAt: 2000 },
      ],
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

  await t('工作流步骤不再给自己装死墙钟（假终态的唯一产地）', () => {
    const engine = read('main/groupchat/loop-engine.js');
    assert.ok(!/turnTimeoutMs:/.test(engine),
      '工作流不许再传 turnTimeoutMs —— 到点强杀产出的 failed + hard_timeout 只是「Hub 不等了」，'
      + 'CLI 那边很可能还在跑，而这条假终态正是恢复入口重复派发的燃料');
    assert.ok(!/allowActiveExtend:/.test(engine),
      '续命判断是给墙钟打的补丁，墙拆了就不该留着');
    const dispatcher = read('main/groupchat/dispatcher.js');
    assert.ok(/disableHardTimeout: !\(Number\(turnTimeoutMs\) > 0\)/.test(dispatcher),
      'dispatcher 保留参数入口（默认不传即不设墙），回退成本才是零');
  });

  await t('等待中也能同步采用：不能把唯一的救援入口挡在门外', () => {
    const seg = handlers.slice(handlers.indexOf("'workflow:sync-step'"));
    assert.ok(!/if \(before\.running\) return \{ ok: false/.test(seg),
      '拆墙之后「正在跑」多半只是「正在等回答」，一律拒绝等于没有救援入口');
    assert.ok(/engineAlreadyRunning/.test(seg),
      '引擎已经在跑时不该再唤醒一次，但采用本身要放行');
  });

  await t('orchestrator 认识 manual_paste（否则台账把它当失败）', () => {
    const orch = read('core/group-chat-orchestrator.js');
    assert.ok(/manual_paste: ATTEMPT_COMPLETED/.test(orch), '状态映射缺 manual_paste');
    assert.ok(/MANUAL_RESULT_STATUSES/.test(orch),
      '人工结果守卫要同时覆盖 manual_extracted 与 manual_paste，否则粘贴的答案会被迟到的失败信号顶掉');
  });
}


// ───────────── 五、合并位第一轮 BLOCKERS 的回归 ─────────────

async function blockerRegressionTests() {
  // B3：串行工作流所有步骤复用同一个 turn，turn.by 只按 sid 存。
  //     只按 turnNum + sid 判「这位答过了」，A1 → A2 → A1 的第三步会拿第一步的正文顶。
  await t('B3 · 这一步没有自己的记录时，绝不能拿别的步骤的答案顶上', () => {
    const turn = {
      n: 7,
      by: { s1: '第 1 步的实现说明' },
      byStatus: { s1: 'completed' },
      lastPatchedAt: 2000,
      meta: {
        workflowSteps: [{
          runId: 'RUN-1', stepIndex: 0, targetMemberIds: ['m1'], completedAt: 1000,
          results: [{ sid: 's1', status: 'completed', textLength: 40 }],
        }],
      },
    };
    const stepEntryFor = idx => (turn.meta.workflowSteps.find(e => Number(e.stepIndex) === idx) || null);

    // 第 1 步：自己的记录就写着成功 → 成交
    assert.strictEqual(W.inspectStepResults({
      turn, turnNum: 7, targetSids: ['s1'], stepEntry: stepEntryFor(0), requireStepIdentity: true,
    }).complete, true);

    // 第 3 步（同一位成员）：没有自己的记录 → 绝不成交
    const third = W.inspectStepResults({
      turn, turnNum: 7, targetSids: ['s1'], stepEntry: stepEntryFor(2), requireStepIdentity: true,
    });
    assert.strictEqual(third.complete, false,
      '第三步从没跑过，不能因为「同一个人早先答过」就跳过它');
    assert.deepStrictEqual(third.missingSids, ['s1']);
    assert.strictEqual(third.results[0].why, 'step_never_ran_for_member');

    // 退回不带身份的宽松判据 ⇒ 第三步会被误判成已完成（这就是 B3 的原样）
    assert.strictEqual(W.inspectStepResults({ turn, turnNum: 7, targetSids: ['s1'] }).complete, true,
      '这条断言固定住「不带步骤身份就会误判」，改动时能看出差别');
  });

  await t('B3 · 这一步失败在先、人后来补的答案才算数（比结算时刻新）', () => {
    const stepEntry = {
      runId: 'RUN-1', stepIndex: 1, targetMemberIds: ['m1'], completedAt: 5000,
      results: [{ sid: 's1', status: 'errored', textLength: 0 }],
    };
    const older = {
      n: 7, by: { s1: '这段是更早的步骤留下的' }, byStatus: { s1: 'completed' }, lastPatchedAt: 4000,
    };
    const newer = {
      n: 7, by: { s1: '人后来粘进来的正文' }, byStatus: { s1: 'manual_paste' }, lastPatchedAt: 6000,
    };
    assert.strictEqual(W.inspectStepResults({
      turn: older, turnNum: 7, targetSids: ['s1'], stepEntry, requireStepIdentity: true,
    }).complete, false, '比这一步结算还早的正文不属于这一步');
    assert.strictEqual(W.inspectStepResults({
      turn: newer, turnNum: 7, targetSids: ['s1'], stepEntry, requireStepIdentity: true,
    }).complete, true, '这一步失败之后才补进来的正文，才是给这一步的');
  });

  // B5：恢复入口在当前步骤没有回答时，绝不能重发原成员。
  await t('B5 · 恢复时当前步骤没有回答：明确暂停，一次派发都不许有', async () => {
    const { engine, dispatchedMemberIds } = mkSerialEngine(
      stateWithStaleSnapshot({ liveStatus: 'errored', liveText: '' }));
    const state = await engine.runSerial('serial-mtg', null, { ...RESUMABLE }, { noRedispatch: true });
    assert.deepStrictEqual(dispatchedMemberIds, [],
      '「继续」不是「重问一遍」；实际派发：' + JSON.stringify(dispatchedMemberIds));
    assert.strictEqual(state.status, 'paused');
    assert.strictEqual(state.lastError && state.lastError.reason, 'awaiting_result');
  });

  await t('B5 · 恢复闸门只守当前这一步：有答案就照常推进到下一步', async () => {
    const { engine, dispatchedMemberIds } = mkSerialEngine(stateWithStaleSnapshot());
    await engine.runSerial('serial-mtg', null, { ...RESUMABLE }, { noRedispatch: true });
    assert.strictEqual(dispatchedMemberIds.filter(id => id === 'm1').length, 0);
    assert.strictEqual(dispatchedMemberIds.filter(id => id === 'm2').length, 1,
      '守的是恢复时停在的那一步，后面的步骤该派发照样派发');
  });

  await t('B1 · 步骤成功判据认 manual_paste（开发闭环不许再判它失败）', () => {
    const engine = require('fs').readFileSync(
      path.join(__dirname, '..', 'main', 'groupchat', 'loop-engine.js'), 'utf8');
    assert.ok(!/\['completed', 'manual_extracted'\]\.includes\(result\.status\)/.test(engine),
      'resultIsSuccessful 不能再自带一份短名单 —— 它和新判据必须是同一套白名单');
    assert.ok(/WSR\.isAdoptedStatus\(result\.status\)/.test(engine),
      '步骤成功判据要走共享的 isAdoptedStatus');
  });
}

async function main() {
  console.log('Running workflow step adoption tests...');
  await pureFunctionTests();
  await tokenTests();
  await engineTests();
  await contractTests();
  await blockerRegressionTests();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
