'use strict';
// Regression: inactive composer disposal must not hide the current answer.
// Real isolated Hub UI and IPC with a deterministic native App Server fixture.
const assert=require('node:assert/strict'),fs=require('node:fs'),net=require('node:net'),os=require('node:os'),path=require('node:path');
const {connectFirstPage}=require('./helpers/cdp-client');
const {launchIsolatedHub,gracefulQuit,_waitMs}=require('./helpers/hub-launcher');
const ROOT=path.resolve(__dirname,'..');
const TEMP_ROOT=fs.mkdtempSync(path.join(os.tmpdir(),'hub-card-bottom-'));
const ARTIFACT_DIR=path.resolve(process.env.HUB_BOTTOM_OUT || 'artifacts/session-ui-bounds/card-bottom');
function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitFor(label, fn, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) { last = error; }
    await _waitMs(120);
  }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${last.message}` : ''}`);
}

async function clickPoint(client, selector) {
  await client.eval(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:"center"})`);
  const point = await client.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { found: false };
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { found: true, x, y, visible: rect.width > 0 && rect.height > 0, topmost: hit === el || el.contains(hit), hit: hit && (hit.tagName + '.' + hit.className) };
  })()`);
  assert.equal(point.found, true, `${selector} should exist`);
  assert.equal(point.visible, true, `${selector} should be visible`);
  assert.equal(point.topmost, true, `${selector} should be topmost; hit=${point.hit}`);
  await client.send('Page.bringToFront');
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}

async function screenshot(client, target) {
  const shot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.writeFileSync(target, Buffer.from(shot.data, 'base64'));
}



