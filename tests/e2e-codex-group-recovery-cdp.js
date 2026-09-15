'use strict';
// Real isolated Hub + real group dispatch and buttons; only the provider child
// is a deterministic protocol fixture. No renderer/runtime state injection.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),j=JSON.stringify;
(async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-codex-group-recovery-'));
  const out=path.resolve('artifacts/codex-group-recovery/'+Date.now());fs.mkdirSync(out,{recursive:true});
  const trace=path.join(root,'trace.jsonl'),report={out,checks:[],passed:false};let hub,c;
  const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const n=server.address().port;server.close(()=>resolve(n));});});
  const until=async(label,fn)=>{const deadline=Date.now()+90000;while(!await fn()){if(Date.now()>deadline)throw Error('timeout '+label);await sleep(75);}};
  const invoke=(name,args={})=>c.eval(`ipcRenderer.invoke(${j(name)},${j(args)})`);
  const shot=async name=>{const result=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(result.data,'base64'));};
  try {
    hub=await launchIsolatedHub({dataDir:path.join(root,'data'),port,windowMode:'hidden',label:'codex-group-recovery',extraEnv:{
      CLAUDE_HUB_E2E:'1',CODEX_HOME:path.join(root,'codex'),
      CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.resolve('tests/fixtures/codex-app-server.js'),
      CLAUDE_HUB_NATIVE_FIXTURE_TRACE:trace}});
    c=await connectFirstPage(hub);await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await until('renderer',()=>c.eval('!!window.MeetingRoom'));
    const meeting=await invoke('create-meeting',{scene:'general',groupChat:true,title:'Codex 原生群聊恢复',workspace:root,
      slots:[{kind:'codex',memberId:'m1',model:'gpt-5.4',mcpProfile:'none'}]});
    const id=meeting.id,sid=meeting.subSessions[0];report.meetingId=id;
    await invoke('update-meeting-sync',{meetingId:id,fields:{serialWorkflow:{enabled:true,steps:[['m1']],stepConfigs:[],loop:{enabled:false}}}});
    const fresh=(await invoke('get-meetings')).find(m=>m.id===id);
    await c.eval(`window.MeetingRoom.openMeeting(${j(id)},${j(fresh)})`);
    await until('composer',()=>c.eval('!!document.querySelector("#mr-input-box")'));
    await c.eval('document.querySelector("#mr-input-box").focus()');await c.send('Input.insertText',{text:'fixture:no-ack 完成本轮任务。'});
    await c.eval('document.querySelector("#mr-send-btn").click()');
    await until('workflow paused',async()=>{const result=await invoke('loop:status',{meetingId:id});return result.serialRunState?.status==='paused';});
    const sends=()=>fs.readFileSync(trace,'utf8').trim().split('\n').map(JSON.parse).filter(r=>r.method==='turn/start');
    assert.equal(sends().length,1);report.checks.push('missing Codex ACK pauses serial workflow after exactly one native dispatch');
    await until('reconciliation button',()=>c.eval(`!!document.querySelector('[data-gc-open-session="${sid}"]')`));
    await c.eval(`document.querySelector('[data-gc-open-session="${sid}"]').click()`);
    await until('native reconciliation control',()=>c.eval(`activeSessionId===${j(sid)} && [...document.querySelectorAll('.codex-native-controls button')].some(b=>b.innerText==='核对原生记录')`));
    await c.eval(`(()=>{const b=[...document.querySelectorAll('.codex-native-controls button')].find(b=>b.innerText==='核对原生记录');b.click();})()`);
    await until('exact submission recovered',()=>c.eval(`sessions.get(${j(sid)}).nativeRuntime.submission?.status==='accepted'`));
    await c.eval(`window.MeetingRoom.openMeeting(${j(id)},${j(fresh)})`);
    await until('completed native result sync button',()=>c.eval(`!!document.querySelector('[data-gc-sync-answer="${sid}"]') && document.body.innerText.includes('原生已完成')`));
    await shot('ready-to-sync');
    await c.eval(`document.querySelector('[data-gc-sync-answer="${sid}"]').click()`);
    await until('exact native result collected',async()=>{const state=await invoke('groupchat:get-state',{meetingId:id});return state.messages.some(m=>m.sid===sid&&m.status==='manual_extracted'&&m.content==='原生回答 ✅');});
    assert.equal(sends().length,1);report.checks.push('real native Reconcile and group Sync collect the exact answer without replay');
    await shot('synced');report.passed=true;
  } catch(error){report.error=error.stack;throw error;}
  finally {if(hub)fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));if(c)await c.close();if(hub)report.exit=await gracefulQuit(hub);fs.writeFileSync(path.join(out,'result.json'),j(report));console.log(j(report));}
})().catch(error=>{console.error(error);process.exitCode=1;});
