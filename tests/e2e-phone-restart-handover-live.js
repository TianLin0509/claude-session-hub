'use strict';
// Hub 重启时新旧进程重叠（2026-10-15）：新进程等旧进程退出才接手手机通道，重叠期间不收发、不写 channel.bin；
// 旧进程退出后几秒内接手，手机发来的消息照常答复。用真实隔离 Hub ×2、真实云中继，手机端为协议级模拟。
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const {seal,open}=require('../core/hub-phone/crypto');
const j=JSON.stringify,wait=ms=>new Promise(r=>setTimeout(r,ms));
const freePort=()=>new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
function phone(code){
 const c=JSON.parse(Buffer.from(code.replace(/^AIH1\./,''),'base64url').toString('utf8'));let cursor=0;const inbox=[];
 const call=async(route,body)=>{const r=await fetch(c.url+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+c.token,'Content-Type':'application/json'},body:body&&j(body),signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error('relay '+r.status);return r.json();};
 return{inbox,
  async send(value){const id=crypto.randomUUID();await call('/send',{channel:c.channel,role:'phone',id,payload:seal(c.key,c.channel,id,'phone',value)});return id;},
  async poll(){const r=await call('/poll?channel='+c.channel+'&role=phone&after='+cursor);for(const p of r.messages){if(p.seq<=cursor)continue;cursor=p.seq;inbox.push({...open(c.key,c.channel,p.id,'hub',p.payload),receivedAt:Date.now()});}return r.online;},
 };
}
async function main(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'phone-handover-')),data=path.join(root,'data');
 const out=path.resolve('artifacts/phone-restart-handover',new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(out,{recursive:true});
 fs.mkdirSync(path.join(data,'electron-userdata'),{recursive:true});
 const result={passed:false,scope:'真实隔离 Hub ×2（重叠运行）、真实云中继；手机端为协议级模拟',root,out,checks:[]};
 const localState=path.join(data,'electron-userdata','Local State');
 fs.copyFileSync(path.join(process.env.APPDATA,'ai-group-chat-hub','Local State'),localState);
 const env={CLAUDE_HUB_HOME_DIR:path.join(root,'home'),CLAUDE_HUB_E2E:'1',HUB_ASSISTANT_FAST_LANE:'0',DEEPSEEK_API_KEY:'',OPENAI_API_KEY:'',ANTHROPIC_API_KEY:''};
 const launch=async label=>{const hub=await launchIsolatedHub({dataDir:data,port:await freePort(),windowMode:'background',label,allowExternalState:true,extraEnv:env});const cdp=await connectFirstPage(hub);
  for(const end=Date.now()+60000;Date.now()<end;){if(await cdp.eval('typeof assistantPanel!=="undefined"').catch(()=>false))break;await wait(300);}return{hub,cdp};};
 const status=h=>h.cdp.eval('ipcRenderer.invoke("assistant:phone-status").then(r=>JSON.stringify(r))').then(JSON.parse);
 const bin=path.join(data,'assistant','phone','channel.bin');
 let first,second;
 try{
  first=await launch('phone-handover-1');
  const code=await first.cdp.eval('ipcRenderer.invoke("assistant:phone-pair").then(r=>r.code||JSON.stringify(r))');
  assert.match(code,/^AIH1\./,'配对失败：'+code);result.checks.push('旧 Hub 配对成功');
  const p=phone(code);
  const hello=await p.send({type:'hello',app:'e2e',caps:['profile']});
  for(const end=Date.now()+20000;Date.now()<end&&!p.inbox.some(m=>m.type==='profile');){await p.poll();await wait(500);}
  assert.ok(p.inbox.some(m=>m.type==='profile'),'旧 Hub 没回 hello');result.checks.push('旧 Hub 正常收发');

  // 重叠：旧 Hub 不退，新 Hub 启动
  second=await launch('phone-handover-2');
  for(const end=Date.now()+20000;Date.now()<end;){const st=await status(second);if(st.waitingForPreviousHub)break;await wait(500);}
  const waiting=await status(second);
  assert.equal(waiting.waitingForPreviousHub,true,'新 Hub 没有等待旧 Hub：'+j(waiting));result.checks.push('重叠期间新 Hub 显示「等旧窗口退出」');
  const mtime=fs.statSync(bin).mtimeMs,lock=JSON.parse(fs.readFileSync(path.join(data,'assistant','phone','channel.lock'),'utf8'));
  assert.equal(lock.pid,first.hub.pid??lock.pid,'锁不在旧 Hub 手里');
  const during=await p.send({type:'hello',app:'e2e-during',caps:['profile']});
  for(const end=Date.now()+15000;Date.now()<end&&!p.inbox.some(m=>m.type==='profile'&&m.requestId===during);){await p.poll();await wait(500);}
  assert.ok(p.inbox.some(m=>m.type==='profile'&&m.requestId===during),'重叠期间旧 Hub 应继续负责');result.checks.push('重叠期间仍由旧 Hub 答复');
  const st2=await status(second);assert.equal(st2.waitingForPreviousHub,true,'新 Hub 不应在旧 Hub 存活时接手');

  // 旧 Hub 退出 → 新 Hub 接手
  first.cdp.close();fs.writeFileSync(path.join(out,'hub-1.log'),first.hub.log().join('\n'));const quitAt=Date.now();await gracefulQuit(first.hub);first=null;
  let took=null;for(const end=Date.now()+20000;Date.now()<end&&!took;){const st=await status(second);if(!st.waitingForPreviousHub)took=Date.now()-quitAt;else await wait(500);}
  assert.ok(took!=null,'旧 Hub 退出 20 秒后新 Hub 仍未接手');result.handoverMs=took;result.checks.push('旧 Hub 退出后 '+took+'ms 新 Hub 接手');
  const after=await p.send({type:'hello',app:'e2e-after',caps:['profile']});
  for(const end=Date.now()+20000;Date.now()<end&&!p.inbox.some(m=>m.type==='profile'&&m.requestId===after);){await p.poll();await wait(500);}
  assert.ok(p.inbox.some(m=>m.type==='profile'&&m.requestId===after),'新 Hub 接手后没回消息');result.checks.push('新 Hub 接手后正常答复');
  assert.ok(fs.statSync(bin).mtimeMs>=mtime,'channel.bin 时间异常');
  const dup=p.inbox.filter(m=>m.type==='profile'&&[hello,during,after].includes(m.requestId)).map(m=>m.requestId);
  assert.equal(new Set(dup).size,dup.length,'同一条手机消息被两个 Hub 重复答复：'+j(dup));result.checks.push('三条手机消息各只答复一次');
  result.passed=true;
 }catch(e){result.error=e.stack;process.exitCode=1;}
 finally{
  for(const h of [first,second].filter(Boolean)){try{h.cdp.close();}catch{}fs.writeFileSync(path.join(out,(h===first?'hub-1':'hub-2')+'.log'),h.hub.log().join('\n'));try{await gracefulQuit(h.hub);}catch(e){result.cleanupError=e.message;}}
  if(fs.existsSync(localState))fs.unlinkSync(localState);
  fs.writeFileSync(path.join(out,'result.json'),j(result,null,1));console.log(j(result,null,1));
 }
}
main();
