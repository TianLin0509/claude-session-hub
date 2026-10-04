'use strict';
// Real isolated Electron/UI/IPC; the dispatcher is the controlled test stub.
// Reproduces the reported flow: run a workflow task, end it, then chat
// normally (no kickoff), and only start a new task after 开新任务.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-task-chat-')), DATA = path.join(ROOT, 'data'), SCRIPT = path.join(ROOT, 'dispatch.js'), LOG = path.join(ROOT, 'calls.jsonl');
const ART = path.resolve(__dirname, '..', 'artifacts', 'task-chat-mode'); fs.mkdirSync(ART, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const port = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
fs.writeFileSync(SCRIPT, `const fs=require('fs');module.exports=(args)=>{fs.appendFileSync(${JSON.stringify(LOG)},JSON.stringify({to:args.targetMemberIds,text:String(args.userInput||''),workflow:args.workflowRun||null})+'\\n');return {text:'收到'};};`);
const calls = () => fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];

(async () => {
  let hub, cdp; const checks = [], ok = (n, v) => { assert(v, n); checks.push(n); console.log('PASS ' + n); };
  const wait = async (label, pred, ms = 30000) => { const end = Date.now() + ms; while (Date.now() < end) { const r = await pred(); if (r) return r; await sleep(150); } throw new Error('Timeout: ' + label); };
  const invoke = (ch, a = {}) => cdp.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(ch)},${JSON.stringify(a)})`);
  const shot = async n => { const r = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(ART, n + '.png'), Buffer.from(r.data, 'base64')); };
  const click = async sel => {
    await wait('visible ' + sel, () => cdp.eval(`!!document.querySelector(${JSON.stringify(sel)})`));
    const p = await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
  };
  const send = async text => {
    await click('#mr-input-box'); await cdp.send('Input.insertText', { text });
    for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  };
  const bar = () => cdp.eval("(()=>{const e=document.querySelector('.mr-delivery-flow');return e?{text:e.querySelector('.mr-file-detail strong').innerText,arm:!!e.querySelector('[data-delivery=arm]'),disarm:!!e.querySelector('[data-delivery=disarm]')}:null;})()");
  try {
    hub = await launchIsolatedHub({ dataDir: DATA, port: await port(), windowMode: 'hidden', label: 'task-chat', extraEnv: { CLAUDE_HUB_TEST_DISPATCH_SCRIPT: SCRIPT } });
    cdp = await connectFirstPage(hub, t => /index\.html/.test(t.url));
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    await wait('renderer', () => cdp.eval('!!window.MeetingRoom'));
    const m = await invoke('create-meeting', { mode: 'dev', groupChat: true, title: '结束任务后回到群聊', workspace: ROOT, slotSpecs: [{ index: 0, kind: 'claude', memberId: 'm1' }, { index: 1, kind: 'codex', memberId: 'm2' }] });
    await invoke('test:seed-groupchat-members', { meetingId: m.id, count: 2 });
    const config = await cdp.eval("require('../core/workflow-settings').createDeliveryConfig('development',[{memberId:'m1'},{memberId:'m2'}])");
    await invoke('update-meeting-sync', { meetingId: m.id, fields: { serialWorkflow: config } });
    await cdp.eval(`selectMeeting(${JSON.stringify(m.id)})`);
    await wait('delivery bar', async () => (await bar())?.text === '工作流已就绪');
    ok('新建群：状态栏显示「工作流已就绪」，可改为普通群聊', (await bar()).disarm);

    await send('做任务 A');
    await wait('kickoff', () => calls().length >= 1);
    ok('就绪时第一条消息按工作流开题', /文件交付工作流/.test(calls()[0].text) && calls()[0].text.includes('做任务 A'));
    const runA = (await invoke('delivery:status', { meetingId: m.id })).runId;
    // End the task through the real UI (the confirm dialog is accepted).
    await cdp.eval('window.confirm=()=>true');
    await click('[data-delivery-details]'); await click('[data-delivery=cancel]');
    await wait('plain chat after end', async () => (await bar())?.text === '普通群聊');
    ok('结束任务后状态栏变为「普通群聊」，并给出「开新任务」', (await bar()).arm);
    ok('输入框提示改为普通群聊', (await cdp.eval("document.getElementById('mr-input-box').dataset.placeholder")).includes('普通群聊'));
    await shot('01-after-end');

    const before = calls().length;
    await send('现在什么进展');
    await wait('plain message', () => calls().length > before);
    const plain = calls()[before];
    ok('结束后发的话直接给成员，不再开题', plain.text.includes('现在什么进展') && !/文件交付工作流/.test(plain.text) && !plain.workflow);
    ok('没有因此开出新任务', (await invoke('delivery:status', { meetingId: m.id })).runId === runA);

    await click('[data-delivery=arm]');
    await wait('armed', async () => (await bar())?.text === '工作流已就绪');
    const before2 = calls().length;
    await send('做任务 B');
    await wait('new kickoff', () => calls().length > before2);
    const kick = calls()[before2];
    ok('点「开新任务」后，下一条消息才按工作流开题', /文件交付工作流/.test(kick.text) && kick.text.includes('做任务 B'));
    ok('开出的是新任务', (await invoke('delivery:status', { meetingId: m.id })).runId !== runA);
    await shot('02-new-task');
    fs.writeFileSync(path.join(ART, 'checks.json'), JSON.stringify({ checks, dispatcher: 'controlled stub' }, null, 2));
  } catch (error) { if (cdp) { try { await shot('failure'); } catch {} } console.error(error); process.exitCode = 1; }
  finally { if (cdp) await cdp.close(); if (hub) await gracefulQuit(hub); }
})();
