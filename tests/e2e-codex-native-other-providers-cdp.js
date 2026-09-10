'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),net=require('net'),assert=require('assert/strict');
const {execFileSync}=require('node:child_process');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher'),{connectFirstPage}=require('./helpers/cdp-client');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const port=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
async function main(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-native-other-')),out=path.resolve('artifacts/codex-native-runtime/other-providers-'+Date.now());fs.mkdirSync(out,{recursive:true});
  const cwd=path.join(root,'workspace');fs.mkdirSync(cwd);
  const result={root,out,head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),checks:[],passed:false};let hub,cdp;
  const until=async(expr,name)=>{const end=Date.now()+45000;while(Date.now()<end){if(await cdp.eval(expr))return;await sleep(200);}throw Error('timeout '+name);};
  try{
    hub=await launchIsolatedHub({dataDir:path.join(root,'data'),port:await port(),windowMode:'hidden',label:'other-providers',extraEnv:{CODEX_HOME:path.join(root,'codex'),CLAUDE_CONFIG_DIR:path.join(root,'claude'),CLAUDE_HUB_HOME_DIR:path.join(root,'home'),DEEPSEEK_API_KEY:'',KIMI_CODE_HOME:path.join(root,'kimi'),KIMI_CODE_BIN:path.join(os.homedir(),'.kimi-code/bin/kimi.exe')}});cdp=await connectFirstPage(hub);await until('typeof sessions!=="undefined"','renderer');
    // Claude now intentionally uses native stream-json. Remaining PTY paths
    // must keep their own startup and composer, without native controls.
    for(const kind of ['powershell','kimi']){
      const s=await cdp.eval('ipcRenderer.invoke("create-session",'+JSON.stringify({kind,opts:{cwd,title:kind+' 隔离启动验收',userRenamed:true,mcpProfile:'none'}})+')');assert(s.id);const id=JSON.stringify(s.id);
      await until('document.querySelector('+JSON.stringify('.session-item[data-session-id="'+s.id+'"]')+')','sidebar');await cdp.eval('selectSession('+id+')');
      await until('(async()=>String(await ipcRenderer.invoke("debug:get-session-buffer",'+id+')).length>200)()','real CLI output');
      const live=(await cdp.eval('ipcRenderer.invoke("get-sessions")')).find(x=>x.id===s.id);assert.equal(live.kind,kind);assert.notEqual(live.runtimeBackend,'codex-app-server');assert(!live.nativeRuntime);
      await until('document.querySelector(".floating-input-box")','legacy composer');assert.equal(await cdp.eval('!!document.querySelector(".codex-native-controls:not([hidden]), .claude-native-controls:not([hidden])")'),false);
      await sleep(6000);
      const screen=await cdp.eval('ipcRenderer.invoke("debug:get-session-buffer",'+id+')');assert(!/is not recognized|无法将.*识别|Cannot find module/.test(String(screen)));result.checks.push({kind,id:s.id,outputLength:String(screen).length,boundary:'real CLI startup and existing composer; no model request'});
      const shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,kind+'.png'),Buffer.from(shot.data,'base64'));
    }
    result.passed=true;
  }finally{if(cdp)await cdp.close();if(hub){fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));result.exit=await gracefulQuit(hub);}fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));}
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
