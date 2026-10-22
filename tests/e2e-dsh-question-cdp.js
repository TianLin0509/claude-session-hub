'use strict';
// Opt-in real subscription test; only this test's Hub/profile is changed.
const fs=require('fs'),path=require('path'),os=require('os'),net=require('net'),assert=require('assert/strict');
const {launchIsolatedHub,gracefulQuit,_waitMs}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const j=JSON.stringify;
async function main(){
  if(!process.env.HUB_ACP_LIVE_CONFIG)throw Error('HUB_ACP_LIVE_CONFIG required');
  const acp=JSON.parse(fs.readFileSync(process.env.HUB_ACP_LIVE_CONFIG,'utf8')).acp;
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-deepseek-start-')),data=path.join(root,'data');
  const out=path.resolve('artifacts','20261022-dsh-question-codex-'+Date.now());
  fs.mkdirSync(data);fs.mkdirSync(out,{recursive:true});
  const configFile=path.join(data,'config.json');fs.writeFileSync(configFile,j({acp}));
  let hub,c,sid;const report={passed:false,checks:[],out};
  const until=async(expr,label)=>{const deadline=Date.now()+120000;while(Date.now()<deadline){
    if(await c.eval(`Boolean(${expr})`))return;
    if(sid){const reason=await c.eval(`(sessions.get(${j(sid)})?.nativeRuntime?.connection==='disconnected' || sessions.get(${j(sid)})?.nativeRuntime?.state==='failed') && sessions.get(${j(sid)}).nativeRuntime.reason`);if(reason)throw Error(reason);}
    await _waitMs(150);
  }throw Error('timeout: '+label);};
  const click=async(selector)=>{const pos=await c.eval(`(()=>{const e=document.querySelector(${j(selector)});if(!e)throw Error('missing '+${j(selector)});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    for(const type of ['mousePressed','mouseReleased'])await c.send('Input.dispatchMouseEvent',{type,...pos,button:'left',clickCount:1});};
  const snap=async(name)=>{const shot=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(shot.data,'base64'));};
  try{
    const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
    hub=await launchIsolatedHub({dataDir:data,port,label:'DeepSeek Token Plan real startup',extraEnv:{AI_HUB_WORKSPACE_ROOT:root,HUB_STARTUP_TRACE:'1'}});
    c=await connectFirstPage(hub);
    let sidebarReady=false;
    c.ws.on('message',raw=>{const event=JSON.parse(raw);if(event.method==='Runtime.consoleAPICalled'
      && event.params.args?.some(a=>String(a.value).includes('renderer-sidebar-ready sent')))sidebarReady=true;});
    await c.send('Runtime.enable');
    const startupDeadline=Date.now()+90000;
    while(!sidebarReady && Date.now()<startupDeadline)await _waitMs(100);
    assert(sidebarReady,'renderer has completed persisted-session restoration');
    await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:950,deviceScaleFactor:1,mobile:false});
    await until('document.body?.innerText.includes("选择协作方式")','home ready');
    await click('#btn-new-more');
    await until('document.querySelector("#new-session-menu")?.getBoundingClientRect().height>0','launch center visible');
    await _waitMs(350);
    await click('.new-session-option[data-kind="deepseek"]');
    await until(`document.querySelector('#new-session-model')?.value===${j(require('../core/model-options').DEFAULT_MODEL_BY_KIND['deepseek-acp'])}`,'Token Plan model loaded');
    await _waitMs(350);await click('#new-session-submit');
    await until('[...sessions.values()].some(s=>s.kind==="deepseek-acp")','created from launch center');
    sid=await c.eval('[...sessions.values()].find(s=>s.kind==="deepseek-acp").id');
    await until(`sessions.get(${j(sid)})?.nativeRuntime?.connection==='connected' && sessions.get(${j(sid)})?.acpSid`,'native authentication and session/new');
    assert.equal(await c.eval('currentView'),'card');
    await until('!!document.querySelector("#msg-overlay .session-welcome")','welcome');
    report.checks.push('physical launch-center click creates and authenticates actual DeepSeek Token Plan Harness');
    await snap('01-created');
    await click('.floating-input-box');await c.send('Input.insertText',{text:'请调用你内置的 ask_user_question 工具，问我页面主色选择蓝色还是红色，给出这两个选项，等待我的回答。请实际调用工具，不要用普通文字代替。得到回答后回复颜色名称。'});await click('.floating-input-send');
    await click('.composer-collapse');
    await until('!!document.querySelector(".codex-native-request button[type=submit]")','question form');
    report.request=await c.eval(`sessions.get(${j(sid)}).nativeRuntime.requests`);
    report.layout=await c.eval(`(()=>{const e=document.querySelector('.codex-native-request');const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,view:currentView,text:e.innerText};})()`);
    await snap('02-question');
    assert(report.layout.width>0 && report.layout.height>0,'pending question remains visible with composer collapsed');
    await c.eval(`(()=>{const f=document.querySelector('.codex-native-request');const s=f.querySelector('select');if(!s)throw Error('Missing choices');s.value=[...s.options].find(o=>/蓝|blue/i.test(o.textContent)).value;s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await click('.codex-native-request button[type=submit]');
    await until(`sessions.get(${j(sid)}).nativeRuntime.state==='completed'`,'question answered');
    report.checks.push('real DSH question answered inside Hub card');
    await snap('02-reply');
    await until('!document.querySelector(".codex-native-request")','answered question removed');
    await click('.composer-expand');
    await click('.floating-input-box');
    await c.send('Input.insertText',{text:'请在当前工作目录创建 20261022-dsh-smoke.txt，内容只有 OK。完成后简短报告。'});
    await click('.floating-input-send');
    const taskCwd=await c.eval(`sessions.get(${j(sid)}).cwd`);
    assert(path.resolve(taskCwd).startsWith(path.resolve(root)+path.sep),'test task stays inside isolated workspace');
    const taskDeadline=Date.now()+120000;
    while(Date.now()<taskDeadline){
      const state=await c.eval(`sessions.get(${j(sid)}).nativeRuntime`);
      assert.equal(state.requests?.length||0,0,'fully specified ordinary task proceeds without questions');
      if(state.state==='failed')throw Error(state.reason||'ordinary task failed');
      if(fs.existsSync(path.join(taskCwd,'20261022-dsh-smoke.txt')) && state.state==='completed')break;
      await _waitMs(150);
    }
    assert.equal(fs.readFileSync(path.join(taskCwd,'20261022-dsh-smoke.txt'),'utf8').trim(),'OK');
    assert.equal(await c.eval(`sessions.get(${j(sid)}).nativeRuntime.state`),'completed');
    report.checks.push('specified file creation completes without questions (one real task)');
    await snap('03-ordinary-task');report.passed=true;
  }catch(error){report.error=error.stack;process.exitCode=1;if(c){report.screen=await c.eval('document.body?.innerText.slice(-2200)');await snap('failure');}}
  finally{if(c)await c.close();if(hub)await gracefulQuit(hub);fs.writeFileSync(configFile,j({acp:{...acp,apiKey:''}}));fs.writeFileSync(path.join(out,'evidence.json'),j(report).split(acp.apiKey).join('[REDACTED]'));console.log(j(report));}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
