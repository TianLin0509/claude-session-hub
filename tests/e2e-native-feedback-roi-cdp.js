'use strict';
// Real isolated Hub + controlled native protocol. No runtime snapshots are
// injected by this test; messages enter through the actual composer.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const ROOT=path.resolve(__dirname,'..'),baseline=process.argv.includes('--baseline');
const entryPath=process.env.FEEDBACK_BASELINE_ROOT || ROOT;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const freePort=()=>new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
async function main(){
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'hub-feedback-roi-'));
  const out=path.join(ROOT,'artifacts','cli-feedback-roi',(baseline?'before-':'after-')+Date.now());fs.mkdirSync(out,{recursive:true});
  const workspace=path.join(temp,'workspace'),home=path.join(temp,'codex');fs.mkdirSync(workspace);fs.mkdirSync(home);
  fs.writeFileSync(path.join(home,'config.toml'),'model="gpt-6-astra"\nmodel_reasoning_effort="xhigh"\n');
  const result={baseline,entryPath,out,providers:[],passed:false,scope:'isolated Electron with native protocol fixtures; not real model E2E'};
  let hub,c,focusTimer;
  const until=async(expr,label,ms=25000)=>{const end=Date.now()+ms;while(Date.now()<end){const value=await c.eval(expr);if(value)return value;await sleep(60);}throw Error('timeout: '+label);};
  const shot=async name=>{const value=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(value.data,'base64'));};
  try{
    hub=await launchIsolatedHub({entryPath,dataDir:path.join(temp,'data'),port:await freePort(),label:'feedback-roi',extraEnv:{
      CLAUDE_HUB_E2E:'1',CODEX_HOME:home,CLAUDE_CONFIG_DIR:path.join(temp,'claude'),
      CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.join(__dirname,'fixtures/codex-app-server.js'),
      CLAUDE_HUB_NATIVE_FIXTURE_STORE:path.join(temp,'threads.json'),
      CLAUDE_HUB_CLAUDE_STREAM_FIXTURE:path.join(__dirname,'fixtures/claude-stream.js'),CLAUDE_HUB_CLAUDE_FIXTURE_MODE:'feedback'}});
    c=await connectFirstPage(hub,t=>t.type==='page'&&/index\.html/.test(t.url));
    await until('typeof sessions!=="undefined" && !!window.__hubE2E','renderer');
    await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await c.send('Page.bringToFront');focusTimer=setInterval(()=>c.send('Page.bringToFront').catch(e=>{result.focusError=e.message;}),1000);
    for(const kind of ['codex','claude']){
      const s=await c.eval(`ipcRenderer.invoke('create-session',${JSON.stringify({kind,opts:{cwd:workspace,model:kind==='codex'?'gpt-6-astra':'opus[1m]',effort:kind==='codex'?'xhigh':'max',mcpProfile:'none'}})})`);
      const sid=JSON.stringify(s.id);
      await until(`sessions.get(${sid})?.nativeRuntime?.connection==='connected'`,kind+' connected');
      await c.eval(`window.__hubE2E.selectSession(${sid},{forceScrollBottom:true});applyViewMode('card')`);
      await until(`document.querySelector('.floating-input-box') && !document.querySelector('#msg-overlay .card-history-loading')`,kind+' composer');
      await c.eval(`(()=>{window.feedbackSamples=[];window.feedbackSeen=new Set();window.feedbackObserver?.disconnect();
        window.feedbackObserver=new MutationObserver(()=>{const text=document.getElementById('msg-overlay').innerText;
          for(const m of text.matchAll(/FEEDBACK_(\\d+)@(\\d+)/g))if(!feedbackSeen.has(m[1])){feedbackSeen.add(m[1]);feedbackSamples.push({id:m[1],latencyMs:Date.now()-Number(m[2])});}});
        feedbackObserver.observe(document.getElementById('msg-overlay'),{subtree:true,childList:true,characterData:true});
        window.feedbackParseCount=0;window.feedbackInvoke=ipcRenderer.invoke.bind(ipcRenderer);
        ipcRenderer.invoke=(channel,...args)=>{if(channel==='parse-session-transcript')feedbackParseCount++;return feedbackInvoke(channel,...args);};
        document.querySelector('.floating-input-box').focus();})()`);
      await c.send('Input.insertText',{text:'fixture:feedback'});
      const local=await c.eval(`(()=>{const start=performance.now();document.querySelector('.floating-input-send').click();return {ms:performance.now()-start,card:!!document.querySelector('.turn-card.user[data-optimistic="true"]'),receipt:document.querySelector('.turn-prompt-receipt')?.textContent||''};})()`);
      await until('feedbackSamples.length===12',kind+' twelve streamed samples');
      await sleep(1800);
      const stats=await c.eval(`({samples:feedbackSamples,parseCount:feedbackParseCount,
        receipt:document.querySelector('.turn-prompt-receipt')?.textContent||'',detail:document.querySelector('.composer-status-detail')?.textContent||'',
        tools:[...window._sessionTurns.values()].flatMap(t=>t.toolCalls||[]).map(t=>({output:t.output,resultRef:t.resultRef})),
        state:sessions.get(${sid}).nativeRuntime.state,userCards:document.querySelectorAll('#msg-overlay .turn-card.user').length})`);
      const times=stats.samples.map(s=>s.latencyMs).sort((a,b)=>a-b);stats.p95=times[Math.ceil(times.length*.95)-1];stats.max=times.at(-1);stats.kind=kind;stats.local=local;
      result.providers.push(stats);
      assert(local.card,'input must appear immediately');assert.equal(stats.state,'running');assert.equal(stats.userCards,1,'one input must remain one card');
      if(!baseline){assert.match(stats.receipt,/引擎已收到/);assert.match(stats.detail,/收到更新|没有新输出/);assert.match(stats.detail,/Hub 本地有响应/);assert(stats.p95<700,kind+' local stream p95 '+stats.p95);
        if(kind==='codex'){
          assert(stats.tools.some(t=>String(t.output).includes('TOOL_OUTPUT_12')),'command output visible before completion');
          const reference=stats.tools.find(t=>t.resultRef?.itemId==='feedback-command').resultRef;
          stats.fullTool=await c.eval(`ipcRenderer.invoke('codex-native:tool-result',${JSON.stringify(reference)})`);
          assert(JSON.stringify(stats.fullTool).includes('TOOL_OUTPUT_01'),'full output remains readable');
        }
      }
      await shot(kind+'-card');
      if(!baseline && process.argv.includes('--silence')){
        await until(`document.querySelector('.composer-status-detail')?.textContent.includes('没有新输出')`,kind+' silence age',40000);
        stats.silent=await c.eval(`({state:sessions.get(${sid}).nativeRuntime.state,detail:document.querySelector('.composer-status-detail').textContent,stop:!document.querySelector('.floating-input-stop').disabled})`);
        assert.equal(stats.silent.state,'running');assert.match(stats.silent.detail,/Hub 本地有响应/);assert(stats.silent.stop);
        await shot(kind+'-silent');
      }
      await c.eval(`document.getElementById('btn-backstage').click()`);
      await until(`document.querySelector('.codex-backstage')?.getBoundingClientRect().height>0`,kind+' backstage');
      await until(`document.querySelector('.codex-backstage .cb-notice')?.hidden && document.querySelector('.codex-backstage .cb-list')?.textContent.includes('FEEDBACK_12')`,kind+' backstage content');
      await shot(kind+'-backstage');
      if(!baseline){const text=await c.eval(`document.querySelector('.cb-state-detail')?.textContent||''`);assert.match(text,/收到更新|没有新输出/);}
      await c.eval(`document.getElementById('btn-backstage').click()`);
      await c.eval(`feedbackObserver.disconnect();ipcRenderer.invoke=feedbackInvoke;document.querySelector('.floating-input-stop').click()`);
      await until(`sessions.get(${sid}).nativeRuntime.state==='interrupted'`,kind+' stop');
      await shot(kind+'-stopped');
    }
    result.passed=true;
  }finally{
    clearInterval(focusTimer);
    if(c){try{
      result.finalText=await c.eval('document.body.innerText.slice(-3500)');
      if(!result.passed){
        result.diagnostic=await c.eval(`({hidden:document.hidden,focus:document.hasFocus(),samples:window.feedbackSamples,
          sessions:[...sessions.values()].map(s=>({id:s.id,runtime:s.nativeRuntime,feedback:s.nativeFeedback}))})`);
        await shot('failed');
      }
      await c.close();}catch(e){result.captureError=e.message;}}
    if(hub){fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));result.exit=await gracefulQuit(hub);}
    fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));
    console.log(JSON.stringify({out,passed:result.passed,providers:result.providers.map(p=>({kind:p.kind,p95:p.p95,max:p.max,parseCount:p.parseCount})),exit:result.exit}));
  }
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
