'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os');
const cfg=require('../core/antigravity-config');
const {AntigravityTap}=require('../core/antigravity-tap');
const {parseGeminiTranscriptToTurns:parse}=require('../core/gemini-transcript-parser');
const SID='a1111111-2222-4333-8444-555555555555';
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-agy-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const file=path.join(root,'.gemini','antigravity-cli','brain',SID,'.system_generated','logs','transcript.jsonl');fs.mkdirSync(path.dirname(file),{recursive:true});return {root,file};}
test('launch preserves precise identity and rejects legacy Gemini resume',()=>{
 assert.deepEqual(cfg.launchArgs({model:'gemini-3.1-pro-high',useResume:true,geminiChatId:SID,geminiProjectHash:'antigravity'}),['--dangerously-skip-permissions','--model','gemini-3.1-pro-high','--conversation',SID]);
 assert.throws(()=>cfg.launchArgs({useResume:true,geminiChatId:SID}),/旧 Gemini/);
  assert.throws(()=>cfg.launchArgs({model:"x'; Remove-Item"}),/模型/);
  assert.throws(()=>cfg.launchArgs({useResume:true}),/缺少会话 ID/);
});
test('native records survive rewrites, preserve Unicode and reject a foreign UUID',t=>{
 const {file}=fixture(t);const user={step_index:0,type:'USER_INPUT',source:'USER_EXPLICIT',content:'<USER_REQUEST>中文🙂</USER_REQUEST><metadata>hidden</metadata>'};
 const answer={step_index:1,source:'MODEL',type:'PLANNER_RESPONSE',status:'DONE',content:'first'};
 fs.writeFileSync(file,[user,answer].map(JSON.stringify).join('\n'));
 assert.equal(parse(file,{expectedSessionId:SID})[0].text,'中文🙂');
 assert.equal(parse(file)[1].nativeOutcome,null);
 fs.writeFileSync(file,JSON.stringify({...answer,content:'重写'}));
 assert.equal(parse(file)[0].text,'重写');
 assert.throws(()=>parse(file,{expectedSessionId:'other'}),/不属于/);
});
test('only fully idle normal Stop completes; errors and foreign hooks cannot complete',t=>{
 const {root,file}=fixture(t);fs.writeFileSync(file,[{step_index:0,source:'USER_EXPLICIT',type:'USER_INPUT',content:'ping'},
 {step_index:1,source:'MODEL',type:'PLANNER_RESPONSE',content:'pong'}].map(JSON.stringify).join('\n'));
 const tap=new AntigravityTap();t.after(()=>tap.unregisterSession('hub1'));
 tap.registerSession('hub1',{antigravityEventsFile:path.join(root,'events.jsonl'),cwd:root});
 const s=tap._bound.get('hub1'),events=[];for(const name of ['session-bound','turn-started','turn-complete','turn-error','turn-aborted'])tap.on(name,e=>events.push({name,...e}));
 const e={hubSessionId:'hub1',conversationId:SID,transcriptPath:file,observedAt:1,executionNum:0};
 tap._event(s,{...e,event:'PreInvocation'});
 tap._event(s,{...e,event:'Stop',fullyIdle:false,terminationReason:'model_stop'});
 assert.equal(events.filter(e=>e.name==='turn-complete').length,0);
 tap._event(s,{...e,event:'Stop',fullyIdle:true,terminationReason:'model_stop'});
  assert.equal(events.find(e=>e.name==='turn-complete').text,'pong');assert.equal(tap.getLastTokens('hub1'),null);
  assert.equal(s.turns.at(-1).nativeOutcome,'completed');
  fs.writeFileSync(file,JSON.stringify({step_index:1,source:'MODEL',type:'PLANNER_RESPONSE',content:'different answer'}));
  tap._read(s);assert.equal(s.turns.at(-1).nativeOutcome,null,'rewritten text cannot inherit a previous completion receipt');
 tap._event(s,{...e,event:'Stop',observedAt:2,fullyIdle:true,terminationReason:'error',error:'rate limit'});
 assert.equal(events.filter(e=>e.name==='turn-complete').length,1);assert.equal(events.at(-1).name,'turn-error');
 tap._event(s,{...e,event:'Stop',observedAt:3,fullyIdle:true,terminationReason:'NO_TOOL_CALL'});
 assert.equal(events.filter(e=>e.name==='turn-complete').length,2,'real agy 1.3.3 normal Stop is NO_TOOL_CALL');
 assert.throws(()=>tap._event(s,{...e,conversationId:'b1111111-2222-4333-8444-555555555555'}),/转录路径身份无效/,'a conversation id must own its transcript path');
 assert.throws(()=>tap._event(s,{...e,hubSessionId:'other-hub'}),/身份无效/);
});
test('Stop that arrives before the final text is flushed completes later instead of failing',t=>{
 const {root,file}=fixture(t);fs.writeFileSync(file,JSON.stringify({step_index:0,source:'USER_EXPLICIT',type:'USER_INPUT',content:'ping'})+'\n');
 const tap=new AntigravityTap();t.after(()=>tap.unregisterSession('late'));
 tap.registerSession('late',{antigravityEventsFile:path.join(root,'late.jsonl'),cwd:root});
 const s=tap._bound.get('late'),events=[];for(const name of ['turn-complete','turn-error'])tap.on(name,e=>events.push({name,...e}));
 const e={hubSessionId:'late',conversationId:SID,transcriptPath:file,observedAt:1,executionNum:0};
 tap._event(s,{...e,event:'PreInvocation'});
 tap._event(s,{...e,event:'Stop',fullyIdle:true,terminationReason:'NO_TOOL_CALL'});
 assert.equal(events.length,0,'no false failure while agy is still writing');
 fs.appendFileSync(file,JSON.stringify({step_index:1,source:'MODEL',type:'PLANNER_RESPONSE',content:'迟到的正文'})+'\n');
 tap._poll(s);
 assert.deepEqual(events.map(e=>[e.name,e.text]),[['turn-complete','迟到的正文']]);
});
test('switching conversations inside agy rebinds the Hub session instead of rejecting it',t=>{
 const {root,file}=fixture(t),other='b1111111-2222-4333-8444-555555555555',otherFile=file.replace(SID,other);
 fs.writeFileSync(file,[{step_index:0,source:'USER_EXPLICIT',type:'USER_INPUT',content:'old'},{step_index:1,source:'MODEL',type:'PLANNER_RESPONSE',content:'old answer'}].map(JSON.stringify).join('\n'));
 fs.mkdirSync(path.dirname(otherFile),{recursive:true});
 fs.writeFileSync(otherFile,[{step_index:0,source:'USER_EXPLICIT',type:'USER_INPUT',content:'new'},{step_index:1,source:'MODEL',type:'PLANNER_RESPONSE',content:'new answer'}].map(JSON.stringify).join('\n'));
 const events=path.join(root,'switch.jsonl'),tap=new AntigravityTap(),seen=[];t.after(()=>tap.unregisterSession('sw'));
 for(const name of ['session-bound','turn-started','turn-complete','turn-error'])tap.on(name,e=>seen.push({name,...e}));
 const base={hubSessionId:'sw',observedAt:1,executionNum:0};
 fs.writeFileSync(events,[{...base,event:'PreInvocation',conversationId:SID,transcriptPath:file},{...base,event:'Stop',conversationId:SID,transcriptPath:file,fullyIdle:true,terminationReason:'NO_TOOL_CALL'},
  {...base,observedAt:2,event:'PreInvocation',conversationId:other,transcriptPath:otherFile},{...base,observedAt:2,event:'Stop',conversationId:other,transcriptPath:otherFile,fullyIdle:true,terminationReason:'NO_TOOL_CALL'}].map(JSON.stringify).join('\n')+'\n');
 tap.registerSession('sw',{antigravityEventsFile:events,cwd:root});
 assert.deepEqual(seen.filter(e=>e.name==='session-bound').map(e=>e.geminiChatId),[SID,other]);
 assert.deepEqual(seen.filter(e=>e.name==='turn-complete').map(e=>e.text),['old answer','new answer']);
 assert.equal(seen.filter(e=>e.name==='turn-started').length,2);assert.equal(seen.filter(e=>e.name==='turn-error').length,0);
 tap._poll(tap._bound.get('sw'));
 assert.equal(seen.filter(e=>e.name==='turn-started').length,2,'polling again never replays processed lines');
});
test('streaming a new turn never repeats the preceding assistant answer',t=>{
 const tap=new AntigravityTap();
 tap._bound.set('stream',{active:true,turns:[{role:'user',text:'old question'},
   {role:'assistant',text:'old answer'},{role:'user',text:'new question'}]});
 t.after(()=>tap.unregisterSession('stream'));
 assert.equal(tap.getStreamingText('stream'),null);
 tap._bound.get('stream').turns.push({role:'assistant',text:'new answer'});
 assert.deepEqual(tap.getStreamingText('stream'),[{type:'text',text:'new answer'}]);
});

