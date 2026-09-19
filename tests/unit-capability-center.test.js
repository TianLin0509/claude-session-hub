'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {collectCapabilities,tomlFlags}=require('../core/capability-catalog');
const {CapabilityService}=require('../core/capability-service');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'capability-unit-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const write=(rel,s)=>{const p=path.join(root,rel);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,s);return p;};return {root,write};}
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
  const r=await service.runtime('s');assert.equal(r.rows.length,5);assert.equal(r.rows[0].status,'原生已发现');assert.equal(r.rows.find(x=>x.name==='disabled').status,'原生已禁用');assert.equal(r.rows.find(x=>x.name==='server').status,'原生已连接');assert.equal(r.rows.find(x=>x.name==='empty').status,'连接状态未确认');assert.deepEqual(methods.sort(),['mcpServerStatus/list','mcpServerStatus/list','plugin/list','skills/list']);
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
  const r=await service.runtime('s');assert.equal(r.observedAt,12);assert.equal(r.rows.find(x=>x.name==='review').type,'command');assert.equal(r.rows.find(x=>x.name==='m').status,'原生状态：failed');
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
test('skill sharing is additive, preserves variants, includes companion files and is idempotent',t=>{
  const {root,write}=fixture(t);const {planSharing,applySharing}=require('../scripts/share-agent-skills');
  write('.codex/skills/task/SKILL.md','---\nname: task\n---\nsource');
  write('.codex/skills/task/scripts/run.js','companion');
  const original=write('.claude/skills/task/SKILL.md','---\nname: task\n---\nvariant');
  write('.claude/skills/task/scripts/run.js','companion');
  const plan=planSharing(root);assert.equal(plan.operations.length,1);
  const report=applySharing(plan,path.join(root,'manifest.json'));assert.equal(report.errors.length,0,JSON.stringify(report.errors));assert.equal(report.created.length,1);
  assert.equal(fs.readFileSync(original,'utf8'),'---\nname: task\n---\nvariant');
  assert.equal(fs.readFileSync(path.join(root,'.agents/skills/task/scripts/run.js'),'utf8'),'companion');
  assert.equal(planSharing(root).operations.length,0);
  // Remove only the fixture junction; never recursively remove its live target.
  fs.unlinkSync(report.created[0].target);
});
