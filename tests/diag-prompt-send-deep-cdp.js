'use strict';
// Actual composer/CLI/receipt/answer verification, plus separately labelled
// controlled renderer faults. Isolated credentials are removed on exit.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { ensureClaudeHookIntegration } = require('../core/claude-hook-integration');
const ROOT = path.resolve(__dirname, '..'), j = JSON.stringify;
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-prompt-deep-'));
const OUT = path.join(ROOT, 'artifacts', 'prompt-send-deep-' + Date.now());
fs.mkdirSync(OUT, {recursive:true});
const report = {out:OUT, checks:[], models:{claude:'claude-haiku-4-5-20251001',codex:'gpt-6.1-sol'}, sessions:[]};
const claudeHome = path.join(TEMP,'claude'), codexHome = path.join(TEMP,'codex');
for(const d of [claudeHome,codexHome,path.join(TEMP,'workspace')]) fs.mkdirSync(d,{recursive:true});
const sourceClaude = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(),'.claude');
fs.copyFileSync(path.join(sourceClaude,'.credentials.json'),path.join(claudeHome,'.credentials.json'));
fs.writeFileSync(path.join(claudeHome,'.claude.json'),j({hasCompletedOnboarding:true,theme:'dark',
  bypassPermissionsModeAccepted:true,skipDangerousModePermissionPrompt:true,projects:{}}));
