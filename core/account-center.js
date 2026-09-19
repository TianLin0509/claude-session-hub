'use strict';
// Stores observations only. Credentials remain with the CLI/browser/tool that owns them.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const STATES = new Set(['signed_in','login_required','configured','unknown','offline','unavailable','opening']);
function maskIdentity(value) {
  const s = String(value || '').slice(0,160);
  if (s.includes('@')) { const [name,domain] = s.split('@'); return name.slice(0,1)+'•••@'+domain; }
  return s ? s.slice(0,2)+'•••'+s.slice(-4) : '身份未确认';
}
function safeObservation(raw = {}) {
  return { state:STATES.has(raw.state)?raw.state:'unknown', identity:raw.identity ? maskIdentity(raw.identity) : '身份未确认',
    message:String(raw.message || '').slice(0,240), observedAt:Number(raw.observedAt)||Date.now(),
    source:String(raw.source || '连接检查').slice(0,80) };
}
class AccountCenter {
  constructor({ dataDir, getConfig, adapter, homeDir = os.homedir(), env = process.env }) {
    Object.assign(this,{dataDir,getConfig,adapter,homeDir,env});
    this.root=path.join(dataDir,'account-center');this.flights=new Map();
  }
  baseConnections() {
    const c=this.getConfig();
    const profiles=c.codexSubscriptionProfiles?.length?c.codexSubscriptionProfiles:[{id:'default',label:'主账号',home:''}];
    const native=(id,name,provider,home,uses)=>({id,name,provider,home:path.resolve(require('./codex-usage-scope').expandHomePath(home,this.homeDir)),type:'native',uses,action:'login',configProvider:provider});
    const rows=[native('claude','Claude Code','claude',this.env.CLAUDE_CONFIG_DIR || path.join(this.homeDir,'.claude'),['Claude 会话','开发群聊']),
      ...profiles.filter(p=>/^[\w-]{1,64}$/.test(p.id)).map(p=>({...native('codex-'+p.id,'Codex · '+p.label,'codex',p.home || this.env.CODEX_HOME || path.join(this.homeDir,'.codex'),['Codex 会话','开发群聊']),isDefault:p.id===(c.codexSubscriptionProfile || 'default')})),
      native('gemini-cli','Gemini CLI','gemini',path.join(this.homeDir,'.gemini'),['Gemini 会话']),
      native('kimi','Kimi Code','kimi',this.env.KIMI_CODE_HOME || path.join(this.homeDir,'.kimi-code'),['Kimi 会话']),
      {id:'bridge',name:'ChatGPT · 公司中转',type:'web',uses:['公司拉取 / 同步'],provider:'bridge',action:'login'},
      {id:'chatgpt-web',name:'ChatGPT · Codex Web GPT',type:'web',uses:['ChatGPT 会话'],provider:'chatgpt-web',action:'login'},
      ...['deepseek','gemini','chatgpt'].map(p=>({id:'web-'+p,name:({deepseek:'DeepSeek',gemini:'Gemini',chatgpt:'ChatGPT'})[p]+' · 网页',type:'web',provider:p,uses:['专用网页登录（圆桌待接入）'],action:'login',managedBrowser:true})),
      ...['claude','codex','deepseek'].map(p=>({id:'api-'+p,name:({claude:'Claude 中转',codex:'Codex API',deepseek:'DeepSeek API'})[p],type:'api',provider:p,uses:[p+' API 会话'],action:'configure',configProvider:p,configured:!!c[p+'ApiKey']})),
      {id:'token-plan',name:'百炼 · Token Plan',type:'service',provider:'token-plan',uses:['Token Plan 用量'],action:'login'},
      {id:'feishu',name:'飞书 CLI · 用户授权',type:'service',provider:'feishu',uses:['飞书用户授权 / 通知身份检查'],action:'login'},
      {id:'server-monitor',name:'服务器监控授权',type:'service',provider:'server',uses:['工作台服务器监控'],action:'configure',configProvider:'server',configured:!!c.operations?.aliyunMonitor?.bearerToken},
    ];
    return rows;
  }
  async connections() {
    const rows=this.baseConnections();
    try {
      const images=await this.adapter.imageAccounts();
      if(!images.length)rows.push({id:'images',name:'ChatGPT 网页生图',type:'web',provider:'images',accountId:'primary',uses:['网页生图 MCP'],action:'login',observation:{state:'unknown',message:'尚无生图账号记录，可打开原工具的主账号登录入口',source:'生图共享池记录',observedAt:0}});
      for(const a of images) if(/^[a-z][a-z0-9_-]{0,39}$/.test(a.id)) rows.push({
        id:'image-'+a.id,name:'ChatGPT 生图 · '+a.id,type:'web',provider:'images',accountId:a.id,uses:['网页生图 MCP'],action:'login',
        toolState:a.enabled===false?'账号已停用':a.workerAlive?'工作进程在线':'工作进程未在线',
        observation:{state:a.state || 'unknown',message:a.message || '原工具维护独立浏览器配置',observedAt:a.observedAt || 0,source:'生图共享池记录',identity:'身份由生图工具管理'},
      });
    } catch { rows.push({id:'images',name:'ChatGPT 网页生图',type:'web',provider:'images',accountId:'primary',uses:['网页生图 MCP'],action:'login',observation:{state:'unavailable',message:'未能读取生图账号列表，请检查原工具安装',source:'本机工具发现',observedAt:Date.now()}}); }
    return rows;
  }
  file(id,suffix='json'){return path.join(this.root,crypto.createHash('sha256').update(id).digest('hex')+'.'+suffix);}
  read(id){try{return JSON.parse(fs.readFileSync(this.file(id),'utf8'));}catch(e){if(e.code==='ENOENT')return null;return {state:'unknown',message:'账号状态记录不可读，请重新检查',observedAt:0,source:'状态记录'};}}
  save(id,raw){fs.mkdirSync(this.root,{recursive:true});const value=safeObservation(raw);const file=this.file(id),tmp=file+'.'+process.pid+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value),'utf8');fs.renameSync(tmp,file);return value;}
  scope(row){const c=this.getConfig();const credential=row.provider==='server'?c.operations?.aliyunMonitor?.bearerToken:row.type==='api'?c[row.provider+'ApiKey']:'';return row.id+':'+(row.home || '')+':'+(credential?crypto.createHash('sha256').update(String(credential)).digest('hex'):'');}
  async snapshot(){
    const rows=await this.connections();
    await Promise.allSettled(rows.filter(r=>r.type==='native'&&['claude','codex'].includes(r.provider)).map(async row=>{
      const key=this.scope(row),cached=this.read(key);if(cached?.observedAt&&Date.now()-cached.observedAt<60000)return;
      if(this.flights.has(key))return this.flights.get(key);
      const flight=(async()=>{try{this.save(key,await this.adapter.check(row));}catch{this.save(key,{state:'unknown',message:'自动检测未完成；可打开官方登录入口后重新检查',source:'本机 CLI 检测'});}finally{this.flights.delete(key);}})();this.flights.set(key,flight);return flight;
    }));
    return {connections:rows.map(row=>{
      const cached=this.read(this.scope(row));
      const observation=(row.observation && (!cached || row.observation.observedAt>cached.observedAt) ? row.observation : cached) || row.observation || {state:row.configured?'configured':'unknown',message:row.action==='configure'?(row.configured?'密钥已配置，尚未验证有效性':row.provider==='server'?'尚未配置密钥；公开监控端点可以不需要授权':'尚未配置密钥'):'尚未检查；点击检查或登录',observedAt:0,source:'配置发现'};
      const {home,observation:unused,...safe}=row;
      return {...safe,...observation,stale:!!observation.observedAt&&Date.now()-observation.observedAt>300000,pending:this.leaseActive(row)};
    }),history:this.history()};
  }
  history(){try{return fs.readFileSync(path.join(this.root,'events.jsonl'),'utf8').trim().split('\n').filter(Boolean).slice(-80).map(x=>JSON.parse(x)).reverse();}catch(e){if(e.code==='ENOENT')return [];return [{at:Date.now(),name:'活动记录',message:'记录不可读；未覆盖原文件'}];}}
  log(row,message){fs.mkdirSync(this.root,{recursive:true});fs.appendFileSync(path.join(this.root,'events.jsonl'),JSON.stringify({at:Date.now(),name:row.name,message})+'\n','utf8');}
  leaseActive(row){return fs.existsSync(this.file(this.scope(row),'login'));}
  leaseToken(key){try{return JSON.parse(fs.readFileSync(this.file(key,'login'),'utf8')).token;}catch(e){if(e.code==='ENOENT')return null;throw e;}}
  clearLease(key,token){if(!token||this.leaseToken(key)!==token)return;try{fs.unlinkSync(this.file(key,'login'));}catch(e){if(e.code!=='ENOENT')throw e;}}
  async row(id){const row=(await this.connections()).find(r=>r.id===id);if(!row)throw new Error('连接不存在，请刷新账号列表');return row;}
  async check(id){
    const row=await this.row(id),key=this.scope(row),token=this.leaseToken(key);
    if(this.flights.has(key))return this.flights.get(key);
    const promise=(async()=>{
      try {
        const raw=await this.adapter.check(row);const result=this.save(key,raw);
        if(result.state==='signed_in')this.clearLease(key,token);
        this.log(row,result.state==='signed_in'?'检查完成：已有登录证据':result.state==='login_required'?'检查完成：需要登录':'检查完成：'+result.message);
        return result;
      }catch(e){this.save(key,{state:'unknown',message:'检查未完成；未将网络或工具错误判为未登录',source:'连接检查'});this.log(row,'检查失败，请重试或打开原工具');throw new Error('检查失败：'+(e.code==='ENOENT'?'未找到所需工具':'工具未返回有效状态，请在原工具检查'));}
      finally{this.flights.delete(key);}
    })();this.flights.set(key,promise);return promise;
  }
  async login(id){
    const row=await this.row(id);if(row.action!=='login')throw new Error('此连接通过接入配置管理');
    fs.mkdirSync(this.root,{recursive:true});const key=this.scope(row),file=this.file(key,'login'),token=crypto.randomUUID();
    if(this.leaseActive(row))return {pending:true,message:'这个账号的登录窗口已打开；请完成验证后点“检查登录”'};
    let fd;try{fd=fs.openSync(file,'wx');}catch(e){if(e.code==='EEXIST')return {pending:true,message:'另一个 Hub 正在打开此账号的登录窗口'};throw e;}
    try{fs.writeFileSync(fd,JSON.stringify({at:Date.now(),pid:process.pid,token}));}finally{fs.closeSync(fd);}
    try{const result=await this.adapter.login(row);this.log(row,'已打开登录入口；完成本人验证后检查状态');return {...result,pending:true,message:result.message || '已打开官方登录入口。完成验证后点“检查登录”'};}
    catch(e){this.clearLease(key,token);this.log(row,'登录入口打开失败');throw new Error('无法打开登录入口：'+(e.message || '请检查工具安装'));}
  }
  async release(id){const row=await this.row(id);try{fs.unlinkSync(this.file(this.scope(row),'login'));}catch(e){if(e.code!=='ENOENT')throw e;}this.log(row,'结束登录等待；未退出账号、未关闭浏览器');return {ok:true};}
}
module.exports={AccountCenter,maskIdentity,safeObservation};
