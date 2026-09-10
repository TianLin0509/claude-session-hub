'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const ROOT = path.resolve(__dirname, '..');
const MODE = process.argv.find(value => value.startsWith('--mode='))?.split('=')[1] || 'approval';
const RUN = 'claude-native-' + MODE + '-' + Date.now();
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), RUN));
const OUT = path.join(ROOT, 'artifacts', 'native-agent', RUN);
fs.mkdirSync(OUT, { recursive: true });
async function waitFor(label, fn, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await _waitMs(100); }
  throw new Error('Timeout: ' + label);
}
async function freePort() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function main() {
  let hub, client, sid;
  const checks = [];
  const workspace = path.join(TEMP, 'workspace');
  const claudeHome = path.join(TEMP, 'claude');
  const codexHome = path.join(TEMP, 'codex');
  for (const directory of [workspace, claudeHome, codexHome]) fs.mkdirSync(directory, { recursive: true });
  const configOptions = MODE === 'recovery' ? { permissionMode: 'plan',
    appendSystemPromptFile: path.join(workspace, 'instructions.txt'),
    addDirs: [workspace], settingSources: ['project', 'local'] } : {};
  if (configOptions.appendSystemPromptFile) fs.writeFileSync(configOptions.appendSystemPromptFile, 'Keep the configured scope.\n', 'utf8');
  async function state() {
    return client.eval(`({session:sessions.get(${JSON.stringify(sid)}),delivery:floatingPromptDeliveries.get(${JSON.stringify(sid)}),
      controls:document.querySelector('.claude-native-controls')?.innerText,
      composer:document.querySelector('.composer-status')?.innerText,
      card:document.querySelector('.msg-overlay')?.innerText})`);
  }
  async function shot(name) {
    const result = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(result.data, 'base64'));
  }
  async function click(selector) {
    const box = await client.eval(`(() => { const e=document.querySelector(${JSON.stringify(selector)});
      if (!e) throw Error('Missing element'); const r=e.getBoundingClientRect();
      return {x:r.x+r.width/2,y:r.y+r.height/2,text:e.textContent}; })()`);
    assert.ok(box.x > 0 && box.y > 0);
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  }
  try {
    const launchOptions = { dataDir: path.join(TEMP, 'data'), port: await freePort(), windowMode: 'hidden', label: RUN,
      extraEnv: { CLAUDE_HUB_E2E: '1', CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome,
        CLAUDE_HUB_HOME_DIR: path.join(TEMP, 'home'), AI_HUB_WORKSPACE_ROOT: TEMP,
        CLAUDE_HUB_CLAUDE_STREAM_FIXTURE: path.join(ROOT, 'tests', 'fixtures', 'claude-stream.js'),
        CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE: path.join(ROOT, 'tests', 'fixtures', 'codex-app-server.js'),
        CLAUDE_HUB_FIXTURE_CONFIG_DIR: path.join(OUT, 'launch-config'),
        CLAUDE_HUB_CLAUDE_FIXTURE_MODE: MODE === 'recovery' ? 'crash-once' : MODE, DEEPSEEK_API_KEY: '' },
    };
    hub = await launchIsolatedHub(launchOptions);
    client = await connectFirstPage(hub, target => target.type === 'page' && /index\.html/.test(target.url));
    await waitFor('renderer', () => client.eval('!!window.__hubE2E && !!window.WorkspaceController'));
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    const created = await client.eval(`window.WorkspaceController.createSession('claude', {cwd:${JSON.stringify(workspace)},
      opts:{model:'claude-opus-5[1m]',effort:'max',mcpProfile:'lean',fastMode:false,...${JSON.stringify(configOptions)}}}).then(s=>({id:s.id}))`);
    sid = created.id;
    await waitFor('session', () => client.eval(`sessions.has(${JSON.stringify(sid)})`));
    await client.eval(`window.__hubE2E.selectSession(${JSON.stringify(sid)}, {forceScrollBottom:true})`);
    await waitFor('native ready', async () => (await state()).session?.nativeRuntime?.connection === 'connected');
    if (MODE === 'recovery') assert.deepEqual((await state()).session.nativeConfig, configOptions);
    await shot('ready');
    const prompt = '  第一行 🧪\n' + Array.from({ length: 600 }, (_, i) => `- 材料 ${i + 1}：编号与换行`).join('\n') + '\n末行  ';
    await client.eval(`document.querySelector('.floating-input-box').focus()`);
    await client.send('Input.insertText', { text: prompt });
    const actual = await client.eval("readContenteditablePlainText(document.querySelector('.floating-input-box'))");
    assert.equal(actual, prompt);
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    if (MODE === 'recovery') {
      await waitFor('unknown receipt after crash', async () => (await state()).session.nativeRuntime.state === 'unknown'
        && (await state()).session.nativeRuntime.connection === 'disconnected');
      await shot('unknown');
      const oldIdentity = (await state()).session.nativeRuntime.submission.userMessageId;
      await click('.claude-reconnect');
      await waitFor('recovery records', () => client.eval("!!document.querySelector('.claude-reconcile')"));
      await click('.claude-native-controls summary');
      await click('.claude-recovery-copy');
      assert.equal(await client.eval("readContenteditablePlainText(document.querySelector('.floating-input-box'))"), prompt);
      await shot('reconcile');
      await click('.claude-reconcile');
      await waitFor('explicit acknowledgement', async () => (await state()).session.nativeRuntime.state === 'idle');
      await client.eval("document.querySelector('.floating-input-box').focus()");
      await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await waitFor('new identity', async () => (await state()).session.nativeRuntime.submission?.userMessageId !== oldIdentity);
      checks.push('crash stays unknown; actual reconnect and reconcile buttons do not resend; Enter sends a new identity');
    }
    await waitFor('exact receipt', async () => (await state()).delivery?.status === 'confirmed');
    checks.push('real Hub composer -> Main -> OS pipe fixture -> exact receipt');
    assert.equal(await client.eval("document.activeElement === document.querySelector('.floating-input-box')"), true);
    if (MODE === 'hold') {
      await client.send('Input.insertText', { text: '下一条草稿，保留焦点' });
      assert.equal(await client.eval("readContenteditablePlainText(document.querySelector('.floating-input-box'))"), '下一条草稿，保留焦点');
      assert.equal((await state()).session.nativeRuntime.state, 'starting');
      await shot('draft-while-starting');
      await click('.floating-input-stop');
      await waitFor('protocol interruption', async () => (await state()).session.nativeRuntime.state === 'interrupted');
      assert.equal(await client.eval("document.activeElement === document.querySelector('.floating-input-box')"), true);
      await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      assert.equal(await client.eval("document.activeElement === document.querySelector('.floating-input-box')"), true);
      assert.equal(await client.eval("readContenteditablePlainText(document.querySelector('.floating-input-box'))"), '下一条草稿，保留焦点');
      await shot('interrupted');
      checks.push('typing after send stays in composer; real stop button uses protocol and preserves the next draft');
    }
    if (['approval', 'question'].includes(MODE)) {
      await waitFor('request UI', async () => (await state()).session.nativeRuntime.state === 'waiting');
      await shot('waiting');
      if (MODE === 'question') {
        await click('.claude-native-controls input');
        await client.send('Input.insertText', { text: '甲' });
        await click('.claude-native-controls button[type=submit]');
      } else await click('.claude-native-controls button[type=button]');
      checks.push(MODE === 'question' ? 'native question answered using actual GUI form' : 'native approval denied using actual GUI button');
    }
    if (MODE !== 'hold') {
    await waitFor('completed', async () => (await state()).session.nativeRuntime.state === 'completed');
    await waitFor('visible answer card', async () => (await state()).card?.includes('完成 🧪'));
    const transcript = await client.eval(`ipcRenderer.invoke('parse-session-transcript',{hubSessionId:${JSON.stringify(sid)}})`);
    assert.equal(transcript.turns.find(turn => turn.role === 'user').text, prompt);
    assert.ok(transcript.turns.some(turn => turn.role === 'assistant' && turn.text.includes('完成')));
    await shot('completed');
    checks.push('native transcript retains 600 lines and final answer');
    const orderedRoles = await client.eval("[...document.querySelectorAll('#msg-overlay > .turn-card')].map(e=>e.classList.contains('user')?'user':'assistant')");
    if (MODE === 'background' || MODE === 'interleaved') {
      await waitFor('separate visible background card', async () => (await state()).card?.includes('后台任务独立回答 🧩'));
      const fresh = await client.eval(`ipcRenderer.invoke('parse-session-transcript',{hubSessionId:${JSON.stringify(sid)}})`);
      assert.equal(fresh.turns.filter(turn => turn.role === 'user').length, 1);
      assert.equal(fresh.turns.filter(turn => turn.nativeActivity).length, 1);
      assert.equal(fresh.turns.find(turn => !turn.nativeActivity && turn.role === 'assistant').text, '完成 🧪');
      await shot('background-completed');
      checks.push('human answer and injected continuation have separate visible cards and one human receipt');
      await client.close(); client = null;
      await gracefulQuit(hub); fs.writeFileSync(path.join(OUT, 'first-hub.log'), hub.log().join('\n'), 'utf8'); hub = null;
      hub = await launchIsolatedHub({ ...launchOptions, port: await freePort(), label: RUN + '-restart' });
      client = await connectFirstPage(hub, target => target.type === 'page' && /index\.html/.test(target.url));
      await waitFor('restored session list', () => client.eval(`!!window.__hubE2E && sessions.has(${JSON.stringify(sid)})`));
      await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
      await client.eval(`window.__hubE2E.selectSession(${JSON.stringify(sid)}, {forceScrollBottom:true})`);
      await waitFor('restored background answer', async () => (await state()).card?.includes('后台任务独立回答 🧩'));
      const after = await client.eval(`ipcRenderer.invoke('parse-session-transcript',{hubSessionId:${JSON.stringify(sid)}})`);
      assert.equal(after.turns.filter(turn => turn.role === 'user').length, 1);
      assert.equal(after.turns.filter(turn => turn.nativeActivity).length, 1);
      await shot('background-restored');
      checks.push('whole Hub restart retains the background activity without replaying it as a user prompt');
    } else if (MODE === 'recovery') assert.equal(transcript.turns.filter(turn => turn.role === 'user').length, 2);
    else assert.deepEqual(orderedRoles, ['user', 'assistant']);
    if (MODE === 'normal' || MODE === 'mixed') {
      const secondSlot = MODE === 'mixed'
        ? { kind: 'codex', model: 'gpt-6-astra', effort: 'xhigh', mcpProfile: 'none', codexSpeedTier: 'fast' }
        : { kind: 'claude', model: 'claude-opus-5[1m]', effort: 'max', mcpProfile: 'lean', fastMode: false };
      const meeting = await client.eval(`ipcRenderer.invoke('create-meeting', {title:'Claude native group',scene:'general',
        workspace:${JSON.stringify(workspace)},slots:[{kind:'claude',model:'claude-opus-5[1m]',effort:'max',mcpProfile:'lean',fastMode:false},
        ${JSON.stringify(secondSlot)}]})`);
      assert.equal(meeting.subSessions.length, 2);
      await client.eval(`window.MeetingRoom.openMeeting(${JSON.stringify(meeting.id)},${JSON.stringify(meeting)})`);
      await waitFor('group composer', () => client.eval("!!document.getElementById('mr-input-box')"));
      await click('#mr-input-box');
      await client.send('Input.insertText', { text: '两位分别回答本条消息。' });
      await click('#mr-send-btn');
      const groupState = await waitFor('two group answers', async () => {
        const state = await client.eval(`ipcRenderer.invoke('groupchat:get-state',{meetingId:${JSON.stringify(meeting.id)}})`);
        return state?.currentMode === 'idle' && Object.values(state.turns?.at(-1)?.byStatus || {}).filter(s => s === 'completed').length === 2 ? state : null;
      });
      await waitFor('visible group answers', () => client.eval("document.querySelector('.mr-gc-shell')?.innerText.includes('完成')"));
      fs.writeFileSync(path.join(OUT, 'group.json'), JSON.stringify(groupState, null, 2), 'utf8');
      await shot('group-completed');
      checks.push((MODE === 'mixed' ? 'Claude and Codex native members' : 'two native Claude members') + ' finish through real group composer and dispatcher');
    }
    if (MODE === 'recovery') {
      await client.eval("document.querySelector('.floating-input-box').focus()");
      await client.send('Input.insertText', { text: '重启后继续写这条草稿' });
      await waitFor('session metadata saved', () => fs.existsSync(path.join(TEMP, 'data', 'sessions', sid + '.json')));
      await client.close(); client = null;
      await gracefulQuit(hub); fs.writeFileSync(path.join(OUT, 'first-hub.log'), hub.log().join('\n'), 'utf8'); hub = null;
      hub = await launchIsolatedHub({ ...launchOptions, port: await freePort(), label: RUN + '-restart' });
      client = await connectFirstPage(hub, target => target.type === 'page' && /index\.html/.test(target.url));
      await waitFor('restored session list', () => client.eval(`!!window.__hubE2E && typeof sessions !== 'undefined' && sessions.has(${JSON.stringify(sid)})`));
      await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
      await client.eval(`window.__hubE2E.selectSession(${JSON.stringify(sid)}, {forceScrollBottom:true})`);
      await waitFor('native restarted', async () => (await state()).session?.nativeRuntime?.connection === 'connected');
      assert.deepEqual((await state()).session.nativeConfig, configOptions);
      await waitFor('restored draft', () => client.eval("document.querySelector('.floating-input-box')?.innerText === '重启后继续写这条草稿'"));
      const after = await client.eval(`ipcRenderer.invoke('parse-session-transcript',{hubSessionId:${JSON.stringify(sid)}})`);
      assert.equal(after.turns.filter(turn => turn.role === 'user').length, 2);
      assert.ok(after.turns.some(turn => turn.role === 'assistant' && turn.text.includes('完成')));
      await shot('hub-restarted');
      checks.push('whole Hub restart retains draft and both prior identities with no replay');
      const forkResult = await client.eval(`ipcRenderer.invoke('fork-session',{sourceSessionId:${JSON.stringify(sid)}})`);
      assert.equal(forkResult.ok, true, JSON.stringify(forkResult));
      const fork = forkResult.session;
      await waitFor('fork configuration', () => client.eval(`sessions.get(${JSON.stringify(fork.id)})?.nativeRuntime?.connection === 'connected'`));
      const forkSession = await client.eval(`sessions.get(${JSON.stringify(fork.id)})`);
      assert.deepEqual(forkSession.nativeConfig, configOptions);
      assert.equal(forkSession.effort, 'max'); assert.equal(forkSession.fastMode, false);
      assert.notEqual(forkSession.ccSessionId, (await state()).session.ccSessionId);
      const captures = fs.readdirSync(path.join(OUT, 'launch-config')).map(file =>
        JSON.parse(fs.readFileSync(path.join(OUT, 'launch-config', file), 'utf8')));
      assert.equal(captures.length, 4, 'initial process, reconnect, Hub restart and fork');
      for (const capture of captures) {
        for (const [flag, value] of [['--permission-mode', 'plan'], ['--effort', 'max'],
          ['--append-system-prompt-file', configOptions.appendSystemPromptFile],
          ['--add-dir', workspace], ['--setting-sources', 'project,local']]) {
          assert.equal(capture.args[capture.args.indexOf(flag) + 1], value, flag);
        }
        assert.equal(capture.settings.fastMode, false);
      }
      checks.push('non-default permissions, instruction file, directories and setting sources survive Hub restart and native fork');
    }
    }
    const snapshot = await state();
    fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify({ mode: MODE, controlledProtocol: true,
      realModel: false, checks, snapshot, temp: TEMP, pid: hub.pid }, null, 2), 'utf8');
    console.log('PASS ' + checks.length + ' checks; ' + OUT);
  } catch (error) {
    if (client) {
      try { fs.writeFileSync(path.join(OUT, 'failure.json'), JSON.stringify(await state(), null, 2), 'utf8'); await shot('failure'); }
      catch (diagnosticError) { console.error('Diagnostic capture failed:', diagnosticError.message); }
    }
    throw error;
  } finally {
    if (client) await client.close();
    if (hub) { await gracefulQuit(hub); fs.writeFileSync(path.join(OUT, 'hub.log'), hub.log().join('\n'), 'utf8'); }
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
