'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {AssistantService}=require('../core/hub-assistant/service');
const {ALL_AI_KINDS}=require('../core/ai-kinds');
const {configureProjectTools}=require('../core/hub-assistant/project-tools');
const {AssistantFinalReaders,projectFinals}=require('../core/hub-assistant/final-readers');
function temp(t,cleanup=true){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-providers-unit-'));if(cleanup)t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('every Hub AI backend has its own retained manager identity and scoped tools',async t=>{
  const dataDir=temp(t,false),sessions=new Map();const service=new AssistantService({dataDir,getSession:id=>sessions.get(id),getAllSessions:()=>[...sessions.values()],
    createSession:async(kind,opts)=>{const s={...opts,kind,status:'idle'};sessions.set(s.id,s);return s;}});t.after(()=>{service.close();fs.rmSync(dataDir,{recursive:true,force:true});});
  const ids=new Set();for(const kind of ALL_AI_KINDS){const r=await service.switchBackend({kind});ids.add(r.sessionId);assert.equal(r.session.purpose,'hub-assistant');
    const servers=r.session.codexMcpEntries||r.session.assistantMcpServers;
    const entry=servers?.[0]||r.session.assistantMcpEntry||((kind==='claude'||kind==='codeagent')?JSON.parse(fs.readFileSync(r.session.mcpConfigFile,'utf8')).mcpServers.hub_assistant:null);
    assert(entry,kind+' must have a tool bridge');
    assert.equal((await service.switchBackend({kind})).sessionId,r.sessionId);
  }
  assert.equal(ids.size,ALL_AI_KINDS.length);assert.deepEqual(service.sessions(),[]);
  assert.throws(()=>service.getLaunchOptions('powershell','bad'),/Hub 支持/);
});
test('project tool registration preserves other settings and rejects a different assistant identity',t=>{
  const cwd=temp(t),entry={name:'hub_assistant',command:'node',args:['bridge.js'],env:{HUB_ASSISTANT_SESSION_ID:'fixed-a'}};
  for(const kind of ['gemini','kimi']){
    const dir=path.join(cwd,kind==='gemini'?'.gemini':'.kimi-code'),file=path.join(dir,kind==='gemini'?'settings.json':'mcp.json');fs.mkdirSync(dir);
    fs.writeFileSync(file,JSON.stringify({theme:'user-choice',mcpServers:{existing:{command:'own-tool'}}}));
    configureProjectTools(kind,{id:'fixed-a',purpose:'hub-assistant',assistantMcpEntry:entry},cwd);
    const saved=JSON.parse(fs.readFileSync(file));assert.equal(saved.theme,'user-choice');assert.equal(saved.mcpServers.existing.command,'own-tool');
    assert.equal(saved.mcpServers.hub_assistant.env.HUB_ASSISTANT_SESSION_ID,'fixed-a');
    assert.throws(()=>configureProjectTools(kind,{id:'fixed-b',purpose:'hub-assistant',assistantMcpEntry:{...entry,env:{HUB_ASSISTANT_SESSION_ID:'fixed-b'}}},cwd),/另一助理/);
    assert.throws(()=>configureProjectTools(kind,{id:'fixed-a',purpose:'ordinary',assistantMcpEntry:entry},cwd),/身份不一致/);
  }
});
test('provider evidence rejects unbound writers and takes only completed final speech',t=>{
  const meta={id:'qwen-manager',kind:'qwen',acpSid:'native-a'},rows=[
    {id:'user',role:'user',text:'提问'},
    {id:'partial',role:'assistant',nativeOutcome:null,text:'过程'},
    {id:'failed',role:'assistant',nativeOutcome:'failed',text:'失败'},
    {id:'final',role:'assistant',nativeOutcome:'completed',text:'包含过程',tsEnd:123,displayMessages:[{phase:'commentary',text:'过程'},{phase:'final_answer',text:'最终结果'}]}
  ];
  const reader=new AssistantFinalReaders({dataDir:temp(t),readNativeTurns:()=>({identity:'native-a',turns:rows})});
  assert.deepEqual(reader.read(meta).records.map(r=>r.text),['最终结果']);
  assert.equal(reader.read({...meta,acpSid:'native-b'}).available,false);
  assert.equal(projectFinals(meta,rows,'test').records[0].timestamp,123);
});
test('Gemini disk evidence checks full native identity and finality',t=>{
  const dir=temp(t),file=path.join(dir,'chat.jsonl');fs.writeFileSync(file,[
    {sessionId:'gemini-exact'},
    {id:'partial',type:'gemini',content:'尚在思考',timestamp:new Date().toISOString()},
    {id:'done',type:'gemini',content:'工作已交付',tokens:{total:20},timestamp:new Date().toISOString()}
  ].map(JSON.stringify).join('\n')+'\n');
  const reader=new AssistantFinalReaders({dataDir:dir}),meta={id:'g',kind:'gemini',geminiChatId:'gemini-exact',transcriptPath:file};
  assert.deepEqual(reader.read(meta).records.map(r=>r.text),['工作已交付']);
  assert.equal(reader.read({...meta,geminiChatId:'another'}).available,false);
  assert.deepEqual(reader.read({...meta,kind:'gemini-resume'}).records.map(r=>r.text),['工作已交付']);
});
test('historical Claude Resume cards retain exact bound final evidence',t=>{
  const dir=temp(t),file=path.join(dir,'claude.jsonl'),id='claude-original';
  fs.writeFileSync(file,JSON.stringify({type:'assistant',uuid:'answer1',timestamp:new Date().toISOString(),sessionId:id,message:{id:'m1',stop_reason:'end_turn',content:[{type:'text',text:'原会话最终答复'}]}})+'\n');
  const reader=new AssistantFinalReaders({dataDir:dir}),meta={id:'old-card',kind:'claude-resume',ccSessionId:id,transcriptPath:file};
  assert.deepEqual(reader.read(meta).records.map(r=>r.text),['原会话最终答复']);
  assert.equal(reader.read({...meta,ccSessionId:'another'}).available,false);
});
test('resume aliases preserve original native identities for all provider families',()=>{
  const {nativeId}=require('../core/hub-assistant/live-history');
  for(const [kind,key] of [['codex','codexSid'],['claude','ccSessionId'],['deepseek','codexSid'],['gemini','geminiChatId'],['kimi','kimiSid'],['qwen','acpSid'],['glm','acpSid'],['deepseek-acp','acpSid']]){
    assert.equal(nativeId({kind:kind+'-resume',[key]:'original-thread'}),'original-thread');
    assert.equal(nativeId({kind:kind+'-resume'}),null);
  }
});
