'use strict';
// Two real isolated Hub versions. Old Codex TUI and new App Server share only
// this test's data/home. A local Responses fixture removes service variance.
const fs=require('fs'),path=require('path'),os=require('os'),net=require('net'),assert=require('assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher'),{connectFirstPage}=require('./helpers/cdp-client');
const {startResponsesFixture}=require('./fixtures/codex-responses-server');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const port=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
async function main(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-native-migration-')),out=path.resolve('artifacts/codex-native-runtime/migration-'+Date.now());fs.mkdirSync(out,{recursive:true});
  const fixture=await startResponsesFixture({chunks:1,delayMs:1}),home=path.join(root,'codex'),cwd=path.join(root,'workspace');fs.mkdirSync(home);fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(home,'config.toml'),'model="gpt-6-astra"\nmodel_reasoning_effort="xhigh"\nmodel_provider="fixture"\n[model_providers.fixture]\nname="fixture"\nbase_url="http://127.0.0.1:'+fixture.port+'/v1"\nwire_api="responses"\nenv_key="HUB_PERF_FIXTURE_KEY"\nsupports_websockets=false\n[windows]\nsandbox="unelevated"\n[notice]\nhide_full_access_warning=true\n');
  const result={root,out,checks:[],passed:false};let oldHub,oldCdp,newHub,cdp;
  const until=async(client,expr,name,ms=45000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await client.eval(expr))return;await sleep(120);}throw Error('timeout '+name);};
  const launch=async(entryPath)=>launchIsolatedHub({entryPath,dataDir:path.join(root,'data'),port:await port(),label:'migration',extraEnv:{CODEX_HOME:home,CLAUDE_CONFIG_DIR:path.join(root,'claude'),HUB_PERF_FIXTURE_KEY:'test-only'}});
  try{
    oldHub=await launch(path.resolve('artifacts/codex-native-runtime/baseline-8c5c6928'));oldCdp=await connectFirstPage(oldHub);await until(oldCdp,'typeof sessions!=="undefined"','old renderer');
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
    result.checks.push('after explicit old test Hub exit, native resume preserves exact thread, completed history and settings');result.passed=true;
  }finally{
    if(cdp){try{result.final=await cdp.eval('({sessions:[...sessions.values()],text:document.body.innerText.slice(-2500)})');}catch(e){result.captureError=e.message;}await cdp.close();}
    if(oldCdp)await oldCdp.close();
    if(oldHub){fs.writeFileSync(path.join(out,'old-hub.log'),oldHub.log().join('\n'));result.oldExit=await gracefulQuit(oldHub);}
    if(newHub){fs.writeFileSync(path.join(out,'new-hub.log'),newHub.log().join('\n'));result.newExit=await gracefulQuit(newHub);}
    await fixture.close();fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({out,passed:result.passed,checks:result.checks,oldExit:result.oldExit,newExit:result.newExit}));
  }
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
