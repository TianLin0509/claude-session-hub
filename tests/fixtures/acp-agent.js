'use strict';
const readline = require('readline');
const sessionId = 'fixture-session';
let requestId = 1000, pendingPrompt;
const output = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const result = (id, value) => output({ id, result: value });
const update = value => output({ method: 'session/update', params: { sessionId, update: value } });
const model=process.argv.includes('--model')?process.argv[process.argv.indexOf('--model')+1]:'fixture';
const configs = [{ id: 'model', category: 'model', type: 'select', currentValue: model, options: [{ value: model, name: model }] }];
configs.push({id:'mode',category:'mode',type:'select',currentValue:'yolo',options:['default','plan','yolo'].map(value=>({value,name:value}))});
if (process.env.HUB_ACP_UI_FIXTURE === '1') {
  const kind=process.env.DSH_MODEL ? 'deepseek-acp' : process.env.ZCODE_MODEL ? 'glm' : 'qwen';
  const current=process.env.DSH_MODEL || process.env.ZCODE_MODEL || model;
  configs[0].currentValue=current;
  configs[0].options=require('../../core/acp-model-catalog').acpModelOptions(kind,current).map(o=>({value:o.id,name:o.id}));
  configs[1].options.push({value:'danger-full-access',name:'Full access'});
  configs.push({id:'effort',category:'thought_level',type:'select',currentValue:'high',options:['low','high','max'].map(value=>({value,name:value}))});
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line), p = m.params || {};
  if (m.method === 'initialize') return result(m.id, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
  if (m.method === 'authenticate') return result(m.id, {});
  if (['session/new', 'session/load'].includes(m.method)) return result(m.id, { sessionId, configOptions: configs });
  if (m.method === 'session/set_config_option') {
    configs.find(o=>o.id===p.configId).currentValue=p.value;
    update({sessionUpdate:'config_option_update',configOptions:configs});
    return result(m.id, { configOptions: configs });
  }
  if (m.method === 'session/prompt') {
    const text = p.prompt[0].text;
    if (text.startsWith('PERF_RUN_')) {
      let index=0;
      const timer=setInterval(()=>{
        update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'EVENT:'+Date.now()+':'+index+'; 中文\n'}});
        if(++index===60){clearInterval(timer);result(m.id,{stopReason:'end_turn'});}
      },20);
      return;
    }
    if (text === 'reject') return output({ id: m.id, error: { code: -32602, message: 'fixture rejected' } });
    if (['auth-401','rate-429','quota-402','server-500'].includes(text)) return output({id:m.id,error:{code:-32000,message:text+' provider failure'}});
    if (text === 'break-json') return process.stdout.write('not-json\n');
    if (text === 'silent') { pendingPrompt = m.id; return; }
    if (text === 'question') {
      pendingPrompt = m.id;
      return output({ id: requestId++, method: 'elicitation/create', params: { sessionId, mode:'form',
        message:'请选择颜色', requestedSchema:{type:'object',properties:{color:{type:'string',enum:['red','blue']}},required:['color']} } });
    }
    update({ sessionUpdate: 'agent_message_chunk', messageId: 'msg', content: { type: 'text', text: '中文🧪 ' } });
    update({ sessionUpdate: 'agent_thought_chunk', messageId: 'msg', content: { type: 'text', text: 'separate thought' } });
    if (text === 'permission' || text === 'qwen-question') {
      pendingPrompt = m.id;
      return output({ id: requestId++, method: 'session/request_permission', params: { sessionId,
        toolCall: { toolCallId: 'read', title: 'Read fixture', ...(text === 'qwen-question' ? {_meta:{qwenQuestions:[{question:'选择文件名'}]}} : {}) }, options: [
          { optionId: 'yes', name: '允许本次', kind: 'allow_once' }, { optionId: 'no', name: '拒绝', kind: 'reject_once' }] } });
    }
    if (text === 'cancel') { pendingPrompt = m.id; return; }
    update({ sessionUpdate: 'tool_call', toolCallId: 'read', title: 'Read', kind: 'read', status: 'in_progress' });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'read', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'file contents' } }] });
    update({ sessionUpdate: 'agent_message_chunk', messageId: 'msg', content: { type: 'text', text } });
    return result(m.id, { stopReason: 'end_turn' });
  }
  if (m.method === 'session/cancel') {
    if (pendingPrompt != null) result(pendingPrompt, { stopReason: 'cancelled' });
    pendingPrompt = null;
    return;
  }
  if (m.id >= 1000 && m.result && pendingPrompt != null) {
    update({ sessionUpdate: 'agent_message_chunk', messageId: 'decision', content: { type: 'text', text: m.result.content?.color || m.result.outcome?.optionId || 'cancelled' } });
    result(pendingPrompt, { stopReason: 'end_turn' });
    pendingPrompt = null;
  }
});
