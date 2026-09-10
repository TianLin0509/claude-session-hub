'use strict';
// Real isolated Electron/UI/IPC/files; controlled dispatcher, not a real-model E2E.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-fileflow-i-'));
const DATA = path.join(ROOT, 'data'), SCRIPT = path.join(ROOT, 'dispatch.js'), LOG = path.join(ROOT, 'calls.jsonl');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
fs.writeFileSync(SCRIPT, `const fs=require('fs'); module.exports=(args, ctx)=> { fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify(args)+'\\n'); return {text:'已收到提示词；本次测试的文件由受控 fixture 交付。'}; };`);
const calls = () => fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
async function run() {
  let hub, cdp;
  const checks = [];
  const ok = (name, value) => { assert(value, name); checks.push(name); console.log('PASS ' + name); };
  try {
    hub = await launchIsolatedHub({ dataDir: DATA, port: await freePort(), windowMode: 'hidden', extraEnv: { CLAUDE_HUB_TEST_DISPATCH_SCRIPT: SCRIPT } });
    cdp = await connectFirstPage(hub, t => /index\.html/.test(t.url));
    const wait = async (predicate, label, ms = 15000) => { const deadline = Date.now() + ms; while (Date.now() < deadline) { if (await predicate()) return; await sleep(150); } throw new Error('Timeout: ' + label); };
    await wait(() => cdp.eval('!!window.MeetingRoom && !!window.WorkflowTemplates'), 'renderer');
    const invoke = (channel, args = {}) => cdp.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(channel)}, ${JSON.stringify(args)})`);
    const m = await invoke('create-meeting', { mode: 'dev', groupChat: true, title: '文件工作流验收', workspace: ROOT,
      slotSpecs: [{ index: 0, kind: 'codex', memberId: 'm1' }, { index: 1, kind: 'claude', memberId: 'm2' }] });
    const id = m.id;
    await invoke('test:seed-groupchat-members', { meetingId: id, count: 2 });
    const config = await cdp.eval("window.WorkflowTemplates.createTemplateConfig('dev-task', [{memberId:'m1',kind:'codex'},{memberId:'m2',kind:'claude'}])");
    await invoke('update-meeting-sync', { meetingId: id, fields: { serialWorkflow: config } });
    const getMeeting = async () => (await invoke('get-meetings')).find(x => x.id === id);
    let fresh = await getMeeting();
    await cdp.eval(`selectMeeting(${JSON.stringify(id)})`);
    await wait(() => cdp.eval("!!document.querySelector('[data-file-kickoff]')"), 'kickoff button');
    const before = calls().length;
    await cdp.eval("document.getElementById('mr-input-box').textContent='修复任务 A\\n保留用户补充'; document.querySelector('[data-file-kickoff]').click()");
    await wait(() => cdp.eval("document.getElementById('mr-input-box').innerText.includes('【开题提示词结束】')"), 'prefill');
    ok('开题预填保留原文', await cdp.eval("document.getElementById('mr-input-box').innerText.startsWith('修复任务 A\\n保留用户补充')"));
    ok('仅点亮第一席位', JSON.stringify((await getMeeting()).participants) === '[0]');
    const docs = path.join(DATA, 'task-docs', id);
    ok('点击开题不派工、不创建阶段文件', calls().length === before && !fs.existsSync(docs));
    await cdp.eval("document.querySelector('[data-file-kickoff]').click()");
    await sleep(500);
    ok('重复点击不会叠加提示词', await cdp.eval("document.getElementById('mr-input-box').innerText.split('【AI HUB 开题提示词】').length===2"));
    ok('移除旧循环与重发控件', await cdp.eval("!document.querySelector('[data-dev-redispatch],[data-loop-resume],[data-workflow-stop]')"));
    ok('新房间不能启动旧串行引擎', !(await invoke('serial:start', { meetingId: id, userInput: 'bad' })).ok);
    // Normal Enter invokes the real composer handler and IPC. The dispatcher is the only fake boundary.
    await cdp.eval("document.getElementById('mr-input-box').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', code:'Enter', bubbles:true, cancelable:true}))");
    await wait(() => calls().length > before, 'normal Enter sends');
    ok('Enter 发送用户检查后的整条 prompt', calls()[before].userInput.includes('保留用户补充') && calls()[before].userInput.includes('开题报告.md'));
    fs.mkdirSync(docs, { recursive: true }); fs.writeFileSync(path.join(docs, '开题报告.md'), '');
    const state = () => invoke('dev-file:status', { meetingId: id });
    await wait(async () => (await state()).phase === 'kickoff', 'draft phase');
    fs.renameSync(path.join(docs, '开题报告.md'), path.join(docs, '已完成-开题报告.md'));
    await wait(() => calls().some(x => x.workflowRun?.stepIndex === 1), 'automatic build');
    ok('只认文件名派施工，空正文不会触发额外内容门槛', calls().some(x => x.userInput.includes('实现手册-轮次1.md')));
    fs.writeFileSync(path.join(docs, '已完成-实现手册-轮次1.md'), 'RESULT: FAIL\n这段不参与 Hub 状态识别');
    await wait(() => calls().some(x => x.workflowRun?.stepIndex === 2), 'automatic merge');
    ok('自动合并派工同步点亮第二席位', JSON.stringify((await getMeeting()).participants) === '[1]');
    await wait(() => cdp.eval("!!document.querySelector('[data-file-stop]')"), 'single stop');
    await cdp.eval("document.querySelector('[data-file-stop]').click()");
    await wait(async () => (await state()).paused, 'stop persisted');
    const count = calls().length;
    fs.writeFileSync(path.join(docs, '需返工-合并手册-轮次1.md'), '');
    await sleep(1300); ok('停止后迟到文件不派工', calls().length === count);
    await invoke('groupchat:turn', { meetingId: id, userInput: '现在进展如何' });
    ok('进度询问不恢复', (await state()).paused);
    await cdp.eval("document.getElementById('mr-input-box').textContent='继续'; document.getElementById('mr-input-box').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', code:'Enter', bubbles:true, cancelable:true}))");
    await wait(() => calls().some(x => x.workflowRun?.stepIndex === 3), 'continue round 2');
    ok('继续接续第 2 轮并点亮工作位', !(await state()).paused && JSON.stringify((await getMeeting()).participants) === '[0]');
    await wait(() => cdp.eval("document.querySelector('.mr-file-detail')?.innerText.includes('第 2 轮')"), 'UI phase sync');
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ROOT, 'fileflow-ui.png'), Buffer.from(shot.data, 'base64'));
    const board = await invoke('dev-workbench:get-snapshot');
    fs.writeFileSync(path.join(ROOT, 'workbench.json'), JSON.stringify(board, null, 2));
    fs.writeFileSync(path.join(ROOT, 'checks.json'), JSON.stringify({ checks, isolatedHubPid: hub.child.pid, dataDir: DATA, dispatcher: 'controlled fixture' }, null, 2));
    await invoke('groupchat:interrupt', { meetingId: id });
    console.log('ARTIFACT_ROOT ' + ROOT);
  } finally { if (cdp) await cdp.close(); if (hub) await gracefulQuit(hub); }
}
run().catch(error => { console.error(error); console.error('ARTIFACT_ROOT ' + ROOT); process.exitCode = 1; });
