'use strict';
// Real Hub composer, dispatcher, file scanner and native OS pipe; controlled engine only.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const ROOT = path.resolve(__dirname, '..');
const RUN = 'claude-fileflow-' + Date.now();
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), RUN));
const DATA = path.join(TEMP, 'data'), GATES = path.join(TEMP, 'gates');
const OUT = path.join(ROOT, 'artifacts', 'native-agent', RUN);
for (const directory of [OUT, GATES, path.join(TEMP, 'workspace'), path.join(TEMP, 'claude'), path.join(TEMP, 'codex')]) fs.mkdirSync(directory, { recursive: true });
async function port() { const server = net.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const value = server.address().port; await new Promise(r => server.close(r)); return value; }
async function wait(label, predicate, ms = 30000) { const end = Date.now() + ms;
  while (Date.now() < end) { const value = await predicate(); if (value) return value; await _waitMs(100); } throw new Error('Timeout: ' + label); }
const received = () => fs.existsSync(path.join(GATES, 'received.jsonl'))
  ? fs.readFileSync(path.join(GATES, 'received.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const release = (message, text) => fs.writeFileSync(path.join(GATES, message.uuid + '.json'), JSON.stringify({ result: text }));
async function main() {
  let hub, cdp, id; const checks = [];
  const invoke = (channel, args = {}) => cdp.eval(`ipcRenderer.invoke(${JSON.stringify(channel)},${JSON.stringify(args)})`);
  const state = () => invoke('groupchat:get-state', { meetingId: id });
  const phase = () => invoke('dev-file:status', { meetingId: id });
  async function shot(name) { const image = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(image.data, 'base64')); }
  async function click(selector) {
    const box = await cdp.eval(`(() => {const e=document.querySelector(${JSON.stringify(selector)}); if(!e)throw Error('missing ${selector}'); const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, ...box, button: 'left', clickCount: 1 });
  }
  async function send(text) {
    await click('#mr-input-box'); await cdp.send('Input.insertText', { text });
    for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  }
  try {
    hub = await launchIsolatedHub({ dataDir: DATA, port: await port(), label: RUN, windowMode: 'hidden', extraEnv: {
      CLAUDE_HUB_E2E: '1', CLAUDE_HUB_HOME_DIR: path.join(TEMP, 'home'), AI_HUB_WORKSPACE_ROOT: TEMP,
      CLAUDE_CONFIG_DIR: path.join(TEMP, 'claude'), CODEX_HOME: path.join(TEMP, 'codex'), DEEPSEEK_API_KEY: '',
      CLAUDE_HUB_CLAUDE_STREAM_FIXTURE: path.join(ROOT, 'tests', 'fixtures', 'claude-stream.js'),
      CLAUDE_HUB_CLAUDE_FIXTURE_MODE: 'gated', CLAUDE_HUB_FIXTURE_GATE_DIR: GATES,
    } });
    cdp = await connectFirstPage(hub, page => page.type === 'page' && /index\.html/.test(page.url));
    await wait('renderer', () => cdp.eval('!!window.MeetingRoom && !!window.WorkflowTemplates'));
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    const meeting = await invoke('create-meeting', { mode: 'dev', scene: 'dev', groupChat: true, title: '原生阶段接续', workspace: path.join(TEMP, 'workspace'),
      slots: [0, 1].map(index => ({ index, memberId: 'm' + (index + 1), kind: 'claude', model: 'claude-opus-5[1m]', effort: 'max', mcpProfile: 'lean', fastMode: false })) });
    id = meeting.id; assert.equal(meeting.subSessions.length, 2);
    const config = await cdp.eval("window.WorkflowTemplates.createTemplateConfig('dev-task', [{memberId:'m1',kind:'claude'},{memberId:'m2',kind:'claude'}])");
    await invoke('update-meeting-sync', { meetingId: id, fields: { serialWorkflow: config } });
    const fresh = (await invoke('get-meetings')).find(m => m.id === id);
    await cdp.eval(`window.MeetingRoom.openMeeting(${JSON.stringify(id)},${JSON.stringify(fresh)})`);
    await wait('kickoff', () => cdp.eval("!!document.querySelector('[data-file-kickoff]')"));
    await click('#mr-input-box'); await cdp.send('Input.insertText', { text: '验证本条任务的阶段接续。' });
    await click('[data-file-kickoff]'); assert.equal(received().length, 0);
    await click('#mr-input-box');
    for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    const a = await wait('kickoff received', () => received()[0]);
    const docs = path.join(DATA, 'task-docs', id); fs.mkdirSync(docs, { recursive: true });
    fs.writeFileSync(path.join(docs, '开题报告.md'), 'controlled kickoff');
    fs.renameSync(path.join(docs, '开题报告.md'), path.join(docs, '已完成-开题报告.md'));
    const queued = await wait('build queued while kickoff running', async () => {
      const s = await state(); return Object.values(s.attempts || {}).find(attempt => attempt.status === 'queued');
    });
    assert.equal(received().length, 1); assert.equal(queued.providerTurnId, null);
    await shot('build-queued'); checks.push('early kickoff completion file creates queued build with no second pipe write');
    release(a, 'OLD_KICKOFF_SENTINEL');
    const b = await wait('own build receipt', () => received()[1]);
    assert.equal(b.sessionId, a.sessionId); assert.notEqual(b.uuid, a.uuid);
    const ownAttempt = await wait('build running', async () => Object.values((await state()).attempts || {}).find(attempt => attempt.userMessageId === b.uuid && attempt.status === 'running'));
    assert.notEqual(ownAttempt.status, 'completed'); checks.push('old kickoff result cannot settle the queued build');
    fs.writeFileSync(path.join(docs, '已完成-实现手册-轮次1.md'), 'controlled implementation');
    const c = await wait('independent merge member receives', () => received()[2]);
    assert.notEqual(c.sessionId, b.sessionId);
    release(b, 'OLD_IMPLEMENT_SENTINEL');
    await wait('merge remains active after old build result', async () => Object.values((await state()).attempts || {}).find(attempt => attempt.userMessageId === c.uuid && attempt.status === 'running'));
    checks.push('second member can receive while first member still runs; old build result cannot settle merge');
    await click('[data-file-stop]'); await wait('paused', async () => (await phase()).paused);
    fs.writeFileSync(path.join(docs, '需返工-合并手册-轮次1.md'), 'controlled rework');
    await _waitMs(1300); assert.equal(received().length, 3);
    await send('继续'); const d = await wait('round two build', () => received()[3]);
    assert.equal(d.sessionId, a.sessionId); assert.ok(d.text.includes('实现手册-轮次2.md'));
    release(d, 'ROUND_TWO_BUILD'); fs.writeFileSync(path.join(docs, '已完成-实现手册-轮次2.md'), 'controlled build two');
    const e = await wait('round two merge', () => received()[4]);
    release(e, 'ROUND_TWO_MERGE'); fs.writeFileSync(path.join(docs, '已完成-合并手册-轮次2.md'), 'controlled merge two');
    await wait('done', async () => (await phase()).done);
    await _waitMs(1200); assert.equal(received().length, 5);
    checks.push('pause suppresses late rework dispatch; actual continue follows round two and finishes without duplicate dispatch');
    await shot('done');
    fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify({ controlledProtocol: true, realModel: false,
      checks, state: await state(), phase: await phase(), received: received(), pid: hub.pid, temp: TEMP }, null, 2), 'utf8');
    console.log('PASS ' + checks.length + ' checks; ' + OUT);
  } catch (error) {
    if (cdp) { try { await shot('failure'); fs.writeFileSync(path.join(OUT, 'failure.json'), JSON.stringify({ state: id && await state(), phase: id && await phase(), received: received() }, null, 2), 'utf8'); } catch (captureError) { console.error(captureError.message); } }
    throw error;
  } finally { if (cdp) await cdp.close(); if (hub) { await gracefulQuit(hub); fs.writeFileSync(path.join(OUT, 'hub.log'), hub.log().join('\n'), 'utf8'); } }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
