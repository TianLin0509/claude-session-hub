'use strict';
// Real stdio fault injection. No model or credentials. Every accepted answer
// writes a real file so Stop assertions measure effects, not just button state.
const fs = require('node:fs');
const path = require('node:path');
const sessionId = 'cancel-race';
let turn, nextRequest = 900;
const requests = new Map();
const emit = value => process.stdout.write(JSON.stringify({ jsonrpc:'2.0', ...value }) + '\n');
const result = (id, value) => emit({ id, result:value });
const update = text => emit({ method:'session/update', params:{sessionId, update:{
  sessionUpdate:'agent_message_chunk', content:{type:'text', text},
}} });
const configs = [{id:'model',category:'model',type:'select',currentValue:'qwen3.8-max',
  options:[{value:'qwen3.8-max',name:'qwen3.8-max'}]},
{id:'mode',category:'mode',type:'select',currentValue:'default',options:[{value:'default',name:'default'}]}];
function ask(method) {
  const id = nextRequest++;
  requests.set(id, {turn, method});
  emit({id, method, params:{sessionId, ...(method === 'elicitation/create'
    ? {mode:'form',message:'Late question during cancellation',requestedSchema:{type:'object',properties:{answer:{type:'string'}},required:['answer']}}
    : {toolCall:{toolCallId:'late-write',title:'Late permission during cancellation'},options:[{optionId:'allow',kind:'allow_once',name:'Allow'}]})}});
}
function finish(value) {
  if (value.finishing || value.text === 'no-confirmation') return;
  value.finishing = true;
  setTimeout(() => result(value.id, {stopReason:value.cancelled ? 'cancelled' : 'end_turn'}),
    Number(process.env.ACP_CANCEL_FIXTURE_HOLD_MS) || 0);
}
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return result(m.id,{protocolVersion:1,agentCapabilities:{loadSession:true}});
  if (m.method === 'authenticate') return result(m.id,{});
  if (['session/new','session/load'].includes(m.method)) return result(m.id,{sessionId,configOptions:configs});
  if (m.method === 'session/set_config_option') return result(m.id,{configOptions:configs});
  if (m.method === 'session/prompt') {
    turn = {id:m.id,text:m.params.prompt[0].text};
    if (turn.text === 'next') {update('NEXT_TURN');return finish(turn);}
    if (turn.text !== 'prefill') update('started');
    if (turn.text.startsWith('queued-')) ask(turn.text === 'queued-question' ? 'elicitation/create' : 'session/request_permission');
    return;
  }
  if (m.method === 'session/cancel') {
    if (!turn || turn.finishing) return;
    turn.cancelled = true;
    update(' cancellation tail');
    if (!turn.text.startsWith('queued-')) {
      ask('session/request_permission');
      ask('elicitation/create');
    } else if (![...requests.values()].some(q => q.turn === turn)) finish(turn);
    return;
  }
  const q = requests.get(m.id);
  if (q && m.result) {
    requests.delete(m.id);
    if (m.result.outcome?.outcome === 'cancelled' || m.result.action === 'cancel') q.turn.cancelled = true;
    fs.appendFileSync(path.join(process.cwd(),'responses.jsonl'),JSON.stringify({id:m.id,method:q.method,result:m.result})+'\n');
    if (m.result.outcome?.optionId === 'allow' || m.result.action === 'accept') {
      fs.writeFileSync(path.join(process.cwd(),'side-effect.txt'),'WRITTEN_AFTER_CANCEL');
    }
    if (![...requests.values()].some(other => other.turn === q.turn)) finish(q.turn);
  }
});
