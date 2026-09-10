'use strict';
// Real Hub, real Codex, isolated test directories. Existing model/effort/tier
// are copied, credentials are removed in finally and never included in evidence.
const fs=require('fs'),path=require('path'),os=require('os'),net=require('net'),assert=require('assert/strict'),crypto=require('crypto');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const port=()=>new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
async function main(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-native-real-gui-'));
  const out=path.resolve('artifacts/codex-native-runtime/real-gui-'+Date.now());fs.mkdirSync(out,{recursive:true});
  const source=process.env.CODEX_HOME || path.join(os.homedir(),'.codex');
  const sourceConfig=path.join(source,'config.toml'),sourceAuth=path.join(source,'auth.json');
  const before={config:hash(sourceConfig),auth:hash(sourceAuth)};
  const config=fs.readFileSync(sourceConfig,'utf8');const read=k=>config.match(new RegExp('^'+k+'\\s*=\\s*"([^"]+)"','m'))?.[1];
  const model=read('model'),effort=read('model_reasoning_effort'),tier=read('service_tier');assert(model&&effort);
  const home=path.join(root,'codex'),cwd=path.join(root,'workspace');fs.mkdirSync(home);fs.mkdirSync(cwd);
  fs.copyFileSync(sourceAuth,path.join(home,'auth.json'));
  if(fs.existsSync(path.join(source,'models_cache.json')))fs.copyFileSync(path.join(source,'models_cache.json'),path.join(home,'models_cache.json'));
  fs.writeFileSync(path.join(home,'config.toml'),'model = '+JSON.stringify(model)+'\nmodel_reasoning_effort = '+JSON.stringify(effort)+'\n'+(tier?'service_tier = '+JSON.stringify(tier)+'\n':''));
  const result={root,out,model,effort,tier,before,checks:[],passed:false};let hub,cdp;
  const until=async(expr,label,ms=90000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await cdp.eval(expr))return;if(result.sessionId){const r=await cdp.eval('sessions.get('+JSON.stringify(result.sessionId)+')?.nativeRuntime');if(r?.connection==='disconnected')throw Error(r.reason);}await sleep(150);}throw Error('timeout: '+label);};
  const snap=async name=>{const shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(shot.data,'base64'));};
  try{
    hub=await launchIsolatedHub({dataDir:path.join(root,'data'),port:await port(),label:'native-real',extraEnv:{CODEX_HOME:home,CLAUDE_CONFIG_DIR:path.join(root,'claude')}});
    result.pid=hub.pid;cdp=await connectFirstPage(hub);
    await until('typeof sessions!=="undefined"','renderer');
    const s=await cdp.eval('ipcRenderer.invoke("create-session",'+JSON.stringify({kind:'codex',opts:{cwd,model,effort,mcpProfile:'none',codexSpeedTier:'inherit',approvalPolicy:'on-request',sandbox:'read-only'}})+')');
    result.sessionId=s.id;const sid=JSON.stringify(s.id);
    await until('sessions.get('+sid+')?.nativeRuntime?.state==="idle"','real native connected');
    assert.equal(await cdp.eval('sessions.get('+sid+').effort'),effort);
    await cdp.eval('document.querySelector(\'.session-item[data-session-id="'+s.id+'"]\').click()');
    await until('document.querySelector(".floating-input-box")','composer');
    async function send(text){
      await cdp.eval('(()=>{const box=document.querySelector(".floating-input-box");box.textContent='+JSON.stringify(text)+';box.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector(".floating-input-send").click();})()');
    }
    await send('这是真实 AI Hub 隔离 GUI 验收。不要调用工具，只回复 GUI_NATIVE_OK。');
    await until('sessions.get('+sid+').nativeRuntime.state==="completed"','real GUI complete');
    await cdp.eval('document.querySelector(\'[data-view="card"]\').click()');
    await until('[...document.querySelectorAll(".turn-card .turn-body")].some(e=>e.innerText.includes("GUI_NATIVE_OK"))','real answer card');
    assert.equal(await cdp.eval('document.querySelectorAll(".fi-stuck").length'),0);
    await snap('real-answer');result.checks.push('real model GUI composer -> native receipt -> answer card');
    // This command is intentionally approval-gated. The test clicks decline;
    // no broader permission is granted and no command is executed.
    await send('这是隔离环境的审批界面验收。请用 exec_command 发起一次 sandbox_permissions="require_escalated" 的命令请求，cmd 为 Write-Output APPROVAL_TEST，justification 为“隔离审批界面测试”。不要自行执行其他命令，也不要规避拒绝。如果被拒绝，只回复 APPROVAL_DECLINED。');
    await until('sessions.get('+sid+').nativeRuntime.requests.some(r=>r.method==="item/commandExecution/requestApproval")','real approval');
    await until('document.querySelector(".codex-native-request")','real approval form');
    await until('document.querySelectorAll(".turn-card.user[data-optimistic=true]").length===0','real native card replaced its optimistic placeholder');
    result.approval=await cdp.eval('sessions.get('+sid+').nativeRuntime.requests.map(r=>({method:r.method,params:r.params}))');
    await snap('real-approval');
    await cdp.eval('[...document.querySelectorAll(".codex-native-request button")].find(b=>b.textContent==="拒绝").click()');
    await until('sessions.get('+sid+').nativeRuntime.state==="completed"','decline resolved');
    result.checks.push('real command approval form and explicit decline resolve through native request id');
    await snap('real-declined');
    const prior=await cdp.eval('sessions.get('+sid+').nativeRuntime.turnId');
    await send('请保持一次较长的思考，用五个步骤解释为什么所有 GUI 应读取同一执行状态。不要调用工具。');
    await until('sessions.get('+sid+').nativeRuntime.state==="running" && sessions.get('+sid+').nativeRuntime.turnId!=='+JSON.stringify(prior),'real active turn');
    await cdp.eval('document.querySelector(".floating-input-stop").click()');
    await until('sessions.get('+sid+').nativeRuntime.state==="interrupted"','real native interrupted');
    await until('!document.querySelector(".streaming-indicator")','no generation pill after native interrupt',2000);
    await snap('real-interrupted');result.checks.push('real stop button waits for interrupted outcome');
    // Explicit UI configuration round-trip; no inference runs at the temporary
    // setting. The source account config must remain byte-for-byte unchanged.
    for(const selected of ['max',effort]){
      await cdp.eval('document.querySelector(".composer-thinking").click()');
      await until('document.querySelector('+JSON.stringify('.model-picker-item[data-effort="'+selected+'"]')+')','effort choice');
      await cdp.eval('document.querySelector('+JSON.stringify('.model-picker-item[data-effort="'+selected+'"]')+').click()');
      await until('sessions.get('+sid+').effort==='+JSON.stringify(selected)+' && !sessions.get('+sid+')._modelSwitchPending','native effort confirmed');
      await until('!document.querySelector(".model-picker-menu")','picker closed');
    }
    assert.equal(await cdp.eval('sessions.get('+sid+').nativeRuntime.configurationError'),null);
    await snap('real-effort-restored');result.checks.push('real effort chip configures native model settings and restores the original effort without inference');
    result.passed=true;
  }finally{
    if(cdp){try{result.sessions=await cdp.eval('[...sessions.values()]');await snap('final');}catch(error){result.captureError=error.message;}await cdp.close();}
    if(hub){fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));result.exit=await gracefulQuit(hub);}
    fs.rmSync(path.join(home,'auth.json'),{force:true});
    result.originalUnchanged=hash(sourceConfig)===before.config && hash(sourceAuth)===before.auth;
    fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));
    console.log(JSON.stringify({out,checks:result.checks,passed:result.passed,originalUnchanged:result.originalUnchanged,exit:result.exit}));
    assert(result.originalUnchanged,'source authentication/config must stay unchanged');
  }
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
