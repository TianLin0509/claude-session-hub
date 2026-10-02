'use strict';
// Real isolated Electron UI. Read-only dialogs; no cloud calls or production data.
const assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path'), os=require('node:os'), net=require('node:net');
const {launchIsolatedHub,gracefulQuit,_waitMs}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const j=JSON.stringify, audit=process.argv.includes('--audit');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'hub-light-surfaces-'));
const out=path.resolve(__dirname,'../artifacts/20261002-light-surfaces-codex1',String(Date.now()));
fs.mkdirSync(out,{recursive:true});
const result={passed:false,checks:[],surfaces:[],out,boundary:'真实隔离 Electron，只读界面检查；未调用云端 AI'};
let hub,c;
const port=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const until=async expr=>{for(let i=0;i<200;i++){if(await c.eval(expr))return;await _waitMs(100);}throw Error('Timeout: '+expr);};
const click=async selector=>{const p=await c.eval(`(()=>{const e=document.querySelector(${j(selector)});if(!e)throw Error('Missing '+${j(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);for(const type of ['mouseMoved','mousePressed','mouseReleased'])await c.send('Input.dispatchMouseEvent',{type,...p,button:type==='mouseMoved'?'none':'left',clickCount:type==='mouseMoved'?0:1});await _waitMs(230);};
const check=(value,label)=>{assert(value,label);result.checks.push(label);};
const shot=async name=>{const r=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(r.data,'base64'));};
const surface=async(name,selectors)=>{const values=await c.eval(`(${JSON.stringify(selectors)}).map(s=>{const e=document.querySelector(s);if(!e)return {selector:s,missing:true};const c=getComputedStyle(e),b=e.getBoundingClientRect();return {selector:s,bg:c.backgroundColor,color:c.color,scheme:c.colorScheme,width:b.width,height:b.height,before:getComputedStyle(e,'::before').backgroundColor};})`);result.surfaces.push({name,values});await shot(name);return values;};
const escape=async()=>{for(const type of ['keyDown','keyUp'])await c.send('Input.dispatchKeyEvent',{type,key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await _waitMs(150);};
(async()=>{
 try {
  hub=await launchIsolatedHub({dataDir:path.join(temp,'data'),port:await port(),label:'light-surfaces',extraEnv:{CODEX_HOME:path.join(temp,'codex'),CLAUDE_CONFIG_DIR:path.join(temp,'claude'),AI_HUB_WORKSPACE_ROOT:path.join(temp,'workspace')}});
  c=await connectFirstPage(hub);await until('typeof themeController!=="undefined" && typeof openWorkflowConfigModal==="function"');
  await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:960,deviceScaleFactor:1,mobile:false});
  await click('#btn-new-more');await until('getComputedStyle(document.getElementById("new-session-menu")).display!=="none"');
  const hover=await c.eval('(()=>{const r=document.querySelector(".session-create-head").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()');
  await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',...hover});await _waitMs(250);
  const launch=await surface('launch-hover',['#new-session-menu','.session-create-head','.session-workspace-choice.selected','.session-create-submit']);
  if(!audit)check(launch[0].before==='rgba(0, 0, 0, 0)','鼠标悬停不再把启动面板内部压灰');
  await click('#launch-intent-group');const group=await surface('launch-group',['.mcm-dialog','.mcm-slot','.mcm-slot select']);
  if(!audit)check(group[1].bg.match(/\d+/g).slice(0,3).every(n=>Number(n)>200),'群聊成员表单摆脱深色回退背景');
  await click('#launch-intent-resume');await surface('launch-resume',['#launch-center-resume-panel','.launch-center-resume-option']);
  await click('#launch-intent-session');await click('[data-kind="kimi"]');
  check(await c.eval('document.querySelector("[data-kind=kimi]").classList.contains("selected")'),'启动中心手选 AI 保留');
  await click('#new-session-close');
  await click('#btn-theme');await surface('theme-menu',['#theme-menu']);await escape();
  await click('#btn-options');await click('#options-settings');await until('!document.querySelector("#config-modal").classList.contains("hidden")');
  const settings=await surface('settings',['#config-modal > :first-child','#config-modal input','#config-modal select']);
  if(!audit)check(settings.every(e=>!e.missing && e.width>0),'设置窗口及表单真实加载可见');await escape();
  await c.eval('openWorkflowConfigModal({members:[{memberId:"m1",label:"Codex 1",kind:"codex"},{memberId:"m2",label:"Claude 2",kind:"claude"}]})');
  const workflow=await surface('workflow',['#workflow-config-modal .wf-dialog','#workflow-config-modal textarea','#workflow-config-modal .wf-mark']);
  if(!audit)check(workflow[0].scheme==='light','工作流设置使用浅色表单与原生选择器');
  await click('#workflow-config-modal .mcm-close');
  if(!audit){
   await c.eval('themeController.setTheme("claude")');await click('#btn-new-more');await click('#launch-intent-group');
   const warm=await surface('claude-launch',['#new-session-menu','.mcm-slot']);
   check(warm[0].before==='rgba(0, 0, 0, 0)' && warm.every(e=>e.bg.match(/\d+/g).slice(0,3).every(n=>Number(n)>200)),'暖白主题同样保持浅色启动与成员卡');
   await click('#new-session-close');await c.eval('themeController.setTheme("codex")');
   check(await c.eval('document.querySelector("#btn-new-hub img").getAttribute("src")==="../claude-wx.ico" && document.querySelector("#btn-new-hub img").naturalWidth>0'),'左上角加载标准橙色 Hub 标志');
   for(const [width,height] of [[900,600],[760,560],[390,780]]){
    await c.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await click('#btn-new-more');
    check(await c.eval('(()=>{const e=document.querySelector("#new-session-menu"),r=e.getBoundingClientRect();return r.left>=-1 && r.right<=innerWidth+1 && r.top>=-1 && r.bottom<=innerHeight+1 && e.scrollWidth<=e.clientWidth+1})()'),'启动窗口完整可用 '+width+'x'+height);
    await shot('launch-'+width);await click('#new-session-close');
   }
   await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:960,deviceScaleFactor:1,mobile:false});
   await c.eval('themeController.setTheme("dark")');await click('#btn-new-more');
   check(await c.eval('document.documentElement.dataset.theme==="dark" && getComputedStyle(document.querySelector("#new-session-menu"),"::before").backgroundColor==="rgba(0, 0, 0, 0)"'),'深色主题保持独立配色，遮罩不污染面板');await shot('dark-launch');await click('#new-session-close');
  }
  result.passed=true;
 }catch(error){result.error=error.stack;process.exitCode=1;if(c)await shot('failure').catch(()=>{});}
 finally{if(c)await c.close();if(hub){result.shutdown=await gracefulQuit(hub);fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));}fs.writeFileSync(path.join(out,'evidence.json'),j(result,null,2));console.log(j(result,null,2));}
})();
