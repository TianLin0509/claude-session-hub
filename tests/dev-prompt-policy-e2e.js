'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const port=()=>new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p))})});
async function run(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-prompt-policy-')),out=path.resolve('output/playwright/dev-prompt-policy-'+Date.now());fs.mkdirSync(out,{recursive:true});
 let hub,cdp;const evidence={checks:[],root,fixture:'App Server stdio; real Hub dispatcher and UI, no real model'};
 const ok=(n,b)=>{assert(b,n);evidence.checks.push(n);console.log('PASS '+n)};
 try{
  hub=await launchIsolatedHub({dataDir:path.join(root,'data'),port:await port(),windowMode:'hidden',extraEnv:{CODEX_HOME:path.join(root,'codex'),CLAUDE_CONFIG_DIR:path.join(root,'claude'),CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.join(__dirname,'fixtures/codex-app-server.js')}});
  evidence.pid=hub.pid;cdp=await connectFirstPage(hub);
  const until=async(fn,name)=>{const deadline=Date.now()+25000;while(Date.now()<deadline){if(await fn())return;await sleep(100)}throw Error('timeout '+name)};
  const invoke=(channel,args={})=>cdp.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(channel)},${JSON.stringify(args)})`);
  await until(()=>cdp.eval('!!window.WorkflowTemplates && typeof sessions!=="undefined"'),'renderer');
  const m=await invoke('create-meeting',{mode:'dev',scene:'dev',groupChat:true,title:'提示词验收',workspace:root,slots:[{kind:'codex',memberId:'m1',model:'gpt-6-astra',effort:'xhigh',mcpProfile:'none'},{kind:'codex',memberId:'m2',model:'gpt-6-astra',effort:'xhigh',mcpProfile:'none'}]});
  await until(()=>cdp.eval(`${JSON.stringify(m.subSessions)}.every(s=>sessions.get(s)?.nativeRuntime?.state==='idle')`),'native sessions');
  await invoke('rename-session',{sessionId:m.subSessions[0],title:'检查员 岚',userRenamed:true});await invoke('rename-session',{sessionId:m.subSessions[1],title:'开发者 海',userRenamed:true});
  const cfg=await cdp.eval(`window.WorkflowTemplates.createTemplateConfig('dev-task',[{kind:'codex',memberId:'m1'},{kind:'codex',memberId:'m2'}])`);
  cfg.steps=[['m2'],['m1']];await invoke('update-meeting-sync',{meetingId:m.id,fields:{serialWorkflow:cfg}});
  await cdp.eval(`selectMeeting(${JSON.stringify(m.id)})`);
  const preset=await invoke('dev-file:kickoff-preset',{meetingId:m.id});
  ok('派工按成员 ID 绑定真实名称，非数组位置',preset.slot===1&&preset.prompt.includes('开发者 海：执行开题'));
  await invoke('groupchat:set-participants',{meetingId:m.id,participants:[1]});
  const state=()=>invoke('groupchat:get-state',{meetingId:m.id});
  async function send(text){const previous=(await state()).currentTurn;
   await cdp.eval(`(()=>{const b=document.getElementById('mr-input-box');b.textContent=${JSON.stringify(text)};b.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('mr-send-btn').click()})()`);
   await until(async()=>{const s=await state();return s.currentTurn>previous&&s.turns.some(t=>t.n===s.currentTurn)},'settled group turn');
   return state();
  }
  const first=await send('fixture:dev-progress\n'+preset.prompt);
  const prompt=s=>s.messages.findLast(x=>x.sid===m.subSessions[1]&&x.sourcePrompt)?.sourcePrompt||'';
  ok('首次实际发送一次公共协议，包含大白话与 HTML',prompt(first).split('## AI HUB 文件工作流').length===2&&prompt(first).includes('大白话')&&prompt(first).includes('HTML'));
  await until(()=>cdp.eval(`document.querySelectorAll('.mr-gc-messages [data-phase="commentary"]').length>=2`),'progress UI');
  const visible=await cdp.eval(`[...document.querySelectorAll('.mr-gc-messages [data-phase="commentary"]')].map(e=>e.innerText).join('\\n')`);
  ok('进展可见且不显示 PLAN / UPDATE 前缀',visible.includes('已定位问题')&&visible.includes('验证已通过')&&!/PLAN:|UPDATE:/.test(visible));
  ok('原始输出保留标签供核查',JSON.stringify(first.displayMessagesByAttempt).includes('PLAN: 已定位问题'));
  await cdp.eval(`document.querySelector('.mr-gc-messages [data-phase="commentary"]').scrollIntoView({block:'center'})`);
  const progressShot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'20260911-plain-progress-codex1.png'),Buffer.from(progressShot.data,'base64'));
  const next=await send('继续');ok('普通继续不注入文件协议或阶段派工',!prompt(next).includes('## AI HUB 文件工作流')&&!prompt(next).includes('原子改名')&&prompt(next).includes('继续'));
  await cdp.send('Page.reload');await until(()=>cdp.eval('!!window.MeetingRoom && typeof sessions!=="undefined"'),'reload');await cdp.eval(`selectMeeting(${JSON.stringify(m.id)})`);
  const third=await send('现在进度如何');ok('重载仍保持首次协议送达记录',!prompt(third).includes('## AI HUB 文件工作流'));
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1500,height:1050,deviceScaleFactor:1,mobile:false});
  const shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'20260911-dev-prompts-codex1.png'),Buffer.from(shot.data,'base64'));
  fs.writeFileSync(path.join(out,'20260911-group-state-codex1.json'),JSON.stringify(third,null,2));
 }finally{fs.writeFileSync(path.join(out,'20260911-evidence-codex1.json'),JSON.stringify(evidence,null,2));if(cdp)await cdp.close();if(hub)await gracefulQuit(hub);console.log('ARTIFACT_ROOT '+out)}
}
run().catch(e=>{console.error(e);process.exitCode=1});
