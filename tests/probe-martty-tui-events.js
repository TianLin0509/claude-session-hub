'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const kind=process.argv[2]||'glm';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-martty-probe-'));
const data=path.join(root,'data'),cwd=path.join(root,'workspace');fs.mkdirSync(cwd);
process.env.CLAUDE_HUB_DATA_DIR=data;process.env.CLAUDE_HUB_HOME_DIR=path.join(root,'home');
const config=JSON.parse(fs.readFileSync(path.join(os.homedir(),'.claude-session-hub/config.json'),'utf8'));
const options=require('../core/acp-profiles').buildAcpOptions(kind,{id:'probe',cwd},config,data);
const out=path.resolve('artifacts/martty-tui-probe/'+Date.now());fs.mkdirSync(out,{recursive:true});
const events=path.join(out,'events.jsonl');fs.writeFileSync(events,'');
const martty=require.resolve('martty/package.json',{paths:[path.dirname(config.acp.providers.glm.entryPath)]});
const env={...options.launch.env,MARTTY_HOME:path.join(options.home,'.martty'),
  AI_HUB_CLI_AGENT_LAUNCH:JSON.stringify({command:options.launch.command,args:options.launch.args,cwd}),AI_HUB_CLI_EVENT_LOG:events};
const args=[path.join(path.dirname(martty),'bin/martty.js'),'--agent',options.launch.command,
  '--agent-arg',path.resolve('scripts/provider-cli-tap.js'),'--workspace',cwd,'--model',options.model];
if(kind==='deepseek-acp')args.push('--provider','bailian-tpp');
let raw='',proc,sent=false,done=false;
console.log(JSON.stringify({kind,root,out}));
function finish(error){if(done)return;done=true;clearInterval(poll);clearTimeout(timer);fs.writeFileSync(path.join(out,'terminal.txt'),raw);proc?.kill();console.log(error||'completed');process.exitCode=error?1:0;}
const manager={writeToSession:(_,s)=>proc.write(s),getSessionBuffer:()=>raw};
const poll=setInterval(async()=>{try{const rows=fs.readFileSync(events,'utf8').split('\n').filter(Boolean).map(JSON.parse);
  if(!sent&&rows.some(r=>r.direction==='agent'&&r.message.result?.sessionId)){sent=true;const paste=require('../core/pty-prompt-submit');const prompt='Reply only MARTTY_TUI_PROBE_OK';await paste.writeBracketedPaste(manager,'probe',prompt);await paste.waitForPasteSettled(manager,'probe',{settleMs:paste.computeSettleMs(prompt.length)});proc.write('\r');}
  if(rows.some(r=>r.message.result?.stopReason))finish();}catch(error){finish(error.message);}},500);
const timer=setTimeout(()=>finish('timeout'),90000);
proc=require('node-pty').spawn(options.launch.command,args,{cwd,env,cols:120,rows:35,useConpty:true,conptyInheritCursor:false});
proc.onData(s=>{raw+=s;fs.writeFileSync(path.join(out,'terminal.txt'),raw);});proc.onExit(e=>{if(!done){proc=null;finish('exit '+e.exitCode);}});
