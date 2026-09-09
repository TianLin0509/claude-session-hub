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
// 一个真的存在、且 .git 在里面的目录：用来验「现场本来就核实得过就不该拦」
const REPO_FIXTURE = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-fixture-'));
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  return dir;
})();

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
  const blockedRoot = () => {
    const blocker = path.join(hubDir, 'blocked-root');
    if (!fs.existsSync(blocker)) fs.writeFileSync(blocker, 'not a directory', 'utf8');
    return blocker;
  };
  const deps = {
    stepTextWait: { verdictQuietMs: 10, verdictCapMs: 60, builderQuietMs: 10, builderCapMs: 60, docPollMs: 20, docCapMs: 200 },
    // 阻断3 用：把「Hub 数据目录」指到一个**文件**上，mkdir 必然失败
    //（等价于磁盘满 / 无权限 / 路径被占用这一类环境故障）
    getHubDataDir: () => (opts.failTaskDir ? blockedRoot() : hubDir),
    getDispatcher: () => ({
      dispatchGroupChatTurn: async (_mid, args) => {
        turnCalls.push(args);
        if (typeof opts.onDispatch === 'function') await opts.onDispatch(args, docsDir, turnCalls.length);
        const isBuilder = String(args.targetMemberIds[0]) === 'm1';
        // 传输层失败注入：返回 {status:'errored', reason} 就等价于「prompt 没送进 CLI」
        const forced = typeof opts.dispatchResult === 'function' ? opts.dispatchResult(args, turnCalls.length) : null;
        if (forced) {
          // 真 dispatcher 在「prompt 没送进去」时返回的是整体 completed + 单个结果 errored，
          // 失败原因挂在结果上。注入要贴这个形状，否则测的是一个不存在的失败模式。
          return {
            status: 'completed',
            turnNum: turnCalls.length,
            results: [{ sid: isBuilder ? 'sB' : 'sR', status: 'errored', text: '', reason: forced.reason }],
          };
        }
        return {
          status: 'completed',
          turnNum: turnCalls.length,
          results: [{ sid: isBuilder ? 'sB' : 'sR', status: 'completed', text: opts.chatText ? opts.chatText(args, turnCalls.length) : '好的，我说两句人话。' }],
        };
      },
      interruptMeetingTurn: () => {},
    }),
    meetingManager: {
      // 默认现场是一个真实存在的仓库目录 —— 这才是常态；
      // 要验「现场核实不过」的用例显式传 workspace: null。
      getMeeting: () => ({ id: meetingId, groupChat: true, scene: 'dev', workspace: ('workspace' in opts ? opts.workspace : REPO_FIXTURE), subSessions: ['sB', 'sR'], slotSpecs: [{ memberId: 'm1' }, { memberId: 'm2' }], serialWorkflow: workflow }),
      updateMeeting: (_id, fields) => {
        if (fields.serialWorkflow) workflow = { ...workflow, ...fields.serialWorkflow };
        if (Object.prototype.hasOwnProperty.call(fields, 'workspace')) opts.workspace = fields.workspace;
      },
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

  // ── 2026-09-08 合并位复现的四项阻断（本轮修复对象）────────────────────────

  const CHAT_FAIL = ['RESULT: FAIL', 'BLOCKERS: 我改主意了', 'VERIFIED: 跑过', 'NEXT: 无'].join('\n');
  const CHAT_PASS = ['RESULT: PASS', 'BLOCKERS: 无', 'VERIFIED: 跑了单测', 'NEXT: 无'].join('\n');

  await t('阻断1 开题期间点了停止 → 迟到的完成文件不触发实现派工', async () => {
    let engineRef = null;
    const h = mk({
      devPhase: 'discuss',
      onDispatch: (args, docsDir) => {
        if (args.workflowRun && args.workflowRun.kind === 'kickoff') {
          // 用户在它写完的同一瞬间点了停止：完成文件和停止意图同时到达
          engineRef.stopLoop('mtg', { interrupt: false });
          writeDoc(docsDir, 0, KICKOFF_DOC);
        }
      },
    });
    engineRef = h.engine;
    const outcome = await h.engine.runKickoff('mtg', {});
    assert.notStrictEqual(outcome.autoStart, true, '停止之后不许自动开工');
    assert.strictEqual(h.getWorkflow().devPhase, 'kickoff', '停在开题阶段，不翻到实现');
    assert.strictEqual(h.turnCalls.length, 1, '只有开题那一次派发，不许有第二次');
  });

  await t('阻断1 停止意图落盘：Hub 重启后开机重扫也不自动开工', async () => {
    const h = mk({
      devPhase: 'kickoff',
      workflow: { kickoff: { status: 'awaiting_report', authorMemberId: 'm1' }, stopRequested: { at: Date.now(), reason: 'user_stop' } },
    });
    writeDoc(h.docsDir, 0, KICKOFF_DOC);
    h.engine.resumePending();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.strictEqual(h.turnCalls.length, 0, '停止之后开机重扫不许派任何人');
    assert.strictEqual(h.getWorkflow().devPhase, 'kickoff');
  });

  await t('阻断1 循环运行中点停止 → 迟到的协作手册不推进到审查', async () => {
    let engineRef = null;
    const h = mk({
      onDispatch: (args, docsDir) => {
        if (String(args.targetMemberIds[0]) === 'm1') {
          engineRef.stopLoop('mtg', { interrupt: false });
          writeDoc(docsDir, 1, BUILD_DOC);
        }
      },
    });
    engineRef = h.engine;
    const state = await h.engine.runLoop('mtg', '做点事', null, {});
    assert.strictEqual(state.status, 'stopped_user');
    assert.strictEqual(h.turnCalls.length, 1, '审查不许被派出去');
  });

  await t('阻断2 裁决矛盾暂停后点「继续」→ 仍停在待核对，不会变成完成', async () => {
    const h = mk({
      chatText: (args) => (String(args.targetMemberIds[0]) === 'm2' ? CHAT_FAIL : '干完了'),
      onDispatch: (args, docsDir) => {
        if (String(args.targetMemberIds[0]) === 'm1') writeDoc(docsDir, 1, BUILD_DOC);
        else writeDoc(docsDir, 2, REVIEW_PASS);
      },
    });
    const first = await h.engine.runLoop('mtg', '做点事', null, {});
    assert.strictEqual(first.lastError.reason, 'verdict_conflict');
    // 用户点「继续」：文档一个字没改，也没有重新审查 —— 矛盾必须还在
    const resumed = await h.engine.runLoop('mtg', null, { ...first, status: 'running', stepAttempt: 0, lastError: null }, {});
    assert.strictEqual(resumed.status, 'paused', '继续不能把没解决的矛盾变成完成');
    assert.strictEqual(resumed.lastError.reason, 'verdict_conflict');
  });

  await t('阻断2 合并位真的重写了手册 → 按「已接收的被改动」处理，同样不静默放行', async () => {
    let reviewerDispatches = 0;
    const h = mk({
      chatText: (args) => (String(args.targetMemberIds[0]) === 'm2' ? CHAT_FAIL : '干完了'),
      onDispatch: (args, docsDir) => {
        if (String(args.targetMemberIds[0]) === 'm1') writeDoc(docsDir, 1, BUILD_DOC);
        // 只在第一次审查时交手册；后续再被叫起来它不会重写（模拟「我已经交过了」）
        else if (++reviewerDispatches === 1) writeDoc(docsDir, 2, REVIEW_PASS);
      },
    });
    const first = await h.engine.runLoop('mtg', '做点事', null, {});
    assert.strictEqual(first.lastError.reason, 'verdict_conflict');
    writeDoc(h.docsDir, 2, REVIEW_FAIL);
    const resumed = await h.engine.runLoop('mtg', null, { ...first, status: 'running', stepAttempt: 0, lastError: null }, {});
    assert.strictEqual(resumed.status, 'paused');
    assert.strictEqual(resumed.lastError.reason, 'handoff_changed_after_accept',
      '换了内容就是「已接收的交付被改动」，仍然是待核对，不能自己变成新裁决');
  });

  await t('阻断 已接收的协作手册被改动 → 派发前就停在待核对，不白烧一次工作位', async () => {
    let builderDispatches = 0;
    const h = mk({
      onDispatch: (args, docsDir) => {
        if (String(args.targetMemberIds[0]) === 'm1') { builderDispatches += 1; if (builderDispatches === 1) writeDoc(docsDir, 1, BUILD_DOC); }
      },
    });
    const first = await h.engine.runLoop('mtg', '做点事', null, {});
    assert.strictEqual(first.lastError.stage, 'reviewer', '第一轮停在等审查手册');
    // 有人事后改了已经接收的协作手册
    writeDoc(h.docsDir, 1, BUILD_DOC + ' —— 后来又被改了一版');
    h.turnCalls.length = 0;
    const resumed = await h.engine.runLoop('mtg', null, { ...first, status: 'running', stepAttempt: 0, lastError: null }, {});
    assert.strictEqual(resumed.status, 'paused');
    assert.strictEqual(resumed.lastError.reason, 'handoff_changed_after_accept');
    assert.strictEqual(resumed.lastError.stage, 'builder');
    assert.strictEqual(h.turnCalls.length, 0,
      '待核对是给人看的，不该先白派一次真实 CLI 轮次再说「其实停下来了」');
  });

  await t('阻断 已接收的合并手册被改动 → 同样在派发前停住，不重派审查', async () => {
    let reviewerDispatches = 0;
    const h = mk({
      onDispatch: (args, docsDir) => {
        if (String(args.targetMemberIds[0]) === 'm1') writeDoc(docsDir, 1, BUILD_DOC);
        else if (++reviewerDispatches === 1) writeDoc(docsDir, 2, REVIEW_FAIL);
      },
      maxRounds: 1,
    });
    const first = await h.engine.runLoop('mtg', '做点事', null, {});
    assert.strictEqual(reviewerDispatches, 1);
    writeDoc(h.docsDir, 2, REVIEW_FAIL + ' —— 事后又补了两句');
    h.turnCalls.length = 0;
    const resumed = await h.engine.runLoop('mtg', null, { ...first, status: 'running', round: 0, stepAttempt: 0, lastError: null, posBase: 1 }, {});
    assert.strictEqual(resumed.lastError.reason, 'handoff_changed_after_accept');
    assert.strictEqual(resumed.lastError.stage, 'reviewer');
    assert.strictEqual(reviewerDispatches, 1, '审查不许被重派');
    assert.strictEqual(h.turnCalls.length, 0, '一次派发都不该发生');
  });

  await t('停止不是砖头：用户点「继续」清掉意图后，任务能接着往下走', async () => {
    let engineRef = null;
    let stopped = false;
    const h = mk({
      onDispatch: (args, docsDir) => {
        if (String(args.targetMemberIds[0]) === 'm1') {
          if (!stopped) { stopped = true; engineRef.stopLoop('mtg', { interrupt: false }); }
          writeDoc(docsDir, 1, BUILD_DOC);
        } else writeDoc(docsDir, 2, REVIEW_PASS);
      },
    });
    engineRef = h.engine;
    const first = await h.engine.runLoop('mtg', '做点事', null, {});
    assert.strictEqual(first.status, 'stopped_user');
    assert.ok(h.engine.stopIntentOf('mtg'), '停止意图应当留在盘上');

    // 用户点「继续」：IPC 层会先调 clearStopIntent
    h.engine.clearStopIntent('mtg');
    assert.strictEqual(h.engine.stopIntentOf('mtg'), null);
    const resumed = await h.engine.runLoop('mtg', null, { ...first, status: 'running', stepAttempt: 0, lastError: null }, {});
    assert.strictEqual(resumed.status, 'done', '清掉停止意图之后必须能真的接着跑完');
    assert.strictEqual(h.turnCalls.length, 2, '工作位那一步已经交付过，不重做；只补派审查');
  });

  await t('停止保留现场：已接收的交付凭据和阶段文档都还在', async () => {
    let engineRef = null;
    const h = mk({
      onDispatch: (args, docsDir) => {
        if (String(args.targetMemberIds[0]) === 'm1') {
          engineRef.stopLoop('mtg', { interrupt: false });
          writeDoc(docsDir, 1, BUILD_DOC);
        }
      },
    });
    engineRef = h.engine;
    await h.engine.runLoop('mtg', '做点事', null, {});
    assert.ok(fs.existsSync(path.join(h.docsDir, '已完成-阶段1协作手册.md')), '文档不许被清掉');
    assert.ok(DOCS.acceptedAt(h.getWorkflow().taskDocs, 1), '接收凭据也要留着：停止不等于把交付作废');
  });

  await t('阻断 开题已交付但被停住 → 清掉停止意图后重扫即可开工，不重写任务书', async () => {
    let engineRef = null;
    let kickoffDispatches = 0;
    const h = mk({
      devPhase: 'discuss',
      onDispatch: (args, docsDir) => {
        if (args.workflowRun && args.workflowRun.kind === 'kickoff') {
          kickoffDispatches += 1;
          engineRef.stopLoop('mtg', { interrupt: false });
          writeDoc(docsDir, 0, KICKOFF_DOC);
        } else if (String(args.targetMemberIds[0]) === 'm1') writeDoc(docsDir, 1, BUILD_DOC);
        else writeDoc(docsDir, 2, REVIEW_PASS);
      },
    });
    engineRef = h.engine;
    const stoppedOutcome = await h.engine.runKickoff('mtg', {});
    assert.strictEqual(h.getWorkflow().kickoff.status, 'accepted_stopped');
    assert.notStrictEqual(stoppedOutcome.autoStart, true);

    // 用户点「重发本轮」：IPC 先清停止意图，再以 dispatch:false 重扫
    h.engine.clearStopIntent('mtg');
    const resumed = await h.engine.runKickoff('mtg', { authorMemberId: 'm1', dispatch: false });
    assert.strictEqual(resumed.ok, true);
    assert.strictEqual(resumed.autoStart, true, '已接收的报告要能直接接着开工');
    assert.strictEqual(kickoffDispatches, 1, '不许再派一次开题：任务书已经交过了');
    assert.strictEqual(h.getWorkflow().devPhase, 'build');
  });

  await t('阻断 开题派发失败（CLI 没起来）→ 明说 dispatch_failed，不伪装成「正在等报告」', async () => {
    let attempts = 0;
    const h = mk({
      devPhase: 'discuss',
      dispatchResult: () => { attempts += 1; return { reason: 'cli_not_ready' }; },
    });
    const outcome = await h.engine.runKickoff('mtg', {});
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(outcome.reason, 'kickoff_dispatch_failed',
      '一个字都没送到 CLI，就不该显示成「它在写，你等着」');
    assert.strictEqual(outcome.detail, 'cli_not_ready', '要把真实原因带出来给界面用');
    assert.strictEqual(h.getWorkflow().kickoff.status, 'dispatch_failed');
    assert.strictEqual(h.getWorkflow().kickoff.lastReason, 'cli_not_ready');
    assert.strictEqual(attempts, 2, '和循环一样给两次有界传输重试，别一次不行就放弃');
    assert.strictEqual(h.getWorkflow().devPhase, 'kickoff', '阶段和现场都保留，用户点重发即可');
  });

  await t('开题派发第一次失败、第二次成功 → 照常往下走，不把传输抖动记成失败', async () => {
    let attempts = 0;
    const h = mk({
      devPhase: 'discuss',
      dispatchResult: () => (attempts === 1 ? { reason: 'cli_not_ready' } : null),
      onDispatch: (args, docsDir) => {
        if (!(args.workflowRun && args.workflowRun.kind === 'kickoff')) return;
        attempts += 1;
        if (attempts >= 2) writeDoc(docsDir, 0, KICKOFF_DOC);
      },
    });
    const outcome = await h.engine.runKickoff('mtg', {});
    assert.strictEqual(outcome.ok, true);
    assert.strictEqual(attempts, 2);
    assert.strictEqual(h.getWorkflow().devPhase, 'build');
  });

  await t('派发失败但文件其实已经在了 → 先认交付，不因为回执丢了就重来', async () => {
    const h = mk({
      devPhase: 'discuss',
      dispatchResult: () => ({ status: 'errored', reason: 'send_failed' }),
      onDispatch: (args, docsDir) => {
        // 模拟「prompt 其实送到了，只是回执丢了」：agent 已经把报告交出来
        if (args.workflowRun && args.workflowRun.kind === 'kickoff') writeDoc(docsDir, 0, KICKOFF_DOC);
      },
    });
    const outcome = await h.engine.runKickoff('mtg', {});
    assert.strictEqual(outcome.ok, true, '确认丢失但成果在，就按成果算，不重复派工');
    assert.strictEqual(h.getWorkflow().devPhase, 'build');
  });

  await t('阻断3 任务目录不可用 → 暂停并说明，不退回聊天判定', async () => {
    const h = mk({
      failTaskDir: true,
      chatText: (args) => (String(args.targetMemberIds[0]) === 'm1' ? 'PROGRESS: 做完了' : CHAT_PASS),
    });
    const state = await h.engine.runLoop('mtg', '做点事', null, {});
    assert.strictEqual(state.status, 'paused', '开了 MD 交接就不许静默降级成聊天判定');
    assert.strictEqual(state.lastError.reason, 'task_dir_unavailable');
    assert.strictEqual(h.turnCalls.length, 0, '连派工都不该开始');
  });

  // ── 2026-09-08 第四轮合并位复现的阻断 ────────────────────────────────────

  await t('阻断 开题重试期间用户点了停止 → 不许再派第二次', async () => {
    let engineRef = null;
    let dispatches = 0;
    const h = mk({
      devPhase: 'discuss',
      dispatchResult: () => ({ reason: 'cli_not_ready' }),
      onDispatch: (args) => {
        if (!(args.workflowRun && args.workflowRun.kind === 'kickoff')) return;
        dispatches += 1;
        // 第一次派发失败之后、重试之前，用户点了停止
        if (dispatches === 1) engineRef.stopLoop('mtg', { interrupt: false });
      },
    });
    engineRef = h.engine;
    const outcome = await h.engine.runKickoff('mtg', {});
    assert.strictEqual(dispatches, 1, '停止之后不许重试派发');
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(h.getWorkflow().devPhase, 'kickoff', '现场保留');
  });

  await t('阻断 回执失败但报告其实已经交了 → 不许重试，别让它把任务书重写一遍', async () => {
    let dispatches = 0;
    const h = mk({
      devPhase: 'discuss',
      dispatchResult: () => ({ reason: 'send_failed' }),
      onDispatch: (args, docsDir) => {
        if (!(args.workflowRun && args.workflowRun.kind === 'kickoff')) return;
        dispatches += 1;
        // prompt 其实送到了，agent 已经把报告交出来，只是回执丢了
        if (dispatches === 1) writeDoc(docsDir, 0, KICKOFF_DOC);
      },
    });
    const outcome = await h.engine.runKickoff('mtg', {});
    assert.strictEqual(dispatches, 1, '报告已经在了就不该再派一次，否则它会重写同一份任务书');
    assert.strictEqual(outcome.ok, true, '按成果算，照常进入实现');
    assert.strictEqual(h.getWorkflow().devPhase, 'build');
  });

  await t('阻断 状态记录损坏 → 第二次点重发照样拒绝，不是洗一次就放行', async () => {
    const h = mk({ onDispatch: () => {} });
    // 只把轮次写坏 —— 合并位的探针就是这么复现的：第一次暂停时把它归零，
    // 第二次记录已经「干净」了，于是照常派工。
    const damaged = { status: 'running', round: -3, goal: '原目标', runId: 'loop-x', history: [] };
    const first = await h.engine.runLoop('mtg', null, damaged, {});
    assert.strictEqual(first.lastError.reason, 'state_record_damaged');
    // 第二次：从**落盘后**的记录再来一次，这正是用户点第二下「重发」走的路
    const persisted = h.getWorkflow().loopState;
    const second = await h.engine.runLoop('mtg', null, { ...persisted, status: 'running' }, {});
    assert.strictEqual(second.status, 'paused', '损坏标记必须持续生效');
    assert.strictEqual(second.lastError.reason, 'state_record_damaged');
    assert.strictEqual(h.turnCalls.length, 0, '一次派发都不该发生');
  });

  await t('损坏记录的脱困方式是用户明确开新一轮，不是反复点重发', async () => {
    const h = mk({
      onDispatch: (args, docsDir) => {
        if (String(args.targetMemberIds[0]) === 'm1') writeDoc(docsDir, 1, BUILD_DOC);
        else writeDoc(docsDir, 2, REVIEW_PASS);
      },
    });
    await h.engine.runLoop('mtg', null, { status: 'running', round: -3, goal: 'x', history: [] }, {});
    assert.strictEqual(h.getWorkflow().loopState.damaged.detail.includes('round'), true, '损坏细节要留着给人看');
    // 用户给了新目标 = 明确的人工决定，允许重新开始
    const fresh = await h.engine.runLoop('mtg', '换个新目标重来', null, {});
    assert.strictEqual(fresh.status, 'done', '开新一轮不该被旧的损坏标记挡住');
    assert.strictEqual(h.getWorkflow().loopState.damaged, null, '新一轮开始时清掉损坏标记');
  });

  await t('阻断 开题报告声明的项目根核实不过 → 不自动开工', async () => {
    const h = mk({
      devPhase: 'discuss',
      onDispatch: (args, docsDir) => {
        if (args.workflowRun && args.workflowRun.kind === 'kickoff') {
          writeDoc(docsDir, 0, KICKOFF_DOC + '\n项目根：C:\\这个目录根本不存在\\x');
        }
      },
    });
    const outcome = await h.engine.runKickoff('mtg', {});
    assert.strictEqual(outcome.ok, false, '项目根核实不过就不能进实现 —— 那等于在没核实的现场动手');
    assert.strictEqual(outcome.reason, 'project_root_unverified');
    assert.strictEqual(h.getWorkflow().devPhase, 'kickoff', '停在开题，等它改报告或等人处理');
    assert.strictEqual(h.getWorkflow().kickoff.status, 'project_root_unverified');
  });

  await t('开题报告没声明项目根、但当前工作目录本身就是有效仓库 → 照常开工', async () => {
    const h = mk({
      devPhase: 'discuss',
      workspace: REPO_FIXTURE,
      onDispatch: (args, docsDir) => {
        if (args.workflowRun && args.workflowRun.kind === 'kickoff') writeDoc(docsDir, 0, KICKOFF_DOC);
        else if (String(args.targetMemberIds[0]) === 'm1') writeDoc(docsDir, 1, BUILD_DOC);
        else writeDoc(docsDir, 2, REVIEW_PASS);
      },
    });
    const outcome = await h.engine.runKickoff('mtg', {});
    assert.strictEqual(outcome.ok, true, '现场本来就核实得过，就不该拦');
    assert.strictEqual(h.getWorkflow().devPhase, 'build');
  });

  // ── 2026-09-08 第五轮：等待窗口里到达的停止 / 交付 ────────────────────────

  await t('阻断 停止在 500ms 重试等待窗口内到达 → 仍然不许派第二次', async () => {
    let engineRef = null;
    let dispatches = 0;
    const h = mk({
      devPhase: 'discuss',
      dispatchResult: () => ({ reason: 'cli_not_ready' }),
      onDispatch: (args) => {
        if (!(args.workflowRun && args.workflowRun.kind === 'kickoff')) return;
        dispatches += 1;
        // 第一次失败之后，停止在**等待期间**才到 —— 上一版的检查在 sleep 之前，漏掉这一格
        if (dispatches === 1) setTimeout(() => engineRef.stopLoop('mtg', { interrupt: false }), 60);
      },
    });
    engineRef = h.engine;
    const outcome = await h.engine.runKickoff('mtg', {});
    assert.strictEqual(dispatches, 1, '等待窗口里点的停止同样算数');
    assert.strictEqual(outcome.ok, false);
  });

  await t('阻断 报告在 500ms 重试等待窗口内交付 → 按成果算，不再派第二次', async () => {
    let dispatches = 0;
    const h = mk({
      devPhase: 'discuss',
      dispatchResult: () => ({ reason: 'send_failed' }),
      onDispatch: (args, docsDir) => {
        if (!(args.workflowRun && args.workflowRun.kind === 'kickoff')) return;
        dispatches += 1;
        if (dispatches === 1) setTimeout(() => writeDoc(docsDir, 0, KICKOFF_DOC), 60);
      },
    });
    const outcome = await h.engine.runKickoff('mtg', {});
    assert.strictEqual(dispatches, 1, '等待期间交上来的报告同样算数，不该让它重写一遍');
    assert.strictEqual(outcome.ok, true);
    assert.strictEqual(h.getWorkflow().devPhase, 'build');
  });

  await t('循环那两步的传输重试同样要在派发紧前一刻认停止', async () => {
    let engineRef = null;
    let builderDispatches = 0;
    const h = mk({
      dispatchResult: (args) => (String(args.targetMemberIds[0]) === 'm1' ? { reason: 'cli_not_ready' } : null),
      onDispatch: (args) => {
        if (String(args.targetMemberIds[0]) !== 'm1') return;
        builderDispatches += 1;
        if (builderDispatches === 1) setTimeout(() => engineRef.stopLoop('mtg', { interrupt: false }), 60);
      },
    });
    engineRef = h.engine;
    const state = await h.engine.runLoop('mtg', '做点事', null, {});
    assert.strictEqual(builderDispatches, 1, '等待窗口里点的停止，循环这边同样不许再派');
    assert.strictEqual(state.status, 'stopped_user');
  });

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
