'use strict';
const fs=require('fs'), path=require('path'), os=require('os'), net=require('net'), assert=require('assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const port=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
async function until(label,read,timeout=25000){const end=Date.now()+timeout;while(Date.now()<end){const v=await read();if(v)return v;await delay(100);}throw Error('Timeout: '+label);}
async function click(c,selector){
  const r=await c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await c.send('Input.dispatchMouseEvent',{type:'mousePressed',...r,button:'left',clickCount:1});
  await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',...r,button:'left',clickCount:1});
}
async function main(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-session-exclusive-'));
  const out=path.resolve('artifacts/session-exclusive/'+Date.now());fs.mkdirSync(out,{recursive:true});
  const dataDir=path.join(root,'data'),workspace=path.join(root,'workspace');fs.mkdirSync(workspace);
  const env={CLAUDE_HUB_E2E:'1',CODEX_HOME:path.join(root,'codex'),CLAUDE_CONFIG_DIR:path.join(root,'claude'),
    CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.resolve('tests/fixtures/codex-app-server.js'),
    CLAUDE_HUB_CLAUDE_STREAM_FIXTURE:path.resolve('tests/fixtures/claude-stream.js'),
    CLAUDE_HUB_CLAUDE_FIXTURE_MODE:'normal',CLAUDE_HUB_FIXTURE_CONFIG_DIR:path.join(root,'launch-config'),
    CLAUDE_HUB_NATIVE_FIXTURE_STORE:path.join(root,'threads.json'),CLAUDE_HUB_NATIVE_FIXTURE_TRACE:path.join(root,'trace.jsonl'),
    CLAUDE_HUB_NATIVE_FIXTURE_WRITER_DIR:path.join(root,'writers'),
    // Old environment settings cannot re-enable cross-Hub sharing.
    CLAUDE_HUB_CODEX_SHARED_RUNTIME:'1',CLAUDE_HUB_CLAUDE_SHARED_RUNTIME:'1'};
  const hubs=[], clients=[], checks=[], ids={}, before={};
  async function launch(label){const hub=await launchIsolatedHub({dataDir,port:await port(),label,extraEnv:env,windowMode:'hidden'});hubs.push(hub);const c=await connectFirstPage(hub);clients.push(c);await until(label+' ready',()=>c.eval('typeof sessions!=="undefined"'));return {hub,c};}
  async function shot(c,name){const shot=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(shot.data,'base64'));}
  let passed=false;
  try {
    const a=await launch('exclusive-a');
    for(const kind of ['codex','claude']) {
      const s=await a.c.eval(`ipcRenderer.invoke('create-session',${JSON.stringify({kind,opts:{cwd:workspace,mcpProfile:'none',...(kind==='codex'?{model:'gpt-6-astra',effort:'xhigh'}:{})}})})`);
      ids[kind]=s.id;const key=JSON.stringify(s.id);
      const inputBar=`.floating-input-bar[data-session-id="${s.id}"]`;
      await until(kind+' native ready',()=>a.c.eval(`sessions.get(${key})?.nativeRuntime?.connection==='connected'`));
      await until(kind+' row',()=>a.c.eval(`!!document.querySelector('.session-item[data-session-id="${s.id}"]')`));
      await click(a.c,`.session-item[data-session-id="${s.id}"]`);
      await until(kind+' active input',()=>a.c.eval(`activeSessionId===${key} && !!document.querySelector(${JSON.stringify(inputBar+' .floating-input-box')})`));
      await click(a.c,inputBar+' .floating-input-box');await a.c.send('Input.insertText',{text:'独占恢复验收 '+kind});
      await click(a.c,inputBar+' .floating-input-send');
      await until(kind+' completed',()=>a.c.eval(`sessions.get(${key})?.nativeRuntime?.state==='completed'`));
      before[kind]=await a.c.eval(`sessions.get(${key})`);
      await click(a.c,inputBar+' .floating-input-box');await a.c.send('Input.insertText',{text:'未发送草稿 '+kind});
      await until(kind+' draft persisted',()=>a.c.eval(`ipcRenderer.invoke('native-draft:read',{sessionId:${key}}).then(r=>r.record?.text==='未发送草稿 ${kind}')`));
      await until(kind+' metadata persisted',()=>Promise.resolve(fs.existsSync(path.join(dataDir,'sessions',s.id+'.json'))));
    }
    const b=await launch('exclusive-b');
    for(const kind of ['codex','claude']) {
      const id=ids[kind];await until(kind+' restored row',()=>b.c.eval(`sessions.has(${JSON.stringify(id)})`));
      await click(b.c,`.session-item[data-session-id="${id}"]`);
      await until(kind+' occupied dialog',()=>b.c.eval(`document.querySelector('dialog[open]')?.textContent.includes('PID ${a.hub.pid}')`));
      assert.equal(await b.c.eval(`sessions.get(${JSON.stringify(id)}).status`),'dormant');
      assert.equal(await b.c.eval(`ipcRenderer.invoke('get-sessions').then(rows=>rows.some(s=>s.id===${JSON.stringify(id)} && s.status!=='dormant'))`),false);
      await shot(b.c,kind+'-occupied');await click(b.c,'dialog[open] .hub-dialog-actions button:last-child');
    }
    checks.push('real clicks show owning Hub PID and reject both providers before opening');
    const neighbour=await a.c.eval(`ipcRenderer.invoke('create-session',{kind:'codex',opts:{cwd:${JSON.stringify(workspace)},model:'gpt-6-astra',effort:'xhigh',mcpProfile:'none'}})`);
    await until('same-scope neighbour ready',()=>a.c.eval(`sessions.get(${JSON.stringify(neighbour.id)})?.nativeRuntime?.connection==='connected'`));
    const other=await b.c.eval(`ipcRenderer.invoke('create-session',{kind:'codex',opts:{cwd:${JSON.stringify(workspace)},model:'gpt-6-astra',mcpProfile:'none'}})`);
    assert(other.id);checks.push('different sessions remain usable in another Hub');
    for (const kind of ['codex','claude']) {
      const id=ids[kind],key=JSON.stringify(id);
      await click(a.c,`.session-item[data-session-id="${id}"]`);
      await until(kind+' selected for sleep',()=>a.c.eval(`activeSessionId===${key} && !!document.querySelector('.btn-close-session')`));
      await click(a.c,'.btn-close-session');
      await until(kind+' released while Hub A stays alive',()=>a.c.eval(`sessions.get(${key})?.status==='dormant'`));
      assert.equal(await a.c.eval(`sessions.get(${JSON.stringify(neighbour.id)})?.nativeRuntime?.connection`),'connected');
      if(kind==='codex'){
        const oldWriter=JSON.parse(fs.readFileSync(path.join(root,'writers',before.codex.codexSid+'.json'),'utf8')).pid;
        assert.throws(()=>process.kill(oldWriter,0),/ESRCH|no such process/,'old native writer must have exited before sleep completes');
      }
      await click(b.c,`.session-item[data-session-id="${id}"]`);
      await until(kind+' resumes while previous Hub still alive',()=>b.c.eval(`sessions.get(${key})?.nativeRuntime?.connection==='connected'`));
      const resumed=await b.c.eval(`sessions.get(${key})`);
      assert.equal(kind==='codex'?resumed.codexSid:resumed.ccSessionId,kind==='codex'?before[kind].codexSid:before[kind].ccSessionId);
      await until(kind+' sleep preserves draft',()=>b.c.eval(`document.querySelector('.floating-input-box')?.innerText==='未发送草稿 ${kind}'`));
      assert(a.hub.isAlive());
      await shot(b.c,kind+'-sleep-resumed');
      // Return the session to A so window-close recovery also covers both
      // providers, and verify another Codex session in B keeps working.
      await click(b.c,'.btn-close-session');
      await until(kind+' released by Hub B',()=>b.c.eval(`sessions.get(${key})?.status==='dormant'`));
      assert.equal(await b.c.eval(`sessions.get(${JSON.stringify(other.id)})?.nativeRuntime?.connection`),'connected');
      await click(a.c,`.session-item[data-session-id="${id}"]`);
      await until(kind+' returns to Hub A',()=>a.c.eval(`sessions.get(${key})?.nativeRuntime?.connection==='connected'`));
    }
    checks.push('real Close and Sleep clicks release Codex and Claude immediately; native IDs and drafts survive; unrelated sessions remain connected');
    // Change settings after B booted: resumption must reload fresh disk state.
    await a.c.eval(`ipcRenderer.invoke('rename-session',{sessionId:${JSON.stringify(ids.codex)},title:'最新标题：跨 Hub 恢复'})`);
    // Exercise the actual window close path, including configurations that used
    // to keep an invisible Hub in the tray. This test owns this exact window.
    await a.c.eval("ipcRenderer.invoke('debug:agent-league-close-window')");
    await until('owner window close exits instead of hiding',()=>Promise.resolve(!a.hub.isAlive()));
    await gracefulQuit(a.hub,{allowAlreadyExited:true});
    await a.c.close();
    for(const kind of ['codex','claude']) {
      const id=ids[kind],key=JSON.stringify(id);
      await click(b.c,`.session-item[data-session-id="${id}"]`);
      await until(kind+' resumes',()=>b.c.eval(`sessions.get(${key})?.nativeRuntime?.connection==='connected'`));
      const after=await b.c.eval(`sessions.get(${key})`);
      assert.equal(kind==='codex'?after.codexSid:after.ccSessionId,kind==='codex'?before[kind].codexSid:before[kind].ccSessionId);
      await until(kind+' saved draft visible',()=>b.c.eval(`document.querySelector('.floating-input-box')?.innerText==='未发送草稿 ${kind}'`));
      const transcript=await b.c.eval(`ipcRenderer.invoke('parse-session-transcript',{hubSessionId:${key}})`);
      assert(JSON.stringify(transcript).includes(kind==='codex'?'原生回答':'完成'),JSON.stringify(transcript).slice(-1000));
      assert.equal(await b.c.eval(`!!document.querySelector('#codex-shared-status')`),false);
      assert(!JSON.stringify(after).includes('Hub 状态同步连接已断开'));
      await shot(b.c,kind+'-resumed');
    }
    assert(!fs.existsSync(path.join(dataDir,'codex-runtime-broker.json')));
    checks.push('owner exit releases both sessions; original native IDs, full saved responses and drafts restore in the already-open Hub');
    checks.push('no shared broker or viewer/control-transfer UI even with legacy sharing environment flags');
    // Abrupt termination is confined to this exact test child. Its native pipes
    // must close, after which the next Hub can reclaim durable stale ownership.
    await b.c.close();
    assert(b.hub.child.kill('SIGKILL'));
    await until('test Hub B crashed',()=>Promise.resolve(!b.hub.isAlive()));
    const c=await launch('exclusive-crash-recovery');
    for(const kind of ['codex','claude']) {
      const id=ids[kind],key=JSON.stringify(id);
      await until(kind+' crash row',()=>c.c.eval(`sessions.has(${key})`));
      await click(c.c,`.session-item[data-session-id="${id}"]`);
      await until(kind+' crash recovery',()=>c.c.eval(`sessions.get(${key})?.nativeRuntime?.connection==='connected'`));
      const after=await c.c.eval(`sessions.get(${key})`);
      assert.equal(kind==='codex'?after.codexSid:after.ccSessionId,kind==='codex'?before[kind].codexSid:before[kind].ccSessionId);
      await shot(c.c,kind+'-crash-recovered');
    }
    checks.push('abrupt test Hub exit is recoverable for both providers after its native writers exit');
    passed=true;
  } finally {
    for(const c of clients)try{await c.close();}catch{}
    for(const hub of hubs.reverse()) {if(hub.isAlive())await gracefulQuit(hub);const log=hub.log().join('\n');fs.writeFileSync(path.join(out,hub.label+'.log'),log);assert(/hook.*(?:listening|监听)/i.test(log),'hook smoke missing');}
    fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed,checks,ids,before,root},null,2),'utf8');
    console.log(JSON.stringify({out,passed,checks}));
  }
}
main().catch(error=>{console.error(error.stack);if(error.logTail)console.error(error.logTail);process.exitCode=1;});
