'use strict';
// Real isolated Electron UI. Local PTY fixtures plus controlled transcript/receipt
// responses reproduce first-binding-before-writeback without a cloud AI request.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const assert=require('node:assert/strict');
const {launchIsolatedHub,gracefulQuit,_waitMs}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const j=JSON.stringify,baseline=process.argv.includes('--baseline');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-first-send-'));
const data=path.join(root,'data'),work=path.join(root,'work'),bin=path.join(root,'bin');
const out=path.resolve('output/playwright/20261014-first-send-codex1',baseline?'before':'after');
for(const dir of [data,work,bin,out])fs.mkdirSync(dir,{recursive:true});
const cli=path.join(bin,'welcome.js');
fs.writeFileSync(cli,`if(process.argv.includes('--version'))console.log('fixture 0.0.0');else {process.stdout.write('What brings you to this corner?\\r\\n› \\r\\n');setInterval(()=>{},1000);}`);
for(const name of ['claude','codex','gemini','kimi'])fs.writeFileSync(path.join(bin,name+'.cmd'),`@echo off\r\n"${process.execPath}" "${cli}" %*\r\n`);
fs.writeFileSync(path.join(data,'config.json'),j({runtime:{agent:'pty'},providers:{deepseek:{api_key:'unused-local-fixture'},codex:{backend:'subscription',subscription_profiles:[{id:'default',home:path.join(root,'codex')}]}}}));
const report={passed:false,boundary:'真实隔离 Hub 界面点击发送；CLI、送达回执与延迟记录均为本地夹具，不调用云端模型。',checks:[],sessions:[],screenshots:[]};
let hub,c;
const until=async(expr,label)=>{for(const end=Date.now()+30000;Date.now()<end;){if(await c.eval(expr))return;await _waitMs(80);}throw Error('timeout: '+label);};
const click=async(selector)=>{const p=await c.eval(`(()=>{const e=document.querySelector(${j(selector)});e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);for(const type of ['mousePressed','mouseReleased'])await c.send('Input.dispatchMouseEvent',{type,...p,button:'left',clickCount:1});};
const shot=async(name)=>{const file=path.join(out,name+'.png'),result=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(file,Buffer.from(result.data,'base64'));report.screenshots.push(file);};
(async()=>{try{
  const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
  hub=await launchIsolatedHub({dataDir:data,port,windowMode:'background',label:'first-send-stability',extraEnv:{
    CLAUDE_HUB_E2E:'1',CLAUDE_HUB_AGENT_RUNTIME:'pty',AI_HUB_WORKSPACE_ROOT:root,
    CLAUDE_HUB_ACCOUNT_FIXTURE:path.resolve('tests/fixtures/account-center-cli.js'),
    CODEX_HOME:path.join(root,'codex'),CLAUDE_CONFIG_DIR:path.join(root,'claude'),
    GEMINI_CLI_HOME:path.join(root,'gemini'),KIMI_CODE_HOME:path.join(root,'kimi'),KIMI_BIN:path.join(bin,'kimi.cmd'),
    PATH:bin+path.delimiter+process.env.PATH}});
  c=await connectFirstPage(hub);await until('!!window.__hubE2E','renderer');
  await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:950,deviceScaleFactor:1,mobile:false});
  await c.eval(`window.__firstSendFixtures=new Map();window.__firstSendCalls=[];window.__firstSendErrors=[];
    addEventListener('error',e=>window.__firstSendErrors.push(String(e.error||e.message)));
    const firstSendInvoke=ipcRenderer.invoke.bind(ipcRenderer);
    ipcRenderer.invoke=(channel,...args)=>{
      const fixture=window.__firstSendFixtures.get(args[0]?.hubSessionId||args[0]?.sessionId);
      if(fixture&&channel==='parse-session-transcript')return Promise.resolve({turns:fixture.turns,error:null});
      if(fixture&&channel==='session:send-prompt'){window.__firstSendCalls.push(args[0]);return Promise.resolve({ok:true});}
      return firstSendInvoke(channel,...args);
    };`);
  for(const kind of ['claude','codex','gemini','kimi','deepseek']){
    const s=await c.eval(`ipcRenderer.invoke('create-session',${j({kind,opts:{cwd:work,mcpProfile:'none'}})})`);
    assert(s.id);const sid=s.id;
    await until(`activeSessionId===${j(sid)}&&!!document.querySelector('#msg-overlay>.session-welcome')`,'welcome '+kind);
    await c.eval(`window.__firstSendFixtures.set(${j(sid)},{turns:[]})`);
    await click('.floating-input-box');await c.send('Input.insertText',{text:kind+' 首条消息保持可见'});
    await click('.floating-input-send');
    await until(`!!document.querySelector('#msg-overlay>.turn-card[data-optimistic="true"]')`,'immediate user card');
    assert(await c.eval(`window.__firstSendCalls.some(v=>v.sessionId===${j(sid)})`),'actual send button dispatch');
    await c.eval(`window.__firstSendTimeline=[];
      window.__firstSendSample=()=>{const el=document.querySelector('#msg-overlay'),w=el.querySelector('.session-welcome');
        const frame={welcome:!!w&&w.getBoundingClientRect().height>0,cards:el.querySelectorAll(':scope>.turn-card').length,view:currentView};
        const prev=window.__firstSendTimeline.at(-1);if(!prev||JSON.stringify(prev.state)!==JSON.stringify(frame))window.__firstSendTimeline.push({ms:Math.round(performance.now()),state:frame});};
      window.__firstSendObserver=new MutationObserver(window.__firstSendSample);
      window.__firstSendObserver.observe(document.querySelector('#msg-overlay'),{childList:true,subtree:true,attributes:true});
      window.__firstSendTimer=setInterval(window.__firstSendSample,16);window.__firstSendSample();`);
    const binding={hubSessionId:sid,transcriptPath:path.join(root,kind+'-first.jsonl')};
    if(kind==='codex'||kind==='deepseek')binding.codexSid='native-'+sid;
    if(kind==='gemini')binding.geminiChatId='native-'+sid;
    if(kind==='kimi')binding.kimiSid='native-'+sid;
    await c.eval(`ipcRenderer.emit('session-meta-updated',{},${j(binding)})`);
    await _waitMs(1800);await shot(kind+'-waiting-for-writeback');
    await c.eval(`window.__firstSendFixtures.get(${j(sid)}).turns=${j([
      {id:kind+'-user',role:'user',text:kind+' 首条消息保持可见',ts:Date.now(),kind},
      {id:kind+'-answer',role:'assistant',text:'延迟落盘后显示的回答 '+kind,ts:Date.now(),kind}
    ])};loadSessionHistoryToOverlay(${j(sid)},{incremental:true})`);
    await until(`document.querySelector('#msg-overlay').innerText.includes('延迟落盘后显示的回答')`,'projected answer');
    await _waitMs(250);
    const timeline=await c.eval(`(()=>{clearInterval(window.__firstSendTimer);window.__firstSendObserver.disconnect();return window.__firstSendTimeline;})()`);
    report.sessions.push({kind,timeline});
    const regressed=timeline.some(f=>f.state.welcome||f.state.cards===0||f.state.view!=='card');
    assert.equal(regressed,baseline,kind+(baseline?': baseline reproduces flicker':': cards never disappear or return to welcome'));
    assert.equal(await c.eval('document.querySelectorAll("#msg-overlay>.turn-card.user").length'),1,'authoritative user replaces optimistic card exactly once');
    report.checks.push(kind+(baseline?'：已复现卡片消失和欢迎页闪回':'：发送立即出卡，绑定及 1.8 秒延迟期间始终保留，权威记录替换后无重复'));
    if(!baseline){
      await click('#btn-backstage');await click('#btn-backstage');
      await until(`currentView==='card'&&document.querySelector('#msg-overlay').innerText.includes('延迟落盘后显示的回答')`,'backstage round trip');
      assert.equal(await c.eval('document.querySelectorAll("#msg-overlay>.turn-card.user").length'),1);
    }
    await shot(kind+'-answer');
  }
  assert.deepEqual(await c.eval('window.__firstSendErrors'),[]);
  report.passed=true;console.log(j(report.checks));
}finally{fs.writeFileSync(path.join(out,'20261014-first-send-evidence-codex1.json'),j(report));await c?.close();if(hub)await gracefulQuit(hub);}})().catch(e=>{console.error(e.stack);process.exitCode=1;});
