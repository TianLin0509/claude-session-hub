'use strict';
// AI 编排模式 · 真实模型实测（隔离 Hub，真实 CLI，真实 UI 点击）。
//   node tests/e2e-orchestration-live.js main     完整流程：计划→确认→组队→开发交付（可能返工）→结项；中途打断成员并手动救回、重启 Hub 后恢复
//   node tests/e2e-orchestration-live.js budget   额度：迭代上限 2 轮 → Hub 暂停 → 编排员汇报 → 点「再给 3 轮」→ 继续到结项
// 编排员默认 Claude Opus 5.5（ORCH_KIND/ORCH_MODEL/ORCH_EFFORT 可改）；成员由编排员按田哥的话选低档模型。
// 凭据复制到临时目录，结束时删除。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { execFileSync } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher'), { connectFirstPage } = require('./helpers/cdp-client');

const SCENARIO = process.argv[2] || 'main';
const ORCH = { kind: process.env.ORCH_KIND || 'claude', model: process.env.ORCH_MODEL || 'claude-opus-5-5', effort: process.env.ORCH_EFFORT || 'high' };
const MEMBER_HINT = process.env.MEMBER_HINT || '成员用低档模型省额度：Codex 成员用 gpt-6-luna、low 思考；Claude 成员用 claude-haiku-4-5-20251001。';
const MAX_MIN = Number(process.env.MAX_MIN || (SCENARIO === 'budget' ? 60 : 100));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), `hub-orch-live-${SCENARIO}-`)), DATA = path.join(ROOT, 'data');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const ART = path.resolve(__dirname, '..', 'artifacts', 'orchestration-live', `${SCENARIO}-${STAMP}`);
fs.mkdirSync(ART, { recursive: true });
const secrets = [], delay = ms => new Promise(r => setTimeout(r, ms));
const report = { scenario: SCENARIO, realModel: true, orchestrator: ORCH, root: ROOT, startedAt: new Date().toISOString(), timeline: [], problems: [], ui: [] };
const t0 = Date.now();
const log = (event, extra = {}) => { const row = { min: +((Date.now() - t0) / 60000).toFixed(1), event, ...extra }; report.timeline.push(row); console.log(`[${row.min}m] ${event}${Object.keys(extra).length ? ' ' + JSON.stringify(extra).slice(0, 300) : ''}`); };

function profiles() {
  const env = { CLAUDE_HUB_AGENT_RUNTIME: 'pty', CLAUDE_HUB_HOME_DIR: path.join(ROOT, 'home'), AI_HUB_WORKSPACE_ROOT: ROOT, DEEPSEEK_API_KEY: '' };
  for (const [key, source, names] of [['CODEX_HOME', '.codex', ['auth.json', 'config.toml', 'models_cache.json']], ['CLAUDE_CONFIG_DIR', '.claude', ['.credentials.json', 'settings.json']]]) {
    const dest = path.join(ROOT, source.slice(1)); fs.mkdirSync(dest, { recursive: true }); env[key] = dest;
    for (const name of names) { const original = path.join(os.homedir(), source, name), target = path.join(dest, name); if (fs.existsSync(original)) { fs.copyFileSync(original, target); secrets.push(target); } }
  }
  const state = path.join(os.homedir(), '.claude.json'); if (fs.existsSync(state)) { const dest = path.join(env.CLAUDE_CONFIG_DIR, '.claude.json'); fs.copyFileSync(state, dest); secrets.push(dest); }
  const settings = path.join(env.CLAUDE_CONFIG_DIR, 'settings.json');
  if (fs.existsSync(settings)) {
    const s = JSON.parse(fs.readFileSync(settings, 'utf8')), hooks = {};
    for (const [event, groups] of Object.entries(s.hooks || {})) {
      const kept = (groups || []).map(g => ({ ...g, hooks: (g.hooks || []).filter(h => /session-hub-hook/.test(h.command || '')) })).filter(g => g.hooks.length);
      if (kept.length) hooks[event] = kept;
    }
    s.hooks = hooks; delete s.enabledPlugins; delete s.statusLine; fs.writeFileSync(settings, JSON.stringify(s), 'utf8');
  }
  return env;
}
const port = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

