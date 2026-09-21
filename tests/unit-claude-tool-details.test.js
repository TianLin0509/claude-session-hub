'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const {compactClaudeTools,readClaudeToolResult}=require('../core/claude-tool-details');
const {trimFramesForJournal,KEEP_CHARS}=require('../core/native-transcript-trim');

const sessionWith=(frames,extra={})=>({sessionId:'thread',
  records:new Map([['submission',{userMessageId:'user',messages:new Map(frames.map((f,i)=>['m'+i,f]))}]]),
  activities:{records:new Map()},...extra});
const resultFrame=(content)=>({uuid:'m0',type:'user',message:{content:[{type:'tool_result',tool_use_id:'tool',content}]}});

test('Claude live cards keep a small preview and an exact provider-bound full result',async()=>{
  const text='完整输出🧪'.repeat(500000),input={file_path:'C:/fixture/example.js',new_string:'x'.repeat(8000000)};
  const source=[{id:'card',userMessageId:'user',role:'assistant',toolCalls:[{id:'tool',name:'Edit',input,output:text}]}];
  const compact=compactClaudeTools(source,{hubSessionId:'hub',threadId:'thread'});
  assert(JSON.stringify(compact).length<5000);assert.equal(source[0].toolCalls[0].output,text);assert.equal(source[0].toolCalls[0].input,input);
  assert.equal(compact[0].toolCalls[0].input.file_path,input.file_path);
  const session=sessionWith([resultFrame(text)]);
  const reference=compact[0].toolCalls[0].resultRef;
  assert.equal(await readClaudeToolResult(session,reference),text);
  await assert.rejects(()=>readClaudeToolResult(session,{...reference,threadId:'foreign'}),/不属于/);
  await assert.rejects(()=>readClaudeToolResult(session,{...reference,itemId:'missing'}),/未找到/);
  source[0].toolCalls[0].output='new result';
  assert.equal(compactClaudeTools(source,{hubSessionId:'hub',threadId:'thread'})[0].toolCalls[0].output,'new result');
});

// A restored session holds trimmed frames; the provider transcript is the
// remainder. These two tests are the contract that makes trimming lossless.
test('a trimmed result is served in full from the provider transcript',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-tooltrim-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const text='工具输出🧪'.repeat(5000);
  const file=path.join(dir,'native.jsonl');
  fs.writeFileSync(file,[JSON.stringify({uuid:'other',message:{content:[{type:'text',text:'无关'}]}}),
    JSON.stringify(resultFrame(text))].join('\n')+'\n','utf8');
  const [stored]=trimFramesForJournal([resultFrame(text)]);
  const block=stored.message.content[0];
  assert.ok(block.hubTrimmed,'large results must be trimmed on the way to disk');
  assert.ok(text.startsWith(text.slice(0,KEEP_CHARS)) && block.content.startsWith(text.slice(0,KEEP_CHARS)),'the kept head must be a prefix of the original');
  assert.match(block.content,/全文共 \d+ 字/,'the stored body says it is only a head');
  const session=sessionWith([stored],{historyPath:()=>file});
  assert.equal(await readClaudeToolResult(session,{threadId:'thread',userMessageId:'user',itemId:'tool'}),text);
});

test('a lost provider transcript reports the gap instead of passing off the head',async()=>{
  const text='工具输出'.repeat(5000);
  const [stored]=trimFramesForJournal([resultFrame(text)]);
  const session=sessionWith([stored],{historyPath:()=>path.join(os.tmpdir(),'hub-missing-'+Date.now()+'.jsonl')});
  const answer=await readClaudeToolResult(session,{threadId:'thread',userMessageId:'user',itemId:'tool'});
  assert.match(answer,/已找不到这段工具输出的全文/);
  assert.ok(answer.endsWith(stored.message.content[0].content),'the kept head is still delivered');
});

test('small results are stored untouched and need no transcript',async()=>{
  const text='短输出';
  const frames=[resultFrame(text)];
  assert.equal(trimFramesForJournal(frames),frames,'an untrimmed frame keeps its identity');
  const session=sessionWith(frames,{historyPath:()=>{throw new Error('must not read the transcript');}});
  assert.equal(await readClaudeToolResult(session,{threadId:'thread',userMessageId:'user',itemId:'tool'}),text);
});
