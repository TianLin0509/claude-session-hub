'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {launchIsolatedHub,gracefulQuit,_waitMs}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const {seedUsageData,getFreePort,waitFor,click}=require('./helpers/usage-refresh-fixture');
const profiles=require('../core/claude-subscription-profiles');
const run='20261024-single-line-accounts-codex-'+Date.now();
const temp=fs.mkdtempSync(path.join(os.tmpdir(),run)),dataDir=path.join(temp,'data'),home=path.join(dataDir,'isolated-home');
const fixture=seedUsageData(dataDir,'ring');
const configFile=path.join(dataDir,'config.json'),config=JSON.parse(fs.readFileSync(configFile));
config.providers.codex.subscription_profiles.push({id:'second',label:'Codex second',home:path.join(dataDir,'codex-second')});
fs.mkdirSync(path.join(dataDir,'codex-second'),{recursive:true});
config.providers.claude={subscription_profiles:profiles.normalizeProfiles([],home)};
fs.writeFileSync(configFile,JSON.stringify(config));
const claudeConfig={claudeSubscriptionProfiles:config.providers.claude.subscription_profiles};
const env={CLAUDE_HUB_HOME_DIR:home,CLAUDE_HUB_DATA_DIR:dataDir};
const cache=JSON.parse(fs.readFileSync(path.join(dataDir,'usage-cache.json'))),observed=Date.now()-60000;
for(const [i,p] of config.providers.claude.subscription_profiles.entries()){
 const scope=profiles.usageScope(claudeConfig,p.id,env);
 cache['claude:'+scope]={claudeScope:scope,usage5h:{pct:i?8:36,resetsAt:Date.now()+2*3600000},usage7d:{pct:i?24:62,resetsAt:Date.now()+3*86400000},ts:observed};
}
fs.writeFileSync(path.join(dataDir,'usage-cache.json'),JSON.stringify(cache));
fs.writeFileSync(path.join(dataDir,'statusline-cache.json'),'{}');
const out=path.resolve(__dirname,'../artifacts',run);fs.mkdirSync(out,{recursive:true});
let hub,c;const result={scope:'Real isolated Hub; two scoped Claude disk fixtures and two controlled Codex app-server profiles; synthetic node delay; no production accounts',checks:[],geometry:[]};
const check=(yes,label)=>{assert.ok(yes,label);result.checks.push(label);};
async function shot(name){const image=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,run+'-'+name+'.png'),Buffer.from(image.data,'base64'));}
(async()=>{try{
 hub=await launchIsolatedHub({dataDir,port:await getFreePort(),label:run,extraEnv:{APPDATA:fixture.fakeAppData,CLAUDE_HUB_E2E:'1',CLAUDE_HUB_EGRESS_FIXTURE:JSON.stringify({foreign:{ok:true,countryZh:'美国',cityZh:'洛杉矶'},domestic:{ok:true,countryZh:'中国',cityZh:'北京'}})}});
 c=await connectFirstPage(hub);await c.send('Page.enable');
 await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
 await waitFor(c,`document.querySelectorAll('#rail-usage .sidebar-quota-provider[data-provider="claude"]').length===2 && document.querySelectorAll('#rail-usage .sidebar-quota-provider[data-provider="codex"]').length===2`);
 await waitFor(c,`accountUsageController.getSnapshot().accounts?.codex.every(row=>row.usage5h && row.usage7d)`);
 check(await c.eval(`JSON.stringify(accountUsageController.getSnapshot().accounts.claude.map(row=>[row.usage5h.pct,row.usage7d.pct]))==='[[36,62],[8,24]]'`),'Claude account caches remain separate');
 await c.eval(`hubProxyInfo={...hubProxyInfo,proxy:'http://127.0.0.1:7890',clashDelay:{status:'ok',delayMs:168,nodeName:'fixture',measuredAt:Date.now()}};renderSidebarStrip()`);
 for(const width of [1440,1100,900]){
  await c.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await _waitMs(200);
  // 后台真实取数会把夹具延时刷成「不可用」（不可用时不再显示），测量前重新注入。
  await c.eval(`hubProxyInfo={...hubProxyInfo,proxy:'http://127.0.0.1:7890',clashDelay:{status:'ok',delayMs:168,nodeName:'fixture',measuredAt:Date.now()}};renderSidebarStrip()`);
  const g=await c.eval(`(()=>{const f=document.querySelector('#hub-system-footer'),r=f.getBoundingClientRect(),q=document.querySelector('#rail-usage'),delay=document.querySelector('.strip-delay').getBoundingClientRect();return {height:r.height,density:f.dataset.density,quotaScroll:q.scrollWidth,quotaWidth:q.clientWidth,delay:{left:delay.left,right:delay.right,width:delay.width},rows:[...q.querySelectorAll('.sidebar-quota-provider')].map(e=>({provider:e.dataset.provider,profile:e.dataset.profileId,top:e.getBoundingClientRect().top,bottom:e.getBoundingClientRect().bottom,logo:getComputedStyle(e.querySelector('.sidebar-quota-icon')).display,name:getComputedStyle(e.querySelector('.sidebar-quota-name')).display,windows:[...e.querySelectorAll('.sidebar-quota-metric')].map(m=>({window:m.dataset.window,top:m.getBoundingClientRect().top,value:m.querySelector('b').textContent,reset:m.querySelector('.sidebar-quota-period').textContent,display:getComputedStyle(m).display}))}))}})()`);
  result.geometry.push({width,...g});
  check(g.height<=35,'single footer row '+width);
  check(g.rows.every(row=>row.logo!=='none'&&row.name==='none'),'logos remain; provider names hidden '+width);
  const accounts=g.rows.filter(row=>['claude','codex'].includes(row.provider));
  check(accounts.length===4 && accounts.every(row=>row.windows.length===2&&row.windows[0].window==='5h'&&row.windows[1].window==='7d'&&Math.abs(row.windows[0].top-row.windows[1].top)<1&&row.windows.every(w=>w.display!=='none')),'all four accounts keep both windows inline '+width);
  check(g.delay.width>0&&g.delay.left>=0&&g.delay.right<=width,'node delay remains visible '+width);
  check(g.density!=='summary','never collapse to tightest quota '+width);
  if(width===1440)await shot('wide');
 }
 // Programmatic scrolling reveals later accounts without moving the fixed network area.
 await c.eval(`document.getElementById('rail-usage').scrollLeft=10000`);
 check(await c.eval(`document.getElementById('rail-usage').scrollLeft>0`),'narrow quota region scrolls horizontally');
 await shot('narrow');
 await click(c,'#footer-status-details');
 check(await c.eval(`!document.getElementById('footer-status-popover').hidden && document.querySelectorAll('#footer-status-popover [data-refresh-provider="claude"]').length===2 && document.getElementById('footer-status-popover').textContent.includes('5h') && document.getElementById('footer-status-popover').textContent.includes('7d')`),'touch details include every account and both reset windows');
 await c.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
 await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
 await _waitMs(250);
 await c.eval(`document.getElementById('rail-usage').scrollLeft=0;window.__profileCalls=[];window.__originalProfileInvoke=ipcRenderer.invoke;ipcRenderer.invoke=function(channel,...args){if(channel==='refresh-account-profile-usage')window.__profileCalls.push(args[0]);return window.__originalProfileInvoke.call(this,channel,...args);}`);
 await click(c,'#rail-usage .sidebar-quota-provider[data-provider="claude"][data-profile-id="second"]');
 await waitFor(c,`window.__profileCalls.some(p=>p?.provider==='claude'&&p.profileId==='second'&&p.force)`);
 check(await c.eval(`(async()=> (await ipcRenderer.invoke('account-profile-usage')).claude[0].selected===true)()`),'refreshing second account never switches active login');
 await c.eval(`ipcRenderer.invoke=window.__originalProfileInvoke;hubProxyInfo={...hubProxyInfo,clashDelay:{status:'unavailable'}};renderSidebarStrip()`);
 check(await c.eval(`!document.querySelector('.strip-delay')`),'unknown delay takes no footer space');
 // 2026-10-24：会话 logo 右下角标账号序号，与底栏 1/2 同序；单账号的 AI 不标。
 await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
 await c.eval(`window.__hubE2E.addFakeSessions([{id:'acct-c1',kind:'claude',title:'Claude 主账号会话'},{id:'acct-c2',kind:'claude',title:'Claude 第二账号会话',claudeProfile:'second'},{id:'acct-x2',kind:'codex',title:'Codex 第二账号会话',codexProfile:'second'},{id:'acct-g',kind:'gemini',title:'Gemini 会话'}])`);
 await waitFor(c,`document.querySelector('.session-item[data-session-id="acct-c2"] .sl-kind')?.dataset.account==='2'`);
 const badges=await c.eval(`Object.fromEntries(['acct-c1','acct-c2','acct-x2','acct-g'].map(id=>{const e=document.querySelector('.session-item[data-session-id="'+id+'"] .sl-kind');return [id,{no:e?.dataset.account||null,after:e?getComputedStyle(e,'::after').content:null,title:e?.title}]}))`);
 result.badges=badges;
 check(badges['acct-c1'].no==='1'&&badges['acct-c2'].no==='2'&&badges['acct-x2'].no==='2'&&badges['acct-g'].no===null,'session logos carry account 1/2; single-account AIs carry none');
 check(badges['acct-c2'].after==='attr(data-account)'||badges['acct-c2'].after==='"2"','corner number is drawn on the logo');
 check(/账号 2/.test(badges['acct-c2'].title),'hover explains which account');
 check(await c.eval(`getComputedStyle(document.querySelector('#rail-usage .sidebar-quota-provider[data-profile-id="second"] .sidebar-quota-account')).position==='absolute'`),'footer number sits on the logo corner too');
 const sb=await c.eval(`(()=>{const r=document.querySelector('.session-item[data-session-id="acct-c2"]').getBoundingClientRect();return {x:0,y:Math.max(0,r.y-60),width:300,height:180,scale:3};})()`);
 {const img=await c.send('Page.captureScreenshot',{format:'png',clip:sb});fs.writeFileSync(path.join(out,run+'-session-badges.png'),Buffer.from(img.data,'base64'));}
 {const img=await c.send('Page.captureScreenshot',{format:'png',clip:{x:0,y:860,width:1100,height:40,scale:2}});fs.writeFileSync(path.join(out,run+'-footer-badges.png'),Buffer.from(img.data,'base64'));}
 await c.eval(`themeController.setTheme('dark')`);await shot('dark');
 await c.eval(`themeController.setTheme('codex')`);
 check(await c.eval(`[...document.querySelectorAll('#touch-tools [data-touch-action]')].map(b=>b.dataset.touchAction).join()==='screenshot,copy,paste' && [...document.querySelectorAll('#touch-tools [data-touch-action]')].every(b=>b.getBoundingClientRect().width>=28)`),'title tools: three inline icons, no select-all');
 result.passed=true;
}catch(error){result.error=error.stack;process.exitCode=1;if(c){try{result.debug=await c.eval(`({ready:document.readyState,accounts:accountUsageController.getSnapshot().accounts,providers:document.querySelectorAll('.sidebar-quota-provider').length})`);await shot('failure');}catch(e){result.debugError=e.message;}}}
finally{if(c)await c.close();if(hub){result.teardown=await gracefulQuit(hub);fs.writeFileSync(path.join(out,run+'-hub.log'),hub.log().join('\n'));}fs.writeFileSync(path.join(out,run+'.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({...result,out},null,2));}})();
