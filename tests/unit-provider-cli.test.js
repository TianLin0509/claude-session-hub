'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {normalizeProviderCwd}=require('../core/provider-cli-protocol');
const {PromptSubmissionReceipts}=require('../core/prompt-submission-receipts');
test('Windows canonical paths preserve workspace identity without changing prompt text',()=>{
  for(const [cwd,expected]of [['\\\\?\\C:\\work\\x','C:\\work\\x'],['\\\\?\\UNC\\server\\share','\\\\server\\share'],['C:\\work','C:\\work']]){
    assert.equal(normalizeProviderCwd({method:'session/new',params:{cwd}}).params.cwd,expected);
    const prompt={method:'session/prompt',params:{cwd,text:cwd}};assert.equal(normalizeProviderCwd(prompt),prompt);
  }
});
test('CLI observation receipts require the same submission, thread and turn',()=>{
  for(const source of ['qwen-cli','provider-cli']){
    const receipts=new PromptSubmissionReceipts();
    const receipt=receipts.begin('s','request','hello',100,{nativeOnly:true});
    assert.equal(receipts.observe({hubSessionId:'s',text:'hello',submittedAt:101,signalSource:source}),false);
    const event={hubSessionId:'s',text:'hello',submittedAt:101,signalSource:source,threadId:'thread',turnId:'turn',clientSubmissionId:'wrong'};
    assert.equal(receipts.observe(event),false);assert.equal(receipts.observe({...event,clientSubmissionId:'request'}),true);assert.equal(receipt.status,'confirmed');
  }
});
test('Qwen native history renders text and tools; only matching root hooks finish its turn',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-qwen-unit-'));fs.mkdirSync(path.join(root,'.qwen'));fs.writeFileSync(path.join(root,'.qwen/settings.json'),'{}');
  const file=path.join(root,'native.jsonl');
  fs.writeFileSync(file,[{sessionId:'thread',uuid:'u',type:'user',provenance:'real_user',timestamp:new Date(1000).toISOString(),message:{parts:[{text:'hello'}]}},
    {sessionId:'thread',uuid:'a',type:'assistant',timestamp:new Date(1100).toISOString(),message:{parts:[{text:'answer'},{functionCall:{id:'tool',name:'read_file',args:{path:'x'}}}]}},
    {sessionId:'thread',uuid:'r',type:'user',timestamp:new Date(1200).toISOString(),message:{parts:[{functionResponse:{id:'tool',response:{output:'ok'}}}]}}].map(JSON.stringify).join('\n')+'\n');
  const {QwenCliSession}=require('../core/qwen-cli-session');const s=new QwenCliSession({id:'hub',kind:'qwen',home:root,cwd:root,launch:{command:process.execPath,args:['qwen.js']}});
  const events=[];s.on('lifecycle',e=>events.push(e));
  try{
    s.observe({hook_event_name:'SessionStart',session_id:'thread',cwd:root,transcript_path:file});
    await s.transcriptTail._drain();await new Promise(r=>setTimeout(r,30));
    s.observe({hook_event_name:'UserPromptSubmit',session_id:'thread',cwd:root,prompt:'hello',timestamp:new Date(1000).toISOString()});
    s.observe({hook_event_name:'Stop',session_id:'other',cwd:root,last_assistant_message:'wrong'});
    s.observe({hook_event_name:'Stop',session_id:'thread',agent_id:'nested',cwd:root,last_assistant_message:'wrong'});
    assert.equal(s.runtime.state,'running');
    s.observe({hook_event_name:'Stop',session_id:'thread',cwd:root,last_assistant_message:'answer',timestamp:new Date(2000).toISOString()});
    const cards=s.readTranscript({turnId:s.runtime.turnId});assert.equal(cards.length,2);
    assert.equal(cards[1].text,'answer');assert.equal(cards[1].toolCalls[0].status,'completed');assert.equal(cards[1].providerTurnId,s.runtime.turnId);
    assert.equal(events.filter(e=>e.type==='turn-complete').length,1);
  }finally{s.kill();fs.rmSync(root,{recursive:true,force:true});}
});
test('CLI tap preserves split UTF-8 messages and redacts credentials only in its observation log',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-cli-tap-unit-'));
  const agent=path.join(root,'agent.js'),log=path.join(root,'events.jsonl');
  fs.writeFileSync(agent,"const r=require('readline').createInterface({input:process.stdin});r.on('line',s=>process.stdout.write(s+'\\n'));");
  const proc=require('node:child_process').spawn(process.execPath,[path.resolve(__dirname,'../scripts/provider-cli-tap.js')],{
    windowsHide:true,env:{...process.env,AI_HUB_CLI_AGENT_LAUNCH:JSON.stringify({command:process.execPath,args:[agent],cwd:root}),AI_HUB_CLI_EVENT_LOG:log,AI_HUB_CLI_REDACT:JSON.stringify(['test-secret'])},stdio:['pipe','pipe','pipe']});
  let output='',stderr='';proc.stdout.on('data',s=>output+=s);proc.stderr.on('data',s=>stderr+=s);
  const line=JSON.stringify({id:1,method:'session/prompt',params:{text:'中文🙂test-secret'}})+'\n';const bytes=Buffer.from(line);
  for(let i=0;i<bytes.length;i++)proc.stdin.write(bytes.subarray(i,i+1));proc.stdin.end();
  const code=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{proc.kill();reject(new Error('tap timeout'));},10000);proc.on('error',reject);proc.on('close',code=>{clearTimeout(timer);resolve(code);});});
  try{assert.equal(code,0,stderr);assert.equal(output,line);const records=fs.readFileSync(log,'utf8');assert(!records.includes('test-secret'));assert(records.includes('中文🙂[redacted]'));}
  finally{fs.rmSync(root,{recursive:true,force:true});}
});
