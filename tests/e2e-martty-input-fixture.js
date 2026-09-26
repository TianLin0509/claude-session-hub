'use strict';
// Real Windows TUI + local ACP fixture; no cloud request or credentials.
const fs=require('fs'),os=require('os'),path=require('path'),pty=require('node-pty'),assert=require('node:assert/strict');
const {encodeMarttyPrompt,writeMarttyPrompt}=require('../core/martty-prompt-input');
const {computeSettleMs,waitForPasteSettled}=require('../core/pty-prompt-submit');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'martty-input-')),trace=path.join(root,'trace.jsonl');
 const executable=process.env.HUB_MARTTY_EXE||'C:/AIWork/20260911-acp-tools-codex1/node_modules/martty/vendor/win32-x64/martty.exe';
 const p=pty.spawn(executable,['--agent',process.execPath,'--agent-arg',path.resolve(__dirname,'fixtures/acp-agent.js'),'--workspace',root],
  {cwd:root,env:{...process.env,MARTTY_HOME:root,HUB_RESTART_ACP_TRACE:trace},cols:100,rows:30,useConpty:true});
 let output='';p.onData(d=>output+=d);
 const records=()=>fs.existsSync(trace)?fs.readFileSync(trace,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
 try{
  let deadline=Date.now()+30000;while(Date.now()<deadline&&!records().some(x=>x.method==='session/new'))await sleep(100);
  assert(records().some(x=>x.method==='session/new'),'native session ready');await sleep(1000);
  const text=Array.from({length:120},(_,i)=>`reference ${i}: 中文🙂 `+'x'.repeat(100)).join('\n');
  const encoded=encodeMarttyPrompt(text);await writeMarttyPrompt(data=>p.write(data),encoded.payload);
  await waitForPasteSettled({settleMs:computeSettleMs(encoded.payload.length)});
  assert.equal(records().filter(x=>x.method==='session/prompt').length,0,'draft must not submit');
  p.write('\x1b[13;28;13;1;0;1_\x1b[13;28;13;0;0;1_');deadline=Date.now()+60000;while(Date.now()<deadline&&!records().some(x=>x.method==='session/prompt'))await sleep(100);
  const prompts=records().filter(x=>x.method==='session/prompt');assert.equal(prompts.length,1);assert.equal(prompts[0].params.prompt[0].text,text);
  console.log(JSON.stringify({passed:true,lines:120,exactUnicodeAndNewlines:true,root}));
 }finally{fs.writeFileSync(path.join(root,'screen.txt'),output);p.kill();}
})().catch(e=>{console.error(e);process.exitCode=1});
