'use strict';
// Real isolated Electron/UI/IPC/task files/Git/Hub test gate. The dispatcher
// is a fixture that plays both agents by writing their delivery files; this is
// not a real-model E2E. Covers: new rooms on the delivery engine, the user only
// types the task, Hub-run gate before review, review convergence prompts, and
// migration of a legacy file-flow room on restart.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { execFileSync } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-devflow-'));
const DATA = path.join(ROOT, 'data'), SCRIPT = path.join(ROOT, 'dispatch.js'), LOG = path.join(ROOT, 'calls.jsonl'), CTL = path.join(ROOT, 'control.json');
const ART = path.resolve(__dirname, '..', 'artifacts', 'delivery-dev-flow');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
fs.mkdirSync(ART, { recursive: true });

// A project repo whose declared test takes ~3s, so the gate state is visible.
const WORK = path.join(ROOT, 'work'); fs.mkdirSync(WORK); fs.writeFileSync(path.join(WORK, '.aiwork-root'), '');
const REPO = path.join(WORK, 'project');
fs.mkdirSync(path.join(REPO, '.agents'), { recursive: true });
const git = (...a) => execFileSync('git', ['-C', REPO, ...a], { encoding: 'utf8', windowsHide: true }).trim();
git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
fs.writeFileSync(path.join(REPO, '.agents', 'project.json'), JSON.stringify({ name: '开发流验收项目', trunk: 'master', test: ['node -e "setTimeout(()=>process.exit(0),3000)"'] }));
git('add', '-A'); git('commit', '-qm', 'init');
const SHA = git('rev-parse', 'HEAD');
new (require('../core/prepared-project-registry').PreparedProjectRegistry)({ dataDir: DATA }).register(REPO);
fs.writeFileSync(CTL, JSON.stringify({ reworkReviews: 1, candidate: `CANDIDATE: ${REPO} ${SHA}` }));
fs.writeFileSync(SCRIPT, `const fs=require('fs');
module.exports=(args,ctx)=>{
  const u=String(args.userInput||'');
  fs.appendFileSync(${JSON.stringify(LOG)},JSON.stringify({meetingId:ctx.meetingId,targetMemberIds:args.targetMemberIds,recipientSids:args.recipientSids,userInput:u})+'\\n');
  const ctl=JSON.parse(fs.readFileSync(${JSON.stringify(CTL)},'utf8'));
  const pick=re=>{const m=re.exec(u);return m?m[1].trim():null;};
  const draft=pick(/草稿：(.+)/),ready=pick(/完成后改名为：(.+)/),rework=pick(/确有需返工问题改名为：(.+)/),head=pick(/文件第一行必须原样保留：(.+)/);
  if(!draft||!ready||!head)return {text:'没有交付路径'};
  const review=!!rework,build=/CANDIDATE:/.test(u)&&!review;
  const reviewsSoFar=fs.readFileSync(${JSON.stringify(LOG)},'utf8').trim().split('\\n').map(JSON.parse).filter(c=>c.meetingId===ctx.meetingId&&/确有需返工问题改名为/.test(c.userInput)).length;
  const out=review&&reviewsSoFar<=ctl.reworkReviews?rework:ready;
  const body=build?'实现完成，自测通过。\\n'+ctl.candidate:review&&out===rework?'P1：示例阻断项':'已完成本轮职责。';
  fs.writeFileSync(draft,head+'\\n\\n'+body,'utf8');fs.renameSync(draft,out);
  return {text:'已交付 '+out};
};`);
const calls = id => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []).filter(c => !id || c.meetingId === id);

