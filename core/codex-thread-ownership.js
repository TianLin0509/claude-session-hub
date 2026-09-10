'use strict';
// Ownership guards only decide whether Hub may attach a thread. They never
// infer whether a turn is running, waiting or complete.
const fs=require('fs'),path=require('path'),os=require('os'),http=require('http'),{randomUUID}=require('crypto');
const WebSocket=require('ws');
function alive(pid){if(!Number.isInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;if(e.code==='EPERM')return true;throw e;}}
function ownerDirectory(options){return path.join(options.env?.CODEX_HOME || path.join(os.homedir(),'.codex'),'.hub-native-owners');}
function ownershipDatabase(options){
  const dir=ownerDirectory(options);fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,'owners.sqlite');
  const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(file);
  try{db.exec('PRAGMA busy_timeout=100; CREATE TABLE IF NOT EXISTS owners (thread TEXT PRIMARY KEY, hub_pid INTEGER NOT NULL, server_pid INTEGER, session TEXT, nonce TEXT NOT NULL)');}
  catch(error){db.close();throw error;}
  return {db,file};
}
function claimThread(options,threadId,serverPid){
  const {db,file}=ownershipDatabase(options),nonce=randomUUID();
  try{
    db.exec('BEGIN IMMEDIATE');
    const previous=db.prepare('SELECT * FROM owners WHERE thread=?').get(threadId);
    if(previous && (alive(previous.hub_pid)||alive(previous.server_pid)))throw new Error('该 Codex 会话仍由另一个进程持有，请在原会话结束后恢复');
    db.prepare('INSERT OR REPLACE INTO owners VALUES (?,?,?,?,?)').run(threadId,process.pid,serverPid || null,options.id || null,nonce);
    db.exec('COMMIT');return {file,threadId,nonce};
  }finally{db.close();}
}
function releaseThread(lease){
  if(!lease)return;
  const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(lease.file);
  try{db.exec('PRAGMA busy_timeout=100');db.prepare('DELETE FROM owners WHERE thread=? AND nonce=?').run(lease.threadId,lease.nonce);}
  finally{db.close();}
}
function getJson(port,url){return new Promise((resolve,reject)=>{
  const req=http.get({hostname:'127.0.0.1',port,path:url,timeout:2000},res=>{let text='';res.on('error',reject);res.on('data',c=>{text+=c;if(text.length>1024*1024)req.destroy(new Error('本机 Hub 响应过大'));});res.on('end',()=>{try{resolve(JSON.parse(text));}catch(e){reject(e);}});});req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('旧 Hub 暂未响应')));
});}
async function readOtherHubSessions(control){
  if(!control.cdpPort)throw new Error('旧 Hub 未开放状态核对入口');
  const version=await getJson(control.cdpPort,'/json/version');
  const browserUrl=new URL(version.webSocketDebuggerUrl);
  if(!['127.0.0.1','localhost','[::1]'].includes(browserUrl.hostname)||Number(browserUrl.port)!==Number(control.cdpPort))throw new Error('旧 Hub 浏览器核对地址无效');
  await new Promise((resolve,reject)=>{
    const ws=new WebSocket(browserUrl.href);let done=false;
    const finish=error=>{if(done)return;done=true;clearTimeout(timer);ws.close();error?reject(error):resolve();};
    const timer=setTimeout(()=>finish(new Error('旧 Hub 进程核对超时')),3000);
    ws.on('error',finish);ws.on('close',()=>{if(!done)finish(new Error('旧 Hub 进程核对已断开'));});
    ws.on('open',()=>ws.send(JSON.stringify({id:1,method:'SystemInfo.getProcessInfo'})));
    ws.on('message',bytes=>{let m;try{m=JSON.parse(bytes);}catch(e){finish(e);return;}if(m.id!==1)return;
      const browser=m.result?.processInfo?.find(p=>p.type==='browser');
      finish(Number(browser?.id)===control.pid?null:new Error('旧 Hub 端口与进程身份不匹配'));
    });
  });
  const targets=await getJson(control.cdpPort,'/json/list');
  const target=targets.find(t=>t.type==='page' && /^file:/.test(t.url) && /\/renderer\/index\.html$/.test(t.url));
  if(!target || !target.webSocketDebuggerUrl)throw new Error('旧 Hub 状态窗口不可达');
  const u=new URL(target.webSocketDebuggerUrl);if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||Number(u.port)!==Number(control.cdpPort))throw new Error('旧 Hub 核对地址无效');
  return new Promise((resolve,reject)=>{
    const ws=new WebSocket(u.href);let done=false;
    const finish=(err,result)=>{if(done)return;done=true;clearTimeout(timer);ws.close();err?reject(err):resolve(result);};
    const timer=setTimeout(()=>finish(new Error('旧 Hub 状态核对超时')),3000);
    ws.on('error',e=>finish(e));ws.on('close',()=>{if(!done)finish(new Error('旧 Hub 状态连接已关闭'));});
    ws.on('open',()=>ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{awaitPromise:true,returnByValue:true,
      expression:'require("electron").ipcRenderer.invoke("get-sessions").then(rows=>({sessions:rows.filter(s=>s.kind==="codex"||s.kind==="codex-resume").map(s=>({id:s.id,kind:s.kind,codexSid:s.codexSid,draft:typeof floatingInputDrafts!=="undefined"?floatingInputDrafts.get(s.id)||"":""}))}))'
    }})));
    ws.on('message',bytes=>{let m;try{m=JSON.parse(bytes);}catch(e){finish(e);return;}if(m.id!==1)return;
      if(m.error||m.result?.exceptionDetails)return finish(new Error('旧 Hub 无法返回会话归属'));
      const value=m.result?.result?.value;if(!Array.isArray(value?.sessions))return finish(new Error('旧 Hub 返回的会话列表无效'));
      finish(null,value.sessions);
    });
  });
}
async function assertNoOtherHubOwner(options,threadId,readSessions=readOtherHubSessions){
  const data=options.env?.CLAUDE_HUB_DATA_DIR || path.join(os.homedir(),'.claude-session-hub');
  const dir=path.join(data,'control');let files;
  try{files=fs.readdirSync(dir);}catch(e){if(e.code==='ENOENT')return;throw e;}
  for(const name of files.filter(n=>/^\d+\.json$/.test(n))){
    const pid=Number(name.slice(0,-5));if(pid===process.pid || !alive(pid))continue;
    let control;try{control=JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'));}catch(e){throw new Error('旧 Hub 接管记录不可读，暂不能恢复该会话');}
    if(control.pid!==pid)throw new Error('旧 Hub 进程身份不匹配，暂不能恢复该会话');
    const rows=await readSessions(control);
    const owner=rows.find(s=>(s.kind==='codex'||s.kind==='codex-resume') && (s.codexSid===threadId || s.id===options.id));
    if(owner) {
      const error=new Error('原 Hub 仍持有这个 Codex 会话，请在原窗口结束会话后恢复；没有启动第二个任务');
      if(owner.id===options.id && typeof owner.draft==='string')error.nativeDraft=owner.draft;
      throw error;
    }
  }
}
module.exports={claimThread,releaseThread,assertNoOtherHubOwner,readOtherHubSessions,alive};
