'use strict';

// Real Electron + real Codex virtual-live acceptance. The formal and virtual
// league roots both live under one disposable temp root; production Hub/data
// are never opened or modified.
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
const TEMP_ROOT = path.join(os.tmpdir(), `agent-league-virtual-live-${process.pid}-${STAMP}`);
const LEAGUE_ROOT = path.join(TEMP_ROOT, 'league');
const OUTPUT = path.join(HUB_ROOT, 'output', 'playwright', `agent-league-virtual-live-${STAMP}`);
const AGENT_ID = 'virtual-live-codex';
const VIRTUAL_DATE = '2026-08-31';
const REAL_TURN_TIMEOUT_MS = Math.max(60000, Number(process.env.AGENT_LEAGUE_REAL_TURN_TIMEOUT_MS || 20 * 60 * 1000));

function freePort(start = 25720) {
  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      if (port > start + 50) return reject(new Error('no isolated CDP port available'));
      const server = net.createServer();
      server.once('error', () => tryPort(port + 1));
      server.once('listening', () => server.close(() => resolve(port)));
      server.listen(port, '127.0.0.1');
    };
    tryPort(start);
  });
}

async function waitEval(client, expression, label, timeoutMs = 20 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await client.eval(expression);
      if (value) return value;
    } catch {}
    await _waitMs(700);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function screenshot(client, name) {
  const result = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const target = path.join(OUTPUT, name);
  fs.writeFileSync(target, Buffer.from(result.data, 'base64'));
  return target;
}

function seedFormalLeague() {
  const store = new AgentLeagueStore({ root: LEAGUE_ROOT });
  store.createAgent({
    id: AGENT_ID,
    name: '虚拟实盘 Codex 探针',
    provider: 'codex-cli',
    kind: 'codex',
    model: 'gpt-5.6-sol',
    philosophy: getPhilosophy('chuxin-value-speculation'),
    initialCash: 500000,
  });
  const daily = store.listPromptFiles(AGENT_ID).find((row) => row.key === 'dailyPrompt');
  store.savePromptFile(AGENT_ID, 'dailyPrompt', `${daily.content}

## 虚拟实盘端到端验收（只在系统合同明确标注虚拟调试时生效）

- 这是交易链功能验收，不是真实投资建议。合成证据可作为本轮唯一证据，不要调用真实行情。
- 若快照包含 600001.SH“虚拟样本·价值修复”，请将它设为 30% 目标仓位、现金 70%，并完整填写 C1/C2/P1/P2/R1/R2/B1 所需论据、反证、时机与失效条件。
- 不得添加快照外标的；JSON 合同、run_id 和日期必须完全正确。
`, daily.sha256, { actor: 'virtual-live-e2e' });
  const hook = store.listPromptFiles(AGENT_ID).find((row) => row.key === 'hookPrompt');
  store.savePromptFile(AGENT_ID, 'hookPrompt', `${hook.content}

## 虚拟实盘端到端验收（只在虚拟调试时生效）

- 若 DRAFT 已按 600001.SH 30%、现金 70% 且字段完整，逐条审查后使用 PASS，保持相同组合。
- DAILY_BRIEF 明确说明这是合成行情验收，不得写成真实荐股。
`, hook.sha256, { actor: 'virtual-live-e2e' });
  return store;
}

async function openLeague(client) {
  await waitEval(client, `document.getElementById('btn-chuxin') || document.getElementById('btn-research')`, 'Chuxin button', 30000);
  await client.eval(`(document.getElementById('btn-chuxin') || document.getElementById('btn-research')).click()`);
  await waitEval(client, `document.querySelector('.cx-primary-tab[data-tab="league"]')`, 'Agent League tab', 30000);
  await client.eval(`document.querySelector('.cx-primary-tab[data-tab="league"]').click()`);
  await waitEval(client, `document.querySelector('.cxl-root') && document.querySelector('[data-action="toggle-virtual"]')`, 'league surface', 30000);
}

