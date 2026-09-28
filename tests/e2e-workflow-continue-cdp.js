'use strict';
// Real isolated Electron/UI/IPC/task files; the dispatcher is a fixture that
// plays both agents by renaming their stage drafts. Not a real-model E2E.
// Covers: 3-review budget (every build reviewed), the continue button routing
// by task files, and typed "继续" ignoring the lit avatar.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-continue-'));
const DATA = path.join(ROOT, 'data'), SCRIPT = path.join(ROOT, 'dispatch.js'), LOG = path.join(ROOT, 'calls.jsonl'), CTL = path.join(ROOT, 'control.json');
const ART = path.resolve(__dirname, '..', 'artifacts', 'workflow-continue');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
fs.mkdirSync(ART, { recursive: true });
fs.writeFileSync(CTL, JSON.stringify({ rooms: {} }));
fs.writeFileSync(SCRIPT, `const fs=require('fs'),path=require('path');
module.exports=(args,ctx)=>{
  fs.appendFileSync(${JSON.stringify(LOG)},JSON.stringify({meetingId:ctx.meetingId,targetMemberIds:args.targetMemberIds,recipientSids:args.recipientSids,userInput:args.userInput})+'\\n');
  const room=(JSON.parse(fs.readFileSync(${JSON.stringify(CTL)},'utf8')).rooms||{})[ctx.meetingId]||{};
  const found=/草稿：(.+?\\.md)/.exec(String(args.userInput||''));
  if(!found)return {text:'没有阶段草稿'};
  const draft=found[1],name=path.basename(draft),dir=path.dirname(draft),merge=/^合并手册-轮次(\\d+)\\.md$/.exec(name);
  if(merge&&room.holdMerge)return {text:'审查中途被打断，尚未交付'};
  const out=(merge&&Number(merge[1])<=Number(room.reworkUntil||0)?'需返工-':'已完成-')+name;
  fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,out),'fixture delivery','utf8');
  try{fs.unlinkSync(draft);}catch{}
  return {text:'已交付 '+out};
};`);
const calls = id => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []).filter(c => !id || c.meetingId === id);
const control = (id, fields) => { const c = JSON.parse(fs.readFileSync(CTL, 'utf8')); c.rooms[id] = { ...(c.rooms[id] || {}), ...fields }; fs.writeFileSync(CTL, JSON.stringify(c)); };

