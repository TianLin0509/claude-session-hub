'use strict';
// Opt-in live model smoke: real Antigravity terminal tool -> authenticated Hub bridge;
// member dispatch is controlled so this probe never contacts production sessions.
const fs=require('fs'),path=require('path'),os=require('os');
const {spawn}=require('child_process');
const {createOrchestrationService}=require('../main/orchestration/service');
const {resolveCommand,cliEnv}=require('../core/antigravity-config');
const DEFAULT_MODEL=process.env.ORCH_LIVE_MODEL || 'gemini-3.8-flash-low';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-star-live-'));
const artifact=path.resolve(__dirname,'../artifacts/20261022-star-cli-live-codex1.json');
const m={id:'probe',groupChat:true,subSessions:['lead','worker'],slotSpecs:[{memberId:'m1'},{memberId:'m2'}],orchestration:{enabled:true,sessionId:'lead',memberId:'m1',settings:{coordination:'star'}}};
const dispatches=[];
const svc=createOrchestrationService({meetingManager:{getMeeting:()=>m,getAllMeetings:()=>[m]},sessionManager:{getSession:id=>({id,kind:'gemini',status:'idle'}),isAgentTurnActive:()=>false},getHubDataDir:()=>dir,getMembers:()=>m.subSessions.map((sid,i)=>({sid,memberId:'m'+(i+1),displayName:sid,kind:'gemini'})),getDispatcher:()=>({dispatchGroupChatTurn:async(id,a)=>{dispatches.push({to:a.targetMemberIds,text:a.userInput});return {status:'completed'};}}),getDeliveryEngine:()=>({}),logger:console});
(async()=>{
 await svc.start();svc.userMessage('probe',{text:'验证星型编排通用终端工具'});
 const argsFile=path.join(dir,'send.json');fs.writeFileSync(argsFile,JSON.stringify({to:'m2',message:'STAR_LIVE_OK'}));
 const command=require('../core/orchestration/connection').commandFile(dir,'lead');
 const prompt=`This is an authorized local tool smoke test. Run this exact PowerShell command with your terminal tool, then report its JSON result. Do not read or edit other files. & '${command.replace(/'/g,"''")}' --tool orch_send_message --args-file '${argsFile.replace(/'/g,"''")}'`;
 let stdout='',stderr='';
 try {
  const result=await new Promise((resolve,reject)=>{const p=spawn(resolveCommand(),['--dangerously-skip-permissions','--model',DEFAULT_MODEL,'--output-format','json','-p',prompt],{cwd:dir,env:cliEnv(),windowsHide:true,stdio:['ignore','pipe','pipe']});p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);p.on('error',reject);const timeout=setTimeout(()=>{p.kill();reject(Error('live model timeout'));},240000);p.on('close',code=>{clearTimeout(timeout);resolve(code);});});
  await new Promise(r=>setTimeout(r,500));
  const ok=result===0&&dispatches.some(d=>d.to.includes('m2')&&d.text.includes('STAR_LIVE_OK'));
  fs.writeFileSync(artifact,JSON.stringify({ok,model:DEFAULT_MODEL,realModel:true,memberDispatch:'controlled',exitCode:result,dispatches,stdout,stderr},null,2));
  console.log(JSON.stringify({ok,model:DEFAULT_MODEL,dispatches:dispatches.length,artifact}));if(!ok)process.exitCode=1;
 }finally{svc.stop();}
})().catch(e=>{console.error(e.message);svc.stop();process.exitCode=1;});
