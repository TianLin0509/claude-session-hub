'use strict';
// Real isolated Electron renderer + native stdio fixture; no paid model call.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const pause=ms=>new Promise(r=>setTimeout(r,ms)),j=JSON.stringify;
async function main(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-compact-progress-'));
  const out=path.resolve('output/compact-progress-b/'+Date.now());fs.mkdirSync(out,{recursive:true});
  const cwd=path.join(root,'workspace'),home=path.join(root,'codex');fs.mkdirSync(cwd);fs.mkdirSync(home);
  fs.writeFileSync(path.join(home,'config.toml'),'model = "gpt-6-astra"\nmodel_reasoning_effort = "xhigh"\n');
  const port=await new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})});
  let hub,c;const evidence={out,checks:[],passed:false};
  const until=async(expr,label)=>{const end=Date.now()+45000;while(Date.now()<end){if(await c.eval(expr))return;await pause(120)}throw Error('timeout: '+label)};
  const click=async selector=>{const p=await c.eval(`(()=>{const e=document.querySelector(${j(selector)});if(!e)throw Error('missing '+${j(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',...p});for(const type of ['mousePressed','mouseReleased'])await c.send('Input.dispatchMouseEvent',{type,...p,button:'left',clickCount:1});await pause(100)};
  const size=async(w,h)=>{await c.send('Emulation.setDeviceMetricsOverride',{width:w,height:h,deviceScaleFactor:1,mobile:false});await pause(120)};
  const shot=async name=>{await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:0,y:0});await pause(150);const s=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(s.data,'base64'))};
  const prompt='fixture:compact-progress\n请核对普通会话和群聊的紧凑进展布局。';
  const send=async(group=false,text=prompt)=>{const box=group?'#mr-input-box':'.floating-input-box';await c.eval(`(()=>{const b=document.querySelector(${j(box)});b.textContent=${j(text)};b.dispatchEvent(new Event('input',{bubbles:true}));b.focus()})()`);await click(group?'#mr-send-btn':'.floating-input-send')};
  async function grid(scope,count){
    const result=await c.eval(`(()=>{const rows=[...document.querySelectorAll(${j(scope+' .conversation-progress-row')})];return rows.map(e=>{const t=e.querySelector('.conversation-progress-time').getBoundingClientRect(),b=e.querySelector('.conversation-progress-content').getBoundingClientRect();return {display:getComputedStyle(e).display,font:getComputedStyle(e).fontSize,height:e.getBoundingClientRect().height,left:t.left,textLeft:b.left,gap:b.left-t.right,overflow:e.scrollWidth-e.clientWidth}})})()`);
    assert.equal(result.length,count);assert(result.every(r=>r.display==='grid'&&r.gap>=7&&r.overflow<=1),j(result));
    assert(result.every(r=>Math.abs(r.left-result[0].left)<1),j(result));return result;
  }
  try{
    hub=await launchIsolatedHub({dataDir:path.join(root,'data'),port,windowMode:'hidden',label:'compact-progress-b',extraEnv:{CODEX_HOME:home,CLAUDE_CONFIG_DIR:path.join(root,'claude'),CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.join(__dirname,'fixtures/codex-app-server.js')}});
    evidence.pid=hub.pid;c=await connectFirstPage(hub);await c.send('Page.enable');await until('typeof sessions!=="undefined" && !!window.__hubE2E','renderer');
    await c.eval('require("electron").webFrame.setZoomFactor(1)');await size(1600,1100);
    const opts={cwd,model:'gpt-6-astra',effort:'xhigh',mcpProfile:'none',codexSpeedTier:'standard'};
    const session=await c.eval(`ipcRenderer.invoke('create-session',${j({kind:'codex',opts})})`),sid=j(session.id);
    await until(`!!document.querySelector('.session-item[data-session-id="${session.id}"]')`,'ordinary sidebar');await click(`.session-item[data-session-id="${session.id}"]`);await until('!!document.querySelector(".floating-input-box")','composer');
    await send();
    assert.equal(await c.eval('getComputedStyle(document.querySelector("#msg-overlay .turn-card.user>.turn-avatar")).display'),'none');
    await until('document.querySelectorAll("#msg-overlay .conversation-progress-row").length===12 && !!document.querySelector("#msg-overlay [data-phase=final_answer]")','ordinary twelve plus result');
    evidence.ordinaryRows=await grid('#msg-overlay',12);
    assert.equal(await c.eval('[...document.querySelectorAll("#msg-overlay .turn-card.assistant>.turn-avatar")].filter(e=>getComputedStyle(e).visibility==="visible").length'),1);
    assert.equal(await c.eval('document.querySelectorAll("#msg-overlay [data-phase=commentary] .turn-meta-pills").length'),0);
    await c.eval('document.getElementById("msg-overlay").scrollTop=0');await shot('ordinary');
    // Actual copy click through the existing renderer handler and OS clipboard.
    await click('#msg-overlay .conversation-progress-row [data-action=copy]');
    await until('require("electron").clipboard.readText().startsWith("我先核对最新代码")','copy ordinary');
    assert.equal(await c.eval('require("electron").clipboard.readText()'),'我先核对最新代码，确认普通会话和群聊的消息入口。');
    await click('#msg-overlay .conversation-response-copy');await until('require("electron").clipboard.readText().includes("分行记录布局已完成")','copy full response');
    assert.equal(await c.eval('(require("electron").clipboard.readText().match(/我先核对最新代码/g)||[]).length'),1);
    await click('[data-conversation-filter]');assert.equal(await c.eval('getComputedStyle(document.querySelector("#msg-overlay [data-phase=final_answer]>.turn-avatar")).visibility'),'visible');await click('[data-conversation-filter]');
    evidence.checks.push('ordinary: 12 complete grid rows, one avatar, no repeated elapsed pills, real copy, final-only filter');
    await size(1100,780);await send();
    await until('document.querySelectorAll("#msg-overlay .conversation-progress-row").length>=16','second turn live');
    await c.eval('document.getElementById("msg-overlay").focus()');await c.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Home',code:'Home',windowsVirtualKeyCode:36});await c.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Home',code:'Home',windowsVirtualKeyCode:36});await pause(250);
    const top=await c.eval('document.getElementById("msg-overlay").scrollTop');
    await until('document.querySelectorAll("#msg-overlay .conversation-progress-row").length===24 && document.querySelectorAll("#msg-overlay [data-phase=final_answer]").length===2','second turn done');
    assert(Math.abs(await c.eval('document.getElementById("msg-overlay").scrollTop')-top)<3);
    assert.equal(await c.eval('document.querySelectorAll("#msg-overlay .turn-card.assistant:not(.conversation-response-continuation)").length'),2);
    await click('#msg-overlay .conversation-response-copy');await until('require("electron").clipboard.readText().includes("分行记录布局已完成")','copy older response');
    assert.equal(await c.eval('(require("electron").clipboard.readText().match(/我先核对最新代码/g)||[]).length'),1);
    await grid('#msg-overlay',24);await shot('ordinary-narrow');
    evidence.checks.push('new question starts a new identity; live append retains earlier reading position; narrow layout');
    await c.send('Page.reload');await until(`typeof sessions!=='undefined' && sessions.has(${sid})`,'ordinary reload');await click(`.session-item[data-session-id="${session.id}"]`);await until('document.querySelectorAll("#msg-overlay .conversation-progress-row").length===24','ordinary replay');
    assert.equal(await c.eval('document.querySelectorAll("#msg-overlay .turn-card.assistant:not(.conversation-response-continuation)").length'),2);
    await size(1800,1150);
    for(const scene of ['general','dev']){
      const group=await c.eval(`ipcRenderer.invoke('create-meeting',${j({title:'B 方案验收 '+scene,groupChat:true,scene,workspace:cwd,slots:[{kind:'codex',...opts}]})})`);
      await until(`!!document.querySelector('[data-meeting-id="${group.id}"]')`,'group sidebar');await click(`[data-meeting-id="${group.id}"]`);await until('!!document.getElementById("mr-input-box")','group input');await send(true);
      await until('document.querySelectorAll(".mr-gc-messages .conversation-progress-row").length===12 && !!document.querySelector(".mr-gc-messages [data-phase=final_answer]")','group twelve plus result '+scene);
      evidence[scene+'Rows']=await grid('.mr-gc-messages',12);
      assert.equal(await c.eval('document.querySelectorAll(".mr-gc-messages .mr-gc-msg.ai").length'),1);
      await c.eval('document.querySelector(".mr-gc-messages").scrollTop=0');await shot('group-'+scene);
      await click('.mr-gc-messages .conversation-progress-row [data-action=conversation-copy]');await until('require("electron").clipboard.readText().startsWith("我先核对最新代码")','group copy');
      assert.equal(await c.eval('require("electron").clipboard.readText()'),'我先核对最新代码，确认普通会话和群聊的消息入口。');
      await c.send('Page.reload');await until('typeof window.MeetingRoom!=="undefined"','group reload');await click(`[data-meeting-id="${group.id}"]`);await until('document.querySelectorAll(".mr-gc-messages .conversation-progress-row").length===12','group replay');
      // The member's ordinary card surface must use the same presentation too.
      await click('.mr-gc-messages .mr-gc-msg.ai [data-gc-open-session]');
      await until('document.querySelectorAll("#msg-overlay .conversation-progress-row").length===12','member ordinary cards');await grid('#msg-overlay',12);
      assert.equal(await c.eval('document.querySelectorAll("#msg-overlay .turn-card.assistant:not(.conversation-response-continuation)").length'),1);
      await shot('member-'+scene);
      evidence.checks.push(scene+' group: one actual agent identity, 12 aligned messages and distinct result, real copy and durable replay');
    }
    const animationSession=await c.eval(`ipcRenderer.invoke('create-session',${j({kind:'codex',opts})})`);
    await until(`!!document.querySelector('.session-item[data-session-id="${animationSession.id}"]')`,'animation session');await click(`.session-item[data-session-id="${animationSession.id}"]`);
    await send(false,'fixture:hold');await until('!!document.querySelector("#msg-overlay .streaming-indicator")','held working badge');
    await c.send('Page.bringToFront');
    const motion=()=>c.eval(`(()=>{const e=document.querySelector('#msg-overlay .streaming-indicator'),s=e.querySelector('.spinner-icon');return {breath:getComputedStyle(e).animationName,spin:getComputedStyle(s).animationName,transform:getComputedStyle(s).transform,background:getComputedStyle(e).backgroundColor,visibility:document.visibilityState,reduced:matchMedia('(prefers-reduced-motion: reduce)').matches,animations:e.getAnimations({subtree:true}).map(a=>({name:a.animationName,time:a.currentTime,state:a.playState}))}})()`);
    await shot('working-first');const first=await motion();await pause(260);await shot('working-second');const second=await motion();evidence.motion={first,second};
    assert.equal(first.breath,'streaming-breathe');assert.equal(first.spin,'streaming-spin');assert.notEqual(first.transform,second.transform);assert.notEqual(first.background,second.background);
    await click('.floating-input-stop');await until(`sessions.get(${j(animationSession.id)}).nativeRuntime.state==='interrupted'`,'stop badge');await until('!document.querySelector("#msg-overlay .streaming-indicator")','badge removed');
    evidence.checks.push('redundant user avatar hidden; working badge breathes and ring rotates across real frames, disappears on stop');
    evidence.passed=true;
  }catch(error){evidence.error=error.stack;throw error}
  finally{if(c){try{await shot('last')}catch(e){evidence.captureError=e.message}await c.close()}if(hub){fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));evidence.exit=await gracefulQuit(hub)}fs.writeFileSync(path.join(out,'evidence.json'),j(evidence));console.log(j({out,passed:evidence.passed,checks:evidence.checks,error:evidence.error}))}
}
main().catch(e=>{console.error(e);process.exitCode=1});
