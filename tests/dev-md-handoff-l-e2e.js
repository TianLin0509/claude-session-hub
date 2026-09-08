'use strict';
/**
 * L 层 · 隔离真实 Hub + 真实 Agent CLI（任务书 §10.1 的 L 层）
 * ────────────────────────────────────────────────────────────────────────────
 *
 * 这一层没有任何桩：真 Electron Hub、真 Codex / Claude CLI 进程、真 PTY 提交闭环、
 * 真的由 agent 自己写 MD 并改名、真的由 Hub 读文件判定交付。
 * 代码改动落在一个**临时 fixture git 仓库**里（自带本地 bare remote），
 * 绝不写真实 Hub 仓库、master 或 origin。
 *
 * 阶段（--stage）：
 *   kickoff（默认）—— 建房 → 开题 → 真实 agent 写 开题报告.md 并改名 →
 *                      Hub 接收 → 自动进入实现；期间插一句带唯一标识的话，
 *                      验证它真的被提交进了正在运行的那个 CLI。
 *   full           —— 在 kickoff 之上继续跑到实现位交协作手册、合并位交合并手册并给裁决。
 *
 * 真实模型要花真实时间，也可能因为额度 / 登录 / 网络失败。**失败就如实报告**，
 * 不降级成桩、不把「没跑到」写成通过。
 *
 * 用法：
 *   node tests/dev-md-handoff-l-e2e.js                 # kickoff 阶段
 *   node tests/dev-md-handoff-l-e2e.js --stage=full    # 完整一轮
 *   node tests/dev-md-handoff-l-e2e.js --budget=900    # 单阶段秒数预算
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
const U12 = `U12-${RUN_ID}`;

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

const AUTHOR_MD = [
  '# 工作位合同（fixture 版）',
  '',
  '这是一个用来验证流程的**临时测试仓库**，任务都很小。',
  '',
  '- 在本仓库直接改即可，不需要建 worktree。',
  '- 改完跑 `node test.js`，它必须输出 `OK`。',
  '- 提交信息写人话；不要推送到任何远端，除非任务里明说。',
  '- 交付时在群里输出 PROGRESS / VERIFIED / RISK / REPORT 四行，然后写一段 NOTES。',
].join('\n');

const MERGER_MD = [
  '# 合并位合同（fixture 版）',
  '',
  '这是一个临时测试仓库。你要独立验证工作位的改动。',
  '',
  '- 亲自跑 `node test.js`，看真实输出，不采信工作位的自述。',
  '- 最后严格输出四行：RESULT: PASS 或 FAIL / BLOCKERS / VERIFIED / NEXT。',
].join('\n');

function buildFixture() {
  fs.mkdirSync(FIXTURE, { recursive: true });
  fs.mkdirSync(path.join(FIXTURE, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(FIXTURE, '.agents', 'AUTHOR.md'), AUTHOR_MD, 'utf8');
  fs.writeFileSync(path.join(FIXTURE, '.agents', 'MERGER.md'), MERGER_MD, 'utf8');
  fs.writeFileSync(path.join(FIXTURE, '.agents', 'project.json'),
    JSON.stringify({ name: 'md-handoff-fixture', versionFiles: [], versionBump: null }, null, 2), 'utf8');
  fs.writeFileSync(path.join(FIXTURE, 'greet.js'),
    "'use strict';\nfunction greet(name) { return 'hello ' + name; }\nmodule.exports = { greet };\n", 'utf8');
  fs.writeFileSync(path.join(FIXTURE, 'test.js'),
    "'use strict';\nconst { greet } = require('./greet.js');\nif (greet('x') !== 'hello x') { console.log('BROKEN'); process.exit(1); }\nconsole.log('OK');\n", 'utf8');
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
  return git(FIXTURE, 'rev-parse', 'HEAD').trim();
}

async function main() {
  fs.mkdirSync(ROOT, { recursive: true });
  const baseSha = buildFixture();
  console.log(`[L] fixture=${FIXTURE} baseSha=${baseSha.slice(0, 10)} stage=${STAGE} budget=${BUDGET_MS / 1000}s`);

  let hub = await launchIsolatedHub({
    dataDir: DATA_DIR, port: await freePort(), label: 'md-handoff-l', windowMode: 'hidden',
  });
  console.log(`[L] 隔离 Hub PID=${hub.child.pid} DATA=${DATA_DIR}`);
  let cdp = null;
  let meetingId = null;

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

    // ── 建房：真实两席位（Codex 工作位 + Claude 合并位），工作目录就是 fixture ──
    const created = await invoke('create-meeting', {
      mode: 'dev', title: `L 层 ${RUN_ID}`, groupChat: true, workspace: FIXTURE,
      slots: [
        { index: 0, kind: 'codex', memberId: 'm1' },
        { index: 1, kind: 'claude', memberId: 'm2' },
      ],
    });
    meetingId = created && created.id;
    ok(!!meetingId && (created.subSessions || []).length === 2,
      'L 建出开发群聊并拉起两个真实 CLI 会话',
      JSON.stringify({ subs: created && (created.subSessions || []).length }));
    if (!meetingId || (created.subSessions || []).length < 2) throw new Error('真实席位没起来，后面的 L 用例无法进行');

    const config = await cdp.eval(`JSON.stringify(window.WorkflowTemplates.createTemplateConfig('dev-task',
      [{memberId:'m1',kind:'codex'},{memberId:'m2',kind:'claude'}], {}))`);
    await invoke('update-meeting-sync', { meetingId, fields: { scene: 'dev', serialWorkflow: JSON.parse(config) } });
    ok((await wf()).devPhase === 'discuss', 'L 新房间落在讨论阶段');

    // 需求：一句话就够，重点是验证流程而不是难度
    await invoke('meeting-append-user-turn', { meetingId, text: '把 greet 改成支持第二个参数 greeting，默认还是 hello，并补一条测试。' });
    await invoke('groupchat:user-supplement', { meetingId, text: '需求：把 greet 改成支持第二个参数 greeting，默认还是 hello，并补一条测试。' });

    // ── A02/L 只指定一位执笔者 ──
    const started = await invoke('dev:kickoff', { meetingId, authorMemberId: 'm1' });
    ok(started && started.ok, 'A02/L 开题已派给指定执笔者', JSON.stringify(started));

    // ── C01/L 运行中插一句带唯一标识的话，看它是不是真的进了正在跑的那个 CLI ──
    await sleep(20000);
    const supp = await invoke('groupchat:user-supplement', { meetingId, text: `顺便记一下这个标识：${U12}` });
    ok(supp && supp.ok === true, 'C01/L 运行中插话被接受', JSON.stringify(supp && supp.reason));
    ok(supp && (supp.deliveredNow || []).length >= 1,
      'C01/L 插话真的提交进了正在运行的那位（闭环提交，不是盲发回车）',
      JSON.stringify({ deliveredNow: supp && supp.deliveredNow, pending: supp && supp.pendingSids }));

    // ── 等真实 agent 写出并改名开题报告 ──
    const kickoffDeadline = Date.now() + BUDGET_MS;
    let accepted = false;
    while (Date.now() < kickoffDeadline) {
      if (fs.existsSync(path.join(taskDir(), doneName(0)))) { accepted = true; break; }
      await sleep(5000);
    }
    ok(accepted, 'A02/L 真实 agent 自己写出并改名了「已完成-开题报告.md」',
      accepted ? '' : `超时 ${BUDGET_MS / 1000}s；任务目录 ${taskDir()}`);

    if (accepted) {
      const body = fs.readFileSync(path.join(taskDir(), doneName(0)), 'utf8');
      ok(/目标/.test(body) && /非目标/.test(body) && /验收/.test(body) && /(风险|回退)/.test(body),
        'A02/L 开题报告含四项', body.slice(0, 120).replace(/\s+/g, ' '));
      // Hub 侧接收 + 自动开工
      const acceptDeadline = Date.now() + 120000;
      let phase = '';
      while (Date.now() < acceptDeadline) {
        phase = (await wf()).devPhase;
        if (phase === 'build') break;
        await sleep(3000);
      }
      ok(phase === 'build', 'B02/L Hub 接收交付后自动进入实现，不要第二次确认', phase);
      const ledger = (await wf()).taskDocs || {};
      ok(!!(ledger.accepted && ledger.accepted['0']), 'B02/L 接收凭据已落盘');
    }

    if (STAGE !== 'full') {
      skip('B09/L 完整实现→审查→fixture 合并', '本次只跑 kickoff 阶段（--stage=full 跑完整一轮）');
      skip('B10/L 已知缺陷被真实审查判 FAIL 后修复', '同上');
      skip('C05/L 多行/中文/路径/emoji 长补充在两种 CLI 上的原文完整性', '同上');
    } else {
      const buildDeadline = Date.now() + BUDGET_MS * 2;
      let gotBuild = false; let gotReview = false;
      while (Date.now() < buildDeadline) {
        if (!gotBuild && fs.existsSync(path.join(taskDir(), doneName(1)))) gotBuild = true;
        if (fs.existsSync(path.join(taskDir(), doneName(2)))) { gotReview = true; break; }
        await sleep(6000);
      }
      ok(gotBuild, 'B09/L 实现位真的交出了「已完成-阶段1协作手册.md」');
      ok(gotReview, 'B09/L 合并位真的交出了「已完成-阶段1合并手册.md」');
      if (gotReview) {
        const review = fs.readFileSync(path.join(taskDir(), doneName(2)), 'utf8');
        ok(/(^|\n)\s*RESULT\s*[:：]\s*(PASS|FAIL)/i.test(review), 'B09/L 合并手册里有单独成行的裁决');
      }
      const headNow = git(FIXTURE, 'rev-parse', 'HEAD').trim();
      ok(headNow !== baseSha || gotBuild, 'B09/L fixture 仓库里出现了真实改动', `${baseSha.slice(0, 8)} → ${headNow.slice(0, 8)}`);
    }

    // ── C01/L 插话原文是否真的到了 agent 那边：查该会话的转录 ──
    const transcriptHit = await cdp.eval(`(async () => {
      const { ipcRenderer } = require('electron');
      const all = await ipcRenderer.invoke('groupchat:get-state', { meetingId: ${JSON.stringify(meetingId)} });
      const msgs = (all && all.messages) || [];
      return msgs.some(m => m && m.supplement && String(m.content || '').includes(${JSON.stringify(U12)}));
    })()`);
    ok(transcriptHit === true, 'C01/L 插话原文完整留在群聊记录里');
  } catch (error) {
    ok(false, 'L 层脚本执行中断', (error && error.message) || String(error));
  } finally {
    try { if (cdp) await cdp.close(); } catch (e) {}
    try { await gracefulQuit(hub, { allowAlreadyExited: true }); } catch (e) {
      console.warn('[L] 关闭隔离 Hub 时报错：', e && e.message);
    }
  }

  const passed = results.filter((r) => r.pass === true).length;
  const skipped = results.filter((r) => r.pass === null).length;
  console.log('\n────────────────────────────────');
  console.log(`L 层：通过 ${passed} / 未通过 ${failed} / 跳过 ${skipped}`);
  console.log(`fixture=${FIXTURE}  数据目录=${DATA_DIR}`);
  if (failed) {
    console.log('未通过：');
    for (const r of results.filter((x) => x.pass === false)) console.log('  - ' + r.name + (r.detail ? '  → ' + r.detail : ''));
  }
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error('[L] 致命错误：', error);
  process.exit(2);
});
