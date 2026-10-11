'use strict';
// 隔离真实 Hub + 真实 Claude PTY + 云中继；手机端是协议客户端，图片为合成算式。
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const {getFreePort,click,waitFor}=require('./helpers/usage-refresh-fixture');
const {AssistantStore}=require('../core/hub-assistant/store');
const {seal,open}=require('../core/hub-phone/crypto');
const j=JSON.stringify,sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'photo-assistant-live-')),data=path.join(root,'data'),claude=path.join(root,'claude'),work=path.join(root,'work');
 const out=path.resolve('artifacts/20261011-photo-assistant-codex1');for(const d of [data,claude,work,out])fs.mkdirSync(d,{recursive:true});
 const authSource=path.join(process.env.CLAUDE_CONFIG_DIR||path.join(os.homedir(),'.claude'),'.credentials.json'),auth=path.join(claude,'.credentials.json');
 const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'),before=hash(authSource);fs.copyFileSync(authSource,auth);
 fs.writeFileSync(path.join(claude,'.claude.json'),j({hasCompletedOnboarding:true,theme:'light',skipDangerousModePermissionPrompt:true,projects:{[work]:{hasTrustDialogAccepted:true}}}));
 const hooks=require('../core/claude-hook-integration').ensureClaudeHookIntegration({claudeDir:claude,sourceScriptsDir:path.resolve('scripts'),logger:{log(){},warn(){}}});assert.equal(hooks.errors.length,0);
 fs.writeFileSync(path.join(data,'config.json'),j({models:{defaults:{claude:'claude-sonnet-5-5'}}}));
 const store=new AssistantStore(path.join(data,'assistant'));store.set('assistantDefaultsVersion',2);store.set('backendKind','claude');store.set('profile:claude',{model:'claude-sonnet-5-5',effort:'low'});store.close();
 const report={passed:false,root,scope:'隔离真实 Hub、Claude Sonnet 5.5 低思考、真实云中继；协议模拟手机上传合成图片',checks:[]};let hub,c;
 const until=async(label,fn,timeout=180000)=>{for(const end=Date.now()+timeout;Date.now()<end;){const v=await fn();if(v)return v;await sleep(700);}throw Error('timeout: '+label);};
 const shot=async name=>{const r=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(r.data,'base64'));};
 try{
  hub=await launchIsolatedHub({dataDir:data,port:await getFreePort(),windowMode:'background',label:'photo-assistant-live',extraEnv:{CLAUDE_HUB_E2E:'1',CLAUDE_CONFIG_DIR:claude,CODEX_HOME:path.join(root,'codex'),CLAUDE_HUB_AGENT_RUNTIME:'pty',CLAUDE_HUB_NO_FAST:'1',AI_HUB_WORKSPACE_ROOT:work,ANTHROPIC_API_KEY:'',OPENAI_API_KEY:'',HUB_ASSISTANT_FAST_LANE:'0',HUB_SESSION_SEARCH_CLAUDE_ROOTS:path.join(root,'empty'),HUB_SESSION_SEARCH_CODEX_ROOTS:path.join(root,'empty')}});
  c=await connectFirstPage(hub);await waitFor(c,'typeof assistantPanel!=="undefined"');await c.send('Emulation.setDeviceMetricsOverride',{width:1300,height:950,deviceScaleFactor:1,mobile:false});
  const p=await c.eval('ipcRenderer.invoke("assistant:phone-pair")');assert(p.code?.startsWith('AIH1.'),'pairing failed');const phone=JSON.parse(Buffer.from(p.code.slice(5),'base64url').toString('utf8'));
  const req=async(route,body)=>{const r=await fetch(phone.url+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+phone.token,'Content-Type':'application/json'},body:body&&j(body),signal:AbortSignal.timeout(25000)});assert(r.ok,'relay '+r.status);return r.json();};
  const image=await c.eval(`(()=>{const c=document.createElement('canvas');c.width=1200;c.height=600;const x=c.getContext('2d');x.fillStyle='white';x.fillRect(0,0,1200,600);x.fillStyle='black';x.font='72px Arial';x.fillText('Calculate:',80,170);x.font='112px Arial';x.fillText('43 x 19 = ?',80,350);return c.toDataURL('image/jpeg',0.97).split(',')[1]})()`);
  fs.writeFileSync(path.join(out,'20261011-question-codex1.jpg'),Buffer.from(image,'base64'));
  const id=crypto.randomUUID();await req('/send',{channel:phone.channel,role:'phone',id,payload:seal(phone.key,phone.channel,id,'phone',{type:'text',to:'assistant',text:'读取照片里的算式，给出答案和简短计算步骤。',attachment:{name:'capture-'+id+'.jpg',data:image}})});
  const sid=await until('dedicated sidebar session',()=>c.eval('Array.from(sessions.values()).find(s=>s.purpose==="hub-photo-assistant")?.id||null'));
  report.sessionId=sid;assert.equal(await c.eval('Array.from(sessions.values()).filter(s=>s.purpose==="hub-assistant").length'),0,'no daily assistant created for a photo');
  await waitFor(c,`!!document.querySelector('.session-item[data-session-id="${sid}"]')`);await click(c,`.session-item[data-session-id="${sid}"]`);
  report.checks.push('真实照片消息自动新建侧栏拍图助理；未创建日常助理或新增 Tab');
  let cursor=0,answer;await until('answer returned to phone',async()=>{const r=await req('/poll?channel='+phone.channel+'&role=phone&after='+cursor);for(const packet of r.messages||[]){cursor=Math.max(cursor,packet.seq);const m=open(phone.key,phone.channel,packet.id,'hub',packet.payload);if(m.type==='answer'&&m.requestId===id)answer=m;}return answer;});
  assert.match(answer.text,/817/);assert.equal(answer.by,'拍图助理');report.answer=answer.text;report.checks.push('真实 Claude 读取图片并计算 817，通过中继回到原请求');
  await until('answer card visible',()=>c.eval('document.querySelector("#msg-overlay")?.textContent.includes("817")'));await shot('20261011-photo-session-answer-codex1');
  const again=await c.eval('ipcRenderer.invoke("assistant:ensure-photo-session")');assert.equal(again.sessionId,sid);report.checks.push('再次就绪复用同一会话，无重复创建');
  const nativeId=again.session.ccSessionId;
  const closed=await c.eval(`ipcRenderer.invoke('close-session',${j(sid)})`);assert.notEqual(closed?.ok,false);
  await until('session fully suspended',()=>c.eval(`ipcRenderer.invoke('get-sessions').then(rows=>!rows.some(s=>s.id===${j(sid)}))`));
  // 隔离夹具模拟旧版 Hub 的真实落盘：专用 purpose 已保存，后台标记缺失。
  const legacyFile=path.join(data,'sessions',sid+'.json'),legacyMeta=JSON.parse(fs.readFileSync(legacyFile,'utf8'));delete legacyMeta.autonomous;fs.writeFileSync(legacyFile,j(legacyMeta));
  const resumed=await c.eval('ipcRenderer.invoke("assistant:ensure-photo-session")');assert.equal(resumed.sessionId,sid);assert.equal(resumed.session.ccSessionId,nativeId);
  assert.equal(resumed.session.autonomous,true);
  const followup=await c.eval(`ipcRenderer.invoke('session:send-prompt',{sessionId:${j(sid)},clientSubmissionId:'photo-resume-'+${j(id)},text:'刚才照片的计算结果是什么？只回复结果数字。',waitForCliReady:true})`);assert.equal(followup.ok,true,JSON.stringify(followup));
  assert.equal(followup.receipt?.status,'confirmed',JSON.stringify(followup));
  await until('resumed answer finished',()=>{const meta=JSON.parse(fs.readFileSync(path.join(data,'sessions',sid+'.json'),'utf8'));return require('../core/hub-assistant/live-history').readFinals(meta).records.some(x=>x.clientSubmissionId==='photo-resume-'+id&&x.text.includes('817'));});
  report.checks.push('关闭后恢复同一 Hub 与 Claude 原生会话，追问仍记得图片答案 817');
  report.passed=true;
 }catch(e){report.error=e.stack;process.exitCode=1;if(c)await shot('20261011-photo-session-failure-codex1').catch(()=>{});}
 finally{c?.close();try{if(hub){fs.writeFileSync(path.join(out,'20261011-hub-codex1.log'),hub.log().join('\n'));await gracefulQuit(hub);}}finally{if(fs.existsSync(auth))fs.unlinkSync(auth);assert.equal(hash(authSource),before,'production auth unchanged');fs.writeFileSync(path.join(out,'20261011-live-verification-codex1.json'),j(report,null,2));console.log(j(report));}}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
