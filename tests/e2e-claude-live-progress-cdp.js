'use strict';
// A long, silent native Claude turn (many tool calls, no prose) must still
// look alive like a Codex turn: the composer names the tool in flight, the
// activity group grows while it runs, and the finished card shows every call
// and the final answer -- whether the user stayed on the session or switched
// away and came back. Real isolated Hub, real renderer, protocol fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const ROOT = path.resolve(__dirname, '..');
const TOOL_COUNT = 30;
const RUN = 'claude-live-progress-' + Date.now();
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), RUN));
const OUT = path.join(ROOT, 'artifacts', 'native-agent', RUN);
fs.mkdirSync(OUT, { recursive: true });

async function waitFor(label, fn, timeout = 30000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await _waitMs(100); }
  throw new Error('Timeout: ' + label + ' (last=' + JSON.stringify(last) + ')');
}
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function main() {
  let hub, client;
  const checks = [];
  const ok = (name, condition, detail) => {
    assert.ok(condition, name + (detail === undefined ? '' : ' — ' + JSON.stringify(detail)));
    checks.push(name);
  };
  const workspace = path.join(TEMP, 'workspace');
  const claudeHome = path.join(TEMP, 'claude');
  for (const directory of [workspace, claudeHome]) fs.mkdirSync(directory, { recursive: true });
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(TEMP, 'data'), port: await freePort(),
      windowMode: 'hidden', label: RUN,
      extraEnv: { CLAUDE_HUB_E2E: '1', CLAUDE_CONFIG_DIR: claudeHome,
        CLAUDE_HUB_HOME_DIR: path.join(TEMP, 'home'), AI_HUB_WORKSPACE_ROOT: TEMP,
        CLAUDE_HUB_CLAUDE_STREAM_FIXTURE: path.join(ROOT, 'tests', 'fixtures', 'claude-stream.js'),
        CLAUDE_HUB_CLAUDE_FIXTURE_MODE: 'many-tools',
        CLAUDE_HUB_FIXTURE_TOOL_COUNT: String(TOOL_COUNT), CLAUDE_HUB_FIXTURE_TOOL_GAP_MS: '80',
        DEEPSEEK_API_KEY: '' } });
    client = await connectFirstPage(hub, target => target.type === 'page' && /index\.html/.test(target.url));
    await waitFor('renderer', () => client.eval('!!window.__hubE2E && !!window.WorkspaceController'));
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

    const create = () => client.eval(`window.WorkspaceController.createSession('claude', {cwd:${JSON.stringify(workspace)},
      opts:{model:'claude-opus-5[1m]',mcpProfile:'lean'}}).then(s=>s.id)`);
    const cardState = id => client.eval(`(() => {
      const s = sessions.get(${JSON.stringify('__ID__')}.replace('__ID__', ${JSON.stringify(id)}));
      const cards = [...document.querySelectorAll('#msg-overlay > .turn-card')];
      const text = cards.map(c => c.innerText).join('\\n');
      const activity = text.match(/活动\\s*(\\d+)/g) || [];
      const bar = document.querySelector('.floating-input-bar');
      return { state: s?.nativeRuntime?.state, cards: cards.length,
        activityCounts: activity.map(x => Number(x.replace(/\\D/g, ''))),
        hasFinal: text.includes('全部步骤完成：最终回答'),
        composer: bar?.querySelector('.composer-status, .fi-status, .composer-status-text')?.innerText || '',
        detail: s?.currentCardActivity?.label || '' };
    })()`);
    const send = async text => {
      await client.eval(`document.querySelector('.floating-input-box').focus()`);
      await client.send('Input.insertText', { text });
      await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    };

    // ── A: stay on the session for the whole silent run ──
    const stay = await create();
    await client.eval(`window.__hubE2E.selectSession(${JSON.stringify(stay)}, {forceScrollBottom:true})`);
    await client.eval(`applyViewMode('card')`);
    await waitFor('A connected', () => client.eval(`sessions.get(${JSON.stringify(stay)})?.nativeRuntime?.connection==='connected'`));
    await send('跑一个很长的多步骤任务');
    const samples = [];
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const value = await cardState(stay);
      samples.push({ at: Date.now(), ...value });
      if (value.state === 'completed' && value.hasFinal) break;
      await _waitMs(150);
    }
    await _waitMs(1500);
    const finalA = await cardState(stay);
    fs.writeFileSync(path.join(OUT, 'stay-samples.json'), JSON.stringify(samples, null, 2), 'utf8');
    const running = samples.filter(sample => ['starting', 'running'].includes(sample.state));
    const liveDetail = running.filter(sample => sample.detail);
    const growth = [...new Set(running.flatMap(sample => sample.activityCounts))];
    ok('while running, the composer names the tool in flight', liveDetail.length > 0,
      running.slice(-3).map(({ state, detail, composer }) => ({ state, detail, composer })));
    ok('while running, the activity group grows instead of freezing', growth.length >= 3, growth);
    ok('after completion the card shows every tool call', finalA.activityCounts.includes(TOOL_COUNT), finalA);
    ok('after completion the card shows the final answer', finalA.hasFinal, finalA);

    // ── B: switch away during the run, come back after it finished ──
    const away = await create();
    await client.eval(`window.__hubE2E.selectSession(${JSON.stringify(away)}, {forceScrollBottom:true})`);
    await client.eval(`applyViewMode('card')`);
    await waitFor('B connected', () => client.eval(`sessions.get(${JSON.stringify(away)})?.nativeRuntime?.connection==='connected'`));
    await send('再跑一个很长的多步骤任务');
    await waitFor('B running', () => client.eval(`sessions.get(${JSON.stringify(away)})?.nativeRuntime?.state==='running'`));
    await client.eval(`window.__hubE2E.selectSession(${JSON.stringify(stay)}, {forceScrollBottom:true})`);
    await waitFor('B completed in background', () => client.eval(`sessions.get(${JSON.stringify(away)})?.nativeRuntime?.state==='completed'`));
    await client.eval(`window.__hubE2E.selectSession(${JSON.stringify(away)}, {forceScrollBottom:true})`);
    const finalB = await waitFor('B card caught up', async () => {
      const value = await cardState(away);
      return value.hasFinal && value.activityCounts.includes(TOOL_COUNT) ? value : null;
    }, 15000).catch(async () => cardState(away));
    ok('returning to a session shows the whole finished turn', finalB.hasFinal && finalB.activityCounts.includes(TOOL_COUNT), finalB);

    const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(OUT, 'card.png'), Buffer.from(shot.data, 'base64'));
    fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify({ finalA, finalB, checks }, null, 2), 'utf8');
    console.log('PASS ' + checks.length + ' checks; ' + OUT);
  } finally {
    if (client) try { await client.close(); } catch { /* already gone */ }
    if (hub) await gracefulQuit(hub);
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
