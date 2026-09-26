'use strict';
// Real isolated Hub + IPC + native protocol subprocesses. Native CLI rule
// contents are separately verified with the loopback probes; no cloud inference.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const port=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const write=(p,t)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,t);};
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-person-context-')),home=path.join(root,'home'),data=path.join(root,'data'),work=path.join(root,'work'),cwd=path.join(work,'task');
 const a=path.join(home,'a'),b=path.join(home,'b'),claude=path.join(home,'.claude'),trace=path.join(root,'trace.jsonl');
 const out=path.resolve('artifacts/20260925-context-consistency/gui-'+Date.now());
 for(const p of [a,b,claude,data,cwd,out])fs.mkdirSync(p,{recursive:true});
 const user='# Personal rules\nOne user across accounts.\n',rules='# Workspace rules\nUse unique output names.\n';
 write(path.join(home,'.agents/USER_CONTEXT.md'),user);write(path.join(work,'.vibe-root'),'');
 write(path.join(home,'.agents/context-policy.json'),JSON.stringify({version:1,codexDefaults:{features:{memories:true},memories:{use_memories:false},project_root_markers:['.git','.vibe-root']}}));
 for(const n of ['AGENTS.md','CLAUDE.md','GEMINI.md'])write(path.join(work,n),rules);
 const config={providers:{codex:{backend:'subscription',subscription_profile:'default',subscription_profiles:[{id:'default',home:a},{id:'second',home:b}]}}};
 write(path.join(data,'config.json'),JSON.stringify(config));
 const result={passed:false,checks:[],out};let hub,cdp;
 const until=async(expr,label)=>{const end=Date.now()+25000;while(Date.now()<end){if(await cdp.eval(expr))return;await new Promise(r=>setTimeout(r,100));}throw Error('Timeout '+label);};
 const invoke=(channel,value)=>cdp.eval(`ipcRenderer.invoke(${JSON.stringify(channel)},${JSON.stringify(value)})`);
 const receipts=()=>{const dir=path.join(data,'memory/context');return fs.existsSync(dir)?fs.readdirSync(dir).filter(n=>n.endsWith('.json')).flatMap(n=>JSON.parse(fs.readFileSync(path.join(dir,n),'utf8'))):[];};
 try{
  hub=await launchIsolatedHub({dataDir:data,port:await port(),label:'personal-context',windowMode:'hidden',extraEnv:{
   CODEX_HOME:a,CLAUDE_HUB_HOME_DIR:home,CLAUDE_CONFIG_DIR:claude,HUB_CODEX_PROFILE:'',HUB_CODEX_BACKEND:'subscription',AI_HUB_WORKSPACE_ROOT:work,DEEPSEEK_API_KEY:'',
   CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.join(__dirname,'fixtures/codex-app-server.js'),CLAUDE_HUB_NATIVE_FIXTURE_CONTEXT:'1',
   CLAUDE_HUB_NATIVE_FIXTURE_STORE_DIR:path.join(root,'threads'),CLAUDE_HUB_NATIVE_FIXTURE_WRITER_DIR:path.join(root,'writers'),CLAUDE_HUB_NATIVE_FIXTURE_TRACE:trace,
   CLAUDE_HUB_CLAUDE_STREAM_FIXTURE:path.join(__dirname,'fixtures/claude-stream.js')}});
  cdp=await connectFirstPage(hub);await until('typeof sessions!=="undefined"','renderer');
  const ids=[];
  for(const [kind,account] of [['codex','default'],['codex','second'],['claude','second']]){
   config.providers.codex.subscription_profile=account;write(path.join(data,'config.json'),JSON.stringify(config));
   const s=await invoke('create-session',{kind,opts:{cwd,model:kind==='codex'?'gpt-6-astra':'claude-opus-4-6',mcpProfile:'none'}});
   assert(s.id,JSON.stringify(s));ids.push(s.id);await until(`sessions.get(${JSON.stringify(s.id)})?.nativeRuntime?.connection==='connected'`,'connected '+kind);
   const text='Context consistency '+kind+' '+account;
   const sent=await invoke('session:send-prompt',{sessionId:s.id,text,clientSubmissionId:s.id+'-one'});assert(sent.ok,JSON.stringify(sent));
   await until(`sessions.get(${JSON.stringify(s.id)})?.nativeRuntime?.state==='completed'`,'completed '+kind);
   assert.equal(receipts().filter(r=>r.kind==='workspace').length,0,'Native-covered workspace must not be appended');
   const file=path.join(kind==='claude'?claude:account==='default'?a:b,kind==='claude'?'CLAUDE.md':'AGENTS.md');assert.equal(fs.readFileSync(file,'utf8'),user);
   result.checks.push(kind+'/'+account+': native user source synchronized; no redundant workspace appendix');
  }
  const turns=fs.readFileSync(trace,'utf8').trim().split('\n').map(JSON.parse).filter(r=>r.method==='turn/start');
  assert(turns.length>=2);assert(turns.every(r=>!JSON.stringify(r.params.input).includes('ai-hub-workspace-rules')));
  result.checks.push('Actual Codex turn/start payloads contain no duplicate workspace appendix');
  write(path.join(work,'AGENTS.md'),rules+'New unique constraint.\n');
  const sent=await invoke('session:send-prompt',{sessionId:ids[1],text:'After rule update',clientSubmissionId:ids[1]+'-changed'});assert(sent.ok);
  await until(`sessions.get(${JSON.stringify(ids[1])})?.nativeRuntime?.state==='completed'`,'updated rule');
  assert(receipts().some(r=>r.kind==='workspace'&&r.content.includes('New unique constraint.')));
  result.checks.push('Changed rule retained through real Hub submission and receipt');
  result.passed=true;
 }catch(error){result.error=error.stack;throw error;}
 finally{if(cdp)await cdp.close();if(hub){result.log=hub.log();await gracefulQuit(hub);}fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({out,passed:result.passed,checks:result.checks,error:result.error}));}
})().catch(e=>{console.error(e);process.exitCode=1;});
