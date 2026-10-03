'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {credentials,seal,open}=require('../core/hub-phone/crypto'),{PhoneChannel}=require('../core/hub-phone/channel');
function harness(){const c=credentials(),s={credentials:c,enabled:true,cursor:0,created:1,inbox:[],outbox:[],notices:[]},calls=[],remote=[];const assistant={switching:false,overview:()=>({status:'idle'}),ensureSession:async()=>({ok:true,sessionId:'fixed-assistant',backendKind:'codex'}),send:async r=>{calls.push(r);return{receipt:{receipt:{status:'confirmed',turnId:'exact-turn'}}}},readLiveFinal:()=>({records:[]}),notifications:()=>({notifications:[]})};const journal={state:s,change:fn=>fn(s)};const channel=new PhoneChannel({assistant,journal,renderCards:async()=>[Buffer.from('image')],transcribe:async()=>'识别内容'});channel.request=async(route,args)=>{if(route==='/poll')return{messages:remote.splice(0)};return{ok:true}};const incoming=(id,value)=>remote.push({seq:remote.length+1,id,payload:seal(c.key,c.channel,id,'phone',value)});return{channel,assistant,s,calls,remote,incoming,c};}
test('AES-GCM authenticates channel, message identity and sender; no plaintext on wire',()=>{const c=credentials(),p=seal(c.key,c.channel,'test-message-123456','phone',{text:'不要创建会话'});assert.equal(open(c.key,c.channel,'test-message-123456','phone',p).text,'不要创建会话');assert(!p.includes('不要'));for(const [ch,id,role]of [[c.channel,'other-message-123456','phone'],['other-channel-123456','test-message-123456','phone'],[c.channel,'test-message-123456','hub']])assert.throws(()=>open(c.key,ch,id,role,p));});
test('duplicate network messages dispatch once and only exact native turn replies',async()=>{const h=harness(),id=crypto.randomUUID();h.incoming(id,{type:'text',text:'不要创建会话，只回复进展'});h.remote.push({...h.remote[0],seq:2});await h.channel.tick();assert.equal(h.calls.length,1);assert.equal(h.s.inbox.length,1);assert.equal(h.s.inbox[0].turnId,'exact-turn');h.assistant.readLiveFinal=()=>({records:[{turnId:'other-turn',text:'旧回复'}]});await h.channel.tick();assert(!h.s.outbox.some(r=>r.id==='answer-'+id));h.assistant.readLiveFinal=()=>({records:[{turnId:'exact-turn',text:'本轮回复'}]});await h.channel.tick();assert.equal(h.s.inbox[0].state,'answered');assert.equal(h.s.outbox.filter(r=>r.id==='answer-'+id).length,1);await h.channel.tick();assert.equal(h.calls.length,1);});
test('uncertain submission is not automatically retried and late exact receipt recovers',async()=>{const h=harness(),id=crypto.randomUUID();h.assistant.send=async r=>{h.calls.push(r);throw Error('interrupted')};h.incoming(id,{type:'text',text:'继续推进'});await h.channel.tick();await h.channel.tick();assert.equal(h.calls.length,1);assert.equal(h.s.inbox[0].state,'unknown');h.channel.observeReceipt({status:'confirmed',turnId:'recovered',clientSubmissionId:id,sessionId:'wrong'});assert.equal(h.s.inbox[0].state,'unknown');h.channel.observeReceipt({status:'confirmed',turnId:'recovered',clientSubmissionId:id,sessionId:'fixed-assistant'});assert.equal(h.s.inbox[0].state,'waiting');});
test('voice returns editable transcript and cannot dispatch a task without user confirmation',async()=>{const h=harness();h.incoming(crypto.randomUUID(),{type:'voice',pcm:'AQI='});await h.channel.tick();assert.equal(h.calls.length,0);const row=h.s.outbox.find(r=>r.id.startsWith('transcript-'));assert.equal(open(h.c.key,h.c.channel,row.id,'hub',row.payload).text,'识别内容');assert.equal(h.s.inbox[0].state,'transcribed');});
test('busy assistant queues requests and follows the selected backend',async()=>{const h=harness();h.assistant.overview=()=>({status:'running'});h.incoming(crypto.randomUUID(),{type:'text',text:'查进展'});await h.channel.tick();assert.equal(h.calls.length,0);h.assistant.overview=()=>({status:'idle'});h.assistant.ensureSession=async()=>({ok:true,sessionId:'claude',backendKind:'claude'});await h.channel.tick();assert.equal(h.calls.length,1);assert.equal(h.s.inbox[0].state,'waiting');assert.equal(h.s.inbox[0].sessionId,'claude');});
test('pause during network wait cannot start a new delegated task',async()=>{const h=harness();h.incoming(crypto.randomUUID(),{type:'text',text:'创建任务'});const request=h.channel.request;h.channel.request=async(...args)=>{const r=await request(...args);h.s.enabled=false;return r};await h.channel.tick();assert.equal(h.calls.length,0);});
test('watch notification identity is safe and bounded on relay protocol',async()=>{const h=harness();h.assistant.notifications=()=>({notifications:[{id:'a'.repeat(70)+':'+crypto.randomUUID(),createdAt:2,title:'任务',text:'新回复'}]});await h.channel.tick();assert.equal(h.s.notices.length,1);assert(h.s.outbox.every(r=>/^[A-Za-z0-9_-]{16,80}$/.test(r.id)));});
test('definitively not sent startup failure rejects without blocking subsequent tasks',async()=>{const h=harness();h.assistant.send=async()=>({ok:false,receipt:{ok:false,notSent:true,error:'cli-not-ready',message:'启动尚未完成'}});h.incoming(crypto.randomUUID(),{type:'text',text:'查进展'});await h.channel.tick();assert.equal(h.s.inbox[0].state,'rejected');assert(h.s.outbox.some(r=>r.id.startsWith('rejected-')));h.assistant.send=async r=>{h.calls.push(r);return{receipt:{receipt:{status:'confirmed',turnId:'new'}}}};h.remote.push({seq:2,id:crypto.randomUUID(),payload:''});h.remote.length=0;const id=crypto.randomUUID();h.remote.push({seq:2,id,payload:seal(h.c.key,h.c.channel,id,'phone',{type:'text',text:'再查进展'})});await h.channel.tick();assert.equal(h.calls.length,1);assert.equal(h.s.inbox[1].state,'waiting');});

