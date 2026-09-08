'use strict';
/**
 * 循环引擎 · MD 交接闸门。
 *
 * 守的是这句话：「某次 CLI 回复结束」不再等于「本开发步骤完成」。
 * agent 回了话但没交出「已完成-…」文件时，引擎必须停在当前阶段并说清缺什么，
 * 而不是把审查派出去（评审会看到半成品分支），更不能判成代码 FAIL。
 *
 * 跑法：node tests/unit-loop-md-handoff.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLoopEngine } = require('../main/groupchat/loop-engine.js');
const DOCS = require('../core/dev-task-docs.js');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (error) { fail++; console.log('  ✗ ' + name + '\n      ' + (error && error.message)); }
}

const BUILD_DOC = ['# 阶段1协作手册', 'worktree C:/AIWork/x，分支 feat/y，完整提交 abc1234def。', '实际验证：跑了全量单测 386 通过。', '未完成项：无。'].join('\n');
const REVIEW_PASS = ['# 阶段1合并手册', '我独立跑了全量单测和 dry-run。', 'RESULT: PASS', 'BLOCKERS: 无', 'VERIFIED: node scripts/run_unit_tests.js 386 通过', 'NEXT: 无'].join('\n');
const REVIEW_FAIL = ['# 阶段1合并手册', '复现了缺陷。', 'RESULT: FAIL', 'BLOCKERS: 补充没送到待命成员', 'VERIFIED: 隔离实例复现一次', 'NEXT: 修完再审'].join('\n');
const KICKOFF_DOC = ['# 开题报告', '## 目标', '让交接靠文件改名。', '## 非目标', '不做工作流编辑器。', '## 验收标准', '全程可跑通。', '## 风险与回退', '停止新派发即可。'].join('\n');

/** 构造一套 mock，返回引擎 + 任务目录 + 派发记录。 */
function mk(opts = {}) {
  const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-md-'));
  const meetingId = 'mtg';
  const docsDir = DOCS.taskDocsDir(hubDir, meetingId);
  let workflow = {
    enabled: true,
    steps: [['m1'], ['m2']],
    stepConfigs: [{ prompt: 'builder role' }, { prompt: 'reviewer role' }],
    loop: { enabled: true, maxRounds: opts.maxRounds || 2 },
    mdHandoff: opts.mdHandoff !== false,
    devPhase: opts.devPhase || 'build',
    ...(opts.workflow || {}),
  };
  const turnCalls = [];
  const deps = {
    stepTextWait: { verdictQuietMs: 10, verdictCapMs: 60, builderQuietMs: 10, builderCapMs: 60, docPollMs: 20, docCapMs: 200 },
    getHubDataDir: () => hubDir,
    getDispatcher: () => ({
      dispatchGroupChatTurn: async (_mid, args) => {
        turnCalls.push(args);
        if (typeof opts.onDispatch === 'function') await opts.onDispatch(args, docsDir, turnCalls.length);
        const isBuilder = String(args.targetMemberIds[0]) === 'm1';
        return {
          status: 'completed',
          turnNum: turnCalls.length,
          results: [{ sid: isBuilder ? 'sB' : 'sR', status: 'completed', text: opts.chatText ? opts.chatText(args, turnCalls.length) : '好的，我说两句人话。' }],
        };
      },
      interruptMeetingTurn: () => {},
    }),
    meetingManager: {
      getMeeting: () => ({ id: meetingId, groupChat: true, scene: 'dev', subSessions: ['sB', 'sR'], slotSpecs: [{ memberId: 'm1' }, { memberId: 'm2' }], serialWorkflow: workflow }),
      updateMeeting: (_id, fields) => { if (fields.serialWorkflow) workflow = { ...workflow, ...fields.serialWorkflow }; },
      getAllMeetings: () => [{ id: meetingId, groupChat: true, scene: 'dev', serialWorkflow: workflow }],
    },
    sessionManager: { getSession: (sid) => ({ id: sid, title: sid, kind: 'codex', status: 'idle' }) },
    sendToRenderer: () => {},
    writeReport: () => null,
    logger: { log: () => {} },
  };
  return { engine: createLoopEngine(deps), docsDir, turnCalls, getWorkflow: () => workflow, meetingId };
}

function writeDoc(docsDir, pos, body) {
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, DOCS.docSpecForPos(pos).done), body, 'utf8');
}