function makeRepo() {
  const repo = path.join(ROOT, 'pf-sim');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'scheduler.js'), `'use strict';
// 简化的下行调度仿真：每个 TTI 选一个用户发送，用户在该 TTI 的可达速率由 rateOf(user, tti) 给出。
function roundRobin(users, tti) { return tti % users.length; }
function simulate(users, ttis, pick) {
  const served = users.map(() => 0);
  for (let tti = 0; tti < ttis; tti += 1) {
    const i = pick(users, tti, served);
    served[i] += users[i].rateOf(tti);
  }
  return served;
}
module.exports = { roundRobin, simulate };
`);
  fs.writeFileSync(path.join(repo, 'test.js'), `'use strict';
const assert = require('node:assert/strict');
const { roundRobin, simulate } = require('./scheduler');
const users = [{ rateOf: () => 1 }, { rateOf: () => 3 }];
assert.equal(roundRobin(users, 0), 0);
assert.equal(roundRobin(users, 1), 1);
assert.deepEqual(simulate(users, 4, roundRobin), [2, 6]);
console.log('ok');
`);
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'pf-sim', private: true, scripts: { test: 'node test.js' } }, null, 2));
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# pf-sim\n隔离测试用的小仿真项目。测试：`npm test`。不联网，不合并、不推送。\n');
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore', windowsHide: true });
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'orch-live');
  git('add', '-A'); git('commit', '-q', '-m', 'init');
  return repo;
}

const TASKS = {
  main: repo => `在 ${repo} 这个小仿真项目里加一个比例公平（PF）调度器：每个 TTI 选「当前速率 / 历史平均吞吐」最大的用户，历史平均用指数平滑（系数可配）。补单测（含零历史吞吐、单用户两种边界），再写一个对比脚本，跑 RR 和 PF 的总吞吐与 Jain 公平指数（至少 3 个场景），结果写进 REPORT.md。${MEMBER_HINT}审核通过后合并到本仓库主干（没有远端，不用推送）。`,
  budget: () => `调研 ${path.resolve(__dirname, '..', 'core', 'group-answer-files.js')} 里群聊回答文件的读写机制，找出 3 个可能让群聊卡片显示错误或不更新的场景，每个附代码位置与触发条件。用资料调研模板，两位成员即可。${MEMBER_HINT}`,
};

