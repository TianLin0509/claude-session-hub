'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {launchIsolatedHub,gracefulQuit,_waitMs}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'artifacts');
const report={checks:[],metrics:{},scope:'Real isolated Hub UI and IPC; Agent messages are deterministic fixtures; no model or repository merge was invoked.'};
const check=(ok,name)=>{assert.ok(ok,name);report.checks.push(name);};
async function freePort(){return new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});}
async function main(){
  fs.mkdirSync(OUT,{recursive:true});
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'hub-dev-workbench-e2e-')),port=await freePort();
  let hub,client;
  try{
    const entryPath=path.join(__dirname,'helpers/dev-workbench-fixture-entry.js');
    hub=await launchIsolatedHub({dataDir:path.join(temp,'data'),port,label:'dev-workbench',windowMode:'hidden',entryPath,extraEnv:{HUB_DEV_WORKBENCH_FIXTURE:'1'}});
    report.pid=hub.pid;report.port=port;report.dataDir=hub.dataDir;
    for(let i=0;i<40;i++){try{client=await connectFirstPage(hub,t=>t.type==='page'&&/renderer[\\/]index\.html/.test(t.url));if(client)break;}catch(error){if(i===39)throw error;await _waitMs(250);}}
    await client.send('Runtime.enable');
    const ev=expr=>client.eval(expr);
    const waitFor=async(expr,label,timeout=8000)=>{const until=Date.now()+timeout;while(Date.now()<until){if(await ev(expr))return;await _waitMs(60);}throw new Error('Timed out: '+label);};
    const click=async(selector)=>{
      const point=await ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing click target');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();if(e.disabled||!r.width||!r.height)throw Error('Disabled or hidden click target');return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await client.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});await client.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
    };
    const screenshot=async(name)=>{const image=await client.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(OUT,`20260905-dev-workbench-${name}-codex1.png`),Buffer.from(image.data,'base64'));};
    await waitFor(`typeof window.__devBoardShow==='function'&&!!document.querySelector('#devb-status')`,'module and event handlers ready');
    await ev(`window.__devErrors=[];window.addEventListener('error',e=>window.__devErrors.push(e.message));window.addEventListener('unhandledrejection',e=>window.__devErrors.push(String(e.reason)));window.__invokeCounts={};const ipc=require('electron').ipcRenderer;const original=ipc.invoke.bind(ipc);window.__realInvoke=original;ipc.invoke=(channel,...args)=>{window.__invokeCounts[channel]=(window.__invokeCounts[channel]||0)+1;return original(channel,...args);};true`);
    const ids=await ev(`require('electron').ipcRenderer.invoke('fixture:dev-seed',{count:6})`);
    await click('#btn-ran');
    await waitFor(`document.querySelectorAll('.devb-row').length===5`,'five dev groups');
    check(await ev(`document.querySelector('#devb-status').textContent.includes('5 个开发群聊')`),'Board includes all five development groups and excludes ordinary group');
    check(await ev(`document.querySelector('#ran-panel').textContent.includes('12 项示例检查通过')`),'Author verification is visible');
    await screenshot('overview-dark');
    const row=id=>`.devb-row[data-mid="${id}"]`;
    await click(row(ids[0])+' [data-devb-action="takeover"]');
    check(await ev(`document.querySelector('#devb-confirm').open`),'Manual takeover describes its effect before submission');
    await click('[data-devb-action="confirm"]');await waitFor(`document.querySelector(${JSON.stringify(row(ids[0]))}).textContent.includes('手动处理')`,'takeover');
    const taken=await ev(`require('electron').ipcRenderer.invoke('dev-workbench:get-snapshot')`);
    check(taken.rows.find(r=>r.id===ids[0]).actions.restore,'Real IPC disables auto workflow and exposes restore');
    check(taken.rows.find(r=>r.id===ids[1]).stage.key==='paused','Taking over one task does not change another');
    await click(row(ids[0])+' [data-devb-action="restore"]');await click('[data-devb-action="confirm"]');
    await waitFor(`document.querySelector(${JSON.stringify(row(ids[0]))}).textContent.includes('原自动流程设置已恢复')`,'restore');
    check(await ev(`(window.__invokeCounts['loop:start']||0)===0`),'Restoring settings does not start a new workflow');
    const start=Date.now();
    await ev(`require('electron').ipcRenderer.invoke('fixture:dev-publish',{id:${JSON.stringify(ids[0])},text:'实时进展：正在检查旧配置兼容性',progress:true})`);
    await waitFor(`document.querySelector(${JSON.stringify(row(ids[0]))}).textContent.includes('实时进展：正在检查旧配置兼容性')`,'write-driven update');
    report.metrics.writeToVisibleMs=Date.now()-start;
    check(report.metrics.writeToVisibleMs<1500,'Durable group progress reaches the board within 1.5 seconds');
    check(await ev(`(window.__invokeCounts['groupchat:get-state']||0)===0`),'Dashboard has made zero per-group transcript requests');
    await click(row(ids[0])+' [data-devb-action="open"]');
    await waitFor(`document.querySelector('#meeting-room-panel').style.display!=='none'`,'open original group');
    check(await ev(`document.querySelector('#ran-panel').style.display==='none'`),'Task entry opens the real group and keeps main views mutually exclusive');
    await click('#btn-ran');await waitFor(`document.querySelectorAll('.devb-row').length===5`,'return to board');
    const readsBefore=await ev(`window.__invokeCounts['groupchat:get-state']||0`);
    await ev(`require('electron').ipcRenderer.invoke('fixture:dev-publish',${JSON.stringify({id:ids[1],text:'PROGRESS: <img src=x onerror=boom()>\nVERIFIED: 证据保留\nRISK: 无\nREPORT: Z:\\不存在\\验收.html'})})`);
    await waitFor(`document.querySelector(${JSON.stringify(row(ids[1]))}).textContent.includes('<img src=x onerror=boom()>')`,'escaped text');
    check(await ev(`document.querySelectorAll('#ran-panel img').length===0`),'Agent-supplied HTML is displayed as plain text');
    await click(row(ids[1])+' [data-devb-action="report"]');
    await waitFor(`document.querySelector(${JSON.stringify(row(ids[1]))}).textContent.includes('报告打不开')`,'missing report');
    check(await ev(`document.querySelectorAll('.devb-row').length===5`),'Missing report does not destroy the task board');
    await click('#devb-refresh');await _waitMs(180);
    check(await ev(`(window.__invokeCounts['groupchat:get-state']||0)===${readsBefore}`),'Reload reads compact snapshot rather than fetching each transcript');
    await click('[data-filter="passed"]');check(await ev(`document.querySelectorAll('.devb-row').length===1`),'Status filter shows only the passed task');
    await click('[data-filter="all"]');
    await click('[data-devb-action="create"]');
    check(await ev(`(()=>{const e=document.querySelector('#meeting-create-modal');return e&&getComputedStyle(e).display!=='none'&&e.textContent.includes('开发')})()`),'Create entry opens existing group creation UI');
    await ev(`window.closeMeetingCreateModal();true`);
    // Cold reload during push, repeated navigation and burst deliveries.
    await ev(`require('electron').ipcRenderer.invoke('fixture:dev-seed',{count:1001})`);
    await click('#devb-refresh');await waitFor(`document.querySelector('#devb-status').textContent.includes('1000 个开发群聊')`,'1000 tasks',20000);
    check(await ev(`document.querySelectorAll('.devb-row').length===40`),'1,000 tasks render at most 40 cards per page');
    const pressure=await ev(`(async()=>{const ipc=require('electron').ipcRenderer;const samples=[];for(let i=0;i<30;i++){const t=performance.now();await ipc.invoke('dev-workbench:get-snapshot');samples.push(performance.now()-t);}return {max:Math.max(...samples),avg:samples.reduce((a,b)=>a+b,0)/samples.length}})()`);
    report.metrics.snapshotLatency=pressure;check(pressure.max<1500,'Repeated 1,000-task snapshot requests stay responsive');
    await click('#devb-search');await client.send('Input.insertText',{text:'群聊创建页更紧凑'});
    await waitFor(`document.querySelectorAll('.devb-row').length===1`,'search amid 1000 tasks');
    await click(row(ids[0])+' details summary');
    for(let i=0;i<25;i++)await ev(`require('electron').ipcRenderer.invoke('fixture:dev-publish',{id:${JSON.stringify(ids[0])},text:'压力更新 ${i}',progress:true})`);
    await waitFor(`document.querySelector(${JSON.stringify(row(ids[0]))}).textContent.includes('压力更新 24')`,'latest burst retained');
    check(await ev(`document.querySelector('#devb-search').value==='群聊创建页更紧凑'`),'Pushed updates preserve the search field');
    check(await ev(`document.querySelector(${JSON.stringify(row(ids[0])+' details')}).open`),'Pushed updates preserve the expanded task goal');
    await ev(`document.documentElement.dataset.theme='claude';true`);await screenshot('light');
    await client.send('Emulation.setDeviceMetricsOverride',{width:900,height:900,deviceScaleFactor:1,mobile:false});await screenshot('narrow');
    check(await ev(`document.querySelector('#ran-panel').scrollWidth<=document.querySelector('#ran-panel').clientWidth+1`),'Narrow board has no horizontal overflow');
    await client.send('Emulation.clearDeviceMetricsOverride');
    await ev(`document.documentElement.dataset.theme='dark';true`);
    // Intentionally rejected/never-settled/late replies exercise the real renderer recovery boundary.
    await ev(`(()=>{const ipc=require('electron').ipcRenderer;window.__testInvoke=ipc.invoke;ipc.invoke=(channel,...args)=>channel==='dev-workbench:get-snapshot'?Promise.reject(new Error('注入：摘要服务不可用')):window.__testInvoke(channel,...args)})()`);
    await click('#devb-refresh');await waitFor(`document.querySelector('#devb-banner').textContent.includes('摘要服务不可用')`,'read failure');
    check(await ev(`document.querySelectorAll('.devb-row').length===1`),'Read failure retains already visible tasks');
    await ev(`require('electron').ipcRenderer.invoke=window.__testInvoke;true`);await click('#devb-refresh');await _waitMs(160);
    check(await ev(`document.querySelector('#devb-banner').textContent===''`),'User can recover the board with reload');
    await ev(`(()=>{const ipc=require('electron').ipcRenderer;window.__beforeHang=ipc.invoke;ipc.invoke=(channel,...args)=>channel==='dev-workbench:get-snapshot'?new Promise(resolve=>window.__lateSnapshot=resolve):window.__beforeHang(channel,...args)})()`);
    await click('#devb-refresh');
    await waitFor(`document.querySelector('#devb-banner').textContent.includes('摘要载入超时')`,'bounded snapshot timeout',6500);
    check(await ev(`document.querySelectorAll('.devb-row').length===1&&!document.querySelector('[data-devb-action="open"]').disabled`),'A never-settled read times out while retaining usable group navigation');
    await ev(`require('electron').ipcRenderer.invoke=window.__beforeHang;true`);
    await click('#devb-refresh');await _waitMs(180);
    await ev(`window.__lateSnapshot({ok:true,epoch:'obsolete',sequence:0,rows:[]});true`);await _waitMs(160);
    check(await ev(`document.querySelector('#devb-status').textContent.includes('1000 个开发群聊')&&document.querySelectorAll('.devb-row').length===1`),'Late timed-out snapshot cannot replace recovered state');
    await click('#devb-search');await client.send('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',modifiers:2,windowsVirtualKeyCode:65});await client.send('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',modifiers:2,windowsVirtualKeyCode:65});await client.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});await client.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
    await waitFor(`document.querySelectorAll('.devb-row').length===40`,'clear search');
    await ev(`(async()=>{const ipc=require('electron').ipcRenderer;const snap=await ipc.invoke('dev-workbench:get-snapshot');ipc.emit('dev-workbench:changed',null,{epoch:snap.epoch,sequence:snap.sequence+1,rows:[null,{id:'damaged-fixture',title:'损坏字段样例',stage:{tone:'bad'},card:{progress:{unexpected:true}},actions:null}],removed:[]});})()`);
    await waitFor(`document.querySelector('#devb-status').textContent.includes('1001 个开发群聊')`,'malformed push');
    check(await ev(`document.querySelectorAll('.devb-row').length===40&&document.querySelector('#devb-banner').textContent===''`),'Malformed single-row fields do not collapse the board');
    await click('#devb-refresh');await _waitMs(180);
    report.rendererErrors=await ev(`window.__devErrors`);
    check(report.rendererErrors.length===0,'No uncaught renderer errors or unhandled promise rejections during tested operations');
    await ev(`location.reload();true`);await waitFor(`typeof window.__devBoardShow==='function'`,'renderer reload');await click('#btn-ran');
    await waitFor(`document.querySelector('#devb-status').textContent.includes('1000 个开发群聊')`,'state after renderer reload',20000);
    check(await ev(`document.querySelectorAll('.devb-row').length===40`),'Renderer reload restores the whole board from main-side facts');
    report.metrics.hookListening=/Hook server.*listening/i.test(hub.log().join('\n'));
    check(report.metrics.hookListening,'Isolated Hub startup includes hook service evidence');
    report.passed=report.checks.length;
  }catch(error){
    report.failure=error.stack||String(error);
    if(client){
      try{report.failureContext=await client.eval(`({board:document.querySelector('#ran-panel')?.textContent,display:document.querySelector('#ran-panel')?.style.display,errors:window.__devErrors,counts:window.__invokeCounts})`);}catch(diagnosticError){report.diagnosticError=String(diagnosticError);}
    }
    throw error;
  }finally{
    if(client)await client.close();
    if(hub){report.shutdown=await gracefulQuit(hub);report.exitCode=hub.exitCode();fs.writeFileSync(path.join(OUT,'20260905-dev-workbench-hub-codex1.log'),hub.log().join('\n'),'utf8');}
    fs.writeFileSync(path.join(OUT,'20260905-dev-workbench-e2e-codex1.json'),JSON.stringify(report,null,2),'utf8');
  }
  console.log(JSON.stringify(report,null,2));
}
main().catch(error=>{console.error(error.stack||error);if(error.logTail)console.error(error.logTail);process.exitCode=1;});
