'use strict';
/**
 * I 层 · 隔离真实 Hub 的受控故障测试（任务书 §10.1 的 I 层）
 * ────────────────────────────────────────────────────────────────────────────
 *
 * 跑的是**真的**：真 Electron 主进程、真 IPC、真 meeting 持久化、真任务目录与文件读写、
 * 真交付闸门、真停止意图落盘、真重启重扫。唯一被替换的接缝是「派发一轮」和「席位就绪」
 * （main/groupchat/test-dispatch-stub.js，隔离数据目录 + 显式 env 双重闸门，生产拿不到）——
 * 拉起真实 CLI 是 L 层的事，不在这一层冒充。
 *
 * 覆盖：A01 / B01 B04 B05 B06 B07 B08 / C04 C06 C08 / D02 D06 D07，
 * 外加本轮合并位手点复现的两条：停止后开题无法接续、已接收文档变更先重派后暂停。
 *
 * 隔离：独立 CLAUDE_HUB_DATA_DIR + CLAUDE_HUB_HOME_DIR + 空 DEEPSEEK_API_KEY + 随机 CDP 端口；
 * 关闭只针对本进程 spawn 出来的那个 PID。**不碰生产 Hub。**
 *
 * 用法：node tests/dev-md-handoff-i-e2e.js
 */
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const RUN_ID = `md-i-${Date.now()}`;
const ROOT = path.join(os.tmpdir(), 'hub-i-e2e', RUN_ID);
const DATA_DIR = path.join(ROOT, 'data');
const SCRIPT_PATH = path.join(ROOT, 'dispatch-script.js');
const PLAN_PATH = path.join(ROOT, 'dispatch-plan.json');

