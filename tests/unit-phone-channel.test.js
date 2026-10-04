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

function sseFetch(chunks,{status=200}={}){const calls=[];const impl=async(url,init)=>{calls.push(JSON.parse(init.body));const enc=new TextEncoder();let i=0;return{ok:status===200,status,body:{getReader:()=>({read:async()=>i<chunks.length?{done:false,value:enc.encode('data: '+JSON.stringify({choices:[{delta:{content:chunks[i++]}}]})+'\n')}:{done:true}})}};};impl.calls=calls;return impl;}
test('fast lane answers simple questions in place, hands work back, and falls back on errors',async()=>{
 const {FastLane}=require('../core/hub-assistant/fast-lane');
 const fetchImpl=sseFetch(['田哥，','今天南通小雨，18～22℃。']);const lane=new FastLane({credentials:()=>({key:'k',base:'https://x'}),fetchImpl});
 const r=await lane.answer('今天南通天气怎么样？',{userPrefs:'- 回答不用表格'});assert.equal(r.text,'田哥，今天南通小雨，18～22℃。');
 const body=fetchImpl.calls[0];assert.equal(body.search_options.forced_search,true);assert.equal(body.model,'qwen3.8-flash');assert.equal(body.enable_thinking,false);assert.match(body.messages[0].content,/回答不用表格/);
 assert.equal((await new FastLane({credentials:()=>({key:'k',base:'b'}),fetchImpl:sseFetch(['【交给','助理】'])}).answer('明天提醒我开会')).handoff,true);
 assert.equal(lane.eligible('仿真那个会话跑完没'),false);assert.equal(lane.eligible('一加一等于几'),true);
 // 通道：简单问题不进完整助理；助理忙时也照答
 const h=harness();h.channel.fastLane=lane;h.assistant.overview=()=>({status:'running'});const recorded=[];h.assistant.recordFastLane=x=>recorded.push(x);
 const lane2=new FastLane({credentials:()=>({key:'k',base:'b'}),fetchImpl:sseFetch(['田哥，2。'])});h.channel.fastLane=lane2;
 const id=crypto.randomUUID();h.incoming(id,{type:'text',text:'一加一等于几'});await h.channel.tick();
 assert.equal(h.calls.length,0);assert.equal(h.s.inbox[0].state,'answered');const ans=packets(h,'answer-')[0];assert.equal(ans.text,'田哥，2。');assert.equal(ans.lane,'fast');
 assert.equal(packets(h,'answer-'+id+'-image').length,0,'fast answers skip the result card');assert.equal(recorded[0].question,'一加一等于几');
 // 交还：进入完整助理
 h.assistant.overview=()=>({status:'idle'});h.channel.fastLane=new FastLane({credentials:()=>({key:'k',base:'b'}),fetchImpl:sseFetch(['【交给助理】'])});
 let seq=10;const push=(i,v)=>h.remote.push({seq:++seq,id:i,payload:seal(h.c.key,h.c.channel,i,'phone',v)});h.incoming=push;
 const id2=crypto.randomUUID();push(id2,{type:'text',text:'帮我看看明天日程有没有冲突'});await h.channel.tick();assert.equal(h.calls.length,1);
 // 出错：回退到完整助理，不丢消息
 h.assistant.readLiveFinal=()=>({records:[{clientSubmissionId:id2,text:'好的'}]});await h.channel.tick();
 h.channel.fastLane=new FastLane({credentials:()=>{throw new Error('没有 Key');}});const id3=crypto.randomUUID();push(id3,{type:'text',text:'讲个笑话'});await h.channel.tick();
 assert.equal(h.calls.at(-1).requestId,id3);
});
test('fast lane prefers the Token Plan key and falls back to the pay-as-you-go key when the plan refuses',async()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const {FastLane,fastLaneSources}=require('../core/hub-assistant/fast-lane');
 const tried=[];const ok=sseFetch(['田哥，晴。']);
 const fetchImpl=async(url,init)=>{tried.push(url);if(url.startsWith('https://plan'))return{ok:false,status:429};return ok(url,init);};
 const r=await new FastLane({credentials:()=>[{key:'p',base:'https://plan',via:'token-plan'},{key:'d',base:'https://ds',via:'dashscope'}],fetchImpl}).answer('天气');
 assert.equal(r.text,'田哥，晴。');assert.equal(r.via,'dashscope');assert.deepEqual(tried.map(u=>u.split('/')[2]),['plan','ds']);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fast-lane-src-'));
 fs.writeFileSync(path.join(dir,'config.json'),'﻿'+JSON.stringify({acp:{apiKey:'plan-key',baseURL:'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'}}));
 assert.deepEqual(fastLaneSources({dataDir:dir}).map(s=>[s.via,s.base]),[['token-plan','https://token-plan.cn-beijing.maas.aliyuncs.com']]);
 fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({acp:{apiKey:'k',baseURL:'https://elsewhere.example/v1'}}));
 assert.equal(fastLaneSources({dataDir:dir}).length,0,'only the verified Token Plan endpoint is used');
 fs.rmSync(dir,{recursive:true,force:true});
});
test('long-poll receive loop processes a message as soon as it arrives; kicks during work re-run once',async()=>{
 const h=harness();let polls=0;const waits=[];
 h.channel.request=async(route,args={})=>{if(route==='/poll'){polls++;waits.push(args.wait||0);if(!h.remote.length)await new Promise(r=>setTimeout(r,30));return{messages:h.remote.splice(0)};}return{ok:true};};
 const loop=h.channel.receiveLoop();const id=crypto.randomUUID();h.incoming(id,{type:'text',text:'查进展'});
 for(let i=0;i<50&&!h.calls.length;i++)await new Promise(r=>setTimeout(r,20));
 assert.equal(h.calls.length,1,'dispatched without waiting for the timer');assert.ok(waits.every(w=>w===15),'asks the relay to hold the request');
 h.channel.working=true;h.channel.kick();assert.equal(h.channel.rekick,true);h.channel.working=false;
 h.channel.close();await loop;
});
test('front desk: api by default, legacy off switch means cli, invalid choices rejected',()=>{
 const fd=require('../core/hub-assistant/front-desk');
 assert.deepEqual(fd.describe(undefined,{env:{}}),{mode:'api',model:'qwen3.8-flash',label:'千问快答',modelLabel:'千问 3.8 Flash'});
 assert.equal(fd.describe(undefined,{legacyDisabled:true,env:{}}).mode,'cli');
 assert.equal(fd.describe({mode:'api',model:'deepseek-v4.1-flash'},{env:{}}).label,'DeepSeek快答');
 assert.equal(fd.describe({mode:'cli',model:'deepseek-v4.1-flash'},{env:{}}).label,'助理会话直答');
 assert.throws(()=>fd.validate({mode:'fast'}));assert.throws(()=>fd.validate({mode:'api',model:'gpt-x'}));
 assert.deepEqual(fd.catalog(fd.describe()).models.map(m=>m.id),['qwen3.8-flash','deepseek-v4.1-flash']);
});
test('phone set_front_desk applies immediately even while the assistant is busy; cli skips the fast lane; api uses the chosen model',async()=>{
 const {FastLane}=require('../core/hub-assistant/fast-lane'),fd=require('../core/hub-assistant/front-desk');
 const h=harness();let saved;h.assistant.overview=()=>({status:'running'});h.assistant.switching=false;
 h.assistant.frontDesk=()=>fd.describe(saved,{env:{}});h.assistant.setFrontDesk=r=>{saved={...saved,...fd.validate(r)};return{ok:true,frontDesk:h.assistant.frontDesk()};};
 h.assistant.fastLaneDisabled=()=>h.assistant.frontDesk().mode==='cli';h.assistant.currentProfile=()=>({kind:'claude'});
 h.s.phoneCaps=['profile'];h.assistant.phoneProfile=async()=>({current:{kind:'claude'},kinds:[],frontDesk:fd.catalog(h.assistant.frontDesk())});
 const fetchImpl=sseFetch(['田哥，2。']);h.channel.fastLane=new FastLane({credentials:()=>({key:'k',base:'b'}),fetchImpl});
 const id=crypto.randomUUID();h.incoming(id,{type:'set_front_desk',mode:'cli'});await h.channel.tick();
 assert.equal(h.assistant.frontDesk().mode,'cli');const p=packets(h,'profile-').find(x=>x.requestId===id);assert.equal(p.frontDesk.current.mode,'cli');
 let seq=10;const push=(i,v)=>h.remote.push({seq:++seq,id:i,payload:seal(h.c.key,h.c.channel,i,'phone',v)});h.incoming=push;
 push(crypto.randomUUID(),{type:'text',text:'一加一等于几'});h.assistant.overview=()=>({status:'idle'});await h.channel.tick();
 assert.equal(fetchImpl.calls.length,0,'cli mode never calls the API front desk');assert.equal(h.calls.length,1);
 h.assistant.readLiveFinal=()=>({records:[{clientSubmissionId:h.calls[0].requestId,text:'2'}]});await h.channel.tick();
 push(crypto.randomUUID(),{type:'set_front_desk',mode:'api',model:'deepseek-v4.1-flash'});push(crypto.randomUUID(),{type:'text',text:'二加二等于几'});await h.channel.tick();
 assert.equal(fetchImpl.calls.at(-1).model,'deepseek-v4.1-flash');assert.equal(h.calls.length,1,'answered by the API front desk');
 const bad=crypto.randomUUID();push(bad,{type:'set_front_desk',mode:'api',model:'unknown-model'});await h.channel.tick();
 assert.match(packets(h,'profileerror-'+bad)[0].text,/回答方式未切换/);assert.equal(h.assistant.frontDesk().model,'deepseek-v4.1-flash');
});
test('phone dialog log keeps every message and reply with who answered, for the assistant tab',async()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const {DialogLog}=require('../core/hub-assistant/dialog-log');const {FastLane}=require('../core/hub-assistant/fast-lane');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dialog-log-'));const log=new DialogLog(dir);
 const h=harness();h.assistant.logDialog=e=>log.append(e);h.assistant.frontDesk=()=>({mode:'api',model:'qwen3.8-flash',modelLabel:'千问 3.8 Flash'});h.assistant.currentProfile=()=>({kind:'claude',label:'Sonnet 5.5 · 低'});
 h.channel.fastLane=new FastLane({credentials:()=>({key:'k',base:'b'}),fetchImpl:sseFetch(['田哥，2。'])});
 const fast=crypto.randomUUID();h.incoming(fast,{type:'text',text:'一加一等于几'});await h.channel.tick();
 let seq=10;const push=(i,v)=>h.remote.push({seq:++seq,id:i,payload:seal(h.c.key,h.c.channel,i,'phone',v)});h.incoming=push;
 h.channel.fastLane=new FastLane({credentials:()=>({key:'k',base:'b'}),fetchImpl:sseFetch(['【交给助理】'])});h.channel.transcribe=async()=>'记一下明天出差';
 const voice=crypto.randomUUID();push(voice,{type:'voice_message',pcm:'AQI=',durationMs:3000});await h.channel.tick();
 h.assistant.readLiveFinal=()=>({records:[{clientSubmissionId:voice,text:'田哥，已记下。'}]});await h.channel.tick();
 const rows=log.recent();
 assert.deepEqual(rows.map(r=>[r.role,r.lane||r.input,r.text]),[['user','text','一加一等于几'],['assistant','fast','田哥，2。'],['user','voice','记一下明天出差'],['assistant','assistant','田哥，已记下。']]);
 assert.equal(rows[1].by,'千问 3.8 Flash');assert.match(rows[3].by,/Claude · Sonnet 5.5/);assert.equal(rows[2].durationMs,3000);assert.ok(rows[1].ms>=0);
 assert.equal(log.recent({limit:2}).length,2);fs.rmSync(dir,{recursive:true,force:true});
});
test('desk: desktop messages share the front desk — fast answers in place, work goes to the assistant session and its reply is logged; busy assistant queues',async()=>{
 const {AssistantDesk}=require('../core/hub-assistant/desk'),{FastLane}=require('../core/hub-assistant/fast-lane');
 const log=[],sent=[];let status='idle',finals=[];
 const a={logDialog:e=>log.push({at:Date.now(),...e}),frontDesk:()=>({mode:'api',model:'qwen3.8-flash',modelLabel:'千问 3.8 Flash'}),recentHistory:()=>[],recordFastLane:()=>{},
  overview:()=>({status}),send:async r=>{sent.push(r);return{ok:true,sessionId:'asst'};},readLiveFinal:()=>({records:finals}),assistantLabel:()=>'Claude · Sonnet 5.5 · 低'};
 const desk=new AssistantDesk({assistant:a,fastLane:new FastLane({credentials:()=>({key:'k',base:'b'}),fetchImpl:sseFetch(['田哥，2。'])}),pollMs:10});
 const r1=await desk.ask('一加一等于几');assert.equal(r1.lane,'fast');assert.deepEqual(log.map(e=>[e.role,e.source||e.lane]),[['user','hub'],['assistant','fast']]);assert.equal(sent.length,0);
 status='running';const r2=await desk.ask('帮我看看仿真跑完没');assert.equal(r2.lane,'assistant');assert.equal(sent.length,0,'busy assistant: queued, not sent');
 status='idle';desk.check();await new Promise(r=>setTimeout(r,30));assert.equal(sent.length,1);assert.equal(sent[0].requestId,r2.id);
 finals=[{clientSubmissionId:r2.id,text:'田哥，还在跑。'}];desk.check();
 const last=log.at(-1);assert.equal(last.role,'assistant');assert.equal(last.lane,'assistant');assert.equal(last.text,'田哥，还在跑。');assert.equal(last.by,'Claude · Sonnet 5.5 · 低');
 a.frontDesk=()=>({mode:'cli',model:'qwen3.8-flash',modelLabel:'千问 3.8 Flash'});const r3=await desk.ask('一加一等于几');assert.equal(r3.lane,'assistant','cli mode skips the API front desk');
 await assert.rejects(desk.ask('  '));clearInterval(desk.timer);
});
