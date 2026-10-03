'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const {getFreePort,click,waitFor}=require('./helpers/usage-refresh-fixture');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-pinned-filter-'));
const out=path.resolve('artifacts','20261002-pinned-sidebar-codex1-'+Date.now());fs.mkdirSync(out,{recursive:true});
const report={passed:false,checks:[],out,boundary:'隔离 Electron、真实 CDP 点击；会话为受控状态样例'};
let hub,c;const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const check=(value,label)=>{assert(value,label);report.checks.push(label);console.log('PASS '+label);};
const ids=()=>c.eval(`Array.from(document.querySelectorAll('#session-list .session-item')).filter(e=>e.getBoundingClientRect().height>0).map(e=>e.dataset.sessionId)`);
(async()=>{try{
 hub=await launchIsolatedHub({dataDir:path.join(root,'data'),port:await getFreePort(),extraEnv:{CLAUDE_HUB_E2E:'1'}});
 c=await connectFirstPage(hub);await waitFor(c,'!!window.__hubE2E');
 await c.send('Emulation.setDeviceMetricsOverride',{width:1120,height:600,deviceScaleFactor:1,mobile:false});
 await click(c,'[data-display-mode="phone"]');await sleep(300);
 await c.eval(`window.__hubE2E.addFakeSessions([
 {id:'default-pty',kind:'codex',agentRuntime:'pty',title:'PTY 会话默认卡片',status:'idle'},
 {id:'default-other',kind:'claude',agentRuntime:'pty',title:'另一个会话',status:'idle'},
 {id:'default-member',kind:'codex',agentRuntime:'pty',meetingId:'default-group',title:'群聊成员默认卡片',status:'idle'}
 ]);meetings['default-group']={id:'default-group',title:'群聊默认卡片',groupChat:true,status:'idle',subSessions:['default-member'],participants:[0],turns:[],log:[],lastMessageTime:Date.now()};renderSessionList();`);
 await click(c,'.session-item[data-session-id="default-pty"]');await waitFor(c,`activeSessionId==='default-pty'`);
 check(await c.eval(`currentView==='card'&&document.querySelector('#btn-backstage').getAttribute('aria-pressed')==='false'`),'PTY 普通会话默认卡片');
 await click(c,'#btn-backstage');check(await c.eval(`currentView==='pty'`),'后台仅由显式点击进入');
 await click(c,'.session-item[data-session-id="default-other"]');await click(c,'.session-item[data-session-id="default-pty"]');
 check(await c.eval(`currentView==='card'`),'重新进入不继承上次后台偏好');
 await click(c,'.session-item[data-meeting-id="default-group"]');await waitFor(c,`activeMeetingId==='default-group'&&document.querySelector('#meeting-room-panel').getBoundingClientRect().height>0`);
 check(await c.eval(`document.querySelector('#terminal-panel').getBoundingClientRect().height===0`),'进入群聊只显示卡片房间');
 await click(c,'.session-item[data-session-id="default-member"]');await waitFor(c,`activeSessionId==='default-member'`);
 check(await c.eval(`currentView==='card'&&document.querySelector('#btn-backstage').getAttribute('aria-pressed')==='false'`),'群聊成员默认卡片');
 await c.eval(`window.__hubE2E.clearSessions();meetings={};renderSessionList();`);
 await c.eval(`window.__hubE2E.clearSessions();window.__hubE2E.addFakeSessions([
 {id:'pinned-old',kind:'codex',title:'置顶的长期项目会话',pinned:true,status:'idle',lastMessageTime:Date.now()-10*86400000,createdAt:Date.now()-10*86400000},
 {id:'pinned-running',kind:'codex',title:'置顶的运行会话',pinned:true,status:'running',lastMessageTime:Date.now()},
 {id:'unpinned-unread',kind:'claude',title:'未置顶的未读会话',status:'idle',unreadCount:1,lastMessageTime:Date.now()-120000,createdAt:Date.now()-120000},
 {id:'unpinned-running',kind:'codex',title:'未置顶的运行会话',status:'running',lastMessageTime:Date.now()},
 {id:'two-days',kind:'codex',title:'两天前的普通会话',status:'idle',lastMessageTime:Date.now()-2*86400000,createdAt:Date.now()-2*86400000}
 ])`);
 check(await c.eval(`Array.from(document.querySelectorAll('[data-session-days]')).map(e=>e.innerText).join('|')==='置顶|今天|3 天'`),'置顶在今天和 3 天的左边');
 check((await ids()).includes('unpinned-unread')&&!(await ids()).includes('pinned-old')&&!(await ids()).includes('pinned-running')&&!(await ids()).includes('two-days'),'今天保留未读并排除所有置顶，普通会话限定 24 小时');
 await c.eval(`window.__hubE2E.addFakeSessions([
 {id:'compact-long',kind:'codex',title:'让非常长的会话名称在手机上也尽可能显示更多文字',status:'idle',lastMessageTime:Date.now()-9*3600000,createdAt:Date.now()-9*3600000},
 {id:'compact-sleep',kind:'claude',title:'休眠状态灰色图标',status:'dormant',lastMessageTime:Date.now()},
 {id:'compact-wait',kind:'codex',title:'等待输入状态保留',status:'running',attentionState:'needs-input',needsUserInput:true,lastMessageTime:Date.now()},
 {id:'compact-error',kind:'codex',title:'异常状态保留',status:'failed',lastMessageTime:Date.now()}
 ])`);
 const rowSel=id=>'.session-item[data-session-id="'+id+'"]';
 check(await c.eval(`Math.abs(document.querySelector('#session-sidebar').getBoundingClientRect().width-200)<1`),'手机默认会话栏加宽到 200');
 check(await c.eval(`!document.querySelector('#session-sidebar .session-heading')&&(()=>{const a=document.querySelector('#new-session-wrapper').getBoundingClientRect(),b=document.querySelector('#btn-global-search').getBoundingClientRect();return Math.abs(a.y-b.y)<1&&Math.abs(a.width-b.width)<1&&a.height===32&&b.height===32})()`),'删除无信息标题，启动与昨日之我同排等宽');
 check(await c.eval(`!document.querySelector('#session-list .sl-dot')`),'状态点与 AI 图标合并，不再占一列');
 report.rowGeometry=await c.eval(`(()=>{const r=document.querySelector('${rowSel('compact-long')}'),t=r.querySelector('.sl-title'),l=r.querySelector('.sl-kind'),x=r.querySelector('.sl-time');return {height:r.getBoundingClientRect().height,whiteSpace:getComputedStyle(t).whiteSpace,font:getComputedStyle(t).fontSize,width:t.getBoundingClientRect().width,time:x.textContent,gap:x.getBoundingClientRect().left-l.getBoundingClientRect().right,columns:getComputedStyle(r).gridTemplateColumns}})()`);console.log(JSON.stringify(report.rowGeometry));
 check(await c.eval(`(()=>{const r=document.querySelector('${rowSel('compact-long')}'),t=r.querySelector('.sl-title'),logo=r.querySelector('.sl-kind'),time=r.querySelector('.sl-time');return Math.abs(r.getBoundingClientRect().height-27)<1&&getComputedStyle(t).whiteSpace==='nowrap'&&getComputedStyle(t).fontSize==='12px'&&t.getBoundingClientRect().width>130&&time.textContent==='9H'&&Math.abs(time.getBoundingClientRect().left-logo.getBoundingClientRect().right)<=4})()`),'单行 27px、标题 12px、图标时间紧凑且长标题有更多空间');
 check(await c.eval(`document.querySelector('${rowSel('unpinned-unread')} .sl-time').textContent==='2M'&&document.querySelector('${rowSel('unpinned-unread')} .sl-time').title.includes('未读')`),'未读仍醒目，分钟时间缩写与完整悬停说明保留');
 check(await c.eval(`(()=>{const logo=document.querySelector('${rowSel('compact-sleep')} .sl-kind');return logo.dataset.state==='dorm'&&getComputedStyle(logo).filter==='grayscale(1)'&&getComputedStyle(logo).animationName==='none'})()`),'休眠图标灰色且不呼吸');
 check(await c.eval(`getComputedStyle(document.querySelector('${rowSel('unpinned-running')} .sl-kind')).animationName==='sl-logo-breathe'`),'活跃图标继续呼吸');
 check(await c.eval(`document.querySelector('${rowSel('compact-wait')} .sl-kind').dataset.state==='wait'&&document.querySelector('${rowSel('compact-error')} .sl-kind').dataset.state==='error'`),'等待与异常通过图标状态表达');
 const phoneShot=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'phone-singleline.png'),Buffer.from(phoneShot.data,'base64'));
 await click(c,'#btn-new');await waitFor(c,`getComputedStyle(document.querySelector('#new-session-menu')).display!=='none'`);
 check(true,'并排启动按钮仍打开启动中心');await sleep(300);await click(c,'#new-session-close');await sleep(200);
 await click(c,'#btn-global-search');await waitFor(c,`!document.querySelector('#hub-workspace').hidden&&document.querySelector('#hub-workspace [data-hw-close]').getBoundingClientRect().width>0`);
 check(true,'并排昨日之我仍打开搜索');await sleep(300);await click(c,'#hub-workspace [data-hw-close]');await sleep(200);
 await click(c,'[data-session-days="pinned"]');await sleep(120);
 check(JSON.stringify((await ids()).sort())===JSON.stringify(['pinned-old','pinned-running']),'置顶筛选仅展示置顶会话');
 check(await c.eval(`document.querySelector('[data-section-key="sec-active"]')?.innerText.includes('活跃') || document.querySelector('#session-list').innerText.includes('活跃')`),'置顶运行会话仍归活跃分组');
 check(await c.eval(`document.querySelector('[data-session-days="pinned"]').getAttribute('aria-pressed')==='true'&&document.querySelector('[data-session-days="1"]').getAttribute('aria-pressed')==='false'`),'三个范围按钮互斥选中');
 const shot=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'pinned-filter.png'),Buffer.from(shot.data,'base64'));
 await click(c,'[data-session-days="3"]');check((await ids()).includes('two-days')&&(await ids()).includes('unpinned-unread')&&!(await ids()).some(id=>id.startsWith('pinned-')),'3 天恢复完整范围');
 check(await c.eval(`document.querySelector('${rowSel('two-days')} .sl-time').textContent==='2D'`),'天数显示为 2D');
 await click(c,'[data-display-mode="desktop"]');
 check(await c.eval(`(()=>{const r=document.querySelector('${rowSel('compact-long')}');return Math.abs(r.getBoundingClientRect().height-27)<1&&getComputedStyle(r.querySelector('.sl-title')).whiteSpace==='nowrap'})()`),'电脑模式同样保持一行一会话');
 const desktopShot=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'desktop-singleline.png'),Buffer.from(desktopShot.data,'base64'));
 await click(c,'[data-display-mode="phone"]');await sleep(300);
 await click(c,'[data-session-days="pinned"]');
 await c.send('Page.reload');await sleep(400);await c.close();c=await connectFirstPage(hub);await waitFor(c,'!!window.__hubE2E');
 check(await c.eval(`document.querySelector('[data-session-days="pinned"]').getAttribute('aria-pressed')==='true'`),'刷新后保留置顶筛选偏好');
 await click(c,'[data-session-days="1"]');check(await c.eval(`localStorage.getItem('hubSidebarRange')==='1'`),'今天仍可恢复');
 report.passed=true;
}catch(error){report.error=error.stack;process.exitCode=1;if(c){const shot=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'failure.png'),Buffer.from(shot.data,'base64'));report.failureGeometry=await c.eval(`['#new-session-close','#btn-global-search','#search-modal-close'].map(sel=>{const e=document.querySelector(sel),r=e.getBoundingClientRect();return {sel,x:r.x,y:r.y,w:r.width,h:r.height,at:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.id}})`);console.log(JSON.stringify(report.failureGeometry));}}
finally{if(c)await c.close();if(hub)await gracefulQuit(hub);fs.writeFileSync(path.join(out,'evidence.json'),JSON.stringify(report,null,2));console.log('REPORT',out,report.passed?'PASS':report.error);}})();
