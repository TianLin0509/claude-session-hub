'use strict';
// Real settings window and save IPC, with isolated native provider fixtures.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const ROOT=fs.mkdtempSync(path.join(os.tmpdir(),'hub-workflow-a-gui-'));
const ART=path.resolve('artifacts/workflow-a');fs.mkdirSync(ART,{recursive:true});
const freePort=()=>new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
(async()=>{
 let hub,cdp;const evidence={checks:[],passed:false};
 const wait=async expr=>{const end=Date.now()+25000;while(Date.now()<end){if(await cdp.eval(expr))return;await new Promise(r=>setTimeout(r,120));}throw new Error('wait: '+expr);};
 const ok=(label,value)=>{assert(value,label);evidence.checks.push(label);};
 const click=async sel=>{
  await wait(`!!document.querySelector(${JSON.stringify(sel)})`);
  const point=await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!r.width||!r.height||!e.contains(document.elementFromPoint(x,y)))throw Error('unclickable '+${JSON.stringify(sel)});return {x,y};})()`);
  await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
 };
 const fill=async(sel,value)=>{await click(sel);await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',windowsVirtualKeyCode:65});await cdp.send('Input.insertText',{text:value});};
 const shot=async file=>{const r=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(ART,file),Buffer.from(r.data,'base64'));};
 try {
  const work=path.join(ROOT,'work');fs.mkdirSync(work);fs.writeFileSync(path.join(work,'.aiwork-root'),'');
  const project=path.join(work,'demo');fs.mkdirSync(path.join(project,'.git'),{recursive:true});fs.mkdirSync(path.join(project,'.agents'));
  fs.writeFileSync(path.join(project,'.agents/project.json'),JSON.stringify({name:'工作流验收项目',trunk:'master'}));
  new (require('../core/prepared-project-registry').PreparedProjectRegistry)({dataDir:path.join(ROOT,'data')}).register(project);
  hub=await launchIsolatedHub({dataDir:path.join(ROOT,'data'),port:await freePort(),windowMode:'hidden',label:'workflow-a',extraEnv:{AI_HUB_WORKSPACE_ROOT:work,CODEX_HOME:path.join(ROOT,'codex'),CLAUDE_CONFIG_DIR:path.join(ROOT,'claude'),CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.join(__dirname,'fixtures/codex-app-server.js')}});
  cdp=await connectFirstPage(hub);evidence.pid=hub.pid;
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
  await wait('!!window.openMeetingCreateModal && !!window.openWorkflowConfigModal');
  await cdp.eval("openMeetingCreateModal('group')");await click('[data-mcm-workspace-mode="default"]');
  await click('[data-mcm-scene="dev"]');
  await cdp.eval(`document.querySelectorAll('.mcm-ai-select').forEach(s=>{s.value='codex';s.dispatchEvent(new Event('change',{bubbles:true}));})`);
  await click('#meeting-create-modal .mcm-create');
  await wait(`!!document.querySelector('[data-file-kickoff]') && document.querySelector('#mr-workflow-btn')?.getBoundingClientRect().width>0`);
  await click('#mr-workflow-btn');
  evidence.memberChips=await cdp.eval(`[...document.querySelectorAll('[data-wf="chip"]')].map(e=>({id:e.dataset.member,text:e.textContent,selected:e.getAttribute('aria-pressed')}))`);
  ok('natural first-open shows all three file stages',await cdp.eval(`document.querySelectorAll('#workflow-config-modal .wf-step-row').length===3`));
  ok('A exposes every shared prompt directly',await cdp.eval(`document.querySelectorAll('#workflow-config-modal textarea[data-wf-step-prompt]').length===3 && [...document.querySelectorAll('#workflow-config-modal .wf-step-row')].every(r=>r.querySelector('.wf-member-chips')&&r.querySelector('textarea'))`));
  await shot('a-desktop.png');
  const list=await cdp.eval(`require('electron').ipcRenderer.invoke('get-meetings')`),id=list.find(m=>m.groupChat).id;
  await fill('#wf-prompt-1','验收补充：必须验证用户首次打开路径，保留文件流交接。');
  await click('.wf-save');await wait(`document.querySelector('#workflow-config-modal').style.display==='none'`);
  let saved=await cdp.eval(`require('electron').ipcRenderer.invoke('get-meetings').then(ms=>ms.find(m=>m.id===${JSON.stringify(id)}).serialWorkflow)`);
  ok('save IPC preserves full file protocol and edited prompt',saved.fileFlowVersion===2&&saved.fileStages[1].prompt.includes('首次打开')&&saved.steps.length===2);
  await click('#mr-workflow-btn');ok('reopen retains edited prompt',await cdp.eval(`document.querySelector('#wf-prompt-1').value.includes('首次打开')`));
  await click('[data-wf="protocol"]');ok('full send instructions use current task paths',await cdp.eval(`document.querySelector('#wf-protocol').textContent.includes('已完成-开题报告.md')&&document.querySelector('#wf-protocol').textContent.includes('首次打开')`));
  await click('[data-wf="task-preset"][data-task-preset="research"]');
  ok('research has three rounds',await cdp.eval(`document.querySelectorAll('#workflow-config-modal .wf-step-row').length===3 && document.querySelector('#wf-prompt-0').value.includes('支持证据')`));
  await click('.wf-save');await wait(`document.querySelector('#workflow-config-modal').style.display==='none'`);
  saved=await cdp.eval(`require('electron').ipcRenderer.invoke('get-meetings').then(ms=>ms.find(m=>m.id===${JSON.stringify(id)}).serialWorkflow)`);
  ok('switching to research uses serial engine with six-round cap',!saved.fileFlowVersion&&saved.settingsPreset==='research'&&saved.executionLimit===6&&saved.steps.length===3);
  await click('#mr-workflow-btn');await click('[data-task-preset="custom"]');await click('.wf-save');
  ok('invalid save stays open with actionable message',await cdp.eval(`document.querySelector('#wf-error').textContent.includes('不能为空')&&document.querySelector('#workflow-config-modal').style.display==='flex'`));
  await fill('#wf-prompt-0','给出当前问题的结论。');
  for(let n=1;n<6;n++)await click('[data-wf="add"]');
  ok('six-round configuration cap',await cdp.eval(`document.querySelectorAll('.wf-step-row').length===6&&document.querySelector('[data-wf="add"]').disabled`));
  await click('[data-wf="restore"]');
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:600,height:900,deviceScaleFactor:1,mobile:false});
  ok('narrow dialog stays inside viewport',await cdp.eval(`(()=>{const r=document.querySelector('.wf-dialog').getBoundingClientRect();return r.x>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1;})()`));await shot('a-narrow.png');
  await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await wait(`document.querySelector('#workflow-config-modal').style.display==='none'`);
  evidence.passed=true;
 }catch(error){evidence.error=error.stack;if(cdp){await shot('failure.png');evidence.ui=await cdp.eval('document.body.innerText.slice(-14000)');evidence.meetings=await cdp.eval("require('electron').ipcRenderer.invoke('get-meetings')");}throw error;}
 finally{if(cdp)await cdp.close();if(hub){const q=await gracefulQuit(hub);evidence.quit=q;if(!q?.ok&&q?.ok!==undefined)evidence.passed=false;}fs.writeFileSync(path.join(ART,'gui-evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));}
})().catch(e=>{console.error(e);process.exitCode=1;});
