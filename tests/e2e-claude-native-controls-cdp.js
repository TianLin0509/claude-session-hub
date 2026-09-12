'use strict';
// GUI evidence for the Claude native speed and working-mode controls: a real
// isolated Hub, the real renderer, and a protocol fixture that answers like the
// installed engine does. No production Hub process or data directory is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const ROOT = path.resolve(__dirname, '..');
const RUN = 'claude-native-controls-' + Date.now();
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), RUN));
const OUT = path.join(ROOT, 'artifacts', 'native-agent', RUN);
fs.mkdirSync(OUT, { recursive: true });

async function waitFor(label, fn, timeout = 20000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await _waitMs(100);
  }
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
  let hub, client, sid;
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
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

    // Start at standard speed so the switch has somewhere to go.
    const created = await client.eval(`window.WorkspaceController.createSession('claude', {cwd:${JSON.stringify(workspace)},
      opts:{model:'claude-opus-5[1m]',effort:'max',mcpProfile:'lean',fastMode:false,permissionMode:'default'}}).then(s=>({id:s.id}))`);
    sid = created.id;
    const q = JSON.stringify(sid);
    await waitFor('session', () => client.eval(`sessions.has(${q})`));
    await client.eval(`window.__hubE2E.selectSession(${q}, {forceScrollBottom:true})`);
    await waitFor('native ready', () => client.eval(`sessions.get(${q})?.nativeRuntime?.connection==='connected'`));

    // The backstage pane used to stay blank for a native Claude session because
    // Main dropped its output. It must carry engine text like Codex's does.
    const backstage = await waitFor('backstage receives native output',
      () => client.eval(`ipcRenderer.invoke('debug:get-session-buffer', ${q}).then(t => t && t.includes('Claude 已连接') ? t : null)`));
    ok('backstage carries engine output instead of staying blank',
      backstage.includes('本页显示引擎原始输出'));
    ok('backstage line endings are terminal-safe', !/[^\r]\n/.test(backstage));

    const chip = () => client.eval(`(() => { const el=document.querySelector('.composer-speed-chip,.composer-chip.composer-speed');
      return el ? {hidden:el.hidden,text:el.textContent.trim(),pressed:el.getAttribute('aria-pressed')} : null; })()`);
    const speed = await waitFor('speed chip painted', async () => {
      const value = await chip();
      return value && !value.hidden ? value : null;
    });
    // The engine said fast mode is off, so the chip must say so too.
    ok('speed chip reflects the engine standard tier', speed.text === '标准' && speed.pressed === 'false', speed);

    const switched = await client.eval(`ipcRenderer.invoke('session:set-fast',{sessionId:${q},enabled:true})`);
    ok('Main confirms the protocol switch', switched.ok === true && switched.result.fastMode === true, switched);
    const fast = await waitFor('chip flips to Fast', async () => {
      const value = await chip();
      return value && value.text === 'Fast' ? value : null;
    });
    ok('speed chip follows the confirmed tier', fast.pressed === 'true', fast);
    ok('session keeps the confirmed tier', (await client.eval(`sessions.get(${q}).nativeRuntime.fastMode`)) === true);
    // The relaunch overlay must carry the new tier, or a reconnect silently
    // drops back to the launch value.
    const overlay = path.join(TEMP, 'data', 'native-agent-settings', sid + '.json');
    ok('relaunch overlay stores the tier', JSON.parse(fs.readFileSync(overlay, 'utf8')).fastMode === true);

    // Slash commands are a command channel: the composer reports the engine's
    // (or the Hub's) result instead of treating it as a prompt to the model.
    await client.eval(`document.querySelector('.floating-input-box').focus()`);
    await client.send('Input.insertText', { text: '/plan' });
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await waitFor('plan mode confirmed', () => client.eval(`sessions.get(${q})?.nativeRuntime?.permissionMode==='plan'`));
    const feedback = await waitFor('command result shown', () => client.eval(
      `(() => { const el=document.querySelector('.codex-command-feedback,.command-feedback'); return el && el.innerText.trim() ? el.innerText : null; })()`));
    ok('composer reports the command result, not a model turn', /计划/.test(feedback), feedback);

    const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(OUT, 'controls.png'), Buffer.from(shot.data, 'base64'));
    fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify({ sid, checks,
      session: await client.eval(`(({id,fastMode,nativeRuntime})=>({id,fastMode,
        runtime:{fastMode:nativeRuntime.fastMode,fastModeBlocked:nativeRuntime.fastModeBlocked}}))(sessions.get(${q}))`) }, null, 2), 'utf8');
    console.log('PASS ' + checks.length + ' checks; ' + OUT);
  } finally {
    if (client) try { await client.close(); } catch { /* already gone */ }
    if (hub) await gracefulQuit(hub);
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
