'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const {getFreePort,click,waitFor}=require('./helpers/usage-refresh-fixture');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-group-title-'));
const out=path.resolve('artifacts','20261003-group-title-narrow-rail-codex1-'+Date.now());fs.mkdirSync(out,{recursive:true});
const report={passed:false,out,checks:[],measurements:[],boundary:'隔离 Electron/CDP 真实点击；会话和群聊为受控样例，不发送模型请求'};
let hub,c;const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const check=(value,label)=>{assert(value,label);report.checks.push(label);console.log('PASS '+label);};
const shot=async name=>{const r=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(r.data,'base64'));};
(async()=>{try{
 hub=await launchIsolatedHub({dataDir:path.join(root,'data'),port:await getFreePort(),extraEnv:{CLAUDE_HUB_E2E:'1'}});
 c=await connectFirstPage(hub);await waitFor(c,'!!window.__hubE2E');
 await c.send('Emulation.setDeviceMetricsOverride',{width:1120,height:700,deviceScaleFactor:1,mobile:false});
 await c.eval(`window.__hubE2E.clearSessions();window.__hubE2E.addFakeSessions([
 {id:'group-codex',title:'Codex 成员的长会话标题',kind:'codex',meetingId:'group-normal',status:'idle'},
 {id:'group-claude',title:'Claude 成员',kind:'claude',meetingId:'group-normal',status:'idle'},
 {id:'sleep-member',title:'休眠成员',kind:'codex',meetingId:'group-sleep',status:'dormant'},
 {id:'plain',title:'普通会话标题保持单行',kind:'codex',status:'idle'}
 ]);meetings={
 'group-normal':{id:'group-normal',title:'群聊标题应该显示完整而不是只有一个字',groupChat:true,status:'idle',subSessions:['group-codex','group-claude'],participants:[0,1],turns:[],log:[],lastMessageTime:Date.now()},
 'group-sleep':{id:'group-sleep',title:'休眠群聊也应正常显示名称',groupChat:true,status:'dormant',subSessions:['sleep-member'],participants:[0],turns:[],log:[],lastMessageTime:Date.now()}
 };renderSessionList();`);
 await sleep(1000);
 if(await c.eval(`document.querySelector('#new-session-close').getBoundingClientRect().width>0`))await click(c,'#new-session-close');
 for(const mode of ['desktop','phone']) {
  await click(c,`[data-display-mode="${mode}"]`);await sleep(300);
  if(await c.eval(`document.querySelector('#new-session-close').getBoundingClientRect().width>0`))await click(c,'#new-session-close');
  const rows=await c.eval(`['group-normal','group-sleep'].map(id=>{const row=document.querySelector('.session-item[data-meeting-id="'+id+'"]'),line=row.querySelector('.sl-line1'),t=row.querySelector('.sl-title');return {id,title:t.textContent,width:t.getBoundingClientRect().width,height:line.getBoundingClientRect().height,columns:getComputedStyle(line).gridTemplateColumns,whiteSpace:getComputedStyle(t).whiteSpace}})`);
  report.measurements.push({mode,rows});console.log(JSON.stringify({mode,rows}));await shot(mode+'-compact');
  if(process.argv.includes('--probe'))continue;
  check(rows.every(row=>row.width>120&&row.whiteSpace==='nowrap'&&Math.abs(row.height-27)<1),mode+'：普通和休眠群聊标题有完整标题列且保持单行');
  check(await c.eval(`Math.abs(document.querySelector('#scene-rail').getBoundingClientRect().width-44)<1`),mode+'：导航栏压缩至 44px');
  check(await c.eval(`(()=>{const a=document.querySelector('#btn-theme').getBoundingClientRect(),b=document.querySelector('#btn-options').getBoundingClientRect();return Math.abs(a.x-b.x)<1&&b.y>=a.bottom&&a.width>35&&b.width>35})()`),mode+'：主题和设置上下分行且可点击');
  check(await c.eval(`(()=>{const r=document.querySelector('#scene-rail').getBoundingClientRect();return Array.from(document.querySelectorAll('#scene-rail .btn-shell-nav .btn-label')).every(e=>{const b=e.getBoundingClientRect();return b.left>=r.left&&b.right<=r.right})})()`),mode+'：所有导航文字都在窄栏内');
  check(await c.eval(`document.querySelector('#btn-ran .btn-label').textContent==='开发'`),'开发入口使用两字名称');
  await click(c,'#btn-session-details');
  check(await c.eval(`['group-normal','group-sleep'].every(id=>{const line=document.querySelector('.session-item[data-meeting-id="'+id+'"] .sl-line1'),t=line.querySelector('.sl-title');return t.getBoundingClientRect().width>105&&Math.abs(line.getBoundingClientRect().height-27)<1&&!!line.querySelector('.expand-arrow')})`),mode+'：详细模式也正确分配标题列并保留折叠箭头');
  await click(c,'.session-item[data-meeting-id="group-normal"] .expand-arrow');
  check(await c.eval(`!document.querySelector('.session-item[data-session-id="group-codex"]')||document.querySelector('.session-item[data-session-id="group-codex"]').getBoundingClientRect().height===0`),mode+'：群聊成员可收起');
  await click(c,'.session-item[data-meeting-id="group-normal"] .expand-arrow');
  check(await c.eval(`document.querySelector('.session-item[data-session-id="group-codex"]').getBoundingClientRect().height>0`),mode+'：群聊成员可展开');
  await shot(mode+'-details');await click(c,'#btn-session-details');
 }
 if(process.argv.includes('--probe')) {report.passed=true;return;}
 await click(c,'#btn-theme');await waitFor(c,`getComputedStyle(document.querySelector('#theme-menu')).display!=='none'`);
 check(await c.eval(`document.querySelector('#theme-menu').getBoundingClientRect().left>=44`),'主题菜单在窄栏旁完整展开');
 await click(c,'[data-theme-id="dark"]');
 await sleep(200);
 check(await c.eval(`document.querySelector('.session-item[data-meeting-id="group-normal"] .sl-title').getBoundingClientRect().width>120`),'深色主题的群聊标题也正常');
 await click(c,'[data-theme-id="codex"]');await sleep(200);
 await click(c,'#btn-options');await waitFor(c,`getComputedStyle(document.querySelector('#options-menu')).display!=='none'`);
 check(await c.eval(`document.querySelector('#options-menu').getBoundingClientRect().left>=44`),'设置菜单在窄栏旁完整展开');await click(c,'#btn-options');
 await shot('final-phone');
 await c.send('Page.reload');await sleep(400);await c.close();c=await connectFirstPage(hub);await waitFor(c,'!!window.__hubE2E');
 check(await c.eval(`Math.abs(document.querySelector('#scene-rail').getBoundingClientRect().width-44)<1&&document.documentElement.dataset.displayMode==='phone'`),'重启页面后仍保留窄导航和手机模式');
 report.passed=true;
}catch(error){report.error=error.stack;process.exitCode=1;if(c)await shot('failure').catch(()=>{});}
finally{if(c)await c.close();if(hub)await gracefulQuit(hub);fs.writeFileSync(path.join(out,'evidence.json'),JSON.stringify(report,null,2));console.log('REPORT',out,report.passed?'PASS':report.error);}})();
