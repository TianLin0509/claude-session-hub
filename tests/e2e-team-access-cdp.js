'use strict';
// Real isolated company UI. No external site or model is needed for access-control acceptance.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {launchIsolatedHub,gracefulQuit,_waitMs}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const {getFreePort}=require('./helpers/usage-refresh-fixture');
const root=path.resolve(__dirname,'..'),j=JSON.stringify;
(async()=>{
 const entry=process.env.TEAM_ACCESS_E2E_ENTRY;if(!entry)throw Error('Specify isolated company export');
 const credential=process.env.TEAM_ACCESS_E2E_CREDENTIAL;if(!credential)throw Error('Specify local credential file');
 const password=fs.readFileSync(credential,'utf8').split(/\r?\n/)[1];
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'team-access-')),dataDir=path.join(temp,'data');fs.mkdirSync(dataDir);
 const result={passed:false,temp,checks:[]};let hub,c;const requests=[];
 async function until(fn){const end=Date.now()+45000;while(Date.now()<end){if(await fn())return;await _waitMs(100);}throw Error('UI did not reach expected state');}
 async function start(){hub=await launchIsolatedHub({dataDir,entryPath:entry,port:await getFreePort(),windowMode:'background',label:'team-private-access',extraEnv:{CLAUDE_HUB_ASSISTANT_TIMER:'0',CLAUDE_HUB_FORUM_TIMER:'0',CLAUDE_HUB_HOME_DIR:path.join(temp,'home')}});c=await connectFirstPage(hub);await until(()=>c.eval('typeof ipcRenderer!=="undefined"'));await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});}
 async function click(selector){const box=await c.eval(`(()=>{const r=document.querySelector(${j(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);await c.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...box});await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...box});}
 async function shortcut(){await c.send('Input.dispatchKeyEvent',{type:'keyDown',key:'t',code:'KeyT',modifiers:3,windowsVirtualKeyCode:84});await c.send('Input.dispatchKeyEvent',{type:'keyUp',key:'t',code:'KeyT',modifiers:3,windowsVirtualKeyCode:84});await until(()=>c.eval('document.querySelector("#team-access-dialog")?.open'));}
 try{
  await start();
  assert.equal(await c.eval('document.getElementById("btn-team").getBoundingClientRect().width'),0);
  for(const channel of ['team:state','team:call','team:web-open'])assert.equal((await c.eval(`ipcRenderer.invoke(${j(channel)},{id:'weekly',bounds:{x:0,y:0,width:600,height:400}})`)).ok,false);
  assert.equal(fs.existsSync(path.join(dataDir,'company-web-ai-capability')),false);
  result.checks.push('Fresh company UI hides team; direct IPC rejected; team AI worker not created');
  await shortcut();await c.send('Input.insertText',{text:'wrong-password'});await click('#team-access-dialog button[type=submit]');
  await until(()=>c.eval('document.querySelector("#team-access-dialog [role=status]").textContent.includes("不正确")'));
  assert.equal(await c.eval('document.getElementById("btn-team").getBoundingClientRect().width'),0);
  await click('#team-access-dialog input');await c.send('Input.insertText',{text:password});await click('#team-access-dialog button[type=submit]');
  await until(()=>c.eval('document.querySelector("#team-page")?.hidden===false'));
  assert.equal((await c.eval("ipcRenderer.invoke('team:access')")).unlocked,true);
  assert.equal(await c.eval('document.querySelector("#team-access-dialog input").value'),'');
  const shot=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(root,'output','20261024-team-unlocked-codex.png'),Buffer.from(shot.data,'base64'));
  result.checks.push('Real shortcut, wrong password denial, correct password unlock and team page opened; password cleared');
  // Click lock and accept the explicit unsaved-form warning through CDP.
  await shortcut();await c.send('Page.enable');
  const box=await c.eval('(()=>{const r=document.querySelector("#team-access-dialog [data-lock]").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()');
  await c.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...box});
  const release=c.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...box});
  await _waitMs(250);await c.send('Page.handleJavaScriptDialog',{accept:true});await release;
  await until(()=>c.eval('document.getElementById("btn-team").hidden'));
  assert.equal((await c.eval("ipcRenderer.invoke('team:state')")).ok,false);
  result.checks.push('Real lock button hides tab and rejects data access again');
  // Unlock once more, then restart the same isolated data directory.
  await shortcut();await c.send('Input.insertText',{text:password});await click('#team-access-dialog button[type=submit]');await until(()=>c.eval('document.querySelector("#team-page")?.hidden===false'));
  await c.close();c=null;await gracefulQuit(hub);hub=null;await start();
  assert.equal((await c.eval("ipcRenderer.invoke('team:access')")).unlocked,false);
  assert.equal(await c.eval('document.getElementById("btn-team").getBoundingClientRect().width'),0);
  result.checks.push('Restart with same data requires password again');result.passed=true;
 }catch(e){result.error=e.stack;process.exitCode=1;}
 finally{try{await c?.close();}catch{}if(hub)await gracefulQuit(hub);fs.writeFileSync(path.join(root,'output','20261024-team-access-e2e-codex.json'),j(result));console.log(j(result));}
})().catch(e=>{console.error(e);process.exitCode=1;});