function assertAccounting(agent) {
  assert(agent.recentTrades.length >= 1, 'AI decision produced no virtual trade');
  assert(agent.portfolio.positions.length >= 1, 'virtual position missing after open');
  const marketValue = agent.portfolio.positions.reduce((sum, row) => sum + Number(row.quantity) * Number(row.lastPrice), 0);
  const expectedNav = Math.round((Number(agent.portfolio.cash) + marketValue) * 100) / 100;
  assert(Math.abs(agent.stats.nav - expectedNav) < 0.011, `NAV mismatch: ${agent.stats.nav} vs ${expectedNav}`);
  const expectedReturn = expectedNav / Number(agent.initialCash) - 1;
  assert(Math.abs(agent.stats.totalReturn - expectedReturn) < 1e-10, 'total return mismatch');
  assert(Math.abs(agent.stats.dailyReturn - expectedReturn) < 1e-10, 'first-day daily return baseline mismatch');
  assert(Math.abs(agent.stats.positionWeight - marketValue / expectedNav) < 1e-10, 'position weight mismatch');
  for (const trade of agent.recentTrades) {
    assert(Math.abs(Number(trade.commission) - Math.round(Number(trade.notional) * 0.0001 * 100) / 100) < 0.001, 'commission mismatch');
  }
  return { marketValue, expectedNav, expectedReturn };
}

function safeRemoveTemp() {
  const resolved = path.resolve(TEMP_ROOT);
  const temp = path.resolve(os.tmpdir());
  if (!resolved.startsWith(temp + path.sep) || !path.basename(resolved).startsWith('agent-league-virtual-live-')) return;
  fs.rmSync(resolved, { recursive: true, force: true });
}

async function collectFailureDiagnostics(client, hub) {
  const diagnostics = { capturedAt: new Date().toISOString(), hubPid: hub && hub.pid, cdpPort: hub && hub.port };
  try { diagnostics.virtual = await client.eval(`require('electron').ipcRenderer.invoke('agent-league-virtual:list', {})`); } catch (error) { diagnostics.virtualError = error.message; }
  try { diagnostics.debug = await client.eval(`require('electron').ipcRenderer.invoke('agent-league:virtual-state')`); } catch (error) { diagnostics.debugError = error.message; }
  try { diagnostics.sessions = await client.eval(`require('electron').ipcRenderer.invoke('get-sessions')`); } catch (error) { diagnostics.sessionsError = error.message; }
  const agent = diagnostics.virtual && diagnostics.virtual.agents && diagnostics.virtual.agents.find((row) => row.id === AGENT_ID);
  const sessionId = agent && agent.session && agent.session.hubSessionId;
  if (sessionId) {
    try { diagnostics.buffer = await client.eval(`require('electron').ipcRenderer.invoke('debug:get-session-buffer', ${JSON.stringify(sessionId)})`); } catch (error) { diagnostics.bufferError = error.message; }
    try { diagnostics.lastWrite = await client.eval(`require('electron').ipcRenderer.invoke('debug:get-last-session-write')`); } catch (error) { diagnostics.lastWriteError = error.message; }
  }
  diagnostics.hubLogTail = hub ? hub.log().slice(-120) : [];
  try { diagnostics.screenshot = await screenshot(client, '99-failure-pty.png'); } catch (error) { diagnostics.screenshotError = error.message; }
  const virtualRoot = path.join(LEAGUE_ROOT, '_virtual_debug');
  for (const [source, name] of [
    [path.join(virtualRoot, 'VIRTUAL_DEBUG.json'), 'failure-VIRTUAL_DEBUG.json'],
    [path.join(virtualRoot, 'SCHEDULE.md'), 'failure-SCHEDULE.md'],
    [path.join(virtualRoot, 'agents', AGENT_ID, 'SESSION.md'), 'failure-SESSION.md'],
    [path.join(virtualRoot, 'agents', AGENT_ID, 'daily', `${VIRTUAL_DATE}.md`), 'failure-daily.md'],
  ]) {
    try { if (fs.existsSync(source)) fs.copyFileSync(source, path.join(OUTPUT, name)); } catch {}
  }
  fs.writeFileSync(path.join(OUTPUT, 'failure-diagnostics.json'), `${JSON.stringify(diagnostics, null, 2)}\n`, 'utf8');
  return diagnostics;
}

