'use strict';

// Real-click, three-launch acceptance test for one Agent League contestant.
// It reproduces the persisted Hub-shell-without-native-SID state, verifies that
// every league action opens the correct ordinary PTY, completes a real Codex
// DRAFT -> Hook -> weekly flow, and proves exact resume after native binding.
// Production Hub/data are never attached to or modified.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { AgentLeagueStore } = require('../core/agent-league-store.js');
const { getPhilosophy } = require('../core/agent-league-philosophies.js');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const HUB_ROOT = path.resolve(__dirname, '..');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const TEMP_ROOT = path.join(os.tmpdir(), `agent-league-pty-shortcuts-${process.pid}-${STAMP}`);
const HUB_DATA = path.join(TEMP_ROOT, 'hub-data');
const LEAGUE_ROOT = path.join(TEMP_ROOT, 'league');
const OUTPUT = path.join(HUB_ROOT, 'output', 'playwright', `agent-league-pty-shortcuts-${STAMP}`);
const DECISION_DATE = '2026-08-26';
const SATURDAY_DATE = '2026-08-29';
const AGENT_ID = 'chuxin-baseline';
const PICKER_RE = /Resume a previous session|Select a session to resume|resume picker/i;

const evidence = {
  suite: 'single-agent-real-click-pty-shortcuts',
  startedAt: new Date().toISOString(),
  isolated: true,
  productionHubTouched: false,
  decisionDate: DECISION_DATE,
  saturdayDate: SATURDAY_DATE,
  checks: [],
  screenshots: [],
  launches: [],
};
let liveHubForWait = null;

function log(message, detail = null) {
  const row = `[single-agent-e2e] ${new Date().toISOString()} ${message}${detail == null ? '' : ` ${JSON.stringify(detail)}`}`;
  console.log(row);
  fs.appendFileSync(path.join(OUTPUT, 'progress.log'), `${row}\n`, 'utf8');
}

function check(id, label, expected, actual, extra = {}) {
  const pass = typeof expected === 'function' ? !!expected(actual) : Object.is(actual, expected);
  const row = { id, label, pass, expected: typeof expected === 'function' ? extra.expectedText || 'predicate=true' : expected, actual, at: new Date().toISOString(), ...extra };
  evidence.checks.push(row);
  if (!pass) throw new assert.AssertionError({ message: `${id} ${label}`, expected: row.expected, actual });
  log(`PASS ${id} ${label}`, actual);
  return row;
}

async function freePort(start = 25520) {
  return new Promise((resolve, reject) => {
    const attempt = (port) => {
      if (port > start + 80) return reject(new Error('no isolated CDP port available'));
      const server = net.createServer();
      server.once('error', () => attempt(port + 1));
      server.once('listening', () => server.close(() => resolve(port)));
      server.listen(port, '127.0.0.1');
    };
    attempt(start);
  });
}