const results = [];
let failed = 0;
function ok(condition, name, detail = '') {
  results.push({ name, pass: !!condition, detail });
  if (!condition) failed += 1;
  console.log(`${condition ? '  ok  ' : ' FAIL '} ${name}${condition || !detail ? '' : '  → ' + detail}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 派发脚本：Hub 每次派发都重新读它，测试通过改 plan.json 控制这一轮的行为 ──
const DISPATCH_SCRIPT = `'use strict';
const fs = require('fs');
const path = require('path');
const PLAN = ${JSON.stringify(PLAN_PATH)};

module.exports = function handle(args, ctx) {
  let plan = {};
  try { plan = JSON.parse(fs.readFileSync(PLAN, 'utf8')); } catch (e) { plan = {}; }
  const kind = (args.workflowRun && args.workflowRun.kind) || 'loop';
  const member = String((args.targetMemberIds || [])[0] || '');
  const key = kind === 'kickoff' ? 'kickoff' : (member === 'm1' ? 'builder' : 'reviewer');
  const step = plan[key] || {};
  const log = plan.__log || [];
  log.push({ key, member, kind, callIndex: ctx.callIndex, prompt: String(args.userInput || '').slice(0, 8000) });
  plan.__log = log;
  try { fs.writeFileSync(PLAN, JSON.stringify(plan, null, 2), 'utf8'); } catch (e) {}
  if (step.writeDoc) {
    fs.mkdirSync(ctx.taskDocsDir, { recursive: true });
    fs.writeFileSync(path.join(ctx.taskDocsDir, step.writeDoc.name), step.writeDoc.body, 'utf8');
  }
  return { text: step.text || '（我先说两句人话，还没交付）' };
};
`;

function writePlan(plan) {
  fs.writeFileSync(PLAN_PATH, JSON.stringify({ ...plan, __log: [] }, null, 2), 'utf8');
}
function dispatchLog() {
  try { return (JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8')).__log) || []; } catch (e) { return []; }
}
const keys = () => JSON.stringify(dispatchLog().map((x) => x.key));

const KICKOFF_DOC = ['# 开题报告', '## 目标', '把交接改成文件改名。', '## 非目标',
  '不做通用工作流编辑器。', '## 验收标准', '建房→开题→实现→审查全程跑通。',
  '## 风险与回退', '出问题就停止新派发，保留全部文档。'].join('\n');
const BUILD_DOC = ['# 阶段1协作手册', 'worktree C:/AIWork/x，分支 feat/y，完整提交 abc1234def。',
  '实际验证：跑了全量单测。', '未完成项：无。'].join('\n');
const REVIEW_PASS = ['# 阶段1合并手册', '我独立跑了验证。', 'RESULT: PASS', 'BLOCKERS: 无',
  'VERIFIED: 全量单测通过', 'NEXT: 无'].join('\n');
const REVIEW_NO_RESULT = ['# 合并手册', '我看了看，感觉应该没什么问题，测试大概是过的吧，',
  '就先这样了，没有写单独成行的裁决。'].join('\n');
const CHAT_FAIL = ['RESULT: FAIL', 'BLOCKERS: 我改主意了', 'VERIFIED: 跑过', 'NEXT: 无'].join('\n');

const docName = (pos) => {
  if (pos === 0) return '已完成-开题报告.md';
  const round = Math.ceil(pos / 2);
  return pos % 2 === 1 ? `已完成-阶段${round}协作手册.md` : `已完成-阶段${round}合并手册.md`;
};

// 群聊的工作现场：一个真实存在的 git 仓库目录。
// 开发群聊的项目现场必须核实得过，否则引擎会（正确地）停在 project_root_unverified。
const REPO_DIR = path.join(ROOT, 'fixture-repo');
const WORKTREE_DIR = path.join(ROOT, 'fixture-worktree');
const NOT_A_REPO = path.join(ROOT, 'just-a-folder');

async function main() {
  fs.mkdirSync(ROOT, { recursive: true });
  fs.mkdirSync(path.join(REPO_DIR, '.git'), { recursive: true });
  fs.mkdirSync(WORKTREE_DIR, { recursive: true });
  fs.writeFileSync(path.join(WORKTREE_DIR, '.git'), 'gitdir: ' + path.join(REPO_DIR, '.git', 'worktrees', 'x'), 'utf8');
  fs.mkdirSync(NOT_A_REPO, { recursive: true });
  fs.writeFileSync(SCRIPT_PATH, DISPATCH_SCRIPT, 'utf8');
  writePlan({});

  let hub = await launchIsolatedHub({
    dataDir: DATA_DIR,
    port: await freePort(),
    label: 'md-handoff-i',
    windowMode: 'hidden',
    extraEnv: { CLAUDE_HUB_TEST_DISPATCH_SCRIPT: SCRIPT_PATH },
  });
  console.log(`[I] 隔离 Hub PID=${hub.child.pid} DATA=${DATA_DIR}`);

  let cdp = await connectFirstPage(hub, (t) => t.type === 'page' && /index\.html/.test(t.url));
  await cdp.send('Runtime.enable');
  let invoke = async (channel, args) => cdp.eval(
    `require('electron').ipcRenderer.invoke(${JSON.stringify(channel)}, ${JSON.stringify(args || {})})`,
  );

  let meetingId = null;
  const taskDir = () => path.join(DATA_DIR, 'task-docs', meetingId);
  const meetingOf = async () => ((await invoke('get-meetings')) || []).find((m) => m && m.id === meetingId) || null;
  const wf = async () => ((await meetingOf()) || {}).serialWorkflow || {};
  const loopState = async () => (await wf()).loopState || {};
  const writeDoc = (pos, body) => {
    fs.mkdirSync(taskDir(), { recursive: true });
    fs.writeFileSync(path.join(taskDir(), docName(pos)), body, 'utf8');
  };
  const rmDoc = (pos) => { try { fs.rmSync(path.join(taskDir(), docName(pos)), { recursive: true, force: true }); } catch (e) {} };
  /** 等这一轮真的跑完再断言 —— 引擎是后台跑的，固定 sleep 会把节奏问题误报成缺陷。 */
  const waitIdle = async (timeoutMs = 30000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = await invoke('loop:status', { meetingId });
      if (!status || !status.running) return status;
      await sleep(200);
    }
    return invoke('loop:status', { meetingId });
  };

  try {
    for (let i = 0; i < 60; i += 1) {
      if (await cdp.eval('!!(window.WorkflowTemplates && window.DevDiscuss)').catch(() => false)) break;
      await sleep(500);
    }

    // ── A01 建房 ──
    const created = await invoke('create-meeting', {
      mode: 'dev', title: `I 层 ${RUN_ID}`, groupChat: true, workspace: REPO_DIR,
      slotSpecs: [{ index: 0, kind: 'codex', memberId: 'm1' }, { index: 1, kind: 'claude', memberId: 'm2' }],
    });
    meetingId = created && created.id;
    ok(!!meetingId, 'A01/I 真实 IPC 建出开发群聊');
    const seeded = await invoke('test:seed-groupchat-members', { meetingId, count: 2 });
    ok(seeded && seeded.ok, 'I 席位就位（合成席位，不为 I 层拉真实 CLI）');
    const config = await cdp.eval(`JSON.stringify(window.WorkflowTemplates.createTemplateConfig('dev-task',
      [{memberId:'m1',kind:'codex'},{memberId:'m2',kind:'claude'}], {}))`);
    await invoke('update-meeting-sync', { meetingId, fields: { scene: 'dev', serialWorkflow: JSON.parse(config) } });
    ok((await wf()).devPhase === 'discuss', 'A01/I 新建开发群聊默认落在讨论阶段');
    ok((await wf()).mdHandoff === true, 'A01/I 新房间默认走 MD 改名交接');
    const blocked = await invoke('loop:start', { meetingId, userInput: '直接开工试试' });
    ok(blocked && blocked.ok === false && blocked.reason === 'dev_discuss_phase',
      'A01/I 讨论阶段无法绕过开题直接开工', JSON.stringify(blocked));

    // ── B01 开题：只写草稿不改名 → 不推进 ──
    writePlan({ kickoff: { text: '我先把任务书写个草稿。' } });
    fs.mkdirSync(taskDir(), { recursive: true });
    fs.writeFileSync(path.join(taskDir(), '开题报告.md'), KICKOFF_DOC, 'utf8');
    ok((await invoke('dev:kickoff', { meetingId, authorMemberId: 'm1' })).ok, 'I 开题已派发');
    await waitIdle();
    ok((await wf()).devPhase === 'kickoff', 'B01/I 草稿在、完成文件不在 → 停在开题不推进');
    ok(dispatchLog().filter((x) => x.key === 'kickoff').length === 1,
      'B01/I 普通回复结束没有触发下一步', keys());

    // ── B01 空的完成文件同样不算交付 ──
    writeDoc(0, '');
    await invoke('dev:redispatch', { meetingId });
    await waitIdle();
    ok((await wf()).devPhase === 'kickoff', 'B01/I 空的完成文件不算交付');

    // ── D06 停止 与 迟到的完成文件 并发 ──
    await invoke('loop:stop', { meetingId });
    writeDoc(0, KICKOFF_DOC);
    ok(!!(await wf()).stopRequested, 'D06/I 停止意图已落盘');
    await sleep(1500);
    ok((await wf()).devPhase === 'kickoff', 'D06/I 停止后迟到的完成文件不触发实现派工');

    // ── 合并位手点复现的那条：停止后点「重发」必须能接续 ──
    writePlan({ builder: { text: '收到，我先看看。' }, reviewer: { text: '我在审。' } });
    const redispatch = await invoke('dev:redispatch', { meetingId });
    ok(redispatch && redispatch.ok === true,
      '接续入口/I 停止后点「重发」不再报 no_resumable_run', JSON.stringify(redispatch));
    await waitIdle();
    ok(!(await wf()).stopRequested, '接续入口/I 重发把落盘的停止意图清掉了');
    ok((await wf()).devPhase === 'build', '接续入口/I 已接收的开题报告直接接着开工', (await wf()).devPhase);
    ok(dispatchLog().filter((x) => x.key === 'kickoff').length === 0,
      '接续入口/I 报告已交付时不再重写任务书', keys());

    // ── B01 工作位只回话不交手册 → 不派审查 ──
    let ls = await loopState();
    ok(ls.status === 'paused' && ls.lastError && ls.lastError.reason === 'handoff_pending',
      'B01/I 工作位回复结束 ≠ 交付，停在等协作手册', JSON.stringify(ls.lastError || ls.status));
    ok(dispatchLog().filter((x) => x.key === 'reviewer').length === 0,
      'B01/I 审查绝不能看到半成品分支', keys());

    // ── B05 完成文件读不出来（这里用同名目录制造读取失败）→ 保留阶段、不判 FAIL ──
    fs.mkdirSync(path.join(taskDir(), docName(1)), { recursive: true });
    writePlan({ builder: { text: '还在收尾。' }, reviewer: { text: '我在审。' } });
    await invoke('dev:redispatch', { meetingId });
    await waitIdle();
    ls = await loopState();
    ok(ls.status === 'paused' && ls.lastError && String(ls.lastError.reason).startsWith('handoff_'),
      'B05/I 完成文件读不出来 → 保留阶段，不判代码 FAIL', JSON.stringify(ls.lastError));
    ok(!(ls.history || []).some((h) => h && h.pass === false), 'B05/I 也没有被记成一次评审未通过');

    // ── B04/D02 完成文件已经在了 → 重读识别，不重派工作位，正好派下一位一次 ──
    rmDoc(1);
    writeDoc(1, BUILD_DOC);
    writePlan({ builder: { text: '不该再叫我。' }, reviewer: { text: '我在审，还没交手册。' } });
    await invoke('dev:redispatch', { meetingId });
    await waitIdle();
    ok(dispatchLog().filter((x) => x.key === 'builder').length === 0,
      'B04/I 完成文件已存在时不再重派工作位（丢事件靠重读兜住）', keys());
    ok(dispatchLog().filter((x) => x.key === 'reviewer').length === 1,
      'B04/I 交付被接收后正好派下一位一次', keys());
    const accepted1 = ((await wf()).taskDocs || {}).accepted || {};
    ok(!!accepted1['1'] && !!accepted1['1'].fingerprint,
      'B06/I 交付凭据已持久化：「已交付」不依赖 UI 忙闲灯');

    // ── B08 审查手册缺 RESULT → 不猜裁决 ──
    writeDoc(2, REVIEW_NO_RESULT);
    writePlan({ builder: { text: 'x' }, reviewer: { text: '我觉得应该没问题。' } });
    await invoke('dev:redispatch', { meetingId });
    await waitIdle();
    ls = await loopState();
    ok(ls.status === 'paused' && ls.lastError && ls.lastError.reason === 'handoff_incomplete',
      'B08/I 审查手册缺 RESULT → 停在待核对，不猜成 PASS', JSON.stringify(ls.lastError));

    // ── B08 手册 PASS、聊天 FAIL → 待核对；再点继续仍然待核对 ──
    rmDoc(2);
    writePlan({
      builder: { text: 'x' },
      reviewer: { text: CHAT_FAIL, writeDoc: { name: docName(2), body: REVIEW_PASS } },
    });
    await invoke('dev:redispatch', { meetingId });
    await waitIdle();
    ls = await loopState();
    ok(ls.lastError && ls.lastError.reason === 'verdict_conflict',
      'B08/I 手册与聊天裁决矛盾 → 停在待核对', JSON.stringify(ls.lastError));
    ok(!!(((await wf()).taskDocs || {}).conflicts || {})['2'], 'B08/I 矛盾连同手册指纹一起落盘');
    writePlan({ builder: { text: 'x' }, reviewer: { text: 'y' } });
    await invoke('loop:resume', { meetingId });
    await waitIdle();
    ls = await loopState();
    ok(ls.status === 'paused' && ls.lastError && ls.lastError.reason === 'verdict_conflict',
      'B08/I 直接点「继续」不会把没解决的矛盾变成完成',
      JSON.stringify(ls.status + '/' + ((ls.lastError || {}).reason)));
    ok(dispatchLog().length === 0, 'B08/I 待核对期间不再派任何人', keys());

    // ── 已接收文档被改动 → 派发前就停住，不白烧一次真实轮次 ──
    // 挑「循环还处在可接续状态」的时刻做：已完成的运行本来就没有可接续的东西。
    fs.appendFileSync(path.join(taskDir(), docName(1)), '\n后来又被人改了一版。', 'utf8');
    writePlan({ builder: { text: 'x' }, reviewer: { text: 'y' } });
    await invoke('dev:redispatch', { meetingId });
    await waitIdle();
    ls = await loopState();
    ok(ls.lastError && ls.lastError.reason === 'handoff_changed_after_accept',
      '派发前闸门/I 已接收文档被改动 → 待核对', JSON.stringify(ls.lastError));
    ok(dispatchLog().length === 0, '派发前闸门/I 待核对之前一次派发都不该发生', keys());

    // ── B07 手册裁决完整、群聊里没有任何协议字段 → 照样推进 ──
    // （先把矛盾解决掉：合并位重新交一份手册，指纹变了 → 走「已接收的被改动」，
    //   这本身也是 B08 的一条：不静默放行。然后开新一轮验证 B07。）
    fs.rmSync(path.join(taskDir(), docName(2)), { force: true });
    writePlan({
      builder: { text: '这一轮我一句协议字段都不写。', writeDoc: { name: docName(3), body: BUILD_DOC } },
      reviewer: { text: '这一轮我也不写。', writeDoc: { name: docName(4), body: REVIEW_PASS } },
    });
    await invoke('loop:start', { meetingId, userInput: '换个新目标重新来一轮' });
    await waitIdle(40000);
    ls = await loopState();
    ok(ls.status === 'done',
      'B07/I 手册裁决完整、群聊没有协议字段 → 不被缺回执卡住', JSON.stringify(ls.status + '/' + JSON.stringify(ls.lastError || null)));
    ok(dispatchLog().filter((x) => x.key === 'builder').length === 1
      && dispatchLog().filter((x) => x.key === 'reviewer').length === 1,
      'B07/I 一轮就收口，各派一次', keys());

    // ── C04/C06/C08 插话 ──
    const longSupplement = ['补充开头-U12', '中间'.repeat(5000), '补充结尾-U12'].join('|');
    const supp = await invoke('groupchat:user-supplement', { meetingId, text: longSupplement });
    ok(supp && supp.ok === true, 'C08/I 插话在真实 Hub 上落盘', JSON.stringify(supp && supp.reason));
    ok(supp && (supp.pendingSids || []).length === 2,
      'C08/I 没人在跑时两位都记为待送达，不伪称全员已收', JSON.stringify(supp));
    const gcState = await invoke('groupchat:get-state', { meetingId });
    const suppMsg = ((gcState && gcState.messages) || []).find((m) => m && m.supplement);
    ok(!!suppMsg && suppMsg.content === longSupplement,
      'C06/I 原文整段留在群聊里，没有被截断', suppMsg ? String((suppMsg.content || '').length) : 'missing');
    ok(!!suppMsg && suppMsg.origin === 'user',
      'C04/I 真实用户补充带 origin 标记，和 Hub 的阶段指令分得开');

    // ── D07 双击重发：必须恰好一次被接受、恰好一次真实派发 ──
    // 上一版这里放在任务已完成之后，两次都被拒也算通过 —— 那是我写的断言太松，
    // 等于什么都没测（合并位复现出来的）。现在先把现场做成「确实可接续」，
    // 再断言接受次数和真实派发次数都恰好是 1，且轮次没有被重置。
    // 先把现场做成「确实可接续」：开一轮新的、工作位只回话不交手册 → 停在等交付。
    rmDoc(4);
    writePlan({ builder: { text: '这一轮我只回一句话，不交手册。' }, reviewer: { text: 'y' } });
    await invoke('loop:start', { meetingId, userInput: '再开一轮，用来验证双击重发' });
    await waitIdle(40000);
    const roundBeforeDouble = (await loopState()).round;
    writePlan({ builder: { text: '这一轮我只回一句话，不交手册。' }, reviewer: { text: 'y' } });
    const resumableBefore = await invoke('loop:status', { meetingId });
    ok(!!(resumableBefore && resumableBefore.loopState
      && ['paused', 'stopped_user', 'running'].includes(resumableBefore.loopState.status)),
      'D07/I 双击前现场确实可接续（否则这条用例什么都证明不了）',
      JSON.stringify(resumableBefore && resumableBefore.loopState && resumableBefore.loopState.status));
    const [d1, d2] = await Promise.all([
      invoke('dev:redispatch', { meetingId }),
      invoke('dev:redispatch', { meetingId }),
    ]);
    const acceptedCount = [d1, d2].filter((r) => r && r.ok === true).length;
    ok(acceptedCount === 1, 'D07/I 双击重发恰好一次被接受', JSON.stringify({ d1, d2 }));
    await waitIdle();
    ok(dispatchLog().length === 1, 'D07/I 恰好发生一次真实派发，不会创建两个同阶段执行', keys());
    ok((await loopState()).round === roundBeforeDouble, 'D07/I 轮次没有被重发重置');

    // ── D07 旧步骤的重发请求晚到 → 不按最大文件号猜恢复，也不重开轮次 ──
    const staleRound = (await loopState()).round;
    writePlan({ builder: { text: 'x' }, reviewer: { text: 'y' } });
    const stale = await invoke('loop:resume', { meetingId, staleStepIndex: 0 });
    await waitIdle();
    ok((await loopState()).round === staleRound,
      'D07/I 旧请求晚到不重置轮次', JSON.stringify({ stale, round: (await loopState()).round }));

    // ── D07 状态记录损坏 → 不按目录里最大的阶段号盲目继续 ──
    const damaged = { ...(await wf()).loopState, posBase: 'NaN-ish', round: -3 };
    await invoke('update-meeting-sync', { meetingId, fields: { serialWorkflow: { ...(await wf()), loopState: damaged } } });
    writePlan({ builder: { text: 'x' }, reviewer: { text: 'y' } });
    await invoke('dev:redispatch', { meetingId });
    await waitIdle();
    const afterDamage = await loopState();
    ok(afterDamage.status === 'paused' && afterDamage.lastError
      && afterDamage.lastError.reason === 'state_record_damaged',
      'D07/I 状态记录损坏 → 停下来等人处理，不按最大阶段号盲目继续',
      JSON.stringify({ status: afterDamage.status, err: afterDamage.lastError }));
    ok(dispatchLog().length === 0, 'D07/I 记录不可信时一次派发都不该发生', keys());

    // ── E01–E04 路径定位（另开一个群，不打扰上面的流程）──────────────────
    const eRoom = await invoke('create-meeting', {
      mode: 'dev', title: `I 层 E ${RUN_ID}`, groupChat: true, workspace: NOT_A_REPO,
      slotSpecs: [{ index: 0, kind: 'codex', memberId: 'm1' }, { index: 1, kind: 'claude', memberId: 'm2' }],
    });
    const eId = eRoom && eRoom.id;
    await invoke('test:seed-groupchat-members', { meetingId: eId, count: 2 });
    const eConfigRaw = await cdp.eval(`JSON.stringify(window.WorkflowTemplates.createTemplateConfig('dev-task',
      [{memberId:'m1',kind:'codex'},{memberId:'m2',kind:'claude'}], {}))`);
    const eConfig = JSON.parse(eConfigRaw);
    // 项目库里放两个同名候选 + 一个能被任务原文唯一命中的
    eConfig.projectLibrary = [
      { name: '报告工具', path: path.join(ROOT, 'a', 'report-tool') },
      { name: '报告工具', path: path.join(ROOT, 'b', 'report-tool') },
      { name: 'MD 交接 fixture', path: REPO_DIR },
    ];
    eConfig.workRoot = true;
    await invoke('update-meeting-sync', { meetingId: eId, fields: { scene: 'dev', serialWorkflow: eConfig } });
    const eTaskDir = path.join(DATA_DIR, 'task-docs', eId);
    const eWf = async () => (((await invoke('get-meetings')) || []).find((m) => m && m.id === eId) || {}).serialWorkflow || {};
    const eMeeting = async () => ((await invoke('get-meetings')) || []).find((m) => m && m.id === eId) || {};
    const eWaitIdle = async (timeoutMs = 30000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const st = await invoke('loop:status', { meetingId: eId });
        if (!st || !st.running) return st;
        await sleep(200);
      }
      return invoke('loop:status', { meetingId: eId });
    };
    const eWriteDone = (body) => {
      fs.mkdirSync(eTaskDir, { recursive: true });
      fs.writeFileSync(path.join(eTaskDir, docName(0)), body, 'utf8');
    };

    // E03：多个同名候选 → 派出去的 prompt 里必须要求「只问一个具体问题」。
    // 先让维护者真的说一句话 —— 定位靠的是**任务原文**去比对项目库，没有原文就无从匹配。
    await invoke('groupchat:user-supplement', { meetingId: eId, text: '改一下报告工具的导出' });
    writePlan({ kickoff: { text: '我先看看是哪个项目。' } });
    await invoke('dev:kickoff', { meetingId: eId, authorMemberId: 'm1' });
    // 轮询到真的看见那段 prompt 为止 —— 固定 sleep 会把「派发还没发生」误报成「没带那一段」。
    // prompt 原文由派发桩记进 plan 日志（桩替掉了整个 dispatcher，编排器那边看不到）。
    let kickoffPrompt = '';
    for (let i = 0; i < 40 && !kickoffPrompt; i += 1) {
      kickoffPrompt = (dispatchLog().find((x) => x.key === 'kickoff' && /先核实项目现场/.test(x.prompt || '')) || {}).prompt || '';
      if (!kickoffPrompt) await sleep(500);
    }
    ok(!!kickoffPrompt, 'E03/I 派出去的 prompt 里确实带了「先核实项目现场」那一段');
    ok(/只问一个具体问题/.test(kickoffPrompt),
      'E03/I 多个同名候选时要求只问一个具体问题，不许自己挑', kickoffPrompt.slice(0, 80));
    ok(/不许全盘搜索/.test(kickoffPrompt) && /不许自动 git init/.test(kickoffPrompt),
      'E03/I 明确禁止满盘扫和自动初始化');
    ok(/git worktree/.test(kickoffPrompt), 'E04/I 明确说 .git 是文件的 worktree 也算有效现场');

    // E02：报告声明了一个不存在的项目根 → 不许开工，也不许把它绑上去
    eWriteDone(KICKOFF_DOC + '\n项目根：' + path.join(ROOT, '这个目录根本不存在'));
    await invoke('dev:redispatch', { meetingId: eId });
    await eWaitIdle();
    ok((await eWf()).devPhase === 'kickoff',
      'E02/I 项目根核实不过 → 停在开题，不在没核实的现场开工', (await eWf()).devPhase);
    ok((await eWf()).kickoff.status === 'project_root_unverified',
      'E02/I 状态说得出具体原因', JSON.stringify((await eWf()).kickoff));
    ok(path.resolve((await eMeeting()).workspace || '') === path.resolve(NOT_A_REPO),
      'E02/I 没通过核实的路径一律不绑', (await eMeeting()).workspace);

    // E04：另开一个房，报告声明一个 .git 是**文件**的 worktree → 应当认它并绑过去。
    // （不能在上一个房里改写报告：那份已经被接收，改写会走「已接收的交付被改动」那条待核对路径。）
    const wRoom = await invoke('create-meeting', {
      mode: 'dev', title: `I 层 E04 ${RUN_ID}`, groupChat: true, workspace: NOT_A_REPO,
      slotSpecs: [{ index: 0, kind: 'codex', memberId: 'm1' }, { index: 1, kind: 'claude', memberId: 'm2' }],
    });
    const wId = wRoom && wRoom.id;
    await invoke('test:seed-groupchat-members', { meetingId: wId, count: 2 });
    await invoke('update-meeting-sync', { meetingId: wId, fields: { scene: 'dev', serialWorkflow: eConfig } });
    const wTaskDir = path.join(DATA_DIR, 'task-docs', wId);
    fs.mkdirSync(wTaskDir, { recursive: true });
    fs.writeFileSync(path.join(wTaskDir, docName(0)), `${KICKOFF_DOC}\n项目根：${WORKTREE_DIR}`, 'utf8');
    writePlan({ kickoff: { text: '我定位好了。' }, builder: { text: '我先看看。' }, reviewer: { text: '我在审。' } });
    await invoke('dev:kickoff', { meetingId: wId, authorMemberId: 'm1' });
    for (let i = 0; i < 60; i += 1) {
      const st = await invoke('loop:status', { meetingId: wId });
      if (st && !st.running) break;
      await sleep(500);
    }
    const wMeeting = ((await invoke('get-meetings')) || []).find((m) => m && m.id === wId) || {};
    const wWf = wMeeting.serialWorkflow || {};
    ok(path.resolve(wMeeting.workspace || '') === path.resolve(WORKTREE_DIR),
      'E04/I worktree（.git 是文件）被认成有效现场并绑定', wMeeting.workspace);
    ok(wWf.devPhase === 'build',
      'E01/I 核实通过后自主继续进入实现，不要求用户再选一次路径', wWf.devPhase);
    const wLedger = (wWf.taskDocs || {}).accepted || {};
    ok(!!wLedger['0'], 'E01/I 开题交付凭据落盘');
    ok(path.resolve(path.dirname(wLedger['0'].path)) === path.resolve(wTaskDir),
      'E04/I 交接文档仍在本群任务目录里 —— 项目路径怎么改，Hub 都不会去等旧地址',
      wLedger['0'].path);

    // ── D02 重启：接收凭据、阶段、待送达补充都在 ──
    const before = await wf();
    await gracefulQuit(hub);
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR, port: await freePort(), label: 'md-handoff-i-2',
      windowMode: 'hidden', extraEnv: { CLAUDE_HUB_TEST_DISPATCH_SCRIPT: SCRIPT_PATH },
    });
    cdp = await connectFirstPage(hub, (t) => t.type === 'page' && /index\.html/.test(t.url));
    await cdp.send('Runtime.enable');
    invoke = async (channel, args) => cdp.eval(
      `require('electron').ipcRenderer.invoke(${JSON.stringify(channel)}, ${JSON.stringify(args || {})})`,
    );
    for (let i = 0; i < 60; i += 1) {
      if (await cdp.eval('!!window.WorkflowTemplates').catch(() => false)) break;
      await sleep(500);
    }
    const after = await wf();
    ok(!!after && after.devPhase === before.devPhase, 'D02/I 阶段没有被重启重置');
    ok(Object.keys((after.taskDocs || {}).accepted || {}).length
      === Object.keys((before.taskDocs || {}).accepted || {}).length,
      'D02/I 重启后接收凭据一条不少');
    const stateAfter = await invoke('groupchat:get-state', { meetingId });
    const suppAfter = ((stateAfter && stateAfter.messages) || []).filter((m) => m && m.supplement);
    ok(suppAfter.length === 1 && suppAfter[0].content === longSupplement,
      'C08/I 重启后待送达的补充原文还在');
  } catch (error) {
    ok(false, 'I 层脚本本身抛错', (error && error.stack) || String(error));
  } finally {
    try { await cdp.close(); } catch (e) {}
    try { await gracefulQuit(hub, { allowAlreadyExited: true }); } catch (e) {
      console.warn('[I] 关闭隔离 Hub 时报错：', e && e.message);
    }
  }

  console.log('\n────────────────────────────────');
  console.log(`I 层：通过 ${results.length - failed} / ${results.length}，数据目录 ${DATA_DIR}`);
  if (failed) {
    console.log('未通过：');
    for (const r of results.filter((x) => !x.pass)) console.log('  - ' + r.name + (r.detail ? '  → ' + r.detail : ''));
  }
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error('[I] 致命错误：', error);
  process.exit(2);
});
