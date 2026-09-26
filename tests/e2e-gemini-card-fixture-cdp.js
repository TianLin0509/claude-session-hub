'use strict';
// Isolated UI with a native-format history fixture and a local idle CLI stub.
// This verifies rendering, not Gemini authentication or cloud behavior.
const fs=require('fs'),path=require('path'),os=require('os'),net=require('net'),crypto=require('crypto');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher'),{connectFirstPage}=require('./helpers/cdp-client');
const j=JSON.stringify,sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gemini-cards-')),data=path.join(root,'data'),bin=path.join(root,'bin'),cwd=path.join(root,'work');
 for(const d of [data,bin,cwd])fs.mkdirSync(d);const sid=crypto.randomUUID(),hubId='gemini-card-fixture',file=path.join(root,'native.jsonl');
 fs.writeFileSync(file,[{sessionId:sid},{id:'u',type:'user',content:[{text:'请显示 Gemini 历史卡片'}]},
  {id:'a',type:'gemini',content:'GEMINI_CARD_OK 中文🙂',tokens:{total:10}}].map(j).join('\n')+'\n');
 fs.writeFileSync(path.join(bin,'idle.js'),"process.stdout.write('Gemini fixture ready\\r\\n');process.stdin.resume();setInterval(()=>{},60000);");
 fs.writeFileSync(path.join(bin,'gemini.cmd'),'@echo off\r\n"'+process.execPath+'" "'+path.join(bin,'idle.js')+'"\r\n');
 fs.writeFileSync(path.join(data,'state.json'),j({version:1,cleanShutdown:true,meetings:[],sessions:[{hubId,title:'Gemini 历史验收',kind:'gemini',cwd,geminiChatId:sid,transcriptPath:file,savedAt:Date.now(),schemaVersion:1}]}));
 const out=path.resolve('artifacts/gemini-card-fixture/'+Date.now());fs.mkdirSync(out,{recursive:true});let hub,c;const result={root,out,passed:false};
 try{
  const port=await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
  hub=await launchIsolatedHub({dataDir:data,port,extraEnv:{PATH:bin+path.delimiter+process.env.PATH,CLAUDE_HUB_HOME_DIR:path.join(root,'home')}});c=await connectFirstPage(hub);
  const until=async(expr)=>{const end=Date.now()+60000;while(Date.now()<end){if(await c.eval(expr))return;await sleep(200);}throw new Error('timeout '+expr);};
  await until(`!!document.querySelector('.session-item[data-session-id="${hubId}"]')`);
  await c.eval(`document.querySelector('.session-item[data-session-id="${hubId}"]').click()`);
  await until(`activeSessionId===${j(hubId)}`);await c.eval(`applyViewMode('card')`);
  await until(`Array.from(document.querySelectorAll('#msg-overlay .turn-card.assistant')).some(e=>e.textContent.includes('GEMINI_CARD_OK'))`);
  result.passed=true;
 }catch(error){result.error=error.stack;process.exitCode=1;}
 finally{if(c){fs.writeFileSync(path.join(out,'cards.png'),Buffer.from((await c.send('Page.captureScreenshot',{format:'png'})).data,'base64'));await c.close();}if(hub)await gracefulQuit(hub);fs.writeFileSync(path.join(out,'result.json'),j(result));console.log(j(result));}
})().catch(e=>{console.error(e);process.exitCode=1});
