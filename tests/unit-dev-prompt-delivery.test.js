'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {EventEmitter}=require('node:events');
const gc=require('../core/group-chat-orchestrator'),watcher=require('../core/group-chat-watcher');
const {createGroupChatDispatcher}=require('../main/groupchat/dispatcher');
async function run(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dev-prompt-delivery-')),sent=[];
 const meeting={id:path.basename(root),groupChat:true,scene:'dev',workspace:root,subSessions:['a','b'],slotSpecs:[{memberId:'qa'},{memberId:'writer'}],participants:[1],serialWorkflow:{fileFlowVersion:2,steps:[['writer'],['qa']]}};
 const sessions={a:{id:'a',kind:'claude',title:'审查甲',status:'idle'},b:{id:'b',kind:'claude',title:'开发乙',status:'idle'}};
 const tap=new EventEmitter();Object.assign(tap,{clearLastTokens(){},getLastTokens(){},getStreamingText(){return ''},clearStreamingBuf(){}});
 let accept=false;const original=watcher.sendToPty;
 watcher.sendToPty=async(sid,prompt)=>{sent.push({sid,prompt});return accept?{ok:true,sendStatus:'ok',acknowledgementSource:'test-semantic'}:{ok:false,reason:'fixture rejection'};};
 const dispatcher=createGroupChatDispatcher({getHubDataDir:()=>root,groupchat:gc,transcriptTap:tap,cliReadyDetector:{},isCodexBaseKind:()=>false,
  kindLabels:{claude:'Claude'},logger:{log(){},warn(){}},maybeAutoTitleMeetingFromPrompt(){},meetingManager:{getMeeting:()=>meeting},sendToRenderer(){},
  sessionManager:{getSession:sid=>sessions[sid],getSessionBuffer:()=>'',getGroupChatLastActivity:()=>0,getGroupChatReady:()=>true,setGroupChatReady(){},clearStreamingBuf(){}}});
 const orch=gc.getOrchestrator(root,meeting.id);
 async function send(input,id='writer'){
  const pending=dispatcher.dispatchGroupChatTurn(meeting.id,{userInput:input,targetMemberIds:[id]});
  if(accept){const sid=id==='writer'?'b':'a';let active;for(let i=0;i<100;i++){active=dispatcher.getActiveWatchers().get(sid);if(active&&!active.isSettled())break;await new Promise(r=>setTimeout(r,5));}
   assert(active&&!active.isSettled(),'real dispatcher installed watcher');active.manualExtract('已完成本次受控回答');}
  return pending;
 }
 try{
  await send('第一次');assert(!orch.state.devFilePromptReceipts?.b,'failed send does not consume first protocol');
  accept=true;await send('再发');assert(sent.at(-1).prompt.includes('## AI HUB 文件工作流'));assert(orch.state.devFilePromptReceipts.b);
  await send('继续');assert(!sent.at(-1).prompt.includes('## AI HUB 文件工作流'));assert(!sent.at(-1).prompt.includes('本阶段草稿'));
  await send('独立检查','qa');assert(sent.at(-1).prompt.includes('## AI HUB 文件工作流'),'each Agent gets its own first protocol');
  sessions.b.title='开发丙';await send('新名字');assert(sent.at(-1).prompt.includes('开发丙 负责开题与实现'));
  const disk=JSON.parse(fs.readFileSync(path.join(root,'arena-prompts',meeting.id+'-groupchat.json'),'utf8'));assert(disk.devFilePromptReceipts.b);
  console.log('dev prompt delivery: real dispatcher failure, per-Agent first receipt, ordinary delta, rename and persistence passed');
 }finally{watcher.sendToPty=original;dispatcher.interruptMeetingTurn(meeting.id);fs.rmSync(root,{recursive:true,force:true});}
}
run().catch(e=>{console.error(e);process.exitCode=1});
