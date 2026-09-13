'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {compactClaudeTools,readClaudeToolResult}=require('../core/claude-tool-details');
test('Claude live cards keep a small preview and an exact provider-bound full result',()=>{
  const text='完整输出🧪'.repeat(500000),input={file_path:'C:/fixture/example.js',new_string:'x'.repeat(8000000)};
  const source=[{id:'card',userMessageId:'user',role:'assistant',toolCalls:[{id:'tool',name:'Edit',input,output:text}]}];
  const compact=compactClaudeTools(source,{hubSessionId:'hub',threadId:'thread'});
  assert(JSON.stringify(compact).length<5000);assert.equal(source[0].toolCalls[0].output,text);assert.equal(source[0].toolCalls[0].input,input);
  assert.equal(compact[0].toolCalls[0].input.file_path,input.file_path);
  const session={sessionId:'thread',records:new Map([['submission',{userMessageId:'user',messages:new Map([['message',{message:{content:[{type:'tool_result',tool_use_id:'tool',content:text}]}}]])}]]),activities:{records:new Map()}};
  const reference=compact[0].toolCalls[0].resultRef;
  assert.equal(readClaudeToolResult(session,reference),text);
  assert.throws(()=>readClaudeToolResult(session,{...reference,threadId:'foreign'}),/不属于/);
  assert.throws(()=>readClaudeToolResult(session,{...reference,itemId:'missing'}),/未找到/);
  source[0].toolCalls[0].output='new result';
  assert.equal(compactClaudeTools(source,{hubSessionId:'hub',threadId:'thread'})[0].toolCalls[0].output,'new result');
});
