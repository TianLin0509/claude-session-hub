'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),j=JSON.stringify;
(async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-late-echo-')),out=path.resolve('artifacts/claude-late-echo/'+Date.now());
  fs.mkdirSync(out,{recursive:true});const receipts=path.join(root,'receipts.jsonl');
  const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
  let hub,c,id;const report={out,checks:[],passed:false};
  const invoke=(name,args={})=>c.eval(`ipcRenderer.invoke(${j(name)},${j(args)})`);
  const until=async(label,fn)=>{const end=Date.now()+require('../core/native-confirmation-policy').NATIVE_CONFIRMATION_MS+30000;while(Date.now()<end){if(await fn())return;await sleep(60);}throw Error('timeout '+label);};
  async function click(selector){await until(selector,()=>c.eval(`!!document.querySelector(${j(selector)})`));
    const p=await c.eval(`(()=>{const e=document.querySelector(${j(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();if(!r.height)throw Error('hidden control');return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    for(const type of ['mousePressed','mouseReleased'])await c.send('Input.dispatchMouseEvent',{type,...p,button:'left',clickCount:1});}
  try {
    hub=await launchIsolatedHub({dataDir:path.join(root,'data'),port,label:'claude-late-echo',extraEnv:{CLAUDE_HUB_E2E:'1',
      CLAUDE_CONFIG_DIR:path.join(root,'claude'),CODEX_HOME:path.join(root,'codex'),
      CLAUDE_HUB_CLAUDE_STREAM_FIXTURE:path.resolve('tests/fixtures/claude-backstage-status.js'),CLAUDE_HUB_LATE_ECHO_RECEIPTS:receipts}});
    c=await connectFirstPage(hub);await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await until('renderer',()=>c.eval('!!window.MeetingRoom'));
    const meeting=await invoke('create-meeting',{scene:'general',groupChat:true,title:'Claude 晚到确认串行验证',workspace:root,
      slots:[0,1].map(index=>({kind:'claude',memberId:'m'+(index+1),model:'claude-opus-5[1m]',mcpProfile:'none'}))});
    id=meeting.id;report.meetingId=id;const sid=meeting.subSessions[0];
    await invoke('update-meeting-sync',{meetingId:id,fields:{serialWorkflow:{enabled:true,steps:[['m1'],['m2']],stepConfigs:[],loop:{enabled:false}}}});
    const fresh=(await invoke('get-meetings')).find(m=>m.id===id);
    await c.eval(`window.MeetingRoom.openMeeting(${j(id)},${j(fresh)})`);
    await click('#mr-input-box');await c.send('Input.insertText',{text:'fixture:late-echo 请按顺序完成任务。'});await click('#mr-send-btn');
    await until('workflow paused',async()=>{const status=await invoke('loop:status',{meetingId:id});return status.serialRunState?.status==='paused';});
    report.checks.push('real serial dispatch pauses on unconfirmed delivery instead of retrying');
    await until('late answer completed',()=>c.eval(`sessions.get(${j(sid)})?.nativeRuntime?.state==='completed'`));
    const sent=fs.readFileSync(receipts,'utf8').trim().split('\n').map(JSON.parse);assert.equal(sent.length,1);
    const state=await invoke('groupchat:get-state',{meetingId:id});
    assert.equal(state.currentTurn,1);
    await click(`[data-gc-sync-answer="${sid}"]`);
    await until('exact result in group',async()=>{const s=await invoke('groupchat:get-state',{meetingId:id});return s.messages.some(m=>m.sid===sid&&m.status==='manual_extracted'&&m.content==='STATUS_DONE');});
    report.checks.push('late exact echo and terminal result are retained; real Sync collects the same submission');
    const shot=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'synced.png'),Buffer.from(shot.data,'base64'));
    const status=await invoke('loop:status',{meetingId:id});assert.equal(status.serialRunState.status,'paused');assert.equal(status.serialRunState.nextStepIndex,0);
    assert.equal(fs.readFileSync(receipts,'utf8').trim().split('\n').length,1);
    report.checks.push('manual sync neither repeats the task nor dispatches the next member');
    await click('[data-serial-resume]');
    await until('resume completes remaining step',async()=>{const s=await invoke('loop:status',{meetingId:id});return s.serialRunState?.status==='done';});
    const resumed=fs.readFileSync(receipts,'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(resumed.length,2);assert.notEqual(resumed[0].sessionId,resumed[1].sessionId);
    report.checks.push('real Continue dispatches only the next member and finishes the serial workflow');report.passed=true;
  } catch(error){report.error=error.stack;if(c&&id)report.state=await invoke('groupchat:get-state',{meetingId:id});throw error;}
  finally {if(hub)fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));if(c)await c.close();if(hub)report.exit=await gracefulQuit(hub);fs.writeFileSync(path.join(out,'result.json'),j(report));console.log(j(report));}
})().catch(error=>{console.error(error);process.exitCode=1;});
