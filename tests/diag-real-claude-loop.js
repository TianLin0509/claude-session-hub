'use strict';
// Runs a real bundled /loop in an isolated profile and closes only its engine.
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict');
const {ClaudeNativeSession}=require('../core/claude-native-session');
const {createHash}=require('crypto');
async function main(){
  const source=process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(),'.claude');
  const auth=path.join(source,'.credentials.json'),settings=path.join(source,'settings.json');
  const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  const before=hash(auth);
  const current=fs.existsSync(settings)?JSON.parse(fs.readFileSync(settings,'utf8')):{};
  const model=current.model || 'claude-opus-5[1m]';
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'real-claude-loop-')),home=path.join(root,'claude'),cwd=path.join(root,'workspace');
  fs.mkdirSync(home);fs.mkdirSync(cwd);
  fs.copyFileSync(auth,path.join(home,'.credentials.json'));
  const env={...process.env,CLAUDE_CONFIG_DIR:home};
  for(const key of Object.keys(env))if(key==='CLAUDECODE' || key.startsWith('CLAUDE_HUB_') || key.startsWith('ARENA_HUB_'))delete env[key];
  env.CLAUDE_HUB_DATA_DIR=path.join(root,'data');env.CLAUDE_HUB_HOME_DIR=path.join(root,'home');env.DEEPSEEK_API_KEY='';
  const session=new ClaudeNativeSession({id:'real-loop-probe',kind:'claude',cwd,env,
    executable:path.join(os.homedir(),'.local','bin','claude.exe'),
    launchArgs:['--model',model,'--permission-mode','default','--effort','max'],
    initializeTimeoutMs:60000,submissionTimeoutMs:120000,commandTimeoutMs:120000});
  const result={model,effort:'max',passed:false};
  const deadline=setTimeout(()=>session.close().catch(error=>console.error(error.message)),180000);
  try{
    await session.start();
    result.commands=(session.client.initialization.commands || []).map(c=>c.name);
    const reply=await session.slash('/loop 1h 只回复 HUB_LOOP_TICK。这是隔离测试，不读写文件，不联网。',{clientSubmissionId:'loop-one'});
    result.reply=reply;
    const cards=session.transcript();
    result.tools=cards.flatMap(c=>c.toolCalls || []).map(t=>({name:t.name,input:t.input,output:t.output,isError:t.isError}));
    result.text=cards.filter(c=>c.role==='assistant').map(c=>c.text).join('\n');
    assert.equal(reply.ok,true);
    assert.ok(result.tools.some(t=>/CronCreate|ScheduleWakeup/.test(t.name) && !t.isError),'real loop must create a scheduled job');
    result.passed=true;
  }catch(error){result.error=error.stack;process.exitCode=1;}
  finally{
    clearTimeout(deadline);
    try { await session.close(); }
    finally { fs.unlinkSync(path.join(home,'.credentials.json'));assert.equal(hash(auth),before); }
    const out=path.resolve('artifacts/cli-command-cards/real-loop-'+Date.now()+'.json');fs.mkdirSync(path.dirname(out),{recursive:true});
    fs.writeFileSync(out,JSON.stringify(result,null,2));console.log(JSON.stringify({...result,out},null,2));
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