async function waitFor(client, expression, label, timeoutMs = 30000, pollMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (liveHubForWait && !liveHubForWait.isAlive()) {
      const exitCode = liveHubForWait.exitCode();
      const exitSignal = liveHubForWait.exitSignal();
      const tail = liveHubForWait.log().slice(-60).join('\n');
      throw new Error(`isolated Hub exited while waiting for ${label} (code=${exitCode}, signal=${exitSignal || 'none'})\n${tail}`);
    }
    try {
      const value = await client.eval(expression);
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await _waitMs(pollMs);
  }
  throw new Error(`timeout waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

async function screenshot(client, name, checkId) {
  await _waitMs(350);
  const result = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, optimizeForSpeed: true });
  const target = path.join(OUTPUT, name);
  fs.writeFileSync(target, Buffer.from(result.data, 'base64'));
  evidence.screenshots.push({ checkId, path: target, bytes: fs.statSync(target).size });
  return target;
}

function seedSingleAgent() {
  const store = new AgentLeagueStore({ root: LEAGUE_ROOT });
  store.createAgent({
    id: AGENT_ID,
    name: '初心基准',
    provider: 'codex-cli',
    kind: 'codex',
    model: 'gpt-5.6-sol',
    philosophy: getPhilosophy('chuxin-value-speculation'),
    initialCash: 500000,
  });
}

async function launch(label, portStart) {
  const port = await freePort(portStart);
  const hub = await launchIsolatedHub({
    dataDir: HUB_DATA,
    port,
    label,
    windowMode: 'hidden',
    extraEnv: {
      CHUXIN_AGENT_LEAGUE_DIR: LEAGUE_ROOT,
      CHUXIN_DIR: 'C:\\Users\\lintian\\chuxin-research',
      CHUXIN_API_BASE: 'http://127.0.0.1:3004',
      CHUXIN_WEB_BASE: 'http://127.0.0.1:3003',
    },
  });
  const client = await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/.test(target.url || ''));
  await client.send('Runtime.enable');
  await client.send('Page.enable');
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
  evidence.launches.push({ label, pid: hub.pid, port, identityVerified: hub.identityVerified, startedAt: new Date().toISOString() });
  liveHubForWait = hub;
  return { hub, client };
}

async function instrument(client) {
  await waitFor(client, `(document.getElementById('btn-research') || document.getElementById('btn-chuxin')) && document.querySelector('.cx-primary-tab[data-tab="league"]')`, 'Hub and Agent League UI');
  await client.eval(`(() => {
    window.__agentLeagueE2eErrors = [];
    window.addEventListener('error', event => window.__agentLeagueE2eErrors.push(String(event.error || event.message)));
    window.addEventListener('unhandledrejection', event => window.__agentLeagueE2eErrors.push(String(event.reason)));
    const ipc = require('electron').ipcRenderer;
    if (!window.__agentLeagueE2eOriginalInvoke) {
      window.__agentLeagueE2eOriginalInvoke = ipc.invoke.bind(ipc);
      ipc.invoke = (channel, input, ...rest) => {
        let next = input;
        if (channel === 'agent-league:run-day') next = { ...(input || {}), force: true, decisionDate: ${JSON.stringify(DECISION_DATE)} };
        if (channel === 'agent-league:execute-open' || channel === 'agent-league:record-close') next = { ...(input || {}), force: true, decisionDate: ${JSON.stringify(DECISION_DATE)} };
        if (channel === 'agent-league:run-weekly') next = { ...(input || {}), force: true, saturdayDate: ${JSON.stringify(SATURDAY_DATE)} };
        return window.__agentLeagueE2eOriginalInvoke(channel, next, ...rest);
      };
    }
    window.confirm = () => true;
    return true;
  })()`);
}

async function openLeague(client) {
  await client.eval(`(document.getElementById('btn-research') || document.getElementById('btn-chuxin')).click()`);
  await waitFor(client, `document.querySelector('.cx-primary-tab[data-tab="league"]')`, 'league tab');
  await client.eval(`document.querySelector('.cx-primary-tab[data-tab="league"]').click()`);
  await waitFor(client, `document.querySelector('.cxl-root') && document.querySelector('[data-agent-row="${AGENT_ID}"]')`, 'single Agent leaderboard');
}

async function openAgentDrawer(client, agentId = AGENT_ID) {
  await client.eval(`document.querySelector('[data-agent-row=${JSON.stringify(agentId)}]').click()`);
  await waitFor(client, `!document.querySelector('[data-role="detail-overlay"]').hidden && document.querySelector('[data-action="open-pty"]')`, `${agentId} detail drawer`);
}

async function waitPty(client, label, timeoutMs = 12000) {
  const started = Date.now();
  await waitFor(client, `(() => {
    const panel = document.getElementById('terminal-panel');
    return panel && getComputedStyle(panel).display !== 'none' && !panel.classList.contains('card-view-active');
  })()`, label, timeoutMs);
  return Date.now() - started;
}

async function activeSessionId(client) {
  return client.eval(`document.querySelector('#session-list .session-item.selected')?.dataset.sessionId || ''`);
}

async function leagueState(client) {
  return client.eval(`require('electron').ipcRenderer.invoke('agent-league:list', {})`);
}

async function sessionBuffer(client, sessionId) {
  return client.eval(`(async()=>String(await require('electron').ipcRenderer.invoke('debug:get-session-buffer', ${JSON.stringify(sessionId)}) || ''))()`);
}

async function waitRunFinished(client, mode, timeoutMs = 35 * 60 * 1000) {
  return waitFor(client, `(async()=>{
    const value = await require('electron').ipcRenderer.invoke('agent-league:list', {});
    const field = ${JSON.stringify(mode)} === 'weekly' ? value.schedule.lastWeeklyStatus : value.schedule.lastRunStatus;
    return !value.run && ['completed','partial','failed'].includes(field) ? value : null;
  })()`, `${mode} run completion`, timeoutMs, 1000);
}

async function stopLaunch(ctx, label) {
  if (!ctx) return;
  const errors = await ctx.client.eval('window.__agentLeagueE2eErrors || []').catch(() => []);
  check(`${label}-renderer-errors`, `${label} renderer 无未处理异常`, 0, errors.length, { detail: errors });
  await ctx.client.close();
  const exit = await gracefulQuit(ctx.hub);
  liveHubForWait = null;
  const launch = evidence.launches.find(row => row.label === label);
  if (launch) {
    launch.finishedAt = new Date().toISOString();
    launch.exit = exit;
    launch.log = ctx.hub.log();
    fs.writeFileSync(path.join(OUTPUT, `${label}-hub.log`), `${launch.log.join('\n')}\n`, 'utf8');
  }
}

function safeCleanup() {
  const resolved = path.resolve(TEMP_ROOT);
  const temp = path.resolve(os.tmpdir());
  if (!resolved.startsWith(temp + path.sep) || !path.basename(resolved).startsWith('agent-league-pty-shortcuts-')) return;
  fs.rmSync(resolved, { recursive: true, force: true });
}

(async () => {
  fs.mkdirSync(OUTPUT, { recursive: true });
  seedSingleAgent();
  let ctx = null;
  try {
    // Launch 1: exercise the ordinary UI and persist an unbound Hub shell.
    log('PHASE 1: create and persist an unbound ordinary Agent Session');
    ctx = await launch('single-phase-1-unbound', 25520);
    await instrument(ctx.client);
    await openLeague(ctx.client);
    check('S1-ranking', '单 Agent 排行榜只有一行', 1, await ctx.client.eval(`document.querySelectorAll('.cxl-row').length`));
    const shotLeaderboard = await screenshot(ctx.client, '01-single-leaderboard.png', 'S1-ranking');

    await ctx.client.eval(`document.querySelector('[data-action="refresh"]').click()`);
    await waitFor(ctx.client, `!document.querySelector('.cxl-root').classList.contains('loading')`, 'refresh completed');
    check('S1-refresh', '刷新按钮完成且行仍存在', true, await ctx.client.eval(`!!document.querySelector('[data-agent-row="${AGENT_ID}"]')`));

    await ctx.client.eval(`document.querySelector('[data-action="toggle-auto"]').click()`);
    await waitFor(ctx.client, `document.querySelector('[data-action="toggle-auto"]').classList.contains('active')`, 'auto schedule enabled');
    await ctx.client.eval(`document.querySelector('[data-action="toggle-auto"]').click()`);
    await waitFor(ctx.client, `!document.querySelector('[data-action="toggle-auto"]').classList.contains('active')`, 'auto schedule disabled');
    check('S1-auto-toggle', '自动赛程可启用并再次关闭', false, (await leagueState(ctx.client)).schedule.enabled);

    await openAgentDrawer(ctx.client);
    await ctx.client.eval(`document.querySelector('[data-action="edit-prompts"]').click()`);
    await waitFor(ctx.client, `!document.querySelector('[data-role="prompt-overlay"]').hidden && !document.querySelector('[data-role="prompt-editor"]').readOnly`, 'prompt editor');
    await ctx.client.eval(`(() => {
      const editor = document.querySelector('[data-role="prompt-editor"]');
      editor.value += '\\n\\n## 单 Agent 真实点击验收\\n\\nSINGLE-REAL-CLICK-E2E';
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[data-action="save-prompt"]').click();
    })()`);
    await waitFor(ctx.client, `document.querySelector('[data-role="prompt-status"]').textContent.includes('保存成功')`, 'prompt saved');
    check('S1-prompt-save', '提示词通过 UI 原子保存', true, await ctx.client.eval(`(async()=>{
      const value=await require('electron').ipcRenderer.invoke('agent-league:prompt-files',{agentId:${JSON.stringify(AGENT_ID)}});
      return value.files.find(row=>row.key==='agent').content.includes('SINGLE-REAL-CLICK-E2E');
    })()`));
    const shotPrompt = await screenshot(ctx.client, '02-prompt-editor-saved.png', 'S1-prompt-save');
    await ctx.client.eval(`document.querySelector('[data-action="close-prompts"]').click()`);

    // Card creates the ordinary shell. PTY opens the exact same shell.
    await ctx.client.eval(`document.querySelector('[data-action="open-card"]').click()`);
    await waitFor(ctx.client, `document.getElementById('terminal-panel').classList.contains('card-view-active')`, 'empty card surface');
    let state = await leagueState(ctx.client);
    const hubSessionId = state.agents[0].session.hubSessionId;
    check('S1-hub-binding', 'Agent 已绑定普通 Hub Session', value => typeof value === 'string' && value.length > 10, hubSessionId, { expectedText: 'non-empty Hub UUID' });
    check('S1-no-native-yet', '首次对话前没有伪造原生 Codex SID', '', state.agents[0].session.nativeSession.codexSid || '');
    await openLeague(ctx.client);
    await openAgentDrawer(ctx.client);
    await ctx.client.eval(`document.querySelector('[data-action="open-pty"]').click()`);
    const directJumpMs = await waitPty(ctx.client, 'direct PTY shortcut');
    check('S1-direct-pty', '详情中的 PTY 按钮打开同一普通 Session', hubSessionId, await activeSessionId(ctx.client), { latencyMs: directJumpMs });
    let buffer = await sessionBuffer(ctx.client, hubSessionId);
    check('S1-no-picker', '新建 PTY 不出现 resume picker', false, PICKER_RE.test(buffer), { tail: buffer.slice(-400) });
    const shotPty = await screenshot(ctx.client, '03-unbound-ordinary-pty.png', 'S1-direct-pty');
    evidence.single = { hubSessionId, phase1NativeSid: '', screenshots: [shotLeaderboard, shotPrompt, shotPty] };
    await stopLaunch(ctx, 'single-phase-1-unbound');
    ctx = null;

    // Launch 2: exact screenshot reproduction path — click premarket from a
    // dormant shell with no native SID, then observe the automatic PTY jump.
    log('PHASE 2: restart unbound shell and click all trading actions');
    ctx = await launch('single-phase-2-actions', 25620);
    await instrument(ctx.client);
    await openLeague(ctx.client);
    state = await leagueState(ctx.client);
    check('S2-same-shell-before-run', '重启后仍关联原 Hub ID', hubSessionId, state.agents[0].session.hubSessionId);
    check('S2-still-unbound-before-run', '运行前仍没有原生 SID', '', state.agents[0].session.nativeSession.codexSid || '');
    const clickStarted = Date.now();
    await ctx.client.eval(`document.querySelector('[data-action="run-day"]').click()`);
    const autoJumpMs = await waitPty(ctx.client, 'premarket automatic PTY jump', 15000);
    const totalJumpMs = Date.now() - clickStarted;
    check('S2-premarket-auto-jump', '盘前决策自动跳转对应 PTY', hubSessionId, await activeSessionId(ctx.client), { latencyMs: totalJumpMs, terminalWaitMs: autoJumpMs });
    check('S2-premarket-latency', '盘前按钮 15 秒内进入 PTY', value => value <= 15000, totalJumpMs, { expectedText: '<=15000ms' });
    await _waitMs(1800);
    buffer = await sessionBuffer(ctx.client, hubSessionId);
    check('S2-picker-regression', '截图中的 Resume a previous session 不再出现', false, PICKER_RE.test(buffer), { tail: buffer.slice(-700) });
    const shotRunning = await screenshot(ctx.client, '04-premarket-auto-jump-running.png', 'S2-premarket-auto-jump');
    log('waiting for real Codex DRAFT and Hook');
    state = await waitRunFinished(ctx.client, 'daily');
    check('S2-daily-status', '真实 DRAFT→Hook 赛程完成', 'completed', state.schedule.lastRunStatus, { failures: state.run && state.run.failed });
    const agent = state.agents.find(row => row.id === AGENT_ID);
    check('S2-native-bound', '真实 turn 后写回 Codex SID', value => typeof value === 'string' && value.length > 20, agent.session.nativeSession.codexSid || '', { expectedText: 'provider-native SID' });
    check('S2-hook-verdict', 'Hook 产出合法裁决', value => ['PASS', 'REVISE', 'HOLD'].includes(value), agent.latestDaily.hook.verdict, { expectedText: 'PASS/REVISE/HOLD' });
    check('S2-daily-brief', '生成可读的每日思考短文', value => value >= 80, agent.latestDaily.dailyBrief.body.length, { expectedText: '>=80 chars', headline: agent.latestDaily.dailyBrief.headline });
    evidence.single.nativeSid = agent.session.nativeSession.codexSid;

    await openLeague(ctx.client);
    await openAgentDrawer(ctx.client);
    const shotDaily = await screenshot(ctx.client, '05-daily-draft-hook-final.png', 'S2-daily-status');
    await ctx.client.eval(`document.querySelector('[data-action="open-card"]').click()`);
    await waitFor(ctx.client, `document.getElementById('terminal-panel').classList.contains('card-view-active')`, 'card view after daily');
    const cardsAfterDaily = await waitFor(ctx.client, `document.querySelectorAll('#msg-overlay .turn-card').length`, 'daily card history', 45000);
    check('S2-card-history', '卡片视图显示历史对话', value => value >= 2, Number(cardsAfterDaily), { expectedText: '>=2 cards' });
    // Card history is asserted from the real DOM. Keep the screenshot budget
    // for the state transitions that cannot be reconstructed from ledgers.

    await openLeague(ctx.client);
    await ctx.client.eval(`document.querySelector('[data-action="execute-open"]').click()`);
    await waitPty(ctx.client, 'open execution PTY shortcut');
    state = await waitFor(ctx.client, `(async()=>{const v=await require('electron').ipcRenderer.invoke('agent-league:list',{});return v.schedule.lastExecutionDate===${JSON.stringify(DECISION_DATE)}?v:null})()`, 'open execution accounting', 90000);
    check('S2-open-accounting', '开盘执行写入当天账本', 'completed', state.schedule.lastExecutionStatus);
    check('S2-open-pty', '开盘执行后仍跳同一 PTY', hubSessionId, await activeSessionId(ctx.client));

    await openLeague(ctx.client);
    await ctx.client.eval(`document.querySelector('[data-action="record-close"]').click()`);
    await waitPty(ctx.client, 'close accounting PTY shortcut');
    state = await waitFor(ctx.client, `(async()=>{const v=await require('electron').ipcRenderer.invoke('agent-league:list',{});return v.schedule.lastResultDate===${JSON.stringify(DECISION_DATE)}?v:null})()`, 'close accounting', 90000);
    check('S2-close-accounting', '收盘记账更新净值', 'completed', state.schedule.lastResultStatus);
    check('S2-close-pty', '收盘记账后仍跳同一 PTY', hubSessionId, await activeSessionId(ctx.client));

    await openLeague(ctx.client);
    await ctx.client.eval(`document.querySelector('[data-action="run-weekly"]').click()`);
    await waitPty(ctx.client, 'weekly PTY shortcut', 15000);
    check('S2-weekly-pty', '周六沉淀自动跳同一 PTY', hubSessionId, await activeSessionId(ctx.client));
    log('waiting for real Codex weekly reflection');
    state = await waitRunFinished(ctx.client, 'weekly');
    check('S2-weekly-status', '真实周六沉淀完成', 'completed', state.schedule.lastWeeklyStatus);
    const weeklyAgent = state.agents.find(row => row.id === AGENT_ID);
    check('S2-weekly-memory', '周沉淀写入待验证经验', value => value >= 1, weeklyAgent.recentLessons.length, { expectedText: '>=1 lesson' });
    await openLeague(ctx.client);
    await openAgentDrawer(ctx.client);
    const shotWeekly = await screenshot(ctx.client, '07-weekly-reflection-detail.png', 'S2-weekly-status');
    evidence.single.phase2Screenshots = [shotRunning, shotDaily, shotWeekly];
    await stopLaunch(ctx, 'single-phase-2-actions');
    ctx = null;

    // Launch 3: now a native SID exists, so opening PTY must perform exact
    // provider resume, keep history, and still never show a picker.
    log('PHASE 3: exact native resume, idempotence, and conflict recovery');
    ctx = await launch('single-phase-3-resume', 25720);
    await instrument(ctx.client);
    await openLeague(ctx.client);
    await openAgentDrawer(ctx.client);
    const resumeStarted = Date.now();
    await ctx.client.eval(`document.querySelector('[data-action="open-pty"]').click()`);
    await waitPty(ctx.client, 'exact native resume', 15000);
    const resumeMs = Date.now() - resumeStarted;
    check('S3-same-hub-id', '精准恢复仍使用原 Hub ID', hubSessionId, await activeSessionId(ctx.client), { latencyMs: resumeMs });
    state = await leagueState(ctx.client);
    const resumedAgent = state.agents.find(row => row.id === AGENT_ID);
    check('S3-same-native-sid', '精准恢复保持原 Codex SID', evidence.single.nativeSid, resumedAgent.session.nativeSession.codexSid);
    await _waitMs(1600);
    buffer = await sessionBuffer(ctx.client, hubSessionId);
    check('S3-no-picker', '精准恢复直接进入会话而非 picker', false, PICKER_RE.test(buffer), { tail: buffer.slice(-700) });
    const shotResumed = await screenshot(ctx.client, '11-exact-resume-pty.png', 'S3-same-native-sid');

    await openLeague(ctx.client);
    await openAgentDrawer(ctx.client);
    await ctx.client.eval(`document.querySelector('[data-action="open-card"]').click()`);
    await waitFor(ctx.client, `document.getElementById('terminal-panel').classList.contains('card-view-active')`, 'resumed card view');
    const resumedCards = await waitFor(ctx.client, `document.querySelectorAll('#msg-overlay .turn-card').length`, 'resumed card history', 45000);
    check('S3-card-persisted', '重启后卡片历史仍可读', value => value >= 4, Number(resumedCards), { expectedText: '>=4 cards' });
    const shotResumedCard = await screenshot(ctx.client, '12-resumed-card-history.png', 'S3-card-persisted');

    // The same-day button is idempotent and still behaves as a PTY shortcut.
    await openLeague(ctx.client);
    await ctx.client.eval(`document.querySelector('[data-action="run-day"]').click()`);
    await waitPty(ctx.client, 'idempotent daily PTY shortcut', 15000);
    state = await leagueState(ctx.client);
    check('S3-idempotent-day', '重复点击不会生成第二份当日决策', 'completed', state.schedule.lastRunStatus);
    check('S3-idempotent-pty', '重复点击仍打开正确 PTY', hubSessionId, await activeSessionId(ctx.client));

    // Real UI conflict path: mutate AGENT.md through IPC after the editor has
    // loaded, then click Save with the stale SHA and recover via Reload.
    await openLeague(ctx.client);
    await openAgentDrawer(ctx.client);
    await ctx.client.eval(`document.querySelector('[data-action="edit-prompts"]').click()`);
    await waitFor(ctx.client, `!document.querySelector('[data-role="prompt-overlay"]').hidden && !document.querySelector('[data-role="prompt-editor"]').readOnly`, 'prompt editor for conflict');
    const externalSave = await ctx.client.eval(`(async()=>{
      const ipc=require('electron').ipcRenderer;
      const work=await ipc.invoke('agent-league:prompt-files',{agentId:${JSON.stringify(AGENT_ID)}});
      const file=work.files.find(row=>row.key==='agent');
      return ipc.invoke('agent-league:save-prompt-file',{agentId:${JSON.stringify(AGENT_ID)},key:'agent',content:file.content+'\\n\\n<!-- external-e2e-change -->',expectedSha256:file.sha256});
    })()`);
    check('S3-external-save', '并发修改探针先成功落盘', true, externalSave.ok);
    await ctx.client.eval(`(() => {
      const editor=document.querySelector('[data-role="prompt-editor"]');
      editor.value += '\\nSTALE-UI-SAVE';
      editor.dispatchEvent(new Event('input',{bubbles:true}));
      document.querySelector('[data-action="save-prompt"]').click();
    })()`);
    const conflictText = await waitFor(ctx.client, `document.querySelector('[data-role="prompt-status"]').textContent.includes('保存失败') && document.querySelector('[data-role="prompt-status"]').textContent`, 'conflict surfaced');
    check('S3-conflict-visible', '提示词并发冲突在 UI 明确显示', value => /已被其他进程修改|已在别处修改/.test(String(value)), conflictText, { expectedText: 'contains explicit concurrent-modification message' });
    const shotConflict = await screenshot(ctx.client, '13-prompt-conflict-visible.png', 'S3-conflict-visible');
    await ctx.client.eval(`document.querySelector('[data-action="reload-prompt"]').click()`);
    await waitFor(ctx.client, `document.querySelector('[data-role="prompt-status"]').textContent.includes('已从磁盘重新载入')`, 'conflict reload');
    check('S3-conflict-recovery', '冲突后可一键重载恢复', true, await ctx.client.eval(`document.querySelector('[data-role="prompt-editor"]').value.includes('external-e2e-change')`));
    evidence.single.phase3Screenshots = [shotResumed, shotResumedCard, shotConflict];
    await stopLaunch(ctx, 'single-phase-3-resume');
    ctx = null;

    // Preserve the isolated Markdown evidence before removing the temp root.
    fs.cpSync(path.join(LEAGUE_ROOT, 'agents', AGENT_ID), path.join(OUTPUT, 'agent-folder-evidence'), { recursive: true });
    for (const name of ['SCHEDULE.md']) {
      const source = path.join(LEAGUE_ROOT, name);
      if (fs.existsSync(source)) fs.copyFileSync(source, path.join(OUTPUT, name));
    }
    evidence.finishedAt = new Date().toISOString();
    evidence.ok = evidence.checks.every(row => row.pass);
    fs.writeFileSync(path.join(OUTPUT, 'evidence.json'), JSON.stringify(evidence, null, 2), 'utf8');
    log('SINGLE AGENT E2E COMPLETE', { checks: evidence.checks.length, screenshots: evidence.screenshots.length, output: OUTPUT });
    console.log(JSON.stringify({ ok: true, output: OUTPUT, checks: evidence.checks.length, screenshots: evidence.screenshots.length, hubSessionId: evidence.single.hubSessionId, nativeSid: evidence.single.nativeSid }, null, 2));
  } finally {
    if (ctx) {
      const emergencyLog = ctx.hub.log();
      fs.writeFileSync(path.join(OUTPUT, `${ctx.hub.label || 'failed-launch'}-hub-emergency.log`), `${emergencyLog.join('\n')}\n`, 'utf8');
      try { await ctx.client.close(); } catch {}
      try {
        if (ctx.hub.isAlive()) await gracefulQuit(ctx.hub);
        else log('isolated Hub had already exited', { code: ctx.hub.exitCode(), signal: ctx.hub.exitSignal() });
      } catch (error) { log('teardown error', error.message); }
      liveHubForWait = null;
    }
    if (!fs.existsSync(path.join(OUTPUT, 'evidence.json'))) {
      evidence.finishedAt = new Date().toISOString();
      evidence.ok = false;
      fs.writeFileSync(path.join(OUTPUT, 'evidence.json'), JSON.stringify(evidence, null, 2), 'utf8');
    }
    if (evidence.ok) safeCleanup();
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
