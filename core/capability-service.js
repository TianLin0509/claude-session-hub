'use strict';
const path = require('node:path');
const os = require('node:os');
const { Worker } = require('node:worker_threads');
class CapabilityService {
  constructor({sessionManager, dataDir, homeDir = process.env.CLAUDE_HUB_HOME_DIR || os.homedir()}) {
    Object.assign(this,{sessionManager,dataDir,homeDir});
    this.cache=null; this.pending=null;
  }
  sessions() {
    return this.sessionManager.getAllSessions().map(s=>({id:s.id,title:s.title || s.name || s.id,kind:s.kind,
      backend:s.runtimeBackend || 'pty',profile:s.mcpProfile || '未记录',cwd:s.cwd}));
  }
  async catalog(refresh=false) {
    const projects=this.sessionManager.getAllSessions().map(s=>({cwd:s.cwd,kind:s.kind?.replace(/-resume$/,''),
      profileHome:s.codexSessionsRoot ? path.dirname(s.codexSessionsRoot) : null}));
    const key=JSON.stringify(projects);
    if(this.pending) {
      const pendingKey=this.pendingKey,data=await this.pending;
      return pendingKey===key ? {...data,sessions:this.sessions()} : this.catalog(refresh);
    }
    if(!refresh && this.cache?.key===key && Date.now()-this.cache.at<30000)return {...this.cache.data,sessions:this.sessions()};
    this.pendingKey=key;
    this.pending=new Promise((resolve,reject)=>{
      const worker=new Worker(path.join(__dirname,'capability-catalog.js'),{workerData:{homeDir:this.homeDir,dataDir:this.dataDir,projects}});
      const timer=setTimeout(()=>{void worker.terminate();reject(Error('能力目录扫描超时，请刷新重试'));},15000);
      let settled=false;
      const done=(err,data)=>{if(settled)return;settled=true;clearTimeout(timer);err?reject(err):resolve(data);};
      worker.once('message',r=>done(r.ok?null:Error(r.error),r.data));
      worker.once('error',e=>done(e));
      worker.once('exit',code=>{if(!settled)done(Error(`能力扫描提前退出 (${code})`));});
    });
    try {const data=await this.pending;this.cache={key,at:Date.now(),data};return {...data,sessions:this.sessions()};}
    finally {this.pending=null;}
  }
  async runtime(sessionId) {
    const manager=this.sessionManager, session=manager.getSession(sessionId);
    if(!session)throw Error('会话已关闭，请重新选择');
    const native=manager.getNativeCodex?.(sessionId) || manager.getNativeClaude?.(sessionId) || manager.getNativeSession?.(sessionId);
    const out={sessionId,observedAt:Date.now(),backend:session.runtimeBackend || 'pty',profile:session.mcpProfile || '未记录',rows:[],warnings:[]};
    if(!native || native.runtime?.connection!=='connected')return {...out,unknown:'当前会话未提供已连接的原生能力回执。磁盘目录可在“能力目录”查看。'};
    const epoch=native.runtime.epoch, identity=native.threadId || native.sessionId;
    out.epoch=epoch;out.nativeId=identity;
    const valid=()=>manager.getSession(sessionId) && (manager.getNativeCodex?.(sessionId) || manager.getNativeClaude?.(sessionId) || manager.getNativeSession?.(sessionId))===native
      && native.runtime.epoch===epoch && (native.threadId || native.sessionId)===identity && native.runtime.connection==='connected';
    const add=(type,name,status,description='')=>{if(typeof name==='string' && name)out.rows.push({id:`${type}:${name}`,type,name:name.slice(0,250),status,description:String(description).slice(0,1200)});};
    if(session.runtimeBackend==='codex-app-server') {
      const client=native.entry?.client;
      if(!client || !identity)return {...out,unknown:'原生连接尚未就绪'};
      const request=(method,params)=>native.requestNative(client,method,params,8000,{beforeWrite:()=>{if(!valid())throw Error('会话连接已变化，请重新刷新');}});
      const results=await Promise.allSettled([
        request('skills/list',{cwds:[session.cwd],forceReload:false}),
        (async()=>{const servers=[],seen=new Set();let cursor;do {
          const r=await request('mcpServerStatus/list',{threadId:identity,limit:100,...(cursor?{cursor}:{})});
          servers.push(...(r.data || []));cursor=r.nextCursor;
          if(cursor && seen.has(cursor))throw Error('MCP 分页游标重复，结果不完整');
          if(cursor)seen.add(cursor);
          if(seen.size>50)throw Error('MCP 列表过大，结果不完整');
        }while(cursor);return servers;})(),
        request('plugin/list',{cwds:[session.cwd],forceRefetch:false,marketplaceKinds:['local']})
      ]);
      if(!valid())throw Error('会话身份或连接已变化，旧结果已丢弃');
      if(results[0].status==='fulfilled')for(const group of results[0].value.data || []) {
        for(const s of group.skills || [])add('skill',s.name,s.enabled===false?'原生已禁用':'原生已发现',s.description);
        for(const e of group.errors || [])out.warnings.push(String(e.message || '部分技能发现失败'));
      } else out.warnings.push('技能发现失败：'+results[0].reason.message);
      const mcpStatus={notStarted:'原生未启动',starting:'原生连接中',connected:'原生已连接',authenticationRequired:'原生需要授权',failed:'原生连接失败',cancelled:'原生已取消',disabled:'原生已禁用'};
      const authStatus={unknown:'未知',unsupported:'不适用',notLoggedIn:'无登录记录',bearerToken:'令牌授权',oAuth:'OAuth'};
      if(results[1].status==='fulfilled')for(const s of results[1].value)add('mcp',s.name,mcpStatus[s.runtimeStatus] || '连接状态未确认',`${Object.keys(s.tools || {}).length} 个工具条目；授权：${authStatus[s.authStatus] || '未知'}`);
      else out.warnings.push('MCP 状态读取失败：'+results[1].reason.message);
      if(results[2].status==='fulfilled'){
        for(const market of results[2].value.marketplaces || [])for(const p of market.plugins || [])if(p.installed)add('plugin',p.id || p.name,p.enabled?'原生配置启用':'原生已禁用',p.interface?.shortDescription || p.interface?.description || p.name);
        for(const e of results[2].value.marketplaceLoadErrors || [])out.warnings.push('插件目录读取失败：'+e.message);
      }else out.warnings.push('插件状态读取失败：'+results[2].reason.message);
      out.note='来自当前原生连接；技能“已发现”不代表正文已读，插件“配置启用”不代表其全部工具已连接。仅查询本地插件目录。';
    } else if(session.runtimeBackend==='claude-stream-json') {
      const c=native.runtime.capabilities;
      if(!c || c.epoch!==epoch || c.sessionId!==identity)return {...out,unknown:'当前连接尚无能力初始化回执。未用磁盘文件推断加载状态。'};
      for(const s of c.mcpServers || [])add('mcp',s.name,s.status==='connected'?'原生已连接':`原生状态：${s.status || '未知'}`);
      for(const s of c.skills || [])add('skill',typeof s==='string'?s:s.name,'原生已报告');
      for(const s of c.plugins || [])add('plugin',typeof s==='string'?s:s.name,'原生已报告');
      for(const s of c.commands || [])add('command',typeof s==='string'?s:s.name,'原生命令');
      for(const s of c.tools || [])add('tool',typeof s==='string'?s:s.name,'原生已暴露工具');
      out.observedAt=c.observedAt;out.note='来自本连接初始化回执；命令与技能分开列出，未报告的插件/技能状态仍未知。';
    } else out.unknown='此客户端暂未提供逐项技能 / 插件 / MCP 的加载回执，请查看能力目录；状态未确认。';
    return out;
  }
}
module.exports={CapabilityService};
