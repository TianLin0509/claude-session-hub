'use strict';
// Two real isolated Hub versions. Old Codex TUI and new App Server share only
// this test's data/home. A local Responses fixture removes service variance.
const fs=require('fs'),path=require('path'),os=require('os'),net=require('net'),assert=require('assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher'),{connectFirstPage}=require('./helpers/cdp-client');
const {startResponsesFixture}=require('./fixtures/codex-responses-server');
const {execFileSync}=require('node:child_process'),{pathToFileURL}=require('node:url');
const {screenshotReadOnlyReport}=require('./helpers/readonly-report-screenshot');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const port=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
async function main(){
  const baseline=path.resolve('artifacts/native-agent/baseline-8c5c6928');
  if(!fs.existsSync(path.join(baseline,'main.js')))throw Error('Prepare fixed baseline 8c5c6928 first');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-native-migration-')),out=path.resolve('artifacts/codex-native-runtime/migration-'+Date.now());fs.mkdirSync(out,{recursive:true});
  const fixture=await startResponsesFixture({chunks:1,delayMs:1}),home=path.join(root,'codex'),cwd=path.join(root,'workspace');fs.mkdirSync(home);fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(home,'config.toml'),'model="gpt-6-astra"\nmodel_reasoning_effort="xhigh"\nmodel_provider="fixture"\n[model_providers.fixture]\nname="fixture"\nbase_url="http://127.0.0.1:'+fixture.port+'/v1"\nwire_api="responses"\nenv_key="HUB_PERF_FIXTURE_KEY"\nsupports_websockets=false\n[windows]\nsandbox="unelevated"\n[notice]\nhide_full_access_warning=true\n');
  const result={root,out,head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),realCLI:true,realModel:false,checks:[],passed:false};let oldHub,oldCdp,newHub,cdp;
  const until=async(client,expr,name,ms=45000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await client.eval(expr))return;await sleep(120);}throw Error('timeout '+name);};
  const launch=async(entryPath)=>launchIsolatedHub({entryPath,dataDir:path.join(root,'data'),port:await port(),windowMode:'hidden',label:'migration',extraEnv:{CODEX_HOME:home,CLAUDE_CONFIG_DIR:path.join(root,'claude'),CLAUDE_HUB_HOME_DIR:path.join(root,'home'),DEEPSEEK_API_KEY:'',HUB_PERF_FIXTURE_KEY:'test-only'}});
  try{
    oldHub=await launch(baseline);oldCdp=await connectFirstPage(oldHub);await until(oldCdp,'typeof sessions!=="undefined"','old renderer');
    const old=await oldCdp.eval('ipcRenderer.invoke("create-session",'+JSON.stringify({kind:'codex',opts:{cwd,model:'gpt-6-astra',effort:'xhigh',title:'待迁移测试',userRenamed:true,mcpProfile:'none',codexSpeedTier:'standard'}})+')');result.sid=old.id;const sid=JSON.stringify(old.id);
    await until(oldCdp,'sessions.get('+sid+')?.codexSid','old native identity');await sleep(1500);
    await oldCdp.eval('document.querySelector(\'.session-item[data-session-id="'+old.id+'"]\').click()');await until(oldCdp,'document.querySelector(".floating-input-box")','old composer');
    await oldCdp.eval('(()=>{const b=document.querySelector(".floating-input-box");b.textContent="迁移历史样本";b.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector(".floating-input-send").click();})()');
    await until(oldCdp,'sessions.get('+sid+').lastCompletedAt>0','old completed');result.nativeId=await oldCdp.eval('sessions.get('+sid+').codexSid');await sleep(900);
    await oldCdp.eval('(()=>{const box=document.querySelector(".floating-input-box");box.textContent="旧 TUI 尚未发送的迁移草稿";box.dispatchEvent(new Event("input",{bubbles:true}));})()');
    newHub=await launch(path.resolve('.'));cdp=await connectFirstPage(newHub);await until(cdp,'typeof sessions!=="undefined" && sessions.has('+sid+')','new persisted card');
    await cdp.eval('selectSession('+sid+')');await until(cdp,'sessions.get('+sid+').nativeRuntime?.connection==="disconnected"','blocked migration');
    const blocked=await cdp.eval('sessions.get('+sid+').nativeRuntime');assert.match(blocked.reason,/原 Hub 仍持有/);assert.equal(blocked.threadId,null);
    await until(cdp,'document.querySelector(".floating-input-box")?.innerText==="旧 TUI 尚未发送的迁移草稿"','old draft copied without sending');
    assert.equal((await oldCdp.eval('ipcRenderer.invoke("get-sessions")')).filter(s=>s.codexSid===result.nativeId).length,1);
    let shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'old-owner-blocked.png'),Buffer.from(shot.data,'base64'));
    result.checks.push('actual old Hub retains its live Codex TUI; new Hub cannot resume the same thread');
    await oldCdp.close();oldCdp=null;result.oldExit=await gracefulQuit(oldHub);oldHub=null;
    await cdp.eval('document.querySelector(".composer-status-action").click()');await until(cdp,'sessions.get('+sid+').nativeRuntime?.connection==="connected"','migration after owner exit');
    assert.equal(await cdp.eval('sessions.get('+sid+').nativeRuntime.threadId'),result.nativeId);assert.equal(await cdp.eval('sessions.get('+sid+').nativeRuntime.state'),'completed');
    await cdp.eval('document.querySelector(\'[data-view="card"]\').click()');await until(cdp,'document.querySelector(".msg-overlay")?.innerText.includes("HUB_PERF_DONE")','native history shown');
    shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'native-migrated.png'),Buffer.from(shot.data,'base64'));
    result.checks.push('after explicit old test Hub exit, native resume preserves exact thread, completed history and settings');
    if(process.argv.includes('--rollback')){
      const previousTurnId=await cdp.eval(`sessions.get(${sid}).nativeRuntime.turnId`);
      await cdp.eval('document.querySelector(".floating-input-send").click()');
      await until(cdp,`sessions.get(${sid}).nativeRuntime.state==='completed' && sessions.get(${sid}).nativeRuntime.turnId!==${JSON.stringify(previousTurnId)}`,'native new answer');
      await cdp.eval(`(()=>{const b=document.querySelector('.floating-input-box');replaceContenteditableText(b,'回退后保留的 Codex 新草稿 — 🧪');b.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await until(cdp,'document.querySelector(".floating-input-box").dataset.draftState==="saved"','durable native draft');
      const draft=await cdp.eval(`ipcRenderer.invoke('native-draft:read',{sessionId:${sid}})`);
      const before=await cdp.eval(`ipcRenderer.invoke('parse-session-transcript',{hubSessionId:${sid}})`);
      const submission=await cdp.eval(`sessions.get(${sid}).nativeRuntime.submission`);
      const exportFile=path.join(out,'rollback-recovery.json'),report=path.join(out,'rollback-recovery.html');
      const snapshot={sessionId:old.id,providerId:result.nativeId,submission,turns:before.turns,unsentDraft:draft.record.text,instruction:'Read-only. Do not replay.'};
      fs.writeFileSync(exportFile,JSON.stringify(snapshot,null,2),'utf8');
      execFileSync(process.execPath,[path.resolve('scripts/render-native-recovery.js'),exportFile,report]);
      const requests=fixture.requests.filter(r=>r.purpose==='workload').length;
      assert.equal(requests,2,'one old prompt and one native prompt');
      await cdp.close();cdp=null;result.beforeRollbackExit=await gracefulQuit(newHub);newHub=null;
      oldHub=await launch(baseline);oldCdp=await connectFirstPage(oldHub);
      await until(oldCdp,`typeof sessions!=='undefined' && sessions.has(${sid})`,'actual rollback session');
      await oldCdp.eval(`selectSession(${sid})`);
      await until(oldCdp,'!!document.querySelector(".floating-input-box")','old rollback input');
      result.rollbackOldComposerCompatible=await oldCdp.eval(`readContenteditablePlainText(document.querySelector('.floating-input-box'))===${JSON.stringify(draft.record.text)}`);
      await oldCdp.send('Page.navigate',{url:pathToFileURL(report).href});
      await until(oldCdp,'!!document.getElementById("recovery-json")','read-only recovery report');
      assert.deepEqual(await oldCdp.eval('JSON.parse(document.getElementById("recovery-json").textContent)'),snapshot);
      assert.equal(await oldCdp.eval('document.querySelectorAll("script,button,form,iframe").length'),0);
      result.reportRendering=screenshotReadOnlyReport(report,path.join(out,'rollback-readonly-reader.png'));
      await oldCdp.close();oldCdp=null;result.rollbackExit=await gracefulQuit(oldHub);oldHub=null;
      newHub=await launch(path.resolve('.'));cdp=await connectFirstPage(newHub);
      await until(cdp,`typeof sessions!=='undefined' && sessions.has(${sid})`,'reupgrade session');
      await cdp.eval(`selectSession(${sid})`);
      await until(cdp,`sessions.get(${sid}).nativeRuntime.connection==='connected' && sessions.get(${sid}).nativeRuntime.state==='completed'`,'reupgrade same completed turn');
      await until(cdp,`readContenteditablePlainText(document.querySelector('.floating-input-box'))===${JSON.stringify(draft.record.text)}`,'reupgrade draft');
      const after=await cdp.eval(`ipcRenderer.invoke('parse-session-transcript',{hubSessionId:${sid}})`);
      assert.deepEqual(after.turns.map(t=>[t.id,t.role,t.text]),before.turns.map(t=>[t.id,t.role,t.text]));
      assert.equal(await cdp.eval(`sessions.get(${sid}).nativeRuntime.threadId`),result.nativeId);
      assert.deepEqual(await cdp.eval(`ipcRenderer.invoke('native-draft:read',{sessionId:${sid}})`),draft);
      assert.equal(fixture.requests.filter(r=>r.purpose==='workload').length,requests,'rollback/reupgrade never replays either prompt');
      shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'reupgrade-preserved.png'),Buffer.from(shot.data,'base64'));
      result.rollbackCompatibilityMode='explicit-read-only-companion; old UI does not read new schema';result.rollbackGatePassed=true;
      result.checks.push('old/new roundtrip and explicit offline reader preserve exact history IDs, text, draft revision and thread without model replay');
    }
    result.passed=true;
  }catch(error){result.error=error.stack;throw error;}finally{
    if(cdp){try{result.final=await cdp.eval('({sessions:[...sessions.values()],text:document.body.innerText.slice(-2500)})');}catch(e){result.captureError=e.message;}await cdp.close();}
    if(oldCdp)await oldCdp.close();
    if(oldHub){fs.writeFileSync(path.join(out,'old-hub.log'),oldHub.log().join('\n'));result.oldExit=await gracefulQuit(oldHub);}
    if(newHub){fs.writeFileSync(path.join(out,'new-hub.log'),newHub.log().join('\n'));result.newExit=await gracefulQuit(newHub);}
    await fixture.close();fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({out,passed:result.passed,checks:result.checks,oldExit:result.oldExit,newExit:result.newExit}));
  }
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
