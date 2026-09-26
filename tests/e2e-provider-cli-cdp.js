'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const assert=require('node:assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const j=JSON.stringify,sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-provider-cli-')),data=path.join(root,'data'),cwd=path.join(root,'work');fs.mkdirSync(data);fs.mkdirSync(cwd);
  const config=JSON.parse(fs.readFileSync(path.join(os.homedir(),'.claude-session-hub/config.json'),'utf8'));
  fs.writeFileSync(path.join(data,'config.json'),j({acp:config.acp,providers:{deepseek:config.providers?.deepseek}}));
  const out=path.resolve('artifacts/provider-cli/'+Date.now());fs.mkdirSync(out,{recursive:true});
  const report={root,out,checks:[],passed:false};let hub,c;
  const check=text=>{report.checks.push(text);console.log('[provider]',text);};
  const until=async(expr,label,ms=120000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await c.eval(expr))return;await sleep(200);}throw new Error('timeout '+label);};
  const invoke=(ch,arg)=>c.eval(`ipcRenderer.invoke(${j(ch)},${j(arg)})`);
  const screenshot=async name=>{const r=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(r.data,'base64'));};
  const send=async(id,text)=>{await until(`!!document.querySelector('.session-item[data-session-id="${id}"]')`,'sidebar');await c.eval(`document.querySelector('.session-item[data-session-id="${id}"]').click()`);
    await until(`!!document.querySelector('.floating-input-bar[data-session-id="${id}"] .floating-input-box')`,'composer');
    await c.eval(`(()=>{const b=document.querySelector('.floating-input-bar[data-session-id="${id}"]');const i=b.querySelector('.floating-input-box');i.textContent=${j(text)};i.dispatchEvent(new Event('input',{bubbles:true}));b.querySelector('.floating-input-send').click();})()`);};
  const response=async(id,text)=>{await until(`(async()=>{const s=sessions.get(${j(id)});if(s?.cliRuntime&&s.cliRuntime.connection!=='connected')return false;const r=await ipcRenderer.invoke('parse-session-transcript',{hubSessionId:${j(id)},opts:{limit:20}});return (r.turns||[]).some(t=>t.role==='assistant'&&String(t.text||'').includes(${j(text)}));})()`,text);
    await until(`['completed','idle'].includes(getSessionRuntimeTruth(sessions.get(${j(id)})).state)`,'completion '+text);};
  try{
    const port=await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
    hub=await launchIsolatedHub({dataDir:data,port,extraEnv:{CLAUDE_HUB_HOME_DIR:path.join(root,'home')}});c=await connectFirstPage(hub);
    await until('typeof sessions!=="undefined"','renderer');await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    const selected=process.argv.slice(2).filter(a=>!a.startsWith('--'));
    for(const kind of selected.length?selected:['qwen','glm','deepseek']){
      const s=await invoke('create-session',{kind,opts:{cwd,...(kind==='deepseek'?{model:'deepseek-v4-flash',effort:'low',mcpProfile:'none'}:{})}});assert(s.id,j(s));assert.equal(s.agentRuntime,'pty');assert.equal(s.runtimeBackend,null);
      const marker=kind.toUpperCase().replace(/-/g,'_')+'_CLI_OK';await send(s.id,'Reply only '+marker);await response(s.id,marker);
      check(kind+' real UI prompt + CLI output + cards + completion');
      const sid=await c.eval(`sessions.get(${j(s.id)}).acpSid||sessions.get(${j(s.id)}).codexSid`);assert(sid);
      const restarted=await invoke('restart-session',s.id);assert(restarted.id||restarted.session?.id,j(restarted));
      await send(s.id,'Reply only '+marker+'_RESTART');await response(s.id,marker+'_RESTART');
      assert.equal(await c.eval(`sessions.get(${j(s.id)}).acpSid||sessions.get(${j(s.id)}).codexSid`),sid);check(kind+' restart retains native identity and historical cards');
      if(process.argv.includes('--long')){
        const longMarker=marker+'_LONG';
        const prompt=Array.from({length:120},(_,i)=>`reference ${i}: `+'x'.repeat(100)).join('\n')+'\nReply only '+longMarker;
        await send(s.id,prompt);await response(s.id,longMarker);
        const turns=(await invoke('parse-session-transcript',{hubSessionId:s.id,opts:{limit:20}})).turns||[];
        assert.equal(turns.filter(t=>t.role==='user'&&String(t.text||'').includes('Reply only '+longMarker)).length,1);
        check(kind+' 120-line prompt delivered once and answered');
      }
      if(process.argv.includes('--interrupt')){
        await send(s.id,'Use the shell tool to run node -e "setTimeout(()=>console.log(123),30000)" in the foreground. Then reply TOOL_FINISHED.');
        await until(`(async()=>{const r=await ipcRenderer.invoke('parse-session-transcript',{hubSessionId:${j(s.id)},opts:{limit:2}});return (r.turns||[]).some(t=>(t.toolCalls||[]).some(c=>['running','inProgress'].includes(c.status)));})()`,'tool starts');
        await until(`(()=>{const b=document.querySelector('.floating-input-bar[data-session-id="${s.id}"] .floating-input-stop');return b&&!b.disabled&&getComputedStyle(b).display!=='none';})()`,'stop button available');
        await c.eval(`document.querySelector('.floating-input-bar[data-session-id="${s.id}"] .floating-input-stop').click()`);
        report.stop=await c.eval(`({sentAt:sessions.get(${j(s.id)})._ptyStopSentAt,truth:getSessionRuntimeTruth(sessions.get(${j(s.id)}))})`);
        await until(`!['running','starting','waiting'].includes(getSessionRuntimeTruth(sessions.get(${j(s.id)})).state)`,'stop settles',45000);
        await send(s.id,'Reply only '+marker+'_AFTER_STOP');await response(s.id,marker+'_AFTER_STOP');check(kind+' real tool interrupt and next prompt');
      }
      await c.eval(`applyViewMode('card')`);await screenshot(kind+'-cards');
      if(kind==='qwen'&&process.argv.includes('--fork')){
        const fork=await invoke('fork-session',{sourceSessionId:s.id});assert(fork.session?.id,j(fork));
        await send(fork.session.id,'Reply only QWEN_FORK_OK');await response(fork.session.id,'QWEN_FORK_OK');
        assert.notEqual(await c.eval(`sessions.get(${j(fork.session.id)}).acpSid`),sid);check('qwen real CLI fork binds a distinct identity');
      }
    }
    report.passed=true;
  }catch(error){report.error=error.stack;if(c)await screenshot('failure').catch(()=>{});throw error;}
  finally{if(c)await c.close();fs.rmSync(path.join(data,'config.json'),{force:true});
    try{if(hub){fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));await gracefulQuit(hub);}}
    catch(error){report.teardownError=error.stack;report.passed=false;process.exitCode=1;}
    fs.writeFileSync(path.join(out,'result.json'),j(report));console.log(j(report));}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
