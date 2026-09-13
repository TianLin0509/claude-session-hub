'use strict';
// Explicit real-provider diagnostic, never included in automatic unit runs.
// Clone only auth into a temporary home; preserve model/effort and delete the
// temporary credential after closing the owned server.
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict');
const {CodexNativeSession}=require('../core/codex-native-session');
const {createHash}=require('crypto');
async function main(){
  const source=process.env.CODEX_HOME || path.join(os.homedir(),'.codex');
  const configFile=path.join(source,'config.toml'),authFile=path.join(source,'auth.json');
  const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  const before={config:hash(configFile),auth:hash(authFile)};
  const config=fs.readFileSync(configFile,'utf8'),read=k=>config.match(new RegExp('^'+k+'\\s*=\\s*"([^"]+)"','m'))?.[1];
  const model=read('model'),effort=read('model_reasoning_effort'),tier=read('service_tier');assert(model&&effort);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'real-native-goal-')),home=path.join(root,'codex'),cwd=path.join(root,'workspace');
  fs.mkdirSync(home);fs.mkdirSync(cwd);
  const env={...process.env,CODEX_HOME:home,CLAUDE_HUB_DATA_DIR:path.join(root,'data'),CLAUDE_HUB_HOME_DIR:path.join(root,'home'),DEEPSEEK_API_KEY:''};
  for(const key of Object.keys(env))if(key.startsWith('CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE') || key==='CODEX_THREAD_ID' || key==='CODEX_SESSION_ID')delete env[key];
  fs.writeFileSync(path.join(home,'config.toml'),'model = '+JSON.stringify(model)+'\nmodel_reasoning_effort = '+JSON.stringify(effort)+'\n'+(tier?'service_tier = '+JSON.stringify(tier)+'\n':''));
  fs.copyFileSync(authFile,path.join(home,'auth.json'));
  const session=new CodexNativeSession({id:'real-goal-probe',cwd,env,
    threadParams:{model,approvalPolicy:'never',sandbox:'read-only',config:{model_reasoning_effort:effort}},
    turnParams:{model,effort,...(tier?{serviceTier:tier}:{})}});
  const result={model,effort,tier,checks:[],passed:false};
  try{
    await session.start();
    result.server=session.entry.client.initialized;
    assert.match((await session.send('/model')).commandOutput,new RegExp(model));result.checks.push('real model/list');
    const reply=await session.send('/goal 这是隔离协议验证。只回复 HUB_GOAL_OK，然后把目标标记为完成。不要读写文件、不要联网、不要调用除目标完成以外的工具。');
    result.goalOutput=reply.commandOutput;
    assert.match(reply.commandOutput,/隔离协议验证/);
    const deadline=Date.now()+180000;
    while(Date.now()<deadline && !['completed','failed','interrupted'].includes(session.runtime.state))await new Promise(r=>setTimeout(r,150));
    result.runtime={state:session.runtime.state,turnId:session.runtime.turnId,reason:session.runtime.reason};
    result.answer=session.finalText();
    assert.equal(session.runtime.state,'completed');assert.match(result.answer,/HUB_GOAL_OK/);
    result.checks.push('real goal/set starts a native turn and produces the requested answer');
    const current=await session.send('/goal');result.currentGoal=current.commandOutput;
    await session.send('/goal clear');
    result.checks.push('real goal/get and goal/clear');result.passed=true;
  }catch(error){result.error=error.stack;process.exitCode=1;}
  finally{
    const client=session.entry?.client;
    try { session.kill();if(client)await client.waitForExit(); }
    finally {
      fs.unlinkSync(path.join(home,'auth.json'));
      assert.equal(hash(configFile),before.config);assert.equal(hash(authFile),before.auth);
    }
    const out=path.resolve('artifacts/cli-command-cards/real-goal-'+Date.now()+'.json');fs.mkdirSync(path.dirname(out),{recursive:true});
    fs.writeFileSync(out,JSON.stringify(result,null,2));console.log(JSON.stringify({...result,out},null,2));
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
