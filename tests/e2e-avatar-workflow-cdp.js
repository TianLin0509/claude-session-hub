'use strict';
// Real Electron avatars/composer/IPC; deterministic native provider fixtures.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher'),{connectFirstPage}=require('./helpers/cdp-client');
const D=require('../core/delivery-workflow'),j=JSON.stringify,delay=ms=>new Promise(r=>setTimeout(r,ms));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-avatar-flow-')),data=path.join(root,'data'),gates=path.join(root,'gates'),trace=path.join(root,'trace.jsonl');
const art=path.resolve('artifacts/avatar-routing');fs.mkdirSync(art,{recursive:true});
(async()=>{let hub,c,id;const e={passed:false,controlledProtocol:true,root,checks:[]};
 const invoke=(ch,args={})=>c.eval(`require('electron').ipcRenderer.invoke(${j(ch)},${j(args)})`);
 const until=async(label,fn,ms=45000)=>{const end=Date.now()+ms;while(Date.now()<end){const r=await fn();if(r)return r;await delay(100);}throw Error('timeout: '+label);};
 const click=async selector=>{const p=await c.eval(`(()=>{const e=document.querySelector(${j(selector)});if(!e)throw Error('missing '+${j(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);for(const type of ['mousePressed','mouseReleased'])await c.send('Input.dispatchMouseEvent',{type,...p,button:'left',clickCount:1});};
 const send=async text=>{await click('#mr-input-box');await c.send('Input.insertText',{text});for(const type of ['keyDown','keyUp'])await c.send('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13});};
 const traceRows=()=>fs.existsSync(trace)?fs.readFileSync(trace,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
 const selects=()=>c.eval('[...document.querySelectorAll(".mr-free-slot-cb:checked")].map(e=>Number(e.dataset.slotIdx))');
 const select=async indexes=>{for(const n of [0,1]){if((await selects()).includes(n)!==indexes.includes(n)){await click(`.mr-free-avatar-chk[data-slot-idx="${n}"]`);await until('avatar change',async()=>(await selects()).includes(n)===indexes.includes(n));}}};
 const state=()=>invoke('delivery:status',{meetingId:id});
 const deliver=member=>{const base=D.directory(data,id),r=JSON.parse(fs.readFileSync(path.join(base,'run.json'),'utf8')),s=r.steps.at(-1),p=D.paths(base,r,s,member);fs.appendFileSync(p.draft,'本轮已核对，协议夹具交付。\n');fs.renameSync(p.draft,p.ready);};
 try{
  const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
  hub=await launchIsolatedHub({dataDir:data,port,label:'avatar-workflow',extraEnv:{CODEX_HOME:path.join(root,'codex'),CLAUDE_CONFIG_DIR:path.join(root,'claude'),CLAUDE_HUB_CLAUDE_STREAM_FIXTURE:path.resolve('tests/fixtures/claude-stream.js'),CLAUDE_HUB_CLAUDE_FIXTURE_MODE:'gated',CLAUDE_HUB_FIXTURE_GATE_DIR:gates,CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.resolve('tests/fixtures/codex-app-server.js'),CLAUDE_HUB_NATIVE_FIXTURE_TRACE:trace}});
  c=await connectFirstPage(hub);await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});await until('renderer',()=>c.eval('!!window.MeetingRoom'));
  const m=await invoke('create-meeting',{mode:'group',scene:'general',groupChat:true,title:'头像控制补充对象',workspace:root,slots:[{memberId:'m1',kind:'claude',model:'claude-haiku-4-5-20251001',mcpProfile:'lean'},{memberId:'m2',kind:'codex',model:'gpt-6-astra',mcpProfile:'lean'}]});id=m.id;e.meetingId=id;
  const cfg=await invoke('workflow:configure',{meetingId:id,expectedRevision:m.serialWorkflow?.settingsRevision || 0,draft:{kind:'serial',presetId:'custom',enabled:true,rounds:[{name:'Claude 初稿',members:['m1'],prompt:'写初稿',after:'next'},{name:'Codex 核对',members:['m2'],prompt:'核对初稿',after:'end'}]}});assert(cfg.ok,cfg.reason);
  const fresh=(await invoke('get-meetings')).find(m=>m.id===id);await c.eval(`window.MeetingRoom.openMeeting(${j(id)},${j(fresh)})`);await until('first step avatar',async()=>j(await selects())==='[0]');
  await send('逐步完成小任务');await until('first dispatched',()=>fs.existsSync(path.join(gates,'received.jsonl')));e.checks.push('settings select first step; composer starts that step');
  await select([1]);await send('仅给 Codex：请先简答，别改变工作流。');await until('idle member receives',()=>traceRows().some(r=>r.method==='turn/start'&&j(r).includes('仅给 Codex')));
  await until('idle reply visible',()=>c.eval('document.querySelector("#meeting-room-panel")?.innerText.includes("原生回答")'));
  assert.equal((await state()).round,1);assert.deepEqual(await selects(),[1]);e.checks.push('idle selected member receives and its answer is visible; manual selection survives refresh');
  await send('fixture:hold Codex 保持执行');await until('Codex active',()=>c.eval(`sessions.get(${j(m.subSessions[1])})?.nativeRuntime?.state==='running'`));
  await send('活跃插话只给 Codex');await until('active steer',()=>traceRows().some(r=>r.method==='turn/steer'&&j(r).includes('活跃插话只给 Codex')));assert.equal((await state()).round,1);e.checks.push('active Codex steers without starting a workflow or changing the round');
  await select([0,1]);await send('两位都接收这条补充');await until('mixed receipts',()=>c.eval('document.body.innerText.includes("1 位已排队") && document.body.innerText.includes("1 位已确认收到")'));e.checks.push('both selected: Claude queue and Codex immediate receipt shown separately');
  await select([]);const before=traceRows().length;await send('空选择不能偷偷发给全员');await delay(500);assert.equal(traceRows().length,before);assert(await c.eval('document.querySelector("#mr-input-box").innerText.includes("空选择")'));await c.eval('document.querySelector("#mr-input-box").textContent=""');e.checks.push('empty selection retains draft and sends nothing');
  await select([1]);await click('[data-delivery="stop"]');await until('paused',async()=>(await state()).paused);await send('暂停期间只给 Codex 的补充');await until('paused supplement',()=>traceRows().some(r=>j(r).includes('暂停期间只给 Codex')));assert((await state()).paused);assert.equal((await state()).round,1);e.checks.push('supplement during pause leaves workflow paused');
  await select([0]);deliver('m1');await delay(2300);assert.equal((await state()).round,1);await click('[data-delivery="resume"]');await until('next step linked',async()=>(await state()).round===2 && j(await selects())==='[1]');e.checks.push('explicit resume advances delivered step and automatically selects next member');
  deliver('m2');await until('done',async()=>(await state()).done);
  const received=fs.readFileSync(path.join(gates,'received.jsonl'),'utf8');assert(!received.includes('仅给 Codex') && !received.includes('活跃插话只给 Codex'));e.checks.push('unselected Claude never receives Codex-only prompts');
  const shot=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(art,'workflow-avatars.png'),Buffer.from(shot.data,'base64'));
  const ordinary=await invoke('create-meeting',{mode:'group',scene:'general',groupChat:true,title:'普通群聊头像收件',workspace:root,slots:[{memberId:'m1',kind:'claude',model:'claude-haiku-4-5-20251001',mcpProfile:'lean'},{memberId:'m2',kind:'codex',model:'gpt-6-astra',mcpProfile:'lean'}]});
  await c.eval(`window.MeetingRoom.openMeeting(${j(ordinary.id)},${j(ordinary)})`);await until('ordinary avatars',()=>c.eval('document.querySelectorAll(".mr-free-slot-cb").length===2'));await select([1]);
  await send('@all 只是正文引用，普通群聊也只发给选中的 Codex');await until('ordinary selected recipient',()=>traceRows().some(r=>r.method==='turn/start'&&j(r).includes('只是正文引用')));
  assert(!fs.readFileSync(path.join(gates,'received.jsonl'),'utf8').includes('只是正文引用'));e.checks.push('ordinary chat obeys avatar snapshot; @all text does not expand recipients');e.passed=true;
 }catch(error){e.error=error.stack;if(c){e.ui=await c.eval('document.body.innerText.slice(-14000)');if(id)e.state=await state();}throw error;}
 finally{if(hub)e.logs=hub.log();if(c)await c.close();if(hub)e.quit=await gracefulQuit(hub);fs.writeFileSync(path.join(art,'gui-evidence.json'),j(e));console.log(j(e));}
})().catch(error=>{console.error(error);process.exitCode=1;});
