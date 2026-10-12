'use strict';
// Isolated real Claude + cloud relay. No production session or pairing writes.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const {getFreePort,waitFor}=require('./helpers/usage-refresh-fixture');
const {AssistantStore}=require('../core/hub-assistant/store');
const {seal,open}=require('../core/hub-phone/crypto');
const j=JSON.stringify,sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
 const run=Date.now(),root=fs.mkdtempSync(path.join(os.tmpdir(),'photo-throughput-')),data=path.join(root,'data'),claude=path.join(root,'claude'),work=path.join(root,'work');
 const out=path.resolve('artifacts/20261011-photo-throughput-'+run+'-codex1');for(const d of [data,claude,work,out])fs.mkdirSync(d,{recursive:true});
 const model=process.env.PHOTO_TEST_MODEL||'claude-haiku-4-5',count=Number(process.env.PHOTO_TEST_COUNT||3),effort=model.includes('opus')?'medium':'low';
 const source=path.join(os.homedir(),'.claude','.credentials.json'),auth=path.join(claude,'.credentials.json');fs.copyFileSync(source,auth);
 fs.writeFileSync(path.join(claude,'.claude.json'),j({hasCompletedOnboarding:true,theme:'light',skipDangerousModePermissionPrompt:true,projects:{[work]:{hasTrustDialogAccepted:true}}}));
 fs.writeFileSync(path.join(work,'CLAUDE.md'),'Isolated photo delivery test. Read each supplied image. Answer every photo, even when new photos arrive during your work. Each answer must name the visible Q number and give its numeric result. Reply briefly, no other tools beyond reading images.');
 fs.writeFileSync(path.join(data,'config.json'),j({models:{defaults:{claude:model}}}));
 const store=new AssistantStore(path.join(data,'assistant'));store.set('assistantDefaultsVersion',2);store.set('backendKind','claude');store.set('profile:claude',{model,effort});store.close();
 require('../core/claude-hook-integration').ensureClaudeHookIntegration({claudeDir:claude,sourceScriptsDir:path.resolve('scripts'),logger:{log(){},warn(){}}});
 const report={passed:false,root,model,count,photos:[],packets:[],states:[]};let hub,c,cursor=0;
 const until=async(label,fn,timeout=180000)=>{for(const end=Date.now()+timeout;Date.now()<end;){const v=await fn();if(v)return v;await sleep(350);}throw Error('timeout: '+label);};
 try{
  hub=await launchIsolatedHub({dataDir:data,port:await getFreePort(),windowMode:'background',label:'photo-throughput',extraEnv:{CLAUDE_HUB_E2E:'1',CLAUDE_CONFIG_DIR:claude,CODEX_HOME:path.join(root,'codex'),CLAUDE_HUB_AGENT_RUNTIME:'pty',CLAUDE_HUB_NO_FAST:'1',AI_HUB_WORKSPACE_ROOT:work,ANTHROPIC_API_KEY:'',OPENAI_API_KEY:'',HUB_ASSISTANT_FAST_LANE:'0',HUB_SESSION_SEARCH_CLAUDE_ROOTS:path.join(root,'empty'),HUB_SESSION_SEARCH_CODEX_ROOTS:path.join(root,'empty')}});
  c=await connectFirstPage(hub);await waitFor(c,'typeof assistantPanel!=="undefined"');
  const p=await c.eval('ipcRenderer.invoke("assistant:phone-pair")');assert(p.code?.startsWith('AIH1.'));const phone=JSON.parse(Buffer.from(p.code.slice(5),'base64url'));
  const req=async(route,body)=>{for(let attempt=0;;attempt++){const r=await fetch(phone.url+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+phone.token,'Content-Type':'application/json'},body:body&&j(body),signal:AbortSignal.timeout(35000)});if(r.status===429&&attempt<2){await sleep(30000);continue;}assert(r.ok,'relay '+r.status);return r.json();}};
  const pump=async()=>{const r=await req('/poll?channel='+phone.channel+'&role=phone&after='+cursor+'&wait=15');for(const packet of r.messages||[]){cursor=Math.max(cursor,packet.seq);const m=open(phone.key,phone.channel,packet.id,'hub',packet.payload);report.packets.push({...m,observed:Date.now()});if(m.type==='answer'||m.type==='status')console.log('PACKET',m.type,m.requestId,m.state||'',String(m.text).slice(0,180));}};
  const send=async n=>{
   const id=crypto.randomUUID(),question='Q'+n+': '+(30+n)+' x '+(10+n)+' = ?';
   const image=await c.eval(`(()=>{const c=document.createElement('canvas');c.width=1200;c.height=600;const x=c.getContext('2d');x.fillStyle='white';x.fillRect(0,0,1200,600);x.fillStyle='black';x.font='70px Arial';x.fillText(${j(question)},60,270);return c.toDataURL('image/jpeg',0.96).split(',')[1]})()`);
   report.photos.push({id,n,expected:(30+n)*(10+n),sent:Date.now()});
   await req('/send',{channel:phone.channel,role:'phone',id,payload:seal(phone.key,phone.channel,id,'phone',{type:'text',to:'assistant',text:'Read this photo and answer its Q number and result, within 40 words. '+(n===1?'For this delivery test, after reading the image run python -c "import time; time.sleep(18)" exactly once before answering. Continue answering every new photo that arrives.':''),attachment:{name:'capture-'+id+'.jpg',data:image}})});console.log('SENT',n,id);
  };
  await send(1);
  const sid=await until('photo session',()=>c.eval('Array.from(sessions.values()).find(s=>s.purpose==="hub-photo-assistant")?.id||null'));report.sessionId=sid;
  await until('first photo accepted by Claude',async()=>{await pump();return report.packets.some(x=>x.requestId===report.photos[0].id&&x.state==='received'&&x.by==='拍图助理');});
  const beforeBurst=await c.eval(`JSON.parse(JSON.stringify(sessions.get(${j(sid)})))`);report.busyBeforeBurst=beforeBurst.status;console.log('BURST_WHILE',beforeBurst.status);
  for(let n=2;n<=count;n++)await send(n);
  await until('all photo answers',async()=>{
   await pump();const s=await c.eval(`JSON.parse(JSON.stringify(sessions.get(${j(sid)})))`);report.states.push({time:Date.now(),status:s.status});
   if(s.transcriptPath&&fs.existsSync(s.transcriptPath))fs.copyFileSync(s.transcriptPath,path.join(out,'native.jsonl'));
   fs.writeFileSync(path.join(out,'progress.json'),j(report,null,2));
   return report.photos.every(p=>report.packets.some(x=>x.type==='answer'&&(x.requestId===p.id||x.requestIds?.includes(p.id))&&x.text.includes(String(p.expected))));
  },240000);
  report.firstBatchAnswers=report.packets.filter(x=>x.type==='answer').length;
  const firstAnswered=report.packets.find(x=>x.type==='answer').observed;
  assert(report.photos.slice(1).every(p=>report.packets.some(x=>x.requestId===p.id&&x.state==='received'&&x.by==='拍图助理'&&x.observed<firstAnswered)),'new photos must enter Claude before the first answer');
  await send(count+1);
  await until('next photo after burst',async()=>{await pump();const p=report.photos.at(-1);return report.packets.some(x=>x.type==='answer'&&x.requestId===p.id&&x.text.includes(String(p.expected)));});
  report.passed=true;
 }catch(e){report.error=e.stack;process.exitCode=1;}
 finally{c?.close();try{if(hub){fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));await gracefulQuit(hub);}}finally{if(fs.existsSync(auth))fs.unlinkSync(auth);fs.writeFileSync(path.join(out,'verification.json'),j(report,null,2));console.log(j({passed:report.passed,error:report.error,out}));}}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
