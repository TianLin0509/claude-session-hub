'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {ClaudeBrokerSession,restoreRecord}=require('../core/claude-broker-session');
function fixture() {
  const record={submissionId:'s',userMessageId:'u',status:'running',createdAt:1,
    messages:new Map([['result',{type:'user',message:{content:[{type:'tool_result',content:'完整结果🧪'.repeat(100000)}]}}]]),streams:new Map()};
  const owner=Object.create(ClaudeBrokerSession.prototype);
  owner.options={id:'fixture'};owner.changedUsers=new Set();owner.contentRevision=1;
  owner.native={options:{},runtime:{userMessageId:'u'},records:new Map([['s',record]]),activities:{records:new Map()},recoveryRecords:()=>[]};
  const wire=options=>JSON.parse(JSON.stringify(owner.snapshotExtra(options)));
  return {record,owner,wire};
}
test('incremental Claude records keep exact history and replace only changed messages',()=>{
  const {record,wire}=fixture();let view=restoreRecord(wire({full:true}).nativeRecords[0]);
  wire({messagePatches:true});
  for(let i=0;i<20;i++) {
    record.streams.set('live',{message:{id:'live',content:[{type:'text',text:'输出 '+i}]}});
    const update=wire({messagePatches:true});assert(JSON.stringify(update).length<2000);
    view=restoreRecord(update.nativeRecords[0],view);
  }
  assert.deepEqual(view.messages,record.messages);assert.deepEqual(view.streams,record.streams);
  record.messages.set('answer',{type:'assistant',message:{content:[{type:'text',text:'最终回答'}]}});record.streams.clear();
  view=restoreRecord(wire({messagePatches:true}).nativeRecords[0],view);
  assert.equal(view.streams.size,0);assert.equal(view.messages.size,2);assert.deepEqual(view.messages,record.messages);
});
test('a new viewer full snapshot cannot consume updates still needed by existing viewers',()=>{
  const {record,wire}=fixture();let existing=restoreRecord(wire({full:true}).nativeRecords[0]);wire({messagePatches:true});
  record.messages.set('new',{type:'assistant',message:{content:[{type:'text',text:'必须两窗都收到'}]}});
  const newcomer=restoreRecord(wire({full:true}).nativeRecords[0]);
  existing=restoreRecord(wire({messagePatches:true}).nativeRecords[0],existing);
  assert.deepEqual(existing.messages,newcomer.messages);
  record.messages.delete('new');existing=restoreRecord(wire({messagePatches:true}).nativeRecords[0],existing);
  assert.equal(existing.messages.has('new'),false);
});
test('legacy broker/view contract still receives complete messages without a patch flag',()=>{
  const {record,wire}=fixture();wire({messagePatches:true});
  const legacy=wire().nativeRecords[0];assert.equal(legacy.messagePatch,undefined);
  assert.deepEqual(restoreRecord(legacy).messages,record.messages);
  const modern=restoreRecord(legacy);assert.deepEqual(restoreRecord(wire({messagePatches:true}).nativeRecords[0],modern).messages,record.messages);
});
