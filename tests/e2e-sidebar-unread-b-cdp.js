'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const ROOT = path.resolve(__dirname, '..');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-unread-b-'));
const OUT = path.join(ROOT, 'artifacts', 'unread-b');
fs.mkdirSync(OUT, { recursive: true });
function port() { return new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(e => e ? reject(e) : resolve(p)); }); }); }
async function wait(label, fn, timeout = 30000) { const until = Date.now() + timeout; let last; while (Date.now() < until) { last = await fn(); if (last) return last; await _waitMs(150); } throw new Error('Timeout: ' + label + ' last=' + JSON.stringify(last)); }
async function main() {
  delete process.env.ELECTRON_RUN_AS_NODE;
  let hub, c;
  const result = { checks: [], scope: 'Real isolated Electron + real group dispatcher + controlled native App Server provider; no paid model calls.', tempRoot: TEMP };
  const check = (name, value = true) => { assert.ok(value, name); result.checks.push(name); console.log('PASS ' + name); };
  const invoke = (channel, payload) => c.eval(`ipcRenderer.invoke(${JSON.stringify(channel)},${JSON.stringify(payload)})`);
  const click = async selector => {
    const p = await c.eval(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e)return null; e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    assert.ok(p, 'click target missing: ' + selector);
    await c.send('Page.bringToFront');
    await c.send('Input.dispatchMouseEvent', {type:'mouseMoved',...p});
    await c.send('Input.dispatchMouseEvent', {type:'mousePressed',button:'left',clickCount:1,...p});
    await c.send('Input.dispatchMouseEvent', {type:'mouseReleased',button:'left',clickCount:1,...p});
    await _waitMs(600); // outside the existing double-click intent window
  };
  const screenshot = async name => { const s=await c.send('Page.captureScreenshot',{format:'png',fromSurface:true});fs.writeFileSync(path.join(OUT,name+'.png'),Buffer.from(s.data,'base64')); };
  try {
    const workspace=path.join(TEMP,'workspace');fs.mkdirSync(workspace);
    hub=await launchIsolatedHub({dataDir:path.join(TEMP,'data'),port:await port(),label:'unread-b',windowMode:'hidden',extraEnv:{
      AI_HUB_WORKSPACE_ROOT:TEMP, CODEX_HOME:path.join(TEMP,'codex-home'), CLAUDE_CONFIG_DIR:path.join(TEMP,'claude-home'),
      CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.join(ROOT,'tests','fixtures','codex-app-server.js'),
    }});
    c=await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await wait('renderer',()=>c.eval('!!window.MeetingRoom && !!window.LaunchCenter'));
    const model={kind:'codex',model:'gpt-6-astra',effort:'high',mcpProfile:'none'};
    const ready=await invoke('create-session',{kind:'codex',opts:{...model,cwd:workspace,title:'对照会话'}});
    const group=await invoke('create-meeting',{title:'AI HUB 未读验证',scene:'general',workspace,slots:[model,model]});
    const [a,b]=group.subSessions;
    const row=`#session-list [data-meeting-id="${group.id}"]`;
    const unread=()=>c.eval(`meetingUnread.getMeetingUnreadMemberIds(meetings[${JSON.stringify(group.id)}],sessions).size`);
    const section=()=>c.eval(`(() => {let n=document.querySelector(${JSON.stringify(row)});while(n && n.parentElement?.id!=='session-list')n=n.parentElement;while(n && !n.classList.contains('session-sec-header'))n=n.previousElementSibling;return n?.className || '';})()`);
    await wait('members ready',()=>c.eval(`${JSON.stringify(group.subSessions)}.every(id=>!!sessions.get(id)?.nativeRuntime?.threadId)`));
    await click(`#session-list [data-session-id="${ready.id}"]`);
    const first=await invoke('groupchat:turn',{meetingId:group.id,userInput:'fixture:normal',turnTimeoutMs:20000});
    result.firstTurn=first;
    assert.equal(first.status,'completed');
    await wait('both answers unread',async()=>await unread()===2);
    check('Real dispatcher completion produces two unread members');
    await invoke('update-meeting-sync',{meetingId:group.id,fields:{pinned:true,title:'AI HUB · 很长的群聊标题用于检查未读人数和成员按钮布局'}});
    await wait('pinned unread',async()=>/sec-unread/.test(await section()));
    check('Pinned group enters unread once, keeps pin icon',await c.eval(`document.querySelectorAll(${JSON.stringify(row)}).length===1 && !!document.querySelector(${JSON.stringify(row+' .sl-pin')})`));
    check('Count and both member chips visible',await c.eval(`document.querySelector(${JSON.stringify(row+' .sl-unread-badge')}).textContent==='2 位未读' && document.querySelectorAll(${JSON.stringify(row+' .sl-unread-member.has-unread')}).length===2`));
    await click(row+' .sl-title');
    await wait('room selected',()=>c.eval(`activeMeetingId===${JSON.stringify(group.id)}`));
    check('Entering the room keeps both members unread',await unread()===2);
    await screenshot('selected-unread');
    await click(row+` [data-sub-id="${a}"]`);
    await wait('one member read',async()=>await unread()===1);
    check('Member chip opens real member session and only clears that member',await c.eval(`activeSessionId===${JSON.stringify(a)} && meetings[${JSON.stringify(group.id)}].unreadAnswered.has(${JSON.stringify(b)})`));
    await click(row+' .sl-meeting-read');
    await wait('group read',async()=>await unread()===0);
    check('Whole-group read returns the group to pinned',/sec-pinned/.test(await section()));
    check('Whole-group read does not navigate away',await c.eval(`activeSessionId===${JSON.stringify(a)}`));
    // Start two more real group turns while the group is selected. Reading a
    // member between them exercises preserved unread across turn boundaries.
    await click(row+' .sl-title');
    const second=await invoke('groupchat:turn',{meetingId:group.id,userInput:'fixture:normal second',turnTimeoutMs:20000});assert.equal(second.status,'completed');
    await wait('selected group replies unread',async()=>await unread()===2);
    check('Selected room still receives new unread replies');
    await click(row+` [data-sub-id="${a}"]`);
    await click(`#session-list [data-session-id="${ready.id}"]`);
    // The next round targets only a: b must retain the answer from the old round.
    const third=await invoke('groupchat:turn',{meetingId:group.id,userInput:'fixture:normal third',targetMemberIds:[a],turnTimeoutMs:20000});
    assert.equal(third.status,'completed');
    await wait('cross round unread',async()=>await unread()===2);
    check('Old unread survives a new round answering only the other member');
    const pending=await invoke('session:send-prompt',{sessionId:a,text:'fixture:wait'});assert.equal(pending.ok,true);
    await wait('waiting member',()=>c.eval(`sessions.get(${JSON.stringify(a)})?.nativeRuntime?.state==='waiting'`));
    check('Unread badge coexists with actual waiting state',await c.eval(`!!document.querySelector(${JSON.stringify(row+' .sl-group-icon.wait')}) && !!document.querySelector(${JSON.stringify(row+' .sl-unread-badge')})`));
    result.themes=[];
    for(const theme of ['dark','frost','claude','codex','hub','slate']) {
      await c.eval(`themeController.setTheme(${JSON.stringify(theme)})`);
      await _waitMs(150);
      const color=await c.eval(`(() => {const e=document.querySelector(${JSON.stringify(row)}),s=getComputedStyle(e);return {theme:document.documentElement.dataset.theme,background:s.backgroundColor,shadow:s.boxShadow,badge:getComputedStyle(e.querySelector('.sl-unread-badge')).color};})()`);
      assert.notEqual(color.background,'rgba(0, 0, 0, 0)');assert.notEqual(color.shadow,'none');result.themes.push(color);
      if(['frost','codex'].includes(theme))await screenshot(theme+'-unread');
    }
    check('Unread fill and edge persist across all six themes');
    await click('#btn-session-details');
    check('Details mode retains unread badges',await c.eval(`!!document.querySelector(${JSON.stringify(row+' .sl-unread-badge')})`));
    await screenshot('details-unread');
    await click('#session-list .sec-mark-all-read');
    await wait('all read',async()=>await unread()===0);
    check('Mark all read preserves native input request',await c.eval(`sessions.get(${JSON.stringify(a)})?.nativeRuntime?.state==='waiting'`));
    result.passed=true;
  } finally {
    if(c){if(!result.passed){try {result.debug=await c.eval('({activeMeetingId,activeSessionId,groups:Object.values(meetings).map(m=>({id:m.id,subSessions:m.subSessions,unread:[...(m.unreadAnswered||[])]}))})');await screenshot('failure');}catch(error){result.debugError=String(error);}}await c.close();}
    if(hub)await gracefulQuit(hub);
    fs.writeFileSync(path.join(OUT,'e2e-result.json'),JSON.stringify(result,null,2)+'\n');
    console.log(JSON.stringify(result));
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
