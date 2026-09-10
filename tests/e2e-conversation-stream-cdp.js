'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),net=require('net'),assert=require('assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function freePort(){return new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port));});});}
async function main(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-conversation-stream-'));
  const out=path.resolve('artifacts/20260910-card-stream-codex1/gui-'+Date.now());fs.mkdirSync(out,{recursive:true});
  const home=path.join(root,'codex'),cwd=path.join(root,'workspace');fs.mkdirSync(home);fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(home,'config.toml'),'model = "gpt-6-astra"\nmodel_reasoning_effort = "xhigh"\n');
  let hub,cdp;const evidence={root,out,checks:[],passed:false};
  const until=async(expr,label)=>{const end=Date.now()+30000;while(Date.now()<end){if(await cdp.eval(expr))return;await sleep(150);}throw Error('timeout: '+label);};
  const snap=async name=>{const shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(shot.data,'base64'));};
  try{
    hub=await launchIsolatedHub({dataDir:path.join(root,'data'),port:await freePort(),windowMode:'hidden',label:'conversation-stream',extraEnv:{CODEX_HOME:home,CLAUDE_CONFIG_DIR:path.join(root,'claude'),CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.join(__dirname,'fixtures/codex-app-server.js')}});
    evidence.pid=hub.pid;evidence.port=hub.port;cdp=await connectFirstPage(hub);
    await until('typeof sessions!=="undefined" && typeof ipcRenderer!=="undefined"','renderer');
    const opts={cwd,model:'gpt-6-astra',effort:'xhigh',mcpProfile:'none',codexSpeedTier:'standard'};
    const session=await cdp.eval('ipcRenderer.invoke("create-session",'+JSON.stringify({kind:'codex',opts})+')');
    const sid=JSON.stringify(session.id);evidence.sid=session.id;
    await until('sessions.get('+sid+')?.nativeRuntime?.state === "idle"','native ready');
    await until('document.querySelector(\'.session-item[data-session-id="'+session.id+'"]\')','sidebar');
    await cdp.eval('document.querySelector(\'.session-item[data-session-id="'+session.id+'"]\').click()');
    await until('!!document.querySelector(".floating-input-box")','composer');
    await cdp.eval('document.querySelector(\'[data-view="card"]\').click()');
    const prompt='fixture:conversation\n---\n1. 原样保留编号\n- 不拆分同一条输入';
    async function send(){await cdp.eval('(()=>{const b=document.querySelector(".floating-input-box");b.textContent='+JSON.stringify(prompt)+';b.dispatchEvent(new Event("input",{bubbles:true}));b.focus();})()');
      await cdp.eval('document.querySelector(".floating-input-send").click()');}
    await send();
    await until('document.querySelectorAll("#msg-overlay .turn-card[data-phase=commentary]").length===1','first independent progress');
    await cdp.eval('window.__firstProgress=document.querySelector("#msg-overlay .turn-card[data-phase=commentary]");');
    await cdp.eval('(()=>{const n=window.__firstProgress.querySelector(".turn-body p").firstChild;const r=document.createRange();r.setStart(n,0);r.setEnd(n,3);getSelection().removeAllRanges();getSelection().addRange(r);})()');
    evidence.initialSelection=await cdp.eval('getSelection().toString()');
    await cdp.eval('window.__selectionTrace=[];document.addEventListener("selectionchange",()=>{if(window.__selectionTrace.length<40)window.__selectionTrace.push({text:getSelection().toString(),active:document.activeElement?.className,anchor:getSelection().anchorNode?.parentElement?.className,metrics:JSON.parse(JSON.stringify(window.__cardRenderMetrics || {}))});});');
    await until('sessions.get('+sid+').nativeRuntime.state==="completed"','completed');
    await until('document.querySelectorAll("#msg-overlay .turn-card[data-phase=commentary]").length===2 && document.querySelectorAll("#msg-overlay .turn-card[data-phase=final_answer]").length===1','progress survives final');
    assert.equal(await cdp.eval('window.__firstProgress===document.querySelector("#msg-overlay .turn-card[data-phase=commentary]")'),true);
    assert.equal(await cdp.eval('getSelection().toString()'),'已定位');
    assert.equal(await cdp.eval('document.querySelectorAll("#msg-overlay .turn-card.user").length'),1);
    assert.equal(await cdp.eval('document.querySelector("#msg-overlay .conversation-user-text").textContent'),prompt);
    assert.equal(await cdp.eval('!!document.querySelector("#msg-overlay .conversation-long-message:not([open])")'),true);
    assert.equal(await cdp.eval('document.querySelector("#msg-overlay .turn-card[data-phase=activity]")?.innerText.includes("没有回答正文")'),false);
    const copied=await cdp.eval('require("./visible-card-text").extractVisibleCardText(document.querySelector("#msg-overlay .turn-card[data-phase=final_answer] .turn-body"))');
    assert.equal((copied.match(/这是同一条长回答/g) || []).length,36);
    assert(!copied.includes('展开全文'));assert.equal(copied.match(/已完成：/g).length,1);
    evidence.longCopy={length:copied.length,paragraphs:36};
    await cdp.eval('document.getElementById("msg-overlay").scrollTop=0');
    await snap('ordinary-all');evidence.checks.push('real composer -> stdio App Server -> one user card; two progress item nodes survive final');
    await cdp.eval('document.querySelector("#msg-overlay .turn-card[data-phase=final_answer]").scrollIntoView({block:"center"})');
    await snap('ordinary-result');
    await cdp.eval('document.querySelector("[data-conversation-filter]").click()');
    assert.equal(await cdp.eval('[...document.querySelectorAll("#msg-overlay .turn-card[data-phase=commentary]")].every(e=>getComputedStyle(e).display==="none")'),true);
    await cdp.eval('document.querySelector("[data-conversation-filter]").click()');
    await send();await until('document.querySelectorAll("#msg-overlay .turn-card[data-phase=final_answer]").length===2','second real identical submission');
    assert.equal(await cdp.eval('document.querySelectorAll("#msg-overlay .turn-card.user").length'),2);
    evidence.checks.push('intentional identical second submission retained; explicit results filter reversible');
    await cdp.send('Page.reload');await until('typeof sessions!=="undefined" && sessions.has('+sid+')','reload');
    await cdp.eval('document.querySelector(\'.session-item[data-session-id="'+session.id+'"]\').click()');
    await cdp.eval('document.querySelector(\'[data-view="card"]\').click()');
    await until('document.querySelectorAll("#msg-overlay .turn-card[data-phase=commentary]").length===4','history replay preserves all items');
    for(const scene of ['general','dev']) {
      const group=await cdp.eval('ipcRenderer.invoke("create-meeting",'+JSON.stringify({title:'消息流验收 '+scene,scene,workspace:cwd,slots:[{kind:'codex',...opts}]})+')');
      const gid=JSON.stringify(group.id);await until('sessions.get('+JSON.stringify(group.subSessions[0])+')?.nativeRuntime?.state==="idle"','group ready');
      await cdp.eval('window.MeetingRoom.openMeeting('+gid+','+JSON.stringify(group)+')');await until('document.getElementById("mr-input-box")','group composer');
      await cdp.eval('document.querySelector(\'[data-view="card"]\').click()');
      await cdp.eval('(()=>{const b=document.getElementById("mr-input-box");b.textContent='+JSON.stringify(prompt)+';b.dispatchEvent(new Event("input",{bubbles:true}));document.getElementById("mr-send-btn").click();})()');
      const read='ipcRenderer.invoke("groupchat:get-state",{meetingId:'+gid+'})';
      await until('(async()=>{const x=await '+read+';return Object.values(x.displayMessagesByAttempt || {}).some(ms=>ms.filter(m=>m.text).length===3);})()','durable group item history '+scene);
      await until('document.querySelectorAll(".mr-gc-messages .conversation-entry[data-phase=commentary]").length===2','group progress cards '+scene);
      await until('document.querySelector(".mr-gc-messages .conversation-activity:not([open])")!==null','group collapsed tool record '+scene);
      evidence[scene]=await cdp.eval(read);await snap('group-'+scene);
      await cdp.send('Page.reload');await until('typeof window.MeetingRoom!=="undefined"','reload group');
      await cdp.eval('window.MeetingRoom.openMeeting('+gid+','+JSON.stringify(group)+')');
      await until('document.querySelectorAll(".mr-gc-messages .conversation-entry[data-phase=commentary]").length===2','group reload progress '+scene);
      evidence.checks.push(scene+' group: progress/final persisted by attempt and item ID and restored after renderer reload');
    }
    evidence.passed=true;
  }catch(error){evidence.error=error.stack;throw error;}
  finally{if(cdp){try{await snap('last');evidence.ui=await cdp.eval('document.body.innerText.slice(-6000)');evidence.metrics=await cdp.eval('window.__cardRenderMetrics || null');evidence.selectionTrace=await cdp.eval('window.__selectionTrace || []');}catch(e){evidence.captureError=e.message;}await cdp.close();}
    if(hub){fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));evidence.exit=await gracefulQuit(hub);}
    fs.writeFileSync(path.join(out,'evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify({out,passed:evidence.passed,checks:evidence.checks,error:evidence.error},null,2));}
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
