'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {AcpHistoryStore}=require('../core/acp-history-store');
const {AcpSession}=require('../core/acp-session');
function fixture() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-acp-store-unit-'));
  const file=path.join(root,'history.json');
  const snapshot={backend:'acp',kind:'qwen',profileId:'fixture',cwd:root,sessionId:'thread',
    submission:{id:'prompt',status:'accepted'},receipts:[['prompt',{result:{ok:true}}]],configOptions:[],
    turns:[{id:'turn',status:'inProgress',items:[{id:'tool',type:'acpTool',result:'大结果'.repeat(500000)},
      {id:'message',type:'agentMessage',text:'初始🧪'}]}]};
  return {root,file,snapshot};
}
test('legacy migration is lossless and leaves its original file unchanged',()=>{
  const {file,snapshot}=fixture();const original=JSON.stringify(snapshot);fs.writeFileSync(file,original);
  const store=new AcpHistoryStore(file);
  try {
    assert.deepEqual(store.read(),snapshot);
    store.saveItem('turn',{id:'message',type:'agentMessage',text:'已追加🧪'});
    assert.equal(store.read().turns[0].items[1].text,'已追加🧪');
    assert.equal(fs.readFileSync(file,'utf8'),original);
  } finally {store.close();}
  const restored=new AcpHistoryStore(file);
  try{assert.equal(restored.read().turns[0].items[1].text,'已追加🧪');}finally{restored.close();}
});
test('text streaming never rewrites completed large tool rows and survives reopen',()=>{
  const {file,snapshot}=fixture();let store=new AcpHistoryStore(file);store.sync(snapshot);
  store.db.exec(`CREATE TEMP TABLE touched(id TEXT); CREATE TEMP TRIGGER audit_items AFTER UPDATE ON items BEGIN INSERT INTO touched VALUES(NEW.id); END;`);
  for(let i=0;i<50;i++)store.saveItem('turn',{id:'message',type:'agentMessage',text:'增量🧪'.repeat(i+1)});
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM touched WHERE id='tool'").get().n,0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM touched').get().n,50);
  store.close();store=new AcpHistoryStore(file);
  try {const saved=store.read();assert.equal(saved.turns[0].items[0].result,snapshot.turns[0].items[0].result);
    assert.equal(saved.turns[0].items[1].text,'增量🧪'.repeat(50));assert.deepEqual(saved.receipts,snapshot.receipts);
  }finally{store.close();}
});
test('failed writes remain explicit and cannot be followed by a pretend-success update',()=>{
  const {file,snapshot}=fixture();const store=new AcpHistoryStore(file);store.sync(snapshot);
  store.db.exec(`CREATE TEMP TRIGGER reject_update BEFORE UPDATE ON items BEGIN SELECT RAISE(ABORT,'fixture disk failure'); END;`);
  assert.throws(()=>store.saveItem('turn',{id:'message',text:'must not persist'}),/fixture disk failure/);
  assert.throws(()=>store.saveItem('turn',{id:'message',text:'must not continue'}),/fixture disk failure/);
  assert.equal(store.read().turns[0].items[1].text,'初始🧪');store.close();
});
test('foreign legacy scope is rejected before migration and broken data is not replaced',()=>{
  const {file,snapshot}=fixture();fs.writeFileSync(file,JSON.stringify(snapshot));const store=new AcpHistoryStore(file);
  assert.throws(()=>store.read(()=>{throw Error('wrong scope');}),/wrong scope/);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM metadata').get().n,0);store.close();
  fs.writeFileSync(file,'invalid JSON');const broken=new AcpHistoryStore(file);
  assert.throws(()=>broken.read(),/JSON/);assert.equal(fs.readFileSync(file,'utf8'),'invalid JSON');broken.close();
});
test('all three ACP kinds return compact previews but retain exact full tool output',()=>{
  for(const kind of ['qwen','deepseek-acp','glm']) {
    const session=new AcpSession({id:'test',kind});session.threadId='thread';
    const result=[{type:'content',content:{type:'text',text:'结果🧪'.repeat(200000)}}];
    session.history.set('turn',{id:'turn',status:'completed',items:[{id:'u',type:'userMessage',content:[{type:'text',text:'测试'}]},
      {id:'tool',type:'acpTool',title:'Edit fixture',status:'completed',result,content:result,rawOutput:{full:'x'.repeat(1000000)}}]});
    const normal=session.readTranscript({limit:2}),compact=session.readTranscript({limit:2,toolPreviews:true});
    assert(Buffer.byteLength(JSON.stringify(compact))<10000);
    assert.deepEqual(normal[1].toolCalls[0].output,result);
    assert.equal(session.readToolResult(compact[1].toolCalls[0].resultRef),JSON.stringify(result,null,2));
    assert.throws(()=>session.readToolResult({...compact[1].toolCalls[0].resultRef,threadId:'wrong'}),/不属于/);
    assert.equal(compact[1].kind,kind);
  }
});

