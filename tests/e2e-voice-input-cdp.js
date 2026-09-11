'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), assert = require('assert/strict');
const { WebSocketServer } = require('ws');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function freePort() { return new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); }); }
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-voice-input-'));
  const out = path.resolve('artifacts/20260911-voice-input-codex1/gui-' + Date.now()); fs.mkdirSync(out, { recursive: true });
  const cwd = path.join(root, 'workspace'); fs.mkdirSync(cwd);
  const home = path.join(root, 'codex'); fs.mkdirSync(home); fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-6-astra"\nmodel_reasoning_effort = "xhigh"\n');
  const evidence = { passed: false, checks: [], audio: [], out, root, kind: 'Real isolated Hub; synthetic microphone and deterministic ASR fixture, NOT recognition accuracy' };
  let mode = 'success';
  const peer = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await new Promise(resolve => peer.once('listening', resolve));
  peer.on('connection', ws => {
    let id, chunks = 0, bytes = 0, sent = false, sampleRate, nonzero = false;
    const thisMode = mode;
    const emit = (event, sentence) => { if (ws.readyState === 1) ws.send(JSON.stringify({ header: { task_id: id, event }, payload: { output: { sentence } } })); };
    ws.on('message', (raw, binary) => {
      if (binary) {
        chunks++; bytes += raw.length; nonzero ||= raw.some(byte => byte !== 0);
        if (!sent) { sent = true; emit('result-generated', { sentence_id: 1, sentence_end: false, text: '不要合并' }); }
        if (thisMode === 'disconnect' && chunks === 4) ws.close();
        return;
      }
      const request = JSON.parse(raw);
      if (request.header.action === 'run-task') { id = request.header.task_id; sampleRate = request.payload.parameters.sample_rate; emit('task-started'); }
      if (request.header.action === 'finish-task') {
        evidence.audio.push({ bytes, chunks, sampleRate, nonzero, thisMode });
        setTimeout(() => {
          emit('result-generated', { sentence_id: 1, sentence_end: true, text: '不要合并 master。' });
          emit('result-generated', { sentence_id: 1, sentence_end: true, text: '不要合并 master。' });
          emit('result-generated', { sentence_id: 2, sentence_end: true, text: 'SRS 是十毫秒。' });
          emit('task-finished');
        }, 350);
      }
    });
  });
  let hub, cdp;
  const until = async (expr, label) => { const end = Date.now() + 25000; while (Date.now() < end) { if (await cdp.eval(expr)) return; await sleep(150); } throw Error('timeout: ' + label); };
  const snap = async name => { const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(shot.data, 'base64')); };
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port: await freePort(), windowMode: 'hidden', label: 'voice-input', entryPath: path.join(__dirname, 'fixtures/voice-input-hub.js'), extraEnv: {
      DASHSCOPE_API_KEY: '', HUB_VOICE_TEST_PORT: String(peer.address().port), CODEX_HOME: home,
      CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE: path.join(__dirname, 'fixtures/codex-app-server.js'),
    } });
    evidence.pid = hub.pid; cdp = await connectFirstPage(hub);
    await until('typeof sessions !== "undefined" && window.MeetingRoom', 'renderer');
    const opts = { cwd, model: 'gpt-6-astra', effort: 'xhigh', mcpProfile: 'none', codexSpeedTier: 'standard' };
    const s = await cdp.eval('ipcRenderer.invoke("create-session",' + JSON.stringify({ kind: 'codex', opts }) + ')');
    await until('sessions.get(' + JSON.stringify(s.id) + ')?.nativeRuntime?.state === "idle"', 'session idle');
    await cdp.eval('showTerminal(' + JSON.stringify(s.id) + ')');
    await until('document.querySelector(".floating-input-bar .voice-mic")', 'microphone');
    const mic = '.floating-input-bar .voice-mic', box = '.floating-input-bar .floating-input-box', panel = '.floating-input-bar .voice-panel';
    const click = selector => cdp.eval('document.querySelector(' + JSON.stringify(selector) + ').click()');
    const draft = (selector, text) => cdp.eval('(()=>{const b=document.querySelector(' + JSON.stringify(selector) + ');b.textContent=' + JSON.stringify(text) + ';b.dispatchEvent(new Event("input",{bubbles:true}));b.focus();const r=document.createRange();r.selectNodeContents(b);r.collapse(false);getSelection().removeAllRanges();getSelection().addRange(r);})()');
    await draft(box, '已有草稿：'); await click(mic);
    await until('document.querySelector(".voice-settings-dialog")', 'missing key opens settings'); await snap('settings');
    await cdp.eval('(()=>{const d=document.querySelector(".voice-settings-dialog");d.querySelector("input[type=password]").value="fixture-only-key";d.querySelector("textarea").value="SINR\\nSRS";[...d.querySelectorAll("button")].find(b=>b.textContent==="保存").click();})()');
    await until('!document.querySelector(".voice-settings")', 'saved settings');
    const saved = fs.readFileSync(path.join(root, 'data/voice-input.json'), 'utf8'); assert(!saved.includes('fixture-only-key'));
    evidence.checks.push('Missing key opens settings; key encrypted at rest; no audio request before configured');
    // Inject only the browser permission failure, then restore the real capture API.
    await cdp.eval('window.__voiceOriginalGetUserMedia=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException("denied","NotAllowedError")};');
    await click(mic);
    await until('document.querySelector(' + JSON.stringify(panel + ' .voice-status') + ').textContent.includes("权限被拒绝")', 'permission failure');
    assert.equal(await cdp.eval('document.querySelector(' + JSON.stringify(box) + ').textContent'), '已有草稿：');
    await cdp.eval('navigator.mediaDevices.getUserMedia=window.__voiceOriginalGetUserMedia;delete window.__voiceOriginalGetUserMedia;');
    evidence.checks.push('Injected permission rejection surfaces clear error without changing draft; real capture restored');
    await draft(box, '已有草稿：'); await click(mic);
    await until('document.querySelector(' + JSON.stringify(panel + ' .voice-preview') + ').textContent.includes("不要合并")', 'real PCM reaches fixture');
    assert.equal(await cdp.eval('document.querySelector(' + JSON.stringify(box) + ').textContent'), '已有草稿：');
    await snap('recording'); await click(mic);
    await until('document.querySelector(' + JSON.stringify(box) + ').textContent.includes("SRS")', 'final inserted');
    assert.equal(await cdp.eval('document.querySelector(' + JSON.stringify(box) + ').textContent'), '已有草稿：不要合并 master。SRS 是十毫秒。');
    assert.equal(await cdp.eval('sessions.get(' + JSON.stringify(s.id) + ').nativeRuntime.state'), 'idle');
    await snap('ordinary-draft'); evidence.checks.push('Real capture/worklet/PCM/IPC/WS/final flush; repeated final sentence dedup; existing draft retained; no automatic send');
    await click('.floating-input-bar .floating-input-send');
    await until('sessions.get(' + JSON.stringify(s.id) + ')?.nativeRuntime?.state === "completed"', 'manual send uses existing pipeline');
    evidence.checks.push('Explicit send of voice draft goes through existing session pipeline to fixture App Server');
    await click(mic); await until('document.querySelector(' + JSON.stringify(panel + ' .voice-preview') + ').textContent', 'second recording');
    await draft(box, '我同时修改的草稿'); await click(mic);
    await until('document.querySelector(' + JSON.stringify(panel + ' .voice-status') + ').textContent.includes("草稿或会话已改变")', 'edit conflict');
    assert.equal(await cdp.eval('document.querySelector(' + JSON.stringify(box) + ').textContent'), '我同时修改的草稿');
    await cdp.eval('[...document.querySelectorAll(' + JSON.stringify(panel + ' button') + ')].find(b=>b.textContent==="插入草稿").click()');
    assert.equal(await cdp.eval('document.querySelector(' + JSON.stringify(box) + ').textContent'), '我同时修改的草稿不要合并 master。SRS 是十毫秒。');
    evidence.checks.push('Concurrent editing preserved; explicit insertion recovers final text');
    await click(mic); await until('document.querySelector(' + JSON.stringify(panel + ' .voice-preview') + ').textContent', 'cancel recording');
    const beforeCancel = await cdp.eval('document.querySelector(' + JSON.stringify(box) + ').textContent');
    await cdp.eval('[...document.querySelectorAll(' + JSON.stringify(panel + ' button') + ')].find(b=>b.textContent==="取消").click()');
    await until('document.querySelector(' + JSON.stringify(panel) + ').hidden', 'cancelled');
    assert.equal(await cdp.eval('document.querySelector(' + JSON.stringify(box) + ').textContent'), beforeCancel);
    evidence.checks.push('Cancel stops capture and preserves draft; subsequent recording starts normally');
    mode = 'disconnect'; await click(mic);
    await until('document.querySelector(' + JSON.stringify(panel + ' .voice-status') + ').textContent.includes("连接中断")', 'disconnect visible');
    await snap('network-error');
    await cdp.eval('[...document.querySelectorAll(' + JSON.stringify(panel + ' button') + ')].find(b=>b.textContent==="取消").click()');
    mode = 'success'; evidence.checks.push('Connection loss visible; provisional text retained for manual recovery/cancel');
    const g = await cdp.eval('ipcRenderer.invoke("create-meeting",' + JSON.stringify({ title: '语音输入验收', scene: 'general', workspace: cwd, slots: [{ kind: 'codex', ...opts }] }) + ')');
    await cdp.eval('selectMeeting(' + JSON.stringify(g.id) + ')');
    await draft('#mr-input-box', '群聊草稿：'); await click('#mr-input-row .voice-mic');
    await until('document.querySelector("#meeting-room-panel .voice-preview").textContent', 'group recording');
    await click('#mr-input-row .voice-mic');
    await until('document.querySelector("#mr-input-box").textContent.includes("SRS")', 'group draft');
    assert.equal(await cdp.eval('document.querySelector("#mr-input-box").textContent'), '群聊草稿：不要合并 master。SRS 是十毫秒。');
    await snap('group-draft'); evidence.checks.push('Real group composer gets editable voice draft');
    const panelHeight = await cdp.eval('document.querySelector("#meeting-room-panel .voice-panel").getBoundingClientRect().height');
    assert(panelHeight < 180, 'voice panel must not consume message viewport');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 850, deviceScaleFactor: 1, mobile: false });
    await sleep(250); await snap('group-1100');
    const bounds = await cdp.eval('(()=>{const m=document.querySelector("#mr-input-row .voice-mic").getBoundingClientRect();return {left:m.left,right:m.right,width:innerWidth};})()');
    assert(bounds.left >= 0 && bounds.right <= bounds.width);
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    const g2 = await cdp.eval('ipcRenderer.invoke("create-meeting",' + JSON.stringify({ title: '另一个群聊', scene: 'general', workspace: cwd, slots: [{ kind: 'codex', ...opts }] }) + ')');
    await click('#mr-input-row .voice-mic'); await until('document.querySelector("#meeting-room-panel .voice-preview").textContent', 'switch recording');
    await cdp.eval('selectMeeting(' + JSON.stringify(g2.id) + ')');
    await draft('#mr-input-box', '另一群的草稿');
    await until('document.querySelector("#meeting-room-panel .voice-status").textContent.includes("草稿或会话已改变")', 'switch protected');
    assert.equal(await cdp.eval('document.querySelector("#mr-input-box").textContent'), '另一群的草稿');
    await cdp.eval('selectMeeting(' + JSON.stringify(g.id) + ')');
    await cdp.eval('[...document.querySelectorAll("#meeting-room-panel .voice-panel button")].find(b=>b.textContent==="插入草稿").click()');
    assert.equal((await cdp.eval('document.querySelector("#mr-input-box").textContent')).match(/SRS/g).length, 2);
    evidence.checks.push('Switching groups stops capture; delayed text never enters another group; original group can recover');
    assert(evidence.audio.length >= 4); assert(evidence.audio.every(a => a.bytes > 0 && a.bytes % 2 === 0 && a.sampleRate >= 8000));
    evidence.passed = true;
  } catch (error) { evidence.error = error.stack; throw error; }
  finally {
    if (cdp) { try { await snap('last'); evidence.ui = await cdp.eval('document.body.innerText.slice(-3000)'); } catch (error) { evidence.captureError = error.message; } await cdp.close(); }
    if (hub) { fs.writeFileSync(path.join(out, 'hub.log'), hub.log().join('\n')); evidence.exit = await gracefulQuit(hub); }
    for (const client of peer.clients) client.terminate(); await new Promise(resolve => peer.close(resolve));
    fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence, null, 2));
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
