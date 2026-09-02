'use strict';

// Opt-in, model-consuming acceptance test. It launches one isolated Hub, uses
// an isolated Agent League vault and asks two real Codex CLIs to complete the
// full DRAFT -> Hook flow concurrently. Production Hub/data are never touched.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

if (process.env.RUN_REAL_AGENT_LEAGUE_E2E !== '1') {
  throw new Error('Set RUN_REAL_AGENT_LEAGUE_E2E=1 to authorize two real Codex Agents (DRAFT plus Hook).');
}

const HUB_ROOT = path.resolve(__dirname, '..');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const TEMP_ROOT = path.join(os.tmpdir(), `agent-league-two-codex-${process.pid}-${STAMP}`);
const LEAGUE_ROOT = path.join(TEMP_ROOT, 'league');
const OUTPUT_ROOT = path.join(HUB_ROOT, 'output', 'verification', `two-codex-${STAMP}`);

function beijingDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function freePort(start = 25480) {
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

async function invoke(client, channel, payload = {}) {
  return client.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(channel)}, ${JSON.stringify(payload)})`);
}

async function waitForPage(hub, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/.test(target.url || ''));
    } catch {
      await _waitMs(250);
    }
  }
  throw new Error('isolated Hub renderer did not become available');
}

function removeTempRoot() {
  const resolved = path.resolve(TEMP_ROOT);
  const temp = path.resolve(os.tmpdir());
  if (!resolved.startsWith(temp + path.sep)) return;
  if (!path.basename(resolved).startsWith('agent-league-two-codex-')) return;
  fs.rmSync(resolved, { recursive: true, force: true });
}

(async () => {
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
  const port = await freePort();
  const decisionDate = String(process.env.AGENT_LEAGUE_E2E_DECISION_DATE || beijingDate());
  const timeoutMs = Math.max(60_000, Number(process.env.AGENT_LEAGUE_E2E_TIMEOUT_MS || 25 * 60_000));
  const agentIds = ['codex-recovery-a', 'codex-recovery-b'];
  let hub = null;
  let client = null;
  const startedAt = Date.now();
  try {
    hub = await launchIsolatedHub({
      dataDir: path.join(TEMP_ROOT, 'hub-data'),
      port,
      label: 'two-real-codex',
      windowMode: 'hidden',
      extraEnv: {
        CHUXIN_AGENT_LEAGUE_DIR: LEAGUE_ROOT,
        CHUXIN_DIR: 'C:\\Users\\lintian\\chuxin-research',
        CHUXIN_API_BASE: 'http://127.0.0.1:3004',
        CHUXIN_WEB_BASE: 'http://127.0.0.1:3003',
      },
    });
    client = await waitForPage(hub);
    await client.send('Runtime.enable');

    for (const [index, agentId] of agentIds.entries()) {
      const created = await invoke(client, 'agent-league:create', {
        id: agentId,
        name: `Codex Recovery ${index + 1}`,
        provider: 'codex-cli',
        model: 'gpt-5.6-sol',
        philosophyKey: index === 0 ? 'chuxin-value-speculation' : 'trend-confirmation',
        initialCash: 500000,
      });
      assert.equal(created.ok, true, JSON.stringify(created));
    }
    const schedule = await invoke(client, 'agent-league:update-schedule', { enabled: false, maxConcurrency: 2 });
    assert.equal(schedule.ok, true, JSON.stringify(schedule));
    const health = await invoke(client, 'agent-league:health', {});
    assert.equal(health.ok, true, JSON.stringify(health));
    assert.equal(health.report.checks.some(check => check.status === 'fail'), false, JSON.stringify(health.report));

    const started = await invoke(client, 'agent-league:run-day', {
      trigger: 'real-two-codex-e2e', force: true, decisionDate, agentIds,
    });
    assert.equal(started.ok, true, JSON.stringify(started));
    console.log(JSON.stringify({ event: 'started', decisionDate, runId: started.run.runId, hubPid: hub.pid }));

    const deadline = Date.now() + timeoutMs;
    let finalState = null;
    let lastProgress = '';
    while (Date.now() < deadline) {
      const state = await invoke(client, 'agent-league:list', {});
      const progress = JSON.stringify({
        status: state.schedule.lastRunStatus,
        active: state.run && state.run.active || [],
        queue: state.run && state.run.queue || [],
        completed: state.run && state.run.completed || [],
        failed: state.run && state.run.failed || [],
        tasks: state.run && state.run.durable && state.run.durable.tasks || [],
      });
      if (progress !== lastProgress) {
        console.log(JSON.stringify({ event: 'progress', elapsedSeconds: Math.round((Date.now() - startedAt) / 1000), ...JSON.parse(progress) }));
        lastProgress = progress;
      }
      if (['completed', 'partial', 'failed'].includes(state.schedule.lastRunStatus) && !state.run) {
        finalState = state;
        break;
      }
      await _waitMs(5000);
    }
    assert(finalState, `two Codex run did not finish within ${timeoutMs}ms`);
    assert.equal(finalState.schedule.lastRunStatus, 'completed', JSON.stringify(finalState.dashboard.current));
    const agents = finalState.agents.filter(row => agentIds.includes(row.id));
    assert.equal(agents.length, 2);
    assert(agents.every(row => row.latestDaily
      && row.latestDaily.stage === 'complete'
      && row.latestDaily.status === 'decision-queued'));
    assert(agents.every(row => row.decisionCount === 1));
    assert.equal(finalState.dashboard.current.technicalForfeits, 0);

    const result = {
      ok: true,
      version: require('../package.json').version,
      decisionDate,
      runId: finalState.schedule.lastRunId,
      hubPid: hub.pid,
      elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
      health: health.report,
      agents: agents.map(row => ({
        id: row.id,
        session: row.session,
        latestDaily: {
          runId: row.latestDaily.runId,
          decisionDate: row.latestDaily.decisionDate,
          dataAsOf: row.latestDaily.dataAsOf,
          stage: row.latestDaily.stage,
          status: row.latestDaily.status,
          verdict: row.latestDaily.hook && row.latestDaily.hook.verdict || '',
        },
        decisionCount: row.decisionCount,
      })),
      dashboard: finalState.dashboard.current,
    };
    const resultPath = path.join(OUTPUT_ROOT, 'result.json');
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify({ event: 'passed', resultPath, ...result }));
  } catch (error) {
    const failure = {
      ok: false,
      message: error.message,
      stack: error.stack,
      hubLogTail: hub && hub.log ? hub.log().slice(-100) : [],
    };
    fs.writeFileSync(path.join(OUTPUT_ROOT, 'failure.json'), JSON.stringify(failure, null, 2), 'utf8');
    throw error;
  } finally {
    if (client) await client.close();
    if (hub) await gracefulQuit(hub);
    removeTempRoot();
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
