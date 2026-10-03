const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {LiveHistory,readFinals}=require('../core/hub-assistant/live-history');
const envelope=id=>'[AI_HUB_ASSISTANT_CONTEXT_V1]'+JSON.stringify({role:'assistant',userText:'task',sessions:{sessions:[]},history:{clientSubmissionId:id}})+'[/AI_HUB_ASSISTANT_CONTEXT_V1]';
test('Claude final is bound to its native user envelope, survives tool results and cold tail restart',()=>{
 const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'phone-claude-')),'native.jsonl'),meta={id:'assistant',kind:'claude',ccSessionId:'native',transcriptPath:file};
 const rows=[{type:'user',sessionId:'native',message:{content:envelope('phone-request-1111')}},{type:'assistant',sessionId:'native',uuid:'old',message:{stop_reason:'end_turn',content:[{type:'text',text:'old'}]}},{type:'user',sessionId:'native',message:{content:envelope('phone-request-2222')}},{type:'user',sessionId:'native',message:{content:[{type:'tool_result',content:'x'.repeat(1200000)}]}},{type:'assistant',sessionId:'native',uuid:'new',message:{stop_reason:'end_turn',content:[{type:'text',text:'new'}]}}];
 fs.writeFileSync(file,rows.map(JSON.stringify).join('\n')+'\n');
 const records=new LiveHistory().read(meta).records;
 assert.equal(records.at(-1).clientSubmissionId,'phone-request-2222');assert.equal(records.at(-1).text,'new');
 fs.appendFileSync(file,JSON.stringify({type:'user',sessionId:'native',message:{content:'desktop task'}})+'\n'+JSON.stringify({type:'assistant',sessionId:'native',uuid:'desktop',message:{stop_reason:'end_turn',content:[{type:'text',text:'desktop'}]}})+'\n');
 assert.equal(new LiveHistory().read(meta).records.at(-1).clientSubmissionId,null);assert.equal(readFinals({...meta,ccSessionId:'wrong'}).available,false);
});