async function launch() {
  return launchIsolatedHub({ dataDir: DATA, port: await freePort(), windowMode: 'hidden', label: 'delivery-dev-flow', extraEnv: {
    CLAUDE_HUB_TEST_DISPATCH_SCRIPT: SCRIPT, AI_HUB_WORKSPACE_ROOT: WORK, CLAUDE_HUB_HOME_DIR: path.join(ROOT, 'home'),
    CODEX_HOME: path.join(ROOT, 'codex'), CLAUDE_CONFIG_DIR: path.join(ROOT, 'claude'), CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE: path.join(__dirname, 'fixtures/codex-app-server.js') } });
}
async function run() {
  let hub, cdp;
  const checks = [], ok = (name, value) => { assert(value, name); checks.push(name); console.log('PASS ' + name); };
  const wait = async (predicate, label, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await predicate()) return; await sleep(200); } throw new Error('Timeout: ' + label); };
  const invoke = (channel, args = {}) => cdp.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(channel)}, ${JSON.stringify(args)})`);
  const shot = async file => { const r = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(ART, file), Buffer.from(r.data, 'base64')); };
  const click = async sel => {
    await wait(() => cdp.eval(`!!document.querySelector(${JSON.stringify(sel)})`), 'visible ' + sel, 20000);
    const p = await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
  };
  const connect = async () => { cdp = await connectFirstPage(hub, t => /index\.html/.test(t.url)); await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }); await wait(() => cdp.eval('!!window.MeetingRoom && !!window.openMeetingCreateModal'), 'renderer'); };
  const meeting = async id => (await invoke('get-meetings')).find(x => x.id === id);
  try {
    hub = await launch(); await connect();

    // 1) New room through the real create dialog lands on the delivery engine.
    await cdp.eval("openMeetingCreateModal('group')"); await click('[data-mcm-workspace-mode="default"]'); await click('[data-mcm-scene="dev"]');
    await cdp.eval(`document.querySelectorAll('.mcm-ai-select').forEach(s=>{s.value='codex';s.dispatchEvent(new Event('change',{bubbles:true}));})`);
    await click('#meeting-create-modal .mcm-create');
    await wait(() => cdp.eval("!!document.querySelector('.mr-delivery-flow')"), 'delivery bar in new room', 30000);
    const created = (await invoke('get-meetings')).find(m => m.groupChat);
    ok('新建开发群直接使用新引擎（逐成员交付）', created.serialWorkflow.deliveryVersion === 1 && created.serialWorkflow.deliveryKind === 'file' && !created.serialWorkflow.fileFlowVersion);
    ok('新建群不再出现旧版「开题」按钮', await cdp.eval("!document.querySelector('[data-file-kickoff]')"));
    ok('输入框提示：只管输入任务', (await cdp.eval("document.getElementById('mr-input-box').dataset.placeholder")).includes('Hub 按工作流安排'));
    await shot('01-new-room-delivery.png');

    // 2) Fixture room: the user types a task with the reviewer lit.
    const m = await invoke('create-meeting', { mode: 'dev', groupChat: true, title: '新引擎开发流验收', workspace: REPO, slotSpecs: [{ index: 0, kind: 'codex', memberId: 'm1' }, { index: 1, kind: 'claude', memberId: 'm2' }] });
    await invoke('test:seed-groupchat-members', { meetingId: m.id, count: 2 });
    const config = await cdp.eval("require('../core/workflow-settings').createDeliveryConfig('development',[{memberId:'m1'},{memberId:'m2'}])");
    await invoke('update-meeting-sync', { meetingId: m.id, fields: { serialWorkflow: config } });
    await cdp.eval(`require('electron').ipcRenderer.invoke('groupchat:set-participants',{meetingId:${JSON.stringify(m.id)},participants:[1]}).then(r=>window.MeetingRoom.updateMeetingData(${JSON.stringify(m.id)},r.meeting))`);
    await cdp.eval(`selectMeeting(${JSON.stringify(m.id)})`);
    await wait(() => cdp.eval("!!document.querySelector('.mr-delivery-flow')"), 'delivery bar');
    await click('#mr-input-box'); await cdp.send('Input.insertText', { text: '给项目加一个版本号显示' });
    for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await wait(() => calls(m.id).length >= 1, 'kickoff dispatch');
    ok('只输入任务：Hub 把开题交给 m1，而非点亮的审查位', JSON.stringify(calls(m.id)[0].targetMemberIds) === '["m1"]');
    ok('开题提示词含失败模式清单与历史教训', /失败模式清单/.test(calls(m.id)[0].userInput) && /project-lessons/.test(calls(m.id)[0].userInput));
    await wait(() => cdp.eval("document.querySelector('.mr-delivery-flow')?.innerText.includes('Hub 正在跑测试闸门')"), 'gate visible in UI', 60000);
    ok('实现交付后状态栏显示 Hub 正在跑测试闸门', true);
    await shot('02-hub-gate-running.png');
    await wait(() => calls(m.id).length >= 3, 'first review', 60000);
    const r1 = calls(m.id)[2];
    ok('闸门通过后才派审查位 m2', JSON.stringify(r1.targetMemberIds) === '["m2"]' && r1.userInput.includes(`Hub 已在候选 ${SHA}`));
    ok('第 1 轮审查要求一次列全并分级', r1.userInput.includes('第 1 轮审查：一次列全'));
    ok('审查可自行解决机械性冲突', r1.userInput.includes('机械性的'));
    await wait(() => calls(m.id).length >= 5, 'second review', 90000);
    const r2 = calls(m.id)[4];
    ok('第 2 轮按复审口径：新 P2 不阻断', r2.userInput.includes('第 2 轮审查（复审）') && r2.userInput.includes('不阻断合并'));
    await wait(async () => (await invoke('delivery:status', { meetingId: m.id })).done, 'run done', 30000);
    ok('返工一次后完成', calls(m.id).length === 5);
    const gateLogs = fs.readdirSync(path.join(DATA, 'task-docs', m.id, 'deliveries'), { recursive: true }).filter(n => /hub-gate\.log$/.test(String(n)));
    ok('每次实现交付都由 Hub 跑了测试闸门', gateLogs.length === 2);
    await shot('03-done.png');

    // 3) A legacy file-flow room migrates on restart.
    const legacy = await invoke('create-meeting', { mode: 'dev', groupChat: true, title: '旧文件流群', workspace: REPO, slotSpecs: [{ index: 0, kind: 'codex', memberId: 'm1' }, { index: 1, kind: 'claude', memberId: 'm2' }] });
    await invoke('test:seed-groupchat-members', { meetingId: legacy.id, count: 2 });
    const oldConfig = await cdp.eval("window.WorkflowTemplates.createTemplateConfig('dev-task',[{memberId:'m1',kind:'codex'},{memberId:'m2',kind:'claude'}])");
    await invoke('update-meeting-sync', { meetingId: legacy.id, fields: { serialWorkflow: oldConfig } });
    ok('旧群重启前是文件流协议', (await meeting(legacy.id)).serialWorkflow.fileFlowVersion === 2);
    await cdp.close(); cdp = null; await gracefulQuit(hub); hub = null;
    hub = await launch(); await connect();
    const migrated = await meeting(legacy.id);
    ok('重启后旧群迁移到新引擎并备份旧配置', migrated.serialWorkflow.deliveryVersion === 1 && migrated.serialWorkflow.migratedFrom?.protocol === 'fileflow' && migrated.serialWorkflow.migratedFrom.previous.fileFlowVersion === 2);
    await cdp.eval(`selectMeeting(${JSON.stringify(legacy.id)})`);
    await wait(() => cdp.eval("!!document.querySelector('.mr-delivery-flow') && !document.querySelector('[data-file-kickoff]')"), 'migrated room shows delivery bar');
    ok('迁移后的群显示新引擎状态栏', true);
    ok('迁移记录已写入', fs.existsSync(path.join(DATA, 'workflow-migration.jsonl')));
    fs.writeFileSync(path.join(ART, 'checks.json'), JSON.stringify({ checks, dispatcher: 'controlled fixture (writes delivery files)', gate: 'real Hub gate on a real Git commit', calls: calls().map(c => ({ to: c.targetMemberIds, head: c.userInput.slice(0, 50) })) }, null, 2));
    console.log('ARTIFACTS ' + ART);
  } catch (error) {
    if (cdp) { try { await shot('failure.png'); } catch {} }
    fs.writeFileSync(path.join(ART, 'failure-calls.json'), JSON.stringify(calls(), null, 2));
    throw error;
  } finally { if (cdp) await cdp.close(); if (hub) await gracefulQuit(hub); }
}
run().catch(error => { console.error(error); console.error('ARTIFACT_ROOT ' + ROOT); process.exitCode = 1; });
