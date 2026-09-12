'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),net=require('net'),assert=require('assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function freePort(){return new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port));});});}
async function main(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-native-gui-'));
  const out=path.resolve('artifacts/codex-native-runtime/gui-'+Date.now());fs.mkdirSync(out,{recursive:true});
  const home=path.join(root,'codex'),cwd=path.join(root,'workspace');fs.mkdirSync(home);fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(home,'config.toml'),'model = "gpt-6-astra"\nmodel_reasoning_effort = "xhigh"\n');
  const result={root,out,checks:[],passed:false};let hub,cdp;
  const until=async(expr,label)=>{const deadline=Date.now()+30000;while(Date.now()<deadline){if(await cdp.eval(expr))return;await sleep(100);}throw Error('timeout: '+label);};
  const snap=async(name)=>{const shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(shot.data,'base64'));};
  try{
    hub=await launchIsolatedHub({dataDir:path.join(root,'data'),port:await freePort(),label:'codex-native',
      extraEnv:{CODEX_HOME:home,CLAUDE_CONFIG_DIR:path.join(root,'claude'),
        CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.join(__dirname,'fixtures','codex-app-server.js')}});
    result.pid=hub.pid;result.port=hub.port;
    cdp=await connectFirstPage(hub);
    await until("typeof sessions !== 'undefined' && typeof ipcRenderer !== 'undefined'",'renderer');
    const s=await cdp.eval('ipcRenderer.invoke("create-session",'+JSON.stringify({kind:'codex',opts:{cwd,model:'gpt-6-astra',effort:'xhigh',mcpProfile:'none',codexSpeedTier:'standard'}})+')');
    result.sessionId=s.id;const sid=JSON.stringify(s.id);
    await until('sessions.get('+sid+')?.nativeRuntime?.state === "idle"','native idle');
    await until('document.querySelector('+JSON.stringify('.session-item[data-session-id="'+s.id+'"]')+')','sidebar mounted');
    await cdp.eval('document.querySelector(\'.session-item[data-session-id="'+s.id+'"]\').click()');
    await until('!!document.querySelector(".floating-input-box")','composer');
    async function send(text){
      await cdp.send('Page.bringToFront');
      await cdp.eval('(()=>{const input=document.querySelector(".floating-input-box");input.textContent='+JSON.stringify(text)+';input.dispatchEvent(new Event("input",{bubbles:true}));input.focus();})()');
      await until('document.querySelector(".floating-input-send") && !document.querySelector(".floating-input-send").disabled','send ready');
      await cdp.eval('document.querySelector(".floating-input-send").click()');
    }
    await send('fixture:wait');
    await until('sessions.get('+sid+')?.nativeRuntime?.state === "waiting"','native waiting');
    await until('document.querySelector(".codex-native-controls:not([hidden]) textarea")','request form');
    result.checks.push('real Hub send -> native request -> waiting form');
    await snap('waiting');
    await cdp.eval('document.querySelector(".codex-native-request textarea").value="A";document.querySelector(".codex-native-request button[type=submit]").click()');
    await until('sessions.get('+sid+')?.nativeRuntime?.state === "completed"','resolved completion');
    await until('document.querySelector(".codex-native-controls").hidden','request gone');
    result.checks.push('user response -> native resolution -> completed');
    await send('fixture:hold');
    await until('sessions.get('+sid+')?.nativeRuntime?.state === "running"','running');
    await snap('running');
    await cdp.eval('document.querySelector(".floating-input-stop").click()');
    await until('sessions.get('+sid+')?.nativeRuntime?.state === "interrupted"','stop outcome');
    result.checks.push('stop button -> native interrupted');
    await snap('interrupted');
    await cdp.send('Page.reload');
    await until('typeof sessions !== "undefined" && sessions.get('+sid+')?.nativeRuntime?.state === "interrupted"','renderer reload snapshot');
    result.checks.push('renderer reload retains Main outcome');

    await cdp.eval('document.querySelector(\'.session-item[data-session-id="'+s.id+'"]\').click()');
    await until('!!document.querySelector(".floating-input-box")','composer after reload');
    await send('fixture:multi');
    await until('document.querySelectorAll(".codex-native-request").length === 2','two questions');
    await cdp.eval('document.querySelectorAll(".codex-native-request textarea")[1].value="保留这份草稿";document.querySelectorAll(".codex-native-request textarea")[0].value="A";document.querySelectorAll(".codex-native-request button[type=submit]")[0].click()');
    await until('document.querySelectorAll(".codex-native-request").length === 1','one question remains');
    assert.equal(await cdp.eval('document.querySelector(".codex-native-request textarea").value'),'保留这份草稿');
    assert.equal(await cdp.eval('sessions.get('+sid+').nativeRuntime.state'),'waiting');
    await snap('concurrent-draft');
    await cdp.eval('document.querySelector(".codex-native-request button[type=submit]").click()');
    await until('sessions.get('+sid+').nativeRuntime.state === "completed"','multi complete');
    result.checks.push('concurrent request resolution preserves the other draft and waiting');
    await send('fixture:file-approval');
    await until('[...document.querySelectorAll(".codex-native-request pre")].some(e=>e.textContent.includes("sample.txt"))','actual file diff');
    await snap('file-approval');
    await cdp.eval('[...document.querySelectorAll(".codex-native-request button")].find(b=>b.textContent==="拒绝").click()');
    await until('sessions.get('+sid+').nativeRuntime.state === "completed"','approval complete');
    await send('fixture:empty');
    await until('sessions.get('+sid+').nativeRuntime.state === "completed" && sessions.get('+sid+').nativeRuntime.submission?.status === "accepted"','empty done');
    await cdp.eval('if(currentView!=="card") document.querySelector("#btn-backstage").click()');
    await until('currentView==="card"','card view');
    await until('document.querySelector(".turn-native-outcome")?.getBoundingClientRect().height > 0','visible empty outcome card');
    assert.equal(await cdp.eval('document.querySelectorAll(".fi-stuck").length'),0);
    await snap('empty-cards');
    result.checks.push('native history cards retain empty completion and show no false unconfirmed banner');
    const beforeResend=await cdp.eval('sessions.get('+sid+').nativeRuntime.turnId');
    await until('document.querySelector(".turn-card.user [data-action=resend]")','card resend button');
    await cdp.eval('[...document.querySelectorAll(".turn-card.user [data-action=resend]")].at(-1).click()');
    await until('sessions.get('+sid+').nativeRuntime.turnId!=='+JSON.stringify(beforeResend)+' && sessions.get('+sid+').nativeRuntime.state==="completed"','card resend through native driver');
    const beforeRegen=await cdp.eval('sessions.get('+sid+').nativeRuntime.turnId');
    await until('document.querySelector(".turn-card [data-action=regen]")','card regenerate button');
    await cdp.eval('[...document.querySelectorAll(".turn-card [data-action=regen]")].at(-1).click()');
    await until('[...document.querySelectorAll("button")].some(b=>b.textContent==="按此正文重发")','regenerate confirmation');
    await cdp.eval('[...document.querySelectorAll("button")].find(b=>b.textContent==="按此正文重发").click()');
    await until('sessions.get('+sid+').nativeRuntime.turnId!=='+JSON.stringify(beforeRegen)+' && sessions.get('+sid+').nativeRuntime.state==="completed"','card regenerate through native driver');
    result.checks.push('real card resend and regenerate each create one newly acknowledged native turn');
    const group=await cdp.eval('ipcRenderer.invoke("create-meeting",'+JSON.stringify({title:'Codex 原生群聊验收',scene:'general',workspace:cwd,slots:[{kind:'codex',model:'gpt-6-astra',effort:'xhigh',mcpProfile:'none',codexSpeedTier:'standard'}]})+')');
    result.meetingId=group.id;
    await until('sessions.get('+JSON.stringify(group.subSessions[0])+')?.nativeRuntime?.state === "idle"','group native ready');
    await cdp.eval('window.MeetingRoom.openMeeting('+JSON.stringify(group.id)+','+JSON.stringify(group)+')');
    await until('document.getElementById("mr-input-box")','group composer');
    await cdp.eval('(()=>{const box=document.getElementById("mr-input-box");box.textContent="原生群聊即时完成验收";box.dispatchEvent(new Event("input",{bubbles:true}));document.getElementById("mr-send-btn").click();})()');
    await until('(async()=>{const state=await ipcRenderer.invoke("groupchat:get-state",{meetingId:'+JSON.stringify(group.id)+'});return state?.messages?.some(m=>m.role==="assistant" && m.content?.includes("原生回答"));})()','native group result despite completion before listener');
    result.group=await cdp.eval('ipcRenderer.invoke("groupchat:get-state",{meetingId:'+JSON.stringify(group.id)+'})');
    await snap('group-completed');
    result.checks.push('real group composer and dispatcher deliver native completion');

    const dev=await cdp.eval('ipcRenderer.invoke("create-meeting",'+JSON.stringify({title:'原生文件工作流验收',mode:'dev',scene:'dev',workspace:cwd,slots:[{kind:'codex',model:'gpt-6-astra',effort:'xhigh',mcpProfile:'none',codexSpeedTier:'standard'},{kind:'codex',model:'gpt-6-astra',effort:'xhigh',mcpProfile:'none',codexSpeedTier:'standard'}]})+')');
    const devId=JSON.stringify(dev.id);result.devMeetingId=dev.id;
    await until('sessions.get('+JSON.stringify(dev.subSessions[0])+')?.nativeRuntime?.state === "idle" && sessions.get('+JSON.stringify(dev.subSessions[1])+')?.nativeRuntime?.state === "idle"','two native dev members');
    const workflow=await cdp.eval('window.WorkflowTemplates.createTemplateConfig("dev-task",'+JSON.stringify([{memberId:'m1',kind:'codex'},{memberId:'m2',kind:'codex'}])+')');
    await cdp.eval('ipcRenderer.invoke("update-meeting-sync",'+JSON.stringify({meetingId:dev.id,fields:{serialWorkflow:workflow}})+')');
    await cdp.eval('selectMeeting('+devId+')');
    await until('document.querySelector("[data-file-kickoff]")','file kickoff button');
    await cdp.eval('document.getElementById("mr-input-box").textContent="原生文件流程控制测试";document.querySelector("[data-file-kickoff]").click()');
    await until('document.getElementById("mr-input-box").innerText.includes("开题提示词结束")','kickoff prefill');
    await cdp.eval('document.getElementById("mr-send-btn").click()');
    const devState='ipcRenderer.invoke("groupchat:get-state",{meetingId:'+devId+'})';
    await until('(async()=>{const x=await '+devState+';return Object.values(x.attempts || {}).some(a=>a.status==="completed" && a.signalSource==="codex-app-server");})()','file kickoff native completed');
    const beforeBuild=await cdp.eval(devState);
    const docs=path.join(root,'data','task-docs',dev.id);fs.mkdirSync(docs,{recursive:true});
    fs.writeFileSync(path.join(docs,'开题报告.md'),'隔离 fixture 交付，由文件名推进。');
    await sleep(1200);
    assert.equal(Object.keys((await cdp.eval(devState)).attempts).length,Object.keys(beforeBuild.attempts).length,'native completion without file rename must not advance stage');
    fs.renameSync(path.join(docs,'开题报告.md'),path.join(docs,'已完成-开题报告.md'));
    await until('(async()=>{const x=await '+devState+';return x.messages.some(m=>m.role==="user" && m.content.includes("执行施工")) && Object.values(x.attempts).filter(a=>a.status==="completed").length>=2;})()','file rename dispatches author through native driver');
    fs.writeFileSync(path.join(docs,'实现手册-轮次1.md'),'隔离实现 fixture');fs.renameSync(path.join(docs,'实现手册-轮次1.md'),path.join(docs,'已完成-实现手册-轮次1.md'));
    await until('(async()=>{const x=await '+devState+';return Object.values(x.attempts).some(a=>a.sid==='+JSON.stringify(dev.subSessions[1])+' && a.status==="completed" && a.signalSource==="codex-app-server");})()','file rename dispatches merger through native driver');
    result.dev=await cdp.eval(devState);await snap('file-workflow');
    result.checks.push('real file workflow gates on atomic filename handoff and dispatches both native seats');
    result.passed=true;
  }finally{
    if(cdp) {
      try {
        result.ui=await cdp.eval('({text:document.body.innerText.slice(-4000),sessions:typeof sessions!=="undefined"?[...sessions.values()]:[]})');
        await snap('final');
      } catch(error){result.captureError=error.message;}
    }
    if(hub)fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));
    if(cdp)await cdp.close();
    if(hub)result.exit=await gracefulQuit(hub);
    fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));
    console.log(JSON.stringify({out,checks:result.checks,passed:result.passed,exit:result.exit},null,2));
  }
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
