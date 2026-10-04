'use strict';
// 助理页（左侧「助理」）真人操作验收：隔离 Hub + 真实百炼快答（Token Plan 优先）。
// 验收：点「助理」显示田哥与助理的对话页（不是 CLI 会话）；后台预热助理会话不会把画面切走；
// 菜单点开再点收起；在输入框说一句简单的话，几秒内快答回复出现在对话里并标明回答者；点「工作台」助理页收起。
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const j=JSON.stringify,wait=ms=>new Promise(r=>setTimeout(r,ms));
const freePort=()=>new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
async function main(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-page-')),data=path.join(root,'data');
 const out=path.resolve('artifacts/assistant-page',new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(out,{recursive:true});fs.mkdirSync(path.join(data,'electron-userdata'),{recursive:true});
 const result={passed:false,scope:'真实隔离 Hub 界面、真实百炼快答；未登录 CLI，助理会话预热只验证不切走画面',out,checks:[]};
 const temporary=[path.join(data,'voice-input.json'),path.join(data,'electron-userdata','Local State'),path.join(data,'config.json')];
 const prod=JSON.parse(fs.readFileSync(path.join(os.homedir(),'.claude-session-hub/config.json'),'utf8').replace(/^﻿/,''));
 fs.copyFileSync(path.join(os.homedir(),'.claude-session-hub/voice-input.json'),temporary[0]);
 fs.copyFileSync(path.join(process.env.APPDATA,'ai-group-chat-hub','Local State'),temporary[1]);
 fs.writeFileSync(temporary[2],j(prod.acp?.apiKey?{acp:{apiKey:prod.acp.apiKey,baseURL:prod.acp.baseURL}}:{}));
 let hub,cdp;
 const until=async(label,read,timeout=30000)=>{for(const end=Date.now()+timeout;Date.now()<end;){const v=await read();if(v)return v;await wait(250);}throw Error('timeout '+label);};
 const click=async selector=>{await until('clickable '+selector,()=>cdp.eval('(()=>{const e=document.querySelector('+j(selector)+');if(!e||e.disabled)return false;const r=e.getBoundingClientRect(),h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.width>0&&(h===e||e.contains(h))})()'),20000);const p=await cdp.eval('(()=>{const r=document.querySelector('+j(selector)+').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()');for(const type of ['mousePressed','mouseReleased'])await cdp.send('Input.dispatchMouseEvent',{type,...p,button:'left',clickCount:1});};
 const shot=async name=>{const r=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(r.data,'base64'));};
 const visible=()=>cdp.eval('!!document.querySelector("#assistant-page:not([hidden])")');
 try{
  hub=await launchIsolatedHub({dataDir:data,port:await freePort(),windowMode:'background',label:'assistant-page',allowExternalState:true,extraEnv:{CLAUDE_HUB_HOME_DIR:path.join(root,'home'),CLAUDE_HUB_E2E:'1',DEEPSEEK_API_KEY:'',OPENAI_API_KEY:'',ANTHROPIC_API_KEY:''}});
  cdp=await connectFirstPage(hub);await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await until('renderer',()=>cdp.eval('typeof assistantPanel!=="undefined"'));
  if(await cdp.eval('document.getElementById("app-container").classList.contains("rail-hidden")'))await click('#btn-toggle-navigation');
  await click('#btn-assistant');await until('assistant page',visible);
  assert.match(await cdp.eval('document.querySelector(".assistant-page .ap-empty")?.innerText||""'),/田哥，我在/);
  assert.equal(await cdp.eval('document.querySelector("#btn-assistant").classList.contains("active")'),true);
  assert.equal(await cdp.eval('document.body.classList.contains("assistant-session-active")'),false,'不是打开 CLI 会话');
  await shot('01-empty');result.checks.push('点「助理」打开助理对话页（空状态），不是 CLI 会话');
  await wait(5000);assert.equal(await visible(),true,'后台预热助理会话后仍停在助理页');
  assert.equal(await cdp.eval('document.querySelector("#btn-assistant").getAttribute("aria-current")==="page" && !document.querySelector("#btn-home").hasAttribute("aria-current") && !document.querySelector("#btn-home").classList.contains("active")'),true,'导航只高亮「助理」');result.checks.push('后台预热助理会话不切走画面，导航只高亮「助理」');
  for(const name of ['front','engine','more']){await click(`[data-ap="${name}"]`);await until(name+' menu',()=>cdp.eval(`document.querySelector(".ap-menu")?.dataset.for===${j(name)}`),5000);await shot('02-menu-'+name);await click(`[data-ap="${name}"]`);await until(name+' menu closed',()=>cdp.eval('!document.querySelector(".ap-menu")'),5000);}
  result.checks.push('回答方式、助理会话、更多三个菜单点开再点收起');
  await click('.ap-composer textarea');await cdp.send('Input.insertText',{text:'一加一等于几？'});
  const t0=Date.now();for(const type of ['keyDown','keyUp'])await cdp.send('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await until('my message',()=>cdp.eval('!!document.querySelector(".assistant-page .ap-msg.me")'),5000);
  const reply=await until('fast reply',()=>cdp.eval('document.querySelector(".assistant-page .ap-msg.ai.fast")?.innerText||null'),30000);
  result.fastReply={text:reply.replace(/\s+/g,' '),ms:Date.now()-t0};assert.match(reply,/2/);assert.match(reply,/千问|DeepSeek/);
  assert.equal(await cdp.eval('document.querySelector(".ap-composer textarea").value'),'','发送后输入框清空');
  assert.match(await cdp.eval('document.querySelector(".assistant-page .ap-msg.me .ap-to")?.innerText||""'),/→ ⚡ 千问|→ ⚡ DeepSeek/,'我的消息下方写明交给了快答');
  assert.equal(await cdp.eval('!!document.querySelector(".assistant-page .ap-again")'),true,'快答下方有「让助理会话再答」');
  await shot('03-fast-reply');
  await click('[data-ap="route"]');assert.equal(await cdp.eval('document.querySelector(".ap-route").innerText'),'交给助理会话');await click('[data-ap="route"]');assert.equal(await cdp.eval('document.querySelector(".ap-route").innerText'),'自动');
  result.checks.push('输入框「自动 / 交给助理会话」开关可切换');
  await click('[data-ap="status"]');await until('status panel',()=>cdp.eval('(()=>{const a=document.querySelector(".ap-status:not([hidden])");return !!a&&/助理会话/.test(a.innerText)&&/记忆/.test(a.innerText)&&/关注的任务/.test(a.innerText)&&/手机/.test(a.innerText)})()'),10000);
  await shot('04-status');result.status=await cdp.eval('document.querySelector(".ap-status").innerText.replace(/\s+/g," ").slice(0,400)');
  result.checks.push('状态栏显示助理会话、上下文、记忆、关注任务、手机');result.checks.push(`电脑上说一句，${result.fastReply.ms}ms 收到快答并标明回答者`);
  await click('#btn-home');await until('page closed',async()=>!(await visible()),5000);result.checks.push('点「工作台」助理页收起');
  await click('#btn-assistant');await until('page reopened with history',()=>cdp.eval('document.querySelectorAll(".assistant-page .ap-msg:not(.typing)").length>=2'),10000);result.checks.push('再进助理页，刚才的对话仍在');
  result.passed=true;
 }catch(e){result.error=e.stack;process.exitCode=1;if(cdp)await shot('failure').catch(()=>{});}
 finally{if(cdp)cdp.close();if(hub){fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));try{await gracefulQuit(hub);}catch(e){result.cleanupError=e.message;}}for(const f of temporary)if(fs.existsSync(f))fs.unlinkSync(f);fs.writeFileSync(path.join(out,'result.json'),j(result,null,1));console.log(j(result,null,1));}
}
main();
