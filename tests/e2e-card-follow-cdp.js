'use strict';
// Actual isolated Electron + native App Server fixture; shell check uses real PowerShell.
const assert=require('node:assert/strict'),fs=require('node:fs'),net=require('node:net'),os=require('node:os'),path=require('node:path');
const {connectFirstPage}=require('./helpers/cdp-client');
const {launchIsolatedHub,gracefulQuit,_waitMs}=require('./helpers/hub-launcher');
const ROOT=path.resolve(__dirname,'..');
const TEMP_ROOT=fs.mkdtempSync(path.join(os.tmpdir(),'hub-pty-design-'));
const ARTIFACT_DIR=path.join(ROOT,'output/playwright/card-follow');
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
 const gap=()=>client.eval('(()=>{const e=document.getElementById("msg-overlay");return {top:e.scrollTop,gap:e.scrollHeight-e.clientHeight-e.scrollTop,height:e.clientHeight,cards:e.querySelectorAll(".turn-card").length,following:e._cardFollowController?.isFollowing()};})()');
 const size=height=>client.send('Emulation.setDeviceMetricsOverride',{width:1300,height,deviceScaleFactor:0,mobile:false});
 try{
  hub=await launchIsolatedHub({dataDir:path.join(TEMP_ROOT,'data'),port:await reservePort(),label:'card-follow',windowMode:'hidden',extraEnv:{CLAUDE_HUB_NATIVE_FIXTURE_STORE:path.join(TEMP_ROOT,'fixture.json'),AI_HUB_WORKSPACE_ROOT:TEMP_ROOT,CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.join(ROOT,'tests/fixtures/codex-app-server.js')}});
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
  if(process.env.HUB_SCROLL_BASELINE==='1'){
    await _waitMs(7000);result.samples.push({stage:'final',...await gap()});
    await screenshot(client,path.join(ARTIFACT_DIR,'baseline.png'));
    result.passed=false;return;
  }
  assert((await gap()).gap<=3,'follows latest through viewport shrink');
  const beforeWheel=await gap();
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
  await waitFor('second sidebar rendered',()=>client.eval(`document.querySelector('.session-item.selected')?.dataset.sessionId===${JSON.stringify(second.id)}`));
  await clickPoint(client,`.session-item[data-session-id="${session.id}"] .sl-title`);
  result.navigation=await client.eval('({active:activeSessionId, sessions:[...sessions.values()].map(s=>({id:s.id,status:s.status})),capture:cardFollowScroll.capture()})');
  await waitFor('restored reader',async()=>{
    const current=await gap();return current.cards>=40&&Math.abs(current.top-reading.top)<5;
  });
  result.samples.push({stage:'session restored',...await gap()});
  assert.equal((await gap()).following,false);
  await clickPoint(client,'#card-jump-latest');await waitFor('latest restored',async()=>(await gap()).gap<=3);
  result.passed=true;
 }finally{
  if(client){result.final=await gap();await screenshot(client,path.join(ARTIFACT_DIR,'final.png'));await client.close();}if(hub)await gracefulQuit(hub);
  fs.writeFileSync(path.join(ARTIFACT_DIR,process.env.HUB_SCROLL_BASELINE==='1'?'baseline.json':'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
