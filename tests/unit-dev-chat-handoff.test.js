'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {EventEmitter}=require('node:events');
const gc=require('../core/group-chat-orchestrator');
const watcher=require('../core/group-chat-watcher');
const paste=require('../core/paste-trapped-detector');
const {createGroupChatDispatcher}=require('../main/groupchat/dispatcher');
const {createHistoryReader}=require('../core/dev-chat-history');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<150;i++){if(fn())return;await sleep(20);}assert.ok(fn(),'condition timed out');}
test('real dispatcher: cross-seat handoff, same-seat queue, late final and stop',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dev-handoff-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const meeting={id:'m',scene:'dev',groupChat:true,serialWorkflow:{fileFlowVersion:2},subSessions:['s1','s2'],
    slotSpecs:[{kind:'gemini',memberId:'m1'},{kind:'gemini',memberId:'m2'}],participants:[0,1]};
  const tap=new EventEmitter();Object.assign(tap,{clearLastTokens(){},getLastTokens(){return null;},getStreamingText(){return[];},clearStreamingBuf(){},extractLatestTurn:async()=>({text:''})});
  const sent=[];
  watcher.sendToPty=async(sid,prompt)=>{sent.push({sid,prompt});return {ok:true,sendStatus:'ok'};};
  watcher.extractStreamingText=()=>({text:'',blocks:[],source:'placeholder'});watcher.cleanBufLen=()=>0;watcher.checkHostShellTakeover=()=>false;
  paste.start=()=>{};paste.tick=()=>'ok';paste.stop=()=>{};
  const dispatcher=createGroupChatDispatcher({getHubDataDir:()=>root,groupchat:gc,transcriptTap:tap,
    cliReadyDetector:{},isCodexBaseKind:()=>false,kindLabels:{gemini:'Gemini'},logger:{log(){},warn(){}},
    maybeAutoTitleMeetingFromPrompt(){},meetingManager:{getMeeting:()=>meeting},sendToRenderer(){},
    sessionManager:{getSession:sid=>({id:sid,kind:'gemini',status:'active',title:sid}),getSessionBuffer:()=>'',getGroupChatLastActivity:()=>0,getGroupChatReady:()=>true,setGroupChatReady(){},clearStreamingBuf(){}}});
  t.after(()=>dispatcher.interruptMeetingTurn('m'));
  const orch=gc.getOrchestrator(root,'m');
  const first=dispatcher.dispatchGroupChatTurn('m',{userInput:'one',targetMemberIds:['m1']});
  await until(()=>dispatcher.getActiveWatchers().has('s1'));
  const old=Object.values(orch.state.devChatHistory.receipts)[0];
  // The source reader has its own protocol identity, independent of mock PTY.
  const reader=createHistoryReader({orch,sid:'s1',kind:'codex',sourcePath:'fixture',speaker:'s1'});
  let offset=0;const row=p=>reader.record({type:'event_msg',timestamp:new Date().toISOString(),payload:p},{startOffset:offset++});
  row({type:'task_started',turn_id:'old'});row({type:'user_message',message:sent[0].prompt});
  row({type:'item_completed',turn_id:'old',item:{id:'p',type:'AgentMessage',phase:'commentary',text:'old progress'}});
  const second=dispatcher.dispatchGroupChatTurn('m',{userInput:'two',targetMemberIds:['m2'],fileHandoff:true});
  const result=await first;assert.equal(result.results[0].status,'handed_off');
  await until(()=>dispatcher.getActiveWatchers().has('s2'));
  assert.equal(sent.length,2,'another seat proceeds before old final');
  tap.emit('turn-complete',{hubSessionId:'s2',text:'two final',signalSource:'task_complete'});await second;
  const waiting=dispatcher.dispatchGroupChatTurn('m',{userInput:'three',targetMemberIds:['m1'],fileHandoff:true});
  await sleep(150);assert.equal(sent.length,2,'same seat waits for provider end');
  dispatcher.interruptMeetingTurn('m');
  assert.equal((await waiting).status,'error','stop also cancels a stage waiting before send');
  row({type:'item_completed',turn_id:'old',item:{id:'f',type:'AgentMessage',phase:'final_answer',text:'old final'}});
  await sleep(150);assert.equal(sent.length,2,'late final cannot resume a stopped dispatch');
  const third=dispatcher.dispatchGroupChatTurn('m',{userInput:'three',targetMemberIds:['m1'],fileHandoff:true});
  await until(()=>sent.length===3);
  assert.equal(orch.state.messages.find(m=>m.id==='a1-m1').content,'old final');
  assert.equal(orch.state.messages.filter(m=>m.sourceMessage && m.attemptId===old.attemptId).length,2);
  dispatcher.interruptMeetingTurn('m');const stopped=await third;assert.equal(stopped.results[0].status,'interrupted');
});
