'use strict';
// Opt-in local Harness metadata probe. A dummy credential and an RPC fence
// guarantee this probe cannot submit a model prompt or spend the subscription.
const fs=require('fs'), os=require('os'), path=require('path');
const {buildAcpOptions}=require('../core/acp-profiles');
const {AcpSession}=require('../core/acp-session');
const {AcpClient}=require('../main/acp-client');
const original=AcpClient.prototype.request;
AcpClient.prototype.request=function(method,...args) {
  if(method==='session/prompt')throw new Error('Inference forbidden in config-only probe');
  return original.call(this,method,...args);
};
async function main() {
  const configPath=process.argv[2]; if(!configPath)throw new Error('Usage: node scripts/probe-acp-config-only.js <config.json> <output.json>');
  const config=JSON.parse(fs.readFileSync(configPath,'utf8').replace(/^\uFEFF/,''));
  config.acp.apiKey='dummy-config-only-not-a-real-key';
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-acp-config-only-'));
  const results={modelRequests:0,root,providers:{}};
  for(const kind of ['qwen','deepseek-acp','glm']) {
    const options=buildAcpOptions(kind,{id:kind,cwd:root},config,root);
    const session=new AcpSession(options);
    try {
      await session.start();
      results.providers[kind]={configOptions:session.configOptions,capabilities:session.capabilities};
      const choices=require('../core/acp-model-catalog').acpModelOptions(kind);
      for(const {id} of choices) {
        await session.configure({model:id});
        const thought=session.configOptions.find(o=>o.category==='thought_level');
        results.providers[kind].models ||= {};
        results.providers[kind].models[id]={thought:thought || null};
        for(const option of (thought?.options || []).flatMap(o=>o.options || [o])) await session.configure({effort:option.value});
      }
      console.log(kind+': mode, model and thought configuration confirmed without inference');
    } catch(e) {results.providers[kind]={...results.providers[kind],error:e.message};console.error(kind+': '+e.message);process.exitCode=1;}
    finally {session.kill();fs.writeFileSync(process.argv[3],JSON.stringify(results,null,2));}
  }
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
