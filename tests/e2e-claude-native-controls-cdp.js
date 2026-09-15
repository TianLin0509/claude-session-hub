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
const lateControl = process.argv.includes('--late-control');
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
        CLAUDE_HUB_FIXTURE_CONFIG_DIR: path.join(TEMP, 'launch'),
        CLAUDE_HUB_CLAUDE_STREAM_FIXTURE: path.join(ROOT, 'tests', 'fixtures', 'claude-stream.js'),
        CLAUDE_HUB_CLAUDE_FIXTURE_MODE: lateControl ? 'late-fast-control' : 'normal',
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

    // The 后台 button must actually switch to the backstage and back. Output in
    // the ring buffer is not enough: the view switch itself used to be blocked
    // for native Claude, so the button did nothing.
    const view = () => client.eval(`({view: currentView,
      pressed: document.getElementById('btn-backstage')?.getAttribute('aria-pressed'),
      buttonHidden: document.getElementById('btn-backstage')?.hidden,
      overlayHidden: document.getElementById('msg-overlay')?.classList.contains('hidden')})`);
    await client.eval(`applyViewMode('card')`);
    ok('backstage button is offered for a native Claude session', (await view()).buttonHidden === false, await view());
    await client.eval(`document.getElementById('btn-backstage').click()`);
    const pty = await waitFor('backstage view shown', async () => {
      const value = await view();
      return value.view === 'pty' ? value : null;
    });
    ok('clicking 后台 opens the backstage', pty.pressed === 'true' && pty.overlayHidden === true, pty);
    const screen = await client.eval(`(() => { const t=terminalCache.get(${q})?.terminal; if(!t) return '';
      const b=t.buffer.active; const out=[]; for(let y=0;y<b.length;y++){const l=b.getLine(y); if(l) out.push(l.translateToString(true));}
      return out.join('\\n'); })()`);
    ok('the backstage terminal shows engine output', /Claude/.test(screen), screen.slice(0, 160));
    await client.eval(`document.getElementById('btn-backstage').click()`);
    await waitFor('back to cards', async () => (await view()).view === 'card');
    checks.push('clicking 后台 again returns to the card view');

    const chip = () => client.eval(`(() => { const el=document.querySelector('.composer-speed-chip,.composer-chip.composer-speed');
      return el ? {hidden:el.hidden,text:el.textContent.trim(),pressed:el.getAttribute('aria-pressed')} : null; })()`);
    const speed = await waitFor('speed chip painted', async () => {
      const value = await chip();
      return value && !value.hidden ? value : null;
    });
    // The engine said fast mode is off, so the chip must say so too.
    ok('speed chip reflects the engine standard tier', /标准/.test(speed.text) && speed.pressed === 'false', speed);

    if (lateControl) {
      await client.eval(`window.lateControlResult=null;ipcRenderer.invoke('session:set-fast',{sessionId:${q},enabled:true}).then(r=>window.lateControlResult=r);void 0`);
      await waitFor('unknown configuration is visible',()=>client.eval(`sessions.get(${q})?.nativeRuntime?.configurationChange?.status==='unknown'
        && document.querySelector('.claude-native-notice')?.innerText.includes('设置结果待核对')`),90000);
      ok('timeout keeps actual Fast unchanged',await client.eval(`sessions.get(${q}).nativeRuntime.fastMode===false`));
      const unknownShot=await client.send('Page.captureScreenshot',{format:'png'});
      fs.writeFileSync(path.join(OUT,'late-control-unknown.png'),Buffer.from(unknownShot.data,'base64'));
      await waitFor('late confirmation clears configuration barrier',()=>client.eval(`sessions.get(${q})?.nativeRuntime?.fastMode===true && !sessions.get(${q}).nativeRuntime.configurationChange`));
      ok('late native confirmation updates the same session without replay',true);
    } else {
      const switched = await client.eval(`ipcRenderer.invoke('session:set-fast',{sessionId:${q},enabled:true})`);
      ok('Main confirms the protocol switch', switched.ok === true && switched.result.fastMode === true, switched);
    }
    const fast = await waitFor('chip flips to Fast', async () => {
      const value = await chip();
      return value && /Fast/.test(value.text) ? value : null;
    });
    ok('speed chip follows the confirmed tier', fast.pressed === 'true', fast);
    ok('session keeps the confirmed tier', (await client.eval(`sessions.get(${q}).nativeRuntime.fastMode`)) === true);
    // The relaunch overlay must carry the new tier, or a reconnect silently
    // drops back to the launch value.
    const nativePid=await client.eval(`sessions.get(${q}).nativeRuntime.childPid`);
    const launched=JSON.parse(fs.readFileSync(path.join(TEMP,'launch',nativePid+'.json'),'utf8'));
    const overlay=path.resolve(launched.args[launched.args.indexOf('--settings')+1]);
    assert(overlay.startsWith(TEMP+path.sep),'settings read must stay inside the isolated test');
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
    // The plan-mode banner is the same control Codex shows: mounted only while
    // the mode is on, and its reset button switches the engine back.
    await waitFor('plan banner mounted', () => client.eval(
      `(() => { const box=document.querySelector('.claude-native-controls .codex-native-mode'); return !!box && !document.querySelector('.claude-native-controls').hidden; })()`));
    await client.eval(`document.querySelector('.claude-native-controls .codex-native-mode button').click()`);
    await waitFor('default mode restored by the banner', () => client.eval(`sessions.get(${q})?.nativeRuntime?.permissionMode==='default'`));
    ok('plan banner unmounts once the mode is reset', !(await client.eval(`!!document.querySelector('.claude-native-controls .codex-native-mode')`)));

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
