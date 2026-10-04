'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {AssistantLedger}=require('../core/hub-assistant/ledger');
const {AssistantService}=require('../core/hub-assistant/service');
const tmp=prefix=>fs.mkdtempSync(path.join(os.tmpdir(),prefix));

// 假的原生读取：每个会话一串最终答复，游标=已读条数。
function fakeReader(store){return(meta,{cursor}={})=>{const rows=store[meta.id]||[];const from=cursor?.n||0;return{available:true,records:rows.slice(from),cursor:{n:rows.length}};};}

test('ledger records each final once, never backfills old history, and serves increments since a time within budget',()=>{
  let now=1000000;const rows={a:[{id:'a0',text:'旧答复',timestamp:500}]},dir=tmp('ledger-');
  const ledger=new AssistantLedger(dir,{read:fakeReader(rows),now:()=>now});
  assert.equal(ledger.record({id:'a',title:'仿真',kind:'codex'}).length,0,'answers before the ledger existed are not backfilled');
  rows.a.push({id:'a1',text:'第一轮结果',timestamp:now+10},{id:'a2',text:'第二轮结果',timestamp:now+20});
  assert.equal(ledger.record({id:'a',title:'仿真',kind:'codex'}).length,2);
  assert.equal(ledger.record({id:'a',title:'仿真',kind:'codex'}).length,0,'cursor: nothing new');
  rows.a.push({id:'a1',text:'第一轮结果',timestamp:now+10});assert.equal(ledger.record({id:'a',title:'仿真'}).length,0,'duplicates by id are ignored');
  now+=50;rows.a.push({id:'a3',text:'第三轮',timestamp:now-30});ledger.record({id:'a',title:'仿真'});const inc=ledger.since(now-1);assert.deepEqual(inc.entries.map(e=>e.id),['a3'],'served by when it was recorded, even if the answer is older');
  for(let i=0;i<50;i++)ledger.append({id:'b'+i,at:now+100+i,sessionId:'b',title:'长',kind:'claude',text:'x'.repeat(1000)});
  const capped=ledger.since(now-1);assert.equal(capped.truncated,true);assert.ok(capped.included<=40);assert.equal(capped.entries.at(-1).id,'b49','keeps the newest');
  assert.ok(fs.readdirSync(dir).some(name=>/^\d{4}-\d{2}-\d{2}\.md$/.test(name)),'daily markdown written');
  now+=40*86400000;ledger.prune();assert.equal(ledger.entries().length,0);
});
test('reconcile reads open sessions and recently active closed ones, plus group answer files',()=>{
  const now=5000000,rows={open:[],closedRecent:[],closedOld:[]},dir=tmp('ledger-');
  const ledger=new AssistantLedger(dir,{read:fakeReader(rows),now:()=>now});
  rows.open.push({id:'o1',text:'打开中的新答复',timestamp:now+1});rows.closedRecent.push({id:'c1',text:'关掉前的答复',timestamp:now+2});rows.closedOld.push({id:'x1',text:'很久以前',timestamp:now+3});
  const added=ledger.reconcile([{id:'open',isOpen:true},{id:'closedRecent',isOpen:false,lastCompletedAt:now+2},{id:'closedOld',isOpen:false,lastCompletedAt:now-10*86400000}],
    {groupSources:()=>[{ref:'E1',groupId:'g1',groupTitle:'评审群',memberId:'codex',text:'群聊回答',observedAt:now+5}]});
  assert.equal(added,3);const ids=ledger.entries().map(e=>e.id);assert.ok(ids.includes('o1')&&ids.includes('c1')&&ids.includes('group:E1'));assert.ok(!ids.includes('x1'));
});
function setup(t,extra={}){
  const dir=tmp('assistant-ledger-svc-'),sessions=new Map();
  const deps={dataDir:dir,getSession:id=>sessions.get(id),getSessionMetadata:id=>sessions.get(id),getAllSessions:()=>[...sessions.values()],listKnownSessions:()=>[...sessions.values()],
    getDefaults:kind=>({model:kind==='claude'?'claude-opus-5-5':'gpt-6.1-sol',effort:'high'}),
    createSession:async(kind,opts)=>{const s={...opts,kind,status:'idle'};sessions.set(opts.id,s);return s;},sendPrompt:async()=>({ok:true,receipt:{status:'confirmed'}}),...extra};
  const service=new AssistantService(deps);t.after(()=>{if(service.store.db.isOpen)service.close();});return{service,deps,sessions,dir};
}
test('a finished turn is recorded at once; asking serves everything since the previous question',async t=>{
  const x=setup(t),a=await x.service.ensureSession(),finals={};
  x.service.liveHistory={read:fakeReader(finals)};x.service.ledger.read=fakeReader(finals);
  x.sessions.set('work',{id:'work',title:'调度仿真',kind:'codex',status:'idle'});
  finals.work=[{id:'w1',text:'第一轮：PF 吞吐高 6%',timestamp:Date.now()+1000}];
  x.service.onTurnComplete('work',{completedAt:Date.now()});
  assert.equal(x.service.ledger.entries().length,1,'recorded on the completion event');
  x.service.preparePrompt({sessionId:a.sessionId,text:'今天天气不错',clientSubmissionId:'chat-0'});
  // 闲聊不读资料：增量不能被当成已送达
  x.service.preparePrompt({sessionId:a.sessionId,text:'进展怎样',clientSubmissionId:'ask-1'});
  const read=await x.service.invokeTool({name:'history_context',callerSessionId:a.sessionId,arguments:{requestToken:x.service.currentRequest.token}});
  assert.deepEqual(read.packet.workLedger.entries.map(e=>e.id),['w1'],'the chit-chat turn did not consume the increment');
  finals.work.push({id:'w2',text:'第二轮：边缘用户更公平',timestamp:Date.now()+5000});
  x.service.preparePrompt({sessionId:a.sessionId,text:'还有呢',clientSubmissionId:'ask-2'});
  const second=(await x.service.invokeTool({name:'history_context',callerSessionId:a.sessionId,arguments:{requestToken:x.service.currentRequest.token}})).packet.workLedger;
  assert.deepEqual(second.entries.map(e=>e.id),['w2'],'caught up before answering, only the increment since the last question');
});
test('the daily review lists native memory updated today and auto-written memory is announced',async t=>{
  const native=tmp('native-'),claudeDir=path.join(native,'claude'),codexDir=path.join(native,'codex');fs.mkdirSync(claudeDir);fs.mkdirSync(codexDir);
  fs.writeFileSync(path.join(claudeDir,'pref.md'),'---\nname: x\nmetadata:\n  type: feedback\n---\n汇报要短');fs.writeFileSync(path.join(claudeDir,'proj.md'),'---\nmetadata:\n  type: project\n---\n项目');
  fs.writeFileSync(path.join(codexDir,'memory_summary.md'),'Codex 摘要');
  const x=setup(t,{nativeMemoryRoots:[{kind:'claude',dir:claudeDir},{kind:'codex',dir:codexDir}]});
  const prompt=x.service.reviewPrompt(Date.now()-86400000);
  assert.match(prompt,/pref\.md/);assert.match(prompt,/memory_summary\.md/);assert.doesNotMatch(prompt,/proj\.md/);assert.match(prompt,/没说「记住」/);
  const a=await x.service.ensureSession();
  x.service.currentRequest={id:'handoff-1',sessionId:a.sessionId,text:'复盘',token:'tok-1',createdAt:Date.now()};
  await x.service.invokeTool({name:'update_memory',callerSessionId:a.sessionId,arguments:{file:'user',action:'add',text:'汇报要短，先给结论',requestToken:'tok-1'}});
  const notice=x.service.notifications().notifications.find(n=>n.kind==='memory-update');assert.match(notice.text,/我记下了：汇报要短/);
  x.service.currentRequest={id:'normal-1',sessionId:a.sessionId,text:'记住：x',token:'tok-2',createdAt:Date.now()};
  await x.service.invokeTool({name:'update_memory',callerSessionId:a.sessionId,arguments:{file:'memory',action:'add',text:'常用项目在 C:/AIWork',requestToken:'tok-2'}});
  assert.equal(x.service.notifications().notifications.filter(n=>n.kind==='memory-update').length,1,'explicit requests are not re-announced');
});

