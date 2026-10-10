'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const port = () => new Promise(resolve => { const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const n=s.address().port;s.close(()=>resolve(n));}); });
async function main() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-writing-composer-'));
  const out=path.resolve('artifacts','20261010-writing-composer-'+Date.now()); fs.mkdirSync(out,{recursive:true});
  const home=path.join(root,'codex');fs.mkdirSync(home);
  fs.writeFileSync(path.join(home,'models_cache.json'),j({models:[{slug:'gpt-6-astra',additional_speed_tiers:['fast'],supported_reasoning_levels:[{effort:'low'},{effort:'high'}]},{slug:'gpt-6.1-sol',supported_reasoning_levels:[{effort:'low'},{effort:'high'}]}]}));
  const entry=path.join(root,'entry.cjs');
  fs.writeFileSync(entry,`const {app}=require('electron');app.commandLine.appendSwitch('use-fake-device-for-media-stream');app.commandLine.appendSwitch('use-fake-ui-for-media-stream');require(${j(path.resolve('main-bootstrap.js'))});`);
  const evidence={passed:false,checks:[],kind:'isolated Hub, real writing/group IPC; deterministic Codex and voice fixtures'};
  let hub,c;
  const check=(label,value)=>{assert(value,label);evidence.checks.push(label);console.log('PASS',label);};
  const wait=async(expression,label,timeout=45000)=>{
    const end=Date.now()+timeout;while(Date.now()<end){if(await c.eval(expression))return;await sleep(120);}throw Error('Timeout: '+label);
  };
  const click=async selector=>{
    const pos=await c.eval(`(()=>{const e=document.querySelector(${j(selector)});if(!e||e.disabled)throw Error('unavailable '+${j(selector)});e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!e.contains(document.elementFromPoint(x,y)))throw Error('covered '+${j(selector)});return{x,y};})()`);
    await c.send('Input.dispatchMouseEvent',{type:'mousePressed',...pos,button:'left',clickCount:1});
    await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',...pos,button:'left',clickCount:1});
  };
  const choose=async(selector,value)=>c.eval(`(()=>{const e=document.querySelector(${j(selector)});e.value=${j(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const shot=async name=>{const r=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(r.data,'base64'));};
  try {
    hub=await launchIsolatedHub({dataDir:path.join(root,'data'),port:await port(),windowMode:'hidden',entryPath:entry,extraEnv:{
      HUB_STARTUP_TRACE:'1',CODEX_HOME:home,CLAUDE_CONFIG_DIR:path.join(root,'claude'),
      CLAUDE_HUB_WRITING_ROOT:path.join(root,'writing'),CLAUDE_HUB_WRITING_SKILLS_DIR:path.join(root,'skills'),
      CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.resolve('tests/fixtures/codex-app-server.js'),
    }});
    c=await connectFirstPage(hub);
    let ready=false;c.ws.on('message',msg=>{if(String(msg).includes('renderer-sidebar-ready sent'))ready=true;});await c.send('Runtime.enable');
    for(let i=0;!ready&&i<200;i++)await sleep(100);assert(ready,'startup');
    await c.send('Emulation.setDeviceMetricsOverride',{width:1450,height:950,deviceScaleFactor:1,mobile:false});
    await sleep(400);
    await wait("typeof window.__writingShow==='function'",'writing loaded');
    c.ws.on('message',raw=>{try{const msg=JSON.parse(raw);if(msg.method==='Runtime.exceptionThrown')console.log('RENDERER_ERROR',JSON.stringify(msg.params));}catch{}});
    await c.eval(`window.__writingCalls=[];window.__voiceBytes=0;window.__voiceCancel=0;window.__originalInvoke=ipcRenderer.invoke.bind(ipcRenderer);
      ipcRenderer.invoke=async(channel,...args)=>{
        if(['create-meeting','groupchat:turn'].includes(channel))__writingCalls.push({channel,payload:args[0]});
        if(channel==='voice:config')return {engine:'streaming',keySet:true,prefs:{voiceSend:false}};
        if(channel==='voice:start'){setTimeout(()=>ipcRenderer.emit('voice:event',{}, {id:args[0].id,type:'done',text:'语音补充观点。'}),600);return {ok:true};}
        if(channel==='voice:audio'){__voiceBytes+=args[0].data.length;return {ok:true};}
        if(channel==='voice:cancel'){__voiceCancel++;return {ok:true};}
        if(channel==='voice:diag'||channel==='voice:stop')return {ok:true};
        if(channel==='prompt:polish')return {ok:true,text:'整理后的写作想法'};
        return __originalInvoke(channel,...args);
      };`);
    await click('#btn-writing');
    console.log('Writing clicked',await c.eval("({visible:document.querySelector('#writing-panel').style.display,classes:document.body.className})"));
    await wait("Boolean(document.querySelector('.wb-compose .writing-input'))",'writing composer');
    check('three configurable defaults',await c.eval("document.querySelectorAll('.writing-member-row').length===3"));
    check('shared voice, polish, reference, collapse controls',await c.eval("!!document.querySelector('.wb-compose .voice-mic')&&!!document.querySelector('.wb-compose .prompt-polish-button')&&!!document.querySelector('.wb-compose .composer-collapse')&&[...document.querySelectorAll('.wb-compose button')].some(b=>b.textContent==='引用会话')"));
    await click('.writing-member-row:last-child .writing-member-remove');
    await click('.writing-member-row:last-child .writing-member-remove');
    await choose('.writing-member-kind','codex');
    await choose('.writing-member-model','gpt-6-astra');
    await choose('.writing-member-effort','low');
    await choose('.writing-member-speed','standard');
    await click('.writing-members-head button');
    await choose('.writing-member-row:last-child .writing-member-model','gpt-6.1-sol');
    await click('.wb-compose .writing-input');await c.send('Input.insertText',{text:'请写一篇简短的文章，讨论协作。'});
    await click('.wb-compose .voice-mic');
    await wait("document.querySelector('.wb-compose .writing-input').innerText.includes('语音补充观点')",'voice transcript');
    check('microphone PCM processed into the writing draft',await c.eval('__voiceBytes>0'));
    await click('.wb-compose .prompt-polish-button');
    await wait("document.querySelector('.wb-compose .writing-input').innerText==='整理后的写作想法'",'polished draft');
    await click('.wb-compose .prompt-polish-undo');
    check('polish undo restores the voice draft',await c.eval("document.querySelector('.wb-compose .writing-input').innerText.includes('语音补充观点')"));
    const file=path.join(root,'writing-material.txt');fs.writeFileSync(file,'fixture material');
    const dom=await c.send('DOM.getDocument');const fileNode=await c.send('DOM.querySelector',{nodeId:dom.root.nodeId,selector:'.wb-compose input[type=file]'});
    await c.send('DOM.setFileInputFiles',{nodeId:fileNode.nodeId,files:[file]});
    await wait(`document.querySelector('.wb-compose .writing-input').innerText.includes(${j(file)})`,'file attachment');
    await click('.wb-compose .composer-collapse');
    check('collapse and expand are available',await c.eval("document.querySelector('.writing-composer').classList.contains('composer-is-collapsed')"));
    await click('.wb-compose .composer-expand');
    const draft=await c.eval("document.querySelector('.wb-compose .writing-input').innerText");
    await click('#btn-home');await click('#btn-writing');
    check('navigation preserves draft and member models',await c.eval(`document.querySelector('.wb-compose .writing-input').innerText===${j(draft)}&&document.querySelectorAll('.writing-member-row').length===2&&document.querySelector('.writing-member-row:last-child .writing-member-model').value==='gpt-6.1-sol'`));
    await shot('new-article-desktop');
    await c.send('Emulation.setDeviceMetricsOverride',{width:960,height:800,deviceScaleFactor:1,mobile:false});await sleep(300);await shot('new-article-phone-width');
    check('input controls stay within writing pane',await c.eval("(()=>{const r=document.querySelector('.writing-composer').getBoundingClientRect();return r.right<=innerWidth&&r.left>=0;})()"));
    await click('.wb-compose .floating-input-send');
    await wait("Boolean(document.querySelector('.wb .writing-input'))",'article workbench',90000);
    const calls=await c.eval('__writingCalls');const created=calls.find(x=>x.channel==='create-meeting');
    check('real create-meeting receives selected members and model',created.payload.slots.length===2&&created.payload.slots[0].kind==='codex'&&created.payload.slots[0].model==='gpt-6-astra'&&created.payload.slots[0].effort==='low'&&created.payload.slots[1].model==='gpt-6.1-sol');
    check('member speed selection reaches the group',created.payload.slots[0].codexSpeedTier==='standard');
    check('initial message uses existing group send pipeline',calls.some(x=>x.channel==='groupchat:turn'&&x.payload.userInput.includes(draft)));
    check('review uses shared voice and member selection',await c.eval("document.querySelectorAll('.writing-recipient').length===2&&!!document.querySelector('.wb-basket .voice-mic')"));
    await wait("[...sessions.values()].filter(s=>s.meetingId).every(s=>s.status!=='running')",'group idle');
    await click('.writing-recipient:first-of-type');
    await click('.wb-basket .writing-input');await c.send('Input.insertText',{text:'只请选中的成员调整开头。'});
    await click('.wb-basket .floating-input-send');
    await wait("__writingCalls.filter(x=>x.channel==='groupchat:turn').length>=2",'selected recipient send');
    const last=await c.eval("__writingCalls.filter(x=>x.channel==='groupchat:turn').at(-1).payload");
    check('review sends only to selected member',last.recipientSids?.length===1&&last.userInput.includes('调整开头'));
    await shot('review-member-selection');evidence.passed=true;
  } catch(error){evidence.error=error.stack;if(c){evidence.ui=await c.eval("document.querySelector('#writing-panel')?.innerText").catch(()=>null);await shot('failure').catch(()=>{});}throw error;}
  finally {try{if(c)await c.close();if(hub){fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));await gracefulQuit(hub);}}finally{fs.writeFileSync(path.join(out,'checks.json'),JSON.stringify(evidence,null,2));console.log('ARTIFACT_ROOT',out);}}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
