'use strict';
const {preview}=require('./acp-tool-preview');
const cached=new WeakMap();
function compactClaudeTools(cards,{hubSessionId,threadId}) {
  return cards.map(card=>!card.toolCalls?.length?card:{...card,toolCalls:card.toolCalls.map(tool=>{
    const key=tool.input && typeof tool.input==='object'?tool.input:null;
    let compact=key && cached.get(key);
    if(!compact || compact.fullOutput!==tool.output) {
      const input={};
      for(const name of ['command','file_path','path','pattern','query','url','target_path','destination','new_path','description']) {
        if(typeof tool.input?.[name]==='string')input[name]=tool.input[name].slice(0,512);
      }
      compact={input,output:tool.output==null?'':preview(tool.output).text,fullOutput:tool.output};
      if(key)cached.set(key,compact);
    }
    return {...tool,input:compact.input,output:compact.output,resultTruncated:tool.output!=null,
      resultRef:{source:'claude-stream-json',hubSessionId,threadId,userMessageId:card.userMessageId,itemId:tool.id}};
  })});
}
function readClaudeToolResult(session,reference) {
  if(reference.threadId!==session.sessionId)throw Error('工具详情不属于当前 Claude 会话');
  const record=[...session.records.values(),...session.activities.records.values()].find(record=>record.userMessageId===reference.userMessageId);
  for(const frame of record?.messages?.values() || []) {
    const result=frame.message?.content?.find(block=>block.type==='tool_result' && block.tool_use_id===reference.itemId);
    if(result)return typeof result.content==='string'?result.content:JSON.stringify(result.content ?? '',null,2);
  }
  throw Error('未找到完整 Claude 工具来源，请重新载入会话');
}
module.exports={compactClaudeTools,readClaudeToolResult};
