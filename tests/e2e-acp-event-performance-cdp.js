'use strict';
// Real isolated Hub render pipeline, deterministic ACP agent; no model/network.
const fs=require('fs'),path=require('path'),os=require('os'),net=require('net'),assert=require('assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const port=()=>new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
async function main(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-acp-render-perf-')),dataDir=path.join(root,'data');fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir,'config.json'),JSON.stringify({acp:{nodePath:process.execPath,apiKey:'fixture-no-network',providers:{qwen:{model:'qwen3.8-max',entryPath:path.join(__dirname,'fixtures/acp-agent.js')}}}}));
  const result={fixture:true,boundary:'ACP subprocess emission through stdio, Main and real renderer DOM; model/network excluded',runs:[],passed:false,root};let hub,cdp;
  const until=async(expr,label)=>{const end=Date.now()+30000;while(Date.now()<end){if(await cdp.eval(expr))return;await sleep(50);}throw Error('timeout '+label);};
  try{
    hub=await launchIsolatedHub({dataDir,port:await port(),label:'acp-render-perf'});cdp=await connectFirstPage(hub);
    await until('typeof sessions!=="undefined"','renderer');
    const s=await cdp.eval('ipcRenderer.invoke("create-session",'+JSON.stringify({kind:'qwen',opts:{cwd:root}})+')');assert(s.id);const id=JSON.stringify(s.id);
    await until('sessions.get('+id+')?.acpSid','native bound');await cdp.eval('selectSession('+id+')');await until('document.querySelector(".floating-input-box")','composer');
    for(let repeat=0;repeat<3;repeat++){
      await cdp.eval(`(()=>{window.__perfObserver?.disconnect();window.__perfSamples=[];const seen=new Set();window.__perfStart=Date.now();window.__perfObserver=new MutationObserver(()=>{
        for(const d of document.querySelectorAll('.conversation-long-message:not([open])'))d.querySelector('summary').click();
        const text=[...document.querySelectorAll('.turn-card.assistant .turn-body')].map(e=>e.innerText).join(' ');
        for(const m of text.matchAll(/EVENT:([0-9]+):([0-9]+);/g)){if(Number(m[1])<window.__perfStart || seen.has(m[0]))continue;seen.add(m[0]);window.__perfSamples.push({delay:Date.now()-Number(m[1]),observedAt:Date.now(),index:Number(m[2])});}
      });window.__perfObserver.observe(document.body,{childList:true,subtree:true,characterData:true});})()`);
      const prior=await cdp.eval('sessions.get('+id+').nativeRuntime.turnId');
      await cdp.eval('(()=>{const b=document.querySelector(".floating-input-box");b.textContent='+JSON.stringify('PERF_RUN_'+repeat)+';b.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector(".floating-input-send").click();})()');
      await until('sessions.get('+id+').nativeRuntime.turnId!=='+JSON.stringify(prior)+' && sessions.get('+id+').nativeRuntime.state==="completed" && window.__perfSamples.length===60 && !document.querySelector(".streaming-indicator")','60 rendered updates and terminal UI');
      const run=await cdp.eval('({samples:window.__perfSamples,inputToFirstMs:window.__perfSamples[0].observedAt-window.__perfStart,memory:performance.memory?.usedJSHeapSize,runtime:sessions.get('+id+').nativeRuntime,terminalObservedAt:Date.now()})');
      const delays=run.samples.map(x=>x.delay).sort((a,b)=>a-b);run.p95Ms=delays[Math.floor(delays.length*.95)];run.maxMs=delays.at(-1);
      run.terminalToDomMs=run.terminalObservedAt-run.runtime.completedAt;delete run.runtime;
      assert(run.p95Ms<=500,'ACP event to DOM p95 exceeds 500 ms');result.runs.push(run);
    }
    result.passed=true;
  }finally{
    if(cdp){result.debug=await cdp.eval('({sessions:[...sessions.values()],samples:window.__perfSamples,text:document.body.innerText.slice(-5000)})');await cdp.close();}if(hub)result.exit=await gracefulQuit(hub);
    fs.mkdirSync('artifacts/acp',{recursive:true});fs.writeFileSync('artifacts/acp/render-performance.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
