'use strict';
const {displayUserText}=require('./synthetic-user-filter');
const {TERMINAL,BACKEND}=require('./codex-native-runtime');
// Content presentation never changes execution state. IDs come from the same
// native thread/turn/items used for live delivery and survive renderer reload.
function nativeTranscriptTurns(threadId, turns) {
  const cards=[];
  for(const turn of turns) {
    const ts=turn.startedAt ? turn.startedAt*1000 : turn.hubStartedAt || null;
    const tsEnd=turn.completedAt ? turn.completedAt*1000 : turn.hubCompletedAt || ts;
    const items=turn.items || [];
    for(const item of items.filter(i=>i.type==='userMessage')) {
      const raw=(item.content || []).map(i=>i.type==='text'?i.text:i.type==='localImage'?i.path:i.type==='image'?i.url:'').filter(Boolean).join('\n');
      const text=displayUserText(raw);
      if(text)cards.push({id:threadId+':'+item.id,role:'user',text,ts,source:BACKEND,clientSubmissionId:item.clientId});
    }
    const messages=items.filter(i=>i.type==='agentMessage');
    const finals=messages.filter(i=>i.phase==='final_answer' || !i.phase);
    const text=(TERMINAL.has(turn.status) && finals.length ? finals : messages).map(i=>i.text || '').join('\n\n');
    const tools=items.filter(i=>!['userMessage','agentMessage','reasoning'].includes(i.type)).map(i=>({
      id:i.id,callId:i.id,name:i.type,input:i,output:i.aggregatedOutput || i.result || null,
      status:(!i.status || i.status==='inProgress') ? (TERMINAL.has(turn.status)?'unknown':'running') : i.status,
      startedAt:ts,...(i.status==='completed'?{completedAt:tsEnd}:{}),
    }));
    const thinking=items.filter(i=>i.type==='reasoning').flatMap(i=>i.summary || []).map(x=>typeof x==='string'?x:x.text || '').join('\n');
    if(text || tools.length || thinking || TERMINAL.has(turn.status))cards.push({id:threadId+':'+turn.id+':assistant',
      role:'assistant',kind:'codex',text,ts,tsEnd,thinking,toolCalls:tools,source:BACKEND,
      stopReason:turn.status,nativeOutcome:TERMINAL.has(turn.status)?turn.status:null,
      durationMs:ts && tsEnd ? tsEnd-ts : undefined});
  }
  return cards;
}
module.exports={nativeTranscriptTurns};
