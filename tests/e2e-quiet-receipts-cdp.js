'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const j=JSON.stringify,sleep=ms=>new Promise(r=>setTimeout(r,ms));
const port=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
async function main(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-quiet-receipts-')),work=path.join(root,'work');fs.mkdirSync(work);
 const out=path.resolve('artifacts','20261011-quiet-receipts-'+Date.now());fs.mkdirSync(out,{recursive:true});
 const evidence={passed:false,checks:[],kind:'isolated Hub UI, controlled send results and receipt events'};let hub,c;
 const check=(name,value)=>{assert(value,name);evidence.checks.push(name);console.log('PASS',name);};
 const wait=async expr=>{for(let i=0;i<300;i++){if(await c.eval(expr))return;await sleep(100);}throw Error('Timeout '+expr);};
 const click=async selector=>{const p=await c.eval(`(()=>{const e=document.querySelector(${j(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);for(const type of ['mousePressed','mouseReleased'])await c.send('Input.dispatchMouseEvent',{type,...p,button:'left',clickCount:1});};
 try{
  hub=await launchIsolatedHub({dataDir:path.join(root,'data'),port:await port(),windowMode:'hidden',extraEnv:{AI_HUB_WORKSPACE_ROOT:root,CODEX_HOME:path.join(root,'codex'),CLAUDE_CONFIG_DIR:path.join(root,'claude'),CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.resolve('tests/fixtures/codex-app-server.js')}});
  c=await connectFirstPage(hub);await c.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  await wait('!!window.WorkspaceController && !!window.MeetingRoom');
  const session=await c.eval(`ipcRenderer.invoke('create-session',{kind:'codex',opts:{cwd:${j(work)},model:'gpt-6-astra',mcpProfile:'none'}})`),sid=j(session.id);
  await wait(`sessions.get(${sid})?.nativeRuntime?.state==='idle'`);await click(`[data-session-id="${session.id}"]`);
  await wait("!!document.querySelector('.floating-input-box')");
  await c.eval(`window.__quietToasts=[];window.__quietSends=[];window.__quietResends=[];window.__quietResult={ok:true,sendStatus:'stuck'};
    const originalToast=showToast;showToast=(...args)=>{__quietToasts.push(args);return originalToast(...args);};
    const invoke=ipcRenderer.invoke.bind(ipcRenderer);ipcRenderer.invoke=(channel,request)=>{
      if(channel==='session:send-prompt'){__quietSends.push(request);return Promise.resolve(__quietResult);}
      if(channel==='session:resend-prompt'){__quietResends.push(request);return Promise.resolve({ok:false});}
      return invoke(channel,request);
    };`);
  const send=async(text,result)=>{await c.eval(`__quietResult=${j(result)};__quietToasts.length=0;var box=document.querySelector('.floating-input-box');replaceContenteditableText(box,${j(text)});box.dispatchEvent(new Event('input',{bubbles:true}));`);await click('.floating-input-send');await sleep(250);return c.eval(`floatingPromptDeliveries.get(${sid})?.clientSubmissionId`);};
  for(const status of ['unconfirmed','content-mismatch','confirmed']){
    const first=await send('校验提示移除测试 '+status,{ok:true,sendStatus:'stuck'});
    await c.eval(`ipcRenderer.emit('session:prompt-receipt',{},${j({sessionId:session.id,clientSubmissionId:first,status})})`);
    check(status+' retained internally',await c.eval(`floatingPromptDeliveries.get(${sid}).status===${j(status)}`));
    check(status+' has no banner or toast',await c.eval("!document.querySelector('.fi-stuck')&&__quietToasts.length===0"));
  }
  await send('返回差异结果',{ok:true,sendStatus:'content-mismatch'});
  check('direct mismatch result stays quiet',await c.eval("!document.querySelector('.fi-stuck')&&__quietToasts.length===0"));
  const late=await send('迟到回执',{ok:false,unconfirmed:true,sendStatus:'stuck'});
  for(const mode of ['pty','card','pty']){
    await c.eval(`applyViewMode(${j(mode)})`);await sleep(150);
    await c.eval(`ipcRenderer.emit('session:prompt-receipt',{},${j({sessionId:session.id,clientSubmissionId:late,status:'content-mismatch'})})`);
    check('switch '+mode+' never restores warning',await c.eval("!document.querySelector('.fi-stuck')&&__quietToasts.length===0"));
  }
  check('no automatic resend',await c.eval('__quietResends.length===0'));
  await send('发送失败应保留原文',{ok:false,notSent:true,message:'测试连接不可用'});
  check('real send failure still visible',await c.eval("__quietToasts.some(a=>a[0].includes('消息未发送'))"));
  check('unsent draft returned',await c.eval("document.querySelector('.floating-input-box').innerText==='发送失败应保留原文'"));
  const shot=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'quiet-composer.png'),Buffer.from(shot.data,'base64'));evidence.passed=true;
 }finally{if(c)await c.close();if(hub){fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));await gracefulQuit(hub);}fs.writeFileSync(path.join(out,'checks.json'),JSON.stringify(evidence,null,2));console.log('ARTIFACT_ROOT',out);}
}
main().catch(e=>{console.error(e);process.exitCode=1;});

