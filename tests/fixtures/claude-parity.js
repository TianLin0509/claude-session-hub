'use strict';
const {randomUUID}=require('node:crypto');
const arg=name=>{const index=process.argv.indexOf(name);return index<0?undefined:process.argv[index+1];};
const sessionId=process.argv.includes('--session-id')?arg('--session-id'):arg('--resume')||randomUUID();
let active,questionTimer,stopTimer;
const questions=new Set(),answers=[];
const frame=value=>new Promise(resolve=>process.stdout.write(JSON.stringify({session_id:sessionId,...value})+'\n',resolve));
const success=(id,response={})=>frame({type:'control_response',response:{subtype:'success',request_id:id,response}});
async function result(text,interrupted=false) {
  await frame({type:'assistant',uuid:randomUUID(),parent_tool_use_id:null,message:{id:randomUUID(),role:'assistant',stop_reason:'end_turn',content:[{type:'text',text}]}});
  await frame({type:'result',subtype:'success',is_error:false,uuid:randomUUID(),result:text,terminal_reason:interrupted?'aborted_streaming':'completed',origin:{kind:'human'}});
}
function question(id,text) {return frame({type:'control_request',request_id:id,request:{subtype:'can_use_tool',tool_name:'AskUserQuestion',tool_use_id:id,
  input:{questions:[{question:text,options:[{label:'保留全部记录',description:'测试选项'},{label:'继续检查',description:'测试选项'}]}]}}});}
const rl=require('node:readline').createInterface({input:process.stdin});
rl.on('line',async line=>{
  const message=JSON.parse(line);
  if(message.type==='control_request') {
    const type=message.request.subtype;
    if(type==='initialize')return success(message.request_id,{fast_mode_state:'off',current_permission_mode:'default'});
    if(type==='get_context_usage')return success(message.request_id,{totalTokens:12500,maxTokens:950000,rawMaxTokens:1000000,percentage:1.3});
    await success(message.request_id);
    if(type==='interrupt') {
      active=null;clearTimeout(questionTimer);questions.clear();
      stopTimer=setTimeout(()=>result('原生已确认中断',true),650);
    }
    return;
  }
  if(message.type==='control_response') {
    if(!questions.delete(message.response.request_id))return;
    answers.push(message.response.response?.updatedInput?.answers);
    if(!questions.size)await result('收到回答 '+JSON.stringify(answers));
    return;
  }
  if(message.type!=='user')return;
  active=message;await frame(message);
  const text=message.message.content.filter(block=>block.type==='text').map(block=>block.text).join('');
  if(text==='QUESTIONS') {
    questions.add('first');questions.add('second');answers.length=0;
    await question('first','先决定如何保存');
    questionTimer=setTimeout(()=>question('second','再决定下一步'),2000);return;
  }
  if(text==='HEAVY') {
    for(let i=0;i<10;i++) {
      if(active!==message)return;
      const id='tool-'+i;
      await frame({type:'assistant',uuid:randomUUID(),message:{id:randomUUID(),role:'assistant',stop_reason:'tool_use',
        content:[{type:'tool_use',id,name:'Read',input:{file_path:'fixture-'+i+'.txt'}}]}});
      await frame({type:'user',uuid:randomUUID(),message:{role:'user',content:[{type:'tool_result',tool_use_id:id,content:'x'.repeat(800000)+'FULL-END-'+i}]}});
    }
  }
  const id=randomUUID();let body='';
  await frame({type:'stream_event',event:{type:'message_start',message:{id,role:'assistant',content:[]}}});
  await frame({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'text',text:''}}});
  for(let i=0;i<160;i++) {
    if(active!==message)return;
    const text='Claude 输出 '+i+' 🧪\n';body+=text;
    await frame({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text}}});
    await new Promise(resolve=>setTimeout(resolve,45));
  }
  if(active!==message)return;
  await frame({type:'assistant',uuid:randomUUID(),message:{id,role:'assistant',model:'claude-opus-5[1m]',
    usage:{input_tokens:100,cache_read_input_tokens:12400,output_tokens:500},
    stop_reason:'end_turn',content:[{type:'text',text:body}]}});
  await frame({type:'result',subtype:'success',is_error:false,uuid:randomUUID(),result:body,terminal_reason:'completed',origin:{kind:'human'},
    usage:{input_tokens:1000,cache_read_input_tokens:99000,output_tokens:500},duration_ms:7800,
    modelUsage:{'claude-opus-5[1m]':{contextWindow:1000000}}});
});
rl.on('close',()=>{active=null;clearTimeout(questionTimer);clearTimeout(stopTimer);});
