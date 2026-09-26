'use strict';
const assert=require('node:assert/strict'),{test}=require('node:test');
const {registerGroupchatSupplementIpc}=require('../main/ipc/groupchat-supplement-handlers');
function fixture(){
 const handlers=new Map(),sent=[],saved=[];
 const meeting={id:'g',groupChat:true,participants:[0],subSessions:['a','b'],slotSpecs:[{memberId:'m1'},{memberId:'m2'}]};
 const orch={state:{attempts:{a:{sid:'a',status:'running'}}},appendUserSupplement:(text,opts)=>{saved.push({text,...opts});return {seq:saved.length};},markUserSupplementsDelivered:()=>{}};
 registerGroupchatSupplementIpc({handle:(name,fn)=>handlers.set(name,fn)},{meetingManager:{getMeeting:()=>meeting},sessionManager:{getSession:sid=>({id:sid,kind:'claude',status:sid==='a'?'working':'idle'})},
  getHubDataDir:()=>'',groupchat:{getOrchestrator:()=>orch},getActiveWatchers:()=>new Map(),groupChatWatcher:{sendToPty:async(sid,text)=>{sent.push({sid,text});return {ok:true,sendStatus:'ok'};}}});
 return {meeting,sent,saved,send:args=>handlers.get('groupchat:user-supplement')(null,{meetingId:'g',text:'完整补充\n第二行',...args})};
}
test('avatar recipient snapshot wins over later selection; selected idle member receives immediately',async()=>{
 const f=fixture();const result=await f.send({recipientSids:['b']});
 assert.equal(result.ok,true);assert.deepEqual(f.saved[0].recipientSids,['b']);assert.deepEqual(f.sent.map(x=>x.sid),['b']);
 assert.match(f.sent[0].text,/完整补充\n第二行/);
});
test('default supplements address selected avatars, never unselected members',async()=>{
 const f=fixture();await f.send({});assert.deepEqual(f.saved[0].recipientSids,['a']);assert.deepEqual(f.sent.map(x=>x.sid),['a']);
});
test('empty or stale recipient snapshot rejects before logging or sending',async()=>{
 for(const recipientSids of [[],['unknown']]){const f=fixture();assert.equal((await f.send({recipientSids})).ok,false);assert.equal(f.saved.length,0);assert.equal(f.sent.length,0);}
});

const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const groupchat=require('../core/group-chat-orchestrator');
const fresh=()=>groupchat.getOrchestrator(fs.mkdtempSync(path.join(os.tmpdir(),'avatar-receipt-')),'g');

test('identical queued supplements consume one native receipt once, with one shared listener',()=>{
 const {EventEmitter}=require('node:events'),sm=new EventEmitter(),tap=new EventEmitter(),confirmed=[];
 sm.getSession=()=>({id:'a'});
 const observe=require('../main/ipc/groupchat-supplement-handlers')._test.createSpecificPromptObserver(sm,tap);
 const a=observe('a','first','same',u=>confirmed.push(u.clientSubmissionId));
 const b=observe('a','second','same',u=>confirmed.push(u.clientSubmissionId));
 assert.equal(tap.listenerCount('prompt-submitted'),1);
 const event={hubSessionId:'a',text:'same',submittedAt:Date.now(),turnId:'turn-1'};
 tap.emit('prompt-submitted',event);tap.emit('prompt-submitted',event);
 assert.deepEqual(confirmed,['first']);assert(a.receipt.started);assert(!b.receipt.started);
 tap.emit('prompt-submitted',{...event,turnId:'turn-2'});
 assert.deepEqual(confirmed,['first','second']);assert.equal(tap.listenerCount('prompt-submitted'),0);
});

