'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {launchIsolatedHub,gracefulQuit,_waitMs}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const ROOT=path.resolve(__dirname,'..');
const OUT=path.join(ROOT,'output/playwright/image-alert');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'hub-image-alert-'));
const port=()=>new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
async function main(){
  fs.mkdirSync(OUT,{recursive:true});
  for(const name of ['claude','codex'])fs.mkdirSync(path.join(temp,name),{recursive:true});
  const result={checks:[],passed:false};let hub,c;
  const invoke=(channel,payload)=>c.eval(`ipcRenderer.invoke(${JSON.stringify(channel)},${JSON.stringify(payload)})`);
  const until=async(label,fn)=>{const end=Date.now()+45000;while(Date.now()<end){if(await fn())return;await _waitMs(100);}throw Error('timeout: '+label);};
  const row=id=>`.session-item[data-session-id="${id}"]`;
  const runtime=id=>c.eval(`sessions.get(${JSON.stringify(id)})?.nativeRuntime`);
  const section=id=>c.eval(`(()=>{let e=document.querySelector(${JSON.stringify(row(id))});while(e && e.parentElement.id!=='session-list')e=e.parentElement;while(e && !e.classList.contains('session-sec-header'))e=e.previousElementSibling;return e?.className || '';})()`);
  async function click(selector){
    await until('visible '+selector,()=>c.eval(`!!document.querySelector(${JSON.stringify(selector)})`));
    const p=await c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',...p});
    await c.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p});
    await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...p});
  }
  async function send(text){
    await click('.floating-input-box');await c.send('Input.insertText',{text});
    await c.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    await c.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  }
  async function shot(name){const s=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(OUT,name+'.png'),Buffer.from(s.data,'base64'));}
  async function create(kind,title){const s=await invoke('create-session',{kind,opts:{cwd:temp,title,mcpProfile:'none',model:kind==='codex'?'gpt-6-astra':'claude-opus-5[1m]'}});await until(title,async()=> (await runtime(s.id))?.connection==='connected');return s.id;}
  try{
    hub=await launchIsolatedHub({dataDir:path.join(temp,'data'),port:await port(),windowMode:'hidden',label:'image-alert',extraEnv:{
      CLAUDE_CONFIG_DIR:path.join(temp,'claude'),CODEX_HOME:path.join(temp,'codex'),
      CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.join(ROOT,'tests/fixtures/codex-app-server.js'),
      CLAUDE_HUB_NATIVE_FIXTURE_STORE:path.join(temp,'threads.json'),
      CLAUDE_HUB_CLAUDE_STREAM_FIXTURE:path.join(ROOT,'tests/fixtures/claude-stream.js'),
      CLAUDE_HUB_CLAUDE_FIXTURE_MODE:'crash-once'}});
    c=await connectFirstPage(hub);await until('renderer',()=>c.eval('!!window.WorkspaceController'));
    await c.send('Emulation.setDeviceMetricsOverride',{width:1500,height:980,deviceScaleFactor:1,mobile:false});
    const image=await create('codex','图片载荷恢复验证');await click(row(image));await send('fixture:large-image');
    await until('image completed',async()=> (await runtime(image))?.state==='completed');
    const before=await runtime(image);assert.equal(before.connection,'connected');
    assert.equal((await invoke('suspend-session',{sessionId:image})).ok,true);
    await until('image dormant',()=>c.eval(`sessions.get(${JSON.stringify(image)})?.status==='dormant'`));
    await click(row(image));await until('resume image history',async()=> (await runtime(image))?.connection==='connected');
    const after=await runtime(image);assert.equal(after.threadId,before.threadId);assert.equal(after.turnId,before.turnId);
    await until('restored answer',()=>c.eval(`document.body.innerText.includes('图片生成完成，文字历史保留')`));
    assert.equal(await c.eval(`document.body.innerText.includes('iVBORw0KGgo')`),false);
    result.checks.push('34 MiB generated image: live receive, sleep, click resume, exact thread/turn and text preserved without base64');
    await shot('image-resumed');
    const codex=await create('codex','Codex 异常中断'),claude=await create('claude','Claude 异常中断');
    await click(row(codex));await send('fixture:crash-before');
    await until('Codex disconnected',async()=> (await runtime(codex))?.connection==='disconnected');
    await until('Codex exceptional section',async()=>/sec-failed/.test(await section(codex)));
    await click(row(claude));await send('测试 Claude 进程异常退出');
    await until('Claude disconnected',async()=> (await runtime(claude))?.connection==='disconnected');
    await until('Claude exceptional section',async()=>/sec-failed/.test(await section(claude)));
    assert.equal(await c.eval(`document.querySelector('.sec-failed .sec-count').textContent`),'2');
    const appearance=await c.eval(`(${JSON.stringify([codex,claude])}).map(id=>{const e=document.querySelector('.session-item[data-session-id="'+id+'"]');return {classes:e.className,dot:e.querySelector('.sl-dot').getAttribute('aria-label'),shadow:getComputedStyle(e).boxShadow};})`);
    for(const a of appearance){assert.match(a.classes,/runtime-error/);assert.equal(a.dot,'运行异常');assert.notEqual(a.shadow,'none');}
    result.appearance=appearance;await shot('both-disconnected');
    await click('#btn-theme');await click('[data-theme-id="codex"]');await click('#btn-theme');
    assert.notEqual(await c.eval(`getComputedStyle(document.querySelector(${JSON.stringify(row(claude))})).boxShadow`),'none');
    await shot('light-disconnected');
    await click('.sec-failed .sec-collapse');await until('collapsed',()=>c.eval(`!document.querySelector(${JSON.stringify(row(codex))})`));
    assert.equal(await c.eval(`document.querySelector('.sec-failed .sec-count').textContent`),'2');
    await click('.sec-failed .sec-collapse');await until('expanded',()=>c.eval(`!!document.querySelector(${JSON.stringify(row(codex))})`));
    result.checks.push('Codex and Claude OS-pipe crashes reach red exception group; selected row stays red; collapse keeps red count');
    await click(row(claude));await send('恢复后继续');
    await until('Claude recovered',async()=> (await runtime(claude))?.state==='completed');
    await until('Claude alert cleared',async()=> !/sec-failed/.test(await section(claude)));
    await click(row(codex));await send('fixture:empty');
    await until('Codex recovered',async()=> (await runtime(codex))?.state==='completed');
    await until('no exceptions',()=>c.eval(`!document.querySelector('.sec-failed')`));
    result.checks.push('actual composer send recovers both native sessions; alert clears from authoritative snapshots');
    await send('fixture:hold');await until('working',async()=> (await runtime(codex))?.state==='running');
    await click('.floating-input-stop');await until('stopped',async()=> (await runtime(codex))?.state==='interrupted');
    assert.equal(await c.eval(`!!document.querySelector('.sec-failed')`),false);
    result.checks.push('user Stop is not classified as abnormal');
    await shot('recovered');
    const group=await invoke('create-meeting',{title:'群聊成员异常验证',scene:'general',workspace:temp,slots:[
      {kind:'codex',model:'gpt-6-astra',mcpProfile:'none'},
      {kind:'claude',model:'claude-opus-5[1m]',mcpProfile:'none'}]});
    await until('members ready',async()=> (await runtime(group.subSessions[0]))?.connection==='connected' && (await runtime(group.subSessions[1]))?.connection==='connected');
    await invoke('session:send-prompt',{sessionId:group.subSessions[0],text:'fixture:failed'});
    await until('group exception',()=>c.eval(`!!document.querySelector('[data-meeting-id="${group.id}"].runtime-error .sl-group-icon.error')`));
    await click('#btn-session-details');
    await until('member red',()=>c.eval(`!!document.querySelector(${JSON.stringify(row(group.subSessions[0])+'.runtime-error .sl-dot.error')})`));
    assert.equal((await runtime(group.subSessions[1])).connection,'connected');
    await click(row(group.subSessions[0]));await shot('group-member-error');
    result.checks.push('mixed Codex/Claude group aggregates failed member; expanded member is red and remains directly openable');
    result.passed=true;
  }finally{
    if(c){if(!result.passed){result.debug=await c.eval(`({sessions:[...sessions.values()].map(s=>({id:s.id,title:s.title,status:s.status,native:s.nativeRuntime})),body:document.body.innerText.slice(-4000)})`).catch(e=>({error:e.message}));await shot('failure').catch(()=>{});}await c.close();}
    if(hub){fs.writeFileSync(path.join(OUT,'hub.log'),hub.log().join('\n'));result.exit=await gracefulQuit(hub);}
    fs.writeFileSync(path.join(OUT,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  }
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