async function run() {
  let hub, cdp;
  const checks = [], ok = (name, value) => { assert(value, name); checks.push(name); console.log('PASS ' + name); };
  try {
    hub = await launchIsolatedHub({ dataDir: DATA, port: await freePort(), windowMode: 'hidden', label: 'workflow-continue', extraEnv: { CLAUDE_HUB_TEST_DISPATCH_SCRIPT: SCRIPT } });
    cdp = await connectFirstPage(hub, t => /index\.html/.test(t.url));
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    const wait = async (predicate, label, ms = 60000) => { const deadline = Date.now() + ms; while (Date.now() < deadline) { if (await predicate()) return; await sleep(200); } throw new Error('Timeout: ' + label); };
    await wait(() => cdp.eval('!!window.MeetingRoom && !!window.WorkflowTemplates'), 'renderer');
    const invoke = (channel, args = {}) => cdp.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(channel)}, ${JSON.stringify(args)})`);
    const shot = async file => { const r = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(ART, file), Buffer.from(r.data, 'base64')); };
    const mouseClick = async sel => {
      await wait(() => cdp.eval(`!!document.querySelector(${JSON.stringify(sel)})`), 'visible ' + sel, 15000);
      const point = await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!r.width||!r.height||!e.contains(document.elementFromPoint(x,y)))throw Error('unclickable '+${JSON.stringify(sel)});return {x,y};})()`);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    };
    const room = async title => {
      const m = await invoke('create-meeting', { mode: 'dev', groupChat: true, title, workspace: ROOT,
        slotSpecs: [{ index: 0, kind: 'codex', memberId: 'm1' }, { index: 1, kind: 'claude', memberId: 'm2' }] });
      await invoke('test:seed-groupchat-members', { meetingId: m.id, count: 2 });
      const config = await cdp.eval("window.WorkflowTemplates.createTemplateConfig('dev-task', [{memberId:'m1',kind:'codex'},{memberId:'m2',kind:'claude'}])");
      await invoke('update-meeting-sync', { meetingId: m.id, fields: { serialWorkflow: config } });
      await cdp.eval(`selectMeeting(${JSON.stringify(m.id)})`);
      await wait(() => cdp.eval("!!document.querySelector('[data-file-kickoff]')"), 'kickoff button');
      return m.id;
    };
    const kickoff = async text => {
      await cdp.eval(`document.getElementById('mr-input-box').textContent=${JSON.stringify(text)}; document.querySelector('[data-file-kickoff]').click()`);
      await wait(() => cdp.eval("document.getElementById('mr-input-box').innerText.includes('【开题提示词结束】')"), 'kickoff prefill');
      await cdp.eval("document.getElementById('mr-input-box').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', code:'Enter', bubbles:true, cancelable:true}))");
    };
    const state = id => invoke('dev-file:status', { meetingId: id });
    const participants = async id => (await invoke('get-meetings')).find(x => x.id === id).participants;

    // 1) Three builds, all reviewed; the third rework pauses with a continue button.
    const a = await room('继续按钮验收：三轮审查上限');
    control(a, { reworkUntil: 3 });
    await kickoff('修复任务 A：验收三轮审查上限');
    await wait(async () => (await state(a)).limitReached, 'limit after third review', 120000);
    const flow = calls(a);
    ok('开题 + 3 轮实现 + 3 轮审查 = 7 次派工', flow.length === 7);
    ok('每轮实现都送审（第 3 轮实现也有审查）', [1, 2, 3].every(n => flow.some(c => c.targetMemberIds?.[0] === 'm2' && c.userInput.includes(`合并手册-轮次${n}.md`))));
    ok('第 3 轮审查返工后不自动派第 4 轮实现', !flow.some(c => c.userInput.includes('实现手册-轮次4.md')));
    ok('暂停现场：输入框仍点亮上一棒审查者', JSON.stringify(await participants(a)) === '[1]');
    await wait(() => cdp.eval("!!document.querySelector('[data-file-continue]')"), 'continue button', 15000);
    const bar = await cdp.eval("({detail:document.querySelector('.mr-file-detail').innerText,button:document.querySelector('[data-file-continue]').innerText,title:document.querySelector('[data-file-continue]').title})");
    ok('状态栏说明已完成 3 轮审查', bar.detail.includes('已完成 3 轮审查'));
    ok('继续按钮写明交给实现位做第 4 轮', /实现 · 第 4 轮/.test(bar.button) && bar.title.includes('再给 3 轮审查额度'));
    ok('输入框占位提示改为点继续', (await cdp.eval("document.getElementById('mr-input-box').dataset.placeholder")).includes('点上方「继续」'));
    await shot('01-limit-continue-button.png');
    await mouseClick('[data-file-continue]');
    await wait(() => calls(a).length >= 8, 'continue dispatch', 20000);
    const cont = calls(a)[7];
    ok('点继续：Hub 按任务文件交给实现位 m1，而非点亮的审查者', JSON.stringify(cont.targetMemberIds) === '["m1"]' && cont.recipientSids === undefined);
    ok('继续派工携带第 4 轮实现提示词', cont.userInput.startsWith('继续：接续当前阶段') && cont.userInput.includes('实现手册-轮次4.md'));
    await wait(async () => (await state(a)).done, 'room A done after build 4 + review 4', 60000);
    ok('第 4 轮实现照常送审后完成', calls(a).length === 9 && calls(a)[8].targetMemberIds?.[0] === 'm2');
    await wait(() => cdp.eval("!document.querySelector('[data-file-continue]') && document.querySelector('.mr-file-detail')?.innerText.includes('合并完成')"), 'done UI', 15000);
    ok('完成后不再显示继续按钮', true);
    await shot('02-done-after-continue.png');

    // 2) Typed "继续" while the author avatar is lit: still routed to the reviewer.
    const b = await room('继续按钮验收：手打继续');
    control(b, { holdMerge: true });
    await kickoff('修复任务 B：验收手打继续');
    await wait(() => calls(b).some(c => c.userInput.includes('合并手册-轮次1.md')), 'review 1 dispatched', 60000);
    await wait(async () => !(await state(b)).running, 'review turn settled', 20000);
    await mouseClick('[data-file-stop]');
    await wait(async () => (await state(b)).paused, 'stopped', 15000);
    await wait(() => cdp.eval("document.querySelector('[data-file-continue]')?.innerText.includes('审查与合并 · 第 1 轮')"), 'continue names reviewer', 15000);
    await shot('03-stopped-review-continue.png');
    // Light only the author, as in the reported incident. Fixture members render
    // no avatar toggles, so use the toggles' own IPC and renderer update.
    await cdp.eval(`require('electron').ipcRenderer.invoke('groupchat:set-participants',{meetingId:${JSON.stringify(b)},participants:[0]}).then(r=>{window.MeetingRoom.updateMeetingData(${JSON.stringify(b)},r.meeting);return r.ok;})`);
    await wait(async () => JSON.stringify(await participants(b)) === '[0]', 'only author lit', 10000);
    ok('渲染层输入框收件人为实现位 m1', await cdp.eval(`JSON.stringify(window.MeetingRoom.getMeetingData(${JSON.stringify(b)})?.participants)==='[0]'`));
    control(b, { holdMerge: false });
    const before = calls(b).length;
    await cdp.eval("document.getElementById('mr-input-box').textContent='继续'; document.getElementById('mr-input-box').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', code:'Enter', bubbles:true, cancelable:true}))");
    await wait(() => calls(b).length > before, 'typed continue dispatch', 20000);
    const typed = calls(b)[before];
    ok('手打继续：发给审查者 m2，不跟随点亮的实现位', JSON.stringify(typed.targetMemberIds) === '["m2"]' && typed.recipientSids === undefined);
    ok('手打继续附带第 1 轮审查提示词', typed.userInput.startsWith('继续') && typed.userInput.includes('合并手册-轮次1.md'));
    await wait(async () => (await state(b)).done, 'room B done', 30000);
    ok('审查交付后任务完成', true);
    fs.writeFileSync(path.join(ART, 'checks.json'), JSON.stringify({ checks, isolatedHubPid: hub.child?.pid || hub.pid, dataDir: DATA, dispatcher: 'controlled fixture (renames drafts)', calls: calls().map(c => ({ meetingId: c.meetingId.slice(0, 8), to: c.targetMemberIds, head: c.userInput.slice(0, 60) })) }, null, 2));
    console.log('ARTIFACTS ' + ART);
  } catch (error) {
    if (cdp) { try { const r = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(ART, 'failure.png'), Buffer.from(r.data, 'base64')); } catch {} }
    fs.writeFileSync(path.join(ART, 'failure-calls.json'), JSON.stringify(calls(), null, 2));
    throw error;
  } finally { if (cdp) await cdp.close(); if (hub) await gracefulQuit(hub); }
}
run().catch(error => { console.error(error); console.error('ARTIFACT_ROOT ' + ROOT); process.exitCode = 1; });
