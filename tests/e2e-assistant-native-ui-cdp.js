'use strict';
// Real isolated Hub and shared session UI; AI output is an explicit protocol fixture.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher'),{connectFirstPage}=require('./helpers/cdp-client');
const j=JSON.stringify,wait=ms=>new Promise(r=>setTimeout(r,ms));
const port=()=>new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
async function main(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-native-ui-')),dataDir=path.join(root,'data'),home=path.join(root,'home'),out=path.resolve('artifacts/assistant-native-ui',new Date().toISOString().replace(/[:.]/g,'-'));
 for(const d of [dataDir,home,out])fs.mkdirSync(d,{recursive:true});
 fs.writeFileSync(path.join(dataDir,'config.json'),j({providers:{codex:{backend:'subscription',subscription_profile:'second',subscription_profiles:[{id:'second',label:'隔离主账号',home:path.join(home,'.codex')}]}}}));
 let hub,cdp;const result={passed:false,scope:'真实Hub界面；AI为native协议夹具；语音仅验证设置入口，无真实录音/识别',checks:[],out};
 const until=async(label,expr,timeout=30000)=>{for(const end=Date.now()+timeout;Date.now()<end;){if(await cdp.eval(`Boolean(${expr})`))return;await wait(120);}throw Error('timeout '+label);};
 const click=async(selector,button='left')=>{await until(selector,`(()=>{const e=document.querySelector(${j(selector)});if(!e||e.disabled)return false;const r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.width>0&&r.height>0&&(hit===e||e.contains(hit))})()`);const p=await cdp.eval(`(()=>{const r=document.querySelector(${j(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);for(const type of ['mousePressed','mouseReleased'])await cdp.send('Input.dispatchMouseEvent',{type,...p,button,clickCount:1});};
 const shot=async name=>{const r=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(r.data,'base64'));};
 const trace=()=>fs.existsSync(path.join(root,'trace.jsonl'))?fs.readFileSync(path.join(root,'trace.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
 const key=async(key,code,number,modifiers=0)=>{for(const type of ['keyDown','keyUp'])await cdp.send('Input.dispatchKeyEvent',{type,key,code,windowsVirtualKeyCode:number,modifiers});};
 try{
  hub=await launchIsolatedHub({dataDir,port:await port(),label:'assistant-native-ui',windowMode:'background',extraEnv:{CLAUDE_HUB_HOME_DIR:home,CODEX_HOME:path.join(home,'.codex'),CODEX_SQLITE_HOME:'',CLAUDE_CONFIG_DIR:path.join(home,'.claude'),AI_HUB_WORKSPACE_ROOT:root,CLAUDE_HUB_AGENT_RUNTIME:'native',CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.resolve('tests/fixtures/codex-app-server.js'),CLAUDE_HUB_NATIVE_FIXTURE_STORE:path.join(root,'threads.json'),CLAUDE_HUB_NATIVE_FIXTURE_TRACE:path.join(root,'trace.jsonl'),CLAUDE_HUB_FIXTURE_CONFIG_DIR:path.join(root,'launch-config'),HUB_SESSION_SEARCH_CODEX_ROOTS:path.join(root,'empty'),HUB_SESSION_SEARCH_CLAUDE_ROOTS:path.join(root,'empty'),HUB_SESSION_SEARCH_KIMI_ROOTS:path.join(root,'empty'),HUB_SESSION_SEARCH_GEMINI_ROOTS:path.join(root,'empty'),DEEPSEEK_API_KEY:''}});
  cdp=await connectFirstPage(hub);result.pid=hub.pid;await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await until('renderer','typeof assistantPanel!=="undefined"');await cdp.eval('localStorage.setItem("hub.assistant.chat-draft","旧助理尚未发送的草稿")');
  await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:5,y:90});await click('#rail-pin');await click('#btn-assistant');await click('[data-ap="more"]');await click('.ap-menu [data-pick="session"]');
  await until('ordinary surface','document.body.classList.contains("assistant-session-active") && !!document.querySelector("#terminal-panel .floating-input-box")');
  const id=await cdp.eval('activeSessionId');result.sessionId=id;
  assert.equal(await cdp.eval('sessions.get(activeSessionId).purpose'),'hub-assistant');assert.equal(await cdp.eval('currentView'),'card');
  assert.equal(await cdp.eval('document.querySelectorAll(".floating-input-bar").length'),1);assert.equal(await cdp.eval('!!document.querySelector("#assistant-page:not([hidden])")'),false,'打开助理会话后助理页收起');
  assert.match(await cdp.eval('document.querySelector(".floating-input-box").textContent'),/旧助理尚未发送的草稿/);assert.equal(await cdp.eval('localStorage.getItem("hub.assistant.chat-draft")'),null);
  await until('native binding','sessions.get(activeSessionId)?.nativeRuntime?.connection==="connected"');
  assert.equal(trace().filter(r=>r.method==='thread/start').length,1);assert.equal(trace().filter(r=>r.method==='turn/start').length,0);
  await shot('01-ordinary-composer');result.checks.push('直接选中普通实体，唯一普通输入框与卡片；旧草稿迁移，打开不发模型请求');
  await until('controls','!!document.querySelector(".voice-mic") && !document.querySelector(".composer-model").hidden');await click('.voice-mic','right');await until('voice settings','!!document.querySelector(".voice-settings-dialog")');await shot('02-reused-voice');await click('.voice-settings .voice-actions button:last-child');
  result.checks.push('普通语音按钮和设置可打开；未真实录音或调用识别');
  await click('.composer-model');await until('model picker','!!document.querySelector(".model-picker-menu")');await shot('03-reused-model-picker');
  await click('#hub-version');await until('model picker closed','!document.querySelector(".model-picker-menu")');
  result.checks.push('点击普通模型选择器可展开；模型及思考控件复用');
  await click('.floating-input-box');await key('a','KeyA',65,2);await cdp.send('Input.insertText',{text:'现在最近有哪些进展？'});await until('new draft replaced old','document.querySelector(".floating-input-box").textContent==="现在最近有哪些进展？"');await click('.floating-input-send');
  await until('normal card','document.querySelector("#msg-overlay .turn-card.assistant")?.textContent.includes("原生回答")',60000);
  assert.equal(trace().filter(r=>r.method==='turn/start').length,1);assert.match(trace().find(r=>r.method==='turn/start').params.input.map(i=>i.text||'').join(''),/AI_HUB_ASSISTANT_CONTEXT_V1/);
  assert.equal(await cdp.eval('document.querySelector(".turn-card.user .turn-body").textContent.includes("现在最近有哪些进展？")'),true);assert.match(await cdp.eval('document.querySelector(".turn-card.assistant .turn-avatar img").getAttribute("src")'),/penguin/);
  await shot('04-normal-cards');result.checks.push('普通发送/回执/卡片读原生回复；上下文仍注入，头像为企鹅');
  await click('#btn-backstage');await until('terminal','currentView==="pty"');await click('#btn-backstage');await until('cards','currentView==="card"');assert.equal(trace().filter(r=>r.method==='thread/start').length,1);
  result.checks.push('普通后台按钮切换同一终端与卡片，不另建运行时');
  await click('.floating-input-box');await cdp.send('Input.insertText',{text:'助理下一轮的草稿'});
  fs.mkdirSync(path.join(root,'ordinary'),{recursive:true});
  const ordinary=await cdp.eval(`ipcRenderer.invoke('create-session',{kind:'codex',opts:{title:'普通会话隔离对照',cwd:${j(path.join(root,'ordinary'))},mcpProfile:'none'}})`);
  // Background creation intentionally preserves the assistant; select the normal sidebar row explicitly.
  await until('normal row',`!!document.querySelector('[data-session-id="${ordinary.id}"]')`);await click(`[data-session-id="${ordinary.id}"]`);await until('normal selected',`activeSessionId===${j(ordinary.id)}`);
  assert.equal(await cdp.eval('document.getElementById("terminal-panel").classList.contains("assistant-session")'),false);
  await click('.floating-input-box');await cdp.send('Input.insertText',{text:'普通会话独立草稿'});await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:5,y:90});await click('#btn-assistant');await until('assistant returns',`activeSessionId===${j(id)}`);
  assert.match(await cdp.eval('document.querySelector(".floating-input-box").textContent'),/助理下一轮的草稿/);assert.doesNotMatch(await cdp.eval('document.querySelector(".floating-input-box").textContent'),/普通会话独立草稿/);
  await until('ordinary native binding',`sessions.get(${j(ordinary.id)})?.nativeRuntime?.connection==="connected"`);assert.equal(trace().filter(r=>r.method==='thread/start').length,2);
  result.checks.push('普通会话样式正常，返回同一助理实体；双方草稿独立');
  await click('.assistant-notifications summary');await until('folded notices','document.querySelector(".assistant-notifications").open');await click('.assistant-notifications summary');result.checks.push('新回复入口折叠在普通工具栏，无第二个聊天页');
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1050,height:800,deviceScaleFactor:1,mobile:false});await wait(250);await shot('05-final-compact');assert.equal(await cdp.eval('document.documentElement.scrollWidth>innerWidth'),false);result.checks.push('较窄窗口无页面横向溢出');result.passed=true;
 }catch(error){result.error=error.stack;process.exitCode=1;if(cdp)await shot('failure').catch(()=>{});}
 finally{if(cdp)cdp.close();if(hub){fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));result.exit=await gracefulQuit(hub);}fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2),'utf8');console.log(JSON.stringify(result));}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
