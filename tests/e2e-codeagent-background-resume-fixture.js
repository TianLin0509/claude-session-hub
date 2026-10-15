'use strict';
// Controlled PTY + native JSONL/hooks. No provider calls; only this test's files.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { randomUUID } = require('node:crypto');
if (process.argv.includes('--version')) { console.log('1.2615 (CodeAgent controlled reentry fixture)'); process.exit(0); }
if (process.argv.includes('--help')) { console.log('Controlled local fixture.'); process.exit(0); }
const cfg = JSON.parse(fs.readFileSync(process.env.REENTRY_FIXTURE_CONFIG, 'utf8'));
if (process.argv.includes('--print')) { console.log('标题：模型回归'); process.exit(0); }
const sid = process.env.CLAUDE_HUB_SESSION_ID;
if (!sid || !process.env.CLAUDE_HUB_PORT || !process.env.CLAUDE_HUB_TOKEN) throw Error('Isolated interactive hook identity required');
const args = process.argv.slice(2), resume = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : null;
const fork = args.includes('--fork-session'), nativeId = resume && !fork ? resume : randomUUID();
const cwd = process.cwd(), bucket = path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
const project = path.join(process.env.CODEAGENT3_CONFIG_DIR, 'projects', bucket), nativeFile = path.join(project, nativeId + '.jsonl');
fs.mkdirSync(project, { recursive: true });
const sourceFile = resume ? path.join(project, resume + '.jsonl') : null;
const prior = sourceFile && fs.existsSync(sourceFile) ? fs.readFileSync(sourceFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
if (resume && !prior.length) throw Error('Requested native history missing in own fixture project');
if (fork) fs.writeFileSync(nativeFile, prior.map(row => JSON.stringify({ ...row, sessionId: nativeId })).join('\n') + '\n');
else if (!resume) fs.writeFileSync(nativeFile, '');
let currentModel = prior.filter(row => row.type === 'assistant').at(-1)?.message?.model || 'GLM-5.2-WX-Auto';
const savedModel = sourceFile + '.model.json';
if (resume && fs.existsSync(savedModel)) currentModel = JSON.parse(fs.readFileSync(savedModel, 'utf8')).model;
const record = data => fs.appendFileSync(cfg.log, JSON.stringify({ at: Date.now(), pid: process.pid, sid, nativeId, ...data }) + '\n');
record({ event: 'start', args, nativeFile, resumeSource: resume, fork, inheritedRows: prior.length, inheritedModel: currentModel });
let lastUuid = prior.at(-1)?.uuid || null, mode = 'prompt', line = '', wire = '', paste = false, selected = 0, lastMessage = '', requestNumber = 0;
const models = ['GLM-5.2-WX-Auto', 'MiniMax-M2.7'];
const control = () => cfg.control && fs.existsSync(cfg.control) ? JSON.parse(fs.readFileSync(cfg.control, 'utf8')) : {};
const hook = (event, extra = {}) => new Promise((resolve, reject) => {
  const body = JSON.stringify({ sessionId: sid, token: process.env.CLAUDE_HUB_TOKEN, claudeSessionId: nativeId, transcriptPath: nativeFile, cwd, ...extra });
  const req = http.request({ host: '127.0.0.1', port: Number(process.env.CLAUDE_HUB_PORT), path: '/api/hook/' + event, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, timeout: 10000 }, res => {
    let response='';res.setEncoding('utf8');res.on('data',chunk=>response+=chunk);res.on('end',()=>{record({event:'hook',hook:event,httpStatus:res.statusCode,response,reportedNativeId:JSON.parse(body).claudeSessionId,reportedTranscript:path.basename(JSON.parse(body).transcriptPath)});res.statusCode>=200&&res.statusCode<300?resolve():reject(Error('Hook HTTP '+res.statusCode));});
  });req.on('timeout',()=>req.destroy(Error('Hook timeout')));req.on('error',reject);req.end(body);
});
function screen(message) {
  if (message !== undefined) lastMessage = message;
  if (mode.startsWith('model')) {
    const body = mode === 'model-numbered' ? models.map((name, i) => (i === selected ? '  ❯ ' : '    ') + (i + 1) + '. ' + name).join('\r\n') + '\r\n\r\n  Enter to set as default · s to use this session only · Esc to cancel'
      : 'Search models...\r\nSearch: ' + line + '\r\n\r\nGLM-5.2-WX-Auto\r\nMiniMax-M2.7\r\n\r\nEnter to confirm · Esc to cancel';
    process.stdout.write('\x1b[2J\x1b[HSelect model\r\n\r\n' + body + '\r\n\r\nCONTROLLED TEST MENU — no provider\r\n');return;
  }
  process.stdout.write('\x1b[2J\x1b[HCodeAgent CONTROLLED REENTRY FIXTURE\r\n' + lastMessage.replace(/\r?\n/g,'\r\n') + '\r\n\r\n │ > Anything I can assist you with? (Ctrl+J 换行 · esc×2 清空 · ↑↓ 历史) │\r\n │ Bypass (Cycle shift+tab) | ' + currentModel + ' │\r\n');
}
function row(type, content) {
  const uuid=randomUUID(),r={type,uuid,parentUuid:lastUuid,sessionId:nativeId,cwd,isSidechain:false,timestamp:new Date().toISOString(),message:{role:type,...(type==='assistant'?{id:'msg-'+uuid,model:currentModel,stop_reason:'end_turn'}:{}),content:type==='assistant'?[{type:'text',text:content}]:content}};
  lastUuid=uuid;return r;
}
function choose() {
  currentModel=models[selected];mode='prompt';line='';
  fs.writeFileSync(nativeFile+'.model.json',JSON.stringify({model:currentModel}));
  record({event:'selected',model:currentModel});screen('Set model to '+currentModel);
}
async function submit(text) {
  record({event:'submit',mode,text,requestNumber:++requestNumber});
  if(mode==='prompt'&&text.trim()==='/model') {mode=control().menu==='search'?'model-search':'model-numbered';line='';selected=Math.max(0,models.indexOf(currentModel));record({event:'menu-open',mode});screen();return;}
  if(mode==='model-numbered'){choose();return;}if(mode==='model-search'){screen();return;}
  const before=fs.readFileSync(nativeFile,'utf8'),seedSeen=before.includes('REENTRY-SEED-761');
  const priorUserTexts=before.trim().split('\n').filter(Boolean).map(JSON.parse).filter(r=>r.type==='user'&&typeof r.message?.content==='string').map(r=>r.message.content);
  const user=row('user',text);fs.appendFileSync(nativeFile,JSON.stringify(user)+'\n');await hook('prompt',{prompt:text,turnId:user.uuid});
  const message='REENTRY_ANSWER\nactual_model='+currentModel+'\ncontext_seed_seen='+seedSeen+'\n'+text;
  fs.appendFileSync(nativeFile,JSON.stringify(row('assistant',message))+'\n');
  screen(message);await hook('stop',{lastAssistantMessage:message,turnId:user.uuid});
  record({event:'answer-ready',text,model:currentModel,seedSeen,priorUserTexts,requestNumber});screen(message);
}
let chain=Promise.resolve();
function drain(){while(wire){
  if(wire.startsWith('\x1b[200~')){paste=true;wire=wire.slice(6);continue;}
  if(wire.startsWith('\x1b[201~')){paste=false;wire=wire.slice(6);continue;}
  const seq=wire.match(/^\x1b\[[0-9;?]*[A-Za-z~]/);
  if(seq){if(mode==='model-numbered'&&(seq[0]==='\x1b[A'||seq[0]==='\x1b[B')){selected=(selected+(seq[0]==='\x1b[B'?1:models.length-1))%models.length;screen();}wire=wire.slice(seq[0].length);continue;}
  if(/^\x1b\[[0-9;?]*$/.test(wire))return;
  const ch=wire[0];wire=wire.slice(1);
  if(ch==='\x1b'){record({event:'escape',mode});if(control().escWorks!==false){mode='prompt';line='';screen('');}}
  else if(mode==='model-numbered'&&ch==='s')choose();
  else if(ch==='\r'&&!paste){const text=line;line='';if(text.trim()||mode!=='prompt')chain=chain.then(()=>submit(text)).catch(error=>{record({event:'fatal',error:error.message});process.exit(2);});}
  else if(ch==='\r'||ch==='\n')line+='\n';
  else if(ch==='\x15'||ch==='\x03'){line='';if(mode==='prompt')screen();}
  else if(ch==='\x7f'||ch==='\b')line=line.slice(0,-1);
  else if(ch>=' '){line+=ch;if(mode.startsWith('model'))screen();else process.stdout.write(ch);}
}}
process.stdout.write('\x1b[?1049h');screen();
process.stdout.on('resize',()=>{if(!line)screen();});setInterval(()=>{if(!line)screen();},1200);
let lastInjection=null;
setInterval(()=>{const state=control();if(state.targetSid===sid&&state.injectMenuNonce&&state.injectMenuNonce!==lastInjection){lastInjection=state.injectMenuNonce;setTimeout(()=>{mode=state.injectMenuStyle==='numbered'?'model-numbered':'model-search';line='';record({event:'menu-injected',nonce:lastInjection,mode});screen();},state.injectMenuAfterMs||0);}},15);
if(process.stdin.isTTY)process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{record({event:'raw',mode,text:chunk});wire+=chunk;drain();});process.stdin.resume();
hook('session-start',{source:resume?'resume':'startup',...(fork && cfg.forkFirstHookIsParent ? {claudeSessionId:resume,transcriptPath:sourceFile} : {})}).catch(error=>{record({event:'fatal',error:error.message});process.exit(2);});
