'use strict';
// Actual Hub renderer and styles, isolated homes/data, representative Markdown.
// No model requests, production state or system clipboard writes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {launchIsolatedHub,gracefulQuit,_waitMs}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const audit=process.argv.includes('--audit');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-code-contrast-'));
const out=path.resolve(__dirname,'../artifacts/20261003-code-block-contrast-codex',audit?'before':'after',String(Date.now()));
fs.mkdirSync(out,{recursive:true});
const result={version:'1.0',audit,passed:false,root,out,cases:[],checks:[],boundary:'实际隔离 Hub 渲染器中的 Markdown 样本；未调用模型、未改生产状态'};
const themes=['codex','claude','hub','slate','dark','frost'];
const graph='手机说话 → 云中继 → 电脑 Hub\n                    │\n                    ├─ 语音识别 → 转成文字\n                    ├─ 判断任务类型\n                    │   ├─ 简单问题 → 快速模型 → 回手机\n                    │   └─ 工作任务 → Claude 助理\n                    │                    └─ 查询资料 → 执行任务\n                    └─ 保存对话记录';
const fence='```';
const samples=[
  {id:'graph',label:'普通文字流程说明',text:'### 当前流程\n'+fence+'\n'+graph+'\n'+fence},
  {id:'plain',label:'带 text 标记的文字说明',text:fence+'text\n先定位资料，再读取必要段落。\n保留出处与适用条件。\n'+fence},
  {id:'javascript',label:'带语法高亮的真实代码',text:fence+'javascript\n// 读取状态\nconst status = { ready: true, count: 42 };\nfunction describe(value) { return "就绪：" + value.ready; }\n'+fence},
];
let hub,c;
const freeport=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const until=async expr=>{for(let i=0;i<150;i++){if(await c.eval(expr))return;await _waitMs(100);}throw Error('Timeout: '+expr);};
const click=async selector=>{const p=await c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing element');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);for(const type of ['mousePressed','mouseReleased'])await c.send('Input.dispatchMouseEvent',{type,...p,button:'left',clickCount:1});};
const shot=async name=>{const r=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(r.data,'base64'));};
(async()=>{
 try{
  hub=await launchIsolatedHub({dataDir:path.join(root,'data'),port:await freeport(),label:'code-block-contrast',extraEnv:{CODEX_HOME:path.join(root,'codex'),CLAUDE_CONFIG_DIR:path.join(root,'claude'),AI_HUB_WORKSPACE_ROOT:path.join(root,'workspace')}});
  result.pid=hub.pid;
  c=await connectFirstPage(hub);
  await until('typeof turnCardRenderer!=="undefined" && typeof themeController!=="undefined"');
  await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await c.eval(`(()=>{
   const host=document.createElement('section');host.id='contrast-samples';
   host.style.cssText='position:fixed;inset:90px 24px 24px 480px;z-index:9999;overflow:auto;padding:24px;background:var(--surface-canvas);color:var(--fg-default);border:1px solid var(--border-subtle)';
   const heading=document.createElement('h2');heading.textContent='代码块可读性 · 隔离验证样本';host.appendChild(heading);
   for(const sample of ${JSON.stringify(samples)})for(const kind of ['claude','codex']){
    const item=document.createElement('div');item.id='sample-'+kind+'-'+sample.id;
    item.innerHTML=turnCardRenderer.renderTurnCard({id:item.id,role:'assistant',kind,text:sample.text,time:Date.now(),phase:'final'});
    host.appendChild(item);turnCardRenderer.postProcessCardCodeBlocks(item);
   }
   const inline=document.createElement('div');inline.className='turn-body';inline.id='contrast-inline';inline.innerHTML='<p>普通正文与 <code>inline_code</code>。</p>';host.appendChild(inline);
   document.body.appendChild(host);
  })()`);
  for(const theme of themes){
   await c.eval(`themeController.setTheme(${JSON.stringify(theme)})`);
   await _waitMs(100);
   const values=await c.eval(`(()=>{
    const rgb=s=>s.match(/[0-9.]+/g).slice(0,3).map(Number);
    const luminance=rgb=>rgb.map(v=>{v/=255;return v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4;}).reduce((a,v,i)=>a+v*[0.2126,0.7152,0.0722][i],0);
    const host=document.getElementById('contrast-samples');
    return [...host.querySelectorAll('pre')].map(pre=>{
     const bg=getComputedStyle(pre).backgroundColor,b=luminance(rgb(bg));
     const nodes=[pre.querySelector('code'),...pre.querySelectorAll('code .token')].filter(e=>e&&e.textContent.trim());
     const colors=nodes.map(e=>{const color=getComputedStyle(e).color,f=luminance(rgb(color));return {color,contrast:Number(((Math.max(b,f)+.05)/(Math.min(b,f)+.05)).toFixed(2))};});
     return {sample:pre.closest('[id^="sample-"]').id,bg,minimumContrast:Math.min(...colors.map(e=>e.contrast)),colors,copyButton:!!pre.parentElement.querySelector('.code-copy'),text:pre.textContent};
    });
   })()`);
   result.cases.push({theme,values});
   if(!audit){
    for(const item of values){
     const contrast=['dark','frost'].includes(theme)?item.colors[0].contrast:item.minimumContrast;
     assert(contrast>=4.5,theme+' '+item.sample+' contrast '+contrast);
     assert(item.copyButton,'Copy affordance retained');
    }
    if(['codex','claude','hub','slate'].includes(theme))assert(values.every(item=>item.bg.match(/\d+/g).slice(0,3).every(v=>Number(v)>200)),'Light code block should match light surfaces');
   }
   if(theme==='codex'||theme==='dark'){await c.eval('document.getElementById("contrast-samples").scrollTop=0');await shot(theme+'-desktop');}
  }
  if(!audit){
   await c.eval('themeController.setTheme("codex");turnCardRenderer.setCodeFoldThreshold(3)');
   await c.eval(`(()=>{const item=document.createElement('div');item.id='contrast-fold';item.innerHTML=turnCardRenderer.renderTurnCard({id:'fold-sample',role:'assistant',kind:'claude',text:${JSON.stringify(fence+'\n'+graph+'\n'+fence)},time:Date.now()});document.getElementById('contrast-samples').appendChild(item);turnCardRenderer.postProcessCardCodeBlocks(item);})()`);
   assert(await c.eval('document.querySelector("#contrast-fold pre").style.display==="none"'),'Long block initially folded');
   await click('#contrast-fold [data-action="code-expand"]');
   assert(await c.eval('document.querySelector("#contrast-fold pre").style.display!=="none"'),'Expand button works');
   await click('#contrast-fold [data-action="code-collapse"]');
   assert(await c.eval('document.querySelector("#contrast-fold pre").style.display==="none"'),'Collapse button works');
   result.checks.push('Long-code expand/collapse through real mouse clicks');
   const foldStyle=await c.eval('(()=>{const s=getComputedStyle(document.querySelector("#contrast-fold .code-toggle"));return {bg:s.backgroundColor,color:s.color};})()');
   assert(foldStyle.bg.match(/\d+/g).slice(0,3).every(v=>Number(v)>200),'Fold control follows light surface');
   result.checks.push('Collapsed-code control follows light palette');
   await c.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
   await click('[data-display-mode="phone"]');
   await c.eval('document.getElementById("contrast-samples").style.inset="80px 8px 16px";document.getElementById("contrast-samples").scrollTop=0');
   assert(await c.eval('(()=>{const e=document.getElementById("contrast-samples");return e.scrollWidth<=e.clientWidth+1;})()'),'Mobile sample panel has no horizontal overflow');
   await shot('codex-mobile');result.checks.push('390px mobile layout');
  }
  result.passed=true;
 }catch(error){result.error=error.stack;process.exitCode=1;if(c)await shot('failure').catch(()=>{});}
 finally{
  if(c)await c.close();
  if(hub){try{result.shutdown=await gracefulQuit(hub);}catch(error){result.shutdownError=error.message;result.passed=false;process.exitCode=1;}fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));}
  fs.writeFileSync(path.join(out,'evidence.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({passed:result.passed,audit,minimumContrast:result.cases.map(r=>({theme:r.theme,min:Math.min(...r.values.map(v=>v.minimumContrast))})),checks:result.checks,error:result.error,shutdownError:result.shutdownError,out}));
 }
})();
