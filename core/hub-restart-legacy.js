'use strict';
const {promptFingerprint}=require('./prompt-submission-receipts');
const {nativeSessionIdentity}=require('./session-capabilities');
const sources=new Set(['kimi_wire_turn_prompt','gemini_user_message','user_message','item_completed_user_message']);

// Event-driven evidence, scoped to this Hub's live provider bindings. Terminal
// repaint or a historical transcript replay is never proof of new work.
function createRestartLegacyTracker(tap,sm,now=Date.now()) {
  const states=new Map();
  tap.on('prompt-submitted',event=>{
    const s=sm.getSession(event.hubSessionId);
    if(!s || s.nativeRuntime || !sources.has(event.signalSource) || !Number.isFinite(Number(event.submittedAt)) || Number(event.submittedAt)<now)return;
    states.set(s.id,{state:'working',at:Number(event.submittedAt),identity:nativeSessionIdentity(s)?.value});
  });
  tap.on('turn-complete',event=>{
    const value=states.get(event.hubSessionId);
    if(!value || Number(event.completedAt)<value.at)return;
    value.state=['idle_timer_5s'].includes(event.signalSource) ? 'unknown' : 'idle';
  });
  tap.on('turn-started',event=>{
    const s=sm.getSession(event.hubSessionId);
    if(!s || s.nativeRuntime || event.signalSource!=='task_started' || !(Number(event.startedAt)>=now))return;
    states.set(s.id,{state:'working',at:Number(event.startedAt),identity:nativeSessionIdentity(s)?.value});
  });
  for(const eventName of ['turn-aborted','turn-error'])tap.on(eventName,event=>{
    const value=states.get(event.hubSessionId);if(value)value.state='unknown';
  });
  return {state(s){const value=states.get(s.id);return value?.identity===nativeSessionIdentity(s)?.value ? value.state : null;}};
}

function observeLegacyPrompt(tap,sessionId,text,timeoutMs=15000) {
  const fingerprint=promptFingerprint(text),startedAt=Date.now();let settle,timer,confirmed=false;
  const promise=new Promise(resolve=>{settle=resolve;});
  const finish=value=>{clearTimeout(timer);tap.off('prompt-submitted',onPrompt);settle(value);};
  const onPrompt=event=>{
    if(event.hubSessionId===sessionId && sources.has(event.signalSource) && Number(event.submittedAt)>=startedAt
      && promptFingerprint(event.text)===fingerprint){confirmed=true;finish({ok:true,sendStatus:'ok',acknowledgementSource:event.signalSource});}
  };
  tap.on('prompt-submitted',onPrompt);
  timer=setTimeout(()=>finish({ok:false,sendStatus:'unknown',message:'续作未获原生历史确认，请核对会话，未自动重发'}),timeoutMs);
  return {promise,get confirmed(){return confirmed;},async wait(ms){
    let timer;try{return await Promise.race([promise,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),ms);})]);}finally{clearTimeout(timer);}
  },dispose:()=>finish({ok:false,sendStatus:'unknown'})};
}

async function waitChildExit(child,timeoutMs=15000) {
  if(!child || child.exitCode!=null || child.signalCode!=null)return;
  await new Promise((resolve,reject)=>{
    const done=()=>{clearTimeout(timer);resolve();};
    const timer=setTimeout(()=>{child.off('exit',done);reject(new Error('原生 Agent 进程尚未确认退出，取消重启'));},timeoutMs);
    child.once('exit',done);
  });
}
module.exports={createRestartLegacyTracker,observeLegacyPrompt,waitChildExit};
