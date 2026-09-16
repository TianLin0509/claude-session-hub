'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const {CodexNativeSession}=require('../core/codex-native-session');
const {CodexAppServerClient}=require('../main/codex-app-server-client');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-real-writer-release-'));
const home=path.join(root,'codex'),cwd=path.join(root,'workspace'),data=path.join(root,'hub');
for(const p of [home,cwd,data])fs.mkdirSync(p);
const env={...process.env,CODEX_HOME:home,CLAUDE_CONFIG_DIR:path.join(root,'claude'),CLAUDE_HUB_DATA_DIR:data,CLAUDE_HUB_HOME_DIR:root,OPENAI_API_KEY:'',DEEPSEEK_API_KEY:'',CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:''};
for(const k of ['CLAUDE_HUB_PORT','CLAUDE_HUB_TOKEN','CLAUDE_HUB_SESSION_ID','CODEX_THREAD_ID','CODEX_SESSION_ID'])delete env[k];
fs.writeFileSync(path.join(home,'config.toml'),'model = "gpt-6-astra"\n');
// Synthetic persisted history, not a user's session. An unused native start
// deliberately has no rollout, so it cannot exercise same-identity resumption.
const seedId=require('crypto').randomUUID(),turnId=require('crypto').randomUUID(),timestamp=new Date().toISOString();
const seedDir=path.join(home,'sessions',...timestamp.slice(0,10).split('-'));fs.mkdirSync(seedDir,{recursive:true});
const seed=[
 {type:'session_meta',payload:{id:seedId,timestamp,cwd,originator:'codex_cli_rs',cli_version:'0.153.4',source:'cli',model_provider:'openai'}},
 {type:'event_msg',payload:{type:'task_started',turn_id:turnId,model_context_window:258400,collaboration_mode_kind:'default'}},
 {type:'event_msg',payload:{type:'user_message',message:'Synthetic lifecycle history fixture',images:[],local_images:[],text_elements:[]}},
 {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'Synthetic lifecycle history fixture'}]}},
 {type:'response_item',payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'Synthetic saved answer'}]}},
 {type:'event_msg',payload:{type:'agent_message',message:'Synthetic saved answer',phase:'final_answer'}},
 {type:'event_msg',payload:{type:'task_complete',turn_id:turnId,last_agent_message:'Synthetic saved answer'}},
];
fs.writeFileSync(path.join(seedDir,'rollout-'+timestamp.slice(0,19).replaceAll(':','-')+'-'+seedId+'.jsonl'),seed.map(v=>JSON.stringify({timestamp,...v})).join('\n')+'\n');
const outDir=path.resolve('artifacts/writer-release');fs.mkdirSync(outDir,{recursive:true});
const sessions=[];
function make(id,resumeId){const s=new CodexNativeSession({id,cwd,env,resumeId,threadParams:{cwd,model:'gpt-6-astra',approvalPolicy:'never',sandbox:'read-only'},clientFactory:()=>new CodexAppServerClient({cwd,env,args:[],timeoutMs:20000})});sessions.push(s);return s;}
async function close(s){if(!s.entry)return;const client=s.entry.client;await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('native close did not finish')),20000);s.once('exit',()=>{clearTimeout(timer);resolve();});s.kill();});assert(client.proc.exitCode!==null || client.proc.signalCode!==null);}
(async()=>{
 const result={root,checks:[],modelTurnsSent:0};
 try {
  const a=make('real-a',seedId),b=make('real-b');await a.start();await b.start();
  result.pids=[a.pid,b.pid];assert.notEqual(a.pid,b.pid);result.checks.push('same-scope real sessions use different native PIDs');
  const threadId=a.threadId,client=a.entry.client;
  result.threadId=threadId;result.nativeVersion=client.initialized;
  const started=Date.now();await close(a);result.closeMs=Date.now()-started;
  assert.equal(b.runtime.connection,'connected');result.checks.push('real writer exits before sleep completion; peer stays connected');
  const c=make('real-c',threadId);await c.start();
  assert.equal(c.threadId,threadId);assert.equal(c.runtime.connection,'connected');result.checks.push('same real native thread resumes immediately in another dedicated process');
  assert(JSON.stringify(await c.entry.client.request('thread/read',{threadId,includeTurns:true})).includes('Synthetic saved answer'));result.checks.push('native saved answer survives same-thread resumption');
  result.passed=true;
 }catch(error){result.passed=false;result.error=error.stack;process.exitCode=1;}
 finally {for(const s of sessions.reverse())try{await close(s);}catch(error){result.passed=false;result.cleanupError=error.stack;process.exitCode=1;}fs.writeFileSync(path.join(outDir,'real-native-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));}
})();
