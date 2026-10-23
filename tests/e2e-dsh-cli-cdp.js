'use strict';
// Opt-in real subscription test; only this test's Hub/profile is changed.
const fs=require('fs'),path=require('path'),os=require('os'),net=require('net'),assert=require('assert/strict');
const {launchIsolatedHub,gracefulQuit,_waitMs}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const j=JSON.stringify;
async function main(){
  if(!process.env.HUB_ACP_LIVE_CONFIG)throw Error('HUB_ACP_LIVE_CONFIG required');
  const live=JSON.parse(fs.readFileSync(process.env.HUB_ACP_LIVE_CONFIG,'utf8'));
  const acp={...live.acp,providers:{...live.acp.providers,'deepseek-acp':{...live.acp.providers['deepseek-acp'],cliRoot:process.env.AI_HUB_DSH_CLI_ROOT}}}, route=process.env.HUB_DSH_ROUTE||'tokenplan';
  if(route==='api')assert(live.providers?.deepseek?.api_key||live.deepseekApiKey,'live API credential required');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-deepseek-start-')),data=path.join(root,'data');
  const out=path.resolve('artifacts','20261023-dsh-cli-codex-'+Date.now());
  fs.mkdirSync(data);fs.mkdirSync(out,{recursive:true});
  const configFile=path.join(data,'config.json');fs.writeFileSync(configFile,j({acp,providers:{deepseek:{api_key:live.providers?.deepseek?.api_key||live.deepseekApiKey||''}}}));
  let hub,c,sid;const report={passed:false,checks:[],out};
  const until=async(expr,label)=>{const deadline=Date.now()+120000;while(Date.now()<deadline){
    if(await c.eval(`Boolean(${expr})`))return;
    if(sid){const reason=await c.eval(`(sessions.get(${j(sid)})?.cliRuntime?.connection==='disconnected' || sessions.get(${j(sid)})?.cliRuntime?.state==='failed') && sessions.get(${j(sid)}).cliRuntime.reason`);if(reason)throw Error(reason);}
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
    await until('!document.querySelector("#new-session-deepseek-route-field").hidden','consumption channel visible');
    await c.eval(`(()=>{const el=document.querySelector('#new-session-deepseek-route');el.value=${j(route)};el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    assert.equal(await c.eval("document.querySelector('#new-session-deepseek-route').value"),route);
    await snap('00-channel-'+route);
    await _waitMs(350);await click('#new-session-submit');
    await until('[...sessions.values()].some(s=>s.kind==="deepseek-acp")','created from launch center');
    sid=await c.eval('[...sessions.values()].find(s=>s.kind==="deepseek-acp").id');
    await until(`sessions.get(${j(sid)})?.cliRuntime?.connection==='connected' && sessions.get(${j(sid)})?.acpSid`,'native authentication and session/new');
    assert.equal(await c.eval('currentView'),'card');
    await until('!!document.querySelector("#msg-overlay .session-welcome")','welcome');
    assert.equal(await c.eval(`sessions.get(${j(sid)}).agentRuntime`),'pty'); assert.equal(await c.eval(`sessions.get(${j(sid)}).runtimeBackend`),null); report.checks.push('real DSH CLI + PTY without ACP');
    await snap('01-created');
    const expectedPrefix=route==='api'?'deepseek-api:':'aliyun-token-plan:';
    assert.equal(await c.eval(`sessions.get(${j(sid)}).deepseekRoute`),route);
    assert.equal(await c.eval(`sessions.get(${j(sid)}).acpProfileId`),expectedPrefix+'deepseek-acp');
    await click('.floating-input-box');await c.send('Input.insertText',{text:'只回复 OK'});await click('.floating-input-send');
    await until(`sessions.get(${j(sid)}).cliRuntime.state==='completed'`,'real reply');
    assert.equal(await c.eval(`sessions.get(${j(sid)}).acpProfileId`),expectedPrefix+'deepseek-acp');
    report.checks.push(route+' selected in launch center and retained after real DSH reply');
    await until(`Array.from(document.querySelectorAll('#msg-overlay .turn-card.assistant')).some(e=>e.textContent.includes('OK'))`,'visible native reply card');
    await snap('02-reply-'+route);
    await c.eval(`applyViewMode('pty')`);
    await until(`document.querySelector('.xterm-screen')?.getBoundingClientRect().height>0`,'real terminal visible');
    await _waitMs(600);
    await snap('03-native-terminal-'+route);report.passed=true;
  }catch(error){report.error=error.stack;process.exitCode=1;if(c){report.screen=await c.eval('document.body?.innerText.slice(-2200)');await snap('failure');}}
  finally{if(c)await c.close();if(hub)await gracefulQuit(hub);fs.writeFileSync(configFile,j({acp:{...acp,apiKey:''}}));fs.writeFileSync(path.join(out,'evidence.json'),j(report).split(acp.apiKey).join('[REDACTED]'));console.log(j(report));}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
