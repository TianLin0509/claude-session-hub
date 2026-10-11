'use strict';
// Real isolated Hub + native-format fixture. This does not claim Google login or cloud success.
const fs=require('fs'),path=require('path'),os=require('os'),net=require('net'),crypto=require('crypto'),assert=require('assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher'),{connectFirstPage}=require('./helpers/cdp-client');
const j=JSON.stringify,sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'antigravity-cards-')),data=path.join(root,'data'),bin=path.join(root,'bin'),cwd=path.join(root,'work'),home=path.join(root,'home');
 for(const d of [data,bin,cwd,home])fs.mkdirSync(d);
 const sid=crypto.randomUUID(),hubId='antigravity-card-fixture',file=path.join(home,'.gemini','antigravity-cli','brain',sid,'.system_generated','logs','transcript.jsonl');
 fs.mkdirSync(path.dirname(file),{recursive:true});
 fs.writeFileSync(file,[{step_index:0,type:'USER_INPUT',source:'USER_EXPLICIT',content:'<USER_REQUEST>显示 Antigravity 历史卡片</USER_REQUEST>'},
 {step_index:1,type:'PLANNER_RESPONSE',source:'MODEL',status:'DONE',content:'ANTIGRAVITY_CARD_OK 中文🙂'}].map(j).join('\n')+'\n');
 fs.writeFileSync(path.join(bin,'idle.js'),"if(process.argv.includes('models')){console.log('gemini-3.1-pro-high  Gemini 3.1 Pro (High)');process.exit(0);}process.stdout.write('Antigravity fixture Type your message\\r\\n');process.stdin.resume();setInterval(()=>{},60000);");
 const cli=path.join(bin,'agy.cmd');fs.writeFileSync(cli,'@echo off\r\n"'+process.execPath+'" "'+path.join(bin,'idle.js')+'" %*\r\n');
 fs.writeFileSync(path.join(data,'state.json'),j({version:1,cleanShutdown:true,meetings:[],sessions:[{hubId,title:'Antigravity 历史验收',kind:'gemini',cwd,geminiChatId:sid,geminiProjectHash:'antigravity',geminiProjectRoot:cwd,transcriptPath:file,savedAt:Date.now(),schemaVersion:1}]}));
 const out=path.resolve('artifacts/20261011-antigravity-codex/ui-'+Date.now());fs.mkdirSync(out,{recursive:true});let hub,c;const result={root,out,passed:false};
 try{
  const port=await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
  hub=await launchIsolatedHub({dataDir:data,port,extraEnv:{AI_HUB_ANTIGRAVITY_COMMAND:cli,CLAUDE_HUB_HOME_DIR:home}});c=await connectFirstPage(hub);
  const until=async(expr)=>{const end=Date.now()+45000;while(Date.now()<end){if(await c.eval(expr))return;await sleep(200);}throw Error('timeout '+expr);};
  await until(`!!document.querySelector('.session-item[data-session-id="${hubId}"]')`);
  assert.match(await c.eval(`document.querySelector('.new-session-option[data-kind="gemini"]').textContent`),/Antigravity CLI/);
  await c.eval(`document.querySelector('.session-item[data-session-id="${hubId}"]').click()`);
  await until(`activeSessionId===${j(hubId)}`);await c.eval(`applyViewMode('card')`);
  await until(`Array.from(document.querySelectorAll('#msg-overlay .turn-card.assistant')).some(e=>e.textContent.includes('ANTIGRAVITY_CARD_OK'))`);
  const created=await c.eval(`ipcRenderer.invoke('create-session',{kind:'gemini',opts:{cwd:${j(cwd)},model:'gemini-3.1-pro-high'}})`);
  assert.equal(created.geminiProjectHash,'antigravity');
  const liveSid=crypto.randomUUID(),liveFile=file.replace(sid,liveSid);
  fs.mkdirSync(path.dirname(liveFile),{recursive:true});
  fs.writeFileSync(liveFile,[{step_index:0,type:'USER_INPUT',source:'USER_EXPLICIT',created_at:new Date().toISOString(),content:'fixture live question'},
   {step_index:1,type:'PLANNER_RESPONSE',source:'MODEL',status:'DONE',created_at:new Date().toISOString(),content:'ANTIGRAVITY_LIVE_FIXTURE_OK'}].map(j).join('\n')+'\n');
  const event={hubSessionId:created.id,conversationId:liveSid,transcriptPath:liveFile,workspacePaths:[cwd],observedAt:Date.now(),modelName:'gemini-3.1-pro-high'};
  const events=path.join(data,'antigravity-events',created.id+'.jsonl');
  fs.appendFileSync(events,[{...event,event:'PreInvocation',invocationNum:1},{...event,event:'Stop',executionNum:1,fullyIdle:true,terminationReason:'model_stop'}].map(j).join('\n')+'\n');
  await until(`sessions.get(${j(created.id)})?.geminiChatId===${j(liveSid)}`);
  assert.ok(fs.existsSync(path.join(data,'antigravity-events','native-'+liveSid+'.json')));
  result.liveBinding={hubSessionId:created.id,conversationId:liveSid,verified:true};
  result.passed=true;
 }catch(error){result.error=error.stack;process.exitCode=1;}
 finally{
  if(c){try{fs.writeFileSync(path.join(out,'cards.png'),Buffer.from((await c.send('Page.captureScreenshot',{format:'png'})).data,'base64'));}finally{await c.close();}}
  if(hub)await gracefulQuit(hub);fs.writeFileSync(path.join(out,'evidence.json'),j(result));console.log(j(result));
 }
})().catch(e=>{console.error(e);process.exitCode=1});
