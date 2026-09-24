'use strict';
// Real isolated Hub, real composer, controlled Claude protocol fixture that
// reproduces 2026-09-24: the engine records the input at once, then the API
// answers 529 for longer than the 60 s confirmation budget before streaming.
// Pass criteria: the receipt comes from the transcript within seconds, the
// composer names the retries, nothing turns "待核对"/"提交失败" at 60 s, and a
// second prompt sent mid-retry queues behind the first instead of killing it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const ROOT = path.resolve(__dirname, '..');
const RUN = 'claude-overload-' + Date.now();
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), RUN));
const OUT = path.join(ROOT, 'artifacts', 'native-agent', RUN);
fs.mkdirSync(OUT, { recursive: true });
const RETRIES = 14, RETRY_MS = 5000; // echo ≈ 75 s after the write, past the 60 s budget

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
  const checks = [], rendererErrors = [];
  const workspace = path.join(TEMP, 'workspace'), claudeHome = path.join(TEMP, 'claude'), codexHome = path.join(TEMP, 'codex');
  for (const directory of [workspace, claudeHome, codexHome]) fs.mkdirSync(directory, { recursive: true });
  const state = () => client.eval(`({session:sessions.get(${JSON.stringify(sid)}),delivery:floatingPromptDeliveries.get(${JSON.stringify(sid)}),
    composer:document.querySelector('.composer-status')?.innerText || '',
    receipts:[...document.querySelectorAll('.turn-card.user[data-submission-id] .turn-prompt-receipt')].map(e=>e.textContent)})`);
  const shot = async name => {
    const result = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(result.data, 'base64'));
  };
  const send = async text => {
    await client.eval(`document.querySelector('.floating-input-box').focus()`);
    await client.send('Input.insertText', { text });
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  };
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(TEMP, 'data'), port: await freePort(), windowMode: 'hidden', label: RUN,
      extraEnv: { CLAUDE_HUB_E2E: '1', CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome,
        CLAUDE_HUB_HOME_DIR: path.join(TEMP, 'home'), AI_HUB_WORKSPACE_ROOT: TEMP, DEEPSEEK_API_KEY: '',
        CLAUDE_HUB_CLAUDE_STREAM_FIXTURE: path.join(ROOT, 'tests', 'fixtures', 'claude-stream.js'),
        CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE: path.join(ROOT, 'tests', 'fixtures', 'codex-app-server.js'),
        CLAUDE_HUB_CLAUDE_FIXTURE_MODE: 'overloaded',
        CLAUDE_HUB_FIXTURE_RETRIES: String(RETRIES), CLAUDE_HUB_FIXTURE_RETRY_MS: String(RETRY_MS) } });
    client = await connectFirstPage(hub, target => target.type === 'page' && /index\.html/.test(target.url));
    client.ws.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.method === 'Runtime.exceptionThrown') rendererErrors.push(message.params.exceptionDetails);
    });
    await client.send('Runtime.enable');
    await waitFor('renderer', () => client.eval('!!window.__hubE2E && !!window.WorkspaceController'));
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    sid = (await client.eval(`window.WorkspaceController.createSession('claude', {cwd:${JSON.stringify(workspace)},
      opts:{model:'claude-opus-5[1m]',effort:'high',mcpProfile:'lean',fastMode:false}}).then(s=>({id:s.id}))`)).id;
    await waitFor('session', () => client.eval(`sessions.has(${JSON.stringify(sid)})`));
    await client.eval(`window.__hubE2E.selectSession(${JSON.stringify(sid)}, {forceScrollBottom:true})`);
    await waitFor('native ready', async () => (await state()).session?.nativeRuntime?.connection === 'connected');
    // Record every Main snapshot so a transient unknown cannot slip between polls.
    await client.eval(`(() => { const id=${JSON.stringify(sid)}; window.overloadTrace=[];
      ipcRenderer.on('session-updated',(_e,{session:s})=>{ if(s.id!==id||!s.nativeRuntime)return; const r=s.nativeRuntime;
        window.overloadTrace.push({at:Date.now(),state:r.state,connection:r.connection,epoch:r.epoch,childPid:r.childPid,
          reason:r.reason||'',retry:r.apiRetry?r.apiRetry.attempt:0,submission:r.submission?.sendStatus||''}); }); })()`);
    const before = (await state()).session.nativeRuntime;

    const sentAt = Date.now();
    await send('第一条：服务过载也要老实说');
    await waitFor('receipt from transcript', async () => (await state()).delivery?.status === 'confirmed', 10000);
    const receiptMs = Date.now() - sentAt;
    assert.ok(receiptMs < 10000, 'receipt took ' + receiptMs + ' ms');
    checks.push(`receipt confirmed from the transcript in ${receiptMs} ms, echo still ~${(RETRIES + 1) * RETRY_MS / 1000}s away`);
    await waitFor('retry line', async () => /Claude 服务繁忙（529），引擎自动重试第 \d+\/\d+ 次 · 已等 /.test((await state()).composer), 15000);
    await shot('retrying');
    checks.push('composer shows: ' + (await state()).composer.split('\n')[0]);

    await waitFor('mid-retry', async () => Date.now() - sentAt > 30000, 40000);
    await send('第二条：重试中途再发一条');
    await waitFor('second queued', async () => (await state()).session.nativeRuntime.queued?.length === 1, 10000);
    assert.equal((await state()).session.nativeRuntime.epoch, before.epoch, 'sending must not reconnect');
    checks.push('second prompt sent mid-retry is queued, not a reconnect');

    await waitFor('past the 60 s budget', async () => Date.now() - sentAt > 65000, 70000);
    const mid = await state();
    assert.notEqual(mid.session.nativeRuntime.state, 'unknown', JSON.stringify(mid.session.nativeRuntime.reason));
    assert.ok(!mid.receipts.some(text => /失败|未确认/.test(text)), JSON.stringify(mid.receipts));
    await shot('past-60s');
    checks.push('at 65 s: state=' + mid.session.nativeRuntime.state + ', receipts=' + JSON.stringify(mid.receipts));

    await waitFor('both prompts completed', async () => {
      const s = await state();
      return s.session.nativeRuntime.state === 'completed' && !s.session.nativeRuntime.queued?.length
        && s.session.nativeRuntime.submission?.sendStatus === 'completed' && s.receipts.length === 2;
    }, 200000);
    const trace = await client.eval('window.overloadTrace');
    fs.writeFileSync(path.join(OUT, 'trace.json'), JSON.stringify(trace, null, 2), 'utf8');
    assert.equal(trace.filter(row => row.state === 'unknown').length, 0, 'no snapshot may be unknown');
    const after = (await state()).session.nativeRuntime;
    assert.equal(after.epoch, before.epoch, 'no reconnect');
    assert.equal(after.childPid, before.childPid, 'the writer survived');
    const transcript = await client.eval(`ipcRenderer.invoke('parse-session-transcript',{hubSessionId:${JSON.stringify(sid)}})`);
    assert.equal(transcript.turns.filter(turn => turn.role === 'user').length, 2);
    assert.equal(transcript.turns.filter(turn => turn.role === 'assistant').length, 2);
    await shot('completed');
    checks.push('both prompts answered by the same writer (epoch ' + after.epoch + ', pid ' + after.childPid + '); no unknown snapshot in ' + trace.length);
    assert.deepEqual(rendererErrors, [], 'renderer exceptions');
    fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify({ controlledProtocol: true, realModel: false, checks }, null, 2), 'utf8');
    console.log(checks.map(line => '  ✔ ' + line).join('\n'));
    console.log('PASS ' + checks.length + ' checks; ' + OUT);
  } catch (error) {
    if (client) {
      try { fs.writeFileSync(path.join(OUT, 'failure.json'), JSON.stringify({ state: await state(),
        trace: await client.eval('window.overloadTrace || []') }, null, 2), 'utf8'); await shot('failure'); }
      catch (diagnosticError) { console.error('Diagnostic capture failed:', diagnosticError.message); }
    }
    throw error;
  } finally {
    if (client) await client.close();
    if (hub) { await gracefulQuit(hub); fs.writeFileSync(path.join(OUT, 'hub.log'), hub.log().join('\n'), 'utf8'); }
    try { fs.rmSync(TEMP, { recursive: true, force: true }); } catch {}
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
