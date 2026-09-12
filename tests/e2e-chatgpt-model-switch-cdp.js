'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict'),net=require('net');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {chromium}=require(path.join(process.env.APPDATA,'npm/node_modules/playwright'));
const {requireWebTools}=require('../core/chatgpt-web-integration');
(async()=>{
  delete process.env.ELECTRON_RUN_AS_NODE;
  const config=requireWebTools('chatgpt-web/high');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-web-switch-')),home=path.join(root,'codex-home'),cwd=path.join(root,'workspace');
  for(const dir of [home,cwd,path.join(root,'runtime')])fs.mkdirSync(dir);
  fs.writeFileSync(path.join(root,'isolation.json'),JSON.stringify({version:1,purpose:'ai-hub-chatgpt-only',port:config.port}));
  fs.writeFileSync(path.join(root,'runtime','config.json'),JSON.stringify({host:'127.0.0.1',port:config.port,mode:'full',proAvailable:true}));
  fs.writeFileSync(path.join(home,'config.toml'),'model="chatgpt-web/high"\n');
  fs.writeFileSync(path.join(home,'auth.json'),JSON.stringify({OPENAI_API_KEY:'local-chatgpt-web-only-not-an-api-key'}));
  const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
  let hub,browser;const evidence={ok:false,root,steps:[]};
  try{
    hub=await launchIsolatedHub({dataDir:path.join(root,'data'),port,label:'web-switch',windowMode:'hidden',extraEnv:{CODEX_HOME:home,AI_HUB_CHATGPT_ROOT:root,AI_HUB_WORKSPACE_ROOT:root}});
    browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);const p=browser.contexts()[0].pages()[0];
    await p.waitForFunction(()=>typeof sessions!=='undefined');
    const session=await p.evaluate(input=>ipcRenderer.invoke('create-session',input),{kind:'chatgpt',opts:{cwd,model:'chatgpt-web/high',effort:'high',mcpProfile:'none'}});
    await p.waitForFunction(id=>sessions.get(id)?.nativeRuntime?.state==='idle',session.id,{timeout:60000});
    await p.locator(`.session-item[data-session-id="${session.id}"]`).click();
    for(const [model,effort] of [['medium','medium'],['pro','ultra'],['high','high']]){
      assert((await p.locator('.composer-model:visible').innerText()).includes('ChatGPT Web'));
      await p.locator(model==='medium'?'.composer-thinking:visible':'.composer-model:visible').click();
      await p.locator('.chatgpt-web-settings-link').waitFor();
      await p.locator(`.model-picker-item[data-model-id="chatgpt-web/${model}"]`).click();
      try{await p.waitForFunction(({id,model,effort})=>sessions.get(id)?.currentModel?.id==='chatgpt-web/'+model&&sessions.get(id)?.effort===effort,{id:session.id,model,effort},{timeout:20000});}
      catch(error){throw Error('Switch failed: '+await p.locator('.model-picker-menu').innerText());}
      await p.waitForFunction(()=>!document.querySelector('.model-picker-menu'),null,{timeout:10000});
      evidence.steps.push({model,effort});
      if(model==='medium'){
        await p.locator('.floating-input-box:visible').fill('Only in the current test directory, create proof.txt containing WEB_MEDIUM_OK using a local command. Do not access other directories or processes.');
        await p.locator('.floating-input-send:visible').click();
        await p.waitForFunction(id=>sessions.get(id)?.nativeRuntime?.state==='completed',session.id,{timeout:240000});
        assert.equal(fs.readFileSync(path.join(cwd,'proof.txt'),'utf8').trim(),'WEB_MEDIUM_OK');
        evidence.mediumLocalToolExecuted=true;
      }
    }
    await p.screenshot({path:path.resolve(__dirname,'../artifacts/20260912-chatgpt-model-switch-codex1.png')});
    evidence.ok=true;
  }catch(e){evidence.error=e.message;process.exitCode=1;}
  finally{if(browser)await browser.close();if(hub)evidence.exit=await gracefulQuit(hub);fs.writeFileSync(path.resolve(__dirname,'../artifacts/20260912-chatgpt-model-switch-codex1.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));}
})();
