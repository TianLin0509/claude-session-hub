'use strict';
// AI 编排模式界面：真实隔离 Electron + 真实 UI 点击 + 真实 IPC 与持久化。
// 模型派发用受控夹具（不调用真实模型）；编排员的工具调用经真实 Hub 桥（HTTP + 身份请求头）发出。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-orch-ui-'));
const WORK = path.join(ROOT, 'work'), DATA = path.join(ROOT, 'data');
const ART = path.resolve(__dirname, '../output/playwright', `orchestration-ui-${Date.now()}`);
const LOG = path.join(ROOT, 'dispatch.jsonl'), SCRIPT = path.join(ROOT, 'dispatch.js');
fs.mkdirSync(WORK, { recursive: true }); fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(ART, { recursive: true });
fs.writeFileSync(path.join(DATA, 'prepared-projects.json'), JSON.stringify({ schemaVersion: 1, projects: [], migrations: [] }));
fs.writeFileSync(path.join(WORK, '.aiwork-root'), '');
fs.writeFileSync(SCRIPT, `const fs=require('fs'); module.exports=args=>{ fs.appendFileSync(${JSON.stringify(LOG)},JSON.stringify({targetMemberIds:args.targetMemberIds,recipientSids:args.recipientSids,userInput:String(args.userInput||'').slice(0,200),kind:args.workflowRun&&args.workflowRun.kind})+'\\n'); return {text:'受控回答'}; };`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const calls = () => fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(e => e ? reject(e) : resolve(p)); }); });

