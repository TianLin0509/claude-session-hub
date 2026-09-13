'use strict';
// Owned stdio fixture: a real file records any stale approval side effect.
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const sessionId=process.argv[process.argv.indexOf('--session-id')+1] || randomUUID();
let active;const pending=new Map();
const send=value=>process.stdout.write(JSON.stringify({...value,session_id:sessionId})+'\n');
const success=id=>send({type:'control_response',response:{subtype:'success',request_id:id,response:{}}});
function ask(question=false) {
  const id=randomUUID();pending.set(id,active);
  send({type:'control_request',request_id:id,request:{subtype:'can_use_tool',tool_use_id:randomUUID(),
    tool_name:question?'AskUserQuestion':'Bash',input:question?{questions:[{question:'如何继续',options:[{label:'继续',description:'测试选项'}]}]}:{command:'fixture side effect'}}});
}
function finish() {
  if(!active?.cancelled || pending.size || active.finishing || active.text==='no-confirmation')return;
  active.finishing=true;
  setTimeout(()=>send({type:'result',subtype:'success',is_error:false,result:'已中断',uuid:randomUUID(),
    terminal_reason:'aborted_tools',origin:{kind:'human'}}),Number(process.env.CLAUDE_CANCEL_HOLD_MS)||25);
}
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const message=JSON.parse(line);
  if(message.type==='control_request') {
    success(message.request_id);
    if(message.request.subtype==='interrupt' && active) {
      active.cancelled=true;
      if(!active.text.startsWith('queued-')) {ask();ask(true);}
      finish();
    }
  } else if(message.type==='user') {
    active={text:message.message.content.filter(block=>block.type==='text').map(block=>block.text).join('')};
    send({...message,type:'user'});
    if(active.text.startsWith('queued-'))ask(active.text==='queued-question');
  } else if(message.type==='control_response') {
    const response=message.response;
    if(!pending.has(response.request_id))return;
    if(response.response?.behavior==='allow')fs.writeFileSync(path.join(process.cwd(),'side-effect.txt'),'stale action');
    fs.appendFileSync(path.join(process.cwd(),'responses.jsonl'),JSON.stringify(response)+'\n');
    pending.delete(response.request_id);finish();
  }
});
