'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {AssistantStore}=require('../core/hub-assistant/store');
const {AssistantWatches}=require('../core/hub-assistant/watches');
const {TranscriptParserService}=require('../core/transcript-parser-service');
const {TranscriptResultCache}=require('../core/transcript-result-cache');
const Answers=require('../core/group-answer-files');
function directory(){return fs.mkdtempSync(path.join(os.tmpdir(),'hub-runtime-opt-'));}

test('unchanged watches avoid writes but cursor advances, errors, recovery and new replies are retained',t=>{
  const store=new AssistantStore(directory());t.after(()=>store.close());
  const meta={id:'target',kind:'codex',codexSid:'exact-native',title:'测试'};
  let result={available:true,identity:meta.codexSid,records:[],cursor:{offset:0}},error=null;
  const notices=[],w=new AssistantWatches(store,{getSession:()=>meta,readFinal:()=>{if(error)throw error;return result;},onNotification:n=>notices.push(n)});
  w.follow(meta.id);let writes=0;const save=w.save.bind(w);w.save=row=>{writes++;return save(row);};
  for(let i=0;i<5;i++)w.poll();assert.equal(writes,0);
  result={...result,cursor:{offset:25}};w.poll();assert.equal(writes,1);assert.equal(w.list()[0].cursor.offset,25);
  const restarted=new AssistantWatches(store,{getSession:()=>meta,readFinal:(_meta,{cursor})=>{assert.equal(cursor.offset,25);return result;}});
  restarted.poll();
  error=new Error('读取暂不可用');w.poll();w.poll();assert.equal(writes,2);assert.equal(w.list()[0].state,'error');
  error=null;w.poll();assert.equal(writes,3);assert.equal(w.list()[0].state,'watching');
  result={...result,cursor:{offset:50},records:[{id:'reply',notificationKey:'turn-one',text:'完整回复',timestamp:Date.now()}]};
  w.poll();w.poll();assert.equal(notices.length,1);assert.equal(w.notifications().notifications[0].text,'完整回复');
});

test('eleven histories stay cached and larger windows serve smaller requests without changing turn IDs',async t=>{
  const dir=directory(),service=new TranscriptParserService();t.after(()=>service.close());
  const files=Array.from({length:11},(_,i)=>{
    const file=path.join(dir,i+'.jsonl'),rows=[];
    for(let n=0;n<8;n++)rows.push({type:'user',uuid:`u-${i}-${n}`,message:{content:'问题 '+n}},
      {type:'assistant',uuid:`a-${i}-${n}`,message:{stop_reason:'end_turn',content:[{type:'text',text:'回答 '+n}]}});
    fs.writeFileSync(file,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');return file;
  });
  const heads=[];for(const file of files)heads.push(await service.parse('claude',file,{limit:10,fromTail:true}));
  for(let i=0;i<files.length;i++){
    const small=await service.parse('claude',files[i],{limit:4,fromTail:true});
    assert.equal(small.meta.cacheHit,true);assert.deepEqual(small.turns,heads[i].turns.slice(-4));
    const head=await service.parse('claude',files[i],{limit:4,fromTail:false});
    assert.equal(head.meta.cacheHit,false,'head and tail may not share windows');assert.equal(head.turns[0].text,'问题 0');
  }
  fs.appendFileSync(files[0],JSON.stringify({type:'user',uuid:'new',message:{content:'新问题'}})+'\n');
  const changed=await service.parse('claude',files[0],{limit:4,fromTail:true});assert.equal(changed.meta.cacheHit,false);assert.equal(changed.turns.at(-1).text,'新问题');
});

test('parsed-history cache respects bytes and query options instead of expanding without a bound',()=>{
  const c=new TranscriptResultCache({maxBytes:1200,maxFiles:3,maxVariants:2});
  c.set('a','claude','1',{limit:2,fromTail:true},[{text:'a'},{text:'b'}]);
  assert.deepEqual(c.get('a','1',{limit:1,fromTail:true}),[{text:'b'}]);
  assert.equal(c.get('a','1',{limit:1,fromTail:false}),null);
  assert.equal(c.get('a','1',{limit:1,fromTail:true,excludeEntryIds:['a']}),null);
  assert.equal(c.get('a','2',{limit:1,fromTail:true}),null,'file change invalidates all variants');
  for(let i=0;i<8;i++)c.set('f'+i,'claude','1',{},[{text:'x'.repeat(180)}]);
  assert.ok(c.bytes<=1200);assert.ok(c.files.size<=3);assert.equal(c.get('f0','1',{}),null);
  c.set('huge','claude','1',{},[{text:'x'.repeat(2000)}]);assert.equal(c.get('huge','1',{}),null);
  c.set('tail','claude','1',{limit:1,fromTail:true},[{text:'尾部'}]);
  c.set('tail','claude','1',{fromTail:true},[{text:'x'.repeat(2000)}]);
  assert.deepEqual(c.get('tail','1',{limit:1,fromTail:true}),[{text:'尾部'}],'an oversized full query does not evict a useful bounded window');
});

test('cached Gemini windows preserve exact session identity validation',async t=>{
  const service=new TranscriptParserService();t.after(()=>service.close());const file=path.join(directory(),'gemini.json');
  fs.writeFileSync(file,JSON.stringify({sessionId:'exact-identity',messages:[{id:'u',type:'user',content:'问题'},{id:'a',type:'gemini',content:'答案',tokens:{total:2}}]}));
  await service.parse('gemini',file,{limit:10,expectedSessionId:'exact-identity'});
  const small=await service.parse('gemini',file,{limit:1,expectedSessionId:'exact-identity'});
  assert.equal(small.turns[0].text,'答案');
  await assert.rejects(service.parse('gemini',file,{limit:1,expectedSessionId:'another-identity'}),/不属于当前会话/);
});

test('group file events check the changed answer; the full fallback still catches edits with no event',()=>{
  const dir=directory(),entries={},cards=new Map();
  for(const id of ['a','b','c']){
    const e=Answers.entryFor({dataDir:dir,meetingId:'room',turnNum:1,memberId:id});
    fs.mkdirSync(e.dir,{recursive:true});fs.writeFileSync(e.ready,'原稿 '+id);entries[id]=e;
  }
  const orch={state:{answerFiles:{1:entries}},applyAnswerFile:(_turn,id,got)=>{cards.set(id,got.text);entries[id].hash=got.hash;return true;}};
  assert.equal(Answers.reconcile(orch),true);
  fs.writeFileSync(entries.a.ready,'新回答 a');fs.writeFileSync(entries.b.ready,'无事件的更正 b');
  const inspected=[],original=fs.statSync;fs.statSync=function(file,...args){inspected.push(file);return original.call(this,file,...args);};
  try{assert.equal(Answers.reconcile(orch,{changedPaths:[entries.a.ready]}),true);}finally{fs.statSync=original;}
  assert.equal(cards.get('a'),'新回答 a');assert.equal(cards.get('b'),'原稿 b');assert.deepEqual(inspected,[entries.a.ready]);
  assert.equal(Answers.reconcile(orch),true);assert.equal(cards.get('b'),'无事件的更正 b');
  fs.unlinkSync(entries.a.ready);assert.equal(Answers.reconcile(orch,{changedPaths:[entries.a.dir]}),true);assert.equal(cards.get('a'),'');
});
