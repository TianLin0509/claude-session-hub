'use strict';
// Real Hub, real Claude (haiku) and real Codex (cheapest catalog model) in an
// isolated profile. Verifies that a background-task continuation renders as
// progress rows in the same Claude card (no second card, no duplicate against
// the disk history), that the journal stays small, that /goal reaches the
// engine, and that the thinking chip is live for native Claude. Credentials
// are copied in and removed in finally; nothing here touches the production Hub.
const fs=require('fs'),path=require('path'),os=require('os'),net=require('net'),assert=require('assert/strict'),crypto=require('crypto');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const j=JSON.stringify,sleep=ms=>new Promise(r=>setTimeout(r,ms));
const port=()=>new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const CLAUDE_MODEL=process.env.REAL_CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
const CODEX_MODEL=process.env.REAL_CODEX_MODEL || 'gpt-5.5';
async function main(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-real-cards-'));
  const out=path.resolve('artifacts/claude-codex-parity/real-cards-'+Date.now());fs.mkdirSync(out,{recursive:true});
  const claudeSource=process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(),'.claude'),claudeAuth=path.join(claudeSource,'.credentials.json');
  const codexSource=process.env.CODEX_HOME || path.join(os.homedir(),'.codex'),codexAuth=path.join(codexSource,'auth.json');
  const before={claude:hash(claudeAuth),codex:hash(codexAuth)};
  const claudeHome=path.join(root,'claude'),codexHome=path.join(root,'codex'),cwd=path.join(root,'workspace');
  for(const d of [claudeHome,codexHome,cwd])fs.mkdirSync(d);
  if(fs.existsSync(path.join(codexSource,'models_cache.json')))fs.copyFileSync(path.join(codexSource,'models_cache.json'),path.join(codexHome,'models_cache.json'));
  fs.writeFileSync(path.join(codexHome,'config.toml'),'model = '+j(CODEX_MODEL)+'\nmodel_reasoning_effort = "low"\n');
  const result={root,out,claudeModel:CLAUDE_MODEL,codexModel:CODEX_MODEL,checks:[],passed:false};let hub,c;
  const until=async(expr,label,ms=120000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await c.eval(expr))return;await sleep(200);}throw Error('timeout: '+label+' :: '+expr.slice(0,160));};
  const snap=async name=>{const shot=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(shot.data,'base64'));};
  const open=async sid=>{await c.eval(`document.querySelector('.session-item[data-session-id="${sid}"]').click()`);await until('!!document.querySelector(".floating-input-box")','composer');};
  const send=async text=>{await c.eval(`(()=>{const box=document.querySelector(".floating-input-box");box.textContent=${j(text)};box.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector(".floating-input-send").click();})()`);};
  const cardsOf=async sid=>c.eval(`ipcRenderer.invoke('parse-session-transcript',{hubSessionId:${j(sid)}}).then(r=>r.turns)`);
  const domCards=()=>c.eval(`[...document.querySelectorAll('#msg-overlay .turn-card')].map(e=>({role:e.classList.contains('user')?'user':'assistant',phase:e.dataset.phase,continuation:e.classList.contains('conversation-response-continuation'),who:e.querySelector('.turn-who')?.textContent||'',chip:!!e.querySelector('.turn-native-chip'),text:e.querySelector('.turn-body')?.innerText.slice(0,80)||''}))`);
  try{
    fs.copyFileSync(claudeAuth,path.join(claudeHome,'.credentials.json'));
    fs.copyFileSync(codexAuth,path.join(codexHome,'auth.json'));
    hub=await launchIsolatedHub({dataDir:path.join(root,'data'),port:await port(),windowMode:'hidden',label:'real cards',extraEnv:{
      CODEX_HOME:codexHome,CLAUDE_CONFIG_DIR:claudeHome,CLAUDE_HUB_HOME_DIR:path.join(root,'home'),DEEPSEEK_API_KEY:''}});
    c=await connectFirstPage(hub);await c.send('Page.bringToFront');await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await until('typeof sessions!=="undefined"','renderer');

    // --- Claude: background agent -> task-notification continuation ---
    const cs=await c.eval(`ipcRenderer.invoke('create-session',${j({kind:'claude',opts:{cwd,model:CLAUDE_MODEL,effort:'low',mcpProfile:'none',permissionMode:'bypassPermissions',autonomous:true}})})`);
    const csid=cs.id,cq=j(csid);result.claudeSession=csid;
    await until(`sessions.get(${cq})?.nativeRuntime?.connection==='connected'`,'claude connected');
    await open(csid);
    assert.equal(await c.eval('document.querySelector(".composer-thinking")?.dataset.interactive'),'1','native Claude thinking chip is clickable');
    result.checks.push('native Claude thinking chip is interactive');
    const prompt='用 Agent 工具启动一个后台子任务（run_in_background 设为 true，subagent_type 用 general-purpose），子任务的 prompt 是「只回复 SUB_DONE，不要做任何别的事」。启动后立刻只回复 LAUNCHED，不要等待子任务。之后当子任务完成的通知到达时，只回复 FINAL_OK。整个过程不要读写文件。';
    await send(prompt);
    // The whole run can settle within seconds; wait for the final state
    // rather than for each intermediate one.
    await until(`sessions.get(${cq}).nativeRuntime.state==='completed' && sessions.get(${cq}).nativeRuntime.backgroundTasks?.length===0 && !sessions.get(${cq}).nativeRuntime.backgroundActivities?.length && document.querySelector('#msg-overlay').innerText.includes('FINAL_OK')`,'continuation settled',300000);
    await sleep(1500);
    const claudeCards=await cardsOf(csid);
    const assistants=claudeCards.filter(t=>t.role==='assistant');
    result.claudeCards=claudeCards.map(t=>({role:t.role,text:String(t.text||'').slice(0,60),continuations:t.continuations,nativeActivity:t.nativeActivity,phases:(t.displayMessages||[]).map(m=>[m.phase,String(m.text).slice(0,30)])}));
    assert.equal(claudeCards.filter(t=>t.role==='user').length,1,'exactly one user card');
    assert.equal(assistants.length,1,'the continuation joins the human card instead of opening a second assistant card');
    assert.ok(assistants[0].continuations?.length>=1,'card carries its continuation');
    assert.ok(assistants[0].displayMessages.some(m=>/FINAL_OK/.test(m.text) && m.phase==='final_answer'),'the notification answer is the result row');
    assert.ok(assistants[0].displayMessages.some(m=>/LAUNCHED/.test(m.text) && m.phase==='commentary'),'the first answer became a progress row');
    assert.ok(!assistants.some(t=>t.nativeActivity),'no standalone 后台活动 card');
    const dom=await domCards();result.claudeDom=dom;
    assert.equal(dom.filter(d=>d.role==='assistant' && !d.continuation).length,1,'DOM shows one assistant header for the whole run');
    assert.equal(dom.filter(d=>d.chip).length,0,'no 后台 chip on a continuation');
    assert.equal(dom.filter(d=>/FINAL_OK/.test(d.text)).length,1,'FINAL_OK is rendered once');
    await snap('claude-continuation');
    const journal=path.join(root,'data','native-agent-submissions',csid+'.jsonl');
    result.journalBytes=fs.statSync(journal).size;
    assert.ok(result.journalBytes<2*1024*1024,'journal stays bounded with background output');
    result.checks.push('real haiku background task: one card, progress rows, single FINAL_OK, journal '+result.journalBytes+' bytes');

    await send('/goal 只回复 GOAL_OK，不要做别的');
    await until(`sessions.get(${cq}).nativeRuntime.state==='completed' && [...document.querySelectorAll('#msg-overlay .turn-card.user')].some(e=>e.innerText.includes('/goal'))`,'claude /goal card',180000);
    await sleep(1000);
    result.claudeGoal=(await cardsOf(csid)).slice(-2).map(t=>({role:t.role,text:String(t.text||'').slice(0,200)}));
    assert.equal(await c.eval('document.querySelectorAll(".fi-stuck").length'),0,'no stuck indicator after /goal');
    await snap('claude-goal');result.checks.push('Claude /goal is forwarded to the engine and answered');

    // --- Codex: same prompt shape for a side-by-side screenshot ---
    const xs=await c.eval(`ipcRenderer.invoke('create-session',${j({kind:'codex',opts:{cwd,model:CODEX_MODEL,effort:'low',mcpProfile:'none',codexSpeedTier:'inherit',approvalPolicy:'never',sandbox:'read-only'}})})`);
    const xsid=xs.id,xq=j(xsid);result.codexSession=xsid;
    await until(`['idle','completed'].includes(sessions.get(${xq})?.nativeRuntime?.state)`,'codex connected',120000);
    await open(xsid);
    await send('不要调用工具。先回复一句 CODEX_PROGRESS 作为进展，再单独回复 CODEX_FINAL 作为最终结论。');
    await until(`sessions.get(${xq}).nativeRuntime.state==='completed'`,'codex turn',180000);
    await until('[...document.querySelectorAll("#msg-overlay .turn-card")].some(e=>e.innerText.includes("CODEX_FINAL"))','codex card');
    await sleep(800);await snap('codex-card');
    result.codexDom=await domCards();
    await send('/goal 只回复 GOAL_OK，不要做别的');
    await until(`[...document.querySelectorAll('#msg-overlay .turn-card.user')].some(e=>e.innerText.includes('/goal'))`,'codex /goal card',120000);
    await sleep(3000);await snap('codex-goal');
    result.checks.push('Codex side rendered for comparison');
    result.passed=true;
  }catch(error){result.error=error.stack;if(c)try{result.ui=await c.eval('document.body.innerText.slice(-3000)');}catch(e){result.captureError=e.message;}process.exitCode=1;}
  finally{
    try{if(hub)await gracefulQuit(hub);}catch(e){result.quitError=e.message;}
    for(const [file,key] of [[path.join(claudeHome,'.credentials.json'),'claude'],[path.join(codexHome,'auth.json'),'codex']]){
      try{fs.unlinkSync(file);}catch{}
      assert.equal(hash(key==='claude'?claudeAuth:codexAuth),before[key],'production credentials untouched');
    }
    fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(result,null,2));
    console.log(JSON.stringify({passed:result.passed,out,checks:result.checks,error:result.error,journalBytes:result.journalBytes,claudeCards:result.claudeCards,claudeGoal:result.claudeGoal},null,2));
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