test('all Hub backends use one phone pairing; native request identity resolves a receipt without turn ID',async()=>{
 for(const kind of require('../core/ai-kinds').ALL_AI_KINDS){
  const h=harness(),id=crypto.randomUUID(),original=JSON.stringify(h.s.credentials);
  h.assistant.ensureSession=async()=>({ok:true,sessionId:kind,backendKind:kind});
  h.assistant.send=async r=>{h.calls.push(r);return{receipt:{receipt:{status:'confirmed'}}}};
  h.incoming(id,{type:'text',text:'current task'});await h.channel.tick();
  assert.equal(h.calls.length,1);assert.equal(h.s.inbox[0].state,'waiting');
  h.assistant.readLiveFinal=sessionId=>{assert.equal(sessionId,kind);return{records:[{clientSubmissionId:'different',text:'old'},{clientSubmissionId:id,text:'current'}]}};
  await h.channel.tick();assert.equal(h.s.inbox[0].state,'answered');assert.equal(JSON.stringify(h.s.credentials),original);
  const reply=h.s.outbox.find(r=>r.id==='answer-'+id);assert.equal(open(h.c.key,h.c.channel,reply.id,'hub',reply.payload).text,'current');
 }
});

const packets=(h,prefix)=>h.s.outbox.filter(r=>r.id.startsWith(prefix)).map(r=>open(h.c.key,h.c.channel,r.id,'hub',r.payload));
test('voice_message is transcribed once and handed straight to the assistant as voice input',async()=>{
 const h=harness(),id=crypto.randomUUID();let transcribed=0;h.channel.transcribe=async()=>{transcribed++;return' 仿真跑完了没有 ';};
 h.assistant.overview=()=>({status:'running'});h.incoming(id,{type:'voice_message',pcm:'AQI=',durationMs:1200});await h.channel.tick();
 const [t]=packets(h,'transcript-');assert.equal(t.text,'仿真跑完了没有');assert.equal(t.auto,true);assert.equal(t.requestId,id);
 assert.equal(h.calls.length,0,'busy assistant: transcript shown, dispatch waits');assert.equal(h.s.inbox[0].pcm,undefined);
 h.assistant.overview=()=>({status:'idle'});await h.channel.tick();
 assert.equal(transcribed,1);assert.equal(h.calls.length,1);assert.deepEqual(h.calls[0],{text:'仿真跑完了没有',requestId:id,inputMode:'voice'});
 assert.equal(h.s.inbox[0].state,'waiting');assert.equal(packets(h,'transcript-').length,1);
});
test('voice_message that cannot be recognised is rejected visibly and never dispatched',async()=>{
 const h=harness(),id=crypto.randomUUID();h.channel.transcribe=async()=>{throw Error('语音连接失败');};
 h.incoming(id,{type:'voice_message',pcm:'AQI='});await h.channel.tick();
 assert.equal(h.calls.length,0);assert.equal(h.s.inbox[0].state,'rejected');
 const [e]=packets(h,'voiceerror-');assert.equal(e.state,'rejected');assert.match(e.text,/识别失败.*语音连接失败/);
});
test('profile packets only go to phones that announced the capability; set_profile switches and answers',async()=>{
 const h=harness();let seq=0;h.incoming=(id,value)=>h.remote.push({seq:++seq,id,payload:seal(h.c.key,h.c.channel,id,'phone',value)});let current={kind:'claude',model:'claude-sonnet-5-5',effort:'low',label:'Sonnet 5.5 · 低'};const set=[];
 h.assistant.currentProfile=()=>current;h.assistant.phoneProfile=async()=>({current,kinds:[{kind:'claude',label:'Claude',models:[{id:'claude-sonnet-5-5',label:'Sonnet 5.5'}],efforts:['low'],defaultModel:'claude-sonnet-5-5',defaultEffort:'low'}]});
 h.assistant.setProfile=async r=>{set.push(r);current={...current,model:r.model,effort:r.effort,label:'Opus 5.5 · 中'};return{ok:true,profile:current};};
 await h.channel.tick();assert.equal(packets(h,'profile-').length,0,'old App never receives unknown packet types');
 const hello=crypto.randomUUID();h.incoming(hello,{type:'hello',app:'1.1.0',caps:['profile','voice_message']});await h.channel.tick();
 const [p]=packets(h,'profile-');assert.equal(p.type,'profile');assert.equal(p.requestId,hello);assert.equal(p.current.model,'claude-sonnet-5-5');assert.equal(p.kinds[0].kind,'claude');
 assert.equal(h.calls.length,0);await h.channel.tick();assert.equal(packets(h,'profile-').length,1,'unchanged profile is not resent');
 const req=crypto.randomUUID();h.incoming(req,{type:'set_profile',kind:'claude',model:'claude-opus-5-5',effort:'medium'});await h.channel.tick();
 assert.deepEqual(set,[{kind:'claude',model:'claude-opus-5-5',effort:'medium'}]);
 const answer=packets(h,'profile-').find(x=>x.requestId===req);assert.equal(answer.current.model,'claude-opus-5-5');assert.equal(h.calls.length,0);
 h.assistant.setProfile=async()=>({ok:false,error:'助理正在处理请求'});const bad=crypto.randomUUID();h.incoming(bad,{type:'set_profile',kind:'claude',model:'x'});await h.channel.tick();
 const [err]=packets(h,'profileerror-');assert.equal(err.requestId,bad);assert.match(err.text,/未切换.*正在处理/);
});
test('an assistant that cannot start does not block the phone queue forever',async()=>{
 const h=harness();let seq=0;h.incoming=(id,value)=>h.remote.push({seq:++seq,id,payload:seal(h.c.key,h.c.channel,id,'phone',value)});
 h.assistant.ensureSession=async()=>({ok:false,error:'助理原会话未打开'});const first=crypto.randomUUID();h.incoming(first,{type:'text',text:'查进展'});
 for(let i=0;i<3;i++)await h.channel.tick();
 assert.equal(h.s.inbox[0].state,'rejected');assert.match(packets(h,'rejected-')[0].text,/暂时无法接收/);
 h.assistant.ensureSession=async()=>({ok:true,sessionId:'fixed-assistant'});const second=crypto.randomUUID();h.incoming(second,{type:'text',text:'再查'});await h.channel.tick();
 assert.equal(h.calls.length,1);assert.equal(h.calls[0].requestId,second);
});
