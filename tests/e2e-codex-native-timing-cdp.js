'use strict';
// Measure actual renderer DOM against Main's native receipt clock. The fixture
// emits protocol events; this harness never writes Hub runtime state.
const fs=require('fs'),path=require('path'),os=require('os'),net=require('net'),assert=require('assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const port=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
async function main(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-native-timing-')),out=path.resolve('artifacts/codex-native-runtime/timing-'+Date.now());
  fs.mkdirSync(out,{recursive:true});const home=path.join(root,'codex'),cwd=path.join(root,'workspace');fs.mkdirSync(home);fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(home,'config.toml'),'model="gpt-6-astra"\nmodel_reasoning_effort="xhigh"\n');
  const result={root,out,checks:[],passed:false};let hub,cdp,foregroundTimer;
  const until=async(expr,label,ms=30000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await cdp.eval(expr))return;await sleep(100);}throw Error('timeout: '+label);};
  async function send(text){await cdp.eval('(()=>{const b=document.querySelector(".floating-input-box");b.textContent='+JSON.stringify(text)+';b.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector(".floating-input-send").click();})()');}
  try{
    hub=await launchIsolatedHub({dataDir:path.join(root,'data'),port:await port(),label:'native-timing',extraEnv:{CODEX_HOME:home,CLAUDE_CONFIG_DIR:path.join(root,'claude'),CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.join(__dirname,'fixtures/codex-app-server.js'),CLAUDE_HUB_NATIVE_FIXTURE_STORE:path.join(root,'threads.json'),CLAUDE_HUB_NATIVE_FIXTURE_TRACE:path.join(root,'trace.jsonl')}});
    cdp=await connectFirstPage(hub);await until('typeof sessions!=="undefined"','renderer');
    // This measures visible rendering. Other Hub windows can occlude the test
    // on this shared desktop, which intentionally suspends Chromium rAF.
    await cdp.send('Page.bringToFront');
    foregroundTimer=setInterval(()=>cdp.send('Page.bringToFront').catch(error=>{result.focusError=error.message;}),200);
    result.visibilityCondition='isolated test window kept foreground using CDP';
    const s=await cdp.eval('ipcRenderer.invoke("create-session",'+JSON.stringify({kind:'codex',opts:{cwd,model:'gpt-6-astra',effort:'xhigh',mcpProfile:'none',codexSpeedTier:'standard'}})+')');
    const sid=JSON.stringify(s.id);result.sid=s.id;
    await until('sessions.get('+sid+')?.nativeRuntime?.state==="idle"','idle');
    await until('document.querySelector(\'.session-item[data-session-id="'+s.id+'"]\')','sidebar mounted');
    await cdp.eval('document.querySelector(\'.session-item[data-session-id="'+s.id+'"]\').click()');
    await until('document.querySelector(".floating-input-box")','composer');
    await send('fixture:hold');await until('document.querySelector(\'.session-item[data-session-id="'+s.id+'"]\')?.dataset.runtimeState==="running"','quiet turn visible');
    async function legacyHooksDoNotVote(){
      const control=JSON.parse(fs.readFileSync(path.join(root,'data','control',hub.pid+'.json'),'utf8'));
      const before=await cdp.eval('sessions.get('+sid+').nativeRuntime');
      for(const event of ['prompt','stop','stop-failure']){
        const response=await fetch('http://127.0.0.1:'+control.hookPort+'/api/hook/'+event,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:control.token,sessionId:s.id,cwd,prompt:'obsolete hook',turnId:'obsolete-turn'})});
        assert.equal(response.status,202);assert.equal((await response.json()).ignored,'codex-native-only');
      }
      const after=await cdp.eval('sessions.get('+sid+').nativeRuntime');assert.deepEqual(after,before);
    }
    await legacyHooksDoNotVote();
    const begin=Date.now();result.quietSamples=[];
    while(Date.now()-begin<61000){
      const r=await cdp.eval('({state:sessions.get('+sid+').nativeRuntime.state,side:document.querySelector(\'.session-item[data-session-id="'+s.id+'"]\')?.dataset.runtimeState,header:document.querySelector(".terminal-crumb-dot")?.dataset.runtimeState,composer:document.querySelector(".composer")?.dataset.state})');
      result.quietSamples.push({at:Date.now(),...r});assert.equal(r.state,'running');assert.equal(r.side,'running');assert.equal(r.composer,'working');
      if(result.quietSamples.length===2)await cdp.eval('document.querySelector(\'[data-view="card"]\').click()');
      if(result.quietSamples.length===5)await cdp.eval('require("electron").webFrame.setZoomFactor(1.1)');
      if(result.quietSamples.length===8)await cdp.eval('document.querySelector(\'[data-view="pty"]\').click();require("electron").webFrame.setZoomFactor(1)');
      await sleep(2000);
    }
    result.quietMs=Date.now()-begin;result.checks.push('61+ seconds without output retains running across views and zoom');
    await cdp.eval('document.querySelector(".floating-input-stop").click()');await until('sessions.get('+sid+').nativeRuntime.state==="interrupted"','quiet stop');
    await cdp.eval(`(()=>{
      window.nativeTiming={samples:[],pending:[],last:null};
      ipcRenderer.on('session-updated',(_e,{session:s})=>{
        if(s.id!==${sid} || !s.nativeRuntime)return;
        const r=s.nativeRuntime,k=[r.epoch,r.state,r.connection].join(':');
        if(k===nativeTiming.last)return;nativeTiming.last=k;
        nativeTiming.pending.push({state:r.state,connection:r.connection,at:r.observedAt,revision:r.revision});
      });
      function read(){
        const side=document.querySelector('.session-item[data-session-id="'+${sid}+'"]')?.dataset.runtimeState;
        const header=document.querySelector('.terminal-crumb-dot')?.dataset.runtimeState;
        const composer=document.querySelector('.composer')?.dataset.state;
        for(const p of nativeTiming.pending){
          const c=p.connection!=='connected'||p.state==='unknown'?'dead':p.state==='running'?'working':p.state==='waiting'?'waiting':'ready';
          if(!p.done && ((side===p.state && header===p.state && composer===c) || Date.now()-p.at>2000)){
            p.done=true;nativeTiming.samples.push({...p,side,header,composer,latencyMs:Date.now()-p.at,match:side===p.state&&header===p.state&&composer===c});
          }
        }
        requestAnimationFrame(read);
      }requestAnimationFrame(read);
    })()`);
    await send('fixture:cycle');await until('sessions.get('+sid+').nativeRuntime.state==="completed"','200 transitions finish',85000);await sleep(250);
    result.transitions=await cdp.eval('nativeTiming.samples');
    const transitions=result.transitions.filter(x=>['running','waiting'].includes(x.state));assert.equal(transitions.length,201);
    assert(transitions.every(x=>x.match),'each native transition must reach all visible consumers');
    const times=transitions.map(x=>x.latencyMs).sort((a,b)=>a-b);result.p95=times[Math.ceil(times.length*.95)-1];result.max=times.at(-1);
    assert(result.p95<=500 && result.max<=2000,JSON.stringify({p95:result.p95,max:result.max}));result.checks.push('200 state transitions: sidebar, header and composer match native state within thresholds');
    await legacyHooksDoNotVote();result.checks.push('authenticated old prompt/stop/failure hooks cannot change running or completed native snapshots');
    await send('fixture:crash-before');await until('sessions.get('+sid+').nativeRuntime.connection==="disconnected"','EOF');await sleep(250);
    result.eof=(await cdp.eval('nativeTiming.samples')).filter(x=>x.connection==='disconnected').at(-1);assert(result.eof?.match && result.eof.latencyMs<=1000);
    await cdp.eval('document.querySelector(".composer-status-action").click()');await until('sessions.get('+sid+').nativeRuntime.connection==="connected"','reconnect');await sleep(250);
    result.recovered=(await cdp.eval('nativeTiming.samples')).filter(x=>x.connection==='connected').at(-1);assert(result.recovered?.match && result.recovered.latencyMs<=2000);
    assert.equal(await cdp.eval('sessions.get('+sid+').nativeRuntime.submission.status'),'unknown');
    const trace=fs.readFileSync(path.join(root,'trace.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(trace.filter(x=>x.method==='turn/start' && x.params.input.some(i=>i.text==='fixture:crash-before')).length,1);
    result.checks.push('EOF visible within 1s, native reconciliation within 2s, unknown submission is not replayed');
    const shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'recovered-unknown.png'),Buffer.from(shot.data,'base64'));result.passed=true;
  }finally{
    clearInterval(foregroundTimer);
    if(cdp){try{result.final=await cdp.eval('({text:document.body.innerText.slice(-3000),timing:window.nativeTiming})');}catch(e){result.captureError=e.message;}await cdp.close();}
    if(hub){fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));result.exit=await gracefulQuit(hub);}
    fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({out,passed:result.passed,checks:result.checks,p95:result.p95,max:result.max,quietMs:result.quietMs,exit:result.exit}));
  }
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
