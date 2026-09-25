'use strict';
// Real installed Codex, synthetic paginated history, no credentials/model calls.
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const {randomUUID}=require('crypto');
const {DatabaseSync}=require('node:sqlite');
const {CodexAppServerClient}=require('../main/codex-app-server-client');
const {CodexNativeSession}=require('../core/codex-native-session');
const {persistNativeRuntime}=require('../core/codex-native-runtime');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'20260924-paginated-account-codex1-'));
const result={root,checks:[],modelTurnsSent:0};
async function close(driver){
 if(!driver || driver.closed)return;
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('close timeout')),15000);
  driver.once('exit',()=>{clearTimeout(timer);resolve();});driver.kill();});
}
async function scenario(custom){
 const dir=path.join(root,custom?'custom-db':'default-db');fs.mkdirSync(dir);
 const a=path.join(dir,'a'),b=path.join(dir,'b'),cwd=path.join(dir,'work'),data=path.join(dir,'hub');
 for(const p of [a,b,cwd,data])fs.mkdirSync(p);
 const sqliteHome=custom?path.join(dir,'history-db'):a;
 if(custom){fs.mkdirSync(sqliteHome);fs.writeFileSync(path.join(a,'config.toml'),'sqlite_home = '+JSON.stringify(sqliteHome)+'\n');}
 // B has its own storage setting; a resumed session must override it.
 fs.writeFileSync(path.join(b,'config.toml'),'sqlite_home = '+JSON.stringify(b)+'\n');
 const env={...process.env,CODEX_HOME:a,CLAUDE_HUB_DATA_DIR:data,CLAUDE_HUB_HOME_DIR:dir,
  OPENAI_API_KEY:'',CODEX_API_KEY:'',CODEX_ACCESS_TOKEN:'',DEEPSEEK_API_KEY:'',CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:''};
 for(const key of ['CODEX_SQLITE_HOME','CODEX_THREAD_ID','CODEX_SESSION_ID','CLAUDE_HUB_TOKEN','CLAUDE_HUB_PORT'])delete env[key];
 const id=randomUUID(),turn=randomUUID(),timestamp=new Date().toISOString();
 const file=path.join(a,'sessions',...timestamp.slice(0,10).split('-'),
  'rollout-'+timestamp.slice(0,19).replaceAll(':','-')+'-'+id+'.jsonl');
 fs.mkdirSync(path.dirname(file),{recursive:true});
 const records=[
  {type:'session_meta',payload:{id,timestamp,cwd,originator:'ai_hub',cli_version:'0.153.4',source:'vscode',model_provider:'openai'}},
  {type:'event_msg',payload:{type:'task_started',turn_id:turn,started_at:Math.floor(Date.now()/1000),model_context_window:258400,collaboration_mode_kind:'default'}},
  {type:'turn_context',payload:{turn_id:turn,cwd,approval_policy:'never',sandbox_policy:{type:'read-only'},model:'gpt-6-astra',effort:'high',summary:'auto'}},
  {type:'event_msg',payload:{type:'user_message',message:'Remember this saved question',images:[],local_images:[],text_elements:[]}},
  {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'Remember this saved question'}]}},
  {type:'response_item',payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'Saved paginated answer'}]}},
  {type:'event_msg',payload:{type:'agent_message',message:'Saved paginated answer',phase:'final_answer'}},
  {type:'event_msg',payload:{type:'task_complete',turn_id:turn,last_agent_message:'Saved paginated answer'}},
 ];
 for(const record of records)if(record.type==='response_item'){
  record.payload.id='msg_'+randomUUID();
  record.payload.internal_chat_message_metadata_passthrough={turn_id:turn,create_time:Date.now()/1000,content_item_kinds:['unknown']};
 }
 const save=()=>fs.writeFileSync(file,records.map((r,ordinal)=>JSON.stringify({timestamp,ordinal,...r})).join('\n')+'\n');save();
 const params={threadId:id,path:file,cwd,model:'gpt-6-astra',approvalPolicy:'never',sandbox:'read-only'};
 const seed=new CodexAppServerClient({cwd,env,args:[]});
 try{await seed.start();await seed.request('thread/resume',params);
  await seed.request('thread/read',{threadId:id,includeTurns:true});
 }finally{seed.close();await seed.waitForExit();}
 Object.assign(records[0].payload,{history_mode:'paginated',session_id:id,context_window:{window_id:randomUUID()}});save();
 const stateFile=fs.readdirSync(sqliteHome).find(n=>/^state_\d+\.sqlite$/.test(n));
 assert(stateFile,'native state database exists');
 const db=new DatabaseSync(path.join(sqliteHome,stateFile));
 try{db.prepare(`INSERT INTO threads
  (id,rollout_path,created_at,updated_at,source,model_provider,cwd,title,sandbox_policy,approval_mode,history_mode)
  VALUES (?,?,?,?,?,?,?,?,?,?,'paginated') ON CONFLICT(id) DO UPDATE SET history_mode='paginated'`)
  .run(id,file,Math.floor(Date.now()/1000),Math.floor(Date.now()/1000),'vscode','openai',cwd,
   'Synthetic paginated thread',JSON.stringify({type:'read-only'}),'never');}finally{db.close();}
 // Seed the persisted paginated projection too. The regression is routing the
 // native database, not reconstructing newer history from legacy event fixtures.
 const bootstrap=new CodexAppServerClient({cwd,env,args:[]});
 try{await bootstrap.start();await bootstrap.request('thread/resume',params);
  await bootstrap.request('thread/read',{threadId:id,includeTurns:true});
 }finally{bootstrap.close();await bootstrap.waitForExit();}
 const historyFile=fs.readdirSync(sqliteHome).find(n=>/^thread_history_\d+\.sqlite$/.test(n));
 const history=new DatabaseSync(path.join(sqliteHome,historyFile));
 try{
  for(const table of ['thread_turns','thread_items','thread_history_projection_state'])history.prepare('DELETE FROM '+table+' WHERE thread_id=?').run(id);
  history.prepare(`INSERT INTO thread_turns (thread_id,turn_id,rollout_ordinal,status,started_at,completed_at,first_user_item_id,final_agent_item_id)
   VALUES (?,?,1,'completed',?,?,?,?)`).run(id,turn,Date.now(),Date.now(),'saved-user','saved-answer');
  const items=[{id:'saved-user',type:'userMessage',content:[{type:'text',text:'Remember this saved question',text_elements:[]}]},
   {id:'saved-answer',type:'agentMessage',text:'Saved paginated answer',phase:'final_answer'}];
  items.forEach((item,i)=>history.prepare(`INSERT INTO thread_items
   (thread_id,turn_id,item_id,rollout_ordinal,created_at_ms,item_json,item_type) VALUES (?,?,?,?,?,?,?)`)
   .run(id,turn,item.id,3+i,Date.now(),JSON.stringify(item),item.type));
  history.prepare('INSERT INTO thread_history_projection_state VALUES (?,?,?)').run(id,fs.statSync(file).size,records.length);
 }finally{history.close();}
 // The pre-fix behavior: credentials move to B, only JSONL path follows.
 const broken=new CodexAppServerClient({cwd,env:{...env,CODEX_HOME:b},args:[]});
 try{await broken.start();await assert.rejects(broken.request('thread/resume',params),/no rollout found for thread id/);}
 finally{broken.close();await broken.waitForExit();}
 result.checks.push((custom?'custom':'default')+' SQLite: old cross-home launch reproduces no rollout found');
 let selected=b,driver;
 const make=(restoredRuntime)=>new CodexNativeSession({id:'paginated-'+id,cwd,env:{...env,CODEX_HOME:selected},
  ownershipHome:a,historyStorageHome:a,accountId:selected===a?'a':'b',resumeId:id,resumePath:file,restoredRuntime,
  resolveAccount:()=>({id:selected===a?'a':'b',label:'Selected',home:selected}),
  threadParams:{cwd,model:'gpt-6-astra',approvalPolicy:'never',sandbox:'read-only'},turnParams:{model:'gpt-6-astra'}});
 try{
  driver=make();await driver.start();
  for(const target of [a,b]){
   const old=driver.entry.client;selected=target;await driver.reconnect();
   assert(old.proc.exitCode!==null || old.proc.signalCode!==null);
   assert.equal(driver.threadId,id);assert.equal(driver.options.env.CODEX_HOME,target);
   assert.equal(driver.runtime.sqliteHome,sqliteHome);
   const read=await driver.entry.client.request('thread/read',{threadId:id,includeTurns:true});
   assert(JSON.stringify(read).includes('Saved paginated answer'),JSON.stringify(read));assert.equal(read.thread.turns.length,1);
  }
  const snapshot=persistNativeRuntime({kind:'codex',nativeRuntime:driver.runtime});await close(driver);
  driver=make(snapshot);await driver.start();assert.equal(driver.threadId,id);assert.equal(driver.runtime.sqliteHome,sqliteHome);
  assert(JSON.stringify(await driver.entry.client.request('thread/read',{threadId:id,includeTurns:true})).includes('Saved paginated answer'));
  result.checks.push((custom?'custom':'default')+' SQLite: B/A/B and cold restart preserve ID, saved turn, database and single writer');
 }finally{await close(driver);}
}
(async()=>{
 try{await scenario(false);await scenario(true);result.passed=true;}
 catch(error){result.passed=false;result.error=error.stack;process.exitCode=1;}
 const out=path.resolve('artifacts/codex-global-account/20260924-paginated-account-codex1.json');
 fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
})();
