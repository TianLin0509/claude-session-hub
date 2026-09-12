'use strict';
// Existing Claude/official DeepSeek paths, real isolated Hub and existing accounts.
const fs=require('fs'),path=require('path'),os=require('os'),net=require('net'),assert=require('assert/strict'),crypto=require('crypto');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher'),{connectFirstPage}=require('./helpers/cdp-client');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const port=()=>new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
async function main(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-acp-legacy-')),dataDir=path.join(root,'data'),claude=path.join(root,'claude');fs.mkdirSync(dataDir);fs.mkdirSync(claude);
  const original=JSON.parse(fs.readFileSync(path.join(os.homedir(),'.claude-session-hub/config.json'),'utf8').replace(/^\uFEFF/,''));
  const config={providers:{claude:original.providers.claude,deepseek:original.providers.deepseek},proxy:original.proxy};
  fs.writeFileSync(path.join(dataDir,'config.json'),JSON.stringify(config));
  const auth=path.join(os.homedir(),'.claude/.credentials.json');if(fs.existsSync(auth))fs.copyFileSync(auth,path.join(claude,'.credentials.json'));
  fs.writeFileSync(path.join(claude,'.claude.json'),JSON.stringify({hasCompletedOnboarding:true,theme:'dark'}));
  const out=path.resolve('artifacts/acp/legacy-'+Date.now());fs.mkdirSync(out,{recursive:true});const result={root,out,checks:[],passed:false};let hub,cdp;
  const until=async(expr,label,ms=120000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await cdp.eval(expr))return;await sleep(200);}throw Error('timeout '+label);};
  const snap=async name=>{const s=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(s.data,'base64'));};
  try{
    hub=await launchIsolatedHub({dataDir,port:await port(),label:'legacy-regression',extraEnv:{CLAUDE_CONFIG_DIR:claude,CODEX_HOME:path.join(root,'codex')}});cdp=await connectFirstPage(hub);await until('typeof sessions!=="undefined"','renderer');
    for(const kind of process.argv.slice(2).length?process.argv.slice(2):['claude','deepseek']){
      const cwd=path.join(root,'workspace-'+kind);fs.mkdirSync(cwd);const marker=crypto.randomUUID();fs.writeFileSync(path.join(cwd,'regression.txt'),marker);
      const s=await cdp.eval('ipcRenderer.invoke("create-session",'+JSON.stringify({kind,opts:{cwd,mcpProfile:'none',model:kind==='deepseek'?'deepseek-v4-pro':original.providers.claude.model}})+')');assert(s.id);const id=JSON.stringify(s.id);
      await cdp.eval('selectSession('+id+')');await until('document.querySelector(".floating-input-box")','composer');
      const send=async text=>cdp.eval('(()=>{const b=document.querySelector(".floating-input-box");b.textContent='+JSON.stringify(text)+';b.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector(".floating-input-send").click();})()');
      const ready=async()=>{
        const end=Date.now()+120000;let declinedImport=false;
        while(Date.now()<end){
          const raw=String(await cdp.eval('ipcRenderer.invoke("debug:get-session-buffer",'+id+')'));
          const clean=raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/\s/g,'');
          if(kind==='claude' && clean.includes('AllowexternalCLAUDE.mdfileimports?') && !declinedImport){
            // A real visible CLI choice; Enter selects its default No. Never a prompt-submit fallback.
            await cdp.eval('ipcRenderer.send("terminal-input",'+JSON.stringify({sessionId:s.id,data:'\r'})+')');declinedImport=true;
          }
          if(kind==='claude'?/ClaudeCodev[0-9]/.test(clean):/OpenAICodex.{0,12}v[0-9]/.test(clean))return;
          await sleep(200);
        }
        throw Error('timeout native CLI banner');
      };
      await ready();
      await send('Read the file regression.txt using your native read tool and return its exact contents. Do not modify any file.');
      await until('[...document.querySelectorAll(".turn-card.assistant")].some(e=>e.innerText.includes('+JSON.stringify(marker)+'))','real legacy answer');await snap(kind+'-answer');
      const live=await cdp.eval('sessions.get('+id+')');assert.notEqual(live.runtimeBackend,'acp');const nativeId=live.ccSessionId || live.codexSid;assert(nativeId,'native identity required');
      await cdp.eval('ipcRenderer.invoke("close-session",'+id+')');await until('sessions.get('+id+')?.status==="dormant"','closed');
      await cdp.eval('selectSession('+id+')');await until('sessions.get('+id+')?.status!=="dormant" && document.querySelector(".floating-input-box")','reopened');
      await ready();
      await send('Without using tools, reply with LEGACY_RESTORED followed by the exact random marker you read in the previous turn.');
      await until('[...document.querySelectorAll(".turn-card.assistant .turn-body")].some(e=>e.innerText.includes("LEGACY_RESTORED") && e.innerText.includes('+JSON.stringify(marker)+'))','new legacy answer recalls native context');
      await snap(kind+'-resumed');result.checks.push(kind+': real CLI create/send/read plus native close/reopen context');
      const priorCompleted=await cdp.eval('sessions.get('+id+').lastCompletedAt');
      await send('请写一篇详细长文，分十节介绍软件测试，每节至少500字，不使用工具。');
      await until('sessions.get('+id+').runtimeTruth?.state==="running" && sessions.get('+id+').runtimeTruth?.startedAt>'+JSON.stringify(priorCompleted),'new legacy native run');
      await until('(()=>{const b=document.querySelector(".floating-input-stop");return b && getComputedStyle(b).display!=="none" && !b.disabled;})()','legacy running stop');
      await cdp.eval('document.querySelector(".floating-input-stop").click()');
      await until('(()=>{const b=document.querySelector(".floating-input-stop");return !b || getComputedStyle(b).display==="none";})()','legacy stop UI');
      await snap(kind+'-stopped');await cdp.eval('ipcRenderer.invoke("close-session",'+id+')');result.checks.push(kind+': existing stop input and UI return');
    }
    result.passed=true;
  }catch(e){result.error=e.message;throw e;}finally{
    if(cdp){result.sessions=await cdp.eval('[...sessions.values()]');result.buffers=await cdp.eval('Promise.all([...sessions.keys()].map(async id=>({id,text:String(await ipcRenderer.invoke("debug:get-session-buffer",id)).slice(-14000)})))');await snap('final');await cdp.close();}
    if(hub){fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n').replace(/\bsk-[\w.\-]{8,}/g,'[REDACTED]'));result.exit=await gracefulQuit(hub);}
    fs.rmSync(path.join(claude,'.credentials.json'),{force:true});fs.rmSync(path.join(dataDir,'config.json'),{force:true});
    fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2).replace(/\bsk-[\w.\-]{8,}/g,'[REDACTED]'));console.log(JSON.stringify({out,passed:result.passed,checks:result.checks,error:result.error}));
  }
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