test('model list accepts only official slug rows and preserves account-dependent choices',()=>{
 const {parseModels}=require('../core/antigravity-model-catalog');
 assert.deepEqual(parseModels('Fetching available models...\ngemini-3.8-flash-high  Gemini 3.8 Flash (High)\nclaude-sonnet-5-5  Claude Sonnet 5.5\nError: login failed').map(m=>m.id),['gemini-3.8-flash-high','claude-sonnet-5-5']);
 assert.deepEqual(parseModels('Fetching available models...'),[]);
 assert.equal(parseModels('gemini-3.1-pro-high\tGemini 3.1 Pro (High)')[0].id,'gemini-3.1-pro-high','agy 1.3.3 uses a single tab separator');
});
test('MCP migration adds missing definitions and preserves new settings and legacy originals',t=>{
 const {root}=fixture(t),legacy=path.join(root,'.gemini','settings.json'),target=path.join(root,'.gemini','config','mcp_config.json');
 fs.mkdirSync(path.dirname(target),{recursive:true});
 fs.writeFileSync(legacy,JSON.stringify({mcpServers:{existing:{command:'old'},remote:{httpUrl:'https://example.test/mcp'}}}));
 fs.writeFileSync(target,JSON.stringify({mcpServers:{existing:{command:'new'}}}));const original=fs.readFileSync(legacy,'utf8');
 cfg.migrateConfiguration({CLAUDE_HUB_HOME_DIR:root});const merged=JSON.parse(fs.readFileSync(target));
 assert.equal(merged.mcpServers.existing.command,'new');assert.equal(merged.mcpServers.remote.serverUrl,'https://example.test/mcp');assert.equal(fs.readFileSync(legacy,'utf8'),original);
 fs.writeFileSync(target,JSON.stringify({mcpServers:{}}));cfg.migrateConfiguration({CLAUDE_HUB_HOME_DIR:root});assert.deepEqual(JSON.parse(fs.readFileSync(target)).mcpServers,{},'do not re-add native MCP entries deliberately removed after migration');
});
test('official empty MCP placeholder can be initialized without discarding nonempty malformed files',t=>{
 const {root}=fixture(t),legacy=path.join(root,'.gemini','settings.json'),target=path.join(root,'.gemini','config','mcp_config.json');
 fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(legacy,JSON.stringify({mcpServers:{a:{command:'test'}}}));fs.writeFileSync(target,'');
 cfg.migrateConfiguration({CLAUDE_HUB_HOME_DIR:root});assert.equal(JSON.parse(fs.readFileSync(target)).mcpServers.a.command,'test');
});
test('hook setup preserves custom hooks, scopes receipts and refuses malformed config',t=>{
 const {root}=fixture(t);const env={CLAUDE_HUB_HOME_DIR:root};const file=path.join(root,'.gemini','config','hooks.json');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify({personal:{enabled:true}}));
 cfg.installHooks(env,path.join(root,'data'),'hub1');const hooks=JSON.parse(fs.readFileSync(file));assert.ok(hooks.personal);assert.ok(hooks['ai-hub-lifecycle'].Stop);
 assert.equal(env.AI_HUB_ANTIGRAVITY_SESSION_ID,'hub1');
 if(process.platform==='win32')assert.match(hooks['ai-hub-lifecycle'].Stop[0].command,/^powershell.exe .* -EncodedCommand [A-Za-z0-9+/=]+$/);
 fs.writeFileSync(file,'broken');assert.throws(()=>cfg.installHooks(env,root,'hub1'));assert.equal(fs.readFileSync(file,'utf8'),'broken');
});
test('old Gemini token cannot authenticate Antigravity and official auth failure is propagated',async t=>{
 const {root}=fixture(t);fs.writeFileSync(path.join(root,'oauth_creds.json'),JSON.stringify({refresh_token:'fixture'}));
 const {createAccountAdapters}=require('../core/account-adapters');
 require('../core/antigravity-model-catalog').resetModelCatalogCache();
 let call,calls=0;const adapters=createAccountAdapters({dataDir:root,homeDir:root,env:{},browser:{},getConfig:()=>({proxy:'http://127.0.0.1:7890'}),runImpl:async(cmd,args,env)=>{calls++;call={cmd,args,env};return {code:1,stdout:'',stderr:'Please sign in to view available models.'};}});
 assert.equal((await adapters.check({provider:'gemini',home:root})).state,'login_required');assert.deepEqual(call.args,['models']);
 assert.equal(call.env.HTTPS_PROXY,'http://127.0.0.1:7890','the launch check refreshes OAuth through the proxy');
 assert.equal((await adapters.check({provider:'gemini',home:root})).state,'login_required');
 assert.equal(calls,1,'back-to-back launches share one agy models run');
 require('../core/antigravity-model-catalog').resetModelCatalogCache();
 adapters.dispose();
});

