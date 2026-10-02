'use strict';
// Real isolated Electron + disk quota cache and controlled provider executables.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {launchIsolatedHub,gracefulQuit,_waitMs}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const {seedUsageData,getFreePort,waitFor,click,key}=require('./helpers/usage-refresh-fixture');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'hub-compact-status-')),dataDir=path.join(temp,'data');
const fixture=seedUsageData(dataDir,'regression');
const out=path.resolve(__dirname,'../artifacts/20261002-compact-status-codex1',String(Date.now()));
fs.mkdirSync(out,{recursive:true});
fs.mkdirSync(path.join(dataDir,'bailian'));fs.writeFileSync(path.join(dataDir,'bailian/config.json'),'{}');
const tokenControl=path.join(temp,'token-quota.json');fs.writeFileSync(tokenControl,JSON.stringify({ratio:.9}));
const cli=path.join(fixture.fakeAppData,'npm/node_modules/bailian-cli/dist/bailian.mjs');
fs.mkdirSync(path.dirname(cli),{recursive:true});
fs.writeFileSync(cli,`import fs from 'node:fs';const c=JSON.parse(fs.readFileSync(${JSON.stringify(tokenControl)},'utf8'));console.log(JSON.stringify({code:'200',successResponse:true,data:{success:true,DataV2:{data:{code:'SUCCESS',data:{per1WeekPercentage:c.ratio,per1WeekResetTime:Date.now()+86400000}}}}}));`);
const result={passed:false,checks:[],geometry:[],out,boundary:'真实隔离 Electron 与 UI/IPC，磁盘缓存及 provider 可执行程序夹具；未调用云端模型'};
let hub,c;
const check=(ok,label)=>{assert(ok,label);result.checks.push(label);console.log('PASS '+label);};
const shot=async name=>{const s=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(s.data,'base64'));};
const geometry=()=>c.eval(`(()=>{const f=document.querySelector('#hub-system-footer'),r=f.getBoundingClientRect(),boxes=[...f.querySelectorAll('.strip-resources,.sidebar-quota-provider,.strip-network')].map(e=>{const b=e.getBoundingClientRect();return {class:e.className,x:b.left,right:b.right,top:b.top,bottom:b.bottom,height:b.height};});return {footer:{left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height,scroll:f.scrollWidth,width:f.clientWidth},boxes,bodyWidth:document.documentElement.scrollWidth,viewport:innerWidth};})()`);
const hover=async selector=>{await c.eval(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest',inline:'nearest'})`);const p=await c.eval(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',...p});};
(async()=>{
 try{
  hub=await launchIsolatedHub({dataDir,port:await getFreePort(),label:'compact-status',extraEnv:{APPDATA:fixture.fakeAppData,CLAUDE_HUB_EGRESS_FIXTURE:JSON.stringify({foreign:{ok:true,countryCode:'US',countryZh:'美国',cityZh:'洛杉矶'},domestic:{ok:true,countryCode:'CN',countryZh:'中国',cityZh:'北京'}})}});
  c=await connectFirstPage(hub);await c.send('Page.enable');
  await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:960,deviceScaleFactor:1,mobile:false});
  await waitFor(c,'document.querySelectorAll(".sidebar-quota-provider").length===4 && document.querySelector(".strip-resource b")');
  await waitFor(c,'document.querySelector("[data-provider=tokenPlan] .sidebar-quota-value").textContent==="10.00%"');
  check(await c.eval('document.querySelector("#hub-system-footer #rail-usage") && !document.querySelector("#session-sidebar #rail-usage") && getComputedStyle(document.querySelector("#sidebar-insights")).display==="none"'),'账户用量已移到底栏，无侧栏用量区');
  check(await c.eval('(()=>{const v=[...document.querySelectorAll(".sidebar-quota-value")].map(e=>e.textContent),s=accountUsageController.getSnapshot();return v[0]==="0%"&&v[1]==="86%"&&v[2]===Math.round(100-s.codex.usage7d.pct)+"%"&&v[3]==="¥60.60"&&v[4]==="10.00%"})()'),'真实缓存读取为剩余额度和余额，没有反转含义');
  check(await c.eval('getComputedStyle(document.querySelector("[data-provider=tokenPlan] .sidebar-quota-metric")).color===getComputedStyle(document.querySelector("[data-provider=claude] .sidebar-quota-metric")).color && document.querySelector("[data-provider=tokenPlan] .sidebar-quota-metric").dataset.level==="danger"'),'Token Plan 剩余 10% 与 Claude 耗尽均显示紧张色');
  check(await c.eval('[...document.querySelectorAll(".sidebar-quota-track,.strip-mini-track")].every(e=>getComputedStyle(e).display==="none")'),'底栏仅显示数字，无占用柱子');
  check(await c.eval('document.querySelector("[data-provider=claude] .sidebar-quota-period").textContent==="5h" && document.querySelector("[data-provider=tokenPlan] .sidebar-quota-metric").title.includes("距离额度重置")'),'时间窗口常显，重置时间保留在提示中');
  for(let i=0;i<2;i++){
   if(i===1)await click(c,'#rail-pin');
   const labels=await c.eval(`[...document.querySelectorAll('#scene-rail .btn-shell-nav:not([hidden])')].map(e=>{const a=e.querySelector('.btn-icon').getBoundingClientRect(),l=e.querySelector('.btn-label'),r=l.getBoundingClientRect(),b=e.getBoundingClientRect();return {text:l.textContent,display:getComputedStyle(l).display,visible:r.width>0&&r.height>0,below:r.top>=a.bottom-1,fits:r.left>=b.left-1&&r.right<=b.right+1};})`);
   check(labels.every(l=>l.text.length<=4&&l.visible&&l.display!=='none'&&l.below&&l.fits),'图标下短标签在'+(i?'窄':'宽')+'导航均常显');
  }
  await shot('compact-rail');await click(c,'#rail-pin');
  check(await c.eval('[...document.querySelectorAll(".rail-utility-label")].every(e=>e.getBoundingClientRect().height>0)'),'重启、主题、设置图标均有短标签');
  await click(c,'.sidebar-quota-provider[data-provider="codex"]');
  await waitFor(c,'!!accountUsageController.getSnapshot().refresh.providers.codex.result');
  await waitFor(c,'accountUsageController.getSnapshot().codex?.source==="app-server"');
  check(await c.eval('document.querySelector("[data-provider=codex] .sidebar-quota-value").textContent==="93%"'),'底栏 Codex 按钮仍通过真实 IPC 单独刷新');
  await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:600,y:300});
  await hover('.rail-usage-button');await waitFor(c,'!document.querySelector("#rail-usage-popover").hidden');
  check(await c.eval('(()=>{const r=document.querySelector("#rail-usage-popover").getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;})()'),'详情可展开并位于窗口内');
  await shot('usage-details');await key(c,'Escape','Escape',27);await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:600,y:300});
  await waitFor(c,'document.querySelector("#rail-usage-popover").hidden');
  // Rendering a controlled telemetry sample validates colors while real sampling is independently checked below.
  const actual=await c.eval('systemResourceUsage');check(Number.isFinite(actual?.memoryPct),'真实系统内存采样仍工作');
  await c.eval('systemResourceUsage={...systemResourceUsage,cpuPct:24,memoryPct:90,disk:{...systemResourceUsage.disk,usagePct:96}};hubProxyInfo={...hubProxyInfo,proxy:"http://127.0.0.1:7890",clashDelay:{status:"ok",delayMs:155,nodeName:"测试节点",measuredAt:Date.now()}};renderSidebarStrip()');
  check(await c.eval('document.querySelector("[data-resource-kind=memory]").classList.contains("strip-resource-critical") && document.querySelector(".strip-delay").textContent.includes("155 ms")'),'90% 内存为紧张色，VPN 节点延迟仍完整显示');
  await hover('[data-resource-kind=memory]');await waitFor(c,'!document.querySelector("#resource-process-tooltip").hidden && document.querySelector("#resource-process-tooltip").textContent.includes("内存占用 Top 3")');
  check(await c.eval('document.querySelector("#resource-process-tooltip").textContent.includes("内存占用 Top 3")'),'系统占用详情悬停入口仍工作');await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:600,y:300});
  await shot('footer-wide');
  for(const [width,height,zoom] of [[1440,960,1],[1100,800,1],[900,700,1],[760,600,1],[390,780,1],[1440,960,1.25]]){
   await c.eval(`require('electron').webFrame.setZoomFactor(${zoom})`);await c.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await _waitMs(150);
   const g=await geometry();result.geometry.push({width,height,zoom,...g});
   check(g.bodyWidth<=g.viewport+1&&g.boxes.every(b=>b.height>0&&b.top>=g.footer.top-1&&b.bottom<=g.footer.bottom+1),'底栏所有读数保持单行且页面不溢出 '+width+'/'+zoom);
   if(width===1440&&zoom===1)check(g.footer.scroll<=g.footer.width+1,'1440px 全部读数一屏放下');
   if(width===390){await c.eval('document.querySelector("#hub-system-footer").scrollLeft=9999');await shot('footer-narrow');check(await c.eval('document.querySelector("#hub-system-footer").scrollLeft>0'),'窄屏可横向查看所有状态');}
  }
  await c.eval('require("electron").webFrame.setZoomFactor(1)');await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:960,deviceScaleFactor:1,mobile:false});
  await click(c,'#btn-rail-accounts');await waitFor(c,'document.body.classList.contains("accounts-open")');
  check(await c.eval('getComputedStyle(document.querySelector("#hub-system-footer")).display==="flex"'),'账号 Tab 打开后底栏保持可见');await click(c,'#btn-home');
  await c.eval('themeController.setTheme("dark")');await shot('dark-footer');
  check(await c.eval('document.documentElement.dataset.theme==="dark" && document.querySelector("#hub-system-footer").getBoundingClientRect().height>0'),'深色主题底栏与导航保持可用');
  await c.eval('themeController.setTheme("codex")');await c.send('Page.reload');await _waitMs(500);await c.close();c=await connectFirstPage(hub);
  await waitFor(c,'document.querySelector("#hub-system-footer .sidebar-quota-provider")');check(await c.eval('document.querySelectorAll("#rail-usage").length===1'),'刷新后只有一套用量控件');await shot('final');
  result.passed=true;
 }catch(error){result.error=error.stack;process.exitCode=1;if(c)await shot('failure').catch(()=>{});}
 finally{if(c)await c.close();if(hub){result.exit=await gracefulQuit(hub);fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));}fs.writeFileSync(path.join(out,'evidence.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}
})();
