'use strict';
const crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const {seal,open,credentials,invite}=require('./crypto');
// 手机协议 v2（App 1.1）：voice_message 识别后直接交给助理，转写只回传显示；hello 声明能力后才下发 profile；set_profile 切换助理模型。
// 旧 App 只认 text/voice/status/answer/image/transcript，未声明能力前不向它发送新类型。
const TYPES=['text','voice','voice_message','hello','set_profile'];
const MAX_VOICE_BYTES=16000*2*120;
const ACTIVE=['dispatching','waiting','unknown'];
const LONG_POLL_SECONDS=15; // 中继支持长等待时，新消息一到即返回；旧中继忽略该参数、立即返回
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
class PhoneChannel{
 constructor({assistant,journal,renderCards,transcribe,fastLane=null,imageRoots=[]}){Object.assign(this,{assistant,journal,renderCards,transcribe,fastLane,imageRoots});this.closed=false;this.issue=null;this.online=false;this.lastPoll=0;}
 status(){const s=this.journal.state;return{ok:true,version:'1.1.0',protocol:2,enabled:s.enabled,connected:this.online,issue:this.issue,paired:!!s.credentials,pending:s.inbox.filter(r=>r.state==='queued').length,unknown:s.inbox.filter(r=>r.state==='unknown').length,voice:true,phoneApp:s.phoneApp||null,backend:this.assistant.overview().backendKind||null};}
 async request(endpoint,{method='GET',body,role='hub',wait=0}={}){const c=this.journal.state.credentials;if(!c)throw Error('请先连接手机');const q=method==='GET'?`?channel=${c.channel}&role=${role}&after=${this.journal.state.cursor}${wait?'&wait='+wait:''}`:'';const headers={Authorization:'Bearer '+c.hubToken,'Content-Type':'application/json'};if(endpoint==='/create'){const file='C:/VibeData/Secrets/aihub-phone-relay-registration.txt';const secret=process.env.HUB_PHONE_REGISTER_KEY||(fs.existsSync(file)?fs.readFileSync(file,'utf8').trim():'');if(!/^[A-Za-z0-9_-]{43}$/.test(secret))throw Error('手机连接服务尚未配置，请先完成手机服务部署');headers['X-Register-Key']=secret;}const r=await fetch(c.url+endpoint+q,{method,headers,body:body&&JSON.stringify({...body,channel:c.channel,role}),signal:AbortSignal.timeout(wait?(wait+15)*1000:20000)});if(!r.ok)throw Error('手机连接服务暂时不可用（'+r.status+'）');return r.json();}
 async pair(){const s=this.journal.state;if(!s.credentials)this.journal.change(x=>{x.credentials=credentials();x.notices=this.assistant.notifications({limit:200}).notifications.map(n=>n.id);x.created=Date.now();});const {channel,hubToken,phoneToken}=s.credentials;await this.request('/create',{method:'POST',body:{channel,hubToken,phoneToken}});this.journal.change(x=>{x.enabled=true;});this.start();return{...this.status(),code:invite(s.credentials)};}
 emit(id,value){const s=this.journal.state;if(s.outbox.some(r=>r.id===id))return;const c=s.credentials;this.journal.change(x=>{x.outbox.push({id,payload:seal(c.key,c.channel,id,'hub',{...value,time:Date.now()}),sent:false});});}
 observeReceipt(r){if(r?.status!=='confirmed'||r.notSent||r.contentMismatch)return;const row=this.journal.state.inbox.find(x=>x.id===r.clientSubmissionId&&x.sessionId===r.sessionId);if(row&&ACTIVE.includes(row.state)){this.journal.change(()=>{row.turnId=r.turnId||null;row.state='waiting';row.issue=null;row.t={...row.t,confirmed:row.t?.confirmed||Date.now()};});this.emit('receipt-'+row.id,{type:'status',requestId:row.id,state:'received',text:'助理已收到，正在处理。'});}}
 // 有任务在途或 10 分钟内有往来时 1.5 秒取一次，其余 2.2 秒；中继按 IP 限每分钟 180 次，手机与电脑常在同一出口。
 // 收消息走独立的长等待循环（消息一到立刻处理）；处理由 kick 触发（新消息、助理答完、关注提醒），定时器只做兜底。
 start(){if(this.timer||this.closed)return;this.timer=setInterval(()=>{const s=this.journal.state,busy=s.inbox.some(r=>r.state==='queued'||r.state==='transcribing'||ACTIVE.includes(r.state))||Date.now()-(s.lastInbound||0)<600000;if(Date.now()-this.lastPoll>=(busy?1500:5000))void this.tick();},500);this.timer.unref();void this.receiveLoop();void this.tick();}
 kick(){if(this.closed)return;if(this.working){this.rekick=true;return;}void this.tick();}
 async receiveLoop(){
  if(this.receiving)return;this.receiving=true;
  try{while(!this.closed&&this.journal.state.enabled&&this.journal.state.credentials){
   const started=Date.now();
   try{const polled=await this.request('/poll',{wait:LONG_POLL_SECONDS});if(this.closed)break;this.online=true;this.issue=null;
    const messages=polled.messages||[];await this.ingest(messages);
    if(messages.length)this.kick();else if(Date.now()-started<1000)await sleep(1500);}
   catch(e){this.online=false;this.issue=e.message;await sleep(3000);}
  }}finally{this.receiving=false;}
 }
 async ingest(messages){const s=this.journal.state;
  for(const packet of messages){if(packet.seq<=s.cursor)continue;if(!s.inbox.some(r=>r.id===packet.id)){try{const m=open(s.credentials.key,s.credentials.channel,packet.id,'phone',packet.payload);this.validate(m);
     if(m.type==='hello'){this.journal.change(x=>{x.cursor=packet.seq;x.lastInbound=Date.now();x.phoneCaps=m.caps.map(String).slice(0,20);x.phoneApp=String(m.app||'').slice(0,20);x.inbox.push({id:packet.id,type:'hello',state:'done'});});await this.sendProfile(packet.id).catch(e=>console.warn('[phone] profile',e.message));continue;}
     this.journal.change(x=>{x.inbox.push({...m,id:packet.id,state:'queued',t:{received:Date.now()}});x.cursor=packet.seq;x.lastInbound=Date.now();});}catch{this.journal.change(x=>{x.cursor=packet.seq;});this.emit('invalid-'+packet.id,{type:'status',requestId:packet.id,state:'rejected',text:'消息校验未通过，未提交任务。'});}}else this.journal.change(x=>{x.cursor=packet.seq;});}
 }
 validate(m){
  if(!TYPES.includes(m.type))throw Error('消息类型不支持');
  if(m.type==='text'&&(typeof m.text!=='string'||!m.text.trim()||m.text.length>50000))throw Error('任务文字无效');
  if(m.type==='voice_message'&&(typeof m.pcm!=='string'||!m.pcm||m.pcm.length>Math.ceil(MAX_VOICE_BYTES/3)*4+4))throw Error('语音无效');
  if(m.type==='set_profile'&&!['kind','model'].every(k=>typeof m[k]==='string'&&m[k]&&m[k].length<=160))throw Error('助理设置无效');
  if(m.type==='hello'&&(!Array.isArray(m.caps)||m.caps.length>20))throw Error('手机能力声明无效');
 }
 supports(cap){return(this.journal.state.phoneCaps||[]).includes(cap);}
 async sendProfile(requestId){
  if(!this.supports('profile')||!this.assistant.phoneProfile)return;
  const profile=await this.assistant.phoneProfile();
  this.journal.change(x=>{x.profileSignature=JSON.stringify(profile.current);});
  this.emit('profile-'+crypto.randomUUID(),{type:'profile',...(requestId?{requestId}:{}),...profile,switching:!!this.assistant.switching});
 }
 async tick(){const s=this.journal.state;if(this.working||this.closed||!s.enabled||!s.credentials)return;this.working=true;this.lastPoll=Date.now();
 try{
  // 长等待循环在跑时由它收消息；单独调用 tick（测试、旧路径）时自己取一次。
  if(!this.receiving){const polled=await this.request('/poll');if(this.closed||!s.enabled)return;this.online=true;this.issue=null;await this.ingest(polled.messages||[]);}
  if(this.closed||!s.enabled)return;
  // 语音先识别（不受助理忙碌影响），可直接答的简单问题走快速通道，其余照旧排队交给完整助理。
  for(const row of s.inbox.filter(r=>r.state==='queued'&&r.type==='voice_message'))await this.transcribeRow(row);
  if(this.fastLane&&!this.assistant.fastLaneDisabled?.())for(const row of s.inbox.filter(r=>r.state==='queued'&&r.type==='text'&&!r.fastTried))await this.tryFastLane(row);
  const active=s.inbox.find(r=>ACTIVE.includes(r.state));
  if(active){let finals;try{finals=this.assistant.readLiveFinal(active.sessionId).records;}catch(e){finals=[];if(/找不到原会话/.test(e.message)){this.journal.change(()=>{active.state='lost';active.issue=e.message;});this.emit('lost-'+active.id,{type:'status',requestId:active.id,state:'unknown',text:'助理会话已不在本窗口，结果请在电脑上查看；不会自动重发。'});}}const answer=finals.find(r=>r.clientSubmissionId===active.id||active.turnId&&r.turnId===active.turnId);if(answer){const found=Date.now();await this.reply('answer-'+active.id,answer.text,{requestId:active.id});this.journal.change(()=>{active.state='answered';active.t={...active.t,answerFound:found,answerQueued:Date.now()};});
   const t=active.t||{},span=(a,b)=>t[a]&&t[b]?t[b]-t[a]:null;console.log('[phone] timing',active.id.slice(0,8),JSON.stringify({asr:span('asrStart','asrDone'),toDispatch:span('received','dispatch'),submit:span('dispatch','confirmed'),turn:span('confirmed','answerFound'),total:span('received','answerQueued')}));}}
  if(!s.inbox.some(r=>ACTIVE.includes(r.state))&&!this.assistant.switching){const row=s.inbox.find(r=>r.state==='queued');if(row){
    if(row.type==='voice'){this.journal.change(()=>{row.state='transcribing';});try{const text=await this.transcribe(row.pcm);if(!text.trim())throw Error('没有听清，请重新录音');this.emit('transcript-'+row.id,{type:'transcript',requestId:row.id,text});this.journal.change(()=>{row.state='transcribed';delete row.pcm;});}catch(e){this.emit('voiceerror-'+row.id,{type:'status',requestId:row.id,state:'rejected',text:e.message});this.journal.change(()=>{row.state='rejected';delete row.pcm;});}}
    else if(row.type==='set_profile'){this.journal.change(()=>{row.state='switching';});try{const r=await this.assistant.setProfile({kind:row.kind,model:row.model,effort:row.effort||undefined});if(!r.ok)throw Error(r.error||'切换未完成');this.journal.change(()=>{row.state='done';});await this.sendProfile(row.id).catch(e=>console.warn('[phone] profile',e.message));}catch(e){this.journal.change(()=>{row.state='rejected';row.issue=e.message;});this.emit('profileerror-'+row.id,{type:'status',requestId:row.id,state:'rejected',text:'助理设置未切换：'+e.message});await this.sendProfile().catch(()=>{});}}
    else{
     if(row.type==='voice_message')await this.transcribeRow(row);
     if(row.state==='queued'){
      // 助理暂时起不来时本条留在队首重试；连续 3 次失败就明确告诉手机，避免整条队列被挡住。
      try{await this.dispatch(row);}catch(e){this.issue=e.message;this.journal.change(()=>{row.attempts=(row.attempts||0)+1;if(row.attempts>=3){row.state='rejected';row.issue=e.message;}});if(row.state==='rejected')this.emit('rejected-'+row.id,{type:'status',requestId:row.id,state:'rejected',text:'助理暂时无法接收：'+e.message+'。本条未提交，请稍后重发。'});}
     }
    }
   }}
  if(this.supports('profile')&&this.assistant.phoneProfile&&!this.assistant.switching){const current=JSON.stringify(this.assistant.currentProfile?.());if(current!==s.profileSignature)await this.sendProfile();}
  for(const n of this.assistant.notifications({limit:200}).notifications){if(s.notices.includes(n.id)||n.createdAt<s.created)continue;await this.reply('notice-'+crypto.createHash('sha256').update(n.id).digest('hex').slice(0,32),n.kind==='memory-update'?n.text:'关注任务「'+n.title+'」有新进展：\n'+n.text,{notice:true});this.journal.change(x=>x.notices.push(n.id));}
  await this.flush(4);
 }catch(e){this.online=false;this.issue=e.message;}finally{this.working=false;if(this.rekick&&!this.closed){this.rekick=false;setTimeout(()=>void this.tick(),0);}}}
 async flush(limit=8){for(const row of this.journal.state.outbox.filter(r=>!r.sent).slice(0,limit)){await this.request('/send',{method:'POST',body:{id:row.id,payload:row.payload}});this.journal.change(()=>{row.sent=true;});}}
  async transcribeRow(row){
   this.journal.change(()=>{row.state='transcribing';row.t={...row.t,asrStart:Date.now()};});
   try{const text=(await this.transcribe(row.pcm)).trim();if(!text)throw Error('没有听清，请再说一次');this.emit('transcript-'+row.id,{type:'transcript',requestId:row.id,text,auto:true});this.journal.change(()=>{row.type='text';row.text=text;row.inputMode='voice';row.state='queued';row.t={...row.t,asrDone:Date.now()};delete row.pcm;});}
   catch(e){this.emit('voiceerror-'+row.id,{type:'status',requestId:row.id,state:'rejected',text:'识别失败：'+e.message});this.journal.change(()=>{row.state='rejected';row.issue=e.message;delete row.pcm;});}
   await this.flush().catch(()=>{});
  }
  // 快速通道：约 1 秒答复；交还标记、出错或超时都回到完整助理，不丢消息。
  async tryFastLane(row){
   this.journal.change(()=>{row.fastTried=true;});
   if(!this.fastLane.eligible(row.text))return false;
   try{
    const started=Date.now(),result=await this.fastLane.answer(row.text,{history:this.assistant.recentHistory?.()||[],userPrefs:this.assistant.memory?.read?.().user||''});
    if(result.handoff){console.log('[phone] fast lane handoff',row.id.slice(0,8),Date.now()-started+'ms');return false;}
    this.journal.change(()=>{row.state='answered';row.lane='fast';row.t={...row.t,answerFound:Date.now()};});
    await this.reply('answer-'+row.id,result.text,{requestId:row.id,lane:'fast'},{cards:false});
    await this.flush().catch(()=>{});
    this.journal.change(()=>{row.t={...row.t,answerQueued:Date.now()};});
    try{this.assistant.recordFastLane?.({id:row.id,question:row.text,answer:result.text,model:result.model,inputMode:row.inputMode});}catch{}
    const t=row.t||{};console.log('[phone] fast lane',row.id.slice(0,8),JSON.stringify({asr:t.asrDone&&t.asrStart?t.asrDone-t.asrStart:null,model:result.ms,first:result.firstMs,total:t.answerQueued-t.received}));
    return true;
   }catch(e){console.warn('[phone] fast lane fallback',e.message);return false;}
  }
  async dispatch(row){
  const overview=this.assistant.overview();if(overview.submissionPending||['running','waiting'].includes(overview.status))return;
  const ready=await this.assistant.ensureSession();if(!ready.ok)throw Error(ready.error||'助理未就绪');
  this.journal.change(()=>{row.state='dispatching';row.sessionId=ready.sessionId;row.t={...row.t,dispatch:Date.now()};});
  try{const r=await this.assistant.send({text:row.text,requestId:row.id,...(row.inputMode==='voice'?{inputMode:'voice'}:{})});const receipt=r.receipt?.receipt;if(receipt?.status==='confirmed')this.observeReceipt({...receipt,sessionId:ready.sessionId,clientSubmissionId:row.id});else if(r.receipt?.notSent){this.journal.change(()=>{row.state='rejected';row.issue=r.receipt.message||r.receipt.error;});this.emit('rejected-'+row.id,{type:'status',requestId:row.id,state:'rejected',text:r.receipt.message||'本条消息未发送，请等助理就绪后重新发送。'});}else if(row.state==='dispatching')this.journal.change(()=>{row.state='unknown';row.issue=r.receipt?.message||r.receipt?.error;});}catch(e){this.journal.change(()=>{row.state=e.notSent?'rejected':'unknown';row.issue=e.message;});}
  if(row.state==='unknown')this.emit('unknown-'+row.id,{type:'status',requestId:row.id,state:'unknown',text:'任务是否送达尚未确认，正在核对，不会自动再发。'});
 }
 async reply(id,text,extra={},{cards=true}={}){this.emit(id,{type:'answer',text,...extra});for(const [i,img]of require('./images').answerImages(text,{roots:this.imageRoots}).entries())this.emit(id+'-original-'+i,{type:'image',originId:id,png:img.data.toString('base64'),caption:img.caption,...extra});if(!cards||this.journal.state.outbox.some(r=>r.id===id+'-image-0'))return;try{const images=await this.renderCards(text);images.forEach((b,i)=>this.emit(id+'-image-'+i,{type:'image',originId:id,png:b.toString('base64'),caption:'结果卡片',...extra}));}catch(e){this.emit(id+'-image-error',{type:'status',text:'文字结果已就绪，图片暂时生成失败。'});}}
 pause(){this.journal.change(s=>{s.enabled=false;});clearInterval(this.timer);this.timer=null;this.online=false;return this.status();}
 close(){this.closed=true;clearInterval(this.timer);}
}
module.exports={PhoneChannel};
