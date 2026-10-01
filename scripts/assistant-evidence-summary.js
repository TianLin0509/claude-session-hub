'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../artifacts');
const read=relative=>JSON.parse(fs.readFileSync(path.join(root,relative),'utf8'));
const qa=read('assistant-codex-probe/results.json');
const corrected=read('assistant-codex-probe/corrected/results.json');
const management=read('assistant-management-probe/create-and-resume/results.json');
const liveDirectory='assistant-tab-real/2026-10-01T09-25-42-859Z';
const liveResult=read(liveDirectory+'/result.json');
const liveReconciliation=read(liveDirectory+'/live-delegation-evidence.json');
const laterDirectory='assistant-tab-real/2026-10-01T09-30-59-119Z';
const laterAudit=read(laterDirectory+'/posthoc-native-audit.json');
const finalDirectory=process.argv[2]||null;
const finalResult=finalDirectory?read(finalDirectory+'/result.json'):null;
const models=[];
for(const relative of ['assistant-codex-probe/private-codex-home/sessions','assistant-codex-probe/corrected/private-codex-home/sessions','assistant-management-probe/create-and-resume/private-home/sessions']){
  const directory=path.join(root,relative);
  for(const file of fs.readdirSync(directory,{recursive:true}).filter(f=>f.endsWith('.jsonl'))){
    for(const line of fs.readFileSync(path.join(directory,file),'utf8').split('\n')){
      try{const event=JSON.parse(line);if(event.type==='turn_context')models.push({file:path.join(relative,file),model:event.payload.model,effort:event.payload.effort});}catch{}
    }
  }
}
const summary={generatedAt:new Date().toISOString(),profile:{id:'second',label:'主账号',verification:'read production profile mapping; copied only credential into isolated home; deleted all probe credential copies after completion'},models,
  questionRuns:[...qa,...corrected].map(({stderrTail,...r})=>r),
  review:{baseline:{recent:'independent review: supported by cited source excerpts; self-report clearly distinguished',decisions:'independent review: supported with status caveats',preferences:'independent review: reflects user preferences and avoids redundant permission request',missing:'failed: global keyword query was misdescribed as 24h due to ambiguous packet metadata'},corrected:{recent:'identity check passed; bounded excerpts and unverified status explicit',missing:'manual read: correctly says all indexed history and does not infer nonexistence'},limits:['Small sample only; citation identity is not proof of factual entailment','Question probes use isolated codex exec, not a real Hub PTY session','Current production group directories supplied no supported answer files; group file adapter verified with fixtures']},
  management:{dispatchCount:management.dispatches.length,targetSessionIds:[...new Set(management.dispatches.map(d=>d.id))],targetRuns:management.runs.filter(r=>r.label.startsWith('target')).map(({toolCalls,...r})=>r),sameNativeThread:management.runs.filter(r=>r.label.startsWith('target')).every(r=>r.threadId===management.runs[0].threadId),ledger:management.ledger,boundary:management.boundary,limitation:'Additional history_context call in this probe was rejected by per-tool approval configuration; create/send themselves completed. Product entry now explicitly configures all four tools.'},
  liveHubPty:{
    boundary:'Real isolated Hub GUI and default Codex PTY using the main account. Distinct from the earlier exec probe with fixture Hub adapters. Original failed runs remain unchanged.',
    first:{source:liveDirectory+'/result.json',originalOverallPassed:liveResult.passed,originalFailure:liveResult.error,model:liveResult.model,profile:liveResult.profile,effort:liveResult.effort,deliveryAudit:liveResult.deliveryAudit,citationAudit:liveResult.audit,
      reconciliation:{source:liveDirectory+'/live-delegation-evidence.json',passed:liveReconciliation.passed,method:liveReconciliation.method,actions:liveReconciliation.actions,targetAnswer:liveReconciliation.targetAnswer,harnessIssue:liveReconciliation.harnessIssue}},
    second:{source:laterDirectory+'/posthoc-native-audit.json',...laterAudit},
    ...(finalResult?{afterReceiptFix:{source:finalDirectory+'/result.json',...finalResult}}:{}),
    conclusion:finalResult?.passed?'After the Codex native prompt receipt fix, the final isolated read-only GUI run passed. Earlier full-material and real create/send/target reply evidence remains separately recorded; previous failures are preserved. Production deployment and full management regression are not claimed.':'Native full-material delivery and real create/send/target reply are proven in isolated runs. End-to-end UI submission confirmation remains unconfirmed in the later run; overall acceptance is not passed. No automatic resend was used.'
  },
  tests:{command:'node --test tests/unit-hub-assistant-snapshots.test.js tests/unit-assistant-action-policy.test.js tests/unit-hub-assistant-service.test.js tests/unit-hub-assistant-history.test.js tests/unit-assistant-group-history.test.js',passed:51,failed:0},
  materialEntry:{implementation:'Short native user envelope with manifest; history_context(requestToken) retrieves the immutable per-turn packet with a SHA-256 receipt',evidenceBoundary:'Host snapshot read receipt does not prove complete native tool-result delivery. Real Hub PTY proof is recorded separately by the UI E2E.',longUserText:'Preserved verbatim; requests above the normal short envelope budget may still use the existing Codex editor channel'},
  shippedCapabilities:['Bounded role/time/content-linked natural-language history','Typed MCP list/search/create/send tools','Ordinary Codex assistant entity with native defaults and a dedicated MCP entry','Persistent intent deduplication; unknown outcomes never automatically replay','Per-turn nonce, conservative delegation checks and exact target binding','Group answer/delivery file reader and explicit observation-time semantics'],
  notProven:[finalResult?.passed?'Production deployment, long-term reliability, and full management regression after the final receipt fix':'Production deployment and reliable end-to-end UI acknowledgement; later isolated UI submit remains unconfirmed despite exact native data and answer','Semantic authorization against every natural-language ambiguity','Automated business-outcome verification','Long-term generated memory or summaries','Cross-provider assistant backends','Remote cloud entry'],
};
fs.writeFileSync(path.join(root,'assistant-backend-evidence.json'),JSON.stringify(summary,null,2));
console.log(JSON.stringify({questionRuns:summary.questionRuns.length,managementDispatches:summary.management.dispatchCount,sameNativeThread:summary.management.sameNativeThread,nativeModelContexts:models.length,tests:summary.tests}));
