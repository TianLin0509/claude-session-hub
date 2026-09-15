'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),os=require('node:os');
const {ClaudeNativeSession}=require('../core/claude-native-session');
const {NativeAgentJournal}=require('../core/native-agent-journal');
const fixture=path.join(__dirname,'fixtures/claude-stream.js');
test('Claude next prompt recovery closes old writer, preserves unknown journal and never replays',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'quiet-recovery-'));
  const journal=new NativeAgentJournal({directory,sessionId:'hub'});
  const s=new ClaudeNativeSession({executable:process.execPath,commandArgs:[fixture,'--fixture=crash-on-user'],
    env:{...process.env,CLAUDE_CONFIG_DIR:directory},persistSubmission:r=>journal.saveSubmission(r),persistLifecycle:r=>journal.saveLifecycle(r)});
  t.after(()=>s.close());
  await assert.rejects(s.submit('old',{submissionId:'old'}));
  const old=s.client, completed=[];s.on('lifecycle',e=>{if(e.type==='agent-turn-complete')completed.push(e);});
  s.options.commandArgs=[fixture,'--fixture=hold'];
  await Promise.all([s.prepareForNewPrompt(),s.prepareForNewPrompt()]);
  assert.ok(old.proc.exitCode!==null || old.proc.signalCode!==null);
  assert.equal(s.runtime.state,'idle');assert.equal(s.records.get('old').status,'unknown');
  assert.equal(s.records.get('old').reconciliation.source,'hub');
  assert.equal(journal.list().find(r=>r.submissionId==='old').reconciliation.source,'hub');
  assert.equal(s.active,null);assert.equal(completed.length,0);
  assert.equal((await s.submit('old',{submissionId:'old'})).sendStatus,'unknown');
  assert.equal((await s.submit('next',{submissionId:'new'})).sendStatus,'accepted');
});
test('quiet recovery never opens a writer after close failure or clears pending control',async t=>{
  const s=new ClaudeNativeSession({executable:process.execPath,commandArgs:[fixture,'--fixture=hold']});t.after(()=>s.close());
  await s.start();s.unreconciled=true;
  const old=s.client,close=old.close.bind(old);t.after(()=>close());old.close=async()=>{throw Error('writer still alive');};
  await assert.rejects(s.prepareForNewPrompt(),/writer still alive/);assert.equal(s.client,old);assert.equal(s.unreconciled,true);
  old.close=close;s.configurationChange=Promise.resolve();
  await assert.rejects(s.prepareForNewPrompt(),/设置/);assert.equal(s.client,old);
});
test('ordinary work and late-ack wait do not restart without a new send',async t=>{
  const s=new ClaudeNativeSession({executable:process.execPath,commandArgs:[fixture,'--fixture=hold']});t.after(()=>s.close());
  await s.submit('working');const client=s.client;
  await s.prepareForNewPrompt();assert.equal(s.client,client);assert.ok(s.active);
});
test('Claude exact history is read but never promoted to a successful workflow result',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'quiet-history-'));
  const s=new ClaudeNativeSession({executable:process.execPath,commandArgs:[fixture,'--fixture=hold'],env:{...process.env,CLAUDE_CONFIG_DIR:directory}});
  t.after(()=>s.close());await s.submit('old',{submissionId:'old'});const record=s.records.get('old');
  const bucket=path.join(directory,'projects','fixture');fs.mkdirSync(bucket,{recursive:true});
  const file=path.join(bucket,s.sessionId+'.jsonl');
  fs.writeFileSync(file,JSON.stringify({type:'user',uuid:record.userMessageId,sessionId:s.sessionId,message:{content:record.content}})+'\n');
  s.disconnect(new Error('fixture lost response'));await s.prepareForNewPrompt();
  assert.equal(record.reconciliation.history,'received');assert.equal(record.status,'unknown');
  assert.equal(s.recoveryRecords().length,0);assert.equal(s.active,null);
});
test('history corruption and journal write failure cannot silently unblock a Claude send',async t=>{
  for(const failure of ['history','journal']){
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'quiet-fail-'));
    const s=new ClaudeNativeSession({executable:process.execPath,commandArgs:[fixture,'--fixture=hold'],env:{...process.env,CLAUDE_CONFIG_DIR:directory}});
    t.after(()=>s.close());await s.submit('old',{submissionId:'old'});s.disconnect(new Error('lost'));
    if(failure==='history'){
      const bucket=path.join(directory,'projects','fixture');fs.mkdirSync(bucket,{recursive:true});fs.writeFileSync(path.join(bucket,s.sessionId+'.jsonl'),'{broken\n');
    }else s.options.persistLifecycle=()=>{throw Error('disk full');};
    await assert.rejects(s.prepareForNewPrompt());assert.equal(s.unreconciled,true);
    await assert.rejects(s.submit('must not send'),/reconciliation/);
  }
});
const {CodexNativeSession}=require('../core/codex-native-session');
const {CodexAppServerClient}=require('../main/codex-app-server-client');
function codex(){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'quiet-codex-'));
  return new CodexNativeSession({id:home,cwd:__dirname,threadParams:{model:'fixture-model'},turnParams:{model:'fixture-model'},env:{CODEX_HOME:home,CLAUDE_HUB_DATA_DIR:home},
    clientFactory:()=>new CodexAppServerClient({timeoutMs:5000,launch:{command:process.execPath,args:[path.join(__dirname,'fixtures/codex-app-server.js')],env:process.env}})});
}
async function closeCodex(s){if(!s.entry){s.kill();return;}const done=new Promise(resolve=>s.once('exit',resolve));s.kill();await done;}
test('Codex automatically reads the native thread before releasing an unmatched idle receipt',async t=>{
  const s=codex();t.after(()=>closeCodex(s));await s.start();
  const id='unsure';s.apply({type:'submission',submission:{id,status:'unknown',digest:'absent'}});
  const client=s.entry.client,calls=[],request=client.request.bind(client);client.request=(m,...a)=>{calls.push(m);return request(m,...a);};
  await s.prepareForNewPrompt();assert.ok(calls.includes('thread/read'));assert.equal(calls.includes('turn/start'),false);
  assert.equal(s.runtime.submission.reviewSource,'hub');assert.equal(s.runtime.submission.status,'reviewed');
  assert.equal((await s.send('new',{clientSubmissionId:'new'})).ok,true);
});
test('Codex active unknown receipt remains blocked and is never completed by recovery',async t=>{
  const s=codex();t.after(()=>closeCodex(s));await s.start();await s.send('fixture:hold');
  s.apply({type:'submission',submission:{id:'unmatched',status:'unknown',digest:'absent'}});
  await s.prepareForNewPrompt();assert.equal(s.runtime.state,'running');assert.equal(s.runtime.submission.status,'unknown');
  await assert.rejects(s.send('do not duplicate',{requireReady:false}),/提交结果不明/);
});
test('Codex same ID with different native content never gets automatically released',async t=>{
  const s=codex();t.after(()=>closeCodex(s));await s.start();await s.send('original',{clientSubmissionId:'same'});
  while(s.runtime.state!=='completed')await new Promise(r=>setTimeout(r,10));
  s.apply({type:'submission',submission:{id:'same',status:'unknown',digest:'wrong'}});
  await assert.rejects(s.prepareForNewPrompt(),/尚未确认一致/);
  assert.equal(s.runtime.submission.status,'unknown');assert.equal(s.runtime.submission.reviewSource,undefined);
});
