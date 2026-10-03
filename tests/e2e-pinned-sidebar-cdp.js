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
 await click(c,'[data-display-mode="phone"]');
 await c.eval(`window.__hubE2E.clearSessions();window.__hubE2E.addFakeSessions([
 {id:'pinned-old',kind:'codex',title:'置顶的长期项目会话',pinned:true,status:'idle',lastMessageTime:Date.now()-10*86400000,createdAt:Date.now()-10*86400000},
 {id:'pinned-running',kind:'codex',title:'置顶的运行会话',pinned:true,status:'running',lastMessageTime:Date.now()},
 {id:'unpinned-unread',kind:'claude',title:'未置顶的未读会话',status:'idle',unreadCount:1,lastMessageTime:Date.now()},
 {id:'unpinned-running',kind:'codex',title:'未置顶的运行会话',status:'running',lastMessageTime:Date.now()},
 {id:'two-days',kind:'codex',title:'两天前的普通会话',status:'idle',lastMessageTime:Date.now()-2*86400000,createdAt:Date.now()-2*86400000}
 ])`);
 check(await c.eval(`Array.from(document.querySelectorAll('[data-session-days]')).map(e=>e.innerText).join('|')==='置顶|今天|3 天'`),'置顶在今天和 3 天的左边');
 check((await ids()).includes('unpinned-unread')&&(await ids()).includes('pinned-old')&&!(await ids()).includes('two-days'),'今天保留老置顶和未读，普通会话限定 24 小时');
 await click(c,'[data-session-days="pinned"]');await sleep(120);
 check(JSON.stringify((await ids()).sort())===JSON.stringify(['pinned-old','pinned-running']),'置顶筛选仅展示置顶会话');
 check(await c.eval(`document.querySelector('[data-section-key="sec-active"]')?.innerText.includes('活跃') || document.querySelector('#session-list').innerText.includes('活跃')`),'置顶运行会话仍归活跃分组');
 check(await c.eval(`document.querySelector('[data-session-days="pinned"]').getAttribute('aria-pressed')==='true'&&document.querySelector('[data-session-days="1"]').getAttribute('aria-pressed')==='false'`),'三个范围按钮互斥选中');
 const shot=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'pinned-filter.png'),Buffer.from(shot.data,'base64'));
 await click(c,'[data-session-days="3"]');check((await ids()).includes('two-days')&&(await ids()).includes('unpinned-unread'),'3 天恢复完整范围');
 await click(c,'[data-session-days="pinned"]');
 await c.send('Page.reload');await sleep(400);await c.close();c=await connectFirstPage(hub);await waitFor(c,'!!window.__hubE2E');
 check(await c.eval(`document.querySelector('[data-session-days="pinned"]').getAttribute('aria-pressed')==='true'`),'刷新后保留置顶筛选偏好');
 await click(c,'[data-session-days="1"]');check(await c.eval(`localStorage.getItem('hubSidebarRange')==='1'`),'今天仍可恢复');
 report.passed=true;
}catch(error){report.error=error.stack;process.exitCode=1;}
finally{if(c)await c.close();if(hub)await gracefulQuit(hub);fs.writeFileSync(path.join(out,'evidence.json'),JSON.stringify(report,null,2));console.log('REPORT',out,report.passed?'PASS':report.error);}})();
