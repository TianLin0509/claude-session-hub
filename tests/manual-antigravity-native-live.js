'use strict';
// Explicit live check: uses the user's official Google subscription and installed agy.
// Never included in the unit runner. All Hub receipts use a dedicated temp directory.
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict');
const {execFile}=require('child_process');
const {promisify}=require('util');
const cfg=require('../core/antigravity-config'),{AntigravityTap}=require('../core/antigravity-tap');
(async()=>{
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-antigravity-live-')),id='antigravity-live-check';
 const env={...process.env,CLAUDE_HUB_DATA_DIR:dataDir};
 const installed=cfg.installHooks(env,dataDir,id),tap=new AntigravityTap(),events=[];
 for(const name of ['session-bound','turn-complete','turn-error','prompt-submitted'])tap.on(name,e=>events.push({name,...e}));
 const cwd=path.join(os.tmpdir(),'20261011-antigravity-install-codex');
 tap.registerSession(id,{cwd,registeredAt:Date.now(),antigravityEventsFile:installed.eventsFile});
 let result;
 try{
  const run=await promisify(execFile)(cfg.resolveCommand(env),['-p','Reply exactly AGY_HUB_OK. Do not call any tools.','--model','gemini-3.8-flash-medium','--output-format','json','--print-timeout','60s'],{cwd,env,windowsHide:true,timeout:90000,maxBuffer:1024*1024});
  const response=JSON.parse(run.stdout);assert.equal(response.status,'SUCCESS');assert.equal(response.response.trim(),'AGY_HUB_OK');
  const end=Date.now()+8000;while(!events.some(e=>e.name==='turn-complete')&&Date.now()<end)await new Promise(r=>setTimeout(r,200));
  assert.ok(events.some(e=>e.name==='session-bound'&&e.geminiChatId===response.conversation_id),'native hook must bind the same conversation');
  assert.equal(events.find(e=>e.name==='turn-complete')?.text,'AGY_HUB_OK','only official Stop evidence completes the turn');
  result={ok:true,dataDir,conversationId:response.conversation_id,response:response.response.trim(),eventNames:events.map(e=>e.name),usage:response.usage};
 }catch(error){result={ok:false,dataDir,error:error.message,eventNames:events.map(e=>e.name)};process.exitCode=1;}
 finally{tap.unregisterSession(id);fs.writeFileSync(path.join(dataDir,'20261011-antigravity-live-evidence.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));}
})().catch(e=>{console.error(e.message);process.exitCode=1});
