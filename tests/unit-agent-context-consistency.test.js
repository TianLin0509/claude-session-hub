'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {syncNativeUserContext}=require('../core/agent-user-context');
const {captureNativeRuleCoverage,stillCovered}=require('../core/native-rule-coverage');
const {sharedWorkspaceRules}=require('../core/memory-rule-files');
function fixture(t){const home=fs.mkdtempSync(path.join(os.tmpdir(),'hub-context-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));return home;}
function write(p,t){fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,t);}
test('all native account entries adopt one user source without touching credentials or project files',t=>{
 const home=fixture(t),source=path.join(home,'.agents/USER_CONTEXT.md'),dataDir=path.join(home,'.claude-session-hub');write(source,'# One person\nShared preferences.');
 const env={USERPROFILE:home};
 for(const kind of ['codex','claude','kimi','gemini','qwen','deepseek-acp','glm']){
  const nativeHome=path.join(home,kind);write(path.join(nativeHome,'auth.json'),'credential:'+kind);
  const a=syncNativeUserContext({kind,nativeHome,env,dataDir});assert.equal(fs.readFileSync(a.path,'utf8'),fs.readFileSync(source,'utf8'));
  assert.equal(fs.readFileSync(path.join(nativeHome,'auth.json'),'utf8'),'credential:'+kind);
  assert.equal(syncNativeUserContext({kind,nativeHome,env,dataDir}).digest,a.digest);
 }
 write(source,'# Updated source');const a=syncNativeUserContext({kind:'codex',nativeHome:path.join(home,'codex'),env,dataDir});assert.equal(fs.readFileSync(a.path,'utf8'),'# Updated source');
 write(a.path,'independent edit');assert.throws(()=>syncNativeUserContext({kind:'codex',nativeHome:path.join(home,'codex'),env,dataDir}),/独立修改/);assert.equal(fs.readFileSync(a.path,'utf8'),'independent edit');
});
test('isolated hubs do not copy the real user source without explicit isolated home',t=>{
 const home=fixture(t);write(path.join(home,'.agents/USER_CONTEXT.md'),'private');
 const nativeHome=path.join(home,'output'),dataDir=path.join(home,'test-hub');
 assert.equal(syncNativeUserContext({kind:'qwen',nativeHome,env:{USERPROFILE:home},dataDir}),null);assert(!fs.existsSync(nativeHome));
 assert(syncNativeUserContext({kind:'qwen',nativeHome,env:{USERPROFILE:home,CLAUDE_HUB_HOME_DIR:home},dataDir}));
 assert.throws(()=>syncNativeUserContext({kind:'kimi',nativeHome:path.join(home,'..','outside'),env:{CLAUDE_HUB_HOME_DIR:home},dataDir}),/隔离/);
});
test('shared hooks and Claude memory settings follow the person, without copying provider credentials',t=>{
 const home=fixture(t),dataDir=path.join(home,'.claude-session-hub'),env={USERPROFILE:home};
 const hooks={hooks:{Stop:[{hooks:[{type:'command',command:'node owned-guard.js'}]}]}};
 write(path.join(home,'.agents/USER_CONTEXT.md'),'same user');
 write(path.join(home,'.agents/context-policy.json'),JSON.stringify({version:1,codexHooks:hooks,claudeDefaults:{autoMemoryDirectory:path.join(home,'memory'),hooks:hooks.hooks,env:{TOKEN:'must-not-copy'}}}));
 // PTY 模式（默认）：期望内容 = 个人策略 + Hub 补齐的状态 hook；策略自己的条目原样保留。
 const {mergeHubCodexHooks,hubHookScriptPath}=require('../core/codex-hook-integration');
 for(const name of ['a','b']){const nativeHome=path.join(home,name);syncNativeUserContext({kind:'codex',nativeHome,env,dataDir});const written=JSON.parse(fs.readFileSync(path.join(nativeHome,'hooks.json'),'utf8'));
  assert.deepEqual(written,mergeHubCodexHooks(hooks,hubHookScriptPath(nativeHome)).hooksFile);assert.deepEqual(written.hooks.Stop[0],hooks.hooks.Stop[0]);}
 const shared=require('../core/agent-user-context').claudeSharedConfig(env,dataDir);assert.deepEqual(shared.hooks,hooks.hooks);assert(!shared.env);
 write(path.join(home,'b/hooks.json'),JSON.stringify({hooks:{}}));assert.throws(()=>syncNativeUserContext({kind:'codex',nativeHome:path.join(home,'b'),env,dataDir}),/独立修改/);
});
test('shared Codex defaults are identical across quota homes; endpoints and explicit session tuning stay independent',t=>{
 const home=fixture(t),dataDir=path.join(home,'.claude-session-hub');
 write(path.join(home,'.agents/context-policy.json'),JSON.stringify({version:1,codexDefaults:{
   model:'common-default',memories:{use_memories:false},features:{memories:true},
   mcp_servers:{shared:{command:'node',args:['shared.js']}},
   model_provider:'must-not-copy',sqlite_home:'must-not-copy',openai_base_url:'must-not-copy'}}));
 const {codexSharedConfig}=require('../core/agent-user-context');
 const env={USERPROFILE:home,CLAUDE_HUB_HOME_DIR:home};
 const a=codexSharedConfig({...env,CODEX_HOME:path.join(home,'a')},dataDir);
 const b=codexSharedConfig({...env,CODEX_HOME:path.join(home,'b')},dataDir);
 assert.deepEqual(a,b);assert.equal(a.memories.use_memories,false);
 for(const key of ['model_provider','sqlite_home','openai_base_url'])assert(!Object.hasOwn(a,key));
 const {buildNativeCodexOptions}=require('../core/session-manager')._private;
 const info={kind:'codex',cwd:home,currentModel:{id:'explicit-model'},effort:'max',mcpProfile:'none',codexSpeedTier:'standard'};
 const x=buildNativeCodexOptions(info,{approvalPolicy:'on-request',sandbox:'read-only'},{...env,CODEX_HOME:path.join(home,'a')});
 assert.equal(x.threadParams.model,'explicit-model');assert.equal(x.threadParams.approvalPolicy,'on-request');assert.equal(x.threadParams.sandbox,'read-only');
 assert(x.processArgs.includes('mcp_servers.shared.enabled=false'));
 assert(x.processArgs.includes('memories={"use_memories"=false}'));assert(x.processArgs.includes('features={"memories"=true}'));
 assert.equal(require('../core/agent-user-context').codexTomlValue({'gpt-5.5':4,'a@market':{enabled:true}}),'{"gpt-5.5"=4,"a@market"={"enabled"=true}}');
});
test('native chains prevent one extra Hub copy, while the no-Git DSH gap is still filled',t=>{
 const home=fixture(t),root=path.join(home,'workspace'),cwd=path.join(root,'task');fs.mkdirSync(cwd,{recursive:true});
 const body='# Workspace\nUse unique filenames.\n';
 for(const f of ['AGENTS.md','CLAUDE.md','GEMINI.md'])write(path.join(root,f),'<!-- label '+f+' -->\n'+body);
 write(path.join(root,'.vibe-root'),'');
 for(const kind of ['codex','deepseek','claude','qwen','gemini','glm']){
  const nativeCoverage=captureNativeRuleCoverage({kind,cwd,env:{USERPROFILE:home}});
  assert(stillCovered(body,nativeCoverage),kind);
  assert.deepEqual(sharedWorkspaceRules({session:{kind,cwd},workspaceService:{getWorkspaceRoot:()=>root},nativeCoverage}),[],kind);
 }
 for(const kind of ['deepseek-acp','kimi']){
  const nativeCoverage=captureNativeRuleCoverage({kind,cwd,env:{USERPROFILE:home}});
  assert.equal(sharedWorkspaceRules({session:{kind,cwd},workspaceService:{getWorkspaceRoot:()=>root},nativeCoverage}).length,1);
 }
});
test('changed or unique rules remain visible; native overrides never hide unrelated content',t=>{
 const home=fixture(t),cwd=path.join(home,'task');fs.mkdirSync(cwd);write(path.join(home,'.vibe-root'),'');write(path.join(home,'AGENTS.md'),'original');
 const snapshot=captureNativeRuleCoverage({kind:'codex',cwd,env:{}});assert(stillCovered('original',snapshot));assert(!stillCovered('different',snapshot));
 write(path.join(home,'AGENTS.md'),'changed');assert(!stillCovered('original',snapshot));assert(!stillCovered('changed',snapshot));
 write(path.join(home,'AGENTS.override.md'),'replacement');const override=captureNativeRuleCoverage({kind:'codex',cwd,env:{}});assert(stillCovered('replacement',override));assert(!stillCovered('changed',override));
});
test('nested Git project still receives unique outer workspace rules',t=>{
 const home=fixture(t),repo=path.join(home,'repo'),cwd=path.join(repo,'src');fs.mkdirSync(cwd,{recursive:true});write(path.join(repo,'.git'),'gitdir: somewhere');write(path.join(home,'AGENTS.md'),'outer rule');write(path.join(repo,'AGENTS.md'),'repository rule');
 const nativeCoverage=captureNativeRuleCoverage({kind:'codex',cwd,env:{}});
 const result=sharedWorkspaceRules({session:{kind:'codex',cwd},workspaceService:{getWorkspaceRoot:()=>home},nativeCoverage});
 assert.deepEqual(result.map(r=>r.content),['outer rule']);
});
test('custom Claude exclusions and Codex document limits keep conservative supplementation',t=>{
 const home=fixture(t),cwd=path.join(home,'task');fs.mkdirSync(cwd);write(path.join(home,'CLAUDE.md'),'root');write(path.join(home,'.claude/settings.json'),JSON.stringify({claudeMdExcludes:['**']}));
 assert.deepEqual(captureNativeRuleCoverage({kind:'claude',cwd,env:{USERPROFILE:home}}),[]);
 write(path.join(home,'.vibe-root'),'');write(path.join(home,'AGENTS.md'),'A'.repeat(20000));write(path.join(cwd,'AGENTS.md'),'B'.repeat(20000));
 assert.deepEqual(captureNativeRuleCoverage({kind:'codex',cwd,env:{}}),[]);
});

test('personal hook policy and Hub PTY hook deployment converge instead of rejecting the next launch',t=>{
 // 回归：同步把 hooks.json 写成策略原样、Hub 部署再补状态 hook，第二次启动时同步把补充当成「独立修改」抛错，Codex 起不来。
 const home=fixture(t),dataDir=path.join(home,'.claude-session-hub'),env={USERPROFILE:home};
 const hooks={hooks:{UserPromptSubmit:[{hooks:[{type:'command',command:'python "C:/x/session-hub-hook.py" prompt',timeout:5}]}],PreToolUse:[{matcher:'Bash',hooks:[{type:'command',command:'python guard.py',timeout:10}]}]}};
 write(path.join(home,'.agents/USER_CONTEXT.md'),'same user');
 write(path.join(home,'.agents/context-policy.json'),JSON.stringify({version:1,codexHooks:hooks}));
 const nativeHome=path.join(home,'codex'),script=path.join(home,'hook.py');write(script,'print(1)');
 const {ensureCodexHookIntegration}=require('../core/codex-hook-integration');
 for(let launch=0;launch<3;launch+=1){
  syncNativeUserContext({kind:'codex',nativeHome,env,dataDir});
  const deployed=ensureCodexHookIntegration({codexHome:nativeHome,sourceScript:script,logger:{}});
  assert.deepEqual(deployed.errors,[]);assert.equal(deployed.hooksChanged,false,'policy sync already wrote the Hub entries');
 }
 const final=JSON.parse(fs.readFileSync(path.join(nativeHome,'hooks.json'),'utf8')).hooks;
 assert.equal(final.PreToolUse[0].hooks[0].command,'python guard.py');
 assert.equal(final.UserPromptSubmit.length,1,'the policy prompt hook is reused, not duplicated');
});
test('a hooks.json that is exactly the personal policy (written by the user sync, no Hub receipt) is upgraded, not rejected',t=>{
 // 2026-09-26 生产现场：~/.codex-profiles/second/hooks.json 由个人同步脚本按策略原样写入，没有 Hub 收据；
 // PTY 模式期望「策略 + Hub 条目」，旧判定把它当成独立修改而拒绝，所有 Codex 会话都恢复不了。
 const home=fixture(t),dataDir=path.join(home,'.claude-session-hub'),env={USERPROFILE:home};
 const hooks={hooks:{Stop:[{hooks:[{type:'command',command:'python guard.py --release',timeout:5}]}]}};
 write(path.join(home,'.agents/USER_CONTEXT.md'),'same user');
 write(path.join(home,'.agents/context-policy.json'),JSON.stringify({version:1,codexHooks:hooks}));
 const nativeHome=path.join(home,'second');
 write(path.join(nativeHome,'hooks.json'),JSON.stringify(hooks,null,2)+'\n');
 syncNativeUserContext({kind:'codex',nativeHome,env,dataDir});
 const {mergeHubCodexHooks,hubHookScriptPath}=require('../core/codex-hook-integration');
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(nativeHome,'hooks.json'),'utf8')),mergeHubCodexHooks(hooks,hubHookScriptPath(nativeHome)).hooksFile);
 // 真正被人手改过（既不是策略原样、也不是 Hub 合成内容、也没有收据）仍然拒绝覆盖。
 const other=path.join(home,'third');
 write(path.join(other,'hooks.json'),JSON.stringify({hooks:{Stop:[{hooks:[{type:'command',command:'python my-own.py'}]}]}}));
 assert.throws(()=>syncNativeUserContext({kind:'codex',nativeHome:other,env,dataDir}),/独立修改/);
});