(async () => {
  let hub, cdp;
  const env = profiles();
  const repo = makeRepo();
  report.repo = repo;
  const invoke = (ch, args = {}) => cdp.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(ch)},${JSON.stringify(args)})`);
  const shot = async name => { try { const r = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(ART, name + '.png'), Buffer.from(r.data, 'base64')); } catch (e) { report.problems.push('screenshot ' + name + ': ' + e.message); } };
  const wait = async (label, pred, ms = 60000, step = 1000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const r = await pred(); if (r) return r; } catch {} await delay(step); } throw Error('Timeout: ' + label); };
  const click = async selector => {
    const p = await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}); if(!e) return null; e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); const x=r.x+r.width/2,y=r.y+r.height/2; if(!r.width||!r.height||!e.contains(document.elementFromPoint(x,y))) return null; return {x,y};})()`);
    if (!p) return false;
    for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
    return true;
  };
  const send = async text => {
    const p = await cdp.eval("(()=>{const r=document.querySelector('#mr-input-box').getBoundingClientRect();return {x:r.x+30,y:r.y+20};})()");
    for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
    await cdp.send('Input.insertText', { text });
    for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  };
  async function launch(label) {
    hub = await launchIsolatedHub({ dataDir: DATA, port: await port(), windowMode: 'hidden', label, extraEnv: env });
    cdp = await connectFirstPage(hub);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
    await wait('renderer', () => cdp.eval('!!window.MeetingRoom && typeof selectMeeting === "function"'), 90000);
  }
  let meetingId = '';
  const ledgerFile = () => path.join(DATA, 'task-docs', meetingId, 'orchestration', 'ledger.json');
  const readLedger = () => { try { return JSON.parse(fs.readFileSync(ledgerFile(), 'utf8')); } catch { return null; } };
  const runFile = () => path.join(DATA, 'task-docs', meetingId, 'deliveries', 'run.json');
  const readRun = () => { try { return JSON.parse(fs.readFileSync(runFile(), 'utf8')); } catch { return null; } };
  const openRoom = async () => { await cdp.eval(`selectMeeting(${JSON.stringify(meetingId)})`); await wait('strip', () => cdp.eval("!!document.querySelector('.mr-orch-strip')"), 60000); };
  try {
    await launch('orch-live');
    report.pid = hub.pid;
    const room = await invoke('create-meeting', { mode: 'general', scene: 'general', groupChat: true, title: `编排实测 · ${SCENARIO}`, workspace: repo,
      slots: [{ index: 0, kind: ORCH.kind, model: ORCH.model, effort: ORCH.effort, mcpProfile: 'lean' }], participants: [0],
      orchestration: { enabled: true, settings: { requireConfirm: true, roundCap: SCENARIO === 'budget' ? 2 : 8, timeCapMin: 180 } } });
    meetingId = room.id;
    report.meetingId = meetingId;
    log('room created', { orchestration: room.orchestration });
    await openRoom();
    await shot('00-room');
    await send(TASKS[SCENARIO](repo));
    log('task sent');

    const deadline = Date.now() + MAX_MIN * 60000;
    let lastKey = '', confirms = 0, grants = 0, decisions = 0, interrupted = null, restarted = false, rescued = false;
    while (Date.now() < deadline) {
      const ledger = readLedger();
      const run = readRun();
      if (!ledger) { await delay(3000); continue; }
      const seg = ledger.segments.at(-1);
      const key = JSON.stringify([ledger.status, ledger.halt?.reason, ledger.plan?.version, ledger.segments.map(s => [s.status, s.rounds]), ledger.budget.roundsUsed]);
      if (key !== lastKey) {
        lastKey = key;
        log('ledger', { status: ledger.status, halt: ledger.halt?.reason || null, plan: ledger.plan?.version || 0, rounds: `${ledger.budget.roundsUsed}/${ledger.budget.roundCap}`, segments: ledger.segments.map(s => `${s.name}:${s.status}:${s.rounds}`), roles: ledger.roles });
        await shot(`ledger-${report.timeline.length}-${ledger.status}`);
      }
      if (ledger.status === 'awaiting_confirm' && ledger.plan && ledger.plan.confirmedVersion !== ledger.plan.version && confirms < 3) {
        await delay(4000);   // 让编排员把计划讲完
        if (await click('.mr-orch-strip [data-orch-action="confirm"]')) { confirms += 1; report.ui.push('点击「确认计划」v' + ledger.plan.version); log('clicked confirm', { version: ledger.plan.version }); }
      } else if (ledger.status === 'halted' && /^budget_/.test(ledger.halt?.reason || '') && grants < 2) {
        await delay(ledger.halt.reported ? 3000 : 60000);   // 先给编排员时间写汇报
        const l2 = readLedger();
        report.haltReport = { reason: l2.halt?.reason, reported: !!l2.halt?.reported, lastReport: l2.reports.at(-1) || null };
        await shot('halt-budget');
        if (await click('.mr-orch-strip [data-orch-action="grant-rounds"]')) { grants += 1; report.ui.push('点击「再给 3 轮」'); log('clicked grant', { reported: !!l2.halt?.reported }); }
      } else if (ledger.status === 'halted' && decisions < 3) {
        await delay(20000);
        decisions += 1;
        await shot(`halt-${ledger.halt?.reason}`);
        await send('按你的建议继续。');
        report.ui.push(`在输入框回复「按你的建议继续」（${ledger.halt?.reason}）`);
        log('answered decision', { reason: ledger.halt?.reason });
        await delay(8000);
      } else if (ledger.status === 'finished') { log('finished'); break; }

      // 场景：打断正在实现的成员 → 点卡片「重新发送」救回
      if (SCENARIO === 'main' && !interrupted && run && run.status === 'running') {
        const step = run.steps?.at(-1);
        const stage = run.stages?.[step?.index];
        if (step && stage?.name === '实现与自测' && !step.deliveries?.[step.members[0]] && Date.now() - step.createdAt > 90000) {
          const m = (await invoke('get-meetings')).find(x => x.id === meetingId);
          const index = m.slotSpecs.findIndex(s => s.memberId === step.members[0]);
          const sid = m.subSessions[index];
          await cdp.eval(`require('electron').ipcRenderer.send('terminal-input',{sessionId:${JSON.stringify(sid)},data:'\\u001b'})`);
          interrupted = { memberId: step.members[0], sid, stepId: step.id, at: Date.now() };
          log('interrupted member (ESC)', { memberId: step.members[0] });
          await delay(25000);
          await shot('interrupted');
        }
      }
      if (interrupted && !rescued && Date.now() - interrupted.at > 30000) {
        const r2 = readRun();
        const st = r2?.steps?.find(s => s.id === interrupted.stepId);
        if (st && st.deliveries?.[interrupted.memberId]) { rescued = true; report.rescue = { note: '打断前后成员仍交付了，未用到救回入口' }; log('member delivered despite interrupt'); }
        else {
          const ok = await click(`[data-gc-resend-member="${interrupted.sid}"]`);
          if (ok) { rescued = true; report.rescue = { via: '卡片「重新发送」', at: Date.now() }; report.ui.push('点击成员卡片「重新发送」'); log('clicked resend on member card'); }
          else if (Date.now() - interrupted.at > 120000) { const r = await invoke('delivery:continue', { meetingId }); rescued = true; report.rescue = { via: 'delivery:continue（卡片按钮未找到）', result: r }; report.problems.push('卡片上没找到「重新发送」按钮，改用提醒未交付成员'); log('rescued via delivery:continue'); }
        }
      }
      // 场景：救回之后、工作流还在跑时重启 Hub
      if (SCENARIO === 'main' && rescued && !restarted && run && run.status === 'running' && Date.now() - (report.rescue.at || 0) > 120000) {
        restarted = true;
        log('restarting Hub');
        await shot('before-restart');
        try { await cdp.close(); } catch {}
        await gracefulQuit(hub);
        await delay(3000);
        await launch('orch-live-restart');
        await openRoom();
        await shot('after-restart');
        log('Hub restarted', { pid: hub.pid });
      }
      await delay(5000);
    }
    if (Date.now() >= deadline) report.problems.push(`超过 ${MAX_MIN} 分钟仍未结项`);
    await shot('99-final');
  } catch (error) {
    report.problems.push('fatal: ' + error.stack);
    console.error(error);
    if (cdp) await shot('fatal');
  } finally {
    try {
      const ledger = readLedger();
      report.ledger = ledger && { status: ledger.status, halt: ledger.halt, budget: ledger.budget, plan: ledger.plan, roles: ledger.roles, segments: ledger.segments, asks: ledger.asks, reports: ledger.reports, events: ledger.events, pendingNotices: ledger.notices };
      if (meetingId) {
        const answers = path.join(DATA, 'task-docs', meetingId, 'answers');
        const orchAnswers = [];
        if (fs.existsSync(answers)) for (const turn of fs.readdirSync(answers)) {
          const file = path.join(answers, turn, 'm1', '回答.md');
          if (fs.existsSync(file)) orchAnswers.push({ turn, text: fs.readFileSync(file, 'utf8') });
        }
        report.orchestratorAnswers = orchAnswers.sort((a, b) => Number(a.turn.split('-')[1]) - Number(b.turn.split('-')[1]));
        const ledgerMd = path.join(DATA, 'task-docs', meetingId, 'orchestration', 'ledger.md');
        if (fs.existsSync(ledgerMd)) fs.copyFileSync(ledgerMd, path.join(ART, 'ledger.md'));
        const deliveries = path.join(DATA, 'task-docs', meetingId, 'deliveries');
        if (fs.existsSync(deliveries)) fs.cpSync(deliveries, path.join(ART, 'deliveries'), { recursive: true });
        if (cdp) { try { const m = (await invoke('get-meetings')).find(x => x.id === meetingId); report.members = m.slotSpecs; } catch {} }
      }
      try { report.repoLog = execFileSync('git', ['log', '--oneline', '--all', '-n', '15'], { cwd: repo, encoding: 'utf8', windowsHide: true }); report.repoBranches = execFileSync('git', ['worktree', 'list'], { cwd: repo, encoding: 'utf8', windowsHide: true }); } catch {}
    } catch (e) { report.problems.push('collect: ' + e.message); }
    if (hub) { try { fs.writeFileSync(path.join(ART, 'hub.log'), hub.log().join('\n')); } catch {} }
    if (cdp) { try { await cdp.close(); } catch {} }
    if (hub) { try { await gracefulQuit(hub); } catch (e) { report.problems.push('quit: ' + e.message); } }
    for (const file of secrets) { try { fs.rmSync(file, { force: true }); } catch {} }
    report.secretsRemoved = secrets.every(f => !fs.existsSync(f));
    report.minutes = +((Date.now() - t0) / 60000).toFixed(1);
    fs.writeFileSync(path.join(ART, 'report.json'), JSON.stringify(report, null, 2));
    console.log('ARTIFACT ' + ART);
  }
})();