for(const throws of [false,true])test('exact prompt receipt retains turn identity after generic send completion; throws='+throws,async()=>{
 const {EventEmitter}=require('node:events'),sm=new EventEmitter(),tap=new EventEmitter(),o=fresh(),handlers={};
 sm.getSession=sid=>({id:sid,kind:'codex',agentRuntime:'pty'});o.beginTurn('goal');
 registerGroupchatSupplementIpc({handle:(name,fn)=>handlers[name]=fn},{sessionManager:sm,transcriptTap:tap,
  meetingManager:{getMeeting:()=>({id:'g',groupChat:true,subSessions:['a']})},getHubDataDir:()=>'',groupchat:{getOrchestrator:()=>o},
  groupChatWatcher:{sendToPty:async(sid,text)=>{
   tap.emit('prompt-submitted',{hubSessionId:sid,text,submittedAt:Date.now(),turnId:'exact-turn'});
   if(throws)throw Error('transport ended after confirmation');return {ok:true,sendStatus:'ok'};
  }}});
 const r=await handlers['groupchat:user-supplement'](null,{meetingId:'g',text:'extra',recipientSids:['a']});
 assert.deepEqual(r.deliveredNow,['a']);assert.deepEqual(r.uncertainSids,[]);
 const a=Object.values(o.state.attempts).find(a=>a.supplementSeq);assert.equal(a.providerTurnId,'exact-turn');assert.equal(a.status,'accepted');
});

