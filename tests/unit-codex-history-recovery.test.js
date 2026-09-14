'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {CodexSharedSession}=require('../core/codex-shared-session');
const {BrokerConnection}=require('../main/codex-runtime-broker-client');
const {createNativeRuntime}=require('../core/codex-native-runtime');
const {nativeTranscriptTurns}=require('../core/codex-native-transcript');
const {compactCodexTools,toolResult}=require('../core/codex-tool-details');
const {CodexBackstageCompat}=require('../core/codex-backstage-compat');
const card=(id,turn,text)=>({id,providerTurnId:turn,displayTurnKey:'thread:'+turn,role:'assistant',text});
test('attach response and later final in one socket read preserve newest content AND earlier history',async()=>{
  const old={key:'key',threadId:'thread',contentRevision:10,
    transcript:[card('history','old','earlier context'),card('answer','active','draft')],blocks:[{text:'draft'}],finalText:'',
    runtime:{...createNativeRuntime(),threadId:'thread',turnId:'active',state:'running',connection:'connected',revision:5},control:{role:'viewer'}};
  const fresh={key:'key',threadId:'thread',replaceTurnId:'active',contentRevision:11,
    transcript:[card('answer','active','PUSH COMPLETE')],blocks:[{text:'PUSH COMPLETE'}],finalText:'PUSH COMPLETE'};
  let connection;
  class Socket extends EventEmitter {
    setEncoding(){} end(){this.destroyed=true;} destroy(){this.destroyed=true;}
    write(line,_encoding,callback){const m=JSON.parse(line);
      const messages=m.method==='attach'?[{id:m.id,result:old},{method:'content',params:fresh},
        {method:'session-event',params:{key:'key',event:'state',args:[{...old.runtime,state:'completed',revision:6}]}}]:[{id:m.id,result:{ok:true}}];
      queueMicrotask(()=>connection.feed(messages.map(JSON.stringify).join('\n')+'\n'));callback?.();return true;
    }
  }
  connection=new BrokerConnection(new Socket());connection.features=[];connection.metadata={serviceId:'fixture'};
  const session=new CodexSharedSession({id:'s',resumeId:'thread',brokerConnector:async()=>connection});
  try {
    await session.start();
    assert.equal(session.finalText(),'PUSH COMPLETE');assert.equal(session.contentRevision,11);
    assert.equal(session.runtime.state,'completed');
    assert.deepEqual(session.readTranscript({limit:Infinity}).map(c=>c.text),['earlier context','PUSH COMPLETE']);
    session.applyContent({...fresh,contentRevision:9,finalText:'late old message'});
    assert.equal(session.finalText(),'PUSH COMPLETE');
  } finally {session.kill();}
});
test('an older full snapshot does not resurrect items removed by a newer per-turn update',()=>{
  const session=new CodexSharedSession({id:'s',resumeId:'thread'});session.threadId='thread';
  session.applyContent({contentRevision:5,replaceTurnId:'active',transcript:[card('new','active','new')]});
  session.applySnapshot({threadId:'thread',contentRevision:4,transcript:[card('past','old','past'),card('removed','active','removed')]});
  assert.deepEqual(session.transcript.map(c=>c.id),['past','new']);
  session.applySnapshot({threadId:'another',contentRevision:1,transcript:[card('another','one','other thread')]});
  assert.equal(session.contentRevision,1);assert.deepEqual(session.transcript.map(c=>c.id),['another']);
});
function fixtureCards(count=80){return nativeTranscriptTurns('thread',[{id:'turn',status:'completed',items:[
  {id:'u',type:'userMessage',content:[{type:'text',text:'original prompt'}]},
  ...Array.from({length:count},(_,i)=>({id:'tool-'+i,type:'commandExecution',command:'command '+i,
    aggregatedOutput:'ORIGINAL-'+i,exitCode:0,status:'completed',hubCompletedAt:5000})),
  {id:'answer',type:'agentMessage',phase:'final_answer',text:'PUSH COMPLETE',hubCompletedAt:6000}]}]);}
