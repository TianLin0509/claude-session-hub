'use strict';
// Actual isolated Electron and composer clicks; controlled native providers.
// The uncertain/late notification is injected while the provider is still
// answering, reproducing the false-alarm case without spending real tokens.
const fs=require('fs'),path=require('path'),os=require('os'),net=require('net'),assert=require('assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher'),{connectFirstPage}=require('./helpers/cdp-client');
const ROOT=fs.mkdtempSync(path.join(os.tmpdir(),'hub-relay-safe-')),DATA=path.join(ROOT,'data'),CG=path.join(ROOT,'codex-gates'),AG=path.join(ROOT,'claude-gates');
const secretaryStore=new(require('../core/hub-assistant/store').AssistantStore)(path.join(DATA,'assistant'));
secretaryStore.set('workbench.config',{enabled:false});secretaryStore.db.close();
const ART=path.resolve('artifacts/20261009-relay-safe-actions-codex1');fs.mkdirSync(ART,{recursive:true});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const port=()=>new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
const received=dir=>{const f=path.join(dir,'received.jsonl');return fs.existsSync(f)?fs.readFileSync(f,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];};
const answerPath=row=>{const m=/写入 (.+?回答\.md)（/.exec(row.text);assert(m);return m[1];};
const release=(dir,row)=>fs.writeFileSync(path.join(dir,row.uuid+'.json'),JSON.stringify({result:'本轮回答已写入群聊。'}));
(async()=>{
 let hub,c,id;const evidence={passed:false,realModel:false,notificationsInjected:true,checks:[],root:ROOT};
 const invoke=(channel,args={})=>c.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(channel)},${JSON.stringify(args)})`);
 const wait=async(label,pred,ms=45000)=>{const end=Date.now()+ms;while(Date.now()<end){const value=await pred();if(value)return value;await delay(100);}throw Error('Timeout: '+label);};
 const check=(label,value)=>{assert(value,label);evidence.checks.push(label);console.log('PASS '+label);};
 const click=async selector=>{const p=await wait('clickable '+selector,()=>c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return r.width&&r.height&&!e.disabled&&e.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`));for(const type of ['mousePressed','mouseReleased'])await c.send('Input.dispatchMouseEvent',{type,...p,button:'left',clickCount:1});};
 const shot=async name=>{const r=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(ART,name+'.png'),Buffer.from(r.data,'base64'));};
 const open=async()=>{await click(`[data-meeting-id="${id}"] .sl-title`);await wait('composer',()=>c.eval(`!!document.querySelector('.mr-conversation-flow')`));};
 const emit=async(channel,payload)=>c.eval(`require('electron').ipcRenderer.emit(${JSON.stringify(channel)},{},${JSON.stringify(payload)})`);
 const snapshot=async()=>({meetings:await invoke('get-meetings'),state:await invoke('groupchat:get-state',{meetingId:id}),c:received(CG).length,a:received(AG).length});
 const assertNoDispatch=async(before,label)=>{const after=await snapshot();check(label,after.c===before.c&&after.a===before.a&&JSON.stringify(after.meetings.find(m=>m.id===id).serialWorkflow.serialRunState)===JSON.stringify(before.meetings.find(m=>m.id===id).serialWorkflow.serialRunState));};
 try{
  hub=await launchIsolatedHub({dataDir:DATA,port:await port(),windowMode:'hidden',label:'relay-safe-actions',extraEnv:{CODEX_HOME:path.join(ROOT,'codex'),CLAUDE_CONFIG_DIR:path.join(ROOT,'claude'),CLAUDE_HUB_CLAUDE_STREAM_FIXTURE:path.resolve('tests/fixtures/claude-stream.js'),CLAUDE_HUB_CLAUDE_FIXTURE_MODE:'gated',CLAUDE_HUB_FIXTURE_GATE_DIR:AG,CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.resolve('tests/fixtures/codex-app-server.js'),CLAUDE_HUB_CODEX_FIXTURE_GATE_DIR:CG,CLAUDE_HUB_NATIVE_FIXTURE_STORE_DIR:path.join(ROOT,'native-store')}});
  c=await connectFirstPage(hub);await wait('renderer',()=>c.eval('!!window.MeetingRoom'));await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  const m=await invoke('create-meeting',{mode:'group',scene:'general',groupChat:true,title:'接力查看与手动补救',workspace:ROOT,slots:[{index:0,memberId:'m1',kind:'claude',model:'claude-haiku-4-5-20251001',mcpProfile:'none'},{index:1,memberId:'m2',kind:'codex',model:'gpt-6-astra',mcpProfile:'none'}]});id=m.id;
  await wait('members ready',async()=>{const sessions=await invoke('get-sessions');return m.subSessions.every(sid=>sessions.find(s=>s.id===sid)?.status==='idle');});
  await click(`[data-meeting-id="${id}"] .sl-title`);await click('#mr-workflow-btn');await click('[data-task-preset=custom]');await click('[data-wf=chip][data-step="0"][data-member=m2]');await click('[data-wf=chip][data-step="0"][data-member=m1]');await click('[data-wf=add]');await click('.wf-save');await wait('saved',()=>c.eval(`document.querySelector('#workflow-config-modal').style.display==='none'`));await open();
  await click('#mr-input-box');await c.send('Input.insertText',{text:'请按顺序回答这个问题，保留完整上下文。'});for(const type of ['keyDown','keyUp'])await c.send('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  const codex=await wait('Codex received',()=>received(CG)[0]);fs.writeFileSync(answerPath(codex),'前序证据：Codex 的完整回答，第二位必须看见。','utf8');release(CG,codex);
  const claude=await wait('Claude received',()=>received(AG)[0]);await wait('second stage',()=>c.eval(`document.querySelector('.mr-conversation-flow')?.innerText.includes('第 2/2 轮')`));
  check('正常接力维持原操作，只显示暂停',await c.eval(`!!document.querySelector('[data-conversation=stop]')&&!document.querySelector('[data-conversation=copy]')&&!document.querySelector('[data-conversation=cli]')`));
  await click('#mr-input-box');await c.send('Input.insertText',{text:'这是下一条未发送草稿'});
  let current=(await invoke('get-meetings')).find(m=>m.id===id),state=await invoke('groupchat:get-state',{meetingId:id});
  const sid=current.subSessions[0],run=current.serialWorkflow.serialRunState,attempt=Object.values(state.attempts).find(a=>a.sid===sid&&a.workflowRun?.runId===run.runId&&a.workflowRun.stepIndex===1);
  assert(attempt,'exact workflow attempt was persisted');evidence.claudeAttempt=attempt;
  await emit('groupchat-soft-alert',{meetingId:id,sid,label:'Claude',level:'t2',turnNum:attempt.turnNum});
  await wait('stale shortcut',()=>c.eval(`!!document.querySelector('[data-conversation=cli]')`));
  check('三分钟提醒只报告待确认，不推断卡死',await c.eval(`document.querySelector('.mr-conversation-flow').innerText.includes('状态可能过期')&&!document.querySelector('#mr-gc-soft-alert-banner')?.innerText.includes('卡死')`));
  await emit('workflow:progress',{meetingId:id,...run,status:'paused',currentStepIndex:1,error:{reason:'submission_unknown'}});
  await wait('uncertain',()=>c.eval(`document.querySelector('.mr-conversation-flow').innerText.includes('待确认')`));
  check('接收不明隐藏继续按钮，提供复制和 CLI',await c.eval(`!document.querySelector('[data-conversation=resume]')&&!!document.querySelector('[data-conversation=copy]')&&!!document.querySelector('[data-conversation=cli]')`));
  evidence.cardCli=await c.eval(`[...document.querySelectorAll('[data-gc-open-cli]')].map(e=>({html:e.outerHTML,parent:e.parentElement.outerHTML.slice(0,600),width:getComputedStyle(e).width,whiteSpace:getComputedStyle(e).whiteSpace}))`);
  check('卡片按钮文字不被改成文件路径链接',await c.eval(`!document.querySelector('[data-gc-open-cli] a')&&getComputedStyle(document.querySelector('[data-gc-open-cli]')).whiteSpace==='nowrap'`));
  const before=await snapshot();await click('[data-conversation=copy]');
  await wait('copied exact archive',()=>c.eval(`require('electron').clipboard.readText()===${JSON.stringify(claude.text)}`));
  check('复制全文包含原问题、前序回答和写回路径',claude.text.includes('完整上下文')&&claude.text.includes('前序证据')&&claude.text.includes(answerPath(claude)));
  await assertNoDispatch(before,'复制不发消息、不暂停或继续工作流');
  check('复制保留草稿和第一位的回答',await c.eval(`document.querySelector('#mr-input-box').innerText==='这是下一条未发送草稿'&&document.querySelector('#meeting-room-panel').innerText.includes('前序证据')`));await shot('01-uncertain-desktop');
  await c.eval(`window.__relayCopy=clipboardController.copyText;clipboardController.copyText=async()=>({ok:false,reason:'controlled clipboard failure'})`);
  await click('[data-conversation=copy]');await wait('fallback',()=>c.eval(`!!document.querySelector('.mr-gc-prompt-raw')`));
  check('复制失败弹出只读的完整原文，不谎报成功',await c.eval(`document.querySelector('.mr-gc-prompt-raw').readOnly&&document.querySelector('.mr-gc-prompt-raw').value===${JSON.stringify(claude.text)}&&document.querySelector('.mr-gc-prompt-modal-title').innerText.includes('复制失败')`));await shot('02-clipboard-fallback');await click('.mr-gc-prompt-modal-close');await c.eval('clipboardController.copyText=window.__relayCopy');
  await click('[data-gc-open-cli]');await wait('card native view',()=>c.eval(`currentView==='pty'&&activeSessionId===${JSON.stringify(sid)}`));
  await assertNoDispatch(before,'未完成回答卡片的 CLI 入口也只查看');await open();
  await click('[data-conversation=cli]');await wait('native view',()=>c.eval(`currentView==='pty'&&activeSessionId===${JSON.stringify(sid)}&&document.querySelector('#meeting-room-panel').style.display==='none'`));
  await assertNoDispatch(before,'打开对应 Claude CLI 不发送、不重启、不修改工作流');
  await open();check('从 CLI 返回群聊草稿仍在',await c.eval(`document.querySelector('#mr-input-box').innerText==='这是下一条未发送草稿'`));
  for(const width of [600,390]){if(width===390)await click('#btn-expand-sidebar');await c.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await c.eval('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');check(`宽 ${width} 状态和两个按钮均可见且不横向溢出`,await c.eval(`(()=>{const root=document.querySelector('.mr-conversation-flow'),r=root.getBoundingClientRect();return r.x>=0&&r.right<=innerWidth+1&&[...root.querySelectorAll('button')].every(b=>{const t=b.getBoundingClientRect();return t.x>=0&&t.right<=innerWidth+1&&t.height>=44;});})()`));await shot('03-narrow-'+width);}
  // Remove the archived input from the isolated renderer snapshot and query
  // response only. The live provider and original durable evidence stay intact.
  await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await click('#btn-expand-sidebar');
  await c.eval(`window.__relayInvoke=require('electron').ipcRenderer.invoke;require('electron').ipcRenderer.invoke=async function(ch,args){const v=await window.__relayInvoke.call(this,ch,args);if(ch==='groupchat:get-state'&&args?.meetingId===${JSON.stringify(id)}){v.pendingPrompts={};v.messages=v.messages.map(m=>({...m,sourcePrompt:undefined}));}return v;}`);
  await open();
  await wait('missing archive',()=>c.eval(`!document.querySelector('[data-conversation=copy]')&&!!document.querySelector('[data-conversation=cli]')`));
  check('完整存档缺失时隐藏复制，仍可查看 CLI',await c.eval(`document.querySelector('.mr-conversation-flow').innerText.includes('暂无存档')`));await shot('04-missing-archive');
  await c.eval(`require('electron').ipcRenderer.invoke=window.__relayInvoke`);
  await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  fs.writeFileSync(answerPath(claude),'Claude 正常完成；快捷入口没有重复提交。','utf8');release(AG,claude);
  await wait('natural completion',async()=>{const s=await invoke('loop:status',{meetingId:id});return !s.running&&s.serialRunState?.status==='done';});
  await wait('answer card',()=>c.eval(`document.querySelector('#meeting-room-panel').innerText.includes('Claude 正常完成')`));
  check('误报后原生回合仍正常完成，两位各接收一次',received(CG).length===1&&received(AG).length===1);
  check('状态自然恢复，未把复制当作送达或回答',await c.eval(`!document.querySelector('[data-conversation=copy]')&&document.querySelector('#mr-input-box').innerText==='这是下一条未发送草稿'`));
  evidence.passed=true;
 }catch(error){evidence.error=error.stack;if(c){await shot('failure');evidence.ui=await c.eval('document.body.innerText.slice(-12000)');}throw error;}
 finally{if(c)await c.close();if(hub){evidence.logs=hub.log();evidence.quit=await gracefulQuit(hub);}fs.writeFileSync(path.join(ART,'evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify({passed:evidence.passed,checks:evidence.checks.length,error:evidence.error,root:ROOT}));}
})().catch(error=>{console.error(error);process.exitCode=1;});
