'use strict';

// Real-click heterogeneous-strategy (same frontier model) multi-Agent E2E.
// The second contestant is created through the actual UI after the baseline
// exists. Both Agents run concurrently in independent ordinary Codex Sessions,
// settle independently, reflect weekly, and precisely resume after Hub restart.

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
const TEMP_ROOT = path.join(os.tmpdir(), `agent-league-multi-real-${process.pid}-${STAMP}`);
const HUB_DATA = path.join(TEMP_ROOT, 'hub-data');
const LEAGUE_ROOT = path.join(TEMP_ROOT, 'league');
const OUTPUT = path.join(HUB_ROOT, 'output', 'playwright', `agent-league-multi-real-${STAMP}`);
const DECISION_DATE = '2026-08-26';
const SATURDAY_DATE = '2026-08-29';
const BASELINE_ID = 'chuxin-baseline';
const TREND_ID = 'trend-rider';
const PICKER_RE = /Resume a previous session|Select a session to resume|resume picker/i;
const PROGRESS_ONLY = process.env.AGENT_LEAGUE_PROGRESS_ONLY === '1';

const evidence = {
  suite: 'multi-agent-real-click-competition',
  startedAt: new Date().toISOString(),
  isolated: true,
  productionHubTouched: false,
  designChoice: 'same gpt-5.6-sol model, different philosophies, isolates strategy effect',
  checks: [], screenshots: [], launches: [],
};
let liveHub = null;

function log(message, detail = null) {
  const row = `[multi-agent-e2e] ${new Date().toISOString()} ${message}${detail == null ? '' : ` ${JSON.stringify(detail)}`}`;
  console.log(row);
  fs.appendFileSync(path.join(OUTPUT, 'progress.log'), `${row}\n`, 'utf8');
}

function check(id, label, expected, actual, extra = {}) {
  const pass = typeof expected === 'function' ? !!expected(actual) : Object.is(expected, actual);
  const row = { id, label, pass, expected: typeof expected === 'function' ? extra.expectedText || 'predicate=true' : expected, actual, at: new Date().toISOString(), ...extra };
  evidence.checks.push(row);
  if (!pass) throw new assert.AssertionError({ message: `${id} ${label}`, expected: row.expected, actual });
  log(`PASS ${id} ${label}`, actual);
  return row;
}

