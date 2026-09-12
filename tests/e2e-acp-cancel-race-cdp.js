'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
(async()=>{
  delete process.env.ELECTRON_RUN_AS_NODE;
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-acp-cancel-gui-')),dataDir=path.join(root,'data');
  const out=path.resolve('artifacts/acp-round2/gui-'+Date.now());fs.mkdirSync(out,{recursive:true});fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir,'config.json'),JSON.stringify({acp:{nodePath:process.execPath,apiKey:'fixture-no-real-credential',
    providers:{qwen:{entryPath:path.join(__dirname,'fixtures/acp-cancel-race.js'),model:'qwen3.8-max'}}}}));
  const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const p=server.address().port;server.close(()=>resolve(p));});});
  const report={root,out,fixture:true,checks:[],passed:false};let hub,cdp;
  const until=async(expr,label)=>{const deadline=Date.now()+25000;while(Date.now()<deadline){if(await cdp.eval(expr))return;await new Promise(r=>setTimeout(r,60));}throw Error('timeout '+label);};
  const snap=async name=>{const s=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(s.data,'base64'));};
  const enter=async text=>cdp.eval('(()=>{const box=document.querySelector(".floating-input-box");box.textContent='+JSON.stringify(text)+';box.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector(".floating-input-send").click();})()');
  try {
    hub=await launchIsolatedHub({dataDir,port,label:'ACP cancellation race',extraEnv:{ACP_CANCEL_FIXTURE_HOLD_MS:'2000',
      CODEX_HOME:path.join(root,'codex'),CLAUDE_CONFIG_DIR:path.join(root,'claude')}});report.pid=hub.pid;
    cdp=await connectFirstPage(hub);await until('typeof sessions!=="undefined"','renderer');
    for (const mode of ['late-interactions','queued-permission','no-confirmation']) {
      report.currentMode=mode;
      const cwd=path.join(root,mode);fs.mkdirSync(cwd);
      const s=await cdp.eval('ipcRenderer.invoke("create-session",'+JSON.stringify({kind:'qwen',opts:{cwd,model:'qwen3.8-max'}})+')');assert(s.id);
      const sid=JSON.stringify(s.id),runtime='sessions.get('+sid+').nativeRuntime';
      await until(runtime+'.state==="idle"','idle');
      await until('document.querySelector(\'.session-item[data-session-id="'+s.id+'"]\')','session sidebar row');
      await cdp.eval('document.querySelector(\'.session-item[data-session-id="'+s.id+'"]\').click()');
      await until('document.querySelector(".floating-input-box")','composer');await enter(mode);
      await until(runtime+'.state==="running" || '+runtime+'.state==="waiting"','running');
      let old;
      if(mode==='queued-permission') {
        await until('document.querySelector(".codex-native-request button")','existing permission');
        old=await cdp.eval(runtime+'.requests[0]');await snap(mode+'-before-stop');
      }
      await cdp.eval('document.querySelector(".floating-input-stop").click()');
      await until(runtime+'.cancellation?.status==="pending" && !!document.querySelector(".acp-cancelling")','visible cancellation');
      assert.equal(await cdp.eval('document.querySelectorAll(".codex-native-request button:not([disabled])").length'),0);
      await snap(mode+'-cancelling');
      const record={mode,afterStop:await cdp.eval(runtime)};
      if(old) {
        record.oldReply=await cdp.eval('ipcRenderer.invoke("codex:native-action",'+JSON.stringify({sessionId:s.id,action:'reply',
          requestId:old.id,epoch:record.afterStop.epoch,result:{outcome:{outcome:'selected',optionId:'allow'}}})+')');
        assert.equal(record.oldReply.ok,false,'Main rejects old button payload');
      }
      const final=mode==='no-confirmation'?'unknown':'interrupted';
      await until(runtime+'.state==='+JSON.stringify(final),'provider result or bounded unknown');
      record.final=await cdp.eval(runtime);assert(!fs.existsSync(path.join(cwd,'side-effect.txt')));
      if(mode==='no-confirmation') {
        assert.equal(record.final.submission.status,'unknown');assert.match(record.final.reason,/停止未在期限/);
        await until('document.body.innerText.includes("停止未在期限")','visible timeout reason');
      } else {
        await enter('next');await until(runtime+'.state==="completed"','next turn');
      }
      await snap(mode+'-final');report.checks.push(record);
    }
    // Exercise the real group composer and stop control on first open.
    const cwd=path.join(root,'group');fs.mkdirSync(cwd);
    const group=await cdp.eval('ipcRenderer.invoke("create-meeting",'+JSON.stringify({title:'ACP 取消竞态群聊',scene:'general',workspace:cwd,
      slots:[{kind:'qwen',model:'qwen3.8-max'},{kind:'qwen',model:'qwen3.8-max'}]})+')');
    report.meetingId=group.id;
    await until(JSON.stringify(group.subSessions)+'.every(id=>sessions.get(id)?.nativeRuntime?.state==="idle")','group members');
    await cdp.eval('window.MeetingRoom.openMeeting('+JSON.stringify(group.id)+','+JSON.stringify(group)+')');
    await until('document.getElementById("mr-input-box")','group composer');
    await cdp.eval('(()=>{const box=document.getElementById("mr-input-box");box.textContent="late-interactions";box.dispatchEvent(new Event("input",{bubbles:true}));document.getElementById("mr-send-btn").click();})()');
    await until(JSON.stringify(group.subSessions)+'.every(id=>sessions.get(id)?.nativeRuntime?.state==="running")','group running');
    await until('document.querySelector("[data-gc-stop-turn]")','group stop control');
    await cdp.eval('document.querySelector("[data-gc-stop-turn]").click()');
    await until(JSON.stringify(group.subSessions)+'.every(id=>sessions.get(id)?.nativeRuntime?.cancellation?.status==="pending")','group cancellation snapshot');
    await until('document.querySelector("[data-gc-cancelling]") && [...document.querySelectorAll(".mr-gc-msg")].filter(el=>el.innerText.includes("正在停止")).length>=2','group cancellation visible');
    const record={mode:'group',pending:await cdp.eval(JSON.stringify(group.subSessions)+'.map(id=>sessions.get(id).nativeRuntime)')};
    assert(record.pending.every(r=>r.requests.length===0 && r.state==='running'));
    assert.equal(await cdp.eval('document.getElementById("mr-group-chat-panel").innerText.includes("正在发言")'),false);
    assert.equal(await cdp.eval('document.body.innerText.includes("已停止本轮：")'),false);
    await snap('group-cancelling');
    await until(JSON.stringify(group.subSessions)+'.every(id=>sessions.get(id)?.nativeRuntime?.state==="interrupted")','group provider cancellation');
    assert(!fs.existsSync(path.join(cwd,'side-effect.txt')));await snap('group-final');report.checks.push(record);
    report.passed=true;
  }catch(error){report.error=error.message;process.exitCode=1;}
  finally {
    if(cdp){await snap('final').catch(error=>{report.captureError=error.message;});await cdp.close();}
    if(hub){fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));report.exit=await gracefulQuit(hub);}
    fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({out,passed:report.passed,error:report.error,checks:report.checks.length}));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