test('an older Hub changing legacy JSON after migration cannot be silently ignored',()=>{
  const {file,snapshot}=fixture();fs.writeFileSync(file,JSON.stringify(snapshot));
  let store=new AcpHistoryStore(file);store.read();
  store.saveItem('turn',{id:'message',text:'new database output'});store.close();
  snapshot.turns.push({id:'old-hub-new-turn',items:[]});
  const changed=JSON.stringify(snapshot);fs.writeFileSync(file,changed);
  store=new AcpHistoryStore(file);
  try{assert.throws(()=>store.read(),/迁移后发生变化/);
    assert.equal(fs.readFileSync(file,'utf8'),changed);
    assert.match(store.db.prepare("SELECT value FROM items WHERE id='message'").get().value,/new database output/);
  }finally{store.close();}
});

test('receipts and terminal lifecycle events are not published before durable storage',async()=>{
  for(const stage of ['accepted','completed']) {
    const {root}=fixture();
    const session=new AcpSession({id:'durability',kind:'qwen',cwd:root,storeDir:root,profileId:'fixture'});
    session.threadId='thread';session.apply({type:'started',threadId:'thread',turn:{id:'turn'}});
    session.runtime.submission={id:'prompt',status:'submitting'};
    session.items.set('user',{id:'user',type:'userMessage',content:[{type:'text',text:'hello'}]});
    session.history.set('turn',{id:'turn',status:'inProgress',items:[...session.items.values()]});
    let acknowledged=false;const lifecycle=[];
    session.active={id:'prompt',turnId:'turn',digest:'digest',text:'hello',at:Date.now(),resolve:()=>{acknowledged=true;}};
    session.on('lifecycle',event=>lifecycle.push(event));session.persist();
    const store=session.historyStore();
    if(stage==='completed')session.acknowledge();
    try {
      if(stage==='accepted') {
        store.db.exec("CREATE TEMP TRIGGER reject_meta BEFORE INSERT ON metadata BEGIN SELECT RAISE(ABORT,'disk failure'); END;");
        assert.throws(()=>session.acknowledge(),/disk failure/);
        assert.equal(acknowledged,false);assert.equal(lifecycle.length,0);
      } else {
        store.db.exec("CREATE TEMP TRIGGER reject_turn BEFORE UPDATE ON turns BEGIN SELECT RAISE(ABORT,'disk failure'); END;");
        assert.throws(()=>session.finish(session.active,'completed',null),/disk failure/);
        assert.equal(session.history.get('turn').status,'inProgress');
        assert.equal(lifecycle.some(event=>event.type==='turn-complete'),false);
        assert.equal(await session.readOutcome('turn'),null);
      }
      await assert.rejects(session.send('must not send'),/历史保存失败/);
      assert.equal(store.read().turns[0].status,'inProgress');
    }finally{store.close();}
  }
});
