'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict');
const {AcpSession}=require('../core/acp-session'),{buildAcpOptions}=require('../core/acp-profiles'),{realAcpConfig}=require('./helpers/acp-real-env');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function run(kind){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-acp-cancel-')),config=realAcpConfig();
  const out=path.resolve('artifacts/acp/cancel-'+kind+'-'+Date.now());fs.mkdirSync(out,{recursive:true});
  const target=path.join(out,'unapproved.txt'),started=path.join(root,'started.txt'),late=path.join(root,'late.txt'),script=path.join(root,'slow.js');
  fs.writeFileSync(script,`require('fs').writeFileSync(${JSON.stringify(started)},'started');setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(late)},'late side effect'),8000);`);
  const s=new AcpSession(buildAcpOptions(kind,{id:kind,cwd:root},config,root)),result={kind,root,out,checks:[],passed:false};let autoApprove=false;
  s.on('state',runtime=>{if(!autoApprove)return;for(const q of runtime.requests){if(q.answered)continue;q.answered=true;const o=q.params.options?.find(o=>o.kind==='allow_once');if(o)s.reply(q.id,{outcome:{outcome:'selected',optionId:o.optionId}},runtime.epoch).catch(e=>{result.replyError=e.message;});}});
  const waitFor=async(test,label,ms=90000)=>{const end=Date.now()+ms;while(Date.now()<end){if(test())return;if(s.runtime.connection!=='connected')throw Error(s.runtime.reason);await sleep(80);}throw Error('timeout '+label);};
  try{
    await s.start();await s.send('Use your native tool to write CANCEL_TEST to '+target+'. This is outside the workspace. Request permission and wait for the user; do not find another path.');
    await waitFor(()=>s.runtime.requests.length>0,'waiting for permission');const q=s.runtime.requests[0],epoch=s.runtime.epoch;
    await s.interrupt();await s.idle(15000);assert.equal(s.runtime.state,'interrupted');assert(!fs.existsSync(target));
    await assert.rejects(s.reply(q.id,{outcome:{outcome:'cancelled'}},epoch));result.checks.push('stop while waiting for permission, no write and obsolete answer rejected');
    autoApprove=true;
    await s.send('Run exactly this command with your native shell tool: node "'+script.replace(/\\/g,'/')+'". Keep the command in foreground and wait for completion. Do not modify files or run other commands.');
    await waitFor(()=>fs.existsSync(started),'actual foreground tool started');
    await s.interrupt();await s.idle(15000);assert.equal(s.runtime.state,'interrupted');
    await sleep(9000);assert(!fs.existsSync(late),'cancelled tool must not produce its delayed side effect');result.checks.push('stop actual running command and observe beyond its scheduled write');
    await s.send('Do not use tools. Reply CANCEL_RECOVERED.');await s.idle(90000);assert.equal(s.runtime.state,'completed');assert(s.finalText().includes('CANCEL_RECOVERED'));result.checks.push('next real turn succeeds after both cancellations');result.passed=true;
  }catch(e){result.error=e.message;}finally{s.kill();fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));}return result.passed;
}
(async()=>{let passed=true;for(const kind of process.argv.slice(2).length?process.argv.slice(2):['qwen','deepseek-acp','glm'])passed=await run(kind)&&passed;if(!passed)process.exitCode=1;})().catch(e=>{console.error(e);process.exitCode=1;});
