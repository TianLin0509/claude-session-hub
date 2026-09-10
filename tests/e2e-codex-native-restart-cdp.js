'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),net=require('net'),assert=require('assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher'),{connectFirstPage}=require('./helpers/cdp-client');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const port=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
async function main(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-native-restart-')),out=path.resolve('artifacts/codex-native-runtime/restart-'+Date.now());fs.mkdirSync(out,{recursive:true});
  const home=path.join(root,'codex'),cwd=path.join(root,'workspace');fs.mkdirSync(home);fs.mkdirSync(cwd);fs.writeFileSync(path.join(home,'config.toml'),'model="gpt-6-astra"\nmodel_reasoning_effort="xhigh"\n');
  const result={root,out,checks:[],exits:[],passed:false};let hub,cdp,sid,turnId,epoch;
  const until=async(expr,name)=>{const end=Date.now()+30000;while(Date.now()<end){if(await cdp.eval(expr))return;await sleep(100);}throw Error('timeout '+name);};
  async function start(){hub=await launchIsolatedHub({dataDir:path.join(root,'data'),port:await port(),label:'native-restart',extraEnv:{CODEX_HOME:home,CLAUDE_CONFIG_DIR:path.join(root,'claude'),CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.join(__dirname,'fixtures/codex-app-server.js'),CLAUDE_HUB_NATIVE_FIXTURE_STORE:path.join(root,'threads.json'),CLAUDE_HUB_NATIVE_FIXTURE_TRACE:path.join(root,'trace.jsonl')}});cdp=await connectFirstPage(hub);await until('typeof sessions!=="undefined"','renderer');}
  async function stop(){if(cdp){await cdp.close();cdp=null;}if(hub){result.exits.push(await gracefulQuit(hub));hub=null;}}
  try{
    await start();const s=await cdp.eval('ipcRenderer.invoke("create-session",'+JSON.stringify({kind:'codex',opts:{cwd,model:'gpt-6-astra',effort:'xhigh',mcpProfile:'none',codexSpeedTier:'standard'}})+')');sid=JSON.stringify(s.id);result.sid=s.id;
    await until('document.querySelector(\'.session-item[data-session-id="'+s.id+'"]\') && sessions.get('+sid+')?.nativeRuntime?.state==="idle"','session ready');await cdp.eval('document.querySelector(\'.session-item[data-session-id="'+s.id+'"]\').click()');
    await until('document.querySelector(".floating-input-box")','composer');
    await cdp.eval('(()=>{const b=document.querySelector(".floating-input-box");b.textContent="fixture:empty";b.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector(".floating-input-send").click();})()');
    await until('sessions.get('+sid+').nativeRuntime.state==="completed"','known complete');
    turnId=await cdp.eval('sessions.get('+sid+').nativeRuntime.turnId');epoch=await cdp.eval('sessions.get('+sid+').nativeRuntime.epoch');
    await cdp.eval('(()=>{const b=document.querySelector(".floating-input-box");b.textContent="重启后必须保留的草稿";b.dispatchEvent(new Event("input",{bubbles:true}));})()');await sleep(700);await stop();
    await start();await until('sessions.has('+sid+')','persisted card');
    assert.equal(await cdp.eval('sessions.get('+sid+').nativeRuntime.state'),'completed');
    await cdp.eval('selectSession('+sid+')');await until('sessions.get('+sid+').nativeRuntime.connection==="connected"','resume same native');
    assert.equal(await cdp.eval('sessions.get('+sid+').nativeRuntime.turnId'),turnId);assert((await cdp.eval('sessions.get('+sid+').nativeRuntime.epoch'))>epoch);
    await until('document.querySelector(".floating-input-box")?.innerText==="重启后必须保留的草稿"','draft retained');
    result.checks.push('full Hub restart retains exact completed turn, parameters and unsent draft');
    const sent=await cdp.eval('ipcRenderer.invoke("session:send-prompt",{sessionId:'+sid+',text:"fixture:crash",clientSubmissionId:"restart-unknown"})');assert.equal(sent.ok,false);
    await until('sessions.get('+sid+').nativeRuntime.connection==="disconnected"','uncertain crashed');await sleep(700);await stop();
    // The persisted provider record has an unfinished turn, but no executing
    // engine after its process died. This fixture snapshot models that fact.
    const threads=JSON.parse(fs.readFileSync(path.join(root,'threads.json'),'utf8'));for(const [,t] of threads)t.status={type:'idle'};fs.writeFileSync(path.join(root,'threads.json'),JSON.stringify(threads));
    await start();await until('sessions.has('+sid+')','unknown persisted card');await cdp.eval('selectSession('+sid+')');
    await until('sessions.get('+sid+').nativeRuntime.connection==="connected"','unknown resumed');
    assert.equal(await cdp.eval('sessions.get('+sid+').nativeRuntime.state'),'unknown');
    assert.equal(await cdp.eval('sessions.get('+sid+').nativeRuntime.submission.status'),'accepted','exact native client id proves message receipt but not completion');
    const trace=fs.readFileSync(path.join(root,'trace.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(trace.filter(x=>x.method==='turn/start' && x.params.clientUserMessageId==='restart-unknown').length,1);
    result.checks.push('Hub restart reconciles message identity without inventing a missing terminal outcome or resending');
    const shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'unknown-after-restart.png'),Buffer.from(shot.data,'base64'));result.passed=true;
  }finally{
    if(cdp){try{result.final=await cdp.eval('({sessions:[...sessions.values()],text:document.body.innerText.slice(-3000)})');}catch(e){result.captureError=e.message;}}
    if(hub)fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));await stop();fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({out,passed:result.passed,checks:result.checks,exits:result.exits}));
  }
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
