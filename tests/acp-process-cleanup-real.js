'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict'),cp=require('child_process');
const {AcpSession}=require('../core/acp-session'),{buildAcpOptions}=require('../core/acp-profiles'),{realAcpConfig}=require('./helpers/acp-real-env');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
  assert.equal(process.platform,'win32');const config=realAcpConfig(),result={passed:false,checks:[]},sessions=[];
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-acp-process-'));
  try{
    for(const kind of Object.keys(config.acp.providers)){
      const cwd=path.join(root,kind);fs.mkdirSync(cwd);const s=new AcpSession(buildAcpOptions(kind,{id:kind,cwd},config,root));sessions.push(s);await s.start();
      const raw=cp.execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'],{encoding:'utf8',windowsHide:true});
      const rows=JSON.parse(raw),owned=new Set([s.pid]);let changed=true;
      while(changed){changed=false;for(const r of rows)if(owned.has(r.ParentProcessId)&&!owned.has(r.ProcessId)){owned.add(r.ProcessId);changed=true;}}
      // Protocol/pipe failure uses the same exact-owned-process shutdown path.
      s.client.fail(new Error('acceptance disconnect'));assert.equal(s.runtime.connection,'disconnected');
      const exists=pid=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};
      const end=Date.now()+5000;while(Date.now()<end && [...owned].some(exists))await sleep(100);
      const remaining=[...owned].filter(exists);assert.deepEqual(remaining,[],'owned native descendants must exit on disconnect');
      result.checks.push({kind,ownedPids:[...owned],remaining});s.kill();
    }
    result.passed=true;
  }catch(e){result.error=e.message;throw e;}finally{for(const s of sessions)s.kill();fs.mkdirSync('artifacts/acp',{recursive:true});fs.writeFileSync('artifacts/acp/process-cleanup.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
