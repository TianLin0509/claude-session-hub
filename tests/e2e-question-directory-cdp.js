'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');

const ROOT = path.resolve(__dirname, '..');
const RUN_ID = `${Date.now()}-${process.pid}`;
const TEMP_ROOT = path.join(os.tmpdir(), `hub-projlib-${RUN_ID}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const HOME_DIR = path.join(TEMP_ROOT, 'home');
const WORKSPACE_ROOT = path.join(TEMP_ROOT, 'AIWork');
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'question-directory');

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
 for(const dir of [DATA_DIR,WORKSPACE_ROOT,ARTIFACT_DIR])fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(WORKSPACE_ROOT,'.aiwork-root'),'');const workspace=path.join(WORKSPACE_ROOT,'demo');fs.mkdirSync(workspace);
 fs.writeFileSync(path.join(workspace,'card-delivery.html'),'<!doctype html><meta charset="utf-8"><h1>目录验收产物</h1>');
 let hub,client;const result={checks:[]};
 const invoke=(channel,payload)=>{if(channel!=='groupchat:get-state')console.log(channel);return client.eval('ipcRenderer.invoke('+JSON.stringify(channel)+','+JSON.stringify(payload)+')');};
 const shot=name=>screenshot(client,path.join(ARTIFACT_DIR,name+'.png'));
 const size=(width)=>client.send('Emulation.setDeviceMetricsOverride',{width,height:950,deviceScaleFactor:0,mobile:false});
 try{
 hub=await launchIsolatedHub({dataDir:DATA_DIR,port:await reservePort(),label:'question-directory',windowMode:'hidden',extraEnv:{AI_HUB_WORKSPACE_ROOT:WORKSPACE_ROOT,CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.join(ROOT,'tests/fixtures/codex-app-server.js')}});
 client=await connectFirstPage(hub);await size(1500);await waitFor('renderer',()=>client.eval('!!window.MeetingRoom'));
 console.log('renderer ready');
 client.ws.on('message', raw => { const m=JSON.parse(raw); if(m.method==='Runtime.consoleAPICalled' && m.params.args.some(a=>String(a.value).includes('Markdown rendering failed'))) { result.markdownErrors=(result.markdownErrors||0)+1; console.log('MARKDOWN ERROR',m.params.args.map(a=>a.value)); } });
 await client.send('Runtime.enable');

 const model={kind:'codex',model:'gpt-6-astra',effort:'high',mcpProfile:'none'};
 const ordinary=await invoke('create-session',{kind:'codex',opts:{...model,cwd:workspace}});
 const group=await invoke('create-meeting',{title:'问题目录与卡片能力验收',scene:'general',workspace,slots:[model]});
 await waitFor('native ready',()=>client.eval(`${JSON.stringify(group.subSessions)}.every(id=>!!sessions.get(id)?.nativeRuntime?.threadId)`));
 await clickPoint(client,'[data-meeting-id="'+group.id+'"]');
 await waitFor('visible composer',()=>client.eval('document.querySelector("#mr-input-box")?.getBoundingClientRect().height>0'));
 for(let i=0;i<3;i++){
 console.log('send '+i);

 await clickPoint(client,'#mr-input-box');await client.send('Input.insertText',{text:'fixture:card-details 第 '+(i+1)+' 个问题：请查看 https://example.com/docs ，以及 `https://example.com/inline`，保留交付结果。'});await clickPoint(client,'#mr-send-btn');
 await waitFor('group reply '+i,async()=>{const s=await invoke('groupchat:get-state',{meetingId:group.id});return s?.currentMode==='idle' && s.messages?.filter(m=>m.role==='assistant').length>=i+1;});
 }
 await waitFor('three user cards',()=>client.eval('document.querySelectorAll(".mr-gc-msg.mine").length===3'));
 result.before=await client.eval(`(()=>{const el=document.querySelector('.mr-gc-messages');return {userLinks:el.querySelectorAll('.mine a').length,delivery:el.querySelectorAll('.turn-delivery-summary').length,gap:el.scrollHeight-el.clientHeight-el.scrollTop,assistantLinks:el.querySelectorAll('.ai a.rt-file-link').length}})()`);
 await size(900);await _waitMs(600);result.halfGap=await client.eval("(()=>{const e=document.querySelector('.mr-gc-messages');return e.scrollHeight-e.clientHeight-e.scrollTop})()");
 if(process.env.HUB_DIRECTORY_BASELINE==='1'){result.baseline=true;await shot('baseline-half');return;}
 assert(result.before.userLinks>=6,'group user URLs should be clickable');assert(result.before.delivery>=3,'group delivery summaries');assert(result.halfGap<8,'resize stays at latest');

 const groupNav='#mr-question-nav';
 const collapsed=()=>client.eval(`document.querySelector('${groupNav}').classList.contains('directory-collapsed')`);
 assert(await collapsed(),'half window auto collapses');
 await size(1500);await waitFor('wide directory',async()=>!await collapsed());
 assert.equal(await client.eval(`document.querySelectorAll('${groupNav} .card-question-nav-item').length`),3);
 assert(await client.eval("document.querySelectorAll('.mr-gc-messages .turn-delivery-check.status-failed').length>0"),'failed validation remains visible');
 await shot('group-wide');
 await clickPoint(client,groupNav+' .question-directory-toggle');assert(await collapsed());
 await invoke('update-meeting-sync',{meetingId:group.id,fields:{title:'目录偏好保持'}});
 await waitFor('updated group title',()=>client.eval(`meetings[${JSON.stringify(group.id)}].title==='目录偏好保持'`));assert(await collapsed());
 await clickPoint(client,groupNav+' .question-directory-toggle');assert(!await collapsed());
 await size(900);await waitFor('auto narrow',collapsed);await shot('group-half');
 await clickPoint(client,groupNav+' .question-directory-toggle');assert(!await collapsed(),'manual expansion available in narrow view');
 await size(1500);await waitFor('wide preference restored',async()=>!await collapsed());
 await clickPoint(client,groupNav+' [data-question-index="1"]');await _waitMs(500);
 assert.equal(await client.eval("document.querySelector('.mr-gc-messages')._cardFollowController.isFollowing()"),false);
 const reading=await client.eval("document.querySelector('.mr-gc-messages').scrollTop");
 await size(900);await _waitMs(400);
 assert.equal(await client.eval("document.querySelector('.mr-gc-messages')._cardFollowController.isFollowing()"),false);
 assert(await client.eval("(()=>{const e=document.querySelector('.mr-gc-messages');return e.scrollHeight-e.clientHeight-e.scrollTop})()")>40);
 await size(1500);await _waitMs(400);
 assert(Math.abs(await client.eval("document.querySelector('.mr-gc-messages').scrollTop")-reading)<12);
 await clickPoint(client,groupNav+' [data-directory-action="up"]');await _waitMs(120);
 const up=await client.eval("document.querySelector('.mr-gc-messages').scrollTop");assert(up<reading);
 await clickPoint(client,groupNav+' [data-directory-action="down"]');await _waitMs(120);assert(await client.eval("document.querySelector('.mr-gc-messages').scrollTop")>up);
 await clickPoint(client,groupNav+' [data-directory-action="latest"]');await _waitMs(150);
 assert(await client.eval("document.querySelector('.mr-gc-messages')._cardFollowController.isFollowing()"));
 result.checks.push('group directory: default open, manual fold survives updates, auto narrow and wide restore, narrow manual override, question jump, up/down/latest and reading intent');
 const markdown=await client.eval("(()=>{const e=document.querySelector('.mr-gc-msg.ai:last-child [data-phase=final_answer]');return {code:e.querySelector('code')?.textContent,link:[...e.querySelectorAll('a')].some(a=>a.classList.contains('rt-file-link') && a.dataset.path.endsWith('card-delivery.html'))}})()");
 assert.equal(markdown.code,'src/card-example.js');assert(markdown.link,'Markdown relative artifact links are previewable');
 assert(await client.eval("window.__mrRenderMarkdown('公式 $x^2$').includes('katex')"),'group math matches ordinary cards');
 // Open a real artifact through the same delegated preview used by ordinary cards.
 await clickPoint(client,'.mr-gc-msg.ai:last-child .turn-delivery-summary > summary');
 await clickPoint(client,'.mr-gc-msg.ai:last-child .turn-delivery-artifact a');
 await waitFor('artifact preview',()=>client.eval("document.querySelector('#preview-panel').style.display==='flex' && document.querySelector('#preview-title').title.includes('card-delivery.html')"));
 await shot('group-delivery-preview');await clickPoint(client,'#preview-close');
 await invoke('update-meeting-sync',{id:group.id,title:'交付展开状态保留'});await _waitMs(250);
 assert(await client.eval("document.querySelector('.mr-gc-msg.ai:last-child .turn-delivery-summary').open"));
 result.checks.push('group delivery includes file changes, success/failure checks and real local artifact preview');
 await clickPoint(client,'[data-session-id="'+ordinary.id+'"]');
 await waitFor('ordinary composer',()=>client.eval("document.querySelector('.floating-input-box')?.getBoundingClientRect().height>0"));
 for(let i=0;i<3;i++){
 await clickPoint(client,'.floating-input-box');await client.send('Input.insertText',{text:'fixture:card-details 普通问题 '+(i+1)+' https://example.com/docs'});await clickPoint(client,'.floating-input-send');
 await waitFor('ordinary final '+i,()=>client.eval(`document.querySelectorAll('#msg-overlay .turn-delivery-summary').length>=${i+1} && sessions.get(${JSON.stringify(ordinary.id)}).nativeRuntime.state!=='running'`));
 }
 await waitFor('ordinary questions',()=>client.eval("document.querySelectorAll('#card-question-nav .card-question-nav-item').length===3"));
 assert(!await client.eval("document.querySelector('#card-question-nav').classList.contains('directory-collapsed')"));
 result.ordinaryWide=await client.eval("(()=>{const e=document.querySelector('#msg-overlay');return {...e._cardFollowController.capture(),gap:e.scrollHeight-e.clientHeight-e.scrollTop}})()");
 await shot('ordinary-wide');await size(900);await _waitMs(500);
 result.ordinaryHalfState=await client.eval("document.querySelector('#msg-overlay')._cardFollowController.capture()");
 result.ordinaryHalfGap=await client.eval("(()=>{const e=document.querySelector('#msg-overlay');return e.scrollHeight-e.clientHeight-e.scrollTop})()");assert(result.ordinaryHalfGap<8);
 assert(await client.eval("document.querySelector('#card-question-nav').classList.contains('directory-collapsed')"));
 await size(1500);await _waitMs(250);await clickPoint(client,'#card-question-nav .question-directory-toggle');
 await client.send('Page.reload');await waitFor('reload renderer',()=>client.eval('!!window.MeetingRoom && !!window.LaunchCenter'));
 await clickPoint(client,'[data-session-id="'+ordinary.id+'"]');
 await waitFor('ordinary cards restored',()=>client.eval("document.querySelectorAll('#card-question-nav .card-question-nav-item').length===3"));
 assert(await client.eval("document.querySelector('#card-question-nav').classList.contains('directory-collapsed')"),'manual preference persists through reload');
 await clickPoint(client,'#card-question-nav .question-directory-toggle');
 await clickPoint(client,'#btn-theme');await clickPoint(client,'[data-theme-id="codex"]');await clickPoint(client,'#btn-theme');await shot('ordinary-light');
 await clickPoint(client,'[data-meeting-id="'+group.id+'"]');await waitFor('group visible after reload',()=>client.eval("document.querySelector('#mr-question-nav')?.getBoundingClientRect().height>0"));await shot('group-light');
 result.checks.push('ordinary session default directory, native replies and delivery retained, half window follows latest, manual fold persists through reload; light theme in both views');
 assert.equal(result.markdownErrors || 0,0);result.passed=true;
 }finally{if(client){try{if(!result.passed&&!result.baseline){result.debug=await client.eval("({html:document.querySelector('.mr-gc-messages')?.innerHTML?.slice(-9000)})");await shot('failure');}}catch(error){result.debugError=error.message;}finally{await client.close();}}if(hub)await gracefulQuit(hub);fs.writeFileSync(path.join(ARTIFACT_DIR,result.baseline?'baseline.json':'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));}
}
main().catch(e=>{console.error(e);process.exitCode=1});
