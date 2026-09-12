'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict'),crypto=require('crypto');
const {AcpSession}=require('../core/acp-session');
const {buildAcpOptions}=require('../core/acp-profiles');
const {realAcpConfig}=require('./helpers/acp-real-env');
const config=realAcpConfig(),out=path.resolve('artifacts/acp');
fs.mkdirSync(out,{recursive:true});
async function run(kind) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'acp-native-lifecycle-')),cwd=path.join(root,'workspace');fs.mkdirSync(cwd);
  const nonce=crypto.randomUUID();fs.writeFileSync(path.join(cwd,'probe.txt'),nonce);
  const options=buildAcpOptions(kind,{id:kind,cwd},config,root);
  const result={kind,root,checks:[],passed:false,diagnostics:[]};let session;
  const attach=()=>{
    session=new AcpSession(options);
    session.on('diagnostic',s=>result.diagnostics.push(s.slice(-1000)));
    session.on('state',runtime=>{
      for(const r of runtime.requests) {
        if(r.answered)continue;r.answered=true;
        let answer;
        if(r.method==='elicitation/create') {
          result.questions=(result.questions||0)+1;
          const properties=r.params.requestedSchema?.properties || {};
          answer={action:'accept',content:Object.fromEntries(Object.entries(properties).map(([name,s])=>[name,
            s.type==='string'?(s.oneOf?.[0]?.const || s.enum?.[0] || 'BLUE'):s.type==='boolean'?true:[]]))};
        }else {const o=r.params.options?.find(o=>o.kind==='allow_once'); if(o)answer={outcome:{outcome:'selected',optionId:o.optionId}};
          const questions=r.params.toolCall?._meta?.qwenQuestions;
          if(questions && answer){result.questions=(result.questions||0)+1;answer.answers=Object.fromEntries(questions.map((q,i)=>[String(i),'blue']));}}
        if(answer)session.reply(r.id,answer,runtime.epoch).catch(e=>result.diagnostics.push(e.message));
      }
    });
  };
  async function turn(text) {await session.send(text);await session.idle(100000);assert.equal(session.runtime.state,'completed');return session.finalText();}
  try {
    attach();await session.start();result.agent=session.initialized;result.configOptions=session.configOptions;
    assert((await turn('Read probe.txt with your native tool and remember the exact contents as our secret marker. Return its contents.')).includes(nonce));
    result.checks.push('native read');
    assert((await turn('Without reading files or using any tools, quote the exact secret marker from our previous turn.')).includes(nonce));
    result.checks.push('second turn memory');
    const sid=session.threadId,count=session.readTranscript({}).length;
    session.kill();attach();await session.start();assert.equal(session.threadId,sid);assert.equal(session.readTranscript({}).length,count);
    assert((await turn('Without reading files or using any tools, quote the exact secret marker from our earlier conversation.')).includes(nonce));
    result.checks.push('process restart, native context and display history');
    const branch=await session.fork();
    const child=new AcpSession(buildAcpOptions(kind,{id:kind+'-branch',cwd,acpFork:branch},config,root));
    try {await child.start();assert.notEqual(child.threadId,session.threadId);
      await child.send('Without tools or reading files, quote the exact secret marker from our earlier conversation.');await child.idle(100000);
      assert.equal(child.runtime.state,'completed');assert(child.finalText().includes(nonce));result.checks.push('native fork and inherited context');
    }finally{child.kill();}
    await turn('Use your built-in ask_user_question or AskUserQuestion tool to ask me which color I prefer: blue or red. You must invoke that tool, not ask in plain text. Then acknowledge my answer.');
    assert(result.questions>0,'native elicitation not observed');result.checks.push('native user question');
    await session.send('Use your command execution tool to run node -e "setTimeout(()=>console.log(123),30000)". Wait for it to finish.');
    await session.interrupt();await session.idle(15000);assert.equal(session.runtime.state,'interrupted');result.checks.push('cancel confirmed');
    result.passed=true;
  }catch(e){result.error=e.message;result.details=e.details;}
  finally {if(session){result.transcript=session.readTranscript({});session.kill();}fs.writeFileSync(path.join(out,kind+'-lifecycle-real.json'),JSON.stringify(result,null,2).split(config.acp.apiKey).join('[REDACTED]'));}
  console.log(JSON.stringify({kind,passed:result.passed,checks:result.checks,error:result.error}));return result.passed;
}
(async()=>{let ok=true;for(const kind of process.argv.slice(2).length?process.argv.slice(2):Object.keys(config.acp.providers))ok=await run(kind)&&ok;if(!ok)process.exitCode=1;})().catch(e=>{console.error(e.message);process.exitCode=1;});