ensureClaudeHookIntegration({claudeDir:claudeHome,sourceScriptsDir:path.join(ROOT,'scripts'),logger:{}});
const sourceCodex = process.env.CODEX_HOME || path.join(os.homedir(),'.codex');
for(const name of ['auth.json','config.toml','models_cache.json']) {
  if(fs.existsSync(path.join(sourceCodex,name))) fs.copyFileSync(path.join(sourceCodex,name),path.join(codexHome,name));
}
const freePort = () => new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
async function main() {
  let hub,c;
  let entryPath=ROOT;
  if(process.env.DEEP_DROP_FIRST_ENTER==='1') {
    entryPath=path.join(OUT,'fault-entry.cjs');
    report.transportFault='drop first submit Enter; stale previous-turn ring frame';
    fs.writeFileSync(entryPath,`
      const fs=require('node:fs');
      const {SessionManager}=require(${j(path.join(ROOT,'core/session-manager.js'))});
      const submit=require(${j(path.join(ROOT,'core/pty-prompt-submit.js'))}),detect=submit.pasteStillInInputBox;
      submit.pasteStillInInputBox=(probe,prompt)=>{const result=detect(probe,prompt);
        fs.appendFileSync(${j(path.join(OUT,'probes.jsonl'))},JSON.stringify({at:Date.now(),prompt,result,probe})+'\\n');return result;};
      const watcher=require(${j(path.join(ROOT,'core/group-chat-watcher.js'))}),init=watcher.init;
      watcher.init=deps=>init({...deps,enableSendDiagnostics:true});
      const counts=new Map(),write=SessionManager.prototype.writeToSession,buffer=SessionManager.prototype.getSessionBuffer;
      SessionManager.prototype.writeToSession=function(sid,data){
        fs.appendFileSync(${j(path.join(OUT,'writes.jsonl'))},JSON.stringify({sid,data,at:Date.now()})+'\\n');
        if(data.includes('\\x1b[200~')&&!counts.has(sid)) counts.set(sid,0);
        if(data==='\\r'&&counts.has(sid)){
          const n=counts.get(sid)+1;counts.set(sid,n);
          fs.appendFileSync(${j(path.join(OUT,'enter-trace.jsonl'))},JSON.stringify({sid,n,at:Date.now(),dropped:n===1})+'\\n');
          if(n===1)return;
        }return write.apply(this,arguments);
      };
      SessionManager.prototype.getSessionBuffer=function(sid){const text=buffer.apply(this,arguments);
        return counts.get(sid)===1?text+'\\r\\n· Thinking… (3s)\\r\\n• Working (3s • esc to interrupt)\\r\\n':text;};
      require(${j(path.join(ROOT,'main-bootstrap.js'))});
    `,'utf8');
  }
  async function until(label,fn,timeout=90000) {
    const end=Date.now()+timeout; while(Date.now()<end){const v=await fn();if(v)return v;await _waitMs(200);}
    throw Error('timeout: '+label);
  }
  async function shot(name){const x=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(OUT,name+'.png'),Buffer.from(x.data,'base64'));}
  async function send(sid,text) {
    const value=await c.eval(`(()=>{const box=document.querySelector('.floating-input-bar[data-session-id="${sid}"] .floating-input-box');box.focus();replaceContenteditableText(box,${j(text)});box.dispatchEvent(new Event('input',{bubbles:true}));return readContenteditablePlainText(box);})()`);
    assert.equal(value,text,'composer text and newlines');
    await c.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    await c.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    return c.eval(`floatingPromptDeliveries.get(${j(sid)})?.clientSubmissionId`);
  }
  async function recall(sid,text) {
    await c.eval(`(()=>{const b=document.querySelector('.floating-input-bar[data-session-id="${sid}"] .floating-input-box');b.focus();replaceContenteditableText(b,'');})()`);
    await c.send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowUp',code:'ArrowUp',windowsVirtualKeyCode:38});
    await c.send('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowUp',code:'ArrowUp',windowsVirtualKeyCode:38});
    assert.equal(await c.eval(`readContenteditablePlainText(document.querySelector('.floating-input-bar[data-session-id="${sid}"] .floating-input-box'))`),text,'ArrowUp recalls exact attempted prompt');
    await c.eval(`(()=>{const b=document.querySelector('.floating-input-bar[data-session-id="${sid}"] .floating-input-box');replaceContenteditableText(b,'');b.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  }
  try {
    hub=await launchIsolatedHub({dataDir:path.join(TEMP,'data'),port:await freePort(),windowMode:'background',label:'prompt deep',entryPath,
      extraEnv:{CLAUDE_CONFIG_DIR:claudeHome,CODEX_HOME:codexHome,CLAUDE_HUB_HOME_DIR:path.join(TEMP,'home'),
        AI_HUB_WORKSPACE_ROOT:TEMP,DEEPSEEK_API_KEY:'',CLAUDE_HUB_E2E:'1'}});
    c=await connectFirstPage(hub);
    await until('renderer',()=>c.eval('typeof sessions!=="undefined" && !!window.WorkspaceController'));
    await c.eval(`window.__deep=[];window.__originalInvoke=ipcRenderer.invoke.bind(ipcRenderer);
      ipcRenderer.invoke=(channel,...args)=>{const p=window.__originalInvoke(channel,...args);
        if(channel==='session:send-prompt'){const row={at:Date.now(),sid:args[0].sessionId,id:args[0].clientSubmissionId,length:args[0].text.length};window.__deep.push(row);p.then(r=>row.result=r,e=>row.error=e.message);}return p;};true`);
    for(const provider of (process.env.DEEP_PROVIDERS||'claude,codex').split(',')) {
      console.log('[deep] creating '+provider);
      const s=await c.eval(`ipcRenderer.invoke('create-session',${j({kind:provider,opts:{cwd:path.join(TEMP,'workspace'),model:report.models[provider],effort:'low',mcpProfile:'none',codexSpeedTier:'inherit',permissionMode:'default'}})})`);
      const sid=s.id;report.sessions.push({provider,sid});
      await until('session row',()=>c.eval(`!!document.querySelector('.session-item[data-session-id="${sid}"]')`));
      await c.eval(`document.querySelector('.session-item[data-session-id="${sid}"]').click();true`);
      await until('composer',()=>c.eval(`!!document.querySelector('.floating-input-bar[data-session-id="${sid}"] .floating-input-box')`));
      if(process.env.DEEP_SHOW_PTY==='1') await c.eval(`applyViewMode('pty');true`);
      await until(provider+' ready',async()=>{
        const screen=await c.eval(`window.__hubE2E.terminalLiveScreenText(${j(sid)})`);
        if(/trust.*(?:directory|folder)|Yes, I trust this folder/i.test(screen)) {
          await c.eval(`ipcRenderer.send('terminal-input',{sessionId:${j(sid)},data:'\\r'});true`);
        }
        return await c.eval(`ipcRenderer.invoke('cli-ready-status',${j(sid)})`);
      },150000);
      const realCases=[
        ['short','只回复 DEEP_SHORT_OK，不调用工具。','DEEP_SHORT_OK'],
        ['multiline',Array.from({length:110},(_,i)=>`材料第 ${i+1} 行：中文、多行及粘贴完整性校验。`).join('\n')+'\n只回复 DEEP_LONG_OK，不调用工具。','DEEP_LONG_OK'],
        ['followup','继续只回复 DEEP_NEXT_OK，不调用工具。','DEEP_NEXT_OK'],
      ];
      for(const [label,prompt,marker] of (process.env.DEEP_SHORT_ONLY==='1'?realCases.slice(0,1):realCases)) {
        const at=Date.now(),id=await send(sid,prompt);assert.ok(id);
        await recall(sid,prompt);
        await until(provider+' '+label+' receipt',()=>c.eval(`floatingPromptDeliveries.get(${j(sid)})?.status==='confirmed'`),Number(process.env.DEEP_RECEIPT_TIMEOUT)||90000);
        const latency=Date.now()-at;
        await until(provider+' '+label+' answer',()=>c.eval(`ipcRenderer.invoke('get-last-assistant-text',${j(sid)}).then(x=>String(x||'').includes(${j(marker)}))`),180000);
        // Wait until the real CLI has finished before sending the next case.
        await until(provider+' turn complete',()=>c.eval(`!['running','starting'].includes(getSessionRuntimeTruth(sessions.get(${j(sid)})).state)`),90000);
        assert.equal(await c.eval(`document.querySelector('.floating-input-bar[data-session-id="${sid}"] .fi-stuck')?.textContent||''`),'');
        report.checks.push({provider,label,mode:'real CLI / receipt / answer / ArrowUp',id,receiptLatencyMs:latency,passed:true});
        console.log('[deep] PASS '+provider+' '+label+' receipt='+latency+'ms');
      }
      await shot(provider+'-real');
      // These do not write prompts to a provider. They reproduce common UI
      // failure paths, recording history and whether IPC was called.
      await c.eval(`window.__deepFaultInvoke=ipcRenderer.invoke;window.__pendingUI=[];
        ipcRenderer.invoke=(channel,...args)=>channel==='session:send-prompt'
          ?new Promise((resolve,reject)=>window.__pendingUI.push({request:args[0],resolve,reject}))
          :window.__deepFaultInvoke(channel,...args);true`);
      const a=await send(sid,'较早消息 A'),b=await send(sid,'较新消息 B');
      await c.eval(`window.__pendingUI[0].resolve({ok:false,notSent:true,message:'controlled previous send failure'});true`);
      await _waitMs(100);
      const olderFailedVisible=await c.eval(`document.body.innerText.includes('controlled previous send failure')`);
      assert.equal(await c.eval(`floatingPromptDeliveries.get(${j(sid)}).clientSubmissionId`),b);
      report.checks.push({provider,label:'older send failure',mode:'controlled IPC',olderFailedVisible,a,b,passed:olderFailedVisible});
      await c.eval(`window.__pendingUI[1].resolve({ok:true,sendStatus:'ok',receipt:{sessionId:${j(sid)},clientSubmissionId:${j(b)},status:'confirmed'}});true`);
      // A real DOM callback throw occurs after history insertion and clearing,
      // but before invoke. Do not claim this is a naturally observed incident.
      await c.eval(`window.__oldClearWaiting=clearSessionWaitingState;clearSessionWaitingState=()=>{throw Error('controlled pre-dispatch UI failure');};true`);
      const n=await c.eval('window.__pendingUI.length');
      await send(sid,'发送前异常原文');
      await c.eval('clearSessionWaitingState=window.__oldClearWaiting;true');
      const uiFailure=await c.eval(`({dispatched:window.__pendingUI.length>${n},draft:readContenteditablePlainText(document.querySelector('.floating-input-bar[data-session-id="${sid}"] .floating-input-box')),visible:document.body.innerText.includes('controlled pre-dispatch UI failure')})`);
      await recall(sid,'发送前异常原文');
      report.checks.push({provider,label:'pre-dispatch UI failure',mode:'controlled renderer exception',...uiFailure,passed:!uiFailure.dispatched && uiFailure.draft==='发送前异常原文' && uiFailure.visible});
      console.log('[deep] controlled '+provider+' '+j({olderFailedVisible,uiFailure}));
      await c.eval('ipcRenderer.invoke=window.__deepFaultInvoke;true');
    }
    report.sends=await c.eval('window.__deep');
    if(process.env.DEEP_BASELINE!=='1') assert.ok(report.checks.every(x=>x.passed),'all real and controlled cases must pass');
  } catch(error) {
    report.error=error.stack;process.exitCode=1;
    if(c){try{report.failure=await c.eval(`({sid:activeSessionId,screen:window.__hubE2E.terminalLiveScreenText(activeSessionId),delivery:floatingPromptDeliveries.get(activeSessionId),sends:window.__deep})`);await shot('failure');}catch{}}
  } finally {
    if(hub)fs.writeFileSync(path.join(OUT,'hub.log'),hub.log().join('\n'),'utf8');
    if(c)await c.close();if(hub)await gracefulQuit(hub);
    for(const file of [path.join(claudeHome,'.credentials.json'),path.join(codexHome,'auth.json')]){try{fs.unlinkSync(file);}catch{}}
    fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify(report,null,2),'utf8');
    console.log(j({out:OUT,error:report.error,checks:report.checks}));
  }
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
