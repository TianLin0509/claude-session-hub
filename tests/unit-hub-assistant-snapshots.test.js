'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {AssistantService}=require('../core/hub-assistant/service');
const {hashPacket}=require('../core/hub-assistant/snapshots');
const {assistantContextDisplay}=require('../core/assistant-context-display');
function fixture(t){
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-snapshot-'));
  const service=new AssistantService({dataDir,getSession:()=>null,getAllSessions:()=>[]});
  let packet={asOf:123,since:100,until:123,range:'rolling-window',sources:[{ref:'E1234567890123456',text:'材料'.repeat(12000)}],selectedChars:24000,truncated:false};
  service.context=()=>({...packet,workbench:{markdownPath:path.join(dataDir,'CURRENT.md'),revision:'fixture',activeCount:0,mode:'checkpoint',revisions:{}}});t.after(()=>service.close());
  return{service,replace:value=>{packet=value;}};
}
test('large materials stay in immutable snapshot and normal bootstrap stays below 2048 chars',async t=>{
  const {service,replace}=fixture(t),prepared=service.preparePrompt({text:'最近有什么变化？'});
  assert.ok(prepared.text.length<2048);const view=assistantContextDisplay(prepared.text,'hub-assistant');assert.equal(view.userText,'最近有什么变化？');
  assert.match(prepared.text,/输出截断则扩大本次输出预算补读/);assert.match(prepared.text,/text\(\)/);
  assert.equal(prepared.text.includes('\n'),false,'transport frame stays exact when Codex removes boundary line breaks');
  const token=service.currentRequest.token,stored=JSON.parse(fs.readFileSync(service.snapshots.file(token),'utf8'));
  assert.equal(stored.packetHash,hashPacket(stored.packet));assert.equal(stored.packet.selectedChars,24000);
  assert.equal(service.overview().contextCoverage.snapshotRead,false);assert.ok(!prepared.text.includes('材料'));
  replace({sources:[],selectedChars:0,asOf:999});
  const response=await service.invokeTool({name:'history_context',arguments:{requestToken:token}});
  assert.deepEqual(response.packet,stored.packet);assert.equal(response.snapshotReceipt.packetHash,stored.packetHash);
  assert.equal(service.overview().contextCoverage.snapshotRead,true);
  assert.match(response.snapshotReceipt.evidence,/native receipt requires transcript verification/);
});
test('dynamic lookup does not claim a frozen snapshot was read; stale tokens cannot retrieve a new turn',async t=>{
  const {service}=fixture(t);service.preparePrompt({text:'进展'});const old=service.currentRequest.token;
  await service.invokeTool({name:'history_context',arguments:{query:'研究'}});
  assert.equal(service.overview().contextCoverage.snapshotRead,false);
  service.preparePrompt({text:'下一条进展'});
  await assert.rejects(service.invokeTool({name:'history_context',arguments:{requestToken:old}}),/不属于当前/);
  assert.equal(service.overview().contextCoverage.snapshotRead,false);
});
test('corrupted snapshot is rejected before a read receipt is published',async t=>{
  const {service}=fixture(t);service.preparePrompt({text:'进展'});const token=service.currentRequest.token,file=service.snapshots.file(token);
  const stored=JSON.parse(fs.readFileSync(file,'utf8'));stored.packet.sources[0].text='changed';fs.writeFileSync(file,JSON.stringify(stored),'utf8');
  await assert.rejects(service.invokeTool({name:'history_context',arguments:{requestToken:token}}),/完整性/);
  assert.equal(service.overview().contextCoverage.snapshotRead,false);
});
test('long user requests remain verbatim and resending a bootstrap generates a fresh snapshot',t=>{
  const {service}=fixture(t),text='这是用户原话\n'.repeat(500);
  const first=service.preparePrompt({text}),old=service.currentRequest.token;
  assert.equal(assistantContextDisplay(first.text,'hub-assistant').userText,text);assert.ok(first.text.length>2048);
  assert.equal(first.text.includes('\n'),false,'user line breaks stay escaped in transport and intact after decoding');
  assert.match(service.overview().contextCoverage.inputTransportNote,/用户原话较长/);
  const second=service.preparePrompt(first);assert.notEqual(service.currentRequest.token,old);
  assert.equal(assistantContextDisplay(second.text,'hub-assistant').userText,text);
  assert.equal(second.text.split('[AI_HUB_ASSISTANT_CONTEXT_V1]').length,2);
});
