'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const {parseGeminiTranscriptToTurns:parse}=require('../core/gemini-transcript-parser');
test('Gemini JSON and JSONL native histories preserve Unicode, latest message and tool status',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gemini-projection-'));
 const rows=[{id:'u',type:'user',timestamp:'2026-09-26T10:00:00Z',content:[{text:'中文🙂'}]},
 {id:'a',type:'gemini',content:'draft'},
 {id:'a',type:'gemini',content:'answer',tokens:{total:10},toolCalls:[{id:'tool',name:'read_file',args:{path:'x'},result:{text:'ok'},status:'success'}]}];
 try{for(const ext of ['json','jsonl']){
  const file=path.join(root,'session.'+ext);fs.writeFileSync(file,ext==='json'?JSON.stringify({sessionId:'12345678-full',messages:rows}):[{sessionId:'12345678-full'},...rows,{$set:{lastUpdated:'now'}}].map(JSON.stringify).join('\n')+'\n{"partial":');
  const cards=parse(file,{expectedSessionId:'12345678'});assert.equal(cards.length,2);assert.equal(cards[0].text,'中文🙂');assert.equal(cards[1].text,'answer');assert.equal(cards[1].toolCalls[0].status,'completed');
  assert.throws(()=>parse(file,{expectedSessionId:'other'}),/不属于/);assert.equal(parse(file,{limit:1})[0].role,'assistant');
 }}finally{fs.rmSync(root,{recursive:true,force:true});}
});
