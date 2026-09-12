'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const root=path.resolve(__dirname,'..'),out=path.join(root,'artifacts');fs.mkdirSync(out,{recursive:true});
const checks=[],check=(ok,n)=>{assert.ok(ok,n);checks.push(n);};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'hub-dev-workbench-e2e-')),dataDir=path.join(temp,'data');
 const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 let hub,c;
 try{
  hub=await launchIsolatedHub({dataDir,port,label:'readonly-workbench',windowMode:'hidden',entryPath:path.join(__dirname,'helpers/dev-workbench-fixture-entry.js'),extraEnv:{HUB_DEV_WORKBENCH_FIXTURE:'1'}});
  c=await connectFirstPage(hub,t=>t.type==='page'&&/renderer[\\/]index.html/.test(t.url));
  const ev=x=>c.eval(x),until=async(expr,label)=>{for(let i=0;i<120;i++){if(await ev(expr))return;await wait(100);}throw Error('Timeout: '+label);};
  const click=async selector=>{const p=await ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);await c.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p});await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...p});};
  await until('document.readyState === "complete" && typeof window.__devBoardShow === "function"','page ready');
  await ev('document.fonts.ready.then(()=>true)');
  await ev(`window.__readonlyErrors=[];window.__readonlyDeltas=[];require('electron').ipcRenderer.on('dev-workbench:changed',(_e,p)=>window.__readonlyDeltas.push({at:Date.now(),sequence:p.sequence,rows:p.rows?.map(r=>({id:r.id,quality:r.quality,scope:r.scope}))}));window.addEventListener('error',e=>window.__readonlyErrors.push(e.message));window.addEventListener('unhandledrejection',e=>window.__readonlyErrors.push(String(e.reason)));true`);
  const tasks=await ev("require('electron').ipcRenderer.invoke('fixture:readonly-seed')");
  await ev("window.__readonlyClicks=[];document.addEventListener('click',e=>window.__readonlyClicks.push({id:e.target.id,entry:e.target.closest('#btn-ran')?.id}),true);true");
  await click('#btn-ran');await until("document.querySelectorAll('.devb-row').length===3 && document.querySelector('#devb-sync').textContent==='数据已核对'",'first open real file projection');
  fs.writeFileSync(path.join(out,'20260911-workbench-first-open.json'),JSON.stringify(await ev('({clicks:window.__readonlyClicks,deltas:window.__readonlyDeltas})'),null,2));
  check(await ev("document.querySelector('#devb-subtitle').textContent.includes('1 项等你决定')"),'Only explicit decision counted');
  check(await ev("!document.querySelector('#ran-panel [data-devb-action=create]') && !document.querySelector('#ran-panel [data-devb-action=stop]')"),'No mutation controls');
  check(await ev("Array.from(document.querySelector('#devb-project').options).filter(o=>o.text.includes('同名项目')).every(o=>o.text.includes(' · '))"),'Same-name projects distinguished by workspace');
  await ev(`(()=>{const e=document.querySelector('#devb-project');e.value=${JSON.stringify(tasks[2].workspace.replace(/\\/g,'/').toLowerCase())};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  check(await ev("document.querySelectorAll('.devb-row').length===1 && document.querySelector('#devb-subtitle').textContent.includes('1 项在跟进')"),'Project filter and headline share scope');
  await click('[data-scope=history]');check(await ev("document.querySelectorAll('.devb-row').length===0"),'Empty selected project history does not reset filter');
  await click('[data-scope=current]');await ev("(()=>{const e=document.querySelector('#devb-project');e.value='';e.dispatchEvent(new Event('change',{bubbles:true}));})()");
  const row=`.devb-row[data-mid="${tasks[0].id}"]`;
  await click(row+' [data-devb-action=details]');await click(row+' [data-devb-action=source]');await until("document.querySelector('#devb-source-text').textContent.includes('hub-task-view')",'read source through real IPC');
  await click('[data-devb-action=close-source]');
  const ordering=await ev("Array.from(document.querySelectorAll('.devb-row'),e=>e.dataset.mid).join(',')");
  const write=d=>{const file=path.join(tasks[0].taskDir,'任务记录.md'),tmp=file+'.tmp';fs.writeFileSync(tmp,'# 任务记录\n```hub-task-view\n'+JSON.stringify(d)+'\n```\n');fs.renameSync(tmp,file);};
  write({...tasks[0].record,revision:2,summary:'文件更新后的最新进展'});
  await until(`document.querySelector(${JSON.stringify(row)}).textContent.includes('文件更新后的最新进展')`,'file-only live update');
  check(await ev("Array.from(document.querySelectorAll('.devb-row'),e=>e.dataset.mid).join(',')")===ordering,'File updates preserve reading order');
  write({...tasks[0].record,revision:1,summary:'旧数据不能覆盖'});await until(`document.querySelector(${JSON.stringify(row)}).textContent.includes('修订号回退')`,'revision conflict');
  check(await ev(`document.querySelector(${JSON.stringify(row)}).textContent.includes('文件更新后的最新进展')`),'Bad update retains prior valid text');
  write({...tasks[0].record,revision:3,summary:'恢复后的最新进展'});await until(`document.querySelector(${JSON.stringify(row)}).textContent.includes('恢复后的最新进展')`,'recovery');
  await click('[data-scope=history]');check(await ev("document.querySelectorAll('.devb-row').length===1 && document.querySelector('.devb-stage').textContent.includes('已报告完成')"),'Reported completion is not merged');
  await click('[data-scope=discuss]');check(await ev("document.querySelectorAll('.devb-row').length===1"),'Discussion stays outside current');await click('[data-scope=current]');
  for(const theme of ['dark','claude','codex','hub','slate']){
    await ev(`themeController.setTheme(${JSON.stringify(theme)});true`);await wait(160);
    const contrast=await ev(`(()=>{const e=document.querySelector('.devb-stage');const l=s=>s.match(/[\\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((a,v,i)=>a+v*[.2126,.7152,.0722][i],0);const a=l(getComputedStyle(e).color),b=l(getComputedStyle(document.querySelector('#ran-panel')).backgroundColor);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05)})()`);
    check(contrast>=4.5,theme+' status text contrast');
    if(['dark','claude'].includes(theme)){const shot=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'20260911-workbench-'+theme+'.png'),Buffer.from(shot.data,'base64'));}
  }
  await ev("document.querySelector('#ran-panel').style.maxWidth='390px';true");await wait(150);
  check(await ev("document.querySelector('#devb-list').scrollWidth<=document.querySelector('#devb-list').clientWidth+1"),'390px workbench container has no horizontal overflow');
  const narrow=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'20260911-workbench-narrow.png'),Buffer.from(narrow.data,'base64'));
  await ev("document.querySelector('#ran-panel').style.maxWidth='';true");
  check((await ev("window.__readonlyErrors")).length===0,'No renderer exceptions');
  check(!(await ev(`require('electron').ipcRenderer.invoke('dev-workbench:action',{meetingId:${JSON.stringify(tasks[0].id)},action:'pin'})`)).ok,'Mutation IPC rejects');
  await c.send('Page.reload');await until('document.readyState === "complete" && typeof window.__devBoardShow === "function"','renderer reload');await ev('document.fonts.ready.then(()=>true)');await click('#btn-ran');
  await until(`document.querySelector(${JSON.stringify(row)})?.textContent.includes('恢复后的最新进展')`,'latest source survives renderer restart');
  check(true,'Renderer reload reconstructs latest source');
  console.log(JSON.stringify({checks,pid:hub.pid,port,dataDir,scope:'Real isolated Hub, real file/IPC/UI; synthetic task documents; no model execution.'}));
  fs.writeFileSync(path.join(out,'20260911-workbench-cdp.json'),JSON.stringify({checks,pid:hub.pid,port,dataDir},null,2));
 }catch(error){
  fs.writeFileSync(path.join(out,'20260911-workbench-failure.log'),String(error)+'\n'+(hub?.log?.()||[]).join('\n'));
  if(c)try{fs.writeFileSync(path.join(out,'20260911-workbench-failure.json'),JSON.stringify(await c.eval("require('electron').ipcRenderer.invoke('dev-workbench:get-snapshot')"),null,2));fs.writeFileSync(path.join(out,'20260911-workbench-failure-dom.json'),JSON.stringify(await c.eval("({text:document.querySelector('#ran-panel').innerText,rows:document.querySelectorAll('.devb-row').length,errors:window.__readonlyErrors,deltas:window.__readonlyDeltas,clicks:window.__readonlyClicks})"),null,2));}catch(e){console.error('Failure snapshot unavailable',e.message);}
  throw error;
 }finally{if(c)await c.close();if(hub)await gracefulQuit(hub);}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
