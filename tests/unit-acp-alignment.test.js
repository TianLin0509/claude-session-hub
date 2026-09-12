'use strict';
const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const {AcpSession}=require('../core/acp-session');
const {acpModelOptions,deepseekReasoningEfforts}=require('../core/acp-model-catalog');
const {composerThinkingChip}=require('../core/session-status-summary');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-acp-alignment-'));
const options={id:'bypass',kind:'qwen',cwd:root,profileId:'fixture',model:'fixture',storeDir:root,
  defaultMode:'yolo',permissionPolicy:'bypass',launch:{command:process.execPath,args:[path.join(__dirname,'fixtures/acp-agent.js')],cwd:root,env:process.env}};
async function main(){
  assert.equal(acpModelOptions('qwen').length,5);
  assert.equal(acpModelOptions('qwen','qwen-future').at(-1).id,'qwen-future');
  assert.deepEqual(Object.keys(deepseekReasoningEfforts('deepseek-v4-pro')),['high','max']);
  assert.deepEqual(Object.keys(deepseekReasoningEfforts('deepseek-v4-pro-0813')),['low','high','max']);
  const s={kind:'glm',runtimeBackend:'acp',acpConfigOptions:[{id:'thought',category:'thought_level',type:'select',currentValue:'nothink',options:[{value:'nothink',name:'关闭'},{value:'max',name:'最高'}]}]};
  assert.deepEqual(composerThinkingChip(s),{visible:true,label:'关闭',interactive:true,options:['nothink','max']});
  assert.equal(composerThinkingChip({...s,acpConfigOptions:[]}).visible,false,'missing native capability must not invent tiers');
  let session=new AcpSession(options);
  try {
    await session.start();
    await session.configure({configId:'mode',value:'default'});
    session.kill();
    session=new AcpSession({...options,resumeId:'fixture-session'});
    await session.start();
    assert.equal(session.configOptions.find(o=>o.id==='mode').currentValue,'yolo','resume upgrades old restricted mode to explicit full access');
    const states=[];session.on('state',runtime=>states.push(runtime.state));
    await session.send('permission');await session.idle(2000);
    assert(!states.includes('waiting'),'automatic approvals must never flash a user approval form');
    assert.match(session.finalText(),/yes/);assert.equal(session.runtime.requests.length,0);
    await session.send('question');
    assert.equal(session.runtime.requests[0].method,'elicitation/create');
    await session.reply(session.runtime.requests[0].id,{action:'accept',content:{color:'blue'}},session.runtime.epoch);
    await session.idle(2000);
    await session.send('qwen-question');
    if (!session.runtime.requests.length) await new Promise(resolve => {
      const listener = runtime => { if (runtime.requests.length) { session.off('state',listener); resolve(); } };
      session.on('state',listener);
    });
    assert(session.runtime.requests[0].params.toolCall._meta.qwenQuestions);
    await assert.rejects(session.reply(session.runtime.requests[0].id,{outcome:{outcome:'selected',optionId:'yes'}},session.runtime.epoch),/每个问题/);
    await session.reply(session.runtime.requests[0].id,{outcome:{outcome:'selected',optionId:'yes'},answers:{'0':'a.txt'}},session.runtime.epoch);
    await session.idle(2000);
    await session.send('cancel');await session.interrupt();await session.idle(2000);
    assert.equal(session.runtime.state,'interrupted');
  }finally{session.kill();}
  // A stop arriving while the response is queued must revoke auto-approval.
  const queued=new AcpSession(options);queued.threadId='queue';queued.active={accepted:true,turnId:'turn'};
  let response;
  queued.client={respond:async(_id,value,_error,guard)=>{queued.active.cancelling=true;response=guard(value);}};
  await queued.request({id:10,method:'session/request_permission',params:{sessionId:'queue',options:[{optionId:'allow',kind:'allow_once'}]}});
  assert.equal(response.outcome.outcome,'cancelled');
  console.log('ACP alignment: bypass/resume, real questions, cancellation fence, model catalogs and native-only effort controls PASS');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
