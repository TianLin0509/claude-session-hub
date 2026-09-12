'use strict';
// Real Hub, real Codex, isolated test directories. Existing model/effort/tier
// are copied, credentials are removed in finally and never included in evidence.
const fs=require('fs'),path=require('path'),os=require('os'),net=require('net'),assert=require('assert/strict'),crypto=require('crypto');
const {execFileSync}=require('node:child_process');
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
  if(fs.existsSync(path.join(source,'models_cache.json')))fs.copyFileSync(path.join(source,'models_cache.json'),path.join(home,'models_cache.json'));
  fs.writeFileSync(path.join(home,'config.toml'),'model = '+JSON.stringify(model)+'\nmodel_reasoning_effort = '+JSON.stringify(effort)+'\n'+(tier?'service_tier = '+JSON.stringify(tier)+'\n':''));
  const result={root,out,head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),model,effort,tier,before,checks:[],passed:false};let hub,cdp;
  const launch=async()=>launchIsolatedHub({dataDir:path.join(root,'data'),port:await port(),windowMode:'hidden',label:'native-real',extraEnv:{CODEX_HOME:home,CLAUDE_CONFIG_DIR:path.join(root,'claude'),CLAUDE_HUB_HOME_DIR:path.join(root,'home'),DEEPSEEK_API_KEY:''}});
  const until=async(expr,label,ms=90000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await cdp.eval(expr))return;if(result.sessionId){const r=await cdp.eval('sessions.get('+JSON.stringify(result.sessionId)+')?.nativeRuntime');if(r?.connection==='disconnected')throw Error(r.reason);}await sleep(150);}throw Error('timeout: '+label);};
  const snap=async name=>{const shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(shot.data,'base64'));};
  try{
    fs.copyFileSync(sourceAuth,path.join(home,'auth.json'));
    hub=await launch();
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
    await until('currentView === "card"','default native conversation view');
    await until('[...document.querySelectorAll(".turn-card .turn-body")].some(e=>e.innerText.includes("GUI_NATIVE_OK"))','real answer card');
    assert.equal(await cdp.eval('document.querySelectorAll(".fi-stuck").length'),0);
    await snap('real-answer');result.checks.push('real model GUI composer -> native receipt -> answer card');
    if(process.argv.includes('--extended')){
      const nonce='NATIVE_READ_'+crypto.randomUUID();
      fs.writeFileSync(path.join(cwd,'native-verification.txt'),nonce,'utf8');
      const longPrompt='GUI_LONG_NATIVE: 请用 exec_command 只读当前工作目录 native-verification.txt（PowerShell Get-Content -LiteralPath ./native-verification.txt），不要申请提权、不要修改任何文件。回复文件原文。以下 600 行是完整性样本，无需分析或复述。\n'
        +Array.from({length:600},(_,i)=>`${i+1}. 中文 — 编号 ${i+1} 🧪 "literal"`).join('\n')+'\nGUI_LONG_END';
      const prior=await cdp.eval(`sessions.get(${sid}).nativeRuntime.turnId`);
      await send(longPrompt);
      await until(`sessions.get(${sid}).nativeRuntime.state==='completed' && sessions.get(${sid}).nativeRuntime.turnId!==${JSON.stringify(prior)}`,'real long prompt and read-only tool',180000);
      const parsed=await cdp.eval(`ipcRenderer.invoke('parse-session-transcript',{hubSessionId:${sid}})`);
      assert.equal(parsed.turns.filter(t=>t.role==='user' && t.text===longPrompt).length,1,'native history contains exactly the full original 600-line message');
      const toolTurn=parsed.turns.find(t=>t.role==='assistant' && t.text.includes(nonce));
      assert.ok(toolTurn,'random file content must be returned');
      assert.ok(toolTurn.toolCalls.some(t=>t.name==='commandExecution' && t.input?.exitCode===0 && String(t.output).includes(nonce)),'native command item confirms actual successful read');
      result.longTool={turnId:await cdp.eval(`sessions.get(${sid}).nativeRuntime.turnId`),inputSha256:crypto.createHash('sha256').update(longPrompt).digest('hex'),inputBytes:Buffer.byteLength(longPrompt),toolTurn};
      await snap('real-long-tool');result.checks.push('real 600-line GUI submission is exact in native history; successful native tool item reads an unpredictable isolated file');
    }
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
    if(process.argv.includes('--extended')){
      const priorCards=await cdp.eval(`ipcRenderer.invoke('parse-session-transcript',{hubSessionId:${sid}})`);
      const priorRuntime=await cdp.eval(`sessions.get(${sid}).nativeRuntime`);
      await cdp.eval(`(()=>{const b=document.querySelector('.floating-input-box');replaceContenteditableText(b,'真实恢复保留草稿 — 🧪');b.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await until('document.querySelector(".floating-input-box").dataset.draftState==="saved"','real durable draft');
      const draft=await cdp.eval(`ipcRenderer.invoke('native-draft:read',{sessionId:${sid}})`);
      await cdp.close();cdp=null;result.restartExit=await gracefulQuit(hub);hub=null;
      hub=await launch();cdp=await connectFirstPage(hub);
      // Initial persisted disconnected metadata is expected before this explicit select/resume.
      const savedSessionId=result.sessionId;result.sessionId=null;
      await until(`typeof sessions!=='undefined' && sessions.has(${sid})`,'real persisted session');
      await cdp.eval(`selectSession(${sid})`);
      await until(`sessions.get(${sid}).nativeRuntime.connection==='connected'`,'real native resume');
      result.sessionId=savedSessionId;
      assert.equal(await cdp.eval(`sessions.get(${sid}).nativeRuntime.threadId`),priorRuntime.threadId);
      assert.equal(await cdp.eval(`sessions.get(${sid}).nativeRuntime.turnId`),priorRuntime.turnId);
      const cards=await cdp.eval(`ipcRenderer.invoke('parse-session-transcript',{hubSessionId:${sid}})`);
      assert.deepEqual(cards.turns.map(t=>[t.id,t.role,t.text]),priorCards.turns.map(t=>[t.id,t.role,t.text]));
      await until('readContenteditablePlainText(document.querySelector(".floating-input-box"))==="真实恢复保留草稿 — 🧪"','real restored draft');
      assert.deepEqual(await cdp.eval(`ipcRenderer.invoke('native-draft:read',{sessionId:${sid}})`),draft);
      await snap('real-restarted');
      await send('仅回复 GUI_RESUME_OK，不要调用工具。');
      await until(`sessions.get(${sid}).nativeRuntime.state==='completed' && sessions.get(${sid}).nativeRuntime.turnId!==${JSON.stringify(priorRuntime.turnId)}`,'real follow-up after resume');
      assert.ok((await cdp.eval(`ipcRenderer.invoke('parse-session-transcript',{hubSessionId:${sid}})`)).turns.some(t=>t.role==='assistant' && t.text.includes('GUI_RESUME_OK')));
      await snap('real-resume-followup');result.checks.push('real Hub restart preserves exact thread/history/draft revision without replay; subsequent real model turn completes');
      const questionPrior=await cdp.eval(`sessions.get(${sid}).nativeRuntime.turnId`);
      await send('/plan');
      await until(`sessions.get(${sid}).nativeRuntime.collaborationMode==='plan'`,'real supported plan mode');
      await until('document.querySelector(".codex-native-mode")','visible plan mode');
      assert.equal(await cdp.eval('document.querySelectorAll(".turn-card.user[data-optimistic=true]").length'),0,'native command is not a model message');
      await send('这是原生提问界面的隔离验收。请使用 request_user_input 工具提问“选择哪个验收标记？”，两个选项为 NATIVE_A 与 NATIVE_B。收到工具返回的选择后，只回复该标记。不要调用命令、不要读取文件、不要改动任何配置。');
      await until(`sessions.get(${sid}).nativeRuntime.requests.some(r=>r.method==='item/tool/requestUserInput')`,'real native question',120000);
      await until('document.querySelector(".codex-native-request textarea")','real question form');
      result.question=await cdp.eval(`sessions.get(${sid}).nativeRuntime.requests.filter(r=>r.method==='item/tool/requestUserInput').map(r=>({method:r.method,params:r.params}))`);
      await snap('real-question');
      await cdp.eval(`(()=>{const form=[...document.querySelectorAll('.codex-native-request')].find(f=>f.querySelector('textarea'));form.querySelector('textarea').value='NATIVE_A';form.querySelector('button[type=submit]').click();})()`);
      await until(`sessions.get(${sid}).nativeRuntime.state==='completed' && sessions.get(${sid}).nativeRuntime.turnId!==${JSON.stringify(questionPrior)}`,'real answer after question');
      assert.ok((await cdp.eval(`ipcRenderer.invoke('parse-session-transcript',{hubSessionId:${sid}})`)).turns.some(t=>t.role==='assistant' && t.text.includes('NATIVE_A')));
      await snap('real-question-answered');result.checks.push('real model emits a native user question and consumes the actual Hub form answer');
      await cdp.eval('document.querySelector(".codex-native-mode button").click()');
      await until(`sessions.get(${sid}).nativeRuntime.collaborationMode==='default' && !document.querySelector('.codex-native-mode')`,'restore default mode');
    }
    result.passed=true;
  }finally{
    const cleanupErrors=[];
    if(cdp){try{result.sessions=await cdp.eval('[...sessions.values()]');await snap('final');}catch(error){result.captureError=error.message;result.passed=false;}
      try{await cdp.close();}catch(error){cleanupErrors.push(error.message);}}
    if(hub){try{fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));result.exit=await gracefulQuit(hub);}
      catch(error){cleanupErrors.push(error.message);result.termination=error.termination;}}
    try{fs.rmSync(path.join(home,'auth.json'),{force:true});}catch(error){cleanupErrors.push('remove isolated auth copy: '+error.message);}
    result.cleanupErrors=cleanupErrors;if(cleanupErrors.length)result.passed=false;
    result.originalUnchanged=hash(sourceConfig)===before.config && hash(sourceAuth)===before.auth;
    if(!result.originalUnchanged)result.passed=false;
    fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));
    console.log(JSON.stringify({out,checks:result.checks,passed:result.passed,originalUnchanged:result.originalUnchanged,exit:result.exit}));
    assert(result.originalUnchanged,'source authentication/config must stay unchanged');
    assert.equal(cleanupErrors.length,0,cleanupErrors.join('; '));
  }
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