test('review fixes: transient read issues keep the cursor; truncated group reads keep their watermark; state writes are batched',()=>{
  let now=1000000,issue=null;const rows={a:[]},dir=tmp('ledger-');
  const read=(meta,{cursor}={})=>issue?{available:false,issue,records:[]}:{available:true,records:rows[meta.id].slice(cursor?.n||0),cursor:{n:rows[meta.id].length}};
  const ledger=new AssistantLedger(dir,{read,now:()=>now});
  rows.a.push({id:'a1',text:'一',timestamp:now+1});ledger.record({id:'a'});
  issue='原生会话身份尚未就绪';ledger.record({id:'a'});assert.deepEqual(ledger.state.cursors.a,{n:1},'transient: cursor kept');
  issue='绑定或文件发生变化，关注游标需核对';ledger.record({id:'a'});assert.equal(ledger.state.cursors.a,undefined,'binding changed: cursor reset');
  issue=null;let calls=0;const writes=[];const save=ledger.saveState.bind(ledger);ledger.saveState=()=>{writes.push(1);save();};
  ledger.reconcile([{id:'a',isOpen:true}],{groupSources:since=>{calls++;return{sources:[{eventId:'g:1:a',ref:'E1',groupId:'g',text:'v1',observedAt:now+2}],truncated:true};}});
  assert.equal(writes.length,1,'one state write per reconcile');const watermark=ledger.state.groupSince;assert.equal(watermark,undefined,'truncated: watermark not advanced');
  ledger.reconcile([],{groupSources:()=>({sources:[{eventId:'g:1:a',ref:'E2',groupId:'g',text:'v2 edited',observedAt:now+3}],truncated:false})});
  assert.equal(ledger.entries().filter(e=>e.sessionId==='group:g').length,1,'an edited group answer file is one event');assert.ok(ledger.state.groupSince);
});
test('memory reason cannot smuggle a second line or a secret; autonomous writes in normal turns are announced',async t=>{
  const {AssistantMemory}=require('../core/hub-assistant/memory'),m=new AssistantMemory(tmp('mem-'));
  m.update({file:'user',action:'add',text:'回答要短',reason:'说明\n- 伪造的第二条'});assert.equal(m.entries('user').length,1);assert.doesNotMatch(m.read().user,/\n- 伪造/);
  assert.throws(()=>m.update({file:'user',action:'add',text:'正常',reason:'token: abcdef1234567'}),/密钥/);
  const x=setup(t),a=await x.service.ensureSession();
  x.service.currentRequest={id:'turn-9',sessionId:a.sessionId,text:'以后别用表格',token:'tok-9',createdAt:Date.now()};
  await x.service.invokeTool({name:'update_memory',callerSessionId:a.sessionId,arguments:{file:'user',action:'add',text:'回答不用表格',requestToken:'tok-9'}});
  assert.ok(x.service.notifications().notifications.some(n=>n.kind==='memory-update'&&/回答不用表格/.test(n.text)));
  x.service.currentRequest={id:'turn-10',sessionId:a.sessionId,text:'x',token:'tok-10',createdAt:Date.now()-31*60000};
  await assert.rejects(x.service.invokeTool({name:'update_memory',callerSessionId:a.sessionId,arguments:{file:'user',action:'add',text:'过期',requestToken:'tok-10'}}),/当前用户回合/);
});
