'use strict';
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const {createTransport,readCertificates}=require('./transport');
const registry=require('./catalog.json');
const PLAN_TTL=10*60*1000;
const MESSAGES={ssh_key_missing:'没有找到本机已登记的阿里云 SSH 密钥。',ssh_host_untrusted:'服务器主机密钥尚未确认，未继续连接。',ssh_auth_failed:'SSH 登录未通过，请检查本机的服务器访问权限。',ssh_failed:'暂时连接不到阿里云，请稍后重试。',cloud_timeout:'本次请求超时，保留上次结果；维护操作请重新扫描确认。',cloud_invalid_response:'服务器返回的数据不完整，保留上次成功快照。',cloud_remote_failed:'服务器本次没有完成采集，请稍后重试。',stale_plan:'整理方案已过期或不属于本次扫描，请重新扫描。',invalid_groups:'请选择本次扫描列出的整理项目。'};
const copy=x=>JSON.parse(JSON.stringify(x));
function validSample(s) {
  const expected=registry.services.filter(v=>v.backend);
  if(!s||typeof s.collectedAt!=='string'||!Number.isFinite(Date.parse(s.collectedAt))||!s.host||!Array.isArray(s.services)
    ||!Number.isInteger(s.cores)||s.cores<1||s.cores>1024||!Number.isFinite(s.sampleSeconds)||s.sampleSeconds<1||s.sampleSeconds>120
    ||s.services.length!==expected.length||new Set(s.services.map(v=>v?.id)).size!==expected.length)return false;
  const h=s.host;
  return ['memoryTotalBytes','memoryFreeBytes','diskTotalBytes','diskFreeBytes','uptimeSeconds'].every(k=>Number.isFinite(h[k])&&h[k]>=0)
    && h.memoryTotalBytes>0&&h.diskTotalBytes>0&&h.memoryFreeBytes<=h.memoryTotalBytes&&h.diskFreeBytes<=h.diskTotalBytes
    && (h.cpuPct===null||Number.isFinite(h.cpuPct)&&h.cpuPct>=0&&h.cpuPct<=100)
    && typeof h.os==='string'&&h.os.length>0&&h.os.length<200
    && s.services.every(v=>{
      const spec=expected.find(e=>e.id===v?.id);
      if(!spec||v.port!==spec.port||typeof v.running!=='boolean'||typeof v.stable!=='boolean'||!Number.isInteger(v.processCount)||v.processCount<0)return false;
      if(!v.running)return v.processCount===0&&v.cpuPct===null&&v.workingSetBytes===null;
      if(v.processCount<1)return false;
      if(!v.stable)return v.cpuPct===null&&v.workingSetBytes===null;
      return Number.isFinite(v.cpuPct)&&v.cpuPct>=0&&v.cpuPct<=100&&Number.isFinite(v.workingSetBytes)&&v.workingSetBytes>=0;
    });
}
class CloudService {
  constructor({dataDir,enabled=require('../distribution').personalModules,request,certificates=readCertificates,now=Date.now,onChange=()=>{},home,readOnly=false}={}){
    this.enabled=!!enabled;this.readOnly=readOnly;this.dataDir=dataDir;this.request=request||createTransport({home});this.certificates=certificates;this.now=now;this.onChange=onChange;
    this.settings={refreshMinutes:5};this.snapshot=null;this.error=null;this.lastAttemptAt=null;this.history=[];this.optimization={phase:'idle',plan:null,groups:[],releasedBytes:0};this.planItems=[];this.refreshing=null;this.operation=null;this.storageWarning='';
    if(this.enabled&&dataDir){try{const f=path.join(dataDir,'cloud-state.json');if(fs.statSync(f).size<1024*1024){const saved=JSON.parse(fs.readFileSync(f,'utf8'));if([0,5,15].includes(saved.settings?.refreshMinutes))this.settings=saved.settings;if(validSample(saved.snapshot))this.snapshot=saved.snapshot;if(Array.isArray(saved.history))this.history=saved.history.slice(-20);}}catch{}}
  }
  guard(){if(!this.enabled)throw new Error('cloud_disabled');}
  emit(){try{this.onChange();}catch{}}
  save(){if(!this.dataDir)return;try{fs.mkdirSync(this.dataDir,{recursive:true});const file=path.join(this.dataDir,'cloud-state.json'),tmp=file+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify({settings:this.settings,snapshot:this.snapshot,history:this.history.slice(-20)}),'utf8');fs.renameSync(tmp,file);this.storageWarning='';}catch{this.storageWarning='本次结果已显示，但本机历史记录暂未保存。';}}
  getState(){if(!this.enabled)return {enabled:false};return copy({enabled:true,machine:{label:registry.machine.label,host:registry.machine.host,region:registry.machine.region,instanceType:registry.machine.instanceType},catalog:registry.services.filter(s=>s.id!=='caddy'),gateway:registry.services.find(s=>s.id==='caddy'),settings:this.settings,snapshot:this.snapshot,refreshing:!!this.refreshing,lastAttemptAt:this.lastAttemptAt,error:this.error,history:this.history,optimization:this.optimization,storageWarning:this.storageWarning});}
  setSettings(p={}){this.guard();if(![0,5,15].includes(p.refreshMinutes))throw new Error('invalid_refresh_interval');this.settings={refreshMinutes:p.refreshMinutes};this.save();this.emit();return this.getState();}
  async refresh(){
    this.guard();if(this.refreshing)return this.refreshing;
    this.lastAttemptAt=new Date(this.now()).toISOString();this.error=null;
    this.refreshing=Promise.resolve().then(async()=>{try{const [sample,certs]=await Promise.all([this.request('metrics'),Promise.resolve().then(()=>this.certificates()).catch(()=>[])]);if(!validSample(sample))throw new Error('cloud_invalid_response');this.snapshot={...sample,certificates:certs};this.save();}catch(e){this.error={code:e.message,message:MESSAGES[e.message]||'本次采集未完成，请稍后重试。',at:new Date(this.now()).toISOString()};}finally{this.refreshing=null;this.emit();}return this.getState();});
    this.emit();return this.refreshing;
  }
  async planOptimization(){
    this.guard();if(this.operation)return this.operation;
    this.optimization={phase:'scanning',plan:null,groups:[],releasedBytes:0};this.emit();
    this.operation=Promise.resolve().then(async()=>{try{
      const result=await this.request('plan');
      if(!Array.isArray(result.items)||result.items.length>50||new Set(result.items.map(i=>i?.id)).size!==result.items.length||result.items.some(i=>!i||!['temp','logs'].includes(i.group)||typeof i.path!=='string'||!i.path||typeof i.id!=='string'||!i.id||!Number.isFinite(i.bytes)||i.bytes<0||i.bytes>10*1024*1024||!/^\d{1,20}$/.test(i.modifiedTicks)))throw new Error('cloud_invalid_response');
      this.planItems=result.items;
      const createdAt=this.now();
      const groups=['temp','logs'].map(id=>({id,label:id==='temp'?'清理失效临时文件':'压缩已轮转日志',fileCount:this.planItems.filter(i=>i.group===id).length,bytes:this.planItems.filter(i=>i.group===id).reduce((n,i)=>n+i.bytes,0),status:'pending'}));
      this.optimization={phase:'planned',plan:{id:crypto.randomUUID(),createdAt,expiresAt:createdAt+PLAN_TTL,files:this.planItems.map(({id,group,path:filename,bytes})=>({id,group,path:filename,bytes})),warnings:result.warnings||[]},groups,releasedBytes:0};
    }catch(e){this.optimization={phase:'error',plan:null,groups:[],releasedBytes:0,error:MESSAGES[e.message]||'没有完成扫描，请稍后重试。'};}finally{this.operation=null;this.emit();}return this.getState();});return this.operation;
  }
  async runOptimization(p={}){
    this.guard();if(this.readOnly)throw new Error('cloud_read_only');if(this.operation)return this.operation;
    const opt=this.optimization;
    if(!opt.plan||p.planId!==opt.plan.id||this.now()>opt.plan.expiresAt)throw new Error('stale_plan');
    if(!Array.isArray(p.groups)||!p.groups.length||p.groups.some(x=>!['temp','logs'].includes(x)))throw new Error('invalid_groups');
    if(opt.groups.some(g=>p.groups.includes(g.id)&&g.status==='unknown'))throw new Error('stale_plan');
    const groups=opt.groups.filter(g=>p.groups.includes(g.id)&&g.fileCount&&g.status!=='done');
    if(!groups.length)return this.getState();
    const alreadyReleased=opt.releasedBytes;
    this.operation=Promise.resolve().then(async()=>{opt.phase='running';this.emit();
      for(const group of groups){
        group.status='running';this.emit();
        const completed=new Set((group.results||[]).filter(r=>['done','skipped'].includes(r.status)).map(r=>r.id));
        const pending=this.planItems.filter(i=>i.group===group.id&&!completed.has(i.id));
        try{
          const result=await this.request('execute',{items:pending});
          if(!Array.isArray(result.results)||result.results.length!==pending.length||new Set(result.results.map(r=>r?.id)).size!==pending.length||pending.some(i=>!result.results.some(r=>r.id===i.id))
            ||result.results.some(r=>!['done','skipped','failed'].includes(r.status)||!Number.isFinite(r.releasedBytes)||r.releasedBytes<0||r.releasedBytes>(pending.find(i=>i.id===r.id)?.bytes??-1)))throw new Error('cloud_invalid_response');
          const previous=group.results||[];
          group.results=[...previous.filter(r=>completed.has(r.id)),...result.results.filter(r=>pending.some(i=>i.id===r.id)).map(r=>({id:r.id,status:['done','skipped','failed'].includes(r.status)?r.status:'failed',releasedBytes:r.status==='done'&&Number.isFinite(r.releasedBytes)?Math.max(0,r.releasedBytes):0,message:String(r.message||'').slice(0,120)}))];
          group.status=group.results.some(r=>r.status==='failed')?'failed':'done';
          group.message=group.status==='failed'?'部分文件未完成，可单独重试。':'已完成；无需处理的文件已跳过。';
        }catch(e){group.status='unknown';group.message=MESSAGES[e.message]||'未收到完整结果，请重新扫描确认。';}
        opt.releasedBytes=opt.groups.flatMap(g=>g.results||[]).reduce((n,r)=>n+r.releasedBytes,0);this.emit();
      }
      opt.phase='done';this.history.push({at:new Date(this.now()).toISOString(),releasedBytes:Math.max(0,opt.releasedBytes-alreadyReleased),groups:groups.map(g=>({id:g.id,label:g.label,status:g.status,message:g.message}))});this.history=this.history.slice(-20);this.save();
      this.emit();await this.refresh();return this.getState();
    }).finally(()=>{this.operation=null;this.emit();});return this.operation;
  }
  async openService(id,openExternal){
    this.guard();const service=registry.services.find(s=>s.id===id);if(!service)throw new Error('unknown_service');
    let url=service.url;
    if(service.privateEntry){const result=await this.request('private-url');url=result.url;const u=new URL(url);if(u.protocol!=='https:'||u.hostname!==registry.machine.privateHost||!/^\/drop\/[A-Za-z0-9_-]+\/$/.test(u.pathname)||u.username||u.password||u.search||u.hash)throw new Error('invalid_private_entry');}
    if(!url)throw new Error('no_service_entry');
    const parsed=new URL(url);if(parsed.protocol!=='https:'||!registry.machine.domains.includes(parsed.hostname))throw new Error('invalid_service_entry');
    await openExternal(url);return {ok:true};
  }
}
module.exports={CloudService,validSample,PLAN_TTL,MESSAGES};