(async () => {
  fs.mkdirSync(OUTPUT, { recursive: true });
  seedFormalLeague();
  const port = await freePort();
  let hub = null;
  let client = null;
  let completed = false;
  try {
    hub = await launchIsolatedHub({
      dataDir: path.join(TEMP_ROOT, 'hub-data'),
      port,
      label: 'agent-league-virtual-live',
      windowMode: 'hidden',
      extraEnv: { CHUXIN_AGENT_LEAGUE_DIR: LEAGUE_ROOT },
    });
    client = await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/.test(target.url || ''));
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
    await openLeague(client);
    await waitEval(client, `document.querySelector('[data-agent-row="${AGENT_ID}"]')`, 'formal Agent row');
    await client.eval(`(() => {
      window.__agentLeagueVirtualErrors = [];
      window.addEventListener('error', event => window.__agentLeagueVirtualErrors.push(String(event.error || event.message)));
      window.addEventListener('unhandledrejection', event => window.__agentLeagueVirtualErrors.push(String(event.reason)));
    })()`);
    const formalShot = await screenshot(client, '01-formal-before.png');

    await client.eval(`document.querySelector('[data-action="toggle-virtual"]').click()`);
    await waitEval(client, `document.querySelector('.cxl-root.virtual-mode') && !document.querySelector('[data-role="virtual-lab"]').hidden && document.querySelector('[data-agent-row="${AGENT_ID}"]') && /_virtual_debug$/.test(document.querySelector('[data-role="root-path"]').textContent)`, 'virtual lab initialized', 60000);
    const virtualUi = await client.eval(`(() => ({
      title: document.querySelector('[data-role="league-title"]').textContent,
      date: document.querySelector('[data-role="virtual-date"]').textContent,
      phase: document.querySelector('[data-role="virtual-phase"]').textContent,
      root: document.querySelector('[data-role="root-path"]').textContent,
      note: document.querySelector('[data-role="league-note"]').textContent,
    }))()`);
    assert.equal(virtualUi.title, 'Agent 联赛 · 虚拟实盘');
    assert.equal(virtualUi.date, VIRTUAL_DATE);
    assert.match(virtualUi.root, /_virtual_debug$/);
    assert.match(virtualUi.note, /不读取真实开收盘/);
    await client.eval(`document.querySelector('[data-action="self-test-virtual"]').click()`);
    await waitEval(client, `document.querySelector('[data-role="virtual-status"]').textContent.includes('账本自检 PASS')`, 'virtual self-test PASS', 30000);
    const premarketShot = await screenshot(client, '02-virtual-premarket-selftest.png');

    await client.eval(`document.querySelector('[data-action="run-day"]').click()`);
    const decided = await waitEval(client, `(async()=>{
      const value=await require('electron').ipcRenderer.invoke('agent-league-virtual:list',{});
      return !value.run && value.schedule.lastRunStatus==='completed' ? value : null;
    })()`, 'real Codex virtual DRAFT and Hook', REAL_TURN_TIMEOUT_MS);
    const decidedAgent = decided.agents.find((row) => row.id === AGENT_ID);
    assert(decidedAgent.latestDaily && decidedAgent.latestDaily.hook, 'real Codex Hook missing');
    assert.equal(decidedAgent.latestDaily.hook.verdict, 'PASS');
    assert.equal(decidedAgent.latestDaily.decision.targets[0].symbol, '600001.SH');
    assert.equal(decidedAgent.latestDaily.decision.targets[0].target_weight, 0.3);
    assert.equal(decidedAgent.latestDaily.decision.cash_target, 0.7);
    assert(decidedAgent.session.nativeSession.codexSid, 'real Codex native SID missing');

    await openLeague(client);
    await waitEval(client, `document.querySelector('[data-action="execute-open"]') && !document.querySelector('[data-action="execute-open"]').disabled`, 'virtual open button enabled', 30000);
    await client.eval(`document.querySelector('[data-action="execute-open"]').click()`);
    const opened = await waitEval(client, `(async()=>{
      const value=await require('electron').ipcRenderer.invoke('agent-league-virtual:list',{});
      return value.schedule.lastExecutionDate===${JSON.stringify(VIRTUAL_DATE)} ? value : null;
    })()`, 'virtual open accounting', 90000);
    const openedAgent = opened.agents.find((row) => row.id === AGENT_ID);
    assert(openedAgent.recentTrades.length >= 1);
    assert(openedAgent.portfolio.positions.length >= 1);

    await openLeague(client);
    await waitEval(client, `document.querySelector('[data-action="record-close"]') && !document.querySelector('[data-action="record-close"]').disabled`, 'virtual close button enabled', 30000);
    await client.eval(`document.querySelector('[data-action="record-close"]').click()`);
    const closed = await waitEval(client, `(async()=>{
      const value=await require('electron').ipcRenderer.invoke('agent-league-virtual:list',{});
      return value.schedule.lastResultDate===${JSON.stringify(VIRTUAL_DATE)} ? value : null;
    })()`, 'virtual close accounting', 90000);
    const closedAgent = closed.agents.find((row) => row.id === AGENT_ID);
    const accounting = assertAccounting(closedAgent);

    await openLeague(client);
    await waitEval(client, `document.querySelector('[data-role="virtual-phase"]').textContent.includes('当日已收盘')`, 'closed virtual phase', 30000);
    await client.eval(`document.querySelector('[data-agent-row="${AGENT_ID}"]').click()`);
    await waitEval(client, `!document.querySelector('[data-role="detail-overlay"]').hidden && document.querySelector('.cxl-holdings')`, 'virtual result drawer', 30000);
    const resultShot = await screenshot(client, '03-virtual-result.png');
    await client.eval(`document.querySelector('[data-action="close-detail"]').click()`);

    const formalAfter = await client.eval(`require('electron').ipcRenderer.invoke('agent-league:list', {})`);
    const formalAgent = formalAfter.agents.find((row) => row.id === AGENT_ID);
    assert.equal(formalAgent.decisionCount, 0);
    assert.equal(formalAgent.recentTrades.length, 0);
    assert.equal(formalAgent.stats.nav, 500000);
    assert.equal(formalAgent.portfolio.positions.length, 0);

    await client.eval(`document.querySelector('[data-action="advance-virtual"]').click()`);
    await waitEval(client, `document.querySelector('[data-role="virtual-date"]').textContent==='2026-09-01' && document.querySelector('[data-role="virtual-phase"]').textContent.includes('盘前待决策')`, 'next virtual trading day', 30000);
    const advancedShot = await screenshot(client, '04-virtual-next-day.png');
    assert.deepEqual(await client.eval('window.__agentLeagueVirtualErrors'), []);

    const summary = {
      ok: true,
      pid: hub.pid,
      cdpPort: port,
      virtualDate: VIRTUAL_DATE,
      nextVirtualDate: '2026-09-01',
      sessionId: closedAgent.session.hubSessionId,
      codexSid: closedAgent.session.nativeSession.codexSid,
      hookVerdict: closedAgent.latestDaily.hook.verdict,
      decision: closedAgent.latestDaily.decision,
      trades: closedAgent.recentTrades,
      stats: closedAgent.stats,
      accounting,
      formalUnchanged: {
        decisionCount: formalAgent.decisionCount,
        tradeCount: formalAgent.recentTrades.length,
        nav: formalAgent.stats.nav,
      },
      selfTest: await client.eval(`require('electron').ipcRenderer.invoke('agent-league:virtual-self-test')`),
      screenshots: [formalShot, premarketShot, resultShot, advancedShot],
      output: OUTPUT,
    };
    fs.writeFileSync(path.join(OUTPUT, 'virtual-live-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    const daily = path.join(LEAGUE_ROOT, '_virtual_debug', 'agents', AGENT_ID, 'daily', `${VIRTUAL_DATE}.md`);
    if (fs.existsSync(daily)) fs.copyFileSync(daily, path.join(OUTPUT, 'virtual-live-daily.md'));
    completed = true;
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    if (!completed && client && hub) {
      try { await collectFailureDiagnostics(client, hub); } catch {}
    }
    if (client) await client.close();
    if (hub) await gracefulQuit(hub);
    safeRemoveTemp();
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
