'use strict';
const {captureConversationMessages}=require('./conversation-capture');
// The content collector outlives a dispatch watcher: a file handoff may end
// that watcher while its original App Server turn continues producing items.
function createGroupConversationCollector() {
  const seen=new WeakMap();
  return function collect({native,orch,sid}) {
    const attempts=Object.values(orch.state.attempts || {}).filter(a=>a.sid===sid
      && a.providerThreadId===native.threadId && a.providerTurnId);
    const signature=`${native.contentRevision}:${native.runtime.revision}:${attempts.length}`;
    if(seen.get(native)===signature)return false;
    let changed=false;
    for(const a of attempts) {
      const stored=orch.state.displayMessagesByAttempt?.[a.attemptId];
      if(a.providerTurnId!==native.runtime.turnId && stored?.some(m=>m.phase==='final_answer'))continue;
      const messages=captureConversationMessages({native,providerTurnId:a.providerTurnId,clientSubmissionId:a.attemptId});
      changed=orch.recordDisplayMessages(a.attemptId,messages) || changed;
    }
    seen.set(native,signature);
    return changed;
  };
}
module.exports={createGroupConversationCollector};
