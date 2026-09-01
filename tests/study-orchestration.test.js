'use strict';
// tests/study-orchestration.test.js
//
// 学习 Tab 编排器的离线验证：用假的 sessionManager / transcriptTap / ipcMain
// 跑完整的三棒串行流程，不启动 Electron、不真的拉起 CLI。
//
//   node tests/study-orchestration.test.js
//
// 覆盖的是最容易出错、且一旦出错就很难在真环境里定位的几条路径：
//   1) 每一棒派给了正确的角色与 CLI 种类（尤其 review 必须落到 codex）
//   2) turn-complete 只有在「完成口令 + 产物文件」双满足时才推进
//   3) 只有口令没产物 → 推一次 → 仍不行 → 失败（而不是傻等超时）
//   4) 补跑时已 done 的棒不重复执行
//   5) Session 中途退出 → 立刻失败，不等超时
//   6) 调度判定：当天已出过课就不再触发

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { registerStudyIpc } = require('../main/ipc/study-handlers.js');
const workflow = require('../core/study-workflow.js');

let passed = 0;
const results = [];
function check(name, fn) {
  try { fn(); results.push(['PASS', name]); passed += 1; }
  catch (e) { results.push(['FAIL', name, e.message]); }
}

/* ───────────────── 测试替身 ───────────────── */

function makeHarness(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'study-test-'));
  const studyRoot = path.join(root, 'agent-study');
  fs.mkdirSync(path.join(studyRoot, 'days'), { recursive: true });
  fs.writeFileSync(path.join(studyRoot, 'PLAN.md'), [
    '| # | 主题 |', '|---|---|',
    '| L1 | 一 |', '| L2 | 二 |', '| **L3** | 三（加粗写法也要认） |',
  ].join('\n'), 'utf8');

  const sessions = new Map();
  let seq = 0;
  const sessionManager = new EventEmitter();
  Object.assign(sessionManager, {
    createSession(kind, options) {
      const id = options.id || `hub-${kind}-${++seq}`;
      const s = { id, kind, cwd: options.cwd, title: options.title, model: options.model,
        status: 'active', options, codexSid: kind === 'codex' ? 'cx-1' : '', claudeSid: kind === 'claude' ? 'cl-1' : '' };
      sessions.set(id, s);
      return s;
    },
    getSession: (id) => sessions.get(id) || null,
    closeSession: (id) => sessions.delete(id),
    writeToSession: () => {},
    getSessionBuffer: () => 'ready',
    getGroupChatReady: () => true,
    setGroupChatReady: () => {},
  });

  const transcriptTap = new EventEmitter();
  const ipcHandlers = new Map();
  const ipcMain = { handle: (ch, fn) => ipcHandlers.set(ch, fn) };

  const sentPrompts = [];
  const bridge = registerStudyIpc(ipcMain, {
    sessionManager,
    transcriptTap,
    getHubDataDir: () => root,
    stateFile: path.join(root, 'study-state.json'),
    studyRoot,
    sendToRenderer: () => {},
    logger: { log() {}, warn() {}, error() {} },
    waitCliReady: async () => (opts.cliReady === false ? false : true),
    sendToPty: async (sid, prompt, kind) => {
      sentPrompts.push({ sid, kind, prompt });
      return { ok: true, sendStatus: 'sent' };
    },
    clock: () => opts.now || new Date('2026-09-02T00:05:00+08:00'),
  });

  return { root, studyRoot, sessionManager, transcriptTap, ipcMain, ipcHandlers, bridge, sentPrompts, sessions,
    cleanup: () => { bridge.dispose(); try { fs.rmSync(root, { recursive: true, force: true }); } catch {} } };
}

// figures.json 必须是真 JSON：编排器会读它来校验 review 棒的图是不是都画了。
const FIGURES = [{ name: 'k1-demo', prompt: '画面描述', why: '帮助理解' }];

function writeArtifacts(studyRoot, stage, date, lessonId) {
  const p = workflow.lessonPaths(studyRoot, date, lessonId);
  for (const f of workflow.stageArtifacts(stage, studyRoot, date, lessonId)) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    if (f === p.figures) fs.writeFileSync(f, JSON.stringify(FIGURES), 'utf8');
    // src.html 里要带图片占位——编排器按占位校验 review 棒有没有把图画齐
    else if (f === p.srcHtml) fs.writeFileSync(f, FIGURES.map((x) => `@@IMG:${x.name}@@`).join(' '), 'utf8');
    else fs.writeFileSync(f, 'x', 'utf8');
  }
  if (stage === 'review') {
    fs.mkdirSync(p.assetDir, { recursive: true });
    for (const item of FIGURES) fs.writeFileSync(path.join(p.assetDir, `${item.name}.png`), 'png', 'utf8');
  }
}

