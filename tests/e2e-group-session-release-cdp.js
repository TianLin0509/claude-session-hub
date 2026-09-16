'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),net=require('net'),assert=require('assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const j=JSON.stringify,delay=ms=>new Promise(r=>setTimeout(r,ms));
const freePort=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
async function until(label,fn){const end=Date.now()+30000;while(!await fn()){if(Date.now()>end)throw Error('Timeout '+label);await delay(100);}}
async function click(c,selector){const rect=await c.eval(`(()=>{const e=document.querySelector(${j(selector)});if(!e)throw Error('Missing button');const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);for(const type of ['mousePressed','mouseReleased'])await c.send('Input.dispatchMouseEvent',{type,...rect,button:'left',clickCount:1});}
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-group-release-')),out=path.resolve('artifacts/group-session-release/'+Date.now());fs.mkdirSync(out,{recursive:true});
 const dataDir=path.join(root,'data'),workspace=path.join(root,'workspace');fs.mkdirSync(workspace);
 const env={CLAUDE_HUB_E2E:'1',CODEX_HOME:path.join(root,'codex'),CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.resolve('tests/fixtures/codex-app-server.js'),CLAUDE_HUB_NATIVE_FIXTURE_STORE:path.join(root,'threads.json'),CLAUDE_HUB_NATIVE_FIXTURE_WRITER_DIR:path.join(root,'writers')};
 const hubs=[],clients=[],report={passed:false,checks:[],root};
 const invoke=(c,name,args)=>c.eval(`ipcRenderer.invoke(${j(name)},${j(args)})`);
 async function launch(label){const hub=await launchIsolatedHub({dataDir,port:await freePort(),label,windowMode:'hidden',extraEnv:env});hubs.push(hub);const c=await connectFirstPage(hub);clients.push(c);await until('renderer',()=>c.eval('typeof window.openMeetingMemberSession==="function"'));return {hub,c};}
 try {
  const a=await launch('group-release-a');
  const meeting=await invoke(a.c,'create-meeting',{scene:'general',groupChat:true,title:'群聊成员跨 Hub 休眠恢复',workspace,slots:[1,2].map(i=>({kind:'codex',memberId:'m'+i,model:'gpt-6-astra',effort:'xhigh',mcpProfile:'none'}))});
  const [peer,sid]=meeting.subSessions;report.meetingId=meeting.id;
  await until('members connected',()=>a.c.eval(`${j(meeting.subSessions)}.every(id=>sessions.get(id)?.nativeRuntime?.connection==='connected')`));
  await a.c.eval(`window.openMeetingMemberSession(${j(sid)})`);
  await until('member input',()=>a.c.eval(`activeSessionId===${j(sid)} && !!document.querySelector('.floating-input-box')`));
  await click(a.c,'.floating-input-box');await a.c.send('Input.insertText',{text:'群聊成员休眠恢复测试'});await click(a.c,'.floating-input-send');
  await until('member completed',()=>a.c.eval(`sessions.get(${j(sid)})?.nativeRuntime?.state==='completed'`));
  const before=await a.c.eval(`sessions.get(${j(sid)})`);report.threadId=before.codexSid;
  const b=await launch('group-release-b');
  await click(a.c,'.btn-close-session');
  await until('member dormant',()=>a.c.eval(`sessions.get(${j(sid)})?.status==='dormant'`));
  const pid=JSON.parse(fs.readFileSync(path.join(root,'writers',before.codexSid+'.json'),'utf8')).pid;
  assert.throws(()=>process.kill(pid,0),/ESRCH|no such process/);
  assert.equal(await a.c.eval(`sessions.get(${j(peer)})?.nativeRuntime?.connection`),'connected');
  report.checks.push('sleeping Codex 2 exits its writer while Codex 1 remains connected in the old Hub');
  await b.c.eval(`window.openMeetingMemberSession(${j(sid)})`);
  await until('same group member resumes',()=>b.c.eval(`sessions.get(${j(sid)})?.nativeRuntime?.connection==='connected'`));
  const after=await b.c.eval(`sessions.get(${j(sid)})`);assert.equal(after.codexSid,before.codexSid);assert.equal(after.meetingId,meeting.id);
  const history=await invoke(b.c,'parse-session-transcript',{hubSessionId:sid});assert(JSON.stringify(history).includes('原生回答'));
  assert(a.hub.isAlive());report.checks.push('another Hub resumes the same member and native thread with history and group membership preserved');
  const shot=await b.c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'group-member-resumed.png'),Buffer.from(shot.data,'base64'));report.passed=true;
 }catch(error){report.error=error.stack;process.exitCode=1;}
 finally{for(const c of clients)await c.close();for(const hub of hubs.reverse()){await gracefulQuit(hub);fs.writeFileSync(path.join(out,hub.label+'.log'),hub.log().join('\n'));}fs.writeFileSync(path.join(out,'result.json'),j(report));console.log(j({out,...report}));}
})();
