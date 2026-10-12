'use strict';
// UI-only route selection. Cloud execution is covered by e2e-provider-cli-cdp.
const fs=require('fs'),path=require('path'),os=require('os'),net=require('net'),assert=require('assert/strict');
const {launchIsolatedHub,gracefulQuit}=require(path.resolve('tests/helpers/hub-launcher'));
const {connectFirstPage}=require(path.resolve('tests/helpers/cdp-client'));
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-deepseek-route-'));
 const out=path.resolve('artifacts/deepseek-route/'+Date.now());fs.mkdirSync(out,{recursive:true});
 const result={root,out,passed:false};let hub,c;
 try{
  const port=await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
  hub=await launchIsolatedHub({dataDir:path.join(root,'data'),port});c=await connectFirstPage(hub);
  const until=async expr=>{const end=Date.now()+60000;while(Date.now()<end){if(await c.eval(expr))return;await new Promise(r=>setTimeout(r,100));}throw Error('timeout '+expr);};
  await until('typeof openMeetingCreateModal==="function"');
  await c.eval("openMeetingCreateModal('group')");
  await until('!!document.querySelector(".mcm-ai-select")');
  const select=async(selector,value)=>c.eval(`(()=>{const s=document.querySelector(${JSON.stringify(selector)});s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  // 2026-10-11：DeepSeek 成员一律跑 Claude Code，接入方式 Token Plan（默认）/ 官方 API。
  await select('.mcm-ai-select','deepseek-claude');
  result.default=await c.eval(`({route:document.querySelector('.mcm-deepseek-route').value,kind:document.querySelector('.mcm-slot').dataset.kind,model:document.querySelector('.mcm-model-select').value})`);
  assert.deepEqual(result.default,{route:'tokenplan',kind:'deepseek-claude',model:'deepseek-v4.1-flash'});
  await select('.mcm-deepseek-route','api');
  assert.equal(await c.eval(`document.querySelector('.mcm-slot').dataset.kind`),'deepseek-claude');
  assert.equal(await c.eval(`document.querySelector('.mcm-deepseek-route').value`),'api');
  result.passed=true;
 }catch(error){result.error=error.stack;process.exitCode=1;}
 finally{
  try{if(c){fs.writeFileSync(path.join(out,'route.png'),Buffer.from((await c.send('Page.captureScreenshot',{format:'png'})).data,'base64'));await c.close();}if(hub)await gracefulQuit(hub);}
  catch(error){result.teardownError=error.stack;result.passed=false;process.exitCode=1;}
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }
})().catch(error=>{console.error(error);process.exitCode=1});
