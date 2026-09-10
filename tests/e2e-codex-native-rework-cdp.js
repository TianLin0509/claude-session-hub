'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),net=require('net'),assert=require('assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function freePort(){return new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});}
async function main(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-native-rework-gui-'));
  const out=path.resolve('artifacts/codex-native-round2/gui-'+Date.now());fs.mkdirSync(out,{recursive:true});
  const home=path.join(root,'codex'),cwd=path.join(root,'workspace'),trace=path.join(out,'rpc.jsonl');fs.mkdirSync(home);fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(home,'config.toml'),'model = "gpt-6-astra"\nmodel_reasoning_effort = "xhigh"\n');
  let hub,cdp,launched;const result={root,out,checks:[],passed:false};
  const until=async(expr,label)=>{const end=Date.now()+25000;while(Date.now()<end){if(await cdp.eval(expr))return;await sleep(80);}throw Error('timeout: '+label);};
  const snap=async name=>{const shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(shot.data,'base64'));};
  const calls=()=>fs.readFileSync(trace,'utf8').trim().split('\n').map(JSON.parse);
  try{
    hub=await launchIsolatedHub({dataDir:path.join(root,'data'),port:await freePort(),label:'native-rework',extraEnv:{CODEX_HOME:home,
      CLAUDE_CONFIG_DIR:path.join(root,'claude'),CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.join(__dirname,'fixtures','codex-app-server.js'),
      CLAUDE_HUB_NATIVE_FIXTURE_TRACE:trace}});launched=hub;result.pid=hub.pid;result.port=hub.port;
    cdp=await connectFirstPage(hub);await until('typeof sessions!=="undefined" && typeof ipcRenderer!=="undefined"','renderer');
    await cdp.send('Page.bringToFront');
    async function create(){
      const s=await cdp.eval('ipcRenderer.invoke("create-session",'+JSON.stringify({kind:'codex',opts:{cwd,model:'gpt-6-astra',effort:'xhigh',mcpProfile:'none',codexSpeedTier:'standard'}})+')');
      await until('sessions.get('+JSON.stringify(s.id)+')?.nativeRuntime?.state==="idle"','native idle');
      return s;
    }
    async function select(s){
      await until('document.querySelector('+JSON.stringify('.session-item[data-session-id="'+s.id+'"]')+')','sidebar');
      await cdp.eval('document.querySelector('+JSON.stringify('.session-item[data-session-id="'+s.id+'"]')+').click()');
      await until('!!document.querySelector(".floating-input-box")','composer');
    }
    async function send(text){
      await cdp.eval('(()=>{const input=document.querySelector(".floating-input-box");input.textContent='+JSON.stringify(text)+';input.dispatchEvent(new Event("input",{bubbles:true}));input.focus();})()');
      await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});
      await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});
    }
    const errorSession=await create(),a=JSON.stringify(errorSession.id);await select(errorSession);
    await send('fixture:resolve-error');
    await until('sessions.get('+a+').nativeRuntime.state==="waiting" && document.querySelector(".codex-native-request textarea")','waiting form');
    await cdp.eval('document.querySelector(".codex-native-request textarea").value="A";document.querySelector(".codex-native-request button[type=submit]").click()');
    await until('sessions.get('+a+').nativeRuntime.state==="unknown" && sessions.get('+a+').nativeRuntime.requests.length===0','native error retained after resolution');
    const before=await cdp.eval('sessions.get('+a+').nativeRuntime');await sleep(400);
    const after=await cdp.eval('sessions.get('+a+').nativeRuntime');assert.deepEqual(after,before);
    await until('document.body.innerText.includes("Codex 状态待核对") && document.body.innerText.includes("Codex 服务端状态异常")','visible error');
    result.errorSnapshot=after;result.errorSessionId=errorSession.id;await snap('unknown-after-resolution');
    result.checks.push('R1: real Hub answer form -> stdio systemError + resolved + replay; unknown and revision unchanged');
    const normal=await create(),b=JSON.stringify(normal.id);await select(normal);await send('fixture:hold');
    await until('sessions.get('+b+').nativeRuntime.state==="running"','normal running');
    await cdp.eval('document.querySelector(".floating-input-stop").click()');
    await until('sessions.get('+b+').nativeRuntime.state==="interrupted"','stop terminal');
    await snap('stop-retains-native-terminal');
    result.checks.push('stop button waits for native interrupted while the other thread remains unknown');
    await cdp.eval('document.querySelector(".btn-close-session").click()');
    await until('sessions.get('+b+')?.status==="dormant"','header close suspends');await snap('closed-and-dormant');
    result.checks.push('real header close -> suspend gate -> dormant; no new turn for the closed thread');
    const queued=await create(),q=JSON.stringify(queued.id);await select(queued);await send('fixture:stop-delayed');
    await until('sessions.get('+q+').nativeRuntime.state==="running" && sessions.get('+q+').nativeRuntime.submission?.status==="accepted"','shutdown live turn');
    result.shutdownThreadId=await cdp.eval('sessions.get('+q+').nativeRuntime.threadId');
    await send('/compact');await sleep(150);
    // A second actual IPC request queues behind the composer command. It must
    // never be dispatched as turn/start/steer while Hub drains its sessions.
    await cdp.eval('(()=>{window.reworkQueued=ipcRenderer.invoke("session:send-prompt",'+JSON.stringify({sessionId:queued.id,text:'forbidden-after-shutdown',clientSubmissionId:'shutdown-queued'})+');return true;})()');
    await snap('queued-before-shutdown');
    assert.equal(calls().filter(c=>c.params?.threadId===result.shutdownThreadId && c.method==='turn/start').length,1);
    await cdp.close();cdp=null;result.exit=await gracefulQuit(hub);hub=null;
    const rpc=calls().filter(c=>c.params?.threadId===result.shutdownThreadId && ['turn/start','turn/steer','turn/interrupt','thread/compact/start','thread/unsubscribe'].includes(c.method));
    result.shutdownCalls=rpc;assert.deepEqual(rpc.map(c=>c.method),['turn/start','turn/interrupt','thread/unsubscribe']);
    result.checks.push('real Hub graceful shutdown cancels composer /compact + queued prompt; trace has start -> interrupt -> unsubscribe only');
    result.passed=true;
  }catch(error){result.error=error.stack;throw error;}
  finally{
    if(launched)fs.writeFileSync(path.join(out,'hub.log'),launched.log().join('\n'));
    if(cdp){try{await snap('final');}catch(error){result.captureError=error.message;}await cdp.close();}
    if(hub)result.exit=await gracefulQuit(hub);
    fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
  }
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
