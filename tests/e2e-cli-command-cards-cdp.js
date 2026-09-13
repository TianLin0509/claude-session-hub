'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),net=require('net'),assert=require('assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function freePort(){return new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port));});});}
async function main(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-command-cards-'));
  const out=path.resolve('artifacts/cli-command-cards/'+Date.now());fs.mkdirSync(out,{recursive:true});
  const home=path.join(root,'codex'),cwd=path.join(root,'workspace');fs.mkdirSync(home);fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(home,'config.toml'),'model = "gpt-6-astra"\nmodel_reasoning_effort = "xhigh"\n');
  const result={root,out,checks:[],passed:false};let hub,cdp;
  const until=async(expr,label)=>{const deadline=Date.now()+30000;while(Date.now()<deadline){if(await cdp.eval(expr))return;await sleep(100);}throw Error('timeout: '+label);};
  try{
    hub=await launchIsolatedHub({dataDir:path.join(root,'data'),port:await freePort(),windowMode:'hidden',label:'cli-commands',
      extraEnv:{CODEX_HOME:home,CLAUDE_CONFIG_DIR:path.join(root,'claude'),
        CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.join(__dirname,'fixtures','codex-app-server.js'),
        CLAUDE_HUB_CLAUDE_STREAM_FIXTURE:path.join(__dirname,'fixtures','claude-stream.js')}});
    cdp=await connectFirstPage(hub);result.pid=hub.pid;
    await until("typeof sessions !== 'undefined' && typeof ipcRenderer !== 'undefined'",'renderer');
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    const create=async kind=>cdp.eval('ipcRenderer.invoke("create-session",'+JSON.stringify({kind,opts:{cwd,model:kind==='codex'?'gpt-6-astra':'claude-opus-5[1m]',effort:'xhigh',mcpProfile:'none',codexSpeedTier:'standard'}})+')');
    const s=await create('codex'), sid=JSON.stringify(s.id);result.sessionId=s.id;
    async function select(id){
      await until('document.querySelector('+JSON.stringify('.session-item[data-session-id="'+id+'"]')+')','sidebar');
      await cdp.eval('document.querySelector('+JSON.stringify('.session-item[data-session-id="'+id+'"]')+').click();applyViewMode("card")');
      await until('!!document.querySelector(".floating-input-box")','composer');
    }
    await select(s.id);
    async function send(text){
      await cdp.eval('(()=>{const input=document.querySelector(".floating-input-box");input.textContent='+JSON.stringify(text)+';input.dispatchEvent(new Event("input",{bubbles:true}));input.focus();document.querySelector(".floating-input-send").click();})()');
    }
    const count=text=>'[...document.querySelectorAll("#msg-overlay .turn-card.user")].filter(e=>e.textContent.includes('+JSON.stringify(text)+')).length';
    const raw='/goal 修复 API\n— 保留英文\n1. 不重启生产';
    await send(raw);
    await until(count('/goal 修复 API')+' === 1','raw goal card');
    await until('document.querySelector(".codex-command-feedback pre")?.textContent.includes("进行中")','native goal response');
    assert.equal(await cdp.eval('sessions.get('+sid+').nativeRuntime.turnId'),null);
    result.checks.push('goal raw multiline card and confirmed native goal response without fabricated turn');
    await send('/goal pause');
    await until('document.querySelector(".codex-command-feedback pre")?.textContent.includes("已暂停")','pause');
    await until(count('/goal pause')+' === 1','pause raw');
    await send('/model');
    await until('document.querySelector(".codex-command-feedback pre")?.textContent.includes("fixture-model")','model list');
    await send('/unknown-command');
    await until('document.querySelector(".codex-command-feedback.failed") && '+count('/unknown-command')+' === 1','failure raw retained');
    result.checks.push('pause/model/unknown command results and retained raw inputs');
    await send('/fixture-skill 执行 skill');
    await until('sessions.get('+sid+').nativeRuntime.state === "completed"','skill complete');
    await until(count('/fixture-skill 执行 skill')+' === 1','skill raw');
    await send('普通提问');
    await until('document.querySelector("#msg-overlay")?.textContent.includes("普通提问") && sessions.get('+sid+').nativeRuntime.state === "completed"','ordinary turn');
    const other=await create('codex');await select(other.id);await select(s.id);
    await until(count('/goal 修复 API')+' === 1','switch preserves goal');
    await cdp.send('Page.reload');
    await until('typeof sessions !== "undefined" && sessions.has('+sid+')','reload');await select(s.id);
    await until(count('/goal 修复 API')+' === 1 && '+count('/fixture-skill 执行 skill')+' === 1','reload preserves raw');
    await until('document.querySelector("#msg-overlay")?.textContent.includes("普通提问")','ordinary history');
    assert.equal(await cdp.eval('document.querySelectorAll("#msg-overlay .turn-card.user[data-optimistic=true]").length'),0);
    const history=await cdp.eval('ipcRenderer.invoke("parse-session-transcript",{hubSessionId:'+sid+',opts:{limit:100}})');
    assert.equal(history.turns.filter(t=>t.role==='user'&&t.text===raw).length,1);
    assert.equal(history.turns.filter(t=>t.role==='user'&&t.text==='执行 skill').length,0);
    result.checks.push('provider rewritten skill prompt deduplicated by identity; switch and renderer reload retain exact raw');
    const shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'commands.png'),Buffer.from(shot.data,'base64'));
    await cdp.eval('document.querySelector("#msg-overlay .turn-card.user")?.scrollIntoView({block:"center"})');
    const goalShot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'goal-raw.png'),Buffer.from(goalShot.data,'base64'));
    const claude=await create('claude');await select(claude.id);
    const loop='/loop 5m 检查构建结果';
    await send(loop);
    await until(count(loop)+' === 1','Claude loop raw');
    await until('sessions.get('+JSON.stringify(claude.id)+')?.nativeRuntime?.state === "completed"','Claude command response');
    await cdp.send('Page.reload');
    await until('typeof sessions !== "undefined" && sessions.has('+JSON.stringify(claude.id)+')','Claude reload');await select(claude.id);
    await until(count(loop)+' === 1','Claude loop reload');
    const claudeHistory=await cdp.eval('ipcRenderer.invoke("parse-session-transcript",{hubSessionId:'+JSON.stringify(claude.id)+'})');
    assert.equal(claudeHistory.turns.filter(t=>t.role==='user'&&t.text===loop).length,1);
    result.checks.push('Claude /loop raw passes through provider input, appears once, survives renderer reload (fixture, not a real scheduled task)');
    result.passed=true;
  }catch(error){result.error=error.stack;throw error;}
  finally{if(cdp)cdp.close();if(hub)await gracefulQuit(hub);fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