async function main(){
 fs.mkdirSync(ARTIFACT_DIR,{recursive:true});const workspace=path.join(TEMP_ROOT,'project');fs.mkdirSync(workspace);
 let hub,client;const result={passed:false,samples:[]};
 const gap=()=>client.eval('(()=>{const e=document.getElementById("msg-overlay");return {top:e.scrollTop,gap:e.scrollHeight-e.clientHeight-e.scrollTop,height:e.clientHeight,cards:e.querySelectorAll(".turn-card").length,following:e._cardFollowController?.isFollowing(),chrome:getComputedStyle(document.getElementById("terminal-panel")).getPropertyValue("--fi-bar-h"),rects:Object.fromEntries(["#msg-overlay","#card-question-nav",".floating-input-bar",".composer","#msg-overlay > .turn-card:last-child"].map(s=>{const n=document.querySelector(s),r=n?.getBoundingClientRect();return [s,r?{top:r.top,bottom:r.bottom,height:r.height}:null]}))};})()');
 const size=height=>client.send('Emulation.setDeviceMetricsOverride',{width:1300,height,deviceScaleFactor:0,mobile:false});
 try{
  hub=await launchIsolatedHub({dataDir:path.join(TEMP_ROOT,'data'),port:await reservePort(),label:'card-bottom-visibility',windowMode:'hidden',extraEnv:{CLAUDE_HUB_NATIVE_FIXTURE_STORE:path.join(TEMP_ROOT,'fixture.json'),AI_HUB_WORKSPACE_ROOT:TEMP_ROOT,CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.join(ROOT,'tests/fixtures/codex-app-server.js')}});
  client=await connectFirstPage(hub);result.console=[];
  client.ws.on('message',raw=>{const event=JSON.parse(String(raw));if(event.method==='Runtime.consoleAPICalled'&&['error','warning'].includes(event.params.type))result.console.push(event.params.args.map(a=>a.value||a.description).join(' '));});
  await client.send('Runtime.enable');await size(900);await waitFor('ready',()=>client.eval('!!window.LaunchCenter'));
  const session=await client.eval('ipcRenderer.invoke("create-session",'+JSON.stringify({kind:'codex',opts:{cwd:workspace,model:'gpt-6-astra',effort:'high',mcpProfile:'none'}})+')');
  await waitFor('welcome',()=>client.eval('!!document.querySelector(".session-welcome")'));
  await clickPoint(client,'.floating-input-box');await client.send('Input.insertText',{text:'fixture:scroll'});await clickPoint(client,'.floating-input-send');
  await waitFor('content',async()=>(await gap()).cards>=8);
  result.samples.push({stage:'stream',...await gap()});
  await size(650);await _waitMs(700);
  result.samples.push({stage:'resize',...await gap()});
  assert((await gap()).gap<=3,'follows latest through viewport shrink');
  await client.eval('window.__wheelEnded=false;document.getElementById("msg-overlay").addEventListener("wheel",()=>window.__wheelStartTop=document.getElementById("msg-overlay").scrollTop,{once:true});document.getElementById("msg-overlay").addEventListener("scrollend",()=>window.__wheelEnded=true,{once:true});');
  const point=await client.eval('(()=>{const r=document.getElementById("msg-overlay").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()');
  await client.send('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaY:-380,deltaX:0});await waitFor('wheel settled',()=>client.eval('window.__wheelEnded&&document.getElementById("msg-overlay").scrollTop<window.__wheelStartTop-350'));
  const held=await gap();result.samples.push({stage:'held',...held});assert(held.gap>200,'user scroll moved away');
  await _waitMs(1200);const after=await gap();result.samples.push({stage:'reading',...after});
  assert(Math.abs(after.top-held.top)<5,'stream does not move reader');
  await clickPoint(client,'#card-jump-latest');await waitFor('jump reattaches',async()=>(await gap()).gap<=3);
  await waitFor('final answer',()=>client.eval('document.getElementById("msg-overlay").innerText.includes("滚动验收结束")'));await waitFor('completion stays at bottom',async()=>(await gap()).gap<=3);
  await screenshot(client,path.join(ARTIFACT_DIR,'following.png'));
  await client.eval('window.__wheelEnded=false;document.getElementById("msg-overlay").addEventListener("scrollend",()=>window.__wheelEnded=true,{once:true})');
  await client.send('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaY:-500,deltaX:0});
  await waitFor('idle reader',async()=>await client.eval('window.__wheelEnded')&&(await gap()).gap>450);
  const reading=await gap();result.samples.push({stage:'before switch',...reading});
  const second=await client.eval('ipcRenderer.invoke("create-session",'+JSON.stringify({kind:'codex',opts:{cwd:workspace,model:'gpt-6-astra',effort:'high',mcpProfile:'none'}})+')');
  await waitFor('second welcome',()=>client.eval('!!document.querySelector(".session-welcome")'));
  await clickPoint(client,'.floating-input-box');await client.send('Input.insertText',{text:'second session reply'});await clickPoint(client,'.floating-input-send');
  await waitFor('second answered',()=>client.eval('document.getElementById("msg-overlay").innerText.includes("second session reply") && !!document.querySelector("#msg-overlay .turn-card.assistant")'));
  await client.eval('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  await waitFor('second sidebar rendered',()=>client.eval(`document.querySelector('.session-item.selected')?.dataset.sessionId===${JSON.stringify(second.id)}`));
  await clickPoint(client,`.session-item[data-session-id="${session.id}"] .sl-title`);
  result.navigation=await client.eval('({active:activeSessionId, sessions:[...sessions.values()].map(s=>({id:s.id,status:s.status})),capture:cardFollowScroll.capture()})');
  await waitFor('restored reader',async()=>{
    const current=await gap();return current.cards>=40&&Math.abs(current.top-reading.top)<5;
  });
  result.samples.push({stage:'session restored',...await gap()});
  assert.equal((await gap()).following,false);
  await clickPoint(client,'#card-jump-latest');await waitFor('latest restored',async()=>(await gap()).gap<=3);
  // Drain mount/ResizeObserver frames before closing B: a pending callback
  // from A can temporarily repair the old bug and produce a false pass.
  await client.eval('new Promise(resolve => {let frames=0;function next(){if(++frames===6)resolve();else requestAnimationFrame(next)}requestAnimationFrame(next)})');
  await client.eval('ipcRenderer.invoke("close-session",'+JSON.stringify(second.id)+')');
  await waitFor('background session closed',()=>client.eval('sessions.get('+JSON.stringify(second.id)+')?.status === "dormant"'));
  await client.eval('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  result.samples.push({stage:'background closed',...await gap()});
  const geometry=(await gap()).rects;
  assert(geometry['#msg-overlay'].bottom <= geometry['.floating-input-bar'].top + 1, 'message viewport must end above the composer after closing another session');
  assert(geometry['#card-question-nav'].bottom <= geometry['.floating-input-bar'].top + 1, 'directory must not cover the composer');
  assert(geometry['#msg-overlay > .turn-card:last-child'].bottom <= geometry['#msg-overlay'].bottom + 1, 'complete final card must be inside the visible message viewport');
  result.beforeDraft=await gap();
  await clickPoint(client,'.floating-input-box');
  await client.send('Input.insertText',{text:Array.from({length:8},(_,i)=>'Multiline draft '+i).join('\n')});
  await waitFor('multiline draft scrolls inside fixed space',async()=>{
    const state=await gap(),r=state.rects;
    return state.gap<=3 && state.chrome===result.beforeDraft.chrome && r['#msg-overlay'].bottom<=r['.composer'].top+1;
  });
  const drafted=await gap();
  result.samples.push({stage:'multiline draft',...drafted});
  assert.deepEqual(drafted.rects['#card-question-nav'],result.beforeDraft.rects['#card-question-nav'],'typing must not move or resize the directory');
  result.input=await client.eval(`(()=>{const e=document.querySelector('.floating-input-box'),s=getComputedStyle(e);return {height:e.clientHeight,scrollHeight:e.scrollHeight,lineHeight:parseFloat(s.lineHeight),padding:parseFloat(s.paddingTop)+parseFloat(s.paddingBottom),text:e.innerText}})()`);
  assert(result.input.scrollHeight>result.input.height,'long draft must scroll internally');
  assert(Math.abs(result.input.height-result.input.padding-2*result.input.lineHeight)<2,'input reserves exactly two text lines');
  assert(result.input.text.includes('Multiline draft 7'),'long draft is preserved');
  await size(900);
  await waitFor('expanded viewport follows final card',async()=>{
    const state=await gap(),r=state.rects;
    return state.gap<=3 && r['#msg-overlay > .turn-card:last-child'].bottom<=r['#msg-overlay'].bottom+1;
  });
  result.samples.push({stage:'expanded viewport',...await gap()});
  result.passed=true;
 }finally{
  if(client){result.final=await gap();await screenshot(client,path.join(ARTIFACT_DIR,'final.png'));await client.close();}if(hub)await gracefulQuit(hub);
  fs.writeFileSync(path.join(ARTIFACT_DIR,'evidence.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
