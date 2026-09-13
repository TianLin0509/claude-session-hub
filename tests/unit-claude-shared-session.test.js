'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {ClaudeSharedSession}=require('../core/claude-shared-session');
const {readMetadata,connectBroker}=require('../main/codex-runtime-broker-client');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn){const end=Date.now()+5000;while(Date.now()<end){if(fn())return;await sleep(20);}throw Error('shared Claude state timeout');}
test('a new viewer receives the saved usage snapshot even without an observedAt field',()=>{
  const session=new ClaudeSharedSession({id:'usage-view'}),updates=[];
  session.on('session-usage',usage=>updates.push(usage));
  session.applyContent({sessionUsage:{total:100,sourcePath:'history.jsonl'}});
  session.applyContent({sessionUsage:{total:100,sourcePath:'history.jsonl'}});
  session.applyContent({sessionUsage:{total:200,sourcePath:'history.jsonl'}});
  assert.deepEqual(updates.map(usage=>usage.total),[100,200]);
});
test('Claude views share one native writer, preserve receipts and release control only after stop',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'claude-shared-unit-')),dataDir=path.join(root,'data');
  fs.mkdirSync(dataDir,{recursive:true});
  process.env.AI_HUB_CODEX_BROKER_TEST='1';
  const fixture=path.resolve(__dirname,'fixtures/claude-stream.js');
  const settingsA=path.join(root,'a.json'),settingsB=path.join(root,'b.json');
  for(const file of [settingsA,settingsB])fs.writeFileSync(file,JSON.stringify({fastMode:false}));
  const options={id:'a',hubDataDir:dataDir,ownership:true,cwd:root,env:{...process.env,CLAUDE_CONFIG_DIR:path.join(root,'claude'),CLAUDE_HUB_DATA_DIR:dataDir},
    settingsFile:settingsA,executable:process.execPath,commandArgs:[fixture,'--fixture=hold'],launchArgs:['--permission-mode','acceptEdits','--settings',settingsA]};
  const a=new ClaudeSharedSession(options);let b;
  try {
    await a.start();assert.equal(a.control.role,'controller');assert(a.pid);
    b=new ClaudeSharedSession({...options,id:'b',resumeSessionId:a.sessionId,settingsFile:settingsB,
      launchArgs:['--permission-mode','acceptEdits','--settings',settingsB]});await b.start();
    assert.equal(b.sessionId,a.sessionId);assert.equal(b.pid,a.pid);assert.equal(b.control.role,'viewer');
    const receipt=await a.submit('原文\n第二行',{clientSubmissionId:'first'});
    assert.equal(receipt.sendStatus,'accepted');
    try{await until(()=>['starting','running'].includes(b.runtime.state) && b.records.has('first'));}
    catch(error){throw Error(error.message+' '+JSON.stringify({runtime:b.runtime,records:[...b.records.keys()],key:b.key,aKey:a.key}));}
    assert.equal(b.records.get('first').text,'原文\n第二行');
    await assert.rejects(b.submit('duplicate'),/只能查看/);await assert.rejects(b.requestControl(),/工作中/);
    const engine=a.pid,client=b.client;b.client.socket.destroy();
    await until(()=>b.client && b.client!==client && b.runtime.connection==='connected' && b.records.has('first'));
    assert.equal(b.pid,engine);assert.equal(b.records.size,1);
    await a.interrupt();await until(()=>b.runtime.state==='interrupted');
    await b.requestControl();await until(()=>a.control.role==='viewer');
    assert.equal(b.pid,engine);assert.deepEqual(a.transcript(),b.transcript());
    assert.equal(b.options.settingsFile,settingsA);
    await b.setFastMode(true);
    assert.equal(JSON.parse(fs.readFileSync(settingsA)).fastMode,true);
    assert.equal(JSON.parse(fs.readFileSync(settingsB)).fastMode,false);
    await a.close();assert.equal(b.control.role,'controller');
    assert(fs.readFileSync(path.join(dataDir,'native-agent-submissions/a.jsonl'),'utf8').includes('first'));
  } finally {
    await a.close();if(b)await b.close();
    if(readMetadata(dataDir)){const client=await connectBroker({dataDir});await client.request('shutdown-test');client.close();}
    delete process.env.AI_HUB_CODEX_BROKER_TEST;
  }
});
