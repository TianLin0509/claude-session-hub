'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const j=JSON.stringify,delay=ms=>new Promise(r=>setTimeout(r,ms));
const port=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
async function until(label,fn){const end=Date.now()+45000;while(!await fn()){if(Date.now()>end)throw Error('Timeout '+label);await delay(70);}}
async function click(c,selector){const r=await c.eval(`(()=>{const e=document.querySelector(${j(selector)});if(!e)throw Error('Missing '+${j(selector)});e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;if(!r.width||!r.height||!e.contains(document.elementFromPoint(x,y)))throw Error('Hidden/covered '+${j(selector)});return{x,y};})()`);for(const type of ['mousePressed','mouseReleased'])await c.send('Input.dispatchMouseEvent',{type,...r,button:'left',clickCount:1});}
(async()=>{
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-group-split-')),dataDir=path.join(root,'data'),workspace=path.join(root,'workspace');fs.mkdirSync(workspace);fs.mkdirSync(dataDir);
fs.writeFileSync(path.join(dataDir,'prepared-projects.json'),j({schemaVersion:1,projects:[],migrations:[]}));
const out=path.resolve('artifacts/group-member-split/'+Date.now());fs.mkdirSync(out,{recursive:true});
const report={out,passed:false,checks:[]};let hub,c;
const env={CLAUDE_HUB_E2E:'1',CODEX_HOME:path.join(root,'codex'),CLAUDE_CONFIG_DIR:path.join(root,'claude'),CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.resolve('tests/fixtures/codex-app-server.js'),CLAUDE_HUB_CLAUDE_STREAM_FIXTURE:path.resolve('tests/fixtures/claude-stream.js'),CLAUDE_HUB_CLAUDE_FIXTURE_MODE:process.argv.includes('--claude-approval')?'approval':'normal',CLAUDE_HUB_FIXTURE_CONFIG_DIR:path.join(root,'config'),CLAUDE_HUB_NATIVE_FIXTURE_STORE:path.join(root,'threads.json')};
const shot=async name=>{const image=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(image.data,'base64'));};
async function launch(){hub=await launchIsolatedHub({dataDir,port:await port(),label:'group-split',windowMode:'hidden',extraEnv:env});c=await connectFirstPage(hub);await until('renderer',()=>c.eval('typeof MeetingRoom!=="undefined"'));await c.send('Emulation.setDeviceMetricsOverride',{width:1680,height:1000,deviceScaleFactor:1,mobile:false});}
async function quit(){await c.close();c=null;const result=await gracefulQuit(hub);fs.appendFileSync(path.join(out,'hub.log'),hub.log().join('\n'));hub=null;assert.equal(result.forced,false);}
try {
 await launch();
 const meeting=await c.eval(`ipcRenderer.invoke('create-meeting',${j({scene:'general',groupChat:true,title:'成员双屏验收',workspace,slots:[{kind:'codex',memberId:'m1',model:'gpt-6-astra',mcpProfile:'none'},{kind:'claude',memberId:'m2',mcpProfile:'none'}]})})`);
 const mids=j(meeting.subSessions),mid=j(meeting.id);report.meetingId=meeting.id;
 await until('members connected',()=>c.eval(`${mids}.every(id=>sessions.get(id)?.nativeRuntime?.connection==='connected')`));
 const nativeIds=await c.eval(`${mids}.map(id=>sessions.get(id).codexSid||sessions.get(id).ccSessionId)`);
 await quit();await launch();
 await click(c,`[data-meeting-id="${meeting.id}"] .sl-title`);
 await until('resumed members',()=>c.eval(`${mids}.every(id=>sessions.get(id)?.status!=='dormant'&&sessions.get(id)?.nativeRuntime?.connection==='connected')`));
 await until('avatars painted',()=>c.eval('document.querySelectorAll(".mr-free-avatar-chk").length===2'));
 await shot('resumed-avatars');
 const avatars=await c.eval('[...document.querySelectorAll(".mr-free-avatar-chk")].map(el=>({disabled:el.classList.contains("disabled"),inputDisabled:el.querySelector("input").disabled}))');
 assert(avatars.every(a=>!a.disabled&&!a.inputDisabled),'resumed agents must have enabled avatars: '+j(avatars));
 await click(c,'.mr-free-avatar-chk[data-slot-idx="0"]');
 await until('avatar deselected',()=>c.eval(`!MeetingRoom.getMeetingData(${mid}).participants.includes(0)`));
 await click(c,'.mr-free-avatar-chk[data-slot-idx="0"]');
 await until('avatar selected',()=>c.eval(`MeetingRoom.getMeetingData(${mid}).participants.includes(0)`));
 assert.deepEqual(await c.eval(`${mids}.map(id=>sessions.get(id).codexSid||sessions.get(id).ccSessionId)`),nativeIds);
 report.checks.push('real group resume restores both native identities and clickable selected/deselected avatars');
 if(!process.argv.includes('--avatar-only')) {
  assert.equal(await c.eval('document.querySelector("[data-group-layout=overview]").getAttribute("aria-pressed")'),'true');
  await click(c,'#mr-input-box');await c.send('Input.insertText',{text:'共享草稿'});
  await click(c,'[data-group-layout="two"]');
  await until('two mounted member views',()=>c.eval('document.querySelectorAll(".gms-member-view:not([hidden])").length===2'));
  assert.equal(await c.eval('document.querySelector("#mr-input-box").innerText'),'共享草稿');
  assert.equal(await c.eval('document.querySelectorAll(".group-member-split .floating-input-box").length'),0);
  assert.equal(await c.eval('document.querySelector("#mr-input-box").getBoundingClientRect().height>0'),true);
  await shot('two-members');report.checks.push('default overview; real SVG click opens two members with one unchanged group composer');
  async function fill(text) { await click(c,'#mr-input-box'); for(const type of ['keyDown','keyUp'])await c.send('Input.dispatchKeyEvent',{type,key:'a',code:'KeyA',modifiers:2,windowsVirtualKeyCode:65});await c.send('Input.insertText',{text}); }
  async function send(text) { await fill(text);await click(c,'#mr-send-btn'); }
  const left=`[data-group-member="${meeting.subSessions[0]}"]`,right=`[data-group-member="${meeting.subSessions[1]}"]`;
  await send('GROUP_SPLIT_BOTH');
  if(process.argv.includes('--claude-approval')) {
   await until('Claude member approval',()=>c.eval(`!!document.querySelector(${j(right+' .claude-native-controls button')})`));
   await click(c,'[data-group-layout="overview"]');await click(c,'[data-group-layout="two"]');
   await click(c,right+' .claude-native-controls button');
   report.checks.push('Claude native approval remains actionable in its own pane across layout switches');
  }
  await until('both completed',()=>c.eval(`${mids}.every(id=>sessions.get(id)?.nativeRuntime?.state==='completed')`));
  for(const selector of [left,right]) await until('member transcript',()=>c.eval(`document.querySelector(${j(selector+' .msg-overlay')})?.textContent.includes('GROUP_SPLIT_BOTH')`));
  report.checks.push('shared real composer sends to both original members and each pane renders its authoritative history');
  await click(c,right+' .turn-card.assistant .card-actions-more');
  await click(c,right+' .card-actions-menu[open] [data-action="multi-select"]');
  assert.equal(await c.eval(`document.querySelector(${j(right+' .msg-overlay')}).classList.contains('multi-select-active')`),true);
  assert.equal(await c.eval(`document.querySelector(${j(left+' .msg-overlay')}).classList.contains('multi-select-active')`),false);
  await click(c,right+' [data-multi="exit"]');
  report.checks.push('member message multi-select stays in the owning pane');
  await fill('切换保留草稿');
  await click(c,'[data-group-layout="overview"]');
  await until('overview records',()=>c.eval('document.querySelector(".mr-gc-messages")?.textContent.includes("GROUP_SPLIT_BOTH")'));
  assert.equal(await c.eval('document.querySelector("#mr-input-box").innerText'),'切换保留草稿');
  await click(c,'[data-group-layout="two"]');
  await until('restored two',()=>c.eval('document.querySelectorAll(".gms-member-view:not([hidden])").length===2'));
  await click(c,'.gms-pane[data-side="0"] .gms-header button:not(.gms-stop)');
  await until('left backstage',()=>c.eval(`document.querySelector(${j(left+' .codex-backstage')})?.getAttribute('data-view')==='readable'`));
  assert.equal(await c.eval(`document.querySelector(${j(right+' .msg-overlay')}).classList.contains('hidden')`),false);
  await click(c,'.gms-pane[data-side="0"] .gms-header button:not(.gms-stop)');
  report.checks.push('overview roundtrip preserves draft; member backstage switches only its own pane');
  await send('@m1 fixture:approval');
  await until('member approval',()=>c.eval(`!!document.querySelector(${j(left+' .codex-native-request button')})`));
  const request=await c.eval(`sessions.get(${j(meeting.subSessions[0])}).nativeRuntime.requests[0].id`);
  await click(c,'[data-group-layout="overview"]');await click(c,'[data-group-layout="two"]');
  assert.equal(await c.eval(`sessions.get(${j(meeting.subSessions[0])}).nativeRuntime.requests[0].id`),request);
  await click(c,left+' .codex-native-request button');
  await until('approval completed',()=>c.eval(`sessions.get(${j(meeting.subSessions[0])}).nativeRuntime.state==='completed'`));
  report.checks.push('approval survives layout switches and replies to the exact member request');
  await send('@m1 fixture:hold');
  await until('holding member',()=>c.eval(`sessions.get(${j(meeting.subSessions[0])}).nativeRuntime.state==='running'`));
  await until('enabled member stop',()=>c.eval(`!document.querySelector(${j('.gms-pane[data-side="0"] .gms-stop')}).disabled`));
  await click(c,'.gms-pane[data-side="0"] .gms-stop');
  await until('stopped member',()=>c.eval(`sessions.get(${j(meeting.subSessions[0])}).nativeRuntime.state==='interrupted'`));
  assert.equal(await c.eval(`sessions.get(${j(meeting.subSessions[1])}).nativeRuntime.state`),'completed');
  report.checks.push('member stop interrupts only its native session');
  await send('@m1 fixture:scroll');
  await until('scrollable left',()=>c.eval(`(()=>{const e=document.querySelector(${j(left+' .msg-overlay')});return e.scrollHeight>e.clientHeight+200;})()`));
  const rect=await c.eval(`(()=>{const r=document.querySelector(${j(left+' .msg-overlay')}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await c.send('Input.synthesizeScrollGesture',{...rect,yDistance:280,speed:600,gestureSourceType:'mouse'});
  const scroll=await c.eval(`document.querySelector(${j(left+' .msg-overlay')})._cardFollowController.capture()`);
  assert.equal(scroll.following,false);
  await until('scroll completed',()=>c.eval(`sessions.get(${j(meeting.subSessions[0])}).nativeRuntime.state==='completed'`));
  const top=await c.eval(`document.querySelector(${j(left+' .msg-overlay')}).scrollTop`);
  await click(c,'[data-group-layout="overview"]');await click(c,'[data-group-layout="two"]');
  await until('reading anchor restored',()=>c.eval(`Math.abs(document.querySelector(${j(left+' .msg-overlay')}).scrollTop-${top})<3`));
  report.checks.push('live member output keeps upward reading paused across completion and layout changes');
  const navigationScroll=await c.eval(`document.querySelector(${j(left+' .msg-overlay')})._cardFollowController.capture()`);
  report.navigationScroll=navigationScroll;
  await fill('离开群聊保留草稿');await click(c,'#btn-home');
  await click(c,`[data-meeting-id="${meeting.id}"] .sl-title`);
  await until('reopen split',()=>c.eval('document.querySelectorAll(".gms-member-view:not([hidden])").length===2'));
  assert.equal(await c.eval('document.querySelector("#mr-input-box").innerText'),'离开群聊保留草稿');
  assert.deepEqual(await c.eval(`${mids}.map(id=>sessions.get(id).codexSid||sessions.get(id).ccSessionId)`),nativeIds);
  await until('reading position after navigation',()=>c.eval(`(()=>{const e=document.querySelector(${j(left+' .msg-overlay')}), s=e?._cardFollowController.capture();return s && !s.following && (s.anchorId===${j(navigationScroll.anchorId)} && Math.abs(s.anchorOffset-(${navigationScroll.anchorOffset}))<3);})()`));
  await shot('completed-two-members');report.checks.push('home roundtrip restores layout, original sessions and shared draft');
  const hiddenScroll=await c.eval(`document.querySelector(${j(left+' .msg-overlay')})._cardFollowController.capture()`);
  await click(c,'[data-group-layout="overview"]');await click(c,'#btn-home');
  await click(c,`[data-meeting-id="${meeting.id}"] .sl-title`);
  await until('reopen overview',()=>c.eval(`MeetingRoom.getActiveMeetingId()===${mid} && document.querySelector('[data-group-layout=overview]')?.getAttribute('aria-pressed')==='true' && document.querySelector('[data-group-layout=two]')?.getBoundingClientRect().height>0`));
  await click(c,'[data-group-layout="two"]');
  await until('hidden reading snapshot survives navigation',()=>c.eval(`(()=>{const s=document.querySelector(${j(left+' .msg-overlay')})?._cardFollowController.capture();return s && !s.following && s.anchorId===${j(hiddenScroll.anchorId)} && Math.abs(s.anchorOffset-(${hiddenScroll.anchorOffset}))<3;})()`));
  report.checks.push('leaving from overview preserves the hidden member reading anchor');
  await quit();await launch();await click(c,`[data-meeting-id="${meeting.id}"] .sl-title`);
  await until('restart overview',()=>c.eval('document.querySelector("[data-group-layout=overview]")?.getAttribute("aria-pressed")==="true"'));
  assert.equal(await c.eval('document.querySelectorAll(".gms-member-view:not([hidden])").length'),0);
  report.checks.push('restart after split use returns to overview');
  const triple=await c.eval(`ipcRenderer.invoke('create-meeting',${j({scene:'general',groupChat:true,title:'三人群双屏选择',workspace,slots:[1,2,3].map(i=>({kind:'codex',memberId:'m'+i,model:'gpt-6-astra',mcpProfile:'none'}))})})`);
  await until('three members',()=>c.eval(`${j(triple.subSessions)}.every(id=>sessions.get(id)?.nativeRuntime?.connection==='connected')`));
  await click(c,`[data-meeting-id="${triple.id}"] .sl-title`);
  await until('three-person room selected',()=>c.eval(`MeetingRoom.getActiveMeetingId()===${j(triple.id)} && document.querySelectorAll('.gms-member-picker').length===3`));
  await click(c,'[data-group-layout="two"]');
  await until('first two of three',()=>c.eval('document.querySelectorAll(".gms-member-view:not([hidden])").length===2'));
  const recipients=await c.eval(`MeetingRoom.getMeetingData(${j(triple.id)}).participants`);
  await click(c,'.gms-member-picker:nth-child(3) summary');await click(c,'.gms-member-picker:nth-child(3) button:last-child');
  await until('third in right',()=>c.eval(`document.querySelector('.gms-pane[data-side="1"] select').value===${j(triple.subSessions[2])}`));
  assert.equal(await c.eval('document.querySelectorAll(".gms-member-view:not([hidden])").length'),2);
  assert.deepEqual(await c.eval(`MeetingRoom.getMeetingData(${j(triple.id)}).participants`),recipients);
  await click(c,'.gms-member-picker:nth-child(1) summary');await click(c,'.gms-member-picker:nth-child(1) button:last-child');
  assert.equal(await c.eval('document.querySelectorAll(".gms-member-view:not([hidden])").length'),2);
  assert.equal(await c.eval('document.querySelector(".gms-pane.focused").dataset.side'),'0');
  const width=await c.eval('document.querySelector(".gms-pane").getBoundingClientRect().width');
  await click(c,'.group-member-split .session-pane-divider');
  for(const type of ['keyDown','keyUp'])await c.send('Input.dispatchKeyEvent',{type,key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
  await until('divider resized',()=>c.eval(`document.querySelector('.gms-pane').getBoundingClientRect().width>${width}`));
  await shot('three-members-two-panes');
  report.checks.push('three-member roster replaces only one pane, visible duplicate focuses existing pane, recipients unchanged, divider resizes');
 }
 report.passed=true;
}catch(error){report.error=error.stack;if(c){report.reading=await c.eval('[...document.querySelectorAll(".gms-member-view .msg-overlay")].map(e=>e._cardFollowController?.capture())').catch(()=>null);report.dom=await c.eval('document.body.innerText.slice(-6000)').catch(()=>null);await shot('failure').catch(()=>{});}process.exitCode=1;}
finally{if(c&&hub)await quit();fs.writeFileSync(path.join(out,'result.json'),j(report));console.log(j(report));}
})().catch(e=>{console.error(e);process.exitCode=1;});