function makeHarnessSlowReady(gate) {
  // 与 makeHarness 同构，只把 waitCliReady 换成受 gate 控制的版本，
  // 用来制造「pending 已登记但还没派活」的窗口。
  const h = (function () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'study-test-slow-'));
    const studyRoot = path.join(root, 'agent-study');
    fs.mkdirSync(path.join(studyRoot, 'days'), { recursive: true });
    fs.writeFileSync(path.join(studyRoot, 'PLAN.md'), `| # |
|---|
| L1 | 一 |
`, 'utf8');
    const sessions = new Map();
    let seq = 0;
    const sessionManager = new EventEmitter();
    Object.assign(sessionManager, {
      createSession(kind, options) {
        const id = options.id || `hub-${kind}-${++seq}`;
        const s = { id, kind, cwd: options.cwd, options, status: 'active',
          codexSid: kind === 'codex' ? 'cx' : '', claudeSid: kind === 'claude' ? 'cl' : '' };
        sessions.set(id, s); return s;
      },
      getSession: (id) => sessions.get(id) || null,
      closeSession: (id) => sessions.delete(id),
      writeToSession: () => {}, getSessionBuffer: () => 'ready',
      getGroupChatReady: () => true, setGroupChatReady: () => {},
    });
    const transcriptTap = new EventEmitter();
    const ipcHandlers = new Map();
    const sentPrompts = [];
    const bridge = registerStudyIpc({ handle: (c, f) => ipcHandlers.set(c, f) }, {
      sessionManager, transcriptTap,
      getHubDataDir: () => root,
      stateFile: path.join(root, 'study-state.json'),
      studyRoot,
      sendToRenderer: () => {},
      logger: { log() {}, warn() {}, error() {} },
      waitCliReady: async () => gate,
      sendToPty: async (sid, prompt, kind) => { sentPrompts.push({ sid, kind, prompt }); return { ok: true, sendStatus: 'sent' }; },
      clock: () => new Date('2026-09-02T00:05:00+08:00'),
    });
    return { root, studyRoot, sessionManager, transcriptTap, ipcHandlers, bridge, sentPrompts, sessions,
      cleanup: () => { bridge.dispose(); try { fs.rmSync(root, { recursive: true, force: true }); } catch {} } };
  })();
  return h;
}

const doneWord = (stage) => workflow.stageDoneSignal(stage);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ───────────────── 用例 ───────────────── */

