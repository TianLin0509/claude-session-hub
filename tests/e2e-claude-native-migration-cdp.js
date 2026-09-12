'use strict';
// Real old and current Hub processes; controlled historical data and new SDK
// engine fixture. This is migration/GUI evidence, not a real model success.
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { screenshotReadOnlyReport } = require('./helpers/readonly-report-screenshot');
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
  const result = { temp, out, head: execFileSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8'}).trim(), controlledHistory: true, realModel: false, checks: [] };
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
    assert.ok(!(await client.eval('document.querySelector(".claude-native-controls")?.innerText')).includes('原 Hub 仍持有'), 'resolved ownership error must disappear after successful reconnect');
    const restored = await client.eval(`ipcRenderer.invoke('parse-session-transcript',{hubSessionId:${sid}})`);
    assert.ok(restored.turns.some(turn => turn.text.includes('保留的历史回答')));
    assert.equal(await client.eval(`sessions.get(${sid}).ccSessionId`), providerId);
    assert.equal(await client.eval('readContenteditablePlainText(document.querySelector(".floating-input-box"))'), '旧窗口尚未发送的草稿');
    assert.ok(fs.readFileSync(file, 'utf8').startsWith(history));
    await shot('native-resumed');
    result.checks.push('explicit reconnect after old Hub exit keeps the exact history identity and unsent draft');
    if (process.argv.includes('--rollback')) {
      await client.eval('document.querySelector(".floating-input-box").focus()');
      await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await until(client, `sessions.get(${sid})?.nativeRuntime?.state==='completed'`, 'new version completed before rollback');
      const completed = await client.eval(`sessions.get(${sid}).nativeRuntime.submission`);
      await client.eval('document.querySelector(".floating-input-box").focus()');
      await client.send('Input.insertText', { text: '回退后仍需保留的新草稿' });
      const before = await client.eval(`ipcRenderer.invoke('parse-session-transcript',{hubSessionId:${sid}})`);
      assert.ok(before.turns.some(turn => turn.text.includes('完成 🧪')));
      result.rollbackSubmission = completed;
      await until(client, 'document.querySelector(".floating-input-box")?.dataset.draftState==="saved"', 'Main durably saved draft');
      const savedDraft = await client.eval(`ipcRenderer.invoke('native-draft:read',{sessionId:${sid}})`);
      assert.equal(savedDraft.record.text, '回退后仍需保留的新草稿');
      result.savedDraftRevision = savedDraft.record.revision;
      result.nativeStorageOrigin = await client.eval('location.href');
      fs.writeFileSync(path.join(out, 'rollback-recovery.json'), JSON.stringify({
        sessionId: old.id, providerId, submission: completed, turns: before.turns,
        unsentDraft: await client.eval('readContenteditablePlainText(document.querySelector(".floating-input-box"))'),
        instruction: 'Read-only export. Do not resend automatically.'
      }, null, 2), 'utf8');
      const recoveryHtml = path.join(out, 'rollback-recovery.html');
      execFileSync(process.execPath,[path.join(ROOT,'scripts/render-native-recovery.js'),path.join(out,'rollback-recovery.json'),recoveryHtml]);
      await shot('before-rollback');
      await client.close(); client = null;
      result.beforeRollbackExit = await gracefulQuit(hub); hub = null;
      // Reopen the actual baseline against the same isolated data. Do not send
      // any prompts through its old TUI. It must retain unknown newer fields.
      oldHub = await launch(baseline, false); oldClient = await connectFirstPage(oldHub);
      await until(oldClient, `typeof sessions!=='undefined' && sessions.has(${sid})`, 'rollback restores session');
      await oldClient.eval(`selectSession(${sid})`);
      await until(oldClient, '!!document.querySelector(".floating-input-box")', 'rollback composer');
      // The old release never persisted drafts and does not read the native
      // draft key. Check durability separately; do not label old UI compatible.
      result.rollbackOldComposerCompatible = await oldClient.eval('document.querySelector(".floating-input-box")?.innerText==="回退后仍需保留的新草稿"');
      result.rollbackStorageOrigin = await oldClient.eval('location.href');
      result.rollbackOldNativeDraftValue = await oldClient.eval(`localStorage.getItem('hub.claude-native.draft.v1:'+${sid})`);
      const oldHistory = await oldClient.eval(`ipcRenderer.invoke('parse-session-transcript',{hubSessionId:${sid},
        ccSessionId:${JSON.stringify(providerId)},transcriptPath:${JSON.stringify(file)},kind:'claude'})`);
      assert.ok(oldHistory.turns.some(turn => turn.text.includes('保留的历史回答')));
      result.rollbackOldReaderSeesNativeOnlyAnswer = oldHistory.turns.some(turn => turn.text.includes('完成 🧪'));
      const oldImage = await oldClient.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(out, 'rollback-old.png'), Buffer.from(oldImage.data, 'base64'));
      // Explicit compatibility reader, not a claim that the unchanged old UI
      // understands a new journal schema. It cannot send or replay anything.
      await oldClient.send('Page.navigate',{url:pathToFileURL(recoveryHtml).href});
      await until(oldClient,'document.getElementById("recovery-json")','offline rollback reader');
      const recovered = await oldClient.eval('JSON.parse(document.getElementById("recovery-json").textContent)');
      assert.deepEqual(recovered,JSON.parse(fs.readFileSync(path.join(out,'rollback-recovery.json'),'utf8')));
      assert.deepEqual(recovered.turns,before.turns);
      assert.equal(recovered.unsentDraft,savedDraft.record.text);
      assert.equal(recovered.providerId,providerId);
      assert.equal(await oldClient.eval('document.querySelectorAll("script,button,form,iframe").length'),0);
      result.reportRendering = screenshotReadOnlyReport(recoveryHtml,path.join(out,'rollback-readonly-reader.png'));
      result.rollbackReadOnlyCompanionPassed = true;
      await oldClient.close(); oldClient = null;
      result.rollbackExit = await gracefulQuit(oldHub); oldHub = null;
      hub = await launch(ROOT, true); client = await connectFirstPage(hub);
      await until(client, `typeof sessions!=='undefined' && sessions.has(${sid})`, 'reupgrade session');
      await client.eval(`selectSession(${sid})`);
      await until(client, `sessions.get(${sid})?.nativeRuntime?.connection==='connected'`, 'reupgrade writer');
      const after = await client.eval(`ipcRenderer.invoke('parse-session-transcript',{hubSessionId:${sid}})`);
      assert.deepEqual(after.turns.map(turn => [turn.id, turn.role, turn.text]), before.turns.map(turn => [turn.id, turn.role, turn.text]));
      result.reupgradeDraft = await client.eval(`({stored:localStorage.getItem('hub.claude-native.draft.v1:'+${sid}),
        memory:floatingInputDrafts.get(${sid}),input:readContenteditablePlainText(document.querySelector('.floating-input-box')),
        backend:sessions.get(${sid}).runtimeBackend,selected:activeSessionId})`);
      await until(client, 'document.querySelector(".floating-input-box")?.innerText==="回退后仍需保留的新草稿"', 'reupgrade draft visible');
      result.reupgradeMainDraft = await client.eval(`ipcRenderer.invoke('native-draft:read',{sessionId:${sid}})`);
      assert.equal(result.reupgradeMainDraft.record.text, savedDraft.record.text);
      assert.equal(result.reupgradeMainDraft.record.revision, savedDraft.record.revision, 'restore does not resave or resend');
      assert.equal(await client.eval('readContenteditablePlainText(document.querySelector(".floating-input-box"))'), '回退后仍需保留的新草稿');
      assert.equal(await client.eval(`sessions.get(${sid}).ccSessionId`), providerId);
      const afterRuntime = await client.eval(`sessions.get(${sid}).nativeRuntime`);
      assert.ok(afterRuntime.state === 'completed' || afterRuntime.state === 'idle');
      await shot('reupgrade-preserved');
      result.checks.push('actual old/new version roundtrip keeps historical and native journal answers, session identity, and unsent draft without replay');
      result.rollbackCompatibilityMode = 'explicit-read-only-companion; old UI does not read new schema';
      result.rollbackGatePassed = result.rollbackReadOnlyCompanionPassed;
    }
    result.passed = true;
  } catch (error) {
    result.failure = { message: error.message, stack: error.stack };
    throw error;
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
    if (cleanupErrors.length && !result.failure) throw new Error(cleanupErrors.join('; '));
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
