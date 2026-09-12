'use strict';
// Visual evidence for the Claude card view: a real isolated Hub, the real
// renderer and the real engine running one short tool-using turn.
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const ROOT = path.resolve(__dirname, '..');
const RUN = 'claude-card-shot-' + Date.now();
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), RUN));
const OUT = path.join(ROOT, 'artifacts', 'native-agent', RUN);
fs.mkdirSync(OUT, { recursive: true });

async function waitFor(label, fn, timeout = 180000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await _waitMs(250); }
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
  fs.writeFileSync(path.join(workspace, 'note.txt'), 'CARD_SHOT_MARKER\n', 'utf8');
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(TEMP, 'data'), port: await freePort(),
      windowMode: 'hidden', label: RUN,
      extraEnv: { CLAUDE_HUB_E2E: '1', CLAUDE_CONFIG_DIR: claudeHome,
        CLAUDE_HUB_HOME_DIR: path.join(TEMP, 'home'), AI_HUB_WORKSPACE_ROOT: TEMP, DEEPSEEK_API_KEY: '' } });
    client = await connectFirstPage(hub, target => target.type === 'page' && /index\.html/.test(target.url));
    await waitFor('renderer', () => client.eval('!!window.__hubE2E && !!window.WorkspaceController'), 60000);
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false });
    const created = await client.eval(`window.WorkspaceController.createSession('claude', {cwd:${JSON.stringify(workspace)},
      opts:{model:'claude-opus-5[1m]',effort:'low',mcpProfile:'lean',permissionMode:'bypassPermissions'}}).then(s=>({id:s.id}))`);
    const q = JSON.stringify(created.id);
    await waitFor('session', () => client.eval(`sessions.has(${q})`), 60000);
    await client.eval(`window.__hubE2E.selectSession(${q}, {forceScrollBottom:true})`);
    await waitFor('connected', () => client.eval(`sessions.get(${q})?.nativeRuntime?.connection==='connected'`), 60000);
    await client.eval(`document.querySelector('.floating-input-box').focus()`);
    await client.send('Input.insertText', { text: '读一下 note.txt，然后只回复文件里的那个标记词，不要做别的事。' });
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await waitFor('turn completed', () => client.eval(`sessions.get(${q})?.nativeRuntime?.state==='completed'`));
    await _waitMs(1500);
    const turns = await client.eval(`ipcRenderer.invoke('parse-session-transcript',{hubSessionId:${q}}).then(r=>r.turns.map(t=>({
      role:t.role,phase:t.phase,model:t.model||null,usage:t.usage||null,ts:t.ts||null,tsEnd:t.tsEnd||null,
      tools:(t.toolCalls||[]).map(c=>({name:c.name,status:c.status,durationMs:c.durationMs||null})),
      rows:(t.displayMessages||[]).map(m=>({phase:m.phase,ts:m.ts}))})))`);
    fs.writeFileSync(path.join(OUT, 'turns.json'), JSON.stringify(turns, null, 2), 'utf8');
    const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(OUT, 'card.png'), Buffer.from(shot.data, 'base64'));
    console.log(JSON.stringify({ pass: true, out: OUT, assistant: turns.find(t => t.role === 'assistant') }));
  } finally {
    if (client) try { await client.close(); } catch { /* already gone */ }
    if (hub) await gracefulQuit(hub);
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