async function run() {
  let hub, cdp;
  const evidence = { checks: [], root: ROOT, artifacts: ART, dispatcher: 'controlled fixture' };
  const ok = (label, condition) => { assert(condition, label); evidence.checks.push(label); console.log('PASS ' + label); };
  try {
    hub = await launchIsolatedHub({ dataDir: DATA, port: await freePort(), windowMode: 'hidden',
      extraEnv: { CLAUDE_HUB_TEST_DISPATCH_SCRIPT: SCRIPT, AI_HUB_WORKSPACE_ROOT: WORK, CODEX_HOME: path.join(ROOT, 'codex'), CLAUDE_CONFIG_DIR: path.join(ROOT, 'claude') } });
    cdp = await connectFirstPage(hub, t => /index\.html/.test(t.url));
    const wait = async (fn, label, ms = 25000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await sleep(150); } throw new Error('Timeout: ' + label); };
    const invoke = (channel, args = {}) => cdp.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(channel)},${JSON.stringify(args)})`);
    const click = async selector => {
      const p = await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}); if(!e) throw Error('Missing '+${JSON.stringify(selector)}); e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); const x=r.x+r.width/2,y=r.y+r.height/2; if(!r.width||!r.height||!e.contains(document.elementFromPoint(x,y))) throw Error('Not clickable '+${JSON.stringify(selector)}); return {x,y};})()`);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', clickCount: 1 });
    };
    const shot = async name => { const s = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(ART, name + '.png'), Buffer.from(s.data, 'base64')); };
    const typeAndSend = async text => {
      await cdp.eval("(()=>{const b=document.getElementById('mr-input-box'); b.focus(); const r=document.createRange();r.selectNodeContents(b);const s=getSelection();s.removeAllRanges();s.addRange(r);})()");
      await cdp.send('Input.insertText', { text });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    };
    await wait(() => cdp.eval('!!window.openMeetingCreateModal && !!window.MeetingRoom'), 'UI ready');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });

    // 1. 启动中心 → AI 群聊 → 打开编排员开关 → 删掉初始成员 → 建群
    await cdp.eval("document.getElementById('btn-new-more').click()");
    await wait(() => cdp.eval("!!document.getElementById('launch-intent-group')"), 'launch center');
    await click('#launch-intent-group');
    await wait(() => cdp.eval("!!document.querySelector('#new-session-menu #mcm-orch-toggle')"), 'orchestration toggle');
    ok('编排开关默认关闭，选项隐藏', await cdp.eval("!document.getElementById('mcm-orch-toggle').checked && document.getElementById('mcm-orch-options').hidden"));
    await click('#new-session-menu [data-mcm-scene="general"]');
    await click('#new-session-menu [data-mcm-workspace-mode="default"]');
    await click('#new-session-menu .mcm-orch-switch');
    ok('打开后成员 1 标为编排员、显示三个设置', await cdp.eval("document.getElementById('mcm-orch-toggle').checked && !document.getElementById('mcm-orch-options').hidden && document.querySelector('.mcm-slot[data-slot=\"0\"] .mcm-slot-label').textContent.includes('编排员') && document.querySelector('.mcm-slot[data-slot=\"1\"] .mcm-slot-label').textContent.includes('工作成员')"));
    await cdp.eval("(()=>{const r=document.getElementById('mcm-orch-rounds'); r.value='6'; r.dispatchEvent(new Event('input',{bubbles:true}));})()");

    ok('用户预先选定工作成员', await cdp.eval("document.querySelectorAll('#new-session-menu .mcm-slot').length===2"));
    await shot('01-create');
    const before = (await invoke('get-meetings')).length;
    await cdp.eval("[...document.querySelectorAll('#new-session-menu button')].find(b=>b.textContent.trim()==='创建群聊').click()");
    const meeting = await wait(async () => { const all = await invoke('get-meetings'); return all.length > before && all.find(m => m.orchestration?.enabled && m.orchestration.sessionId); }, 'orchestration room created', 40000);
    evidence.meeting = { id: meeting.id, orchestration: meeting.orchestration, participants: meeting.participants };
    ok('群里登记了编排员身份与设置', meeting.orchestration.memberId === 'm1' && meeting.orchestration.settings.roundCap === 6 && meeting.subSessions.length === 2 && JSON.stringify(meeting.participants) === '[0]');
    const session = await cdp.eval(`(()=>{const s=sessions.get(${JSON.stringify(meeting.orchestration.sessionId)}); return s && {purpose:s.purpose,kind:s.kind};})()`);
    ok('编排员是真实会话（purpose=hub-orchestrator）', session && session.purpose === 'hub-orchestrator');
    await cdp.eval(`selectMeeting(${JSON.stringify(meeting.id)})`);
    await wait(() => cdp.eval("!!document.querySelector('.mr-orch-strip')"), 'orchestration strip');
    ok('标题旁与侧栏都有「编排」标签', await cdp.eval("!!document.querySelector('#mr-title + .mr-orch-title-tag') && [...document.querySelectorAll('.sl-orch-tag')].length>=1"));
    ok('状态条显示等编排员提交计划', await cdp.eval("document.querySelector('.mr-orch-strip').textContent.includes('等编排员提交计划')"));
    await shot('02-room-planning');

    // 2. 田哥发消息：只发给编排员
    await typeAndSend('帮我调研 AI Hub 群聊回答文件机制的失败场景，允许10轮以内迭代，最多半小时');
    await wait(() => calls().length >= 1, 'user dispatch');
    ok('输入框默认只发给编排员', JSON.stringify(calls()[0].recipientSids || []) === JSON.stringify([meeting.orchestration.sessionId]) || JSON.stringify(calls()[0].targetMemberIds || []) === '["m1"]');

    // 3. 编排员经 Hub 桥提交计划 → 状态条与卡片按钮
    const endpoint = JSON.parse(fs.readFileSync(path.join(DATA, 'orchestration', 'bridge-endpoint.json'), 'utf8'));
    const tool = async (name, args, caller = meeting.orchestration.sessionId) => {
      const r = await fetch(endpoint.url, { method: 'POST', headers: { Authorization: 'Bearer ' + endpoint.token, 'Content-Type': 'application/json', 'X-Hub-Orchestrator-Session': caller }, body: JSON.stringify({ name, arguments: args }) });
      return r.json();
    };
    ok('非编排员会话调用工具被拒', (await tool('orch_status', {}, 'not-the-orchestrator')).ok === false);
    const plan = await tool('orch_propose_plan', { summary: '一位 Codex 调研、一位 Claude 收口', team: [{memberId:'m2',role:'调研与收口'}], segments: [{ name: '失败场景调研', preset: 'research', goal: '列出失败场景', acceptance: '每个场景附代码位置' }] });
    ok('计划提交成功并等待确认', plan.ok && plan.result.status === 'awaiting_confirm');
    const early = await tool('orch_add_member', { role: '调研', kind: 'codex' });
    ok('编排员不能新增成员', early.ok === false && /已有成员/.test(early.error));
    await wait(() => cdp.eval("!!document.querySelector('.mr-orch-strip [data-orch-action=\"confirm\"]')"), 'confirm button');
    await click('[data-orch-ledger]');
    await wait(() => cdp.eval("!!document.querySelector('.mr-orch-ledger')"), 'ledger panel');
    ok('计划账本展开显示计划与待确认', await cdp.eval("document.querySelector('.mr-orch-ledger').textContent.includes('一位 Codex 调研') && document.querySelector('.mr-orch-ledger').textContent.includes('待确认')"));
    await shot('03-plan-awaiting');
    ok('确认前显示自然语言额度与生效时机', await cdp.eval("document.querySelector('.mr-orch-ledger').textContent.includes('10 轮') && document.querySelector('.mr-orch-ledger').textContent.includes('30 分钟') && document.querySelector('.mr-orch-ledger').textContent.includes('确认后生效')"));
    await click('.mr-orch-strip [data-orch-action="confirm"]');
    await wait(async () => (await invoke('orchestration:view', { meetingId: meeting.id })).view.status === 'running', 'confirmed');
    const budget=(await invoke('orchestration:view',{meetingId:meeting.id})).view.budget; ok('自然语言额度确认后实际生效',budget.roundCap===10 && budget.minutesCap===30);
    ok('点「确认计划」后进入编排中', await cdp.eval("document.querySelector('.mr-orch-strip').textContent.includes('编排中')"));

    // 4. 组队：成员加入后收件人仍只有编排员；@成员 直接点名
    const added = await tool('orch_add_member', { role: '调研', kind: 'codex', tier: 'fast' });
    ok('确认后仍不能新增成员', !added.ok && /已有成员/.test(added.error));
    const room = await wait(async () => (await invoke('get-meetings')).find(m => m.id === meeting.id && m.subSessions.length === 2), 'member joined');
    ok('新成员加入后收件人仍只有编排员', JSON.stringify(room.participants) === '[0]');
    const n = calls().length;
    await typeAndSend('@m2 先看 core/group-answer-files.js');
    await wait(() => calls().length > n, 'direct dispatch');
    const direct = calls().at(-1);
    ok('@成员 时直接发给被点名的成员', JSON.stringify(direct.recipientSids || []) === JSON.stringify([room.subSessions[1]]) || JSON.stringify(direct.targetMemberIds || []) === '["m2"]');
    await wait(async () => { const l = JSON.parse(fs.readFileSync(path.join(DATA, 'task-docs', meeting.id, 'orchestration', 'ledger.json'), 'utf8')); return l.notices.some(x => /直接对 m2 说/.test(x.text)) || calls().some(c => c.kind === 'orch-notice' && /直接对 m2/.test(c.userInput)); }, 'copy to orchestrator');
    ok('点名成员时抄送编排员', true);

    // 5. 需要田哥决定：状态条变红 → 恢复编排
    const decide = await tool('orch_report', { kind: 'need_decision', summary: '调研范围比预想大，建议拆两段' });
    ok('编排员请你决定时暂停', decide.ok && decide.result.status === 'halted');
    await wait(() => cdp.eval("document.querySelector('.mr-orch-strip.is-halted [data-orch-action=\"resume\"]')"), 'halted strip');
    await shot('04-halted');
    await click('.mr-orch-strip [data-orch-action="resume"]');
    await wait(async () => (await invoke('orchestration:view', { meetingId: meeting.id })).view.status === 'running', 'resumed');
    ok('点「恢复编排」后继续', true);

    // 6. 结束编排 → 回到普通群聊路由 → 恢复编排
    await click('.mr-orch-strip [data-orch-action="end"]');
    await wait(() => cdp.eval("document.querySelector('.mr-orch-strip').textContent.includes('编排已结束')"), 'ended');
    const m2 = calls().length;
    await typeAndSend('现在是普通群聊');
    await wait(() => calls().length > m2, 'plain dispatch');
    ok('结束编排后按普通群聊勾选发送', JSON.stringify(calls().at(-1).recipientSids || []) === JSON.stringify([room.subSessions[0]]));
    await click('.mr-orch-strip [data-orch-action="resume"]');
    await wait(() => cdp.eval("!document.querySelector('.mr-orch-strip').textContent.includes('编排已结束')"), 'resumed after end');
    ok('可以恢复编排', true);
    await shot('05-final');

    // 7. 关掉开关建群 = 现在的群聊（不带编排）
    await cdp.eval("document.getElementById('btn-new-more').click()");
    await click('#launch-intent-group');
    await wait(() => cdp.eval("!!document.querySelector('#new-session-menu #mcm-orch-toggle') && !document.getElementById('mcm-orch-toggle').checked"), 'toggle reset');
    ok('重新打开建群页时开关恢复关闭', true);
    evidence.ok = true;
  } catch (error) {
    evidence.error = error.stack;
    if (cdp) { try { const s = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(ART, 'failure.png'), Buffer.from(s.data, 'base64')); evidence.ui = await cdp.eval('document.body.innerText.slice(-4000)'); } catch {} }
    throw error;
  } finally {
    if (hub) fs.writeFileSync(path.join(ART, 'hub.log'), hub.log().join('\n'));
    if (cdp) { try { await cdp.close(); } catch {} }
    if (hub) { try { await gracefulQuit(hub); } catch (e) { evidence.cleanupError = e.message; } }
    fs.writeFileSync(path.join(ART, 'checks.json'), JSON.stringify(evidence, null, 2));
    console.log('ARTIFACT_ROOT ' + ART);
  }
}
run().catch(e => { console.error(e); process.exitCode = 1; });
