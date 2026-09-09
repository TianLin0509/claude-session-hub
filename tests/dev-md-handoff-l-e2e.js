'use strict';
/**
 * L 层 · 隔离真实 Hub + 真实 Agent CLI（任务书 §10.1 的 L 层）
 * ────────────────────────────────────────────────────────────────────────────
 *
 * 没有任何桩：真 Electron Hub、真 Codex / Claude 进程、真 PTY 提交闭环、
 * 真的由 agent 自己写 MD 并改名、真的由 Hub 读文件判定交付、真的在 fixture 仓库里合并。
 * 代码改动只落在临时 fixture git 仓库（自带本地 bare remote），绝不碰真实业务仓库。
 *
 * 阶段（--stage）：
 *   kickoff    建房 → 开题 → agent 自己写并改名 → Hub 接收 → 自动进入实现
 *   full       在 kickoff 之上跑到实现、独立审查、**真实合并进 fixture master**、最终 PASS
 *   fail-first 从一份**已知有缺陷的交付**开始，真实审查位必须自己发现并判 FAIL，
 *              然后真实实现位在同一现场修复、真实审查位复审通过（任务书 B10）
 *
 * 注入时点由**可观察的信号**决定，不用固定 sleep：
 *   · 先等 cli-ready-status 真的就绪，再派开题；
 *   · 先观察到真实轮次已经开始（群聊进入运行态且该席位有在途 attempt），再插话。
 *
 * 真实模型要花真实时间，也可能因为额度 / 登录 / 网络失败。**失败就如实报告**，
 * 不降级成桩、不把「没跑到」写成通过。
 *
 * 用法：
 *   node tests/dev-md-handoff-l-e2e.js --stage=full --budget=900
 *   node tests/dev-md-handoff-l-e2e.js --stage=fail-first --budget=900
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const STAGE = arg('stage', 'kickoff');
const BUDGET_MS = Math.max(60, Number(arg('budget', 900))) * 1000;

const RUN_ID = `md-l-${Date.now()}`;
const ROOT = path.join(os.tmpdir(), 'hub-l-e2e', RUN_ID);
const DATA_DIR = path.join(ROOT, 'data');
const FIXTURE = path.join(ROOT, 'fixture-repo');
const REMOTE = path.join(ROOT, 'fixture-remote.git');
const EVIDENCE = path.join(ROOT, 'evidence');
const U12 = `U12-${RUN_ID}`;
// C05：多行 / 中文 / Windows 路径 / emoji / 较长正文，必须原样送达且不被拆成多条
const LONG_SUPPLEMENT = [
  `补充开头 ${U12} ✅`,
  '- 第一条：中文列表项，带全角标点。',
  '- 第二条：路径 C:\\Users\\lintian\\claude-session-hub\\artifacts\\x.md 不要转义掉反斜杠。',
  '正文'.repeat(400),
  `补充结尾 ${U12} 🚀`,
].join('\n');

const results = [];
let failed = 0;
function ok(condition, name, detail = '') {
  results.push({ name, pass: !!condition, detail });
  if (!condition) failed += 1;
  console.log(`${condition ? '  ok  ' : ' FAIL '} ${name}${condition || !detail ? '' : '  → ' + detail}`);
}
function skip(name, why) {
  results.push({ name, pass: null, detail: why });
  console.log(` SKIP  ${name}  → ${why}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const node = (cwd, ...args) => execFileSync(process.execPath, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const AUTHOR_MD = [
  '# 工作位合同（fixture 版）',
  '',
  '这是一个用来验证流程的**临时测试仓库**，任务都很小。',
  '',
  '- 从 master 开一个 `feat/` 分支，改动提交在那个分支上；**不要自己合并进 master**，合并是合并位的事。',
  '- 改完在你的分支上跑 `node test.js`，它必须输出 `OK`。',
  '- 不要推送到任何远端。',
  '- 交付时在群里输出 PROGRESS / VERIFIED / RISK / REPORT 四行，然后写一段 NOTES。',
].join('\n');

const MERGER_MD = [
  '# 合并位合同（fixture 版）',
  '',
  '这是一个临时测试仓库。你要独立验证工作位的改动。',
  '',
  '- 亲自 checkout 工作位那个 `feat/` 分支并跑 `node test.js`，看真实输出，不采信工作位的自述。',
  '- **只有你亲验通过（PASS）才把该分支合并进 master**（`git checkout master && git merge --no-ff <分支>`），FAIL 一律不合。',
  '- 最后严格输出四行：RESULT: PASS 或 FAIL / BLOCKERS / VERIFIED / NEXT。',
].join('\n');

function buildFixture({ withDefect = false } = {}) {
  fs.mkdirSync(FIXTURE, { recursive: true });
  fs.mkdirSync(path.join(FIXTURE, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(FIXTURE, '.agents', 'AUTHOR.md'), AUTHOR_MD, 'utf8');
  fs.writeFileSync(path.join(FIXTURE, '.agents', 'MERGER.md'), MERGER_MD, 'utf8');
  fs.writeFileSync(path.join(FIXTURE, '.agents', 'project.json'),
    JSON.stringify({ name: 'md-handoff-fixture', versionFiles: [], versionBump: null }, null, 2), 'utf8');
  fs.writeFileSync(path.join(FIXTURE, 'greet.js'),
    "'use strict';\nfunction greet(name) { return 'hello ' + name; }\nmodule.exports = { greet };\n", 'utf8');
  fs.writeFileSync(path.join(FIXTURE, 'test.js'),
    "'use strict';\nconst { greet } = require('./greet.js');\nlet bad = 0;\nif (greet('x') !== 'hello x') { console.log('BROKEN default'); bad++; }\nif (bad) process.exit(1);\nconsole.log('OK');\n", 'utf8');
  fs.writeFileSync(path.join(FIXTURE, 'README.md'), '# fixture repo\n\n只用于验证 AI 群聊开发流程。\n', 'utf8');
  git(FIXTURE, 'init', '-q', '-b', 'master');
  git(FIXTURE, 'config', 'user.email', 'fixture@example.invalid');
  git(FIXTURE, 'config', 'user.name', 'Fixture Bot');
  git(FIXTURE, 'add', '-A');
  git(FIXTURE, 'commit', '-q', '-m', 'fixture: 初始提交');
  fs.mkdirSync(REMOTE, { recursive: true });
  git(ROOT, 'init', '--bare', '-q', REMOTE);
  git(FIXTURE, 'remote', 'add', 'origin', REMOTE);
  git(FIXTURE, 'push', '-q', 'origin', 'master');
  const baseSha = git(FIXTURE, 'rev-parse', 'HEAD').trim();

  let defectBranch = null;
  if (withDefect) {
    // B10：植入一份**已知有真实缺陷的交付**——分支上的实现会让现有测试挂掉。
    defectBranch = 'feat/greeting-defective';
    git(FIXTURE, 'checkout', '-q', '-b', defectBranch);
    fs.writeFileSync(path.join(FIXTURE, 'greet.js'),
      "'use strict';\n// 缺陷：默认问候语被写死成 hi，破坏了既有行为\nfunction greet(name, greeting) { return (greeting || 'hi') + ' ' + name; }\nmodule.exports = { greet };\n", 'utf8');
    git(FIXTURE, 'add', '-A');
    git(FIXTURE, 'commit', '-q', '-m', 'feat: 支持自定义问候语（含缺陷）');
    git(FIXTURE, 'checkout', '-q', 'master');
  }
  return { baseSha, defectBranch };
}

function saveEvidence(name, body) {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  fs.writeFileSync(path.join(EVIDENCE, name), typeof body === 'string' ? body : JSON.stringify(body, null, 2), 'utf8');
}

async function main() {
  fs.mkdirSync(ROOT, { recursive: true });
  const { baseSha, defectBranch } = buildFixture({ withDefect: STAGE === 'fail-first' });
  console.log(`[L] fixture=${FIXTURE} baseSha=${baseSha.slice(0, 10)} stage=${STAGE} budget=${BUDGET_MS / 1000}s`);

  let hub = await launchIsolatedHub({
    dataDir: DATA_DIR, port: await freePort(), label: 'md-handoff-l', windowMode: 'hidden',
  });
  console.log(`[L] 隔离 Hub PID=${hub.child.pid} DATA=${DATA_DIR}`);
  let cdp = null;
  let meetingId = null;
  let promptPoller = null;
  const promptsBySid = new Map();   // sid → [prompt 原文…]，用来核对逐人送达与去重

  const taskDir = () => path.join(DATA_DIR, 'task-docs', meetingId);
  const doneName = (pos) => {
    if (pos === 0) return '已完成-开题报告.md';
    const round = Math.ceil(pos / 2);
    return pos % 2 === 1 ? `已完成-阶段${round}协作手册.md` : `已完成-阶段${round}合并手册.md`;
  };

  try {
    cdp = await connectFirstPage(hub, (t) => t.type === 'page' && /index\.html/.test(t.url));
    await cdp.send('Runtime.enable');
    const invoke = async (channel, args) => cdp.eval(
      `require('electron').ipcRenderer.invoke(${JSON.stringify(channel)}, ${JSON.stringify(args || {})})`,
    );
    for (let i = 0; i < 60; i += 1) {
      if (await cdp.eval('!!window.WorkflowTemplates').catch(() => false)) break;
      await sleep(500);
    }
    const wf = async () => {
      const all = await invoke('get-meetings');
      const m = (all || []).find((x) => x && x.id === meetingId);
      return (m && m.serialWorkflow) || {};
    };
    const gcState = async () => invoke('groupchat:get-state', { meetingId });
    // 「prompt 已经提交、正在等它回答」这几种状态才算真的送到了。
    // prepared / submitting 不算 —— 那时候写入可能还在路上；IPC 的 ok:true 更不算，
    // 它只表示请求被接受（2026-09-08 合并位指出的误报点）。
    const INJECTABLE = ['accepted', 'running', 'awaiting_binding', 'awaiting_final_text'];
    const waitDispatched = async (sid, timeoutMs = 240000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const st = await gcState();
        const live = Object.values((st && st.attempts) || {}).some(
          (a) => a && a.sid === sid && INJECTABLE.includes(String(a.status || '')));
        if (live) return true;
        await sleep(1500);
      }
      return false;
    };

    // ── 建房：真实两席位（Codex 工作位 + Claude 合并位），工作目录就是 fixture ──
    const created = await invoke('create-meeting', {
      mode: 'dev', title: `L 层 ${RUN_ID}`, groupChat: true, workspace: FIXTURE,
      slots: [{ index: 0, kind: 'codex', memberId: 'm1' }, { index: 1, kind: 'claude', memberId: 'm2' }],
    });
    meetingId = created && created.id;
    const subs = (created && created.subSessions) || [];
    ok(!!meetingId && subs.length === 2, 'L 建出开发群聊并拉起两个真实 CLI 会话', JSON.stringify({ subs: subs.length }));
    if (!meetingId || subs.length < 2) throw new Error('真实席位没起来，后面的 L 用例无法进行');
    const [builderSid, reviewerSid] = subs;

    const config = await cdp.eval(`JSON.stringify(window.WorkflowTemplates.createTemplateConfig('dev-task',
      [{memberId:'m1',kind:'codex'},{memberId:'m2',kind:'claude'}], {}))`);
    await invoke('update-meeting-sync', { meetingId, fields: { scene: 'dev', serialWorkflow: JSON.parse(config) } });
    ok((await wf()).devPhase === 'discuss', 'L 新房间落在讨论阶段');

    // prompt 采集：pendingPrompts 在结算时会被清掉，所以边跑边抓，留作逐人送达/去重的证据
    promptPoller = setInterval(async () => {
      try {
        const st = await gcState();
        for (const bySid of Object.values((st && st.pendingPrompts) || {})) {
          for (const [sid, entry] of Object.entries(bySid || {})) {
            const text = entry && typeof entry === 'object' ? String(entry.prompt || '') : '';
            if (!text) continue;
            const list = promptsBySid.get(sid) || [];
            if (!list.includes(text)) { list.push(text); promptsBySid.set(sid, list); }
          }
        }
      } catch (e) { /* 采集失败不影响主流程 */ }
    }, 800);

    // ── 就绪信号驱动：等**这一步要派的那位**真的就绪再派活（不用固定 sleep）──
    // 只等执笔者：另一位要等它第一次被派工时才会被标成群聊就绪，
    // 在这里等它是等不到的（第一版就是这么误报的）。
    const authorSid = STAGE === 'fail-first' ? reviewerSid : builderSid;
    const readyDeadline = Date.now() + 180000;
    const readyOf = async (sid) => !!(await invoke('cli-ready-status', sid).catch(() => false));
    let authorReady = false;
    while (Date.now() < readyDeadline) {
      if (await readyOf(authorSid)) { authorReady = true; break; }
      await sleep(2000);
    }
    ok(authorReady, 'L 这一步要派的那位 CLI 在派活前已就绪（可观察信号，不是固定等待）',
      authorReady ? '' : '180s 内未观察到就绪；派发本身仍会自己等，下面按实际结果判定');

    const goal = STAGE === 'fail-first'
      ? `分支 ${defectBranch} 上已经有一份实现，但它破坏了既有行为。请按合同独立审查它。`
      : '把 greet 改成支持第二个参数 greeting，默认仍然是 hello，并补一条覆盖自定义问候语的测试。';
    // 2026-09-08 合并位复现：这里原来只调 meeting-append-user-turn —— 它**只写时间线**，
    // 不会把需求送进任何 Agent 的上下文。结果开题 Agent 拿到的 prompt 里根本没有需求，
    // 它只能反问「要实现什么功能」，而脚本却已经把这一步记成成功了。
    // 需求必须走真正的投递入口（和用户在输入框里发一句话是同一条路）。
    await invoke('meeting-append-user-turn', { meetingId, text: goal });
    const goalDelivery = await invoke('groupchat:user-supplement', { meetingId, text: goal });
    ok(goalDelivery && goalDelivery.ok === true,
      'L 初始需求已进入逐人投递账本（不是只写时间线）', JSON.stringify(goalDelivery));

    if (STAGE === 'fail-first') {
      // 从「已知缺陷交付」开始：手动放好协作手册，让引擎跳过实现位、直接派真实审查位。
      fs.mkdirSync(taskDir(), { recursive: true });
      fs.writeFileSync(path.join(taskDir(), doneName(1)), [
        '# 阶段1协作手册',
        `分支：${defectBranch}`,
        '实现：给 greet 加了第二个参数 greeting。',
        '实际验证：我认为跑过了测试。',
        '未完成项：无。',
      ].join('\n'), 'utf8');
      await invoke('update-meeting-sync', { meetingId, fields: { serialWorkflow: { ...(await wf()), devPhase: 'build' } } });
      const started = await invoke('loop:start', { meetingId, userInput: goal });
      ok(started && started.ok === true, 'B10/L 请求被接受（只是接受，不代表送到了）', JSON.stringify(started));
      ok(await waitDispatched(reviewerSid), 'B10/L 审查位真的收到了 prompt（按可观察的执行状态判，不看返回值）');
    } else {
      const started = await invoke('dev:kickoff', { meetingId, authorMemberId: 'm1' });
      // ok:true 只表示「请求被接受」——它是同步返回的，那一刻什么都还没发出去。
      // 2026-09-08 合并位指出这两行会提前误报成功；下面必须看**可观察的执行状态**。
      ok(started && started.ok === true, 'A02/L 开题请求被接受（只是接受，不代表送到了）', JSON.stringify(started));
      const dispatched = await waitDispatched(builderSid);
      // 光「送到了」还不够：需求本身必须在那份 prompt 里。这正是上一轮漏掉的东西。
      const goalMark = goal.slice(0, 24);
      let goalInPrompt = false;
      for (let i = 0; i < 40 && !goalInPrompt; i += 1) {
        goalInPrompt = [...promptsBySid.values()].flat().some((text) => text.includes(goalMark));
        if (!goalInPrompt) await sleep(1000);
      }
      ok(goalInPrompt, 'L 初始需求真的出现在派给执笔者的 prompt 里（不是只躺在时间线上）',
        goalMark);
      const kickoffState = (await wf()).kickoff || {};
      ok(dispatched,
        'A02/L 开题 prompt 真的送进了 CLI（按该席位的执行状态判，不看 IPC 返回值）',
        JSON.stringify({ kickoff: kickoffState }));
      ok(kickoffState.status !== 'dispatch_failed',
        'L 送不进去时会明说 dispatch_failed，而不是含混地等',
        JSON.stringify(kickoffState));
      if (!dispatched) throw new Error('开题 prompt 没能送进 CLI：' + JSON.stringify(kickoffState));
    }

    // ── C01/C05：等真实轮次开始之后再插话，验证运行中接收 ──
    ok(await waitDispatched(authorSid),
      'L 观察到执笔者的 prompt 已提交、正在作答（插话时点由此决定，不是固定等 20 秒）');
    const supp = await invoke('groupchat:user-supplement', { meetingId, text: LONG_SUPPLEMENT });
    saveEvidence('supplement-result.json', supp);
    ok(supp && supp.ok === true, 'C01/L 运行中插话被接受', JSON.stringify(supp && supp.reason));
    ok(supp && (supp.deliveredNow || []).length >= 1,
      'C01/L 插话真的提交进了正在运行的那位（闭环提交，不是盲发回车）',
      JSON.stringify({ deliveredNow: supp && supp.deliveredNow, pending: supp && supp.pendingSids }));
    ok(supp && (supp.pendingSids || []).some((sid) => sid !== (supp.deliveredNow || [])[0]),
      'C01/L 待命的那位没有被唤醒，只记账', JSON.stringify(supp && supp.pendingSids));

    // ── C07：直接对某个 CLI 私话，Hub 不广播、也不推进阶段 ──
    const phaseBeforePrivate = (await wf()).devPhase;
    const privateMark = `PRIVATE-${RUN_ID}`;
    await invoke('session:send-prompt', { sessionId: reviewerSid, text: `（私话，不用回复）${privateMark}` });
    await sleep(3000);
    const stAfterPrivate = await gcState();
    ok(!((stAfterPrivate && stAfterPrivate.messages) || []).some((m) => String(m && m.content || '').includes(privateMark)),
      'C07/L CLI 私话不被 Hub 广播进群聊');
    ok((await wf()).devPhase === phaseBeforePrivate, 'C07/L 私话不推进阶段、不重置任务');

    // ── 等交付 ──
    const stageDeadline = Date.now() + BUDGET_MS;
    const waitFile = async (pos) => {
      while (Date.now() < stageDeadline) {
        if (fs.existsSync(path.join(taskDir(), doneName(pos)))) return true;
        await sleep(5000);
      }
      return false;
    };

    if (STAGE !== 'fail-first') {
      const gotKickoff = await waitFile(0);
      ok(gotKickoff, 'A02/L 真实 agent 自己写出并改名了「已完成-开题报告.md」',
        gotKickoff ? '' : `超时；任务目录 ${taskDir()}`);
      if (gotKickoff) {
        const body = fs.readFileSync(path.join(taskDir(), doneName(0)), 'utf8');
        saveEvidence('kickoff-report.md', body);
        ok(/目标/.test(body) && /非目标/.test(body) && /验收/.test(body) && /(风险|回退)/.test(body),
          'A02/L 开题报告含四项');
        const acceptDeadline = Date.now() + 180000;
        let phase = '';
        while (Date.now() < acceptDeadline) {
          phase = (await wf()).devPhase;
          if (phase === 'build') break;
          await sleep(3000);
        }
        ok(phase === 'build', 'B02/L Hub 接收后自动进入实现，不要第二次确认', phase);
        ok(!!(((await wf()).taskDocs || {}).accepted || {})['0'], 'B02/L 接收凭据已落盘');
      }
    }

    if (STAGE === 'kickoff') {
      skip('B09/L 完整实现→审查→fixture 实际合并→PASS', '本次只跑 kickoff 阶段');
      skip('B10/L 已知缺陷被真实审查判 FAIL 后修复', '用 --stage=fail-first 跑');
    }

    if (STAGE === 'full') {
      const gotBuild = await waitFile(1);
      ok(gotBuild, 'B09/L 实现位真的交出了「已完成-阶段1协作手册.md」');
      const gotReview = await waitFile(2);
      ok(gotReview, 'B09/L 合并位真的交出了「已完成-阶段1合并手册.md」');
      let verdict = null;
      if (gotReview) {
        const review = fs.readFileSync(path.join(taskDir(), doneName(2)), 'utf8');
        saveEvidence('review-manual.md', review);
        const m = /(?:^|\n)\s*RESULT\s*[:：]\s*(PASS|FAIL)\b/i.exec(review);
        verdict = m ? m[1].toUpperCase() : null;
        ok(verdict === 'PASS', 'B09/L 完整成功路径要求最终裁决是 PASS（FAIL 不算 B09 通过）', String(verdict));
      }
      // 真实改动 + 真实合并：master 必须前进，且代码与测试都变了，测试在 master 上真能过
      const headNow = git(FIXTURE, 'rev-parse', 'master').trim();
      ok(headNow !== baseSha, 'B09/L fixture 的 master 上出现了真实新提交（不是只有手册）',
        `${baseSha.slice(0, 8)} → ${headNow.slice(0, 8)}`);
      const changed = headNow === baseSha ? '' : git(FIXTURE, 'diff', '--name-only', `${baseSha}..master`);
      ok(/greet\.js/.test(changed) && /test\.js/.test(changed),
        'B09/L 实现与测试都真的改了', JSON.stringify(changed.split(/\r?\n/).filter(Boolean)));
      let testOut = '';
      try { git(FIXTURE, 'checkout', '-q', 'master'); testOut = node(FIXTURE, 'test.js'); } catch (e) { testOut = 'FAILED: ' + (e && e.message); }
      saveEvidence('master-test-output.txt', testOut);
      ok(/OK/.test(testOut), 'B09/L 合并后的 master 上测试真的通过', testOut.trim().slice(0, 120));
      const branches = git(FIXTURE, 'branch', '--merged', 'master');
      ok(/feat\//.test(branches), 'B09/L 实现分支确实被合并进了 master（不是只提交没合并）',
        branches.replace(/\s+/g, ' ').trim());
      saveEvidence('fixture-log.txt', git(FIXTURE, 'log', '--oneline', '--graph', '-15'));
    }

    if (STAGE === 'fail-first') {
      const gotFirstReview = await waitFile(2);
      ok(gotFirstReview, 'B10/L 真实审查位对缺陷交付交出了合并手册');
      let firstVerdict = null;
      if (gotFirstReview) {
        const review = fs.readFileSync(path.join(taskDir(), doneName(2)), 'utf8');
        saveEvidence('review-1-fail.md', review);
        const m = /(?:^|\n)\s*RESULT\s*[:：]\s*(PASS|FAIL)\b/i.exec(review);
        firstVerdict = m ? m[1].toUpperCase() : null;
        ok(firstVerdict === 'FAIL', 'B10/L 真实审查位自己发现了植入的缺陷并判 FAIL（不是假 FAIL 卡片）', String(firstVerdict));
        ok(/BLOCKERS/i.test(review) && !/BLOCKERS\s*[:：]\s*无/i.test(review),
          'B10/L 手册里写了具体阻断项');
      }
      const gotFix = await waitFile(3);
      ok(gotFix, 'B10/L 下一轮实现位在同一现场修复并交出了阶段2协作手册');
      const gotSecondReview = await waitFile(4);
      ok(gotSecondReview, 'B10/L 修复后再次真实审查');
      if (gotSecondReview) {
        const review2 = fs.readFileSync(path.join(taskDir(), doneName(4)), 'utf8');
        saveEvidence('review-2.md', review2);
        const m2 = /(?:^|\n)\s*RESULT\s*[:：]\s*(PASS|FAIL)\b/i.exec(review2);
        ok(!!m2, 'B10/L 复审给出了明确裁决', m2 ? m2[1] : 'none');
      }
    }

    // ── C03：逐人送达与去重（用真实 prompt 原文核对，不看 agent 自述）──
    saveEvidence('prompts-by-sid.json', Object.fromEntries(
      [...promptsBySid.entries()].map(([sid, list]) => [sid, list.map((p) => ({ len: p.length, hasU12: p.includes(U12) }))]),
    ));
    const hits = [...promptsBySid.entries()].map(([sid, list]) => ({
      sid, hit: list.filter((p) => p.includes(LONG_SUPPLEMENT)).length, any: list.filter((p) => p.includes(U12)).length,
    }));
    saveEvidence('supplement-delivery.json', hits);
    const standbyHit = hits.find((h) => h.sid !== (supp && (supp.deliveredNow || [])[0]));
    ok(!!standbyHit && standbyHit.hit >= 1,
      'C03/L 待命那位在它下一次真实 prompt 里拿到了补充原文（逐人送达）', JSON.stringify(hits));
    ok(!standbyHit || standbyHit.hit === 1,
      'C03/L 已确认收到之后不再重复注入（同一条只出现一次）', JSON.stringify(hits));

    const st = await gcState();
    const suppMsg = ((st && st.messages) || []).find((m) => m && m.supplement);
    ok(!!suppMsg && suppMsg.content === LONG_SUPPLEMENT,
      'C05/L 多行 / 中文 / 路径 / emoji / 长文本原样保存，没有被截断或拆开',
      suppMsg ? String((suppMsg.content || '').length) : 'missing');
  } catch (error) {
    ok(false, 'L 层脚本执行中断', (error && error.message) || String(error));
  } finally {
    if (promptPoller) clearInterval(promptPoller);
    try { if (cdp) await cdp.close(); } catch (e) {}
    try { await gracefulQuit(hub, { allowAlreadyExited: true }); } catch (e) {
      console.warn('[L] 关闭隔离 Hub 时报错：', e && e.message);
    }
  }

  const passed = results.filter((r) => r.pass === true).length;
  const skipped = results.filter((r) => r.pass === null).length;
  console.log('\n────────────────────────────────');
  console.log(`L 层（stage=${STAGE}）：通过 ${passed} / 未通过 ${failed} / 跳过 ${skipped}`);
  console.log(`fixture=${FIXTURE}\n证据=${EVIDENCE}\n数据目录=${DATA_DIR}`);
  if (failed) {
    console.log('未通过：');
    for (const r of results.filter((x) => x.pass === false)) console.log('  - ' + r.name + (r.detail ? '  → ' + r.detail : ''));
  }
  saveEvidence('summary.json', { stage: STAGE, passed, failed, skipped, results });
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error('[L] 致命错误：', error);
  process.exit(2);
});
