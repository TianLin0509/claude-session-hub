'use strict';

// Two real isolated Hub processes share one test data directory and database.
// CDP invokes the production IPC route; assertions also inspect durable row IDs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { DatabaseSync } = require('node:sqlite');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

function port() {
  return new Promise((resolve,reject)=>{
    const server=net.createServer();server.once('error',reject);
    server.listen(0,'127.0.0.1',()=>{const value=server.address().port;server.close(error=>error?reject(error):resolve(value));});
  });
}
async function until(label, fn) {
  const deadline=Date.now()+60000;
  let last;
  while(Date.now()<deadline) {
    last=await fn();if(last)return last;
    await _waitMs(100);
  }
  throw new Error('Timed out: '+label+' '+JSON.stringify(last));
}

async function main() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-search-multihub-'));
  const dataDir=path.join(root,'data'), homeDir=path.join(root,'home');
  const sourceRoot=path.join(homeDir,'.claude','projects'), project=path.join(sourceRoot,'fixture');
  const out=path.resolve(__dirname,'../output/playwright/search-multihub',path.basename(root));
  fs.mkdirSync(dataDir,{recursive:true});fs.mkdirSync(project,{recursive:true});fs.mkdirSync(out,{recursive:true});
  const title='MULTIHUB_TITLE_MARKER', liveFile=path.join(project,'live-one.jsonl');
  fs.writeFileSync(liveFile,JSON.stringify({type:'user',uuid:'u1',timestamp:new Date().toISOString(),message:{content:'MULTIHUB_INITIAL_CONTENT'}})+'\n');
  fs.writeFileSync(path.join(dataDir,'state.json'),JSON.stringify({version:1,cleanShutdown:true,sessions:[
    {hubId:'title-one',kind:'claude',title,userRenamed:true,cwd:root,lastMessageTime:1700000000000},
    {hubId:'live-one',kind:'claude',title:'Live fixture',userRenamed:true,cwd:root,ccSessionId:'live-one',transcriptPath:liveFile,lastMessageTime:1700000000000},
  ],meetings:[],immersiveByMeeting:{}}));
  const hubs=[],clients=[],result={root,out,checks:[]};
  let db;
  try {
    for(let i=0;i<2;i++) {
      const hub=await launchIsolatedHub({dataDir,port:await port(),windowMode:'hidden',label:'search-multihub-'+i,extraEnv:{
        CLAUDE_HUB_E2E:'1',CLAUDE_HUB_HOME_DIR:homeDir,DEEPSEEK_API_KEY:'',USERPROFILE:homeDir,HOME:homeDir,
        HUB_SESSION_SEARCH_CLAUDE_ROOTS:sourceRoot,HUB_SESSION_SEARCH_CODEX_ROOTS:path.join(homeDir,'.codex','sessions'),
        HUB_SESSION_SEARCH_KIMI_ROOTS:path.join(homeDir,'.kimi-code','sessions'),HUB_SESSION_SEARCH_GEMINI_ROOTS:path.join(homeDir,'.gemini','tmp'),
        HUB_SESSION_SEARCH_PREWARM:'1',HUB_SESSION_SEARCH_PREWARM_DELAY_MS:'250',
      }});
      hubs.push(hub);
      const client=await connectFirstPage(hub,target=>target.type==='page' && /renderer[\\/]index\.html/.test(target.url||''));
      clients.push(client);
      await until('Hub '+i+' indexed',async()=>{
        const s=await client.eval("require('electron').ipcRenderer.invoke('get-session-search-status')");
        return s?.ready && !s.refreshing && s.index.sessions>=2 && s;
      });
    }
    result.hubPids=hubs.map(h=>h.pid);
    assert.notEqual(result.hubPids[0],result.hubPids[1]);
    db=new DatabaseSync(path.join(dataDir,'cache','session-search-v3.sqlite'),{readOnly:true});
    const titleRows=()=>db.prepare("SELECT id,text FROM docs WHERE session_key='hub:title-one' ORDER BY id").all();
    const refresh=client=>until('explicit incremental refresh',async()=>{
      const s=await client.eval("require('electron').ipcRenderer.invoke('refresh-session-search',{immediate:true})");
      if(s?.phase==='error' || s?.phase==='child_error')throw new Error(JSON.stringify(s));
      return s?.ready && !s.refreshing && s.phase!=='waiting_writer' && s;
    });
    for(const client of clients)await refresh(client);
    const original=titleRows();assert.ok(original.length);
    for(const client of [clients[0],clients[1],clients[0],clients[1]]) {
      await refresh(client);
      assert.deepEqual(titleRows(),original);
      const found=await client.eval("require('electron').ipcRenderer.invoke('search-past-sessions',{query:'MULTIHUB_TITLE_MARKER'})");
      assert.equal(found.totalSessions,1);
    }
    result.checks.push('unchanged fallback row IDs survive four alternating refreshes','both Hub windows find exactly one title result');
    fs.appendFileSync(liveFile,JSON.stringify({type:'user',uuid:'u2',timestamp:new Date().toISOString(),message:{content:'MULTIHUB_APPENDED_CONTENT'}})+'\n');
    for(const client of clients) {
      await until('automatic watcher update visible in both Hubs',async()=>{
        const found=await client.eval("require('electron').ipcRenderer.invoke('search-past-sessions',{query:'MULTIHUB_APPENDED_CONTENT'})");
        return found.totalSessions===1 && found;
      });
      assert.deepEqual(titleRows(),original);
    }
    result.checks.push('file watcher indexes appended content without a forced rebuild','unrelated fallback rows remain unchanged during live source updates');
    result.status='PASS';
  } catch(error) {
    result.status='FAIL';result.error=error.stack||String(error);throw error;
  } finally {
    db?.close();
    for(const client of clients)client.close();
    const failures=[];
    for(const hub of hubs.reverse()) {
      try { await gracefulQuit(hub); } catch(error) { failures.push(error.message); }
      fs.writeFileSync(path.join(out,`hub-${hub.pid}.log`),hub.log().join('\n'));
    }
    if(failures.length){result.status='FAIL';result.cleanupErrors=failures;process.exitCode=1;}
    fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));
    console.log(JSON.stringify(result,null,2));
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
