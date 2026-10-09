'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const R=require('../renderer/conversation-relay');
const meeting={slotSpecs:['claude','codex','gemini','kimi'].map((kind,i)=>({memberId:`m${i+1}`,kind})),subSessions:['s1','s2','s3','s4'],serialWorkflow:{steps:[['m1'],['m1','m2','m3'],['m4']]}};
const run={runId:'current',nextStepIndex:1,currentTurnNum:8,status:'paused',lastError:{reason:'submission_unknown'}};
const attempt=(id,sid,step=1,workflow='current')=>({attemptId:id,sid,turnNum:8,createdAt:10,workflowRun:{runId:workflow,stepIndex:step},status:'submission_unknown'});
const full='用户问题\n补充要求\n上一位的完整回答\n写入回答文件：D:\\工作\\回答.md';
const state={attempts:{a:attempt('a','s1'),b:attempt('b','s2'),old:attempt('old','s3',0)},pendingPrompts:{8:{s1:{attemptId:'a',workflowRun:{runId:'current'},prompt:full},s3:{attemptId:'old',workflowRun:{runId:'current'},prompt:'错轮'}}},messages:[{role:'assistant',sid:'s2',turnNum:8,attemptId:'b',sourcePrompt:'Codex 完整输入'},{role:'assistant',sid:'s3',turnNum:8,attemptId:'old',sourcePrompt:'旧轮输入'}]};
const targets=R.targets(meeting,run,state);
assert.deepEqual(targets.map(m=>m.sid),['s1','s2','s3']);
assert.equal(targets[0].prompt,full);assert.equal(targets[1].prompt,'Codex 完整输入');assert.equal(targets[2].prompt,'');
assert.equal(R.presentation(run,targets,['a','b','c']).resume,false);
assert.match(R.presentation(run,targets,[]).label,/待确认/);
assert.equal(R.targets(meeting,{...run,runId:'other'},state).every(m=>!m.prompt),true,'another question cannot reuse an old prompt');
assert.equal(R.targets(meeting,{...run,currentTurnNum:9},state).every(m=>!m.prompt),true,'another turn cannot reuse an old prompt');
assert.equal(R.targets(meeting,{...run,nextStepIndex:0,currentTurnNum:null},state)[0].prompt,'','repeated member must not borrow next-step input');
const wrongPending=structuredClone(state);wrongPending.pendingPrompts[8].s1.attemptId='wrong';
assert.equal(R.targets(meeting,run,wrongPending)[0].prompt,'','pending prompt must match the precise attempt');
assert.equal(R.targets(meeting,{status:'unavailable'},{}).length,1,'missing state still permits inspection without guessing a prompt');
assert.equal(R.presentation({...run,lastError:null},[],[]).resume,true,'explicit pause keeps the existing resume');
assert.equal(R.presentation({...run,lastError:{reason:'interrupted'}},[],[]).resume,true);
assert.equal(R.presentation({...run,lastError:{reason:'network_interrupted'}},[],[]).resume,false,'abnormal pause does not invite a retry by default');
assert.match(R.presentation({running:true},[{label:'Claude',stale:true}],[]).label,/状态可能过期/);
assert.equal(R.targets(meeting,{...run,nextStepIndex:3,currentTurnNum:null},state).length,0,'completed flow does not pick an earlier member');

// The explicit CLI bridge must select the native view for every provider and
// reject dormant/missing writers rather than implicitly restarting them.
const source=fs.readFileSync(require.resolve('../renderer/renderer.js'),'utf8');
const bridge=/window\.openMeetingMemberCli = async function openMeetingMemberCli\(sessionId\) \{[\s\S]+?\n\};/.exec(source)[0];
(async()=>{
  for(const kind of ['claude','codex','gemini','kimi']){
    const session={kind,status:'running'},calls=[],context={window:{},sessions:new Map([['sid',session]]),activeSessionId:null,selectSession:async(id,opts)=>{calls.push({id,opts});context.activeSessionId=id;}};
    vm.runInNewContext(bridge,context);assert.equal((await context.window.openMeetingMemberCli('sid')).ok,true);assert.deepEqual(JSON.parse(JSON.stringify(calls)),[{id:'sid',opts:{forceScrollBottom:true,inspectOnly:true,splitBypass:true}}]);
    session.status='dormant';assert.equal((await context.window.openMeetingMemberCli('sid')).ok,false);assert.equal(calls.length,1);assert.equal((await context.window.openMeetingMemberCli('missing')).ok,false);
  }
  console.log('PASS: exact archived prompt binding, uncertain/paused/stale states and read-only CLI for four providers');
})().catch(error=>{console.error(error);process.exitCode=1;});
