'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict');
const {AcpSession}=require('../core/acp-session'),{buildAcpOptions}=require('../core/acp-profiles'),{realAcpConfig}=require('./helpers/acp-real-env');
const config=realAcpConfig(),out=path.resolve('artifacts/acp');fs.mkdirSync(out,{recursive:true});
async function run(kind) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-acp-extensions-')),cwd=path.join(root,'workspace');fs.mkdirSync(cwd);
  const marker=crypto.randomUUID(),secret=path.join(root,'mcp-secret.txt'),log=path.join(root,'mcp-calls.txt');fs.writeFileSync(secret,marker);
  const mcpConfigPath=path.join(root,'mcp.json');fs.writeFileSync(mcpConfigPath,JSON.stringify([{name:'hub_acceptance',command:process.execPath,args:[path.join(__dirname,'fixtures/acp-test-mcp.js'),secret,log],env:[]}]));
  const cfg=structuredClone(config);cfg.acp.providers[kind].mcpConfigPath=mcpConfigPath;
  const result={kind,root,checks:[],passed:false,diagnostics:[]},sessions=[];
  const create=(id,withMcp=true)=>{const s=new AcpSession(buildAcpOptions(kind,{id,cwd},withMcp?cfg:config,root));sessions.push(s);
    s.on('diagnostic',x=>result.diagnostics.push(x));s.on('state',r=>{for(const q of r.requests){if(q.answered)continue;q.answered=true;
      const o=q.params.options?.find(o=>o.kind==='allow_once');if(o)s.reply(q.id,{outcome:{outcome:'selected',optionId:o.optionId}},r.epoch).catch(e=>result.diagnostics.push(e.message));}});return s;};
  const turn=async(s,text,opts)=>{await s.send(text,opts);await s.idle(100000);assert.equal(s.runtime.state,'completed');return s.finalText();};
  try {
    const mcp=create('mcp');await mcp.start();result.commands=mcp.commands;result.model=mcp.currentModel;
    assert((await turn(mcp,'Call the MCP tool get_test_marker and report its exact result. Do not use filesystem or shell tools.')).includes(marker));
    assert(fs.readFileSync(log,'utf8').includes('called'));result.checks.push('native MCP tool, independently observed invocation and correct secret result');
    mcp.kill();
    const a=create('a',false),b=create('b',false);await Promise.all([a.start(),b.start()]);assert.notEqual(a.threadId,b.threadId);
    const one=crypto.randomUUID(),two=crypto.randomUUID();
    fs.writeFileSync(path.join(cwd,'peer1.txt'),one);fs.writeFileSync(path.join(cwd,'peer2.txt'),two);
    const readPrompt=file=>'Use only your Read tool to read this exact absolute file path: '+file+'. Do not search or use shell commands. Remember its exact contents as our project code and return it.';
    const answers=await Promise.all([turn(a,readPrompt(path.join(cwd,'peer1.txt'))),turn(b,readPrompt(path.join(cwd,'peer2.txt')))]);
    result.concurrentAnswers=answers;
    assert(answers[0].includes(one)&&!answers[0].includes(two));assert(answers[1].includes(two)&&!answers[1].includes(one));
    a.kill();assert((await turn(b,'Return our exact project code from the conversation. Do not use tools.')).includes(two));result.checks.push('same cwd concurrent same-provider sessions, independent context and close');
    const multi='中文完整性\n\n1. 第一项 — 不拆分\n2. 第二项\n- 原文\n'+('甲乙丙丁🧪\n'.repeat(1100))+'末尾标记 '+two;
    const id=crypto.randomUUID();await turn(b,multi+'\n只回复末尾标记。',{clientSubmissionId:id});
    await b.send(multi+'\n只回复末尾标记。',{clientSubmissionId:id});
    assert.equal(b.readTranscript({}).filter(c=>c.role==='user'&&c.clientSubmissionId===id).length,1);
    assert(b.finalText().includes(two));result.checks.push('long Unicode multiline input as one turn and duplicate submission rejected');
    assert((await b.send('/model '+config.acp.providers[kind].model)).commandOutput.includes(config.acp.providers[kind].model));
    result.commands=b.commands;
    result.compactAnswer=await turn(b,'/compact');
    assert((await turn(b,'Return the exact project code from our earlier conversation, without using tools.')).includes(two));
    result.checks.push('same Plan model explicitly confirmed; native /compact followed by retained model context');
    result.passed=true;
  }catch(e){result.error=e.message;}finally{for(const s of sessions)s.kill();fs.writeFileSync(path.join(out,kind+'-extensions-real.json'),JSON.stringify(result,null,2).split(config.acp.apiKey).join('[REDACTED]'));}
  console.log(JSON.stringify({kind,passed:result.passed,checks:result.checks,error:result.error}));return result.passed;
}
(async()=>{let pass=true;for(const kind of process.argv.slice(2).length?process.argv.slice(2):Object.keys(config.acp.providers))pass=await run(kind)&&pass;if(!pass)process.exitCode=1;})().catch(e=>{console.error(e.message);process.exitCode=1;});