async function freePort(start) {
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
    if (liveHub && !liveHub.isAlive()) {
      throw new Error(`isolated Hub exited while waiting for ${label} (code=${liveHub.exitCode()}, signal=${liveHub.exitSignal() || 'none'})\n${liveHub.log().slice(-60).join('\n')}`);
    }
    try {
      const value = await client.eval(expression);
      if (value) return value;
    } catch (error) { lastError = error; }
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

function seedBaseline() {
  const store = new AgentLeagueStore({ root: LEAGUE_ROOT });
  store.createAgent({
    id: BASELINE_ID, name: '初心基准', provider: 'codex-cli', kind: 'codex', model: 'gpt-5.6-sol',
    philosophy: getPhilosophy('chuxin-value-speculation'), initialCash: 500000,
  });
}

async function launch(label, portStart) {
  const port = await freePort(portStart);
  const hub = await launchIsolatedHub({
    dataDir: HUB_DATA, port, label, windowMode: 'hidden',
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
  liveHub = hub;
  evidence.launches.push({ label, pid: hub.pid, port, identityVerified: hub.identityVerified, startedAt: new Date().toISOString() });
  return { hub, client };
}

async function instrument(client) {
  await waitFor(client, `(document.getElementById('btn-research') || document.getElementById('btn-chuxin')) && document.querySelector('.cx-primary-tab[data-tab="league"]')`, 'league shell');
  await client.eval(`(() => {
    window.__agentLeagueMultiErrors=[];
    window.__agentLeagueMultiResults={};
    window.addEventListener('error',e=>window.__agentLeagueMultiErrors.push(String(e.error||e.message)));
    window.addEventListener('unhandledrejection',e=>window.__agentLeagueMultiErrors.push(String(e.reason)));
    const ipc=require('electron').ipcRenderer;
    if(!window.__agentLeagueMultiOriginalInvoke){
      window.__agentLeagueMultiOriginalInvoke=ipc.invoke.bind(ipc);
      ipc.invoke=(channel,input,...rest)=>{
        let next=input;
        if(channel==='agent-league:run-day') next={...(input||{}),force:true,decisionDate:${JSON.stringify(DECISION_DATE)}};
        if(channel==='agent-league:execute-open'||channel==='agent-league:record-close') next={...(input||{}),force:true,decisionDate:${JSON.stringify(DECISION_DATE)}};
        if(channel==='agent-league:run-weekly') next={...(input||{}),force:true,saturdayDate:${JSON.stringify(SATURDAY_DATE)}};
        return window.__agentLeagueMultiOriginalInvoke(channel,next,...rest).then(result=>{
          if(channel.startsWith('agent-league:')) window.__agentLeagueMultiResults[channel]=result;
          return result;
        });
      };
    }
    window.confirm=()=>true;
    return true;
  })()`);
}

async function openLeague(client) {
  await client.eval(`(document.getElementById('btn-research') || document.getElementById('btn-chuxin')).click()`);
  await waitFor(client, `document.querySelector('.cx-primary-tab[data-tab="league"]')`, 'league tab');
  await client.eval(`document.querySelector('.cx-primary-tab[data-tab="league"]').click()`);
  await waitFor(client, `document.querySelector('[data-agent-row="${BASELINE_ID}"]')`, 'baseline row');
}

async function openDrawer(client, id) {
  await client.eval(`document.querySelector('[data-agent-row=${JSON.stringify(id)}]').click()`);
  await waitFor(client, `!document.querySelector('[data-role="detail-overlay"]').hidden && document.querySelector('[data-action="open-pty"]')`, `${id} drawer`);
}

async function waitPty(client, label, timeoutMs = 15000) {
  await waitFor(client, `(() => {const p=document.getElementById('terminal-panel');return p&&getComputedStyle(p).display!=='none'&&!p.classList.contains('card-view-active')})()`, label, timeoutMs);
  return client.eval(`document.querySelector('#session-list .session-item.selected')?.dataset.sessionId || ''`);
}

async function state(client) {
  return client.eval(`require('electron').ipcRenderer.invoke('agent-league:list',{})`);
}

async function buffer(client, sessionId) {
  return client.eval(`(async()=>String(await require('electron').ipcRenderer.invoke('debug:get-session-buffer',${JSON.stringify(sessionId)})||''))()`);
}

async function waitRunFinished(client, mode, timeoutMs = 45 * 60 * 1000) {
  return waitFor(client, `(async()=>{const v=await require('electron').ipcRenderer.invoke('agent-league:list',{});const s=${JSON.stringify(mode)}==='weekly'?v.schedule.lastWeeklyStatus:v.schedule.lastRunStatus;return !v.run&&['completed','partial','failed'].includes(s)?v:null})()`, `${mode} completion`, timeoutMs, 1000);
}

async function stop(ctx, label) {
  const errors = await ctx.client.eval(`window.__agentLeagueMultiErrors||[]`).catch(() => []);
  check(`${label}-renderer-errors`, `${label} renderer 无未处理异常`, 0, errors.length, { detail: errors });
  await ctx.client.close();
  const exit = await gracefulQuit(ctx.hub);
  liveHub = null;
  const launchRow = evidence.launches.find(row => row.label === label);
  launchRow.finishedAt = new Date().toISOString();
  launchRow.exit = exit;
  launchRow.log = ctx.hub.log();
  fs.writeFileSync(path.join(OUTPUT, `${label}-hub.log`), `${launchRow.log.join('\n')}\n`, 'utf8');
}

function safeCleanup() {
  const resolved = path.resolve(TEMP_ROOT);
  const temp = path.resolve(os.tmpdir());
  if (!resolved.startsWith(temp + path.sep) || !path.basename(resolved).startsWith('agent-league-multi-real-')) return;
  fs.rmSync(resolved, { recursive: true, force: true });
}

(async () => {
  fs.mkdirSync(OUTPUT, { recursive: true });
  seedBaseline();
  let ctx = null;
  try {
    log('PHASE 1: create second Agent through UI and run both concurrently');
    ctx = await launch('multi-phase-1-run', 25820);
    await instrument(ctx.client);
    await openLeague(ctx.client);
    check('M1-before-create', '新增前只有初心基准', 1, await ctx.client.eval(`document.querySelectorAll('.cxl-row').length`));

    await ctx.client.eval(`document.querySelector('[data-action="new-agent"]').click()`);
    await waitFor(ctx.client, `!document.querySelector('[data-role="create-overlay"]').hidden && document.querySelector('[name="model"] option')`, 'create Agent dialog');
    await ctx.client.eval(`(() => {
      const f=document.querySelector('[data-role="create-form"]');
      f.elements.name.value='逐浪';
      f.elements.id.value=${JSON.stringify(TREND_ID)};
      f.elements.provider.value='codex-cli';
      f.elements.provider.dispatchEvent(new Event('change',{bubbles:true}));
      f.elements.model.value='gpt-5.6-sol';
      f.elements.philosophyKey.value='trend-confirmation';
      f.elements.initialCash.value='500000';
      f.requestSubmit();
    })()`);
    await waitFor(ctx.client, `document.querySelector('[data-agent-row="${TREND_ID}"]') && document.querySelectorAll('.cxl-row').length===2`, 'second Agent row');
    let league = await state(ctx.client);
    check('M1-created', '真实 UI 已创建第二个 Agent', 2, league.agents.length);
    const baseline = league.agents.find(row => row.id === BASELINE_ID);
    const trend = league.agents.find(row => row.id === TREND_ID);
    check('M1-equal-capital', '两名 Agent 初始资金相同', baseline.initialCash, trend.initialCash);
    check('M1-different-style', '第二 Agent 使用不同投资理念', true, baseline.philosophy.title !== trend.philosophy.title, { baseline: baseline.philosophy.title, trend: trend.philosophy.title });
    check('M1-separate-folders', '两名 Agent 使用独立 Markdown 文件夹', true, baseline.folder !== trend.folder, { baseline: baseline.folder, trend: trend.folder });
    check('M1-concurrency-config', '赛程并发数允许两名同时运行', 2, league.schedule.maxConcurrency);
    const shotBoard = await screenshot(ctx.client, '01-two-agent-leaderboard.png', 'M1-created');

    // createAgent leaves the second Agent selected, so the global action must
    // jump to that selected contestant while both are running.
    check('M1-global-action-label', '顶部动作明确表示会启动全部 Agent', true,
      await ctx.client.eval(`document.querySelector('[data-action="run-day"]').textContent.includes('全体盘前决策')`));
    await ctx.client.eval(`document.querySelector('[data-action="close-detail"]').click();document.querySelector('[data-action="run-day"]').click()`);
    const selectedPtyId = await waitPty(ctx.client, 'selected trend Agent PTY');
    league = await waitFor(ctx.client, `(async()=>{const v=await require('electron').ipcRenderer.invoke('agent-league:list',{});return v.run&&v.run.active.length===2?v:null})()`, 'two concurrent active Agents', 30000);
    const byId = Object.fromEntries(league.agents.map(row => [row.id, row]));
    const baselineHubId = byId[BASELINE_ID].session.hubSessionId;
    const trendHubId = byId[TREND_ID].session.hubSessionId;
    check('M1-auto-jump-selected', '盘前按钮跳到已选中的逐浪 PTY', trendHubId, selectedPtyId);
    check('M1-two-active', '同一赛程两名 Agent 同时 active', 2, league.run.active.length, { active: league.run.active });
    check('M1-distinct-hub-sessions', '两名 Agent 绑定不同 Hub Session', true, baselineHubId !== trendHubId, { baselineHubId, trendHubId });
    check('M1-trend-no-picker', '逐浪 PTY 不出现 resume picker', false, PICKER_RE.test(await buffer(ctx.client, trendHubId)));
    const shotTrendPty = await screenshot(ctx.client, '02-trend-agent-running-pty.png', 'M1-auto-jump-selected');

    await openLeague(ctx.client);
    const progressUi = await ctx.client.eval(`(() => ({
      buttonText: document.querySelector('[data-action="run-day"]').textContent.trim(),
      buttonDisabled: document.querySelector('[data-action="run-day"]').disabled,
      subtitle: document.querySelector('[data-role="board-subtitle"]').textContent,
      rowStatuses: [...document.querySelectorAll('.cxl-row .cxl-status')].map(node => node.textContent.trim()),
    }))()`);
    check('M1-progress-button-enabled', '运行中顶部按钮仍可点击查看进度', false, progressUi.buttonDisabled, { progressUi });
    check('M1-progress-button-label', '运行中按钮明确显示两名 Agent 的进度入口', true, /查看决策进度（2）/.test(progressUi.buttonText), { progressUi });
    check('M1-progress-subtitle', '排行榜明确显示两名 Agent 同时运行', true, /2 运行中/.test(progressUi.subtitle), { progressUi });
    check('M1-progress-row-status', '两行均显示 DRAFT/Hook 运行阶段而非待首次运行', true,
      progressUi.rowStatuses.length === 2 && progressUi.rowStatuses.every(value => /DRAFT 中|Hook 中/.test(value)), { progressUi });
    const shotProgress = await screenshot(ctx.client, '03-two-agent-progress-entry.png', 'M1-progress-button-enabled');

    await openDrawer(ctx.client, BASELINE_ID);
    await ctx.client.eval(`document.querySelector('[data-action="close-detail"]').click();document.querySelector('[data-action="run-day"]').click()`);
    check('M1-baseline-pty', '选中初心基准后可用同一顶部按钮查看其 PTY', baselineHubId, await waitPty(ctx.client, 'baseline concurrent PTY'));
    check('M1-baseline-no-picker', '初心基准 PTY 不出现 resume picker', false, PICKER_RE.test(await buffer(ctx.client, baselineHubId)));
    const shotBaselinePty = await screenshot(ctx.client, '04-baseline-agent-running-pty.png', 'M1-baseline-pty');

    if (PROGRESS_ONLY) {
      evidence.progressOnly = true;
      evidence.sessions = { baselineHubId, trendHubId };
      evidence.phase1Screenshots = [shotBoard, shotTrendPty, shotProgress, shotBaselinePty];
      await stop(ctx, 'multi-phase-1-run');
      ctx = null;
      evidence.finishedAt = new Date().toISOString();
      evidence.ok = evidence.checks.every(row => row.pass);
      fs.writeFileSync(path.join(OUTPUT, 'evidence.json'), JSON.stringify(evidence, null, 2), 'utf8');
      log('MULTI AGENT PROGRESS E2E COMPLETE', { checks: evidence.checks.length, screenshots: evidence.screenshots.length, output: OUTPUT });
      console.log(JSON.stringify({ ok: true, progressOnly: true, output: OUTPUT, checks: evidence.checks.length, screenshots: evidence.screenshots.length, sessions: evidence.sessions }, null, 2));
      return;
    }

    log('waiting for two real Codex DRAFT and Hook chains');
    league = await waitRunFinished(ctx.client, 'daily');
    check('M1-daily-completed', '双 Agent 日赛程整体完成', 'completed', league.schedule.lastRunStatus);
    const done = Object.fromEntries(league.agents.map(row => [row.id, row]));
    for (const id of [BASELINE_ID, TREND_ID]) {
      check(`M1-${id}-decision`, `${id} 拥有独立 FINAL`, true, !!(done[id].latestDaily && done[id].latestDaily.decision));
      check(`M1-${id}-brief`, `${id} 拥有独立 DAILY_BRIEF`, value => value >= 80, done[id].latestDaily.dailyBrief.body.length, { expectedText: '>=80 chars', headline: done[id].latestDaily.dailyBrief.headline });
    }
    const baselineSid = done[BASELINE_ID].session.nativeSession.codexSid;
    const trendSid = done[TREND_ID].session.nativeSession.codexSid;
    check('M1-distinct-native-sids', '两名 Agent 绑定不同 Codex 原生 SID', true, !!baselineSid && !!trendSid && baselineSid !== trendSid, { baselineSid, trendSid });
    check('M1-independent-briefs', '不同理念产出的每日短文不相同', true, done[BASELINE_ID].latestDaily.dailyBrief.body !== done[TREND_ID].latestDaily.dailyBrief.body);

    await openLeague(ctx.client);
    await ctx.client.eval(`document.querySelector('[data-action="execute-open"]').click()`);
    await waitPty(ctx.client, 'multi open accounting shortcut');
    league = await waitFor(ctx.client, `(async()=>{const v=await require('electron').ipcRenderer.invoke('agent-league:list',{});return v.schedule.lastExecutionDate===${JSON.stringify(DECISION_DATE)}?v:null})()`, 'multi open accounting', 90000);
    const openResult = await ctx.client.eval(`window.__agentLeagueMultiResults['agent-league:execute-open']`);
    check('M1-open-status', '双 Agent 开盘执行完成', 'completed', league.schedule.lastExecutionStatus);
    check('M1-open-two-results', '开盘账本逐 Agent 独立返回', 2, openResult.results.length, { errors: openResult.errors });

    await openLeague(ctx.client);
    await ctx.client.eval(`document.querySelector('[data-action="record-close"]').click()`);
    await waitPty(ctx.client, 'multi close accounting shortcut');
    league = await waitFor(ctx.client, `(async()=>{const v=await require('electron').ipcRenderer.invoke('agent-league:list',{});return v.schedule.lastResultDate===${JSON.stringify(DECISION_DATE)}?v:null})()`, 'multi close accounting', 90000);
    const closeResult = await ctx.client.eval(`window.__agentLeagueMultiResults['agent-league:record-close']`);
    check('M1-close-status', '双 Agent 收盘记账完成', 'completed', league.schedule.lastResultStatus);
    check('M1-close-two-results', '收盘净值逐 Agent 独立返回', 2, closeResult.results.length, { errors: closeResult.errors });

    await openLeague(ctx.client);
    await ctx.client.eval(`document.querySelector('[data-sort="asset"]').click();document.querySelector('[data-sort="return"]').click()`);
    check('M1-ranking-two-rows', '收益排行榜持续展示两名 Agent', 2, await ctx.client.eval(`document.querySelectorAll('.cxl-row').length`));
    await ctx.client.eval(`document.querySelector('[data-action="run-weekly"]').click()`);
    await waitPty(ctx.client, 'multi weekly shortcut');
    await waitFor(ctx.client, `(async()=>{const v=await require('electron').ipcRenderer.invoke('agent-league:list',{});return v.run&&v.run.mode==='weekly'&&v.run.active.length===2})()`, 'two concurrent weekly turns', 30000);
    log('waiting for two real weekly reflections');
    league = await waitRunFinished(ctx.client, 'weekly');
    check('M1-weekly-completed', '双 Agent 周沉淀整体完成', 'completed', league.schedule.lastWeeklyStatus);
    for (const row of league.agents) {
      check(`M1-${row.id}-weekly`, `${row.id} 有独立周复盘`, true, !!(row.latestWeekly && row.latestWeekly.review));
      check(`M1-${row.id}-lesson`, `${row.id} 写入独立待验证经验`, value => value >= 1, row.recentLessons.length, { expectedText: '>=1' });
    }
    evidence.sessions = { baselineHubId, trendHubId, baselineSid, trendSid };
    evidence.phase1Screenshots = [shotBoard, shotTrendPty, shotProgress, shotBaselinePty];
    await stop(ctx, 'multi-phase-1-run');
    ctx = null;

    log('PHASE 2: restart both ordinary Sessions and verify isolation/history');
    ctx = await launch('multi-phase-2-resume', 25920);
    await instrument(ctx.client);
    await openLeague(ctx.client);
    league = await state(ctx.client);
    check('M2-two-rows', '重启后排行榜仍有两名 Agent', 2, league.agents.length);
    const shotResults = await screenshot(ctx.client, '04-resumed-results-leaderboard.png', 'M2-two-rows');

    await openDrawer(ctx.client, TREND_ID);
    await ctx.client.eval(`document.querySelector('[data-action="open-pty"]').click()`);
    check('M2-trend-hub', '逐浪精准恢复原 Hub ID', trendHubId, await waitPty(ctx.client, 'trend exact resume'));
    league = await state(ctx.client);
    check('M2-trend-sid', '逐浪保持原 Codex SID', trendSid, league.agents.find(row => row.id === TREND_ID).session.nativeSession.codexSid);
    check('M2-trend-picker', '逐浪恢复无 picker', false, PICKER_RE.test(await buffer(ctx.client, trendHubId)));
    await openLeague(ctx.client);
    await openDrawer(ctx.client, TREND_ID);
    await ctx.client.eval(`document.querySelector('[data-action="open-card"]').click()`);
    await waitFor(ctx.client, `document.getElementById('terminal-panel').classList.contains('card-view-active')`, 'trend card view');
    const trendCards = await waitFor(ctx.client, `document.querySelectorAll('#msg-overlay .turn-card').length`, 'trend card history', 45000);
    check('M2-trend-cards', '逐浪卡片历史可读', value => value >= 6, Number(trendCards), { expectedText: '>=6 cards' });
    const shotTrendCard = await screenshot(ctx.client, '05-trend-resumed-card-history.png', 'M2-trend-cards');

    await openLeague(ctx.client);
    await openDrawer(ctx.client, BASELINE_ID);
    await ctx.client.eval(`document.querySelector('[data-action="open-pty"]').click()`);
    check('M2-baseline-hub', '初心基准精准恢复原 Hub ID', baselineHubId, await waitPty(ctx.client, 'baseline exact resume'));
    league = await state(ctx.client);
    check('M2-baseline-sid', '初心基准保持原 Codex SID', baselineSid, league.agents.find(row => row.id === BASELINE_ID).session.nativeSession.codexSid);
    check('M2-baseline-picker', '初心基准恢复无 picker', false, PICKER_RE.test(await buffer(ctx.client, baselineHubId)));
    await openLeague(ctx.client);
    await openDrawer(ctx.client, BASELINE_ID);
    await ctx.client.eval(`document.querySelector('[data-action="open-card"]').click()`);
    await waitFor(ctx.client, `document.getElementById('terminal-panel').classList.contains('card-view-active')`, 'baseline card view');
    const baselineCards = await waitFor(ctx.client, `document.querySelectorAll('#msg-overlay .turn-card').length`, 'baseline card history', 45000);
    check('M2-baseline-cards', '初心基准卡片历史可读', value => value >= 6, Number(baselineCards), { expectedText: '>=6 cards' });
    const shotBaselineCard = await screenshot(ctx.client, '06-baseline-resumed-card-history.png', 'M2-baseline-cards');

    // Edit only the second Agent through the real prompt workbench.
    await openLeague(ctx.client);
    await openDrawer(ctx.client, TREND_ID);
    await ctx.client.eval(`document.querySelector('[data-action="edit-prompts"]').click()`);
    await waitFor(ctx.client, `!document.querySelector('[data-role="prompt-overlay"]').hidden && !document.querySelector('[data-role="prompt-editor"]').readOnly`, 'trend prompt editor');
    await ctx.client.eval(`(() => {const e=document.querySelector('[data-role="prompt-editor"]');e.value+='\\n\\n<!-- TREND-ONLY-E2E -->';e.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-action="save-prompt"]').click()})()`);
    await waitFor(ctx.client, `document.querySelector('[data-role="prompt-status"]').textContent.includes('保存成功')`, 'trend prompt save');
    const isolation = await ctx.client.eval(`(async()=>{const ipc=require('electron').ipcRenderer;const a=await ipc.invoke('agent-league:prompt-files',{agentId:${JSON.stringify(BASELINE_ID)}});const b=await ipc.invoke('agent-league:prompt-files',{agentId:${JSON.stringify(TREND_ID)}});return {baseline:a.files.find(x=>x.key==='agent').content.includes('TREND-ONLY-E2E'),trend:b.files.find(x=>x.key==='agent').content.includes('TREND-ONLY-E2E')}})()`);
    check('M2-prompt-isolation', '编辑逐浪不会污染初心基准提示词', true, isolation.trend && !isolation.baseline, { isolation });
    evidence.phase2Screenshots = [shotResults, shotTrendCard, shotBaselineCard];
    await stop(ctx, 'multi-phase-2-resume');
    ctx = null;

    fs.cpSync(path.join(LEAGUE_ROOT, 'agents'), path.join(OUTPUT, 'agent-folders-evidence'), { recursive: true });
    fs.copyFileSync(path.join(LEAGUE_ROOT, 'SCHEDULE.md'), path.join(OUTPUT, 'SCHEDULE.md'));
    evidence.finishedAt = new Date().toISOString();
    evidence.ok = evidence.checks.every(row => row.pass);
    fs.writeFileSync(path.join(OUTPUT, 'evidence.json'), JSON.stringify(evidence, null, 2), 'utf8');
    log('MULTI AGENT E2E COMPLETE', { checks: evidence.checks.length, screenshots: evidence.screenshots.length, output: OUTPUT });
    console.log(JSON.stringify({ ok: true, output: OUTPUT, checks: evidence.checks.length, screenshots: evidence.screenshots.length, sessions: evidence.sessions }, null, 2));
  } finally {
    if (ctx) {
      fs.writeFileSync(path.join(OUTPUT, `${ctx.hub.label || 'failed'}-hub-emergency.log`), `${ctx.hub.log().join('\n')}\n`, 'utf8');
      try { await ctx.client.close(); } catch {}
      try { if (ctx.hub.isAlive()) await gracefulQuit(ctx.hub); } catch (error) { log('teardown error', error.message); }
      liveHub = null;
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