test('background agy calls use the configured proxy, not the shortcut-launched Hub env',()=>{
 const env=cfg.cliEnv({PATH:'x',all_proxy:'socks5://other',https_proxy:'http://stale'},'http://127.0.0.1:7890');
 assert.equal(env.HTTPS_PROXY,'http://127.0.0.1:7890');assert.equal(env.https_proxy,'http://127.0.0.1:7890');
 assert.equal(env.all_proxy,undefined,'a second inherited proxy cannot win');assert.equal(env.PATH,'x');
 assert.equal(cfg.cliEnv({HTTPS_PROXY:'keep'},'').HTTPS_PROXY,'keep','empty config keeps the user env');
});
test('new workspaces are pre-trusted once so the TUI never waits on the trust prompt',t=>{
 const {root}=fixture(t),env={CLAUDE_HUB_HOME_DIR:root},file=path.join(cfg.configRoot(env),'settings.json');
 fs.writeFileSync(file,'\uFEFF'+JSON.stringify({trustedWorkspaces:['C:\old'],keep:1}));
 assert.equal(cfg.ensureWorkspaceTrusted(path.join(root,'工作 1'),env),true);
 const saved=JSON.parse(fs.readFileSync(file,'utf8'));
 assert.deepEqual(saved.trustedWorkspaces,['C:\old',path.join(root,'工作 1')]);assert.equal(saved.keep,1);
 assert.equal(cfg.ensureWorkspaceTrusted(path.join(root,'工作 1'),env),false,'no duplicate entry');
 if(process.platform==='win32')assert.equal(cfg.ensureWorkspaceTrusted(path.join(root,'工作 1').toUpperCase(),env),false);
});
test('model catalog is shared between dialog open and submit, and failures retry soon',async()=>{
 const cat=require('../core/antigravity-model-catalog');cat.resetModelCatalogCache();
 let calls=0,clock=0,code=0;const runImpl=async(cmd,args,env)=>{calls++;assert.equal(env.HTTPS_PROXY!==undefined,true);return {code,stdout:code?'Please sign in':'gemini-3.1-pro-high\tGemini 3.1 Pro (High)',stderr:''};};
 const opts={env:{AI_HUB_ANTIGRAVITY_COMMAND:'agy.exe'},runImpl,now:()=>clock};
 const [a,b]=await Promise.all([cat.readModelCatalog(opts),cat.readModelCatalog(opts)]);
 assert.equal(calls,1,'concurrent callers share one agy process');assert.equal(a,b);assert.equal(a.ok,true);
 clock=9*60*1000;await cat.readModelCatalog(opts);assert.equal(calls,1);
 clock=11*60*1000;code=1;const failed=await cat.readModelCatalog(opts);assert.equal(calls,2);assert.match(failed.error,/登录/);
 clock+=30*1000;await cat.readModelCatalog(opts);assert.equal(calls,2);
 clock+=31*1000;await cat.readModelCatalog(opts);assert.equal(calls,3);
 cat.resetModelCatalogCache();
});
test('branch clones the native conversation under a new id and never touches the source',t=>{
 const {root}=fixture(t),env={CLAUDE_HUB_HOME_DIR:root},base=cfg.configRoot(env),TRAJ='c2222222-3333-4444-8555-666666666666';
 const {DatabaseSync}=require('node:sqlite');fs.mkdirSync(path.join(base,'conversations'),{recursive:true});
 const src=path.join(base,'conversations',SID+'.db'),db=new DatabaseSync(src);
 db.exec('CREATE TABLE trajectory_meta (trajectory_id text PRIMARY KEY, cascade_id text); CREATE TABLE steps (idx integer PRIMARY KEY, step_payload blob)');
 db.prepare('INSERT INTO trajectory_meta VALUES (?,?)').run(TRAJ,SID);
 db.prepare('INSERT INTO steps VALUES (0,?)').run(Buffer.concat([Buffer.from([8,1,18,36]),Buffer.from(SID),Buffer.from('中文 payload '+TRAJ)]));db.close();
 const logs=path.join(base,'brain',SID,'.system_generated','logs');fs.mkdirSync(logs,{recursive:true});
 fs.writeFileSync(path.join(logs,'transcript.jsonl'),JSON.stringify({step_index:0,type:'USER_INPUT',content:'在 '+SID+' 里'})+'\n');
 fs.mkdirSync(path.join(base,'annotations'));fs.writeFileSync(path.join(base,'annotations',SID+'.pbtxt'),'title:"分支源"');
 const before=fs.readFileSync(src);
 const {forkConversation}=require('../core/antigravity-fork'),NEW='d3333333-4444-4555-8666-777777777777';
 const out=forkConversation(SID,{env,newId:NEW});
 assert.equal(out.conversationId,NEW);assert.ok(out.transcriptPath.includes(path.join('brain',NEW)));
 assert.deepEqual(fs.readFileSync(src),before,'source database unchanged');
 const copy=new DatabaseSync(path.join(base,'conversations',NEW+'.db'),{readOnly:true});
 const meta=copy.prepare('SELECT * FROM trajectory_meta').get(),payload=Buffer.from(copy.prepare('SELECT step_payload FROM steps').get().step_payload);copy.close();
 assert.equal(meta.cascade_id,NEW);assert.notEqual(meta.trajectory_id,TRAJ);assert.match(meta.trajectory_id,cfg.UUID);
 assert.equal(payload.length,4+36+Buffer.byteLength('中文 payload ')+36,'protobuf lengths stay valid');
 assert.ok(payload.includes(NEW)&&!payload.includes(SID)&&payload.includes(meta.trajectory_id));
 assert.match(fs.readFileSync(out.transcriptPath,'utf8'),new RegExp(NEW));
 assert.equal(fs.readFileSync(path.join(base,'annotations',NEW+'.pbtxt'),'utf8'),'title:"分支源"');
 assert.throws(()=>forkConversation(SID,{env,newId:NEW}),/已存在/);
 assert.throws(()=>forkConversation('e4444444-5555-4666-8777-888888888888',{env}),/找不到/);
});
test('continue-latest picks the newest conversation that has a user message',t=>{
 const {root,file}=fixture(t),env={CLAUDE_HUB_HOME_DIR:root};
 fs.writeFileSync(file,JSON.stringify({step_index:0,type:'USER_INPUT',content:'hi'})+'\n');
 const empty=file.replace(SID,'f5555555-6666-4777-8888-999999999999');fs.mkdirSync(path.dirname(empty),{recursive:true});fs.writeFileSync(empty,'');
 const later=new Date(Date.now()+5000);fs.utimesSync(empty,later,later);
 assert.equal(cfg.latestConversation(env).conversationId,SID,'an empty newer shell is skipped');
 assert.equal(cfg.latestConversation({CLAUDE_HUB_HOME_DIR:path.join(root,'none')}),null);
});
test('Antigravity sessions can branch; legacy Gemini history cannot',()=>{
 const {planSessionFork}=require('../core/session-fork-plan');const {supportsForkSession}=require('../core/session-capabilities');
 const source={id:'hub-a',kind:'gemini',cwd:'C:\w',geminiChatId:SID,geminiProjectHash:'antigravity',currentModel:{id:'gemini-3.8-flash-high'}};
 const plan=planSessionFork({source});
 assert.equal(plan.ok,true);assert.equal(plan.kind,'gemini');assert.equal(plan.opts.antigravityForkFrom,SID);assert.equal(plan.opts.model,'gemini-3.8-flash-high');
 assert.equal(supportsForkSession({...source,geminiProjectHash:'lintian'}),false);
});
