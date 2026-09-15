'use strict';
const fs=require('fs'), path=require('path'), os=require('os'), net=require('net'), assert=require('assert/strict'), crypto=require('crypto');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {chromium}=require(path.join(process.env.APPDATA,'npm/node_modules/playwright'));
const {requireWebTools}=require('../core/chatgpt-web-integration');
(async()=>{
  const config=requireWebTools('chatgpt-web/high');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-web-recovery-')),home=path.join(root,'codex-home'),cwd=path.join(root,'workspace');
  for(const dir of [home,cwd,path.join(root,'runtime')]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(root,'isolation.json'),JSON.stringify({version:1,purpose:'ai-hub-chatgpt-only',port:config.port}));
  fs.writeFileSync(path.join(root,'runtime/config.json'),JSON.stringify({host:'127.0.0.1',port:config.port,mode:'full',proAvailable:config.proAvailable}));
  fs.writeFileSync(path.join(home,'config.toml'),'model="chatgpt-web/high"\n');
  fs.writeFileSync(path.join(home,'auth.json'),JSON.stringify({OPENAI_API_KEY:'local-chatgpt-web-only-not-an-api-key'}));
  const nonce=crypto.randomBytes(12).toString('hex'); fs.writeFileSync(path.join(cwd,'input.txt'),nonce);
  const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));
  const evidence={ok:false,root,model:'chatgpt-web/high',port};let hub,browser;
  try{
    hub=await launchIsolatedHub({dataDir:path.join(root,'data'),port,label:'web-recovery',windowMode:'hidden',extraEnv:{CODEX_HOME:home,AI_HUB_CHATGPT_ROOT:root,AI_HUB_WORKSPACE_ROOT:cwd}});
    browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);const p=browser.contexts()[0].pages()[0];
    await p.waitForFunction(()=>!!window.WorkspaceController);
    await p.locator('#btn-new-more').click();await p.locator('.new-session-option[data-kind="chatgpt"]').click();
    await p.waitForFunction(()=>document.querySelector('#new-session-model')?.value==='chatgpt-web/high');
    await p.locator('#new-session-submit').click();
    await p.waitForFunction(()=>[...sessions.values()].some(s=>s.currentModel?.id==='chatgpt-web/high'),null,{timeout:75000});
    const id=await p.evaluate(()=>[...sessions.values()].find(s=>s.currentModel?.id==='chatgpt-web/high').id);evidence.sessionId=id;
    await p.locator(`.session-item[data-session-id="${id}"]`).click();
    evidence.creationPassed=true;
    await p.locator('.floating-input-box:visible').fill(`In the test directory ${cwd}, read input.txt using local file tools, copy its exact contents into proof.txt using a local command, and reply with the contents of proof.txt. Only access this test directory. Do not access other directories or processes.`);
    await p.locator('.floating-input-send:visible').click();
    await p.waitForFunction(id=>['completed','failed','unknown'].includes(sessions.get(id)?.nativeRuntime?.state),id,{timeout:240000});
    evidence.runtime=await p.evaluate(id=>{const r=sessions.get(id).nativeRuntime;return {state:r.state,error:r.error,threadId:r.threadId};},id);
    assert.equal(evidence.runtime.state,'completed',JSON.stringify(evidence.runtime));
    assert.equal(fs.readFileSync(path.join(cwd,'proof.txt'),'utf8'),nonce);
    evidence.localFileReadWrite=true;
    await p.screenshot({path:path.resolve(__dirname,'../artifacts/20260915-chatgpt-recovery-codex1.png')});
    evidence.ok=true;
  }catch(e){evidence.error=e.message;process.exitCode=1;}
  finally{
    if(browser)await browser.close();
    if(hub){
      evidence.exit=await gracefulQuit(hub);
      // The verified Hub has exited. Release this test's pipe readers, which
      // Windows descendants can otherwise keep open after the writer exits.
      hub.child.stdout?.destroy();hub.child.stderr?.destroy();
    }
    fs.mkdirSync(path.resolve(__dirname,'../artifacts'),{recursive:true});
    fs.writeFileSync(path.resolve(__dirname,'../artifacts/20260915-chatgpt-recovery-codex1.json'),JSON.stringify(evidence,null,2));
    console.log(JSON.stringify(evidence));
  }
})();
