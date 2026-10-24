'use strict';
// AI 编排模式界面：真实隔离 Electron + 真实 UI 点击 + 真实 IPC 与持久化。
// 模型派发用受控夹具（不调用真实模型）；负责人的工具调用经真实 Hub 桥（HTTP + 身份请求头）发出。
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
fs.writeFileSync(path.join(DATA,'usage-cache.json'),JSON.stringify({antigravity:{observedAt:Date.now(),credits:0,groups:[{id:'gemini',label:'Gemini Models',usage7d:{pct:100,resetsAt:'2026-10-27T07:24:20Z'}},{id:'thirdParty',label:'Claude and GPT models',usage7d:{pct:8,resetsAt:'2026-10-27T07:24:20Z'}}]}}));
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
    await wait(()=>cdp.eval("document.querySelector('[data-provider=antigravity]')?.textContent.includes('0%')"),'Antigravity quota');
    ok('底栏只显示 Antigravity 的 Gemini 剩余和真实零 credits',await cdp.eval("(()=>{const e=document.querySelector('[data-provider=antigravity]');return !e.textContent.includes('C/G') && e.title.includes('credits 余额：0');})()"));
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:960,height:800,deviceScaleFactor:1,mobile:false});
    await wait(()=>cdp.eval("document.querySelector('.footer-quota-summary')?.textContent.includes('Antigravity G 0%')"),'tightest Antigravity summary');
    ok('底栏紧凑汇总仍指出 Antigravity 耗尽',true);
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await shot('00-antigravity-footer');

    // 1. 启动中心 → AI 群聊 → 打开负责人开关 → 删掉初始成员 → 建群
    await cdp.eval("document.getElementById('btn-new-more').click()");
    await wait(() => cdp.eval("!!document.getElementById('launch-intent-group')"), 'launch center');
    await click('#launch-intent-group');
    await wait(() => cdp.eval("!!document.querySelector('#new-session-menu #mcm-orch-toggle')"), 'orchestration toggle');
    ok('编排开关默认关闭，选项隐藏', await cdp.eval("!document.getElementById('mcm-orch-toggle').checked && document.getElementById('mcm-orch-options').hidden"));
    await click('#new-session-menu [data-mcm-scene="general"]');
    await click('#new-session-menu [data-mcm-workspace-mode="default"]');
    await click('#new-session-menu .mcm-orch-switch');
    ok('打开后成员 1 标为负责人、显示自然语言编排说明（没有「计划先给我确认」）', await cdp.eval("!document.getElementById('mcm-orch-confirm')") && await cdp.eval("document.getElementById('mcm-orch-toggle').checked && !document.getElementById('mcm-orch-options').hidden && document.querySelector('.mcm-slot[data-slot=\"0\"] .mcm-slot-label').textContent.includes('负责人') && document.querySelector('.mcm-slot[data-slot=\"1\"] .mcm-slot-label').textContent.includes('工作成员')"));
    ok('没有固定轮次或时长输入', await cdp.eval("!document.getElementById('mcm-orch-rounds') && !document.getElementById('mcm-orch-hours')"));
    await cdp.eval("(()=>{const s=document.querySelector('.mcm-slot[data-slot=\"0\"] .mcm-ai-select');s.value='gemini';s.dispatchEvent(new Event('change',{bubbles:true}));})()");
    ok('Antigravity 可以担任负责人', await cdp.eval("document.querySelector('.mcm-slot[data-slot=\"0\"] .mcm-ai-select').value==='gemini'"));

    ok('用户预先选定工作成员', await cdp.eval("document.querySelectorAll('#new-session-menu .mcm-slot').length===2"));
    await shot('01-create');
    const before = (await invoke('get-meetings')).length;
    await cdp.eval("[...document.querySelectorAll('#new-session-menu button')].find(b=>b.textContent.trim()==='创建群聊').click()");
    const meeting = await wait(async () => { const all = await invoke('get-meetings'); return all.length > before && all.find(m => m.orchestration?.enabled && m.orchestration.sessionId); }, 'orchestration room created', 40000);
    evidence.meeting = { id: meeting.id, orchestration: meeting.orchestration, participants: meeting.participants };
    ok('群里登记了负责人身份与设置', meeting.orchestration.memberId === 'm1' && meeting.orchestration.settings.coordination === 'star' && meeting.subSessions.length === 2 && JSON.stringify(meeting.participants) === '[0]');
    const session = await cdp.eval(`(()=>{const s=sessions.get(${JSON.stringify(meeting.orchestration.sessionId)}); return s && {purpose:s.purpose,kind:s.kind};})()`);
    ok('负责人是真实会话（purpose=hub-orchestrator）', session && session.purpose === 'hub-orchestrator');
    await cdp.eval(`selectMeeting(${JSON.stringify(meeting.id)})`);
    await wait(() => cdp.eval("!!document.querySelector('.mr-orch-strip')"), 'orchestration strip');
    ok('标题旁与侧栏都有「编排」标签', await cdp.eval("!!document.querySelector('#mr-title + .mr-orch-title-tag') && [...document.querySelectorAll('.sl-orch-tag')].length>=1"));
    ok('状态条显示等负责人提交计划', await cdp.eval("document.querySelector('.mr-orch-strip').textContent.includes('等负责人提交计划')"));
    await shot('02-room-planning');

    // 2. 田哥发消息：只发给负责人
    await typeAndSend('帮我调研 AI Hub 群聊回答文件机制的失败场景，允许10轮以内迭代，最多半小时');
    await wait(() => calls().length >= 1, 'user dispatch');
    ok('输入框默认只发给负责人', JSON.stringify(calls()[0].recipientSids || []) === JSON.stringify([meeting.orchestration.sessionId]) || JSON.stringify(calls()[0].targetMemberIds || []) === '["m1"]');

    // 3. 负责人经 Hub 桥提交计划 → 提交即生效，界面没有确认按钮
    const endpoint = JSON.parse(fs.readFileSync(path.join(DATA, 'orchestration', 'connections', meeting.orchestration.sessionId + '.json'), 'utf8'));
    const tool = async (name, args, caller = meeting.orchestration.sessionId) => {
      const r = await fetch(endpoint.url, { method: 'POST', headers: { Authorization: 'Bearer ' + (caller === 'not-the-orchestrator' ? 'invalid' : endpoint.token), 'Content-Type': 'application/json', 'X-Hub-Orchestrator-Session': caller }, body: JSON.stringify({ name, arguments: args }) });
      if (r.status === 403) return { ok:false, error:'身份无效' };
      return r.json();
    };
    ok('非负责人会话调用工具被拒', (await tool('orch_status', {}, 'not-the-orchestrator')).ok === false);
    const plan = await tool('orch_propose_plan', { summary: '一位 Codex 调研、一位 Claude 收口', team: [{memberId:'m2',role:'调研与收口'}], segments: [{ name: '失败场景调研', preset: 'research', goal: '列出失败场景', acceptance: '每个场景附代码位置' }] });
    ok('计划提交即生效（编排中）', plan.ok && plan.result.status === 'running');
    const early = await tool('orch_add_member', { role: '调研', kind: 'codex' });
    ok('负责人不能新增成员', early.ok === false && /已有成员/.test(early.error));
    await wait(() => cdp.eval("document.querySelector('.mr-orch-strip').textContent.includes('编排中')"), 'running strip');
    ok('状态条与卡片上都没有确认/恢复/追加额度按钮', await cdp.eval("!document.querySelector('[data-orch-action=\"confirm\"],[data-orch-action=\"grant-rounds\"],[data-orch-card-action]') && !document.querySelector('.mr-orch-strip [data-orch-action=\"resume\"]')"));
    await click('[data-orch-ledger]');
    await wait(() => cdp.eval("!!document.querySelector('.mr-orch-ledger')"), 'ledger panel');
    ok('计划账本显示计划，不再有待确认字样', await cdp.eval("document.querySelector('.mr-orch-ledger').textContent.includes('一位 Codex 调研') && !document.querySelector('.mr-orch-ledger').textContent.includes('确认')"));
    await shot('03-plan-running');
    ok('账本显示星型自然语言策略', await cdp.eval("document.querySelector('.mr-orch-ledger').textContent.includes('星型')"));
    const budget=(await invoke('orchestration:view',{meetingId:meeting.id})).view.budget; ok('没有固定轮数或时间上限',budget.roundCap===null && budget.minutesCap===null);

    // 4. 组队：成员加入后收件人仍只有负责人；@成员 直接点名
    const added = await tool('orch_add_member', { role: '调研', kind: 'codex', tier: 'fast' });
    ok('组队时仍不能新增成员', !added.ok && /已有成员/.test(added.error));
    const room = await wait(async () => (await invoke('get-meetings')).find(m => m.id === meeting.id && m.subSessions.length === 2), 'member joined');
    ok('新成员加入后收件人仍只有负责人', JSON.stringify(room.participants) === '[0]');
    const n = calls().length;
    await typeAndSend('@m2 先看 core/group-answer-files.js');
    await wait(() => calls().length > n, 'direct dispatch');
    const direct = calls().at(-1);
    ok('@成员 时直接发给被点名的成员', JSON.stringify(direct.recipientSids || []) === JSON.stringify([room.subSessions[1]]) || JSON.stringify(direct.targetMemberIds || []) === '["m2"]');
    await wait(async () => { const l = JSON.parse(fs.readFileSync(path.join(DATA, 'task-docs', meeting.id, 'orchestration', 'ledger.json'), 'utf8')); return l.notices.some(x => /直接对 m2 说/.test(x.text)) || calls().some(c => c.kind === 'orch-notice' && /直接对 m2/.test(c.userInput)); }, 'copy to orchestrator');
    ok('点名成员时抄送负责人', true);

    // 5. 需要田哥决定：负责人暂停 → 田哥在输入框用一句话回复 → 暂停解除
    const decide = await tool('orch_report', { kind: 'need_decision', summary: '调研范围比预想大：A 拆两段，B 只做核心。推荐 A' });
    ok('负责人请你决定时暂停', decide.ok && decide.result.status === 'halted');
    await wait(() => cdp.eval("!!document.querySelector('.mr-orch-strip.is-halted')"), 'halted strip');
    ok('暂停时提示在输入框回复，没有恢复按钮', await cdp.eval("document.querySelector('.mr-orch-strip').textContent.includes('在输入框回复负责人') && !document.querySelector('.mr-orch-strip [data-orch-action=\"resume\"]')"));
    await shot('04-halted');
    const before5 = calls().length;
    await typeAndSend('A，按你推荐的拆两段');
    await wait(() => calls().length > before5, 'reply dispatch');
    ok('回复只发给负责人', JSON.stringify(calls().at(-1).recipientSids || []) === JSON.stringify([meeting.orchestration.sessionId]) || JSON.stringify(calls().at(-1).targetMemberIds || []) === '["m1"]');
    await wait(async () => (await invoke('orchestration:view', { meetingId: meeting.id })).view.status === 'running', 'resumed by reply');
    ok('田哥用自然语言回复后暂停解除', await wait(() => cdp.eval("!document.querySelector('.mr-orch-strip.is-halted') && document.querySelector('.mr-orch-strip').textContent.includes('编排中')"), 'strip running'));
    const revised = await tool('orch_propose_plan', { summary: '按田哥选的 A 拆两段', team: [{memberId:'m2',role:'调研与收口'}], segments: [{ name: '失败场景调研', preset: 'research', goal: '列出失败场景', acceptance: '每个场景附代码位置' }, { name: '修复建议', preset: 'custom', steps: 1, goal: '给修复建议', acceptance: '每条建议对应一个场景' }] });
    ok('改计划直接生效，无需再次确认', revised.ok && revised.result.status === 'running' && revised.result.version === 2);

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

    // Display scope is independent of routing and incoming snapshots.
    // 暂停改为在输入框回话后，没有「恢复」那次立即投递；先等排队的 Hub 通知送完，免得真实快照中途覆盖夹具。
    const ledgerJson = () => JSON.parse(fs.readFileSync(path.join(DATA, 'task-docs', meeting.id, 'orchestration', 'ledger.json'), 'utf8'));
    await wait(() => !ledgerJson().notices.length, 'orchestrator notices delivered', 30000);
    await wait(async () => (await invoke('groupchat:get-state', { meetingId: meeting.id }))?.currentMode === 'idle', 'dispatch idle');
    const fixture = { ...await invoke('groupchat:get-state', { meetingId: meeting.id }), currentMode: 'idle', currentTurn: 1, messages: [
      { id: 'scope-user', role: 'user', content: '我的筛选测试问题', turnNum: 1 },
      { id: 'scope-dispatch', role: 'user', content: '自动派发测试', dispatch: { stepIndex: 0, kind: 'orchestration' }, turnNum: 1 },
      { id: 'scope-lead', role: 'assistant', sid: room.subSessions[0], content: '负责人测试回复', turnNum: 1 },
      { id: 'scope-worker', role: 'assistant', sid: room.subSessions[1], content: '## 摘要\n结论：接口已改好，测试通过\n改了什么：core/a.js', turnNum: 1 },
    ] };
    const renderFixture = state => cdp.eval(`window.MeetingRoom.debugRenderGroupChatState(${JSON.stringify(meeting.id)},${JSON.stringify(state)})`);
    // Earlier routing checks left optimistic user prompts, which correctly stay visible.
    const visibleIds = () => cdp.eval("[...document.querySelectorAll('.mr-gc-messages [data-gc-msg-id]')].map(e=>e.dataset.gcMsgId).filter(id=>!id.startsWith('pending-user-'))");
    await renderFixture(fixture);
    ok('群成员旁默认全员信息', await cdp.eval("document.getElementById('mr-btn-group-members').nextElementSibling.id==='mr-btn-message-scope' && document.getElementById('mr-btn-message-scope').textContent==='全员信息'"));
    ok('全员视图显示四条消息', (await visibleIds()).length === 4);
    // 负责人模式：成员卡片默认折叠成一行，折叠行显示结论；负责人卡片照常展开；点一下展开。
    const card = id => `document.querySelector('[data-gc-msg-id="${id}"]')`;
    ok('成员卡片默认折叠、负责人卡片展开', await cdp.eval(`${card('scope-worker')}.dataset.journalMinimized==='true' && ${card('scope-lead')}.dataset.journalMinimized==='false'`));
    ok('折叠行显示成员结论而不是「摘要」小标题', await cdp.eval(`${card('scope-worker')}.querySelector('.mr-orch-peek')?.textContent.startsWith('结论：接口已改好')`));
    ok('负责人卡片标为负责人', await cdp.eval(`${card('scope-lead')}.querySelector('.mr-orch-badge-lead')?.textContent==='负责人'`));
    await cdp.eval(`${card('scope-lead')}.scrollIntoView({block:'start'})`); await sleep(200);
    await shot('06a-member-folded');
    await cdp.eval(`${card('scope-worker')}.querySelector('[data-journal-action="minimize"]').click()`);
    await sleep(300);
    ok('点击后成员卡片展开', await cdp.eval(`${card('scope-worker')}.dataset.journalMinimized==='false' && ${card('scope-worker')}.textContent.includes('改了什么')`));
    await cdp.eval(`${card('scope-lead')}.scrollIntoView({block:'start'})`); await sleep(200);
    await shot('06b-member-expanded');
    await cdp.eval("document.getElementById('mr-input-box').textContent='尚未发送的草稿'");
    const routesBefore = JSON.stringify((await invoke('get-meetings')).find(m=>m.id===meeting.id).participants);
    const callsBefore = calls().length;
    await click('#mr-btn-message-scope');
    ok('只看编排保留本人和负责人', JSON.stringify(await visibleIds()) === JSON.stringify(['scope-user', 'scope-lead']));
    ok('切换保留输入草稿', await cdp.eval("document.getElementById('mr-input-box').textContent==='尚未发送的草稿'"));
    ok('筛选按群保存', await cdp.eval(`localStorage.getItem('hub:group-message-scope:${meeting.id}')==='orchestrator'`));
    const streaming = { ...fixture, currentMode: 'parallel', messages: fixture.messages.slice(0, 3), _partialBy: { [room.subSessions[1]]: { text: '工作成员正在输出', status: 'streaming' } } };
    await renderFixture(streaming);
    ok('过滤期间的新流式卡片不泄漏队员信息', !(await visibleIds()).some(id=>id.includes(room.subSessions[1])));
    await renderFixture(fixture);
    ok('完整消息刷新后仍只显示本人和负责人', JSON.stringify(await visibleIds()) === JSON.stringify(['scope-user', 'scope-lead']));
    await shot('06-orchestrator-only');
    await click('#mr-btn-message-scope');
    ok('切回全员恢复全部历史卡片', (await visibleIds()).length === 4);
    await renderFixture(streaming);
    ok('全员视图仍显示队员流式卡片', (await visibleIds()).includes('pending-' + room.subSessions[1]));
    ok('切换未改变收件人或触发派发', JSON.stringify((await invoke('get-meetings')).find(m=>m.id===meeting.id).participants) === routesBefore && calls().length === callsBefore);
    await renderFixture(fixture);
    await shot('07-all-members');

    // 7. 关掉开关建群 = 现在的群聊（不带编排）
    await cdp.eval("document.getElementById('btn-new-more').click()");
    await click('#launch-intent-group');
    await wait(() => cdp.eval("!!document.querySelector('#new-session-menu #mcm-orch-toggle') && !document.getElementById('mcm-orch-toggle').checked"), 'toggle reset');
    ok('重新打开建群页时开关恢复关闭', true);
    await click('#new-session-menu [data-mcm-scene="general"]');
    await click('#new-session-menu [data-mcm-workspace-mode="default"]');
    await cdp.eval("[...document.querySelectorAll('#new-session-menu button')].find(b=>b.textContent.trim()==='创建群聊').click()");
    const plainRoom = await wait(async () => (await invoke('get-meetings')).find(m => m.id !== meeting.id && !m.orchestration?.enabled), 'plain room created');
    await cdp.eval(`selectMeeting(${JSON.stringify(plainRoom.id)})`);
    await wait(() => cdp.eval("!!document.getElementById('mr-btn-group-members')"), 'plain group header');
    ok('普通群聊不显示编排筛选按钮', await cdp.eval("!document.getElementById('mr-btn-message-scope')"));
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
