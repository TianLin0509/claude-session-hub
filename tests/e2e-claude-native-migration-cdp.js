'use strict';
// Real old and current Hub processes; controlled historical data and new SDK
// engine fixture. This is migration/GUI evidence, not a real model success.
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const ROOT = path.resolve(__dirname, '..');
const baseline = path.join(ROOT, 'artifacts', 'native-agent', 'baseline-8c5c6928');
async function port() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value;
}
async function main() {
  if (!fs.existsSync(path.join(baseline, 'main.js'))) throw new Error('Prepare baseline from fixed 8c5c6928 git archive');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-native-migration-'));
  const out = path.join(ROOT, 'artifacts', 'native-agent', 'claude-migration-' + Date.now()); fs.mkdirSync(out, { recursive: true });
  const config = path.join(temp, 'claude'), cwd = path.join(temp, 'workspace'); fs.mkdirSync(cwd);
  const providerId = randomUUID(), userId = randomUUID();
  const bucket = path.join(config, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-')); fs.mkdirSync(bucket, { recursive: true });
  const file = path.join(bucket, providerId + '.jsonl');
  const history = [
    { type: 'user', uuid: userId, sessionId: providerId, cwd, timestamp: new Date().toISOString(), message: { role: 'user', content: '迁移前的历史问题' } },
    { type: 'assistant', uuid: randomUUID(), parentUuid: userId, sessionId: providerId, timestamp: new Date().toISOString(),
      message: { role: 'assistant', model: 'claude-opus-5[1m]', content: [{ type: 'text', text: '保留的历史回答' }], stop_reason: 'end_turn' } },
  ].map(value => JSON.stringify(value)).join('\n') + '\n';
  fs.writeFileSync(file, history, 'utf8');
  let oldHub, oldClient, hub, client;
  const result = { temp, out, controlledHistory: true, realModel: false, checks: [] };
  const until = async (c, expression, label) => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) { if (await c.eval(expression)) return; await _waitMs(100); }
    throw new Error('Timeout: ' + label);
  };
  const launch = async (entryPath, fixture) => launchIsolatedHub({ entryPath, dataDir: path.join(temp, 'data'),
    port: await port(), windowMode: 'hidden', label: 'claude-migration', extraEnv: {
      CLAUDE_CONFIG_DIR: config, CODEX_HOME: path.join(temp, 'codex'),
      ...(fixture ? { CLAUDE_HUB_CLAUDE_STREAM_FIXTURE: path.join(ROOT, 'tests', 'fixtures', 'claude-stream.js') } : {}),
    } });
  const shot = async name => {
    const image = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(image.data, 'base64'));
  };
  try {
    oldHub = await launch(baseline, false); oldClient = await connectFirstPage(oldHub);
    await until(oldClient, 'typeof sessions !== "undefined" && !!window.WorkspaceController', 'old renderer');
    const old = await oldClient.eval(`window.WorkspaceController.createSession('claude', {cwd:${JSON.stringify(cwd)},opts:{
      model:'claude-opus-5[1m]',effort:'max',mcpProfile:'lean',fastMode:false,resumeCCSessionId:${JSON.stringify(providerId)},
      title:'旧 Claude 迁移验证',userRenamed:true}})`);
    const sid = JSON.stringify(old.id); result.sessionId = old.id; result.providerId = providerId;
    await oldClient.eval(`selectSession(${sid})`);
    await until(oldClient, '!!document.querySelector(".floating-input-box")', 'old composer');
    await oldClient.eval('document.querySelector(".floating-input-box").focus()');
    await oldClient.send('Input.insertText', { text: '旧窗口尚未发送的草稿' });
    await until(oldClient, `sessions.get(${sid}).ccSessionId===${JSON.stringify(providerId)}`, 'old binding');
    await _waitMs(1500);
    hub = await launch(ROOT, true); client = await connectFirstPage(hub);
    await until(client, `typeof sessions!=='undefined' && sessions.has(${sid})`, 'restored metadata');
    await client.eval(`selectSession(${sid})`);
    await until(client, `sessions.get(${sid})?.nativeRuntime?.connection==='disconnected'`, 'ownership rejected');
    const blocked = await client.eval(`sessions.get(${sid}).nativeRuntime`);
    assert.match(blocked.reason, /原 Hub 仍持有/); assert.equal(blocked.childPid, null);
    await until(client, 'document.querySelector(".floating-input-box")?.innerText==="旧窗口尚未发送的草稿"', 'preserved draft');
    await shot('old-owner-blocked');
    result.checks.push('actual old Hub holds the history; new Hub starts no Claude writer and imports the unsent draft');
    await oldClient.close(); oldClient = null;
    result.oldExit = await gracefulQuit(oldHub); oldHub = null;
    await client.eval('document.querySelector(".claude-reconnect").click()');
    await until(client, `sessions.get(${sid}).nativeRuntime.connection==='connected'`, 'new ownership after old exit');
    const restored = await client.eval(`ipcRenderer.invoke('parse-session-transcript',{hubSessionId:${sid}})`);
    assert.ok(restored.turns.some(turn => turn.text.includes('保留的历史回答')));
    assert.equal(await client.eval(`sessions.get(${sid}).ccSessionId`), providerId);
    assert.equal(await client.eval('readContenteditablePlainText(document.querySelector(".floating-input-box"))'), '旧窗口尚未发送的草稿');
    assert.ok(fs.readFileSync(file, 'utf8').startsWith(history));
    await shot('native-resumed');
    result.checks.push('explicit reconnect after old Hub exit keeps the exact history identity and unsent draft');
    result.passed = true;
  } finally {
    const cleanupErrors = [];
    if (client) { try { await shot('final'); } catch (error) { result.captureError = error.message; } }
    for (const c of [client, oldClient]) {
      if (c) { try { await c.close(); } catch (error) { cleanupErrors.push(error.message); } }
    }
    for (const [instance, label] of [[oldHub, 'old'], [hub, 'new']]) {
      if (!instance) continue;
      try {
        fs.writeFileSync(path.join(out, label + '-hub.log'), instance.log().join('\n'));
        result[label + 'Exit'] = await gracefulQuit(instance);
      } catch (error) { cleanupErrors.push(error.message); }
    }
    result.cleanupErrors = cleanupErrors;
    if (cleanupErrors.length) result.passed = false;
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify({ out, passed: result.passed === true, checks: result.checks }));
    if (cleanupErrors.length) throw new Error(cleanupErrors.join('; '));
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
