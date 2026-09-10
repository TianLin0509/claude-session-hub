'use strict';
// Opt-in real engine smoke; copies only auth into a fresh test home. Never used
// by the unit runner and never writes the user's Codex config or histories.
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict');
const {CodexNativeSession}=require('../core/codex-native-session');
function imageFixture(file) {
  const crc=bytes=>{let n=0xffffffff;for(const byte of bytes){n^=byte;for(let k=0;k<8;k++)n=(n>>>1)^((n&1)?0xedb88320:0);}return (n^0xffffffff)>>>0;};
  const chunk=(name,data)=>{const type=Buffer.from(name),head=Buffer.alloc(4),tail=Buffer.alloc(4);head.writeUInt32BE(data.length);tail.writeUInt32BE(crc(Buffer.concat([type,data])));return Buffer.concat([head,type,data,tail]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(64,0);header.writeUInt32BE(64,4);header[8]=8;header[9]=2;
  const pixels=Buffer.alloc(64*(64*3+1));for(let y=0;y<64;y++)for(let x=0;x<64;x++)pixels[y*193+1+x*3+2]=255;
  fs.writeFileSync(file,Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',require('zlib').deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]));
}
async function main(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-codex-native-real-'));
  const home=path.join(root,'codex'),cwd=path.join(root,'workspace');
  fs.mkdirSync(home);fs.mkdirSync(cwd);fs.writeFileSync(path.join(cwd,'probe.txt'),'NATIVE_TOOL_OK');
  const original=process.env.CODEX_HOME || path.join(os.homedir(),'.codex');
  const config=fs.readFileSync(path.join(original,'config.toml'),'utf8');
  const get=k=>config.match(new RegExp('^'+k+'\\s*=\\s*"([^"]+)"','m'))?.[1];
  const model=get('model'),effort=get('model_reasoning_effort'),serviceTier=get('service_tier');
  assert(model && effort,'real smoke requires the existing explicit model and effort');
  fs.copyFileSync(path.join(original,'auth.json'),path.join(home,'auth.json'));
  if(fs.existsSync(path.join(original,'models_cache.json'))) fs.copyFileSync(path.join(original,'models_cache.json'),path.join(home,'models_cache.json'));
  fs.writeFileSync(path.join(home,'config.toml'),'model = '+JSON.stringify(model)+'\nmodel_reasoning_effort = '+JSON.stringify(effort)+'\n'+(serviceTier?'service_tier = '+JSON.stringify(serviceTier)+'\n':''));
  const env={...process.env,CODEX_HOME:home,CLAUDE_HUB_DATA_DIR:path.join(root,'data')};
  for(const k of ['CODEX_THREAD_ID','CODEX_SESSION_ID','CLAUDE_HUB_SESSION_ID','CLAUDE_HUB_PORT','CLAUDE_HUB_TOKEN','CLAUDECODE','AI_TEAM_HUB_CALLBACK_URL']) delete env[k];
  const n=new CodexNativeSession({id:'real-smoke',cwd,env,
    threadParams:{cwd,model,approvalPolicy:'never',sandbox:'read-only',config:{model_reasoning_effort:effort,'windows.sandbox':'unelevated'}},
    turnParams:{model,effort}});
  const record={root,model,effort,serviceTier,events:[],states:[],checks:[],passed:false};
  n.on('state',r=>record.states.push({state:r.state,connection:r.connection,turnId:r.turnId,revision:r.revision,reason:r.reason}));
  n.on('lifecycle',e=>{record.events.push(e);console.log('EVENT',e.type,e.turnId,e.type==='turn-complete'?e.text || '':'');});
  n.on('diagnostic',text=>console.error('DIAGNOSTIC',text));
  const timer=setTimeout(()=>{console.error('real smoke timeout');n.kill();},300000);
  try{
    await n.start();console.log('CONNECTED',n.threadId,model,effort);
    const receipt=await n.send('这是 AI Hub 隔离协议验收。不要调用工具，不要修改任何文件。只回复这一行：NATIVE_RUNTIME_OK。');
    await n.idle();
    assert.equal(n.runtime.state,'completed');
    assert(n.finalText().includes('NATIVE_RUNTIME_OK'));
    assert.equal(receipt.turnId,n.runtime.turnId);
    await n.reconcile();
    assert.equal(n.runtime.state,'completed');

    let history=await n.entry.client.request('thread/read',{threadId:n.threadId,includeTurns:true});
    const submitted=history.thread.turns.flatMap(t=>t.items).find(i=>i.type==='userMessage' && i.clientId===receipt.clientSubmissionId);
    record.nativeClientId=!!submitted;
    assert(submitted,'native clientUserMessageId must survive thread/read');
    record.checks.push('short text + exact native client id + terminal replay');
    const longText='这是隔离长输入验收。下面全部是同一条消息，请不要调用工具或修改文件。只回答 LONG_NATIVE_OK。\n'+Array.from({length:180},(_,i)=>i+'. — 中文、多行、emoji 😀、空白校验；编号 '+i+' / sample line').join('\n');
    const longReceipt=await n.send(longText);
    await n.idle();assert.equal(n.runtime.state,'completed');assert(n.finalText().includes('LONG_NATIVE_OK'));
    history=await n.entry.client.request('thread/read',{threadId:n.threadId,includeTurns:true});
    const allUser=history.thread.turns.flatMap(t=>t.items).filter(i=>i.type==='userMessage');
    const nativeLong=allUser.find(i=>i.clientId===longReceipt.clientSubmissionId);
    assert.equal(nativeLong.content.filter(i=>i.type==='text').map(i=>i.text).join(''),longText);
    assert.equal(history.thread.turns.length,2);record.longInputChars=longText.length;
    record.checks.push('long Chinese multiline input is byte-exact and creates one turn');
    const command='请使用 shell 工具执行 Get-Content -LiteralPath ./probe.txt，读取当前隔离目录已经准备好的样本文件；不要访问其他目录、不要修改文件。确认读到 NATIVE_TOOL_OK 后只回复 TOOL_DONE。';
    await n.send(command);await n.idle();assert.equal(n.runtime.state,'completed');
    history=await n.entry.client.request('thread/read',{threadId:n.threadId,includeTurns:true});
    const toolItems=history.thread.turns.at(-1).items.filter(i=>i.type==='commandExecution');
    record.toolPassed=toolItems.some(i=>i.status==='completed' && i.exitCode===0);record.tools=toolItems.map(i=>({id:i.id,command:i.command,status:i.status,exitCode:i.exitCode}));
    assert(record.toolPassed,'real tool must complete successfully, not merely appear');
    record.checks.push(toolItems.length?'real native command tool lifecycle':'BLOCKED: read-only tool execution rejected by policy');
    const imagePath=path.join(cwd,'blue.png');imageFixture(imagePath);
    const imageReceipt=await n.send('这是图片输入验收。无需调用工具；识别附图的主要颜色，只回复颜色名称。',{attachments:[{type:'localImage',path:imagePath}]});
    await n.idle();assert.equal(n.runtime.state,'completed');assert.match(n.finalText(),/blue|蓝/i);
    history=await n.entry.client.request('thread/read',{threadId:n.threadId,includeTurns:true});
    const imageUser=history.thread.turns.at(-1).items.find(i=>i.type==='userMessage' && i.clientId===imageReceipt.clientSubmissionId);
    assert(imageUser && imageUser.content.some(i=>i.type==='localImage' && i.path===imagePath));
    record.checks.push('real local image input preserves exact native client identity and path');
    const threadId=n.threadId,knownTurn=n.runtime.turnId;
    const fork=new CodexNativeSession({...n.options,id:'real-fork',forkId:threadId});
    try {await fork.start();assert.notEqual(fork.threadId,threadId);assert(fork.readTranscript().length>=n.readTranscript().length);record.forkThreadId=fork.threadId;}
    finally{await new Promise(resolve=>{fork.once('exit',resolve);fork.kill();});}
    record.checks.push('real native fork retains history');
    const originalCards=n.readTranscript().map(t=>({id:t.id,text:t.text}));
    const epoch=n.runtime.epoch;
    n.entry.client.close();await new Promise(resolve=>setTimeout(resolve,200));
    await n.reconnect();assert(n.runtime.epoch>epoch);assert.equal(n.threadId,threadId);
    assert.equal(n.runtime.turnId,knownTurn);assert.equal(n.runtime.state,'completed');
    assert.deepEqual(n.readTranscript().map(t=>({id:t.id,text:t.text})),originalCards);
    record.checks.push('real App Server restart and native resume preserve exact outcome and card identities');
    record.passed=record.toolPassed;
  }finally{
    clearTimeout(timer);
    const exited=new Promise(resolve=>n.once('exit',resolve));n.kill();await exited;
    // Credentials are test scaffolding, never an artifact.
    fs.rmSync(path.join(home,'auth.json'),{force:true});
    const dest=path.resolve('artifacts/codex-native-runtime/real-smoke-'+Date.now()+'.json');
    fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,JSON.stringify(record,null,2));
    console.log('RESULT',record.passed,dest);if(!record.passed)process.exitCode=1;
  }
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
