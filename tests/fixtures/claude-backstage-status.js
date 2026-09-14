'use strict';
const {randomUUID}=require('node:crypto');
const args=process.argv,id=args[args.indexOf('--session-id')+1]||randomUUID();
const frame=value=>process.stdout.write(JSON.stringify({session_id:id,...value})+'\n');
const success=request_id=>frame({type:'control_response',response:{subtype:'success',request_id,response:{fast_mode_state:'off'}}});
const finish=(interrupted=false)=>frame({type:'result',uuid:randomUUID(),subtype:'success',is_error:false,
  result:interrupted?'':'STATUS_DONE',terminal_reason:interrupted?'aborted_streaming':'completed',origin:{kind:'human'}});
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);
  if(m.type==='control_request'){
    if(m.request.subtype==='get_context_usage')return frame({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{totalTokens:100,maxTokens:200000,percentage:0.05}}});
    success(m.request_id);if(m.request.subtype==='interrupt')finish(true);return;
  }
  if(m.type==='control_response'){finish();return;}
  if(m.type!=='user')return;
  const text=m.message.content.map(x=>x.text||'').join('');
  if(process.env.CLAUDE_HUB_LATE_ECHO_RECEIPTS) require('node:fs').appendFileSync(process.env.CLAUDE_HUB_LATE_ECHO_RECEIPTS,JSON.stringify({uuid:m.uuid,sessionId:id})+'\n');
  if(text.includes('fixture:late-echo') && (!process.env.CLAUDE_HUB_LATE_ECHO_RECEIPTS || require('node:fs').readFileSync(process.env.CLAUDE_HUB_LATE_ECHO_RECEIPTS,'utf8').trim().split('\n').length===1)){
    setTimeout(()=>{
      frame(m);
      const messageId=randomUUID();
      for(const content of [[{type:'thinking',thinking:'first thought'}],[{type:'thinking',thinking:'second thought'}],[{type:'text',text:'STATUS_DONE'}]])
        frame({type:'assistant',uuid:randomUUID(),message:{id:messageId,role:'assistant',stop_reason:'end_turn',content}});
      finish();
    },15700);return;
  }
  frame(m);
  if(text==='SILENT')return;
  if(text==='RUNNING'){
    // The engine starts an assistant message, with no output text at all.
    frame({type:'stream_event',event:{type:'message_start',message:{id:randomUUID(),role:'assistant',content:[]}}});
    frame({type:'assistant',uuid:randomUUID(),message:{id:randomUUID(),role:'assistant',content:[{type:'tool_use',id:'unfinished-tool',name:'Read',input:{file_path:'fixture.txt'}}]}});return;
  }
  if(text==='WAIT'){frame({type:'control_request',request_id:'approval',request:{subtype:'can_use_tool',tool_name:'Read',tool_use_id:'r',input:{file_path:'fixture.txt'}}});return;}
  if(text==='CRASH'){setTimeout(()=>process.exit(9),100);return;}
  finish();
});
