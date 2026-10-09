'use strict';
// Real settings/composer clicks, Electron, dispatcher and native provider
// protocols. Providers are separate controlled processes, not real models.
const fs=require('fs'),path=require('path'),os=require('os'),net=require('net'),assert=require('assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher'),{connectFirstPage}=require('./helpers/cdp-client');
const ROOT=fs.mkdtempSync(path.join(os.tmpdir(),'hub-conversation-gui-')),DATA=path.join(ROOT,'data'),CG=path.join(ROOT,'codex-gates'),AG=path.join(ROOT,'claude-gates');
// Disable unrelated timed secretary jobs in this fixture database. They share
// the provider receipt log and would otherwise race assertions near 21:00.
const secretaryStore=new(require('../core/hub-assistant/store').AssistantStore)(path.join(DATA,'assistant'));
secretaryStore.set('workbench.config',{enabled:false});secretaryStore.db.close();
const ART=path.resolve('artifacts/20261009-conversation-workflow-codex1');fs.mkdirSync(ART,{recursive:true});
const delay=ms=>new Promise(r=>setTimeout(r,ms)),port=()=>new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
const received=dir=>{const file=path.join(dir,'received.jsonl');return fs.existsSync(file)?fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];};
const answerPath=row=>{const match=/写入 (.+?回答\.md)（/.exec(row.text);assert(match,'normal group answer path is attached');return match[1];};
const release=(dir,row)=>fs.writeFileSync(path.join(dir,row.uuid+'.json'),JSON.stringify({result:'本轮回答已写入群聊。'}));
(async()=>{let hub,c,id;const e={passed:false,realModel:false,root:ROOT,checks:[]};
 const invoke=(channel,args={})=>c.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(channel)},${JSON.stringify(args)})`);
 const wait=async(label,pred,ms=45000)=>{const end=Date.now()+ms;while(Date.now()<end){const value=await pred();if(value)return value;await delay(100);}throw Error('Timeout: '+label);};
 const check=(name,value)=>{assert(value,name);e.checks.push(name);console.log('PASS '+name);};
 const click=async selector=>{const p=await wait('clickable '+selector,()=>c.eval(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!r.width||!r.height||!el.contains(document.elementFromPoint(x,y)))return null;return{x,y};})()`));for(const type of ['mousePressed','mouseReleased'])await c.send('Input.dispatchMouseEvent',{type,...p,button:'left',clickCount:1});};
 const send=async text=>{await click('#mr-input-box');await c.send('Input.insertText',{text});for(const type of ['keyDown','keyUp'])await c.send('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13});};
 const status=()=>invoke('loop:status',{meetingId:id});
 const shot=async name=>{const result=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(ART,name+'.png'),Buffer.from(result.data,'base64'));};
 const options={dataDir:DATA,windowMode:'hidden',label:'conversation-workflow',extraEnv:{CODEX_HOME:path.join(ROOT,'codex'),CLAUDE_CONFIG_DIR:path.join(ROOT,'claude'),CLAUDE_HUB_CLAUDE_STREAM_FIXTURE:path.resolve('tests/fixtures/claude-stream.js'),CLAUDE_HUB_CLAUDE_FIXTURE_MODE:'gated',CLAUDE_HUB_FIXTURE_GATE_DIR:AG,CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.resolve('tests/fixtures/codex-app-server.js'),CLAUDE_HUB_CODEX_FIXTURE_GATE_DIR:CG,CLAUDE_HUB_NATIVE_FIXTURE_STORE_DIR:path.join(ROOT,'native-store')}};
 const launch=async()=>{hub=await launchIsolatedHub({...options,port:await port()});c=await connectFirstPage(hub);await wait('renderer',()=>c.eval('!!window.MeetingRoom'));await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});};
 const open=async()=>{await click(`[data-meeting-id="${id}"] .sl-title`);await wait('workflow switch',()=>c.eval(`!document.querySelector('#mr-workflow-switch')?.hidden`));};
 const completed=()=>wait('speech completed',async()=>{const s=await status();return !s.running&&s.serialRunState?.status==='done';});
 const cycle=async(input,marker)=>{
  const cb=received(CG).length,ab=received(AG).length;await send(input);
  const codex=await wait('Codex receives first',()=>received(CG)[cb]);check('新输入从 Codex 开始，Claude 尚未接收',received(AG).length===ab);
  check('发言提示词没有任务交付协议',codex.text.includes(input)&&!codex.text.includes('hub-delivery:')&&!codex.text.includes('按文件交付推进'));
  fs.writeFileSync(answerPath(codex),marker+'：Codex 的完整回答。','utf8');
  await wait('first answer card',()=>c.eval(`document.querySelector('#meeting-room-panel').innerText.includes(${JSON.stringify(marker)})`));
  await delay(250);check('写出回答时仍等待真实回合结束，不提前叫 Claude',received(AG).length===ab);
  release(CG,codex);const claude=await wait('Claude receives next',()=>received(AG)[ab]);
  check('Claude 能看到 Codex 的完整回答和本次输入',claude.text.includes(marker)&&claude.text.includes(input));
  fs.writeFileSync(answerPath(claude),marker+'：Claude 的后续回答。','utf8');release(AG,claude);await completed();
  const state=await invoke('groupchat:get-state',{meetingId:id});
  check('用户原话在真实群聊中只显示一次',state.messages.filter(m=>m.role==='user'&&!m.dispatch&&m.content===input).length===1);
  check('两位的回答分别保留，未创建交付任务目录',answerPath(codex)!==answerPath(claude)&&!fs.existsSync(path.join(DATA,'task-docs',id,'deliveries')));
  return{codex,claude};
 };
 try{
  await launch();const m=await invoke('create-meeting',{mode:'group',scene:'general',groupChat:true,title:'按顺序发言：Codex → Claude',workspace:ROOT,slots:[{index:0,memberId:'m1',kind:'claude',model:'claude-haiku-4-5-20251001',mcpProfile:'none'},{index:1,memberId:'m2',kind:'codex',model:'gpt-6-astra',mcpProfile:'none'}]});id=m.id;
  await click(`[data-meeting-id="${id}"] .sl-title`);await click('#mr-workflow-btn');await click('[data-task-preset=custom]');await click('[data-wf=chip][data-step="0"][data-member=m2]');await click('[data-wf=chip][data-step="0"][data-member=m1]');await click('[data-wf=add]');
  check('设置只有发言顺序、空 Prompt 和保存动作',await c.eval(`document.querySelector('#workflow-config-modal').innerText.includes('按顺序发言')&&!document.querySelector('[data-wf=toggle]')&&[...document.querySelectorAll('[data-wf-step-prompt]')].every(n=>n.value==='')`));await shot('01-settings');
  await click('.wf-save');await wait('save closed',()=>c.eval(`document.querySelector('#workflow-config-modal').style.display==='none'`));await open();
  check('保存后不显示开任务、校对交付或交付文件按钮',await c.eval(`!!document.querySelector('.mr-conversation-flow')&&!document.querySelector('[data-delivery]')`));
  const first=await cycle('第一条问题：请按顺序说明你的观点。','第一条证据');
  fs.writeFileSync(answerPath(first.codex),'第一条修订：普通回答允许更正。','utf8');await wait('answer edit',()=>c.eval(`document.body.innerText.includes('第一条修订')`));check('历史回答允许更正，不触发任务哈希校对',true);
  await cycle('第二条问题：继续按原来的顺序。','第二条证据');check('第二条输入无需重新保存或开任务',true);await shot('02-two-inputs');
  check('小表情开关紧邻工作流设置且保存后开启',await c.eval(`(()=>{const s=document.querySelector('#mr-workflow-switch'),r=s.getBoundingClientRect(),b=document.querySelector('#mr-workflow-btn').getBoundingClientRect();return s.previousElementSibling.id==='mr-workflow-btn'&&Math.abs(r.y-b.y)<3&&r.x>=b.right&&r.x-b.right<15&&s.getAttribute('aria-checked')==='true'&&!!s.querySelector('svg');})()`));
  await click('#mr-workflow-switch');await wait('workflow off',()=>c.eval(`document.querySelector('#mr-workflow-switch').getAttribute('aria-checked')==='false'`));
  check('关掉只改变生效状态，原顺序和空 Prompt 保留',await c.eval(`!document.querySelector('.mr-conversation-flow')`) && (await invoke('get-meetings')).find(m=>m.id===id).serialWorkflow.stepConfigs.every(r=>r.prompt===''));
  // Ordinary chat with one selected member must bypass the saved serial order.
  for(const n of [0,1]){const checked=await c.eval(`document.querySelector('.mr-free-slot-cb[data-slot-idx="${n}"]').checked`);if(checked!==(n===1))await click(`.mr-free-avatar-chk[data-slot-idx="${n}"]`);}
  const offC=received(CG).length,offA=received(AG).length;await send('开关关闭后的普通问题');const plain=await wait('ordinary receiver',()=>received(CG)[offC]);
  check('关闭后新输入走普通群聊',!plain.text.includes('【按顺序发言')&&received(AG).length===offA);fs.writeFileSync(answerPath(plain),'普通群聊回答。','utf8');release(CG,plain);await wait('ordinary complete',()=>c.eval(`document.querySelector('#meeting-room-panel')?.innerText.includes('普通群聊回答。')`));await delay(350);check('普通回答结束不自动叫后面的 Claude',received(AG).length===offA);await shot('04-switch-off');
  const beforeC=received(CG).length,beforeA=received(AG).length;await c.close();c=null;e.firstQuit=await gracefulQuit(hub);hub=null;check('测试 Hub 正常退出',!e.firstQuit.forced);
  await launch();await open();await delay(500);check('重开 Hub 保留关闭状态，未擅自重发旧问题',await c.eval(`document.querySelector('#mr-workflow-switch').getAttribute('aria-checked')==='false'`)&&received(CG).length===beforeC&&received(AG).length===beforeA);
  await click('#mr-workflow-switch');await wait('workflow on',()=>c.eval(`document.querySelector('#mr-workflow-switch').getAttribute('aria-checked')==='true'&&!!document.querySelector('.mr-conversation-flow')`));check('再次打开不会自动重发旧问题',received(CG).length===beforeC&&received(AG).length===beforeA);await shot('05-switch-on');await cycle('重启后的第三条问题。','重启证据');
  const activeC=received(CG).length,activeA=received(AG).length;await send('运行中关闭开关');const activeRow=await wait('active switch dispatch',()=>received(CG)[activeC]);await click('#mr-workflow-switch');await wait('active switch off',()=>c.eval(`document.querySelector('#mr-workflow-switch').getAttribute('aria-checked')==='false'`));check('运行中关闭开关保留当前回答',!!(await status()).running);fs.writeFileSync(answerPath(activeRow),'当前回答已完成。','utf8');release(CG,activeRow);await wait('disabled run stops after current answer',async()=>!((await status()).running));check('当前回答结束后不再叫 Claude',received(AG).length===activeA);
  await click('#mr-workflow-switch');await wait('reenabled after active stop',()=>c.eval(`document.querySelector('#mr-workflow-switch').getAttribute('aria-checked')==='true'`));await cycle('运行中切换后的新问题。','运行中切换恢复');
  const pauseC=received(CG).length,pauseA=received(AG).length;await send('暂停验证：请先回答。');await wait('pause first dispatch',()=>received(CG).length===pauseC+1);
  const current=(await invoke('get-meetings')).find(m=>m.id===id);check('重复刷新相同进度保留暂停按钮，避免点击丢失',await c.eval(`(()=>{const before=document.querySelector('[data-conversation=stop]');window.MeetingRoom.updateMeetingData(${JSON.stringify(id)},${JSON.stringify(current)});return before===document.querySelector('[data-conversation=stop]');})()`));
  await click('[data-conversation=stop]');await wait('paused',async()=>!((await status()).running)&&((await status()).serialRunState?.status==='paused'));check('暂停会阻止后续 Claude 发言',received(AG).length===pauseA);
  await cycle('暂停后换个新问题，仍按同一顺序。','暂停后新输入');
  await c.send('Emulation.setDeviceMetricsOverride',{width:600,height:900,deviceScaleFactor:1,mobile:false});check('窄窗口开关完整可见',await c.eval(`(()=>{const r=document.querySelector('#mr-workflow-switch').getBoundingClientRect();return r.width>0&&r.x>=0&&r.right<=innerWidth;})()`));await shot('06-narrow-switch');await click('#mr-workflow-btn');await wait('settings opened after restart',()=>c.eval(`document.querySelector('#workflow-config-modal')?.style.display==='flex'`));check('窄窗口保留顺序设置，且没有交付校验说明',await c.eval(`(()=>{const d=document.querySelector('.wf-dialog'),r=d.getBoundingClientRect();return r.x>=0&&r.right<=innerWidth+1&&!d.innerText.includes('3 轮审查')&&!d.innerText.includes('交付要求自动附加');})()`));await shot('03-narrow-settings');e.passed=true;
 }catch(error){e.error=error.stack;if(c){await shot('failure');e.ui=await c.eval('document.body.innerText.slice(-14000)');if(id)e.status=await status();}throw error;}
 finally{if(c)await c.close();if(hub){e.logs=hub.log();e.quit=await gracefulQuit(hub);}e.codexReceived=received(CG);e.claudeReceived=received(AG);fs.writeFileSync(path.join(ART,'evidence.json'),JSON.stringify(e,null,2));console.log(JSON.stringify({passed:e.passed,checks:e.checks,error:e.error,root:ROOT}));}
})().catch(error=>{console.error(error);process.exitCode=1;});