async function main() {
  // ---- 1. 课程解析 ----
  {
    const h = makeHarness();
    check('PLAN.md 解析出三课，含加粗写法', () => {
      assert.deepStrictEqual(h.bridge.planLessonIds(), ['L1', 'L2', 'L3']);
    });
    check('nextLessonId 从 L1 开始', () => {
      assert.strictEqual(h.bridge.nextLessonId(), 'L1');
    });
    fs.writeFileSync(path.join(h.studyRoot, 'days', '2026-09-02-L1.html'), '<html></html>', 'utf8');
    check('已出成品的课被跳过', () => {
      assert.strictEqual(h.bridge.nextLessonId(), 'L2');
    });
    check('.src.html 不算成品', () => {
      fs.writeFileSync(path.join(h.studyRoot, 'days', '2026-09-03-L2.src.html'), 'x', 'utf8');
      assert.strictEqual(h.bridge.nextLessonId(), 'L2');
    });
    h.cleanup();
  }

  // ---- 2. 三棒全流程：角色与 CLI 种类正确，顺序正确 ----
  {
    const h = makeHarness();
    const r = await h.bridge.runToday({ trigger: 'test' });
    check('run 启动成功并从 draft 开始', () => {
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.lessonId, 'L1');
      assert.strictEqual(r.stage, 'draft');
    });
    check('第 1 棒发给 claude', () => {
      assert.strictEqual(h.sentPrompts.length, 1);
      assert.strictEqual(h.sentPrompts[0].kind, 'claude');
    });

    // draft 完成
    const sid1 = [...h.bridge._test.pendingByHubSession.keys()][0];
    writeArtifacts(h.studyRoot, 'draft', '2026-09-02', 'L1');
    await h.bridge._test.handleTurnComplete(sid1, `好了 ${doneWord('draft')} 2026-09-02-L1`);
    await sleep(20);
    check('draft 完成后自动进入 review，且发给 codex', () => {
      assert.strictEqual(h.sentPrompts.length, 2, `实际发了 ${h.sentPrompts.length} 条`);
      assert.strictEqual(h.sentPrompts[1].kind, 'codex');
    });
    check('review 用的是另一个 Session（不是同一个）', () => {
      assert.notStrictEqual(h.sentPrompts[0].sid, h.sentPrompts[1].sid);
    });

    // review 完成
    const sid2 = [...h.bridge._test.pendingByHubSession.keys()][0];
    writeArtifacts(h.studyRoot, 'review', '2026-09-02', 'L1');
    await h.bridge._test.handleTurnComplete(sid2, `${doneWord('review')} 3 3`);
    await sleep(20);
    check('review 完成后进入 finalize，且回到 claude 那个 Session', () => {
      assert.strictEqual(h.sentPrompts.length, 3);
      assert.strictEqual(h.sentPrompts[2].kind, 'claude');
      assert.strictEqual(h.sentPrompts[2].sid, h.sentPrompts[0].sid);
    });

    // finalize 完成
    const sid3 = [...h.bridge._test.pendingByHubSession.keys()][0];
    writeArtifacts(h.studyRoot, 'finalize', '2026-09-02', 'L1');
    await h.bridge._test.handleTurnComplete(sid3, `${doneWord('finalize')} 2026-09-02-L1 全过`);
    await sleep(20);
    check('三棒跑完，run 标记 done', () => {
      const run = h.bridge.store.getRun('2026-09-02');
      assert.strictEqual(run.status, 'done');
      assert.strictEqual(run.stages.draft.status, 'done');
      assert.strictEqual(run.stages.review.status, 'done');
      assert.strictEqual(run.stages.finalize.status, 'done');
    });
    check('跑完后 pending 清空、不再占用保护名额', () => {
      assert.strictEqual(h.bridge.getProtectedSessionIds().size, 0);
    });
    h.cleanup();
  }

  // ---- 3. 有口令但产物缺失 → 推一次 → 仍缺 → 失败 ----
  {
    const h = makeHarness();
    await h.bridge.runToday({ trigger: 'test' });
    const sid = [...h.bridge._test.pendingByHubSession.keys()][0];

    await h.bridge._test.handleTurnComplete(sid, doneWord('draft'));  // 没写产物
    await sleep(20);
    check('缺产物时不推进，而是推一次继续', () => {
      assert.strictEqual(h.sentPrompts.length, 2);
      assert.ok(/没有完成|继续/.test(h.sentPrompts[1].prompt), '第 2 条应是推进提示');
      assert.strictEqual(h.bridge.store.getRun('2026-09-02').stages.draft.status, 'running');
    });

    await h.bridge._test.handleTurnComplete(sid, doneWord('draft'));  // 还是没写
    await sleep(20);
    check('推一次后仍不行 → 标记失败，不傻等超时', () => {
      const run = h.bridge.store.getRun('2026-09-02');
      assert.strictEqual(run.stages.draft.status, 'failed');
      assert.strictEqual(run.status, 'failed');
      assert.ok(/缺产物/.test(run.stages.draft.error), `错误信息应说明缺产物，实际：${run.stages.draft.error}`);
    });
    h.cleanup();
  }

  // ---- 4. 产物齐了但没说完成口令 → 同样不算完 ----
  {
    const h = makeHarness();
    await h.bridge.runToday({ trigger: 'test' });
    const sid = [...h.bridge._test.pendingByHubSession.keys()][0];
    writeArtifacts(h.studyRoot, 'draft', '2026-09-02', 'L1');
    await h.bridge._test.handleTurnComplete(sid, '我先看看文件');
    await sleep(20);
    check('无完成口令时推一次而不是直接推进', () => {
      assert.strictEqual(h.sentPrompts.length, 2);
      assert.strictEqual(h.bridge.store.getRun('2026-09-02').stages.draft.status, 'running');
    });
    h.cleanup();
  }

  // ---- 5. 补跑：已 done 的棒不重复执行 ----
  {
    const h = makeHarness();
    await h.bridge.runToday({ trigger: 'test' });
    const sid = [...h.bridge._test.pendingByHubSession.keys()][0];
    writeArtifacts(h.studyRoot, 'draft', '2026-09-02', 'L1');
    await h.bridge._test.handleTurnComplete(sid, doneWord('draft'));
    await sleep(20);
    // 此刻 review 在跑；模拟 Session 退出把 run 打断
    const reviewSid = [...h.bridge._test.pendingByHubSession.keys()][0];
    h.sessionManager.emit('session-exited', { sessionId: reviewSid });
    await sleep(20);
    check('Session 退出 → 立刻失败并说明原因', () => {
      const run = h.bridge.store.getRun('2026-09-02');
      assert.strictEqual(run.status, 'failed');
      assert.ok(/退出/.test(run.stages.review.error), `实际：${run.stages.review.error}`);
    });

    const before = h.sentPrompts.length;
    await h.bridge.runToday({ trigger: 'catchup' });
    await sleep(20);
    check('补跑直接从 review 开始，不重跑 draft', () => {
      const added = h.sentPrompts.slice(before);
      assert.strictEqual(added.length, 1, `补跑应只发 1 条，实际 ${added.length}`);
      assert.strictEqual(added[0].kind, 'codex', '应直接派给 codex');
    });
    h.cleanup();
  }

  // ---- 6. 单飞：跑着的时候再触发不会并发 ----
  {
    const h = makeHarness();
    await h.bridge.runToday({ trigger: 'test' });
    const again = await h.bridge.runToday({ trigger: 'test' });
    check('已有 run 在跑时拒绝再起一个', () => {
      assert.strictEqual(again.ok, false);
      assert.strictEqual(again.error, 'already-running');
    });
    h.cleanup();
  }

  // ---- 7. 调度判定 ----
  {
    const h = makeHarness({ now: new Date('2026-09-02T00:05:00+08:00') });
    check('0 点后、今天还没出课 → 该跑', () => {
      assert.strictEqual(h.bridge.shouldRunNow(), true);
    });
    h.bridge.store.startRun('2026-09-02', 'L1', 'x', [['draft', 'claude']]);
    h.bridge.store.finishRun('2026-09-02', 'done');
    check('今天已出过课 → 不再触发', () => {
      assert.strictEqual(h.bridge.shouldRunNow(), false);
    });
    h.cleanup();
  }

  // ---- 8. 早上补触发（0 点没开 Hub）----
  {
    const h = makeHarness({ now: new Date('2026-09-02T09:30:00+08:00') });
    check('9:30 打开 Hub 时仍会补跑当天的课', () => {
      assert.strictEqual(h.bridge.shouldRunNow(), true);
    });
    h.cleanup();
  }

  // ---- 9. CLI 起不来 → 明确失败 ----
  {
    const h = makeHarness({ cliReady: false });
    await h.bridge.runToday({ trigger: 'test' });
    await sleep(20);
    check('CLI 未就绪 → 失败并写明原因，不发 prompt', () => {
      const run = h.bridge.store.getRun('2026-09-02');
      assert.strictEqual(run.stages.draft.status, 'failed');
      assert.ok(/CLI/.test(run.stages.draft.error));
      assert.strictEqual(h.sentPrompts.length, 0);
    });
    h.cleanup();
  }

  // ---- 10. 路径守卫 ----
  {
    const h = makeHarness();
    const read = h.ipcHandlers.get('study:read-lesson');
    const outside = await read({}, { path: path.join(h.root, 'study-state.json') });
    check('study:read-lesson 拒绝读 days/ 之外的文件', () => {
      assert.strictEqual(outside.ok, false);
      assert.strictEqual(outside.error, 'path-outside-days');
    });
    const f = path.join(h.studyRoot, 'days', '2026-09-02-L1.html');
    fs.writeFileSync(f, '<html>ok</html>', 'utf8');
    const inside = await read({}, { path: f });
    check('days/ 内的成品可以读', () => {
      assert.strictEqual(inside.ok, true);
      assert.ok(inside.html.includes('ok'));
    });
    h.cleanup();
  }

  // ---- 11. 会话配置：Claude 必须 autonomous（否则收不到 turn-complete）----
  {
    const h = makeHarness();
    h.bridge.ensureRoleSession('author');
    h.bridge.ensureRoleSession('reviewer');
    check('Claude Session 开了 autonomous（关 fast，保证 transcript 落盘）', () => {
      const s = [...h.sessions.values()].find((x) => x.kind === 'claude');
      assert.strictEqual(s.options.autonomous, true);
    });
    check('Codex Session 开了 bypass approvals', () => {
      const s = [...h.sessions.values()].find((x) => x.kind === 'codex');
      assert.strictEqual(s.options.codexBypassApprovals, true);
    });
    check('两个 Session 的 cwd 都指向学习项目根', () => {
      for (const s of h.sessions.values()) assert.strictEqual(s.cwd, h.studyRoot);
    });
    check('重复 ensure 不会重复建会话', () => {
      const n = h.sessions.size;
      h.bridge.ensureRoleSession('author');
      assert.strictEqual(h.sessions.size, n);
    });
    h.cleanup();
  }

  // ---- 12. 竞态：prompt 还没发出去时到达的 turn-complete 不算数 ----
  {
    // 让 CLI 就绪等待挂住，制造「已登记 pending 但尚未派活」的窗口
    let release;
    const gate = new Promise((r) => { release = r; });
    const slow = makeHarnessSlowReady(gate);
    const p = slow.bridge.runToday({ trigger: 'test' });
    await sleep(30);
    const sid = [...slow.bridge._test.pendingByHubSession.keys()][0];
    check('CLI 就绪前已登记 pending', () => assert.ok(sid));
    await slow.bridge._test.handleTurnComplete(sid, doneWord('draft'));
    await sleep(20);
    check('prompt 未发出时的 turn-complete 被忽略（不推进也不推催）', () => {
      assert.strictEqual(slow.sentPrompts.length, 0, `不该发任何 prompt，实际 ${slow.sentPrompts.length}`);
      const run = slow.bridge.store.getRun('2026-09-02');
      assert.strictEqual(run.stages.draft.status, 'running');
    });
    release(true);
    await p;
    await sleep(30);
    check('放行后正常派活', () => {
      assert.strictEqual(slow.sentPrompts.length, 1);
      assert.strictEqual(slow.sentPrompts[0].kind, 'claude');
    });
    slow.cleanup();
  }

  // ---- 13. review 棒：写了审阅但没画图 → 不算完成 ----
  {
    const h = makeHarness();
    await h.bridge.runToday({ trigger: 'test' });
    const sid = [...h.bridge._test.pendingByHubSession.keys()][0];
    writeArtifacts(h.studyRoot, 'draft', '2026-09-02', 'L1');
    await h.bridge._test.handleTurnComplete(sid, doneWord('draft'));
    await sleep(20);

    // 只写 review.md，不画图
    const p = workflow.lessonPaths(h.studyRoot, '2026-09-02', 'L1');
    fs.mkdirSync(path.dirname(p.review), { recursive: true });
    fs.writeFileSync(p.review, '意见若干', 'utf8');

    const before = h.sentPrompts.length;
    const reviewSid = [...h.bridge._test.pendingByHubSession.keys()][0];
    await h.bridge._test.handleTurnComplete(reviewSid, doneWord('review'));
    await sleep(20);
    check('审阅写了但图没画 → 不推进，先推一次', () => {
      assert.strictEqual(h.sentPrompts.length, before + 1);
      assert.strictEqual(h.bridge.store.getRun('2026-09-02').stages.review.status, 'running');
    });

    await h.bridge._test.handleTurnComplete(reviewSid, doneWord('review'));
    await sleep(20);
    check('图仍然没画 → review 棒失败，且错误里点名缺的图', () => {
      const run = h.bridge.store.getRun('2026-09-02');
      assert.strictEqual(run.stages.review.status, 'failed');
      assert.ok(/k1-demo\.png/.test(run.stages.review.error), `实际：${run.stages.review.error}`);
    });
    h.cleanup();
  }

  /* ───────────────── 汇总 ───────────────── */
  console.log('\n学习 Tab 编排器 · 离线验证\n');
  for (const [state, name, msg] of results) {
    console.log(`[${state}] ${name}${msg ? '\n        ' + msg : ''}`);
  }
  const failed = results.filter((r) => r[0] === 'FAIL').length;
  console.log(`\n${passed} 通过 / ${failed} 失败 / 共 ${results.length}\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('测试脚本异常：', e); process.exit(2); });
