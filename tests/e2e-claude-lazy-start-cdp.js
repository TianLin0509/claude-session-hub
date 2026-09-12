'use strict';
// A native Claude dev seat must hold its identity without spawning an engine,
// and start on its first dispatch. Real isolated Hub, real renderer, protocol
// fixture as the engine.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const ROOT = path.resolve(__dirname, '..');
const RUN = 'claude-lazy-start-' + Date.now();
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), RUN));
const OUT = path.join(ROOT, 'artifacts', 'native-agent', RUN);
fs.mkdirSync(OUT, { recursive: true });

async function waitFor(label, fn, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await _waitMs(100); }
  throw new Error('Timeout: ' + label);
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
        DEEPSEEK_API_KEY: '' } });
    client = await connectFirstPage(hub, target => target.type === 'page' && /index\.html/.test(target.url));
    await waitFor('renderer', () => client.eval('!!window.__hubE2E && !!window.WorkspaceController'));

    const created = await client.eval(`window.WorkspaceController.createSession('claude', {cwd:${JSON.stringify(workspace)},
      opts:{model:'claude-opus-5[1m]',mcpProfile:'lean',lazyStart:true}}).then(s=>({id:s.id}))`);
    const q = JSON.stringify(created.id);
    await waitFor('session', () => client.eval(`sessions.has(${q})`));
    await client.eval(`window.__hubE2E.selectSession(${q}, {forceScrollBottom:true})`);

    // Give the eager-start path every chance to fire before asserting it did not.
    await _waitMs(1500);
    const idle = await client.eval(`(({nativeRuntime,ccSessionId})=>({connection:nativeRuntime.connection,
      state:nativeRuntime.state,reason:nativeRuntime.reason,ccSessionId,childPid:nativeRuntime.childPid}))(sessions.get(${q}))`);
    ok('seat stays unstarted instead of spawning an engine', idle.connection === 'unstarted', idle);
    ok('an unstarted seat is idle, not "待核对"', idle.state === 'idle', idle);
    ok('the seat already owns its session identity', /^[0-9a-f-]{36}$/.test(String(idle.ccSessionId)), idle);
    ok('no engine child is bound yet', !idle.childPid, idle);
    const panel = await client.eval(`document.querySelector('.claude-native-controls')?.innerText || ''`);
    ok('the panel says it has not started', /尚未开始/.test(panel), panel.slice(0, 120));

    // First dispatch starts it, under the same identity.
    await client.eval(`document.querySelector('.floating-input-box').focus()`);
    await client.send('Input.insertText', { text: '第一条派工' });
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    const started = await waitFor('engine started on first dispatch', () => client.eval(
      `(({nativeRuntime,ccSessionId})=>nativeRuntime.connection==='connected'?{ccSessionId,childPid:nativeRuntime.childPid}:null)(sessions.get(${q}))`), 30000);
    ok('first dispatch starts the engine', !!started.childPid, started);
    ok('identity survives the deferred start', started.ccSessionId === idle.ccSessionId, { idle, started });
    await waitFor('turn completes', () => client.eval(`sessions.get(${q})?.nativeRuntime?.state==='completed'`), 30000);
    checks.push('the deferred seat answers normally');

    fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify({ idle, started, checks }, null, 2), 'utf8');
    console.log('PASS ' + checks.length + ' checks; ' + OUT);
  } finally {
    if (client) try { await client.close(); } catch { /* already gone */ }
    if (hub) await gracefulQuit(hub);
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