(async () => {
  console.log('loop-engine · MD 交接闸门');

  await t('工作位回了话但没交手册 → 停在当前阶段，不把审查派出去，也不判 FAIL', async () => {
    const h = mk();
    const state = await h.engine.runLoop('mtg', '做点事', null, {});
    assert.strictEqual(state.status, 'paused', '不是失败，是「还不能接收」');
    assert.strictEqual(state.lastError.stage, 'builder');
    assert.strictEqual(state.lastError.reason, 'handoff_pending');
    assert.strictEqual(state.lastError.doc, '已完成-阶段1协作手册.md', '界面要能说出缺的是哪个文件');
    assert.strictEqual(h.turnCalls.length, 1, '只派了工作位；评审绝不能看到半成品分支');
  });

  await t('交了手册但审查没交 → 停在审查这一步，工作位不被重派', async () => {
    const h = mk({ onDispatch: (args, docsDir) => { if (String(args.targetMemberIds[0]) === 'm1') writeDoc(docsDir, 1, BUILD_DOC); } });
    const state = await h.engine.runLoop('mtg', '做点事', null, {});
    assert.strictEqual(state.status, 'paused');
    assert.strictEqual(state.lastError.stage, 'reviewer');
    assert.strictEqual(state.lastError.doc, '已完成-阶段1合并手册.md');
    assert.strictEqual(h.turnCalls.length, 2, '工作位一次、审查一次，没有重复派工');
  });

  await t('两份手册都交了且 RESULT: PASS → 正常收口，只跑一轮', async () => {
    const h = mk({
      onDispatch: (args, docsDir) => {
        if (String(args.targetMemberIds[0]) === 'm1') writeDoc(docsDir, 1, BUILD_DOC);
        else writeDoc(docsDir, 2, REVIEW_PASS);
      },
    });
    const state = await h.engine.runLoop('mtg', '做点事', null, {});
    assert.strictEqual(state.status, 'done', '裁决从合并手册里取，不依赖群聊回执');
    assert.strictEqual(h.turnCalls.length, 2);
    assert.strictEqual(DOCS.acceptedAt(h.getWorkflow().taskDocs, 2).verdict, 'pass', '接收凭据要落盘');
  });

  await t('B07 合并手册裁决完整、群聊里一句人话都没有 → 照样推进，不被缺回执卡住', async () => {
    const h = mk({
      chatText: () => '（这一轮 CLI 什么协议字段都没输出）',
      onDispatch: (args, docsDir) => {
        if (String(args.targetMemberIds[0]) === 'm1') writeDoc(docsDir, 1, BUILD_DOC);
        else writeDoc(docsDir, 2, REVIEW_PASS);
      },
    });
    const state = await h.engine.runLoop('mtg', '做点事', null, {});
    assert.strictEqual(state.status, 'done');
  });

  await t('B08 手册判 PASS、群聊里说 FAIL → 不猜，停在待核对', async () => {
    const h = mk({
      chatText: (args) => (String(args.targetMemberIds[0]) === 'm2'
        ? 'RESULT: FAIL\nBLOCKERS: 我改主意了\nVERIFIED: 跑过\nNEXT: 无' : '干完了'),
      onDispatch: (args, docsDir) => {
        if (String(args.targetMemberIds[0]) === 'm1') writeDoc(docsDir, 1, BUILD_DOC);
        else writeDoc(docsDir, 2, REVIEW_PASS);
      },
    });
    const state = await h.engine.runLoop('mtg', '做点事', null, {});
    assert.strictEqual(state.status, 'paused');
    assert.strictEqual(state.lastError.reason, 'verdict_conflict');
    assert(/PASS/.test(state.lastError.detail) && /FAIL/.test(state.lastError.detail), '要说清两边各说了什么');
  });

  await t('FAIL 走下一轮：新一轮用新的阶段文件名，旧文件留着当对照', async () => {
    let round = 0;
    const h = mk({
      maxRounds: 2,
      onDispatch: (args, docsDir) => {
        const builder = String(args.targetMemberIds[0]) === 'm1';
        if (builder) { round += 1; writeDoc(docsDir, DOCS.posForLoopStep(round - 1, 'builder'), BUILD_DOC + ' round' + round); }
        else writeDoc(docsDir, DOCS.posForLoopStep(round - 1, 'reviewer'), round === 1 ? REVIEW_FAIL : REVIEW_PASS);
      },
    });
    const state = await h.engine.runLoop('mtg', '做点事', null, {});
    assert.strictEqual(state.status, 'done');
    assert.strictEqual(round, 2, 'FAIL 之后才该有第二轮');
    assert(fs.existsSync(path.join(h.docsDir, '已完成-阶段1协作手册.md')), '旧轮文件保留作对照');
    assert(fs.existsSync(path.join(h.docsDir, '已完成-阶段2协作手册.md')));
  });

  await t('B04/D02 文件已经在了（丢事件 / 重启后重扫）→ 认出交付，不再派那一位', async () => {
    const h = mk();
    // 模拟：上一次运行时工作位已经交付、Hub 崩在派审查之前
    writeDoc(h.docsDir, 1, BUILD_DOC);
    const state = await h.engine.runLoop('mtg', '做点事', null, {});
    assert.strictEqual(state.status, 'paused', '审查还没交，停在审查这一步');
    assert.strictEqual(state.lastError.stage, 'reviewer');
    assert.strictEqual(h.turnCalls.length, 1, '只派了审查；工作位不被重做');
    assert.strictEqual(String(h.turnCalls[0].targetMemberIds[0]), 'm2');
  });

  await t('暂停后维护者发了新目标 → 新运行从下一个阶段文件起步，不把上一轮的交付当成这一轮的', async () => {
    let round = 0;
    const h = mk({
      onDispatch: (args, docsDir) => {
        const builder = String(args.targetMemberIds[0]) === 'm1';
        if (builder) { round += 1; writeDoc(docsDir, DOCS.posForLoopStep(round - 1, 'builder'), BUILD_DOC); }
        else writeDoc(docsDir, DOCS.posForLoopStep(round - 1, 'reviewer'), REVIEW_PASS);
      },
    });
    const first = await h.engine.runLoop('mtg', '第一个目标', null, {});
    assert.strictEqual(first.status, 'done');
    // 新目标 = 新运行（persistedLoopState 为 null），不能因为阶段1已接收就跳过实现
    h.turnCalls.length = 0;
    const second = await h.engine.runLoop('mtg', '完全不同的第二个目标', null, {});
    assert.strictEqual(second.posBase, 3, '阶段1 两份都已接收 → 新运行从阶段2协作手册开始');
    assert(h.turnCalls.length >= 1 && String(h.turnCalls[0].targetMemberIds[0]) === 'm1',
      '新目标必须真的重新派工作位，不能拿上一轮的交付顶账');
    assert(/阶段2协作手册/.test(h.turnCalls[0].userInput), '给它的文档入口也要是新阶段的文件');
  });

  await t('续跑沿用同一个阶段文件起点：不会跑去找别的轮次的文件', async () => {
    const h = mk({ onDispatch: (args, docsDir) => { if (String(args.targetMemberIds[0]) === 'm1') writeDoc(docsDir, 3, BUILD_DOC); } });
    const persisted = { status: 'running', round: 0, phase: 'reaching', goal: '续跑', runId: 'loop-x', posBase: 3, history: [] };
    const state = await h.engine.runLoop('mtg', null, persisted, {});
    assert.strictEqual(state.posBase, 3);
    assert.strictEqual(state.lastError.doc, '已完成-阶段2合并手册.md', '停在这一轮该等的那个文件上');
  });

  await t('老房间没有 mdHandoff 字段 → 行为一字不改，仍按聊天裁决推进', async () => {
    const h = mk({
      mdHandoff: false,
      chatText: (args) => (String(args.targetMemberIds[0]) === 'm1'
        ? 'PROGRESS: 做完了' : 'RESULT: PASS\nBLOCKERS: 无\nVERIFIED: 跑了单测\nNEXT: 无'),
    });
    const state = await h.engine.runLoop('mtg', '做点事', null, {});
    assert.strictEqual(state.status, 'done', '不打开 MD 交接的房间不该被新闸门挡住');
    assert.strictEqual(h.getWorkflow().taskDocs, undefined, '也不该给它建账本');
  });

  await t('开题：只派给指定执笔者；报告交付后自动开工，不要第二次确认', async () => {
    const h = mk({
      devPhase: 'discuss',
      onDispatch: (args, docsDir) => {
        if (args.workflowRun && args.workflowRun.kind === 'kickoff') writeDoc(docsDir, 0, KICKOFF_DOC);
        else if (String(args.targetMemberIds[0]) === 'm1') writeDoc(docsDir, 1, BUILD_DOC);
        else writeDoc(docsDir, 2, REVIEW_PASS);
      },
    });
    const outcome = await h.engine.runKickoff('mtg', { authorMemberId: 'm2' });
    assert.strictEqual(outcome.ok, true);
    assert.deepStrictEqual(h.turnCalls[0].targetMemberIds, ['m2'], '只给指定的那一位派，另一位不抢写');
    assert.strictEqual(h.getWorkflow().devPhase, 'build', '接收后自动翻到实现阶段');
    assert(/开题报告/.test(outcome.goal) && /已完成-开题报告\.md/.test(outcome.goal), '目标指向任务书本体，不复述全文');
  });

  await t('开题报告缺四项 → 留在开题阶段等它补，不自动开工', async () => {
    const h = mk({
      devPhase: 'discuss',
      onDispatch: (args, docsDir) => {
        if (args.workflowRun && args.workflowRun.kind === 'kickoff') {
          writeDoc(docsDir, 0, '# 开题报告\n就写了一句话，四项里只提到验收标准，别的都没有，长度倒是够。');
        }
      },
    });
    const outcome = await h.engine.runKickoff('mtg', {});
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(outcome.reason, 'kickoff_report_not_delivered');
    assert.strictEqual(h.getWorkflow().devPhase, 'kickoff', '停在开题阶段，成果和文档都留着');
    assert.strictEqual(h.getWorkflow().kickoff.status, 'awaiting_report');
  });

  await t('开题阶段仍然堵死循环：任务书没接收就不许开工', async () => {
    const h = mk({ devPhase: 'kickoff' });
    assert.deepStrictEqual(h.engine.validateLoop('mtg'), { ok: false, reason: 'dev_kickoff_phase' });
    assert.deepStrictEqual(h.engine.validateResume('mtg'), { ok: false, reason: 'dev_kickoff_phase' });
    assert.strictEqual(await h.engine.runLoop('mtg', '绕过开题', null, {}), null);
  });

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