test('PTY supplement ignores ongoing work and updates its durable card on a late exact prompt receipt',async()=>{
 const {EventEmitter}=require('node:events'),sm=new EventEmitter(),tap=new EventEmitter(),o=fresh(),handlers={};let prompt;
 sm.getSession=sid=>({id:sid,kind:'codex',agentRuntime:'pty'});o.beginTurn('goal');
 registerGroupchatSupplementIpc({handle:(name,fn)=>handlers[name]=fn},{sessionManager:sm,transcriptTap:tap,
  meetingManager:{getMeeting:()=>({id:'g',groupChat:true,subSessions:['a']})},getHubDataDir:()=>'',groupchat:{getOrchestrator:()=>o},
  groupChatWatcher:{sendToPty:async(sid,text,kind,options)=>{
   prompt=text;assert(options.submissionReceipt);sm.emit('agent-turn-started',{sessionId:sid,seq:99});
   tap.emit('prompt-submitted',{hubSessionId:sid,text:'old task',submittedAt:Date.now(),turnId:'old'});
   assert.equal(options.submissionReceipt.started,false);return {ok:true,sendStatus:'ok',acknowledgementSource:'pty-running'};
  }}});
 const result=await handlers['groupchat:user-supplement'](null,{meetingId:'g',text:'exact supplement',recipientSids:['a']});
 assert.deepEqual(result.deliveredNow,[]);assert.deepEqual(result.uncertainSids,['a']);
 assert.deepEqual(o.pendingUserSupplementsFor('a'),[]);
 tap.emit('prompt-submitted',{hubSessionId:'a',text:prompt,submittedAt:Date.now(),turnId:'same-active-turn'});
 const card=o.state.messages.find(m=>m.supplement);
 assert.deepEqual(card.supplementDelivery.deliveredNow,['a']);assert.deepEqual(card.supplementDelivery.uncertainSids,[]);
 assert.equal(tap.listenerCount('prompt-submitted'),0);assert.equal(sm.listenerCount('agent-turn-started'),0);
});
test('source final hides only its identical temporary answer, preserving other attempts and progress',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../renderer/meeting-room.js'),'utf8');
 const fn=source.slice(source.indexOf('function _renderGroupChatPending('),source.indexOf('function _renderGroupChatView(')).trim();
 const render=require('node:vm').runInNewContext('('+fn+')',{
  SourceFinal:require('../core/groupchat-source-final'),
  _getGcSlots:()=>[{sid:'s',slotIndex:0}],_isGcSettledStatus:()=>false,
  _gcActiveSids:{},isSlotParticipatingThisTurn:()=>true,_renderGroupChatMessage:()=>'<answer>',
 });
 const state={currentTurn:1,messages:[{role:'assistant',sid:'s',turnNum:1,attemptId:'a',sourceMessage:'native',phase:'final',content:'answer',status:'progress_update'}],
  _partialBy:{s:{attemptId:'a',text:'answer',status:'completed'}}};
 assert.equal(render(state,{id:'g'},{}),'');
 state._partialBy.s.attemptId='b';assert.equal(render(state,{id:'g'},{}),'<answer>');
 state._partialBy.s.attemptId='a';state._partialBy.s.text='different';assert.equal(render(state,{id:'g'},{}),'<answer>');
 state._partialBy.s.text='answer';state.messages[0].phase='commentary';assert.equal(render(state,{id:'g'},{}),'<answer>');
 state.messages[0].phase='final';state.messages[0].providerTurnId='same-turn';
 state._partialBy.s.attemptId='supplement';state.attempts={supplement:{providerTurnId:'same-turn'}};
 assert.equal(render(state,{id:'g'},{}),'');
 state.attempts.supplement.providerTurnId='other-turn';assert.equal(render(state,{id:'g'},{}),'<answer>');
 state._partialBy.s.attemptId='a';state._partialBy.s.providerTurnId='other-turn';assert.equal(render(state,{id:'g'},{}),'<answer>');
});
test('ordinary delivery workflows refresh when a late source reply arrives',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../renderer/meeting-room.js'),'utf8');let handler,calls=0;
 const listener=source.slice(source.indexOf("ipcRenderer.on('dev-workbench:progress'"),source.indexOf("ipcRenderer.on('groupchat-turn-patched'"));
 const meeting={id:'g',scene:'general',groupChat:true,serialWorkflow:{deliveryVersion:1}};
 require('node:vm').runInNewContext(listener,{ipcRenderer:{on:(_name,fn)=>handler=fn},_acceptGcPush:()=>true,
  meetingData:{g:meeting},activeMeetingId:'g',Delivery:require('../core/delivery-workflow'),refreshGroupChatPanel:()=>{calls++;return Promise.resolve();}});
 handler(null,{meetingId:'g'});assert.equal(calls,1);
 handler(null,{meetingId:'other'});assert.equal(calls,1);
});
test('a source final present only in cache is rendered before removing the temporary answer',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../renderer/meeting-room.js'),'utf8');
 const fn=source.slice(source.indexOf('function _patchGroupChatPendingMessage('),source.indexOf('async function refreshGroupChatPanel(')).trim();
 let rendered=false,removed=false;const article={remove:()=>removed=true},panel={querySelector:()=>({querySelector:()=>article})};
 const state={messages:[{sid:'s',sourceMessage:'native',phase:'final',content:'answer',attemptId:'a'}],_partialBy:{s:{text:'answer',attemptId:'a'}}};
 const patch=require('node:vm').runInNewContext('('+fn+')',{SourceFinal:require('../core/groupchat-source-final'),CSS:{escape:x=>x},
  _captureGroupChatScroll:()=>({top:25}),_restoreGroupChatScroll:()=>{},_renderGcPanelInto:(_p,_m,s,opts)=>{assert.equal(s,state);assert.equal(opts.scroll.top,25);rendered=true;}});
 assert.equal(patch(panel,{groupChat:true},'s',state),true);assert.equal(rendered,true);assert.equal(removed,false);
});
for(const supplementFirst of [true,false])test('original and supplementary answers remain separate, supplement first='+supplementFirst,()=>{
 const o=fresh();o.beginTurn('goal');const original=o.recordTurnPrompt(1,'a','original',{memberId:'m1'});
 const added=o.appendUserSupplement('extra',{recipientSids:['a']});
 const reply=o.recordSupplementPrompt('a','extra',{seq:added.seq,memberId:'m1',kind:'codex',native:true});
 const updateOriginal=()=>o.patchTurnResult(1,'a',{text:'ORIGINAL',status:'completed',attemptId:original.attemptId});
 const updateSupplement=()=>o.recordDisplayMessages(reply.attemptId,[{id:'extra-final',text:'SUPPLEMENT',phase:'final_answer'}]);
 if(supplementFirst){updateSupplement();updateOriginal();}else{updateOriginal();updateSupplement();}
 o.completeTurn(1,'goal',[{sid:'a',text:'ORIGINAL',status:'completed',attemptId:original.attemptId}],{a:{memberId:'m1'}});
 const answers=o.state.messages.filter(m=>m.role==='assistant');
 assert.equal(answers.find(m=>m.attemptId===original.attemptId).content,'ORIGINAL');assert.equal(answers.find(m=>m.attemptId===reply.attemptId).content,'SUPPLEMENT');
});
test('repeated Codex supplements steering the same native turn share one answer anchor',()=>{
 const o=fresh();o.beginTurn('goal');const a=o.appendUserSupplement('one',{recipientSids:['a']}),b=o.appendUserSupplement('two',{recipientSids:['a']});
 const first=o.recordSupplementPrompt('a','one',{seq:a.seq,native:true}),second=o.recordSupplementPrompt('a','two',{seq:b.seq,native:true});
 o.finishSupplementPrompt(first.attemptId,{ok:true,threadId:'thread',turnId:'turn'});o.finishSupplementPrompt(second.attemptId,{ok:true,threadId:'thread',turnId:'turn'});
 assert.equal(o.state.attempts[second.attemptId].supplementAliasOf,first.attemptId);assert.equal(o.state.messages.filter(m=>m.supplementReply).length,1);
});
test('reserve all recipients before await; stuck never becomes delivered or gets auto replayed',async()=>{
 const o=fresh();o.beginTurn('goal');const handles={},waits=[];
 registerGroupchatSupplementIpc({handle:(name,fn)=>handles[name]=fn},{meetingManager:{getMeeting:()=>({id:'g',groupChat:true,subSessions:['a','b']})},
  sessionManager:{getSession:sid=>({id:sid,kind:'claude',status:'idle'})},getHubDataDir:()=>'',groupchat:{getOrchestrator:()=>o},
  groupChatWatcher:{sendToPty:()=>new Promise(resolve=>waits.push(resolve))}});
 const task=handles['groupchat:user-supplement'](null,{meetingId:'g',text:'keep whole',recipientSids:['a','b']});
 assert.equal(waits.length,1);assert.deepEqual(o.pendingUserSupplementsFor('a'),[]);assert.deepEqual(o.pendingUserSupplementsFor('b'),[]);
 waits[0]({ok:true,sendStatus:'stuck'});await new Promise(r=>setImmediate(r));waits[1]({ok:true,sendStatus:'ok'});
 const result=await task;assert.deepEqual(result.deliveredNow,['b']);assert.deepEqual(result.uncertainSids,['a']);assert.deepEqual(result.pendingSids,[]);
 assert.deepEqual(o.pendingUserSupplementsFor('a'),[]);assert.equal(o.state.userSupplements.deliveredBySid.a,undefined);
 assert.equal(o.state.currentTurn,1);assert.equal(o.state.messages.find(m=>m.supplement).content,'keep whole');
});
test('recipient closes while earlier recipient submits: unsent reservation is released and later receipt updates the card',async()=>{
 const o=fresh();o.beginTurn('goal');const handles={};let release,closed=false;
 registerGroupchatSupplementIpc({handle:(name,fn)=>handles[name]=fn},{meetingManager:{getMeeting:()=>({id:'g',groupChat:true,subSessions:['a','b']})},
  sessionManager:{getSession:sid=>sid==='b'&&closed?null:{id:sid,kind:'claude',status:'idle'}},getHubDataDir:()=>'',groupchat:{getOrchestrator:()=>o},
  groupChatWatcher:{sendToPty:()=>new Promise(r=>release=r)}});
 const task=handles['groupchat:user-supplement'](null,{meetingId:'g',text:'extra',recipientSids:['a','b']});closed=true;release({ok:true,sendStatus:'ok'});
 const result=await task;assert.deepEqual(result.pendingSids,['b']);assert.equal(o.pendingUserSupplementsFor('b').length,1);
 o.markUserSupplementsDelivered('b',[result.seq],{queued:true});const delivery=o.state.messages.find(m=>m.supplement).supplementDelivery;
 assert.deepEqual(delivery.pendingSids,[]);assert.deepEqual(delivery.queuedSids,['b']);assert.deepEqual(delivery.deliveredNow,['a']);
});
