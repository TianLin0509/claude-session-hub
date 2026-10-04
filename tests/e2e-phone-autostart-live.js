'use strict';
// 用户真实顺序：在 Hub 里配对手机 → 关掉 Hub → 再打开 Hub，且不再点开「手机连接」面板。
// 验收：重开后手机端（按 App 协议直连真实云中继）看到电脑在线，发一条简单问题能在几秒内收到答复。
// 2026-10-04 田哥报告「Hub 开着，手机却显示没在线」：启动时恢复手机连接早于系统安全存储就绪，静默失败。
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const {seal,open}=require('../core/hub-phone/crypto');
const j=JSON.stringify,wait=ms=>new Promise(r=>setTimeout(r,ms));
const freePort=()=>new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
function phone(code){
 const c=JSON.parse(Buffer.from(code.replace(/^AIH1\./,''),'base64url').toString('utf8'));let cursor=0;const inbox=[];
 const call=async(route,body)=>{const r=await fetch(c.url+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+c.token,'Content-Type':'application/json'},body:body&&j(body),signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error('relay '+route+' '+r.status);return r.json();};
 return{inbox,
  async send(value){const id=crypto.randomUUID();await call('/send',{channel:c.channel,role:'phone',id,payload:seal(c.key,c.channel,id,'phone',value)});return id;},
  async poll(){const r=await call('/poll?channel='+c.channel+'&role=phone&after='+cursor);for(const p of r.messages){if(p.seq<=cursor)continue;cursor=p.seq;inbox.push({...open(c.key,c.channel,p.id,'hub',p.payload),receivedAt:Date.now()});}return r.online;},
 };
}
async function main(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'phone-autostart-')),data=path.join(root,'data');
 const out=path.resolve('artifacts/phone-autostart-live',new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(out,{recursive:true});
 fs.mkdirSync(path.join(data,'electron-userdata'),{recursive:true});
 const result={passed:false,scope:'真实隔离 Hub（两次启动）、真实云中继、真实百炼快速通道；手机端为协议级模拟',root,out,checks:[]};
 // 语音/快速通道 Key 与对应本地密钥只读复制进隔离目录，结束即删；Token Plan 套餐 Key 只写入隔离 config。
 const temporary=[path.join(data,'voice-input.json'),path.join(data,'electron-userdata','Local State'),path.join(data,'config.json')];
 const prodCfg=JSON.parse(fs.readFileSync(path.join(os.homedir(),'.claude-session-hub/config.json'),'utf8').replace(/^﻿/,''));
 fs.copyFileSync(path.join(os.homedir(),'.claude-session-hub/voice-input.json'),temporary[0]);
 fs.copyFileSync(path.join(process.env.APPDATA,'ai-group-chat-hub','Local State'),temporary[1]);
 fs.writeFileSync(temporary[2],j(prodCfg.acp?.apiKey?{acp:{apiKey:prodCfg.acp.apiKey,baseURL:prodCfg.acp.baseURL}}:{}));
 const env={CLAUDE_HUB_HOME_DIR:path.join(root,'home'),CLAUDE_HUB_E2E:'1',DEEPSEEK_API_KEY:'',OPENAI_API_KEY:'',ANTHROPIC_API_KEY:''};
 const launch=async label=>{const hub=await launchIsolatedHub({dataDir:data,port:await freePort(),windowMode:'background',label,allowExternalState:true,extraEnv:env});const cdp=await connectFirstPage(hub);
  for(const end=Date.now()+60000;Date.now()<end;){if(await cdp.eval('typeof assistantPanel!=="undefined"').catch(()=>false))break;await wait(300);}return{hub,cdp};};
 let first,second;
 try{
  // 1. 第一次启动：在界面里配对（与用户操作一致）
  first=await launch('phone-autostart-1');
  const code=await first.cdp.eval('ipcRenderer.invoke("assistant:phone-pair").then(r=>r.code||JSON.stringify(r))');
  assert.match(code,/^AIH1\./,'配对失败：'+code);result.checks.push('第一次启动配对成功');
  first.cdp.close();fs.writeFileSync(path.join(out,'hub-1.log'),first.hub.log().join('\n'));await gracefulQuit(first.hub);first=null;
  const savedAt=fs.statSync(path.join(data,'assistant','phone','channel.bin')).mtimeMs;
  // 先等中继把电脑判为离线（在线窗口 40 秒），否则第二次启动的「在线」可能只是第一次的余温。
  const p=phone(code);let offline=false;
  for(const end=Date.now()+70000;Date.now()<end&&!offline;){offline=!(await p.poll());if(!offline)await wait(3000);}
  assert.ok(offline,'关掉 Hub 70 秒后中继仍显示在线');result.checks.push('关掉 Hub 后手机端显示电脑离线');
  // 2. 第二次启动：不碰手机面板，不调任何手机接口
  second=await launch('phone-autostart-2');const started=Date.now();
  let online=false;
  for(const end=Date.now()+45000;Date.now()<end&&!online;){online=await p.poll();if(!online)await wait(2000);}
  result.onlineAfterMs=online?Date.now()-started:null;
  assert.ok(online,'重开 Hub 后 45 秒内手机端仍显示电脑不在线');result.checks.push('重开 Hub 不点手机面板，手机端看到电脑在线（'+result.onlineAfterMs+'ms）');
  assert.ok(fs.statSync(path.join(data,'assistant','phone','channel.bin')).mtimeMs>savedAt,'重开后没有加载手机连接记录');
  // 3. 简单问题走快速通道，几秒内答复
  const sentAt=Date.now(),id=await p.send({type:'text',text:'一加一等于几？'});let answer=null;
  for(const end=Date.now()+30000;Date.now()<end&&!answer;){await p.poll();answer=p.inbox.find(m=>m.type==='answer'&&m.requestId===id);if(!answer)await wait(500);}
  assert.ok(answer,'30 秒内没收到答复');result.answer={text:answer.text,lane:answer.lane,ms:answer.receivedAt-sentAt};
  assert.equal(answer.lane,'fast');result.checks.push('简单问题 '+result.answer.ms+'ms 收到快速通道答复：'+answer.text);
  result.passed=true;
 }catch(e){result.error=e.stack;process.exitCode=1;}
 finally{
  for(const h of [first,second].filter(Boolean)){try{h.cdp.close();}catch{}fs.writeFileSync(path.join(out,(h===first?'hub-1':'hub-2')+'.log'),h.hub.log().join('\n'));try{await gracefulQuit(h.hub);}catch(e){result.cleanupError=e.message;}}
  for(const f of temporary)if(fs.existsSync(f))fs.unlinkSync(f);
  fs.writeFileSync(path.join(out,'result.json'),j(result,null,1));console.log(j(result,null,1));
 }
}
main();
