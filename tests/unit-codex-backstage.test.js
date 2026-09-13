'use strict';
const { test }=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const { EventEmitter }=require('node:events');
const { CodexBackstageStore }=require('../core/codex-backstage-store');
const { CodexBackstage }=require('../core/codex-backstage');
const { CodexAppServerClient }=require('../main/codex-app-server-client');
const { CodexNativeSession }=require('../core/codex-native-session');
const { writeAll, exportChunkText }=require('../main/ipc/codex-backstage-handlers');
function detail(store,id){let after=0,text='';for(;;){const page=store.read({mode:'detail',id,after});text+=page.chunks.map(c=>c.text).join('');after=page.last;if(!page.more)break;}return text;}
function raw(store){let after=0,text='';for(;;){const page=store.read({mode:'raw',after});text+=page.chunks.map(c=>c.text).join('');after=page.last;if(!page.more)break;}return text;}
function session(root){const s=new EventEmitter();Object.assign(s,{options:{id:'view-'+Math.random(),hubDataDir:root,env:{CODEX_HOME:root}},threadId:'thread-'+Math.random(),runtime:{turnId:'t',state:'running'},history:new Map()});return s;}

test('NUL and surrogate pairs split across native deltas survive storage and final snapshots',()=>{
  const s=new CodexBackstageStore();try{
    s.append('x','output','abc\u0000def\ud83d');s.flush();s.releaseHashes('x');s.append('x','output','\ude00');
    assert.equal(detail(s,'x'),'abc\u0000def😀');assert.equal(raw(s),'abc\u0000def😀');
    s.set('x','output','abc\u0000def😀');assert.equal(raw(s),'abc\u0000def😀');
  }finally{s.close();}
});
test('request failure preserves native code/data for only its requesting session',async()=>{
  const owner={backstage:new CodexBackstage(session())},other=new CodexBackstage(session());
  const client=new CodexAppServerClient();client.send=async()=>{};
  try{
    const request=CodexNativeSession.prototype.requestNative.call(owner,client,'thread/start',{});
    const rejection=assert.rejects(request,error=>error.code===-32001);
    client.feed(Buffer.from(JSON.stringify({id:1,error:{code:-32001,message:'Request failed',data:{reason:'FIRST_HAND_EACCES',stack:'FULL_NATIVE_STACK'}}})+'\n'));
    await rejection;const source=raw(owner.backstage.ensure());assert.match(source,/FIRST_HAND_EACCES/);assert.match(source,/FULL_NATIVE_STACK/);assert.match(source,/-32001/);assert.equal(raw(other.ensure()),'');
  }finally{owner.backstage.close();other.close();}
});
test('empty historical failed turns expose original error details',()=>{
  const s=session();s.history.set('old',{id:'old',status:'failed',items:[],error:{message:'EACCES original cause',additionalDetails:'NATIVE_DETAILS'}});
  const b=new CodexBackstage(s);try{const page=b.read();assert.equal(page.entries.length,1);assert.equal(page.entries[0].status,'failed');assert.match(page.entries[0].fields.error.preview,/NATIVE_DETAILS/);}finally{b.close();}
});
test('empty failed history also respects the bounded import budget',()=>{
  const s=session();for(let i=0;i<1000;i++)s.history.set(String(i),{id:String(i),status:'failed',items:[],error:{message:'original '+i}});
  const b=new CodexBackstage(s);try{const page=b.read();assert.equal(page.entries.length,40);assert.equal(page.historyMore,true);assert.equal(b.ensure().db.prepare('SELECT COUNT(*) AS n FROM entries').get().n,40);}finally{b.close();}
});
test('export writes all bytes through short writes and rejects stalled writes',async()=>{
  const result=[];await writeAll({async write(buffer,offset,length){const n=Math.min(length,3);result.push(buffer.subarray(offset,offset+n));return {bytesWritten:n};}},'完整原文 😀');
  assert.equal(Buffer.concat(result).toString('utf8'),'完整原文 😀');
  await assert.rejects(writeAll({async write(){return {bytesWritten:0};}},'原文'),/未完成/);
  assert.equal(exportChunkText('原文😀'),'原文😀');
  assert.equal(JSON.parse(exportChunkText('\ud83d').slice('[UTF-16 JSON] '.length)),'\ud83d');
});

