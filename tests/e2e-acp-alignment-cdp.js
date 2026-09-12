'use strict';
// Actual isolated Hub/IPC/composer; provider executables are local fixtures.
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const {getFreePort,seedUsageData,waitFor}=require('./helpers/usage-refresh-fixture');
// Activate actual DOM controls; hidden Windows test windows can consume the
// first pointer event as a focus event. No handlers or session state are mocked.
const click=(cdp,selector)=>cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e || e.disabled || !e.getBoundingClientRect().height)throw Error('control unavailable');e.click();})()`);
async function main(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-acp-alignment-ui-')),dataDir=path.join(root,'data');
  const out=path.resolve('artifacts/acp-alignment');fs.mkdirSync(out,{recursive:true});
  const usage=seedUsageData(dataDir,'ring');
  fs.writeFileSync(path.join(dataDir,'prepared-projects.json'),JSON.stringify({schemaVersion:1,projects:[],migrations:[]}));
  const config=JSON.parse(fs.readFileSync(path.join(dataDir,'config.json'),'utf8'));
  const entryPath=path.resolve('tests/fixtures/acp-agent.js');
  const bridgePath=path.join(root,'bridge');fs.mkdirSync(bridgePath);fs.writeFileSync(path.join(bridgePath,'package.json'),'{}');
  config.acp={nodePath:process.execPath,apiKey:'dummy-ui-no-model-key',providers:{
    qwen:{entryPath,model:'qwen3.8-max'},'deepseek-acp':{entryPath,bridgePath,model:'deepseek-v4-pro'},glm:{entryPath,backendPath:entryPath,model:'glm-5.2'}}};
  fs.writeFileSync(path.join(dataDir,'config.json'),JSON.stringify(config));
  const results={modelRequests:0,checks:[]};let hub,cdp;
  const check=(name,ok)=>{assert(ok,name);results.checks.push(name);console.log('PASS '+name);};
  try {
    hub=await launchIsolatedHub({dataDir,port:await getFreePort(),windowMode:'hidden',extraEnv:{APPDATA:usage.fakeAppData,HUB_ACP_UI_FIXTURE:'1',CLAUDE_HUB_E2E:'1'}});
    cdp=await connectFirstPage(hub);
    await waitFor(cdp,'typeof sessions!=="undefined" && !!window.WorkspaceController');
    const open=kind=>cdp.eval(`window.WorkspaceController.openNewSessionModal(${JSON.stringify({kind,workspace:{path:root,label:'隔离测试',tier:'external'}})})`);
    const select=async(selector,value)=>cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await open('qwen');
    await waitFor(cdp,'document.querySelector("#new-session-model").options.length===5');
    check('Qwen has 5 code models and a real loaded SVG icon',await cdp.eval(`getComputedStyle(document.querySelector('.new-session-option[data-kind="qwen"] .ai-logo')).backgroundImage.includes('qwen.svg')`));
    check('removed redundant settings entry and duplicate DeepSeek button',await cdp.eval(`!document.getElementById('acp-settings-open') && document.querySelectorAll('.new-session-option[data-kind^="deepseek"]').length===1`));
    await click(cdp,'.new-session-option[data-kind="deepseek"]');
    await waitFor(cdp,`document.querySelector('.new-session-option.selected')?.dataset.kind==='deepseek'`);
    check('DeepSeek defaults to Token Plan with explicit route choice',await cdp.eval(`!document.getElementById('new-session-deepseek-route-field').hidden && document.getElementById('new-session-deepseek-route').value==='deepseek-acp'`));
    await select('#new-session-deepseek-route','deepseek');
    await waitFor(cdp,'document.querySelector("#new-session-model").options.length===2');
    check('API route has its own model catalog',true);
    await select('#new-session-deepseek-route','deepseek-acp');
    await waitFor(cdp,'document.querySelector("#new-session-model").options.length===3');
    check('Token Plan route restores its own model catalog',true);
    for(const kind of ['qwen','deepseek-acp','glm']) {
      await open(kind);
      const before=await cdp.eval('sessions.size');
      await click(cdp,'#new-session-submit');
      await waitFor(cdp,`sessions.size>${before} && [...sessions.values()].some(s=>s.kind===${JSON.stringify(kind)} && s.nativeRuntime?.state==='idle')`);
      const sid=await cdp.eval(`[...sessions.values()].find(s=>s.kind===${JSON.stringify(kind)}).id`);
      await waitFor(cdp,'!!document.querySelector(".floating-input-bar .composer-thinking:not([hidden])")');
      const expectedMode=kind==='deepseek-acp'?'danger-full-access':'yolo';
      check(kind+' starts in confirmed bypass and has no settings panel',await cdp.eval(`sessions.get(${JSON.stringify(sid)}).acpConfigOptions.find(o=>o.category==='mode').currentValue===${JSON.stringify(expectedMode)} && ![...document.querySelectorAll('summary')].some(e=>e.textContent==='原生执行设置')`));
      await click(cdp,'.floating-input-bar .composer-thinking');
      await waitFor(cdp,'!!document.querySelector(".effort-picker-menu")');
      await click(cdp,'.effort-picker-menu [data-effort="low"]');
      await waitFor(cdp,`sessions.get(${JSON.stringify(sid)}).acpConfigOptions.find(o=>o.category==='thought_level').currentValue==='low'`);
      await waitFor(cdp,'!document.querySelector(".effort-picker-menu")');
      check(kind+' composer changes native effort and waits for confirmation',true);
      if(kind==='qwen') {
        await click(cdp,'.floating-input-bar .composer-model');
        await waitFor(cdp,`!!document.querySelector('.model-picker-menu [data-model-id="qwen3.7-plus"]')`);
        await click(cdp,'.model-picker-menu [data-model-id="qwen3.7-plus"]');
        await waitFor(cdp,`sessions.get(${JSON.stringify(sid)}).currentModel.id==='qwen3.7-plus' && !document.querySelector('.model-picker-menu')`);
        check('Qwen composer switches model through native confirmation',true);
      }
      await cdp.eval(`(()=>{const box=document.querySelector('.floating-input-box');box.textContent='permission';box.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await waitFor(cdp,`!document.querySelector('.native-draft-error')?.textContent`);
      await waitFor(cdp,`ipcRenderer.invoke('native-draft:read',{sessionId:${JSON.stringify(sid)}}).then(r=>r.ok && r.record.text==='permission')`);
      check(kind+' input draft is actually persisted before sending',true);
      await click(cdp,'.floating-input-send');
      await waitFor(cdp,`sessions.get(${JSON.stringify(sid)}).nativeRuntime.state==='completed'`);
      check(kind+' fixture tool approval needs no user action',await cdp.eval(`sessions.get(${JSON.stringify(sid)}).nativeRuntime.requests.length===0 && [...document.querySelectorAll('.turn-card')].some(e=>e.innerText.includes('yes'))`));
      const shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,kind+'.png'),Buffer.from(shot.data,'base64'));
    }
    await open('qwen');
    const shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'launch.png'),Buffer.from(shot.data,'base64'));
    await click(cdp,'#launch-intent-group');
    await waitFor(cdp,'!!document.querySelector(".mcm-ai-select")');
    await select('.mcm-ai-select','deepseek');
    await waitFor(cdp,'!!document.querySelector(".mcm-deepseek-route")');
    check('group creation also has one DeepSeek with two routes',await cdp.eval(`document.querySelector('.mcm-ai-select').querySelectorAll('option[value^="deepseek"]').length===1 && document.querySelector('.mcm-deepseek-route').options.length===2`));
    await select('.mcm-deepseek-route','deepseek');
    check('group API route updates model choices',await cdp.eval(`document.querySelector('.mcm-slot').dataset.kind==='deepseek' && document.querySelector('.mcm-model-select').options.length===2`));
    await cdp.eval('window.closeMeetingCreateModal();window.WorkspaceController.closeNewSessionModal()');
    const group=await cdp.eval(`ipcRenderer.invoke('create-meeting',${JSON.stringify({title:'ACP 控件验证',scene:'general',workspace:root,slots:Object.entries(config.acp.providers).map(([kind,p])=>({kind,model:p.model}))})})`);
    assert.equal(group.subSessions.length,3);
    await waitFor(cdp,`${JSON.stringify(group.subSessions)}.every(id=>sessions.get(id)?.nativeRuntime?.state==='idle')`);
    await cdp.eval(`window.MeetingRoom.openMeeting(${JSON.stringify(group.id)},${JSON.stringify(group)})`);
    await waitFor(cdp,`document.querySelectorAll('#mr-input-tuning .composer-thinking:not([hidden])').length===3`);
    for(const sid of group.subSessions) {
      const selector=`#mr-input-tuning [data-sid="${sid}"] .composer-thinking`;
      await click(cdp,selector);
      await waitFor(cdp,'!!document.querySelector(".effort-picker-menu")');
      await click(cdp,'.effort-picker-menu [data-effort="low"]');
      await waitFor(cdp,`sessions.get(${JSON.stringify(sid)}).acpConfigOptions.find(o=>o.category==='thought_level').currentValue==='low' && !document.querySelector('.effort-picker-menu')`);
    }
    check('three group composer controls each confirm their own native effort',true);
    const groupShot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'group.png'),Buffer.from(groupShot.data,'base64'));
    results.passed=true;
  }catch(e){
    results.error=e.stack;
    if(cdp)try {
      results.dom=await cdp.eval(`({selected:document.querySelector('.new-session-option.selected')?.dataset.kind,models:[...document.querySelectorAll('#new-session-model option')].map(o=>o.value),error:document.querySelector('#new-session-error')?.textContent,sessions:[...sessions.values()].map(s=>({id:s.id,kind:s.kind,status:s.nativeRuntime?.state,error:s.nativeRuntime?.error}))})`);
      const shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'failure.png'),Buffer.from(shot.data,'base64'));
      console.error(JSON.stringify(results.dom));
    }catch(diagnostic){results.diagnosticError=diagnostic.message;}
    throw e;
  }
  finally {
    if(hub)fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));
    if(cdp)await cdp.close();if(hub)results.teardown=await gracefulQuit(hub);
    fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(results,null,2));
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
