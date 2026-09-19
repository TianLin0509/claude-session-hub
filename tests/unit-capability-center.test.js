'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {collectCapabilities,tomlFlags}=require('../core/capability-catalog');
const {CapabilityService}=require('../core/capability-service');
const {coverage,related}=require('../core/capability-view-model');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'capability-unit-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const write=(rel,s)=>{const p=path.join(root,rel);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,s);return p;};return {root,write};}
test('plugin contents preserve parent, custom paths, disabled state and reject outside paths',t=>{
  const {root,write}=fixture(t),plugin=path.join(root,'bundle');
  write('.claude/settings.json',JSON.stringify({enabledPlugins:{'bundle@test':false}}));
  write('.claude/plugins/installed_plugins.json',JSON.stringify({plugins:{'bundle@test':[{scope:'user',installPath:plugin}]}}));
  write('bundle/.claude-plugin/plugin.json',JSON.stringify({description:'Bundled workflow',skills:['./custom','../outside'],mcpServers:{private:{command:'SECRET_COMMAND',env:{KEY:'SECRET_KEY'}}}}));
  write('bundle/custom/task/SKILL.md','---\nname: bundled-task\ndescription: bundled\n---');
  write('outside/task/SKILL.md','---\nname: outside\n---');
  const r=collectCapabilities({homeDir:root,dataDir:root}),p=r.rows.find(x=>x.type==='plugin');
  assert.equal(p.description,'Bundled workflow');assert.equal(related(r.rows,p).length,2);
  assert.equal(coverage(r.rows.find(x=>x.name==='bundled-task'),'claude').state,'disabled');
  assert.equal(r.rows.some(x=>x.name==='outside'),false);assert.match(r.warnings.join(' '),/目录之外/);
  assert.doesNotMatch(JSON.stringify(r),/SECRET_COMMAND|SECRET_KEY/);
});
test('malformed credential JSON never echoes its payload; null MCP entries do not abort the catalog',t=>{
  const {root,write}=fixture(t);write('.claude.json','{"token":"VERY_PRIVATE", invalid}');
  write('.gemini/settings.json','{"mcpServers":{"invalid":null,"good":{"command":"do-not-run"}}}');
  const r=collectCapabilities({homeDir:root,dataDir:root});assert.equal(r.warnings.length,2);
  assert.ok(r.rows.some(x=>x.name==='good'));assert.doesNotMatch(JSON.stringify(r),/VERY_PRIVATE|do-not-run/);
});
test('coverage distinguishes real shared target, body variants, disabled and unsupported discovery',()=>{
  const r={type:'skill',sources:[{agent:'codex',scope:'shared',realPath:'/shared',hash:'one'},
    {agent:'claude',scope:'user',realPath:'/shared',hash:'one'}]};
  assert.equal(coverage(r,'claude').state,'shared');assert.equal(coverage(r,'qwen').label,'未发现');assert.equal(coverage(r,'glm').label,'未接入盘点');
  r.sources.push({agent:'claude',realPath:'/other',hash:'two'});assert.equal(coverage(r,'claude').state,'variant');
});
test('Codex explicit user skill disable is retained without changing another agent shared source',t=>{
  const {root,write}=fixture(t),file=write('.agents/skills/task/SKILL.md','---\nname: task\n---');
  write('.codex/config.toml','[[skills.config]]\npath = '+JSON.stringify(file)+'\nenabled = false\n');
  const row=collectCapabilities({homeDir:root,dataDir:root}).rows.find(r=>r.name==='task');
  assert.equal(coverage(row,'codex').state,'disabled');assert.equal(coverage(row,'kimi').state,'shared');
});
test('partial sharing failure preserves completed links and records the exact failed operation',async t=>{
  const {root,write}=fixture(t);write('.codex/skills/task/SKILL.md','---\nname: task\n---');
  const {planSharing,applySharing}=require('../scripts/share-agent-skills'), original=fs.promises.symlink;
  const plan=planSharing(root),failedTarget=plan.operations[1].target;
  fs.promises.symlink=async(...args)=>{if(args[1]===failedTarget)throw Object.assign(Error('fixture disk failure'),{code:'EIO'});return original.apply(fs.promises,args);};
  t.after(()=>{fs.promises.symlink=original;});
  const r=await applySharing(plan,path.join(root,'report.json'));
  assert.equal(r.created.length,1);assert.equal(r.errors.length,1);assert.match(r.errors[0].error,/fixture disk failure/);
  assert.ok(fs.existsSync(path.join(r.created[0].target,'SKILL.md')));fs.unlinkSync(r.created[0].target);
});
test('sharing preview is single use, rejects directory drift, applies additive links and rescans',async t=>{
  const {root,write}=fixture(t);write('.codex/skills/task/SKILL.md','---\nname: task\n---');
  const service=new CapabilityService({homeDir:root,dataDir:path.join(root,'data'),sessionManager:{getAllSessions:()=>[]}});
  const p=service.sharingPlan();assert.equal(p.operations.length,2);
  write('.codex/skills/task/SKILL.md','---\nname: changed\n---');await assert.rejects(()=>service.shareSkills(p.token),/目录已变化/);
  const p2=service.sharingPlan();const r=await service.shareSkills(p2.token);assert.equal(r.created,2);assert.equal(r.errors.length,0);
  await assert.rejects(()=>service.shareSkills(p2.token),/过期/);assert.equal(service.sharingPlan().operations.length,0);
  assert.equal((await service.catalog(true)).rows.find(x=>x.name==='changed').agents.includes('claude'),true);
  fs.unlinkSync(path.join(root,'.agents/skills/task'));fs.unlinkSync(path.join(root,'.claude/skills/task'));
});
test('catalog distinguishes shared, duplicate content, disabled and missing plugins without leaking credentials',t=>{
  const {root,write}=fixture(t);
  write('.agents/skills/sample/SKILL.md','---\nname: sample\ndescription: >\n  A useful workflow\n  for everyone\n---\nShared');
  write('.claude/skills/sample/SKILL.md','---\nname: sample\ndescription: Local variant\n---\nDifferent');
  write('.agents/skills/.archived/old/SKILL.md','---\nname: forbidden\n---');
  write('.codex/config.toml','[mcp_servers."private-service"]\nenabled=false\nhttp_headers={Authorization="SECRET_TEST_VALUE"}\n[plugins."a@b"]\nenabled=true\n');
  write('.claude/settings.json',JSON.stringify({enabledPlugins:{'missing@market':true}}));
  write('.claude.json',JSON.stringify({mcpServers:{browser:{command:'secret_command',env:{KEY:'SECRET_TEST_VALUE'}}}}));
  const r=collectCapabilities({homeDir:root,dataDir:path.join(root,'data')});
  const s=r.rows.find(s=>s.name==='sample');assert.equal(s.shared,true);assert.equal(s.conflict,true);
  assert.equal(s.description,'A useful workflow for everyone');assert.ok(s.agents.includes('kimi'));assert.ok(s.agents.includes('claude'));
  assert.equal(r.rows.some(s=>s.name==='forbidden'),false);
  assert.equal(r.rows.find(s=>s.name==='private-service').sources[0].enabled,false);
  assert.equal(r.rows.find(s=>s.name==='missing@market').sources[0].missing,true);
  assert.doesNotMatch(JSON.stringify(r),/SECRET_TEST_VALUE|secret_command/);
});
test('malformed JSON is visible and supported TOML quoted names and nested env keep status',t=>{
  const {root,write}=fixture(t);write('.gemini/settings.json','broken json');
  const r=collectCapabilities({homeDir:root,dataDir:root});assert.equal(r.warnings.length,1);
  assert.deepEqual(tomlFlags('[mcp_servers."my.service"]\nenabled = false # keep disabled\n[mcp_servers."my.service".env]\nenabled = true\n'),{mcp:[{name:'my.service',enabled:false}],plugins:[]});
});
test('worker catalog coalesces concurrent scans, refresh returns new files, sessions remain current',async t=>{
  const {root,write}=fixture(t);let sessions=[];
  const service=new CapabilityService({homeDir:root,dataDir:root,sessionManager:{getAllSessions:()=>sessions}});
  const [a,b]=await Promise.all([service.catalog(),service.catalog()]);assert.equal(a.generatedAt,b.generatedAt);
  write('.agents/skills/new/SKILL.md','---\nname: new\ndescription: newly installed\n---');
  const refreshed=await service.catalog(true);assert.ok(refreshed.rows.some(r=>r.name==='new'));
  sessions=[{id:'s',kind:'kimi'}];assert.equal((await service.catalog()).sessions.length,1);
});
function nativeFixture(backend='codex-app-server'){
  let native={threadId:'thread-1',sessionId:'claude-1',entry:{client:{}},runtime:{connection:'connected',epoch:2}};
  const session={id:'s',kind:backend==='codex-app-server'?'codex':'claude',runtimeBackend:backend,cwd:os.tmpdir(),mcpProfile:'full'};
  const manager={getAllSessions:()=>[session],getSession:()=>session,getNativeCodex:()=>backend==='codex-app-server'?native:null,getNativeClaude:()=>backend==='claude-stream-json'?native:null};
  return {service:new CapabilityService({sessionManager:manager,dataDir:os.tmpdir()}),native,replace:()=>{native={...native};},session};
}
test('Codex uses current native discovery, pagination and explicit status; never calls send or launches',async()=>{
  const {service,native}=nativeFixture();const methods=[];
  native.requestNative=async(_c,m,p,_timeout,opts)=>{opts.beforeWrite();methods.push(m);return m==='plugin/list'?{marketplaces:[{plugins:[{id:'p@m',installed:true,enabled:true},{id:'not-installed',installed:false}]}]}:m==='skills/list'?{data:[{skills:[{name:'skill',enabled:true},{name:'disabled',enabled:false}]}]}:p.cursor?{data:[{name:'empty',tools:{}}]}:{data:[{name:'server',runtimeStatus:'connected',tools:{hello:{}}}],nextCursor:'second'};};
  const r=await service.runtime('s');assert.equal(r.rows.length,4);assert.equal(r.rows[0].status,'原生已发现');assert.equal(r.rows.find(x=>x.name==='disabled').status,'原生已禁用');assert.equal(r.rows.find(x=>x.name==='server').status,'原生已连接');assert.equal(r.rows.find(x=>x.name==='empty').status,'连接状态未确认');assert.deepEqual(methods.sort(),['mcpServerStatus/list','mcpServerStatus/list','skills/list']);
});
test('connection or identity change rejects completed queries; no stale loaded claims',async()=>{
  const {service,native}=nativeFixture();native.requestNative=async()=>{native.runtime.epoch++;return {data:[]};};
  await assert.rejects(service.runtime('s'),/旧结果已丢弃/);
});
test('individual native failures stay visible and do not erase a successful category',async()=>{
  const {service,native}=nativeFixture();native.requestNative=async(_c,m)=>{if(m==='mcpServerStatus/list')throw Error('not supported');return {data:[{skills:[{name:'ok'}],errors:[{message:'bad metadata'}]}]};};
  const r=await service.runtime('s');assert.equal(r.rows.length,1);assert.equal(r.warnings.length,2);
});
test('Claude requires same epoch and identity init receipt; slash commands are not mislabeled skills',async()=>{
  const {service,native}=nativeFixture('claude-stream-json');delete native.threadId;
  native.runtime.capabilities={epoch:1,sessionId:native.sessionId,commands:['review']};assert.match((await service.runtime('s')).unknown,/初始化/);
  native.runtime.capabilities={epoch:2,sessionId:native.sessionId,observedAt:12,commands:['review'],skills:['writing'],plugins:[{name:'design'}],mcpServers:[{name:'m',status:'failed'}]};
  const r=await service.runtime('s');assert.equal(r.observedAt,12);assert.equal(r.rows.find(x=>x.name==='review').type,'command');assert.equal(r.rows.find(x=>x.name==='m').status,'原生连接失败');
});
test('PTY and disconnected sessions remain unknown; no config-derived loaded entries',async()=>{
  const {service,native}=nativeFixture();native.runtime.connection='disconnected';assert.equal((await service.runtime('s')).rows.length,0);assert.ok((await service.runtime('s')).unknown);
});
test('Claude system init stamps the actual provider identity and epoch',()=>{
  const {ClaudeNativeSession}=require('../core/claude-native-session');
  const native=new ClaudeNativeSession({id:'cap-test',kind:'claude',cwd:process.cwd(),launchArgs:[],sessionId:'11111111-2222-3333-4444-555555555555'});
  native.runtime.epoch=7;
  native.message({type:'system',subtype:'init',session_id:native.sessionId,model:'fixture',skills:['author'],plugins:[{name:'design'}],mcp_servers:[{name:'m',status:'connected'}],slash_commands:['review']});
  assert.equal(native.runtime.capabilities.sessionId,native.sessionId);assert.equal(native.runtime.capabilities.epoch,7);assert.ok(native.runtime.capabilities.observedAt);
  assert.deepEqual(native.runtime.capabilities.skills,['author']);
  native.message({type:'system',subtype:'init',session_id:'22222222-2222-3333-4444-555555555555',skills:['foreign']});
  assert.deepEqual(native.runtime.capabilities.skills,['author']);
});
test('skill sharing is additive, preserves variants, includes companion files and is idempotent',async t=>{
  const {root,write}=fixture(t);const {planSharing,applySharing}=require('../scripts/share-agent-skills');
  write('.codex/skills/task/SKILL.md','---\nname: task\n---\nsource');
  write('.codex/skills/task/scripts/run.js','companion');
  const original=write('.claude/skills/task/SKILL.md','---\nname: task\n---\nvariant');
  write('.claude/skills/task/scripts/run.js','companion');
  const plan=planSharing(root);assert.equal(plan.operations.length,1);
  const report=await applySharing(plan,path.join(root,'manifest.json'));assert.equal(report.errors.length,0,JSON.stringify(report.errors));assert.equal(report.created.length,1);
  assert.equal(fs.readFileSync(original,'utf8'),'---\nname: task\n---\nvariant');
  assert.equal(fs.readFileSync(path.join(root,'.agents/skills/task/scripts/run.js'),'utf8'),'companion');
  assert.equal(planSharing(root).operations.length,0);
  // Remove only the fixture junction; never recursively remove its live target.
  fs.unlinkSync(report.created[0].target);
});