test('large original streams are exact, paged, and previews stay bounded after reopen',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'backstage-store-')),file=path.join(root,'log.sqlite');let store=new CodexBackstageStore(file);
  const text=('命令错误 😀\n'+('x'.repeat(97))).repeat(25000);
  try{store.update('tool',{type:'commandExecution',status:'running'});for(let i=0;i<text.length;i+=301)store.append('tool','output',text.slice(i,i+301));
    assert.equal(detail(store,'tool'),text);assert.equal(raw(store),text);
    const summary=store.read();assert(summary.entries[0].fields.output.preview.length<=4096);assert(JSON.stringify(summary).length<6000);
    store.close();store=new CodexBackstageStore(file);assert.equal(detail(store,'tool'),text);
    assert.equal(store.read({mode:'raw',after:0}).chunks.length,16);
  }finally{store.close();}
});
test('revised snapshots replace current detail and retain both originals in chronological log',()=>{
  const s=new CodexBackstageStore();try{s.set('a','text','first');s.set('a','text','fixed');assert.equal(detail(s,'a'),'fixed');assert.equal(raw(s),'firstfixed');s.set('a','text','fixed');assert.equal(raw(s),'firstfixed');}finally{s.close();}
});
test('tool interleaving stays separate; failure and absent exit codes retain provider semantics',()=>{
  const sessionA=session();const b=new CodexBackstage(sessionA);try{
    b.item('t',{id:'one',type:'commandExecution',command:'python first.py'},false);
    b.item('t',{id:'two',type:'commandExecution',command:'python second.py'},false);
    b.delta('t','one','output','FIRST 原始错误\n');b.delta('t','two','output','SECOND\n');
    b.item('t',{id:'one',type:'commandExecution',status:'failed',exitCode:7,error:{message:'拒绝访问',code:'EACCES',stack:'original stack'}},true);
    b.item('t',{id:'two',type:'commandExecution',status:'completed'},true);
    const rows=b.read().entries;const one=rows.find(r=>r.itemId==='one'),two=rows.find(r=>r.itemId==='two');
    assert.equal(one.exitCode,7);assert.equal(two.exitCode,undefined);assert.match(one.fields.error.preview,/original stack/);
    assert.match(detail(b.store,one.id),/FIRST/);assert(!detail(b.store,one.id).includes('SECOND'));
  }finally{b.close();}
});
test('completion truncation cannot replace the first-hand streamed output',()=>{
  const b=new CodexBackstage(session());try{b.delta('t','tool','output','HEAD\n'+'x'.repeat(40000)+'\nTAIL');b.item('t',{id:'tool',type:'commandExecution',aggregatedOutput:'truncated TAIL',status:'completed'},true);
    const row=b.read().entries[0];assert.equal(row.fields.output.length,40010);assert.equal(row.fields['reported-output'].preview,'truncated TAIL');assert.match(detail(b.store,row.id),/^HEAD/);
  }finally{b.close();}
});
test('history is loaded on demand in source order; completed events need no item-completed predecessor',()=>{
  const s=session();s.history.set('old',{id:'old',status:'completed',items:Array.from({length:100},(_,i)=>({id:String(i),type:'agentMessage',text:'history-'+i}))});const b=new CodexBackstage(s);
  try{let first=b.read();assert.equal(first.historyMore,true);assert.equal(first.entries[0].fields.text.preview,'history-60');assert.equal(first.entries.at(-1).fields.text.preview,'history-99');
    const older=b.read({before:first.first,history:true});assert.equal(older.entries[0].fields.text.preview,'history-20');assert.equal(older.entries.at(-1).fields.text.preview,'history-59');
    b.notification({method:'turn/completed',params:{threadId:s.threadId,turn:{id:'t',status:'failed',items:[{id:'last',type:'agentMessage',text:'terminal only'}],error:{message:'provider failure',additionalDetails:'full cause'}}}});
    let revision=first.revision,found=false,more=true;while(more){const page=b.read({since:revision});found ||= page.entries.some(e=>e.fields.text?.preview==='terminal only');revision=page.revision;more=page.more;}assert(found);
    assert(raw(b.store).includes('full cause'));
  }finally{b.close();}
});
test('pre-bind records move to the owned thread journal and survive native restart',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'backstage-bind-'));const s=session(root);s.threadId=null;const b=new CodexBackstage(s);
  b.note('startup','first-hand startup error','error');s.threadId='native-owned';b.bind();b.item('t',{id:'a',type:'agentMessage',text:'answer'},true);b.close();
  const restarted=session(root);restarted.threadId='native-owned';const resumed=new CodexBackstage(restarted);try{const text=raw(resumed.ensure());assert.match(text,/first-hand startup error/);assert.match(text,/answer/);}finally{resumed.close();}
});
test('capture write failure is explicit and does not modify native execution state',()=>{
  const s=session();let event;s.on('backstage-updated',data=>event=data);const b=new CodexBackstage(s);b.ensure();b.store.putChunk={run(){throw Error('disk full fixture');}};b.note('stderr','original diagnostic');
  assert.throws(()=>b.store.flush(),/disk full/);b.failed(b.store.failure);assert.match(event.error,/disk full/);assert.throws(()=>b.read(),/disk full/);assert.equal(s.runtime.state,'running');b.close();
});
test('stderr streams before process failure, preserves UTF-8 and redacts split known credentials',()=>{
  const c=new CodexAppServerClient({env:{OPENAI_API_KEY:'secret-key-123456789'}});let result='';c.on('stderr',text=>result+=text);
  const source=Buffer.from('真实错误 😀 secret-key-123456789\nstack: first-hand\n');
  for(const byte of source){c.feedStderr(c.stderrDecoder.write(Buffer.from([byte])));c.flushStderr(false);}
  c.feedStderr(c.stderrDecoder.end());c.flushStderr();assert.equal(result,'真实错误 😀 [redacted]\nstack: first-hand\n');assert.equal(c.closed,false);
});
test('incremental revisions return bounded changed steps instead of completed history',()=>{
  const s=new CodexBackstageStore();try{for(let i=0;i<200;i++){s.update('t'+i,{type:'commandExecution',status:'completed'});s.set('t'+i,'output','a'.repeat(6000));}const first=s.read();assert.equal(first.entries.length,40);const rev=first.revision;
    s.append('t199','output','changed');const delta=s.read({since:rev});assert.equal(delta.entries.length,1);assert.equal(delta.entries[0].id,'t199');assert(JSON.stringify(delta).length<6000);
  }finally{s.close();}
});
test('complete credentials with a repeated prefix/suffix are never split back into plaintext',()=>{
  for(const secret of ['token-token','abc1234a'])for(let split=0;split<=secret.length;split++){
    const c=new CodexAppServerClient({env:{OPENAI_API_KEY:secret}});let result='';c.on('stderr',text=>result+=text);
    c.feedStderr(secret.slice(0,split));c.flushStderr(false);c.feedStderr(secret.slice(split));c.flushStderr(false);c.flushStderr(true);
    assert.equal(result,'[redacted]',secret+' at '+split);
  }
});
test('diagnostics do not retain unbounded per-event hashing state',()=>{
  const b=new CodexBackstage(session());try{for(let i=0;i<1000;i++)b.note('warning','message '+i);assert.equal(b.store.hashes.size,0);
    for(let i=0;i<1000;i++)b.note('App Server stderr（共享进程）','line '+i+'\n','warning');assert.equal(b.store.hashes.size,1);
  }finally{b.close();}
});