test('Codex card previews are small and retain an exact on-demand original including NUL and Unicode',()=>{
  const output='HEAD\0'+ '字'.repeat(4*1024*1024)+'😀TAIL';
  const cards=nativeTranscriptTurns('thread',[{id:'turn',status:'completed',items:[{id:'tool',type:'commandExecution',command:'check',status:'completed',aggregatedOutput:output,exitCode:7}]}]);
  const compact=compactCodexTools(cards,{hubSessionId:'viewer',threadId:'thread'});
  assert(Buffer.byteLength(JSON.stringify(compact))<15000);
  const reference=compact[0].toolCalls[0].resultRef;
  assert.equal(reference.hubSessionId,'viewer');assert.equal(toolResult(cards,reference,'thread'),output);
  assert.throws(()=>toolResult(cards,{...reference,threadId:'other'},'thread'),/不属于/);
});
test('legacy backstage opens without an upgrade and pages all saved native history after resume',()=>{
  const owner=new EventEmitter();Object.assign(owner,{options:{id:'local'},threadId:'thread',runtime:{state:'completed'},transcript:fixtureCards()});
  for(let resume=0;resume<2;resume++){
    const compat=new CodexBackstageCompat(owner);
    try{
      let page=compat.read(),ids=new Set(page.entries.map(e=>e.itemId)),guard=0;
      assert.equal(page.compatibility,true);assert(page.entries.some(e=>e.fields.text?.preview==='PUSH COMPLETE'));
      let before=page.first;
      while(page.more||page.historyMore){assert(++guard<15);page=compat.read({before,history:true});for(const e of page.entries)ids.add(e.itemId);if(page.first!=null)before=page.first;}
      assert.equal(ids.size,82);assert(ids.has('tool-0'));
      const revision=compat.read().revision;assert.equal(compat.read().revision,revision,'idle read causes no writes');
      assert.equal(compat.reader.store.file,':memory:','a viewer cannot open the writer journal');
    }finally{compat.close();}
  }
});
test('legacy backstage follows new output without duplicating an unchanged tool result',()=>{
  const owner=new EventEmitter();Object.assign(owner,{options:{id:'local'},threadId:'thread',runtime:{state:'completed'},transcript:fixtureCards(1)});
  const compat=new CodexBackstageCompat(owner);
  try{
    compat.read();owner.transcript=fixtureCards(2);let page=compat.read();
    assert(page.entries.some(e=>e.itemId==='tool-1'));
    owner.transcript=fixtureCards(2);page=compat.read();const revision=page.revision;
    owner.transcript=fixtureCards(2);assert.equal(compat.read().revision,revision);
    const row=page.entries.find(e=>e.itemId==='tool-0');
    const detail=compat.read({mode:'detail',id:row.id,after:0});assert(detail.chunks.some(c=>c.text==='ORIGINAL-0'));
  }finally{compat.close();}
});
test('brief observation reconnect stays quiet while execution truth remains unknown and controls disabled',()=>{
  const {buildComposerStatusModel}=require('../core/session-status-summary');
  const {getSessionRuntimeTruth}=require('../core/session-runtime-truth');
  const {deriveSessionRuntimeStatus}=require('../renderer/session-runtime-status');
  const session={id:'s',kind:'codex',runtimeBackend:'codex-app-server',nativeRuntime:{...createNativeRuntime(),threadId:'t',turnId:'turn',state:'running',
    connection:'disconnected',observation:{state:'reconnecting',since:1000},reason:'socket closed'}};
  const runtime=deriveSessionRuntimeStatus(session,{now:2000});
  assert.equal(getSessionRuntimeTruth(session).state,'unknown');
  const brief=buildComposerStatusModel(session,{runtime,now:2000});assert.equal(brief.state,'syncing');assert.equal(brief.canStop,false);assert.equal(brief.action,null);
  const persistent=buildComposerStatusModel(session,{runtime,now:40000});assert.equal(persistent.state,'waiting');assert.equal(persistent.action.kind,'reconnect');
  session.nativeRuntime.observation=null;
  assert.equal(buildComposerStatusModel(session,{runtime,now:40000}).state,'dead','real native disconnect is not hidden');
});
test('Claude shares attach ordering without treating its transcript method as a Codex array',()=>{
  const {ClaudeSharedSession}=require('../core/claude-shared-session');
  const s=new ClaudeSharedSession({id:'claude',resumeSessionId:'thread'});
  const row=(id,text)=>({submissionId:id,userMessageId:id,messages:[['m',{text}]],streams:[],status:'completed'});
  s.applyContent({contentRevision:11,nativeRecords:[row('active','new final')]});
  s.applySnapshot({threadId:'thread',contentRevision:10,transcript:[],replaceNativeRecords:true,
    nativeRecords:[row('older','earlier history'),row('active','old draft')]});
  assert.equal(s.contentRevision,11);assert.equal(s.records.size,2);
  assert.equal(s.records.get('active').messages.get('m').text,'new final');
  assert.equal(typeof s.transcript,'function');
});
test('cached-turn refresh preserves final and mounted cards without materializing 1000 hidden messages',async()=>{
  const {parseSessionTranscript}=require('../main/ipc/transcript-handlers');
  const {displayTurns}=require('../core/conversation-display');
  const logical={id:'turn',providerTurnId:'turn',role:'assistant',displayMessages:[
    ...Array.from({length:1000},(_,i)=>({id:'m'+i,text:'commentary '+i,phase:'commentary'})),
    {id:'final',text:'PUSH COMPLETE',phase:'final_answer'}]};
  const native={runtime:{},start:async()=>{},readTranscript:()=>[logical]};
  const result=await parseSessionTranscript({hubSessionId:'s',opts:{refreshTurnIds:['turn'],refreshDisplayIds:['m999']}},{
    commandTranscriptStore:{read:()=>[]},defer:async()=>{},sessionManager:{getSession:()=>({runtimeBackend:'codex-app-server'}),getNativeSession:()=>native}});
  assert.deepEqual(displayTurns(result.refreshedTurns).map(c=>c.id),['m999','final']);
  assert(JSON.stringify(result.refreshedTurns).length<1000);
});
test('legacy hidden bursts and earlier-turn arrivals remain pageable; raw export includes every saved source',async()=>{
  const s=new CodexSharedSession({id:'local',resumeId:'thread'});
  const turns=(id,count)=>nativeTranscriptTurns('thread',[{id,status:'completed',items:Array.from({length:count},(_,i)=>({
    id:id+'-'+i,type:'commandExecution',command:'run',aggregatedOutput:'ORIGINAL-'+id+'-'+i,status:'completed',exitCode:0}))}]);
  s.transcript=turns('a',1);await s.readBackstage();
  s.transcript=[...turns('a',1),...turns('b',1),...turns('c',45)];
  let page=await s.readBackstage(),ids=new Set(page.entries.map(e=>e.id)),guard=0;
  while(page.more||page.historyMore){assert(++guard<10);page=await s.readBackstage({before:page.first,history:true});for(const e of page.entries)ids.add(e.id);}
  assert.equal(ids.size,47);
  s.compatBackstage.close();s.compatBackstage=null;
  page=await s.readBackstage({mode:'raw',after:0});let raw='',chunks=0;
  while(true){raw+=page.chunks.map(c=>c.text).join('');chunks+=page.chunks.length;if(!page.more)break;page=await s.readBackstage({mode:'raw',after:page.last});assert(chunks<1000);}
  assert(raw.includes('ORIGINAL-a-0'));assert(raw.includes('ORIGINAL-b-0'));assert(raw.includes('ORIGINAL-c-44'));
  assert.equal(s.compatBackstage.imported.size,47);s.kill();
});
test('opening raw after readable history still starts at the newest source, not the last imported old page',async()=>{
  const s=new CodexSharedSession({id:'local',resumeId:'thread'});s.transcript=fixtureCards(80);
  await s.readBackstage();const page=await s.readBackstage({mode:'raw'});
  assert(page.chunks.some(c=>c.text==='PUSH COMPLETE'));s.kill();
});
test('a concurrent readable refresh cannot interleave old pages into raw preparation',async()=>{
  const s=new CodexSharedSession({id:'local',resumeId:'thread'});s.transcript=fixtureCards(160);await s.readBackstage();
  const raw=s.readBackstage({mode:'raw'}),readable=s.readBackstage({limit:40});
  const [page,view]=await Promise.all([raw,readable]);
  assert(page.chunks.some(c=>c.text==='PUSH COMPLETE'));assert(view.entries.some(e=>e.itemId==='answer'));s.kill();
});
test('Claude late full history fills a partial message record without reviving deleted messages or streams',()=>{
  const {ClaudeSharedSession}=require('../core/claude-shared-session');const s=new ClaudeSharedSession({id:'claude',resumeSessionId:'thread'});
  const record={submissionId:'s',userMessageId:'u',messages:[['history',{text:'earlier'}],['answer',{text:'draft'}],['removed',{text:'obsolete'}]],streams:[['old-stream',{}]]};
  s.applyContent({contentRevision:11,nativeRecords:[{...record,messagePatch:true,messages:[['answer',{text:'FINAL'}]],streams:[],removedMessageIds:['removed']}]});
  s.applySnapshot({threadId:'thread',contentRevision:10,transcript:[],replaceNativeRecords:true,nativeRecords:[record]});
  assert.deepEqual([...s.records.get('s').messages.keys()],['history','answer']);
  assert.equal(s.records.get('s').messages.get('answer').text,'FINAL');assert.equal(s.records.get('s').streams.size,0);assert.equal(s.contentRevision,11);
});
test('disconnected modern writers never pass compact previews off as complete legacy originals',async()=>{
  const s=new CodexSharedSession({id:'local',resumeId:'thread'});s.backstageSupported=true;s.transcript=compactCodexTools(fixtureCards(1),{threadId:'thread',hubSessionId:'local'});
  await assert.rejects(s.readBackstage(),/正在恢复后台同步/);assert(!s.compatBackstage);s.kill();
});
test('Codex compact file changes retain paths while native diff stays behind the detail reference',()=>{
  const cards=nativeTranscriptTurns('thread',[{id:'turn',status:'completed',items:[{id:'file',type:'fileChange',status:'completed',
    changes:[{path:'src/example.js',kind:{type:'update',move_path:null},diff:'x'.repeat(500000)}]}]}]);
  const compact=compactCodexTools(cards,{threadId:'thread',hubSessionId:'local'});
  assert.equal(compact[0].toolCalls[0].input.changes[0].path,'src/example.js');
  assert(!Object.hasOwn(compact[0].toolCalls[0].input.changes[0],'diff'));
  assert(JSON.stringify(compact).length<15000);
  assert(toolResult(cards,compact[0].toolCalls[0].resultRef,'thread').includes('x'.repeat(500000)));
});
test('group conversation capture keeps compact tool references bound to its local Hub session',()=>{
  const {captureConversationMessages}=require('../core/conversation-capture');
  const s=new CodexSharedSession({id:'group-member',resumeId:'thread'});s.view.codexToolMode='preview-v1';
  s.transcript=compactCodexTools(fixtureCards(1),{hubSessionId:'writer',threadId:'thread'});
  const messages=captureConversationMessages({native:s,providerTurnId:'turn'});
  assert.equal(messages.find(m=>m.toolCalls?.length).toolCalls[0].resultRef.hubSessionId,'group-member');s.kill();
});
