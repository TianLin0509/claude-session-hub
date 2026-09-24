'use strict';
// Real native protocol, synthetic history, no credentials or model requests.
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const {randomUUID}=require('crypto');
const {CodexAppServerClient}=require('../main/codex-app-server-client');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-cross-home-'));
const homes=['a','b'].map(n=>path.join(root,n));
for(const h of homes)fs.mkdirSync(h);
const id=randomUUID(),turn=randomUUID(),timestamp=new Date().toISOString();
const file=path.join(homes[0],'rollout-'+id+'.jsonl');
const records=[
 {type:'session_meta',payload:{id,timestamp,cwd:root,originator:'codex_cli_rs',cli_version:'0.153.4',source:'cli',model_provider:'openai'}},
 {type:'event_msg',payload:{type:'task_started',turn_id:turn,model_context_window:258400,collaboration_mode_kind:'default'}},
 {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'Synthetic old question'}]}},
 {type:'response_item',payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'Synthetic saved answer'}]}},
 {type:'event_msg',payload:{type:'user_message',message:'Synthetic old question',images:[],local_images:[],text_elements:[]}},
 {type:'event_msg',payload:{type:'agent_message',message:'Synthetic saved answer',phase:'final_answer'}},
 {type:'event_msg',payload:{type:'task_complete',turn_id:turn,last_agent_message:'Synthetic saved answer'}},
];
fs.writeFileSync(file,records.map(r=>JSON.stringify({timestamp,...r})).join('\n')+'\n');
(async()=>{
 const result={root,checks:[],modelTurnsSent:0};
 try {
  for(const home of homes){
   const env={...process.env,CODEX_HOME:home,OPENAI_API_KEY:'',CODEX_API_KEY:'',CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:''};
   const c=new CodexAppServerClient({cwd:root,env,args:[]});
   try{
    await c.start();
    const r=await c.request('thread/resume',{threadId:id,path:file,model:'gpt-6-astra',approvalPolicy:'never',sandbox:'read-only'});
    assert.equal(r.thread.id,id);assert.equal(path.toNamespacedPath(r.thread.path),path.toNamespacedPath(file));
    assert(JSON.stringify(await c.request('thread/read',{threadId:id,includeTurns:true})).includes('Synthetic saved answer'));
    result.checks.push('same native ID, history and path retained in home '+path.basename(home));
   }finally{c.close();await c.waitForExit();}
  }
  let selected=0;
  const {CodexNativeSession}=require('../core/codex-native-session');
  const driver=new CodexNativeSession({id:'cross-home-real',cwd:root,
   env:{...process.env,CODEX_HOME:homes[0],CLAUDE_HUB_DATA_DIR:path.join(root,'hub'),OPENAI_API_KEY:'',CODEX_API_KEY:'',CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:''},
   resumeId:id,resumePath:file,ownershipHome:homes[0],accountId:'a',resolveAccount:()=>({id:selected?'b':'a',label:selected?'B':'A',home:homes[selected]}),
   threadParams:{cwd:root,model:'gpt-6-astra',approvalPolicy:'never',sandbox:'read-only'},turnParams:{model:'gpt-6-astra'}});
  try{
   await driver.start();const old=driver.entry.client,lease=driver.ownershipLease.file;
   selected=1;await driver.reconnect();
   assert.equal(driver.threadId,id);assert.equal(driver.options.env.CODEX_HOME,homes[1]);
   assert.equal(driver.ownershipLease.file,lease);assert(old.proc.exitCode!==null || old.proc.signalCode!==null);
   assert(JSON.stringify(await driver.entry.client.request('thread/read',{threadId:id,includeTurns:true})).includes('Synthetic saved answer'));
   result.checks.push('real Hub driver reconnect migrates home, waits for writer exit, keeps original lease and history');
  }finally{await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('driver close timeout')),15000);driver.once('exit',()=>{clearTimeout(t);resolve();});driver.kill();});}
  result.passed=true;
 }catch(e){result.passed=false;result.error=e.stack;process.exitCode=1;}
 fs.mkdirSync(path.resolve('artifacts/codex-global-account'),{recursive:true});
 fs.writeFileSync(path.resolve('artifacts/codex-global-account/real-cross-home.json'),JSON.stringify(result,null,2));
 console.log(JSON.stringify(result));
})();
