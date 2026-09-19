'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {classifyRule,sharedWorkspaceRules,digest}=require('../core/memory-rule-files');
const {collectCatalog}=require('../core/hub-memory-catalog');
const {NativeMemoryEvidence}=require('../core/memory-native-evidence');
const {inspect}=require('../core/memory-native-evidence-worker');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-rule-unit-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
function write(file,text){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text,'utf8');}
function copy(source,body,hash=digest(body).slice(0,16)){return `<!-- 由 AI Hub 自动复制自 ${source}，旧副本\nseed-sha256: ${hash}\n-->\n\n${body}`;}
function native(id,body){return [{type:'session_meta',payload:{id}},
  {type:'response_item',timestamp:new Date().toISOString(),payload:{type:'message',role:'user',content:[{type:'input_text',text:`# AGENTS.md instructions for C:\\project\n<INSTRUCTIONS>\n${body}\n</INSTRUCTIONS>`}]}}].map(JSON.stringify).join('\n')+'\n';}
test('only provenance plus exact seed hash classifies an unchanged Hub copy',t=>{
 const root=fixture(t),file=path.join(root,'AGENTS.md'),body='# 中文\n原始规则\n';
 write(file,body);assert.equal(classifyRule(file).state,'owned');
 write(file,copy('C:\\work\\AGENTS.md',body));assert.equal(classifyRule(file).state,'unchanged');assert.equal(classifyRule(file).source,'C:\\work\\AGENTS.md');
 fs.appendFileSync(file,'用户修改');assert.equal(classifyRule(file).state,'modified');
 write(file,copy('C:\\work\\AGENTS.md',body,'missing'));assert.equal(classifyRule(file).state,'unknown');
});
test('shared rules stay in raw prompts but are folded and excluded from search',()=>{
 const text='真实问题\n\n<ai-hub-workspace-rules ref="workspace-1">\n完整共享规则\n</ai-hub-workspace-rules>';
 assert.equal(require('../core/synthetic-user-filter').searchableUserText(text),'真实问题');
 const split=require('../core/memory-index-envelope').splitMemoryIndex(text);assert.equal(split.userText,'真实问题');assert.match(split.indexText,/完整共享规则/);
});
test('missing ancestor rules travel by submission; native coverage and outside scope do not duplicate',t=>{
 const root=fixture(t),cwd=path.join(root,'scratch','task'),home=path.join(root,'home');fs.mkdirSync(cwd,{recursive:true});
 write(path.join(root,'AGENTS.md'),'workspace rule');
 const request={session:{kind:'codex',cwd},homeDir:home,workspaceService:{getWorkspaceRoot:()=>root}};
 assert.equal(sharedWorkspaceRules(request)[0].content,'workspace rule');
 write(path.join(cwd,'AGENTS.md'),'workspace rule');assert.deepEqual(sharedWorkspaceRules(request),[]);
 fs.unlinkSync(path.join(cwd,'AGENTS.md'));fs.mkdirSync(path.join(root,'.git'));assert.deepEqual(sharedWorkspaceRules(request),[]);
 assert.deepEqual(sharedWorkspaceRules({...request,session:{kind:'codex',cwd:root+'-outside'}}),[]);
});
test('catalog finds registered orphan copies without scanning aggregate trees and reports global drift',t=>{
 const root=fixture(t),home=path.join(root,'home'),file=path.join(root,'old','AGENTS.md');
 write(file,copy(path.join(root,'AGENTS.md'),'old rules'));
 const result=collectCatalog({homeDir:home,workspaceRoot:root,memoryRoot:path.join(root,'memory'),sessions:[],workspaces:[{path:path.dirname(file)}]});
 assert.equal(result.files.find(f=>f.path===file).group,'历史规则副本');assert.equal(result.globalRulesAligned,false);
});
test('native evidence verifies identity and stores raw instruction body, never a guessed file path',async t=>{
 const root=fixture(t),file=path.join(root,'raw.jsonl');write(file,native('n1','真实规则正文'));
 const result=await inspect({file,nativeId:'n1'});assert.equal(result.rows[0].content,'真实规则正文');assert.equal(result.rows[0].path,'');
 await assert.rejects(inspect({file,nativeId:'n2'}),/身份/);
 fs.appendFileSync(file,'malformed\n');assert.equal((await inspect({file,nativeId:'n1'})).warnings.length,1);
});
test('native worker returns immediately then refreshes and persists evidence without blocking context',async t=>{
 const root=fixture(t),file=path.join(root,'raw.jsonl');write(file,native('n1','规则快照'));
 const evidence=new NativeMemoryEvidence({root,notify(){},logger:{error(){}}});const s={codexSid:'n1',transcriptPath:file};
 const first=await evidence.read(s);assert.equal(first.state,'loading');assert.deepEqual(first.rows,[]);
 await evidence.flights.get('codex:n1');assert.equal((await evidence.read(s)).rows[0].content,'规则快照');
 const reopened=new NativeMemoryEvidence({root,notify(){}});assert.equal((await reopened.read({codexSid:'n1'})).rows.length,1);
});
test('concurrent Claude load events retain both entries; foreign identities and subagents are rejected',async t=>{
 const root=fixture(t),e=new NativeMemoryEvidence({root,notify(){}}),s={ccSessionId:'c1'};
 const event=instructionPath=>({claudeSessionId:'c1',instructionPath,loadReason:'include'});
 await Promise.all(['A.md','B.md'].map(n=>e.loaded(s,event(path.join(root,n)))));
 assert.equal((await e.read(s)).rows.length,2);
 assert.equal(await e.loaded(s,{...event(path.join(root,'C.md')),claudeSessionId:'wrong'}),false);
 assert.equal(await e.loaded(s,{...event(path.join(root,'C.md')),agentId:'child'}),false);
 assert.equal((await e.read(s)).rows[0].snapshot,false);
});
test('Claude persistence failures remain visible and a later event can recover',async t=>{
 const root=fixture(t),e=new NativeMemoryEvidence({root,notify(){}}),s={ccSessionId:'c1'};
 const original=e.persist.bind(e);e.persist=async()=>{throw new Error('write denied');};
 const event={claudeSessionId:'c1',instructionPath:path.join(root,'A.md')};
 await assert.rejects(e.loaded(s,event),/write denied/);assert.match((await e.read(s)).persistenceError,/write denied/);
 e.persist=original;await e.loaded(s,event);assert.equal((await e.read(s)).persistenceError,undefined);
});
