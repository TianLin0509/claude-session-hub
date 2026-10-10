'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os');
const cfg=require('../core/antigravity-config');
const {AntigravityTap}=require('../core/antigravity-tap');
const {parseGeminiTranscriptToTurns:parse}=require('../core/gemini-transcript-parser');
const SID='a1111111-2222-4333-8444-555555555555';
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-agy-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const file=path.join(root,'.gemini','antigravity-cli','brain',SID,'.system_generated','logs','transcript.jsonl');fs.mkdirSync(path.dirname(file),{recursive:true});return {root,file};}
test('launch preserves precise identity and rejects legacy Gemini resume',()=>{
 assert.deepEqual(cfg.launchArgs({model:'gemini-3.1-pro-high',useResume:true,geminiChatId:SID,geminiProjectHash:'antigravity'}),['--model','gemini-3.1-pro-high','--conversation',SID]);
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
 assert.throws(()=>tap._event(s,{...e,conversationId:'b1111111-2222-4333-8444-555555555555'}),/其他会话/);
});
test('model list accepts only official slug rows and preserves account-dependent choices',()=>{
 const {parseModels}=require('../core/antigravity-model-catalog');
 assert.deepEqual(parseModels('Fetching available models...\ngemini-3.8-flash-high  Gemini 3.8 Flash (High)\nclaude-sonnet-5-5  Claude Sonnet 5.5\nError: login failed').map(m=>m.id),['gemini-3.8-flash-high','claude-sonnet-5-5']);
 assert.deepEqual(parseModels('Fetching available models...'),[]);
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
 fs.writeFileSync(file,'broken');assert.throws(()=>cfg.installHooks(env,root,'hub1'));assert.equal(fs.readFileSync(file,'utf8'),'broken');
});
test('old Gemini token cannot authenticate Antigravity and official auth failure is propagated',async t=>{
 const {root}=fixture(t);fs.writeFileSync(path.join(root,'oauth_creds.json'),JSON.stringify({refresh_token:'fixture'}));
 const {createAccountAdapters}=require('../core/account-adapters');
 let call;const adapters=createAccountAdapters({dataDir:root,homeDir:root,env:{},browser:{},runImpl:async(cmd,args)=>{call={cmd,args};return {code:1,stdout:'',stderr:'Please sign in to view available models.'};}});
 assert.equal((await adapters.check({provider:'gemini',home:root})).state,'login_required');assert.deepEqual(call.args,['models']);
 adapters.dispose();
});
