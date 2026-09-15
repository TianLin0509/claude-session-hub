'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const j=JSON.stringify,root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-quiet-recovery-'));
const out=path.resolve('artifacts/quiet-recovery/'+Date.now());fs.mkdirSync(out,{recursive:true});
const report={out,passed:false,checks:[]};let hub,c;
const until=async(label,check)=>{const end=Date.now()+30000;while(!await check()){if(Date.now()>end)throw Error('timeout '+label);await new Promise(r=>setTimeout(r,80));}};
(async()=>{
  const port=await new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
  const data=path.join(root,'data'),trace=path.join(root,'trace.jsonl');fs.mkdirSync(data);
  fs.writeFileSync(path.join(data,'prepared-projects.json'),j({schemaVersion:1,projects:[],migrations:[]}));
  try{
    hub=await launchIsolatedHub({dataDir:data,port,windowMode:'hidden',label:'quiet-recovery',extraEnv:{
      CLAUDE_HUB_E2E:'1',CODEX_HOME:path.join(root,'codex'),CLAUDE_CONFIG_DIR:path.join(root,'claude'),
      CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.resolve('tests/fixtures/codex-app-server.js'),
      CLAUDE_HUB_NATIVE_FIXTURE_STORE:path.join(root,'threads.json'),CLAUDE_HUB_NATIVE_FIXTURE_TRACE:trace}});
    c=await connectFirstPage(hub);await until('renderer',()=>c.eval('!!window.__hubE2E && !!window.WorkspaceController'));
    await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    const created=await c.eval(`window.WorkspaceController.createSession('codex',{cwd:${j(root)},opts:{model:'gpt-5.4',mcpProfile:'none'}}).then(s=>({id:s.id}))`);
    const sid=created.id;report.sessionId=sid;
    await c.eval(`window.__hubE2E.selectSession(${j(sid)},{forceScrollBottom:true})`);
    const runtime=()=>c.eval(`sessions.get(${j(sid)}).nativeRuntime`);
    await until('ready',async()=>(await runtime()).connection==='connected');
    const send=async text=>{await c.eval('document.querySelector(".floating-input-box").focus()');await c.send('Input.insertText',{text});
      for(const type of ['keyDown','keyUp'])await c.send('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13});};
    await send('fixture:crash-before first');
    await until('native disconnect',async()=>(await runtime()).connection==='disconnected');
    const before=await runtime();report.oldSubmission=before.submission;
    assert.equal(await c.eval('!!document.querySelector(".fi-stuck")'),false);
    assert.equal(await c.eval('!!document.querySelector(".codex-command-feedback:not([hidden])")'),false);
    assert.equal(await c.eval('document.body.innerText.includes("我已核对") || document.body.innerText.includes("核对原生记录")'),false);
    report.checks.push('native disconnect renders no manual receipt-review panel or duplicate composer warning');
    await send('continue with new request');
    await until('new task complete',async()=>{const r=await runtime();return r.state==='completed' && r.submission?.id!==before.submission?.id;});
    const calls=fs.readFileSync(trace,'utf8').trim().split('\n').map(JSON.parse);
    const starts=calls.filter(r=>r.method==='turn/start');assert.equal(starts.length,2);
    assert.deepEqual(starts.map(r=>r.params.input.filter(b=>b.type==='text').map(b=>b.text).join('')),['fixture:crash-before first','continue with new request']);
    assert.equal(new Set(starts.map(r=>r.params.threadId)).size,1);
    assert.ok(calls.some(r=>r.method==='thread/resume'));
    report.checks.push('Enter recovers the same thread and sends the new prompt exactly once; old prompt is not replayed');
    await until('answer card',()=>c.eval('document.querySelector(".msg-overlay")?.innerText.includes("原生回答")'));
    assert.equal(await c.eval('document.activeElement===document.querySelector(".floating-input-box")'),true);
    const shot=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'recovered.png'),Buffer.from(shot.data,'base64'));
    report.checks.push('new answer is visible and composer keeps focus');report.passed=true;
  }catch(error){report.error=error.stack;throw error;}
  finally{if(c)await c.close();if(hub){fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));report.exit=await gracefulQuit(hub);}fs.writeFileSync(path.join(out,'result.json'),j(report));console.log(j(report));}
})().catch(error=>{console.error(error);process.exitCode=1;});
