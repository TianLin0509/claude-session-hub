'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),j=JSON.stringify;
(async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-mixed-supplement-'));
  const out=path.resolve('artifacts/mixed-group-supplement/'+Date.now());fs.mkdirSync(out,{recursive:true});
  const trace=path.join(root,'trace.jsonl'),report={out,checks:[],passed:false};let hub,c;
  const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const n=server.address().port;server.close(()=>resolve(n));});});
  const until=async(label,fn)=>{const deadline=Date.now()+30000;while(!await fn()){if(Date.now()>deadline)throw Error('timeout '+label);await sleep(75);}};
  const invoke=(name,args={})=>c.eval(`ipcRenderer.invoke(${j(name)},${j(args)})`);
  try {
    hub=await launchIsolatedHub({dataDir:path.join(root,'data'),port,windowMode:'hidden',label:'mixed-group-supplement',extraEnv:{
      CLAUDE_HUB_E2E:'1',CODEX_HOME:path.join(root,'codex'),CLAUDE_CONFIG_DIR:path.join(root,'claude'),
      CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.resolve('tests/fixtures/codex-app-server.js'),
      CLAUDE_HUB_CLAUDE_STREAM_FIXTURE:path.resolve('tests/fixtures/claude-stream.js'),CLAUDE_HUB_CLAUDE_FIXTURE_MODE:'hold',
      CLAUDE_HUB_NATIVE_FIXTURE_TRACE:trace}});
    c=await connectFirstPage(hub);await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await until('renderer',()=>c.eval('!!window.MeetingRoom'));
    const meeting=await invoke('create-meeting',{scene:'general',groupChat:true,title:'混合群聊插话语义',workspace:root,
      slots:[{kind:'claude',memberId:'m1',model:'claude-opus-5[1m]',mcpProfile:'none'},
        {kind:'codex',memberId:'m2',model:'gpt-5.4',mcpProfile:'none'}]});
    const id=meeting.id;report.meetingId=id;
    await invoke('update-meeting-sync',{meetingId:id,fields:{serialWorkflow:{enabled:true,steps:[['m1','m2']],stepConfigs:[],loop:{enabled:false}}}});
    const fresh=(await invoke('get-meetings')).find(m=>m.id===id);
    await c.eval(`window.MeetingRoom.openMeeting(${j(id)},${j(fresh)})`);
    await until('composer',()=>c.eval('!!document.querySelector("#mr-input-box")'));
    const send=async text=>{await c.eval('document.querySelector("#mr-input-box").focus()');await c.send('Input.insertText',{text});await c.eval('document.querySelector("#mr-send-btn").click()');};
    await send('fixture:hold 请两位持续执行当前任务。');
    await until('both member prompts accepted',()=>c.eval(`${j(meeting.subSessions)}.every(sid=>['accepted','ok'].includes(sessions.get(sid)?.nativeRuntime?.submission?.status || sessions.get(sid)?.nativeRuntime?.submission?.sendStatus))`));
    await send('补充要求：保留完整结果，不要重新开始。');
    await until('truthful mixed supplement notice',()=>c.eval(`document.body.innerText.includes('1 位已排队，当前任务结束后处理') && document.body.innerText.includes('1 位已确认收到')`));
    const requests=fs.readFileSync(trace,'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(requests.filter(r=>r.method==='turn/start').length,1);
    assert.equal(requests.filter(r=>r.method==='turn/steer').length,1);
    assert.equal(await c.eval(`sessions.get(${j(meeting.subSessions[0])}).nativeRuntime.queued.length`),1);
    report.checks.push('real group composer shows Claude queued and Codex immediate receipt separately');
    report.checks.push('one Codex turn/start plus one turn/steer; Claude keeps one queued supplement');
    const shot=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'mixed-supplement.png'),Buffer.from(shot.data,'base64'));
    report.passed=true;
  } catch(error){report.error=error.stack;if(c)report.ui=await c.eval('({notice:document.querySelector("#mr-gc-soft-alert-banner")?.outerHTML,text:document.body.innerText.slice(-2500)})');throw error;}
  finally {if(hub)fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));if(c)await c.close();if(hub)report.exit=await gracefulQuit(hub);fs.writeFileSync(path.join(out,'result.json'),j(report));console.log(j(report));}
})().catch(error=>{console.error(error);process.exitCode=1;});
