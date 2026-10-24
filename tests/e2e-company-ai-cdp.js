'use strict';
// Real renderer + formal PTY submission + a real subscription model behind the
// existing CodeAgent stand-in. This does not claim native company CodeAgent acceptance.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {launchIsolatedHub,gracefulQuit,_waitMs}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const {getFreePort}=require('./helpers/usage-refresh-fixture');
const root=path.resolve(__dirname,'..'),j=JSON.stringify;
(async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'company-ai-live-')),cac=path.join(temp,'.cac'),dataDir=path.join(temp,'data'),workspace=path.join(temp,'workspace');
 for(const dir of [cac,dataDir,workspace])fs.mkdirSync(dir);
 const auth=path.join(cac,'.credentials.json'),out=path.join(root,'output','20261024-company-ai-e2e-codex.json');
 const result={passed:false,scope:'Real isolated company export UI, real Haiku via CodeAgent stand-in; synthetic draft only',checks:[],temp};let hub,c;
 const until=async(fn,label,ms=360000)=>{const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;await _waitMs(500);}throw Error('timeout '+label);};
 try{
  fs.copyFileSync(path.join(process.env.CLAUDE_CONFIG_DIR||path.join(os.homedir(),'.claude'),'.credentials.json'),auth);
  fs.writeFileSync(path.join(cac,'.claude.json'),j({hasCompletedOnboarding:true,lastOnboardingVersion:'2.1.205',bypassPermissionsModeAccepted:true,skipDangerousModePermissionPrompt:true,hasSeenAutoDefaultNudge:true,hasResetAutoModeOptInForDefaultOffer:true,hasSeenAutoModeEntryWarning:true,projects:{}}));
  fs.writeFileSync(path.join(cac,'.cac.json'),j({hasCompletedOnboarding:true,projects:{}}));
  fs.writeFileSync(path.join(cac,'settings.json'),j({model:'haiku',permissions:{defaultMode:'bypassPermissions'},skipDangerousModePermissionPrompt:true}));
  const probe=require('../core/codeagent-pool').personalModelsFile(dataDir);
  require('../core/codeagent-model-probe').writeProbed(probe,{models:['GLM-5.2-WX-Auto'],defaultModel:'GLM-5.2-WX-Auto'});
  process.env.AI_HUB_CODEAGENT_PICKER_LABELS=j({'GLM-5.2-WX-Auto':'Haiku'});
  const entry=process.env.COMPANY_AI_E2E_ENTRY;if(!entry)throw Error('COMPANY_AI_E2E_ENTRY must point to an isolated company export');
  hub=await launchIsolatedHub({dataDir,port:await getFreePort(),entryPath:entry,windowMode:'background',label:'company-ai-routing',extraEnv:{AI_HUB_CODEAGENT_COMMAND:path.join(root,'tests/fixtures/codeagent-standin/codeagent.cmd'),AI_HUB_CODEAGENT_CONFIG_DIR:cac,CLAUDE_HUB_HOME_DIR:path.join(temp,'home'),DEEPSEEK_API_KEY:'',DASHSCOPE_API_KEY:'',CLAUDE_HUB_ASSISTANT_TIMER:'0',CLAUDE_HUB_FORUM_TIMER:'0',CODEAGENT_STANDIN_NO_CHROME:'1',HUB_SESSION_SEARCH_CLAUDE_ROOTS:path.join(temp,'none')}});
  c=await connectFirstPage(hub);await until(()=>c.eval('typeof ipcRenderer!=="undefined"'),'renderer',60000);
  await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  const session=await c.eval(`ipcRenderer.invoke('create-session',{kind:'codeagent',opts:{cwd:${j(workspace)},title:'公司 AI 草稿验证',mcpProfile:'none'}})`);assert(session.id);
  await c.eval(`selectSession(${j(session.id)})`);
  await until(()=>c.eval('!!document.querySelector("#terminal-panel .prompt-polish-button")'),'polish button',60000);
  assert.match(await c.eval('document.querySelector("#terminal-panel .prompt-polish-button").title'),/CodeAgent/);
  const draft='嗯，我们先讨论一下会议伴侣怎么保留原始录像，先不要实施。请保留 `recording.webm` 这个文件名。';
  const input='#terminal-panel .floating-input-box',button='#terminal-panel .prompt-polish-button';
  await c.eval(`(()=>{const e=document.querySelector(${j(input)});e.focus();e.innerText=${j(draft)};e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  async function click(selector){const box=await c.eval(`(()=>{const r=document.querySelector(${j(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);await c.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...box});await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...box});}
  await click(button);
  await until(()=>c.eval('document.querySelector("#terminal-panel .prompt-polish-button").getAttribute("aria-busy")==="false"'),'real CodeAgent result');
  const edited=await c.eval(`document.querySelector(${j(input)}).innerText`);const status=await c.eval('document.querySelector("#terminal-panel .prompt-polish-status").textContent');
  assert.match(edited,/recording\.webm/);assert.match(edited,/讨论/);assert.match(edited,/不.*实施|实施.*不/);assert.doesNotMatch(status,/失败|超时|未准备|无效/);
  const tasks=fs.readdirSync(path.join(dataDir,'company-ai-tasks')).map(id=>JSON.parse(fs.readFileSync(path.join(dataDir,'company-ai-tasks',id,'task.json'),'utf8')));
  assert.equal(tasks.length,1);assert.equal(tasks[0].state,'done');assert.equal(tasks[0].result,edited);
  result.checks.push('Real click -> dedicated CodeAgent session -> native final receipt -> draft replacement; filename and discussion-only intent preserved');
  const shot=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(root,'output','20261024-company-ai-ui-codex.png'),Buffer.from(shot.data,'base64'));
  await click('#terminal-panel .prompt-polish-undo');assert.equal(await c.eval(`document.querySelector(${j(input)}).innerText`),draft);result.checks.push('Real undo restored exact draft');
  const voice=await c.eval("ipcRenderer.invoke('voice:config','')");assert.equal(voice.engine,'local');assert.equal(voice.companyLocalOnly,true);result.checks.push('Company voice config reports local-only');
  result.passed=true;result.model=tasks[0].result? 'CodeAgent stand-in / Haiku':null;result.taskId=tasks[0].id;
 }catch(e){result.error=e.stack;process.exitCode=1;}
 finally{try{await c?.close();}catch{}if(hub)await gracefulQuit(hub);if(fs.existsSync(auth))fs.unlinkSync(auth);fs.writeFileSync(out,j(result));console.log(j(result));}
})().catch(e=>{console.error(e);process.exitCode=1;});
