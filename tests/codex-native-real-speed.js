'use strict';
// Real Codex engine with a local Responses fixture, no account credentials.
// Verifies selected settings reach the model service without an artificial turn.
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict');
const {CodexNativeSession}=require('../core/codex-native-session');
const {scrubParentControlEnv}=require('./helpers/hub-launcher');
async function main(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-native-settings-')),home=path.join(root,'codex');fs.mkdirSync(home);
  const source=process.env.CODEX_HOME||path.join(os.homedir(),'.codex');
  const config=fs.readFileSync(path.join(source,'config.toml'),'utf8'),read=k=>config.match(new RegExp('^'+k+'\\s*=\\s*"([^"]+)"','m'))?.[1];
  const model=read('model'),originalEffort=read('model_reasoning_effort'),tier=read('service_tier');assert(model&&originalEffort);
  fs.copyFileSync(path.join(source,'models_cache.json'),path.join(home,'models_cache.json'));
  const fixture=await require('./fixtures/codex-responses-server').startResponsesFixture({chunks:1,delayMs:20});
  fs.writeFileSync(path.join(home,'config.toml'),'model='+JSON.stringify(model)+'\nmodel_reasoning_effort='+JSON.stringify(originalEffort)+'\nservice_tier='+JSON.stringify(tier||'fast')+'\nmodel_provider="settings_fixture"\n[model_providers.settings_fixture]\nname="Native settings verification"\nbase_url="http://127.0.0.1:'+fixture.port+'/v1"\nwire_api="responses"\nenv_key="HUB_SETTINGS_FIXTURE_KEY"\nsupports_websockets=false\nrequires_openai_auth=false\n[windows]\nsandbox="unelevated"\n');
  const launch=require('../core/session-manager')._private.buildNativeCodexOptions({kind:'codex',cwd:root,currentModel:{id:model},effort:originalEffort,codexSpeedTier:'standard',mcpProfile:'none'},{},{CODEX_HOME:home});
  const s=new CodexNativeSession({...launch,id:'real-settings',cwd:root,env:{...scrubParentControlEnv(process.env),CODEX_HOME:home,CLAUDE_HUB_DATA_DIR:path.join(root,'hub'),HUB_SETTINGS_FIXTURE_KEY:'isolated'}});
  const result={root,model,originalEffort,tier,passed:false,checks:[]};
  try{
    await s.start();const threadId=s.threadId;
    for(const codexSpeedTier of ['standard','fast','standard']){
      const effort=originalEffort;
      const before=s.history.size,count=fixture.requests.length;
      const choice=await s.configure({codexSpeedTier});assert.equal(choice.appliesOn,'next-turn');assert.equal(s.history.size,before);assert.equal(fixture.requests.length,count);
      await s.send('Native settings delivery '+effort);await s.idle(60000);
      assert.equal(s.runtime.state,'completed');assert.equal(s.threadId,threadId);
      const request=fixture.requests.filter(r=>r.purpose==='workload').at(-1);assert.equal(request.model,model);assert.equal(request.effort,effort);assert.equal(request.serviceTier,codexSpeedTier==='fast'?'priority':undefined);
      result.checks.push({codexSpeedTier,effort,turnId:s.runtime.turnId,serviceTier:request.serviceTier});
    }
    result.passed=true;
  }finally{
    const client=s.entry?.client;const exited=new Promise(resolve=>s.once("exit",resolve));s.kill();await exited;if(client)await client.waitForExit();await fixture.close();result.requests=fixture.requests;
    const out=path.resolve('artifacts/codex-native-runtime/real-speed-'+Date.now()+'.json');fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(result,null,2));console.log(JSON.stringify({out,passed:result.passed,checks:result.checks}));
  }
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});

