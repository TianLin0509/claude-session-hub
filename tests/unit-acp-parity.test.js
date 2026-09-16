'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {AcpSession}=require('../core/acp-session');
function setup(kind='qwen') {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-acp-parity-unit-'));
  return {id:'test',kind,cwd:root,profileId:'fixture',model:'fixture',storeDir:root,
    launch:{command:process.execPath,args:[path.join(__dirname,'fixtures/acp-agent.js')],cwd:root,env:process.env}};
}
async function until(fn){const end=Date.now()+6000;while(!fn()){if(Date.now()>end)throw Error('condition timeout');await new Promise(r=>setTimeout(r,10));}}
function raw(s){let after=0,text='';for(;;){const page=s.readBackstage({mode:'raw',after,limit:16});text+=page.chunks.map(c=>c.text).join('');if(!page.more)return text;after=page.last;}}
test('three ACP engines retain paged original records, Unicode and native results across reopen',async()=>{
  for(const kind of ['qwen','deepseek-acp','glm']) {
    const opts=setup(kind);let s=new AcpSession(opts);
    try {
      await s.start();await s.send('hello');await s.idle(2000);
      const turn=[...s.history.values()][0],item=turn.items.find(i=>i.type==='agentMessage');
      const exact='中文\0'+String.fromCharCode(0xd83e,0xdded)+'x'.repeat(120000)+'END';
      s.backstage.chunk(turn.id,item,exact.slice(0,4));s.backstage.chunk(turn.id,item,exact.slice(4));
      const read=s.readBackstage({limit:60});assert(JSON.stringify(read).length<30000);
      assert(read.entries.some(e=>e.title===s.label));assert(raw(s).includes(exact));assert(raw(s).includes('end_turn'));
      s.kill();s=new AcpSession({...opts,resumeId:'fixture-session'});await s.start();
      await s.prepareBackstageExport();assert(raw(s).includes(exact));assert(raw(s).includes('file contents'));
    }finally{s.kill();}
  }
});
test('busy prompts are durable, unacknowledged until sent, delivered once in order',async()=>{
  const s=new AcpSession(setup());const submitted=[];s.on('lifecycle',e=>{if(e.type==='prompt-submitted')submitted.push(e.clientSubmissionId);});
  try {
    await s.send('HEAVY_STREAM',{clientSubmissionId:'first'});
    const second=await s.send('second',{clientSubmissionId:'second'});
    assert.equal(second.sendStatus,'queued');assert(!second.acknowledgementSource);
    assert.equal((await s.send('second',{clientSubmissionId:'second'})).sendStatus,'queued');
    await assert.rejects(s.send('different',{clientSubmissionId:'second'}),/正文/);
    await s.send('third',{clientSubmissionId:'third'});
    const db=s.historyStore().db;const meta=JSON.parse(db.prepare('SELECT value FROM metadata').get().value);
    assert.deepEqual(meta.pendingPrompts.map(r=>r.text),['second','third']);assert.deepEqual(submitted,['first']);
    await until(()=>s.history.size===3 && !s.active && !s.promptQueue.records.length);
    assert.deepEqual(submitted,['first','second','third']);
    assert.deepEqual([...s.history.values()].map(t=>t.items[0].content[0].text),['HEAVY_STREAM','second','third']);
  }finally{s.kill();}
});
test('Stop and reopen hold unsent messages; explicit resume sends once and stale actions fail',async()=>{
  const opts=setup();let s=new AcpSession(opts);
  try {
    await s.send('cancel');await s.send('retained',{clientSubmissionId:'held'});
    await s.interrupt();await s.idle(2000);
    assert.equal(s.promptQueue.records[0].status,'held');assert.equal(s.history.size,1);
    s.kill();s=new AcpSession({...opts,resumeId:'fixture-session'});await s.start();
    assert.equal(s.promptQueue.records[0].text,'retained');assert.equal(s.promptQueue.records[0].status,'held');
    assert.throws(()=>s.promptQueue.action('held','resume',s.runtime.epoch-1),/旧连接/);
    s.promptQueue.action('held','resume',s.runtime.epoch);
    await until(()=>s.history.size===2 && !s.active && !s.promptQueue.records.length);
    assert.match(s.finalText(),/retained/);
  }finally{s.kill();}
});
test('unknown acknowledgement holds future input and a late terminal does not auto-send it',async()=>{
  const s=new AcpSession({...setup(),ackTimeoutMs:90});
  try {
    const first=s.send('silent');const failed=assert.rejects(first,/执行证据/);
    await until(()=>!!s.active);await s.send('do-not-auto-send',{clientSubmissionId:'future'});
    await failed;assert.equal(s.promptQueue.records[0].status,'held');
    await s.interrupt();await s.idle(2000);assert.equal(s.history.size,1);
    s.promptQueue.action('future','remove',s.runtime.epoch);assert.equal(s.promptQueue.records.length,0);
  }finally{s.kill();}
});
test('native context measurement survives history restore without fabricating cumulative tokens',async()=>{
  const opts=setup();let s=new AcpSession(opts);
  try {
    await s.send('cancel');s.notification({method:'session/update',params:{sessionId:s.threadId,update:{sessionUpdate:'usage_update',used:1234,size:10000}}});
    await s.interrupt();await s.idle(2000);
    s.kill();s=new AcpSession({...opts,resumeId:'fixture-session'});await s.start();
    const usage=s.readTranscript({}).find(c=>c.role==='assistant').usage;
    assert.deepEqual(usage,{context_tokens:1234,context_window:10000});
  }finally{s.kill();}
});
test('failure saving the new turn never sends or drops its previously saved queue intent',async()=>{
  const s=new AcpSession(setup());
  await s.start();const store=s.historyStore(),sync=store.sync.bind(store),request=s.client.request.bind(s.client);let calls=0;
  s.client.request=(method,...args)=>{if(method==='session/prompt')calls++;return request(method,...args);};
  store.sync=value=>{if(value.turns.some(t=>t.status==='inProgress'))throw Error('turn storage failed');return sync(value);};
  try {
    await assert.rejects(s.send('preserve me',{clientSubmissionId:'persist-fail'}),/turn storage failed/);
    assert.equal(calls,0);assert.equal(s.active,null);assert.equal(s.history.size,0);
    assert.equal(s.promptQueue.records[0].text,'preserve me');assert.equal(s.promptQueue.records[0].status,'held');
    assert.equal(JSON.parse(store.db.prepare('SELECT value FROM metadata').get().value).pendingPrompts[0].text,'preserve me');
  }finally{store.sync=sync;s.kill();}
});

test('failed queue removal preserves the unsent message in memory and on disk',async()=>{
  const s=new AcpSession(setup());let store,sync;
  try {
    await s.send('cancel');await s.send('retain on disk failure',{clientSubmissionId:'held'});
    await s.interrupt();await s.idle(2000);
    store=s.historyStore();sync=store.sync.bind(store);
    store.sync=()=>{throw Error('disk full');};
    assert.throws(()=>s.promptQueue.action('held','remove',s.runtime.epoch),/disk full/);
    assert.equal(s.promptQueue.records[0].text,'retain on disk failure');
    assert.equal(s.runtime.queued[0].status,'held');
    assert.equal(JSON.parse(store.db.prepare('SELECT value FROM metadata').get().value).pendingPrompts[0].id,'held');
  }finally{if(sync)store.sync=sync;s.kill();}
});
