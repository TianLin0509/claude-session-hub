'use strict';
// Real end-to-end check that the account rings still advance now that the
// status line no longer runs: an isolated Hub, a real Claude engine, and the
// Hub's own refresh IPC. Starting the engine costs no model call.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const ROOT = path.resolve(__dirname, '..');
const RUN = 'claude-native-usage-' + Date.now();
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), RUN));
const OUT = path.join(ROOT, 'artifacts', 'native-agent', RUN);
fs.mkdirSync(OUT, { recursive: true });

async function waitFor(label, fn, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await _waitMs(200); }
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
  const workspace = path.join(TEMP, 'workspace');
  const claudeHome = path.join(TEMP, 'claude');
  for (const directory of [workspace, claudeHome]) fs.mkdirSync(directory, { recursive: true });
  const credentials = path.join(os.homedir(), '.claude', '.credentials.json');
  if (fs.existsSync(credentials)) fs.copyFileSync(credentials, path.join(claudeHome, '.credentials.json'));
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(TEMP, 'data'), port: await freePort(),
      windowMode: 'hidden', label: RUN,
      extraEnv: { CLAUDE_HUB_E2E: '1', CLAUDE_CONFIG_DIR: claudeHome,
        CLAUDE_HUB_HOME_DIR: path.join(TEMP, 'home'), AI_HUB_WORKSPACE_ROOT: TEMP, DEEPSEEK_API_KEY: '' } });
    client = await connectFirstPage(hub, target => target.type === 'page' && /index\.html/.test(target.url));
    await waitFor('renderer', () => client.eval('!!window.__hubE2E && !!window.WorkspaceController'));
    const created = await client.eval(`window.WorkspaceController.createSession('claude', {cwd:${JSON.stringify(workspace)},
      opts:{model:'claude-opus-5[1m]',effort:'max',mcpProfile:'lean'}}).then(s=>({id:s.id}))`);
    const q = JSON.stringify(created.id);
    await waitFor('native connected', () => client.eval(`sessions.get(${q})?.nativeRuntime?.connection==='connected'`));
    const result = await client.eval("ipcRenderer.invoke('refresh-usage-now','claude')");
    const cache = await client.eval("ipcRenderer.invoke('get-usage-cache')");
    fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify({ result, claude: cache.claude }, null, 2), 'utf8');
    const claudeResult = result?.providerResults?.claude || result?.claude || result;
    assert.equal(claudeResult.source, 'claude-native', JSON.stringify(result));
    assert.ok(cache.claude?.usage5h || cache.claude?.usage7d, 'no window was published');
    console.log(JSON.stringify({ pass: true, source: claudeResult.source,
      usage5h: cache.claude.usage5h, usage7d: cache.claude.usage7d, evidence: OUT }));
  } finally {
    if (client) try { await client.close(); } catch { /* already gone */ }
    if (hub) await gracefulQuit(hub);
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
