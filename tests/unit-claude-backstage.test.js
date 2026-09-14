'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {ClaudeBackstage} = require('../core/claude-backstage');
function session(options={}) {
  return Object.assign(new EventEmitter(),{options,sessionId:'native',runtime:{state:'completed'},records:new Map(),activities:{records:new Map()}});
}
const assistant=(id, content)=>({type:'assistant',uuid:id,message:{id,content}});
test('stream snapshots deduplicate, tool results remain complete, and paged records survive reopening', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'claude-backstage-'));
  let backstage=new ClaudeBackstage(session({hubDataDir:root,id:'hub'}));
  const large='中文 🧪\u0000'.repeat(10000)+'FULL-END';
  try {
    const stream=event=>backstage.frame({type:'stream_event',event},'u');
    stream({type:'message_start',message:{id:'m'}});
    stream({type:'content_block_start',index:0,content_block:{type:'text',text:''}});
    stream({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'hello'}});
    backstage.frame(assistant('m',[{type:'text',text:'hello'}]),'u');
    backstage.frame(assistant('call',[{type:'tool_use',id:'tool',name:'Read',input:{file_path:'a'}}]),'u');
    backstage.frame({type:'user',uuid:'result',message:{content:[{type:'tool_result',tool_use_id:'tool',content:large}]}},'u');
    const page=backstage.read();
    assert.equal(page.entries.filter(e=>e.type==='agentMessage').length,1);
    const tool=page.entries.find(e=>e.itemId==='tool');
    assert.equal(tool.title,'Read'); assert.equal(tool.status,'completed');
    assert.equal(tool.fields.output.length,large.length);
    assert(JSON.stringify(page).length<18000);
    backstage.close(); backstage=new ClaudeBackstage(session({hubDataDir:root,id:'hub'}));
    let after=0,text='';
    do {
      const result=backstage.read({mode:'detail',id:'u/tool',after,limit:60});
      for(const c of result.chunks) {if(c.field==='output')text+=c.text;after=c.seq;}
      if(!result.more)break;
    } while(true);
    assert.equal(text,large);
  } finally {backstage.close(); fs.rmSync(root,{recursive:true,force:true});}
});
test('older saved tools retain both input and output when history loads backwards', () => {
  const s=session();
  s.records.set('s',{userMessageId:'u',createdAt:1,text:'prompt',messages:new Map([
    ['call',assistant('call',[{type:'tool_use',id:'tool',name:'Read',input:{path:'original'}}])],
    ['result',{type:'user',uuid:'result',message:{content:[{type:'tool_result',tool_use_id:'tool',content:'answer'}]}}]
  ])});
  const b=new ClaudeBackstage(s);
  try {const rows=b.read().entries;const tool=rows.find(e=>e.itemId==='tool');
    assert.equal(tool.title,'Read');assert.equal(tool.status,'completed');
    assert.match(tool.fields.details.preview,/original/);assert.equal(tool.fields.output.preview,'answer');
    assert.equal(rows.filter(e=>e.type==='userMessage').length,1);
  } finally {b.close();}
});
test('capture failures are visible and do not claim the model failed', () => {
  const s=session(),b=new ClaudeBackstage(s),errors=[];
  s.on('backstage-updated',e=>{if(e.error)errors.push(e.error);});
  b.ensure=()=>{throw Error('disk full');};
  b.frame(assistant('m',[{type:'text',text:'answer'}]),'u');
  assert.equal(s.runtime.state,'completed');assert.match(errors[0],/disk full/);
  assert.throws(()=>b.read(),/disk full/);b.close();
});

test('a stopped turn cannot leave its unfinished tool and partial answer marked running', () => {
  const b=new ClaudeBackstage(session());
  try {
    b.frame(assistant('call',[{type:'tool_use',id:'tool',name:'Read',input:{path:'a'}}]),'u');
    b.frame(assistant('other',[{type:'tool_use',id:'other-tool',name:'Read',input:{path:'b'}}]),'other');
    b.frame({type:'stream_event',event:{type:'message_start',message:{id:'partial'}}},'u');
    b.frame({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'text',text:'partial'}}},'u');
    b.frame({type:'result',subtype:'success',terminal_reason:'aborted_tools'},'u');
    const rows=b.read().entries;
    assert.equal(rows.find(e=>e.itemId==='tool').status,'interrupted');
    assert.equal(rows.find(e=>e.itemId==='partial:0').status,'interrupted');
    assert.equal(rows.find(e=>e.itemId==='other-tool').status,'running');
  } finally {b.close();}
});
