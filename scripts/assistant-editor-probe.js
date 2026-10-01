'use strict';
// Isolated native TUI diagnostic. Loads a draft through Ctrl+G but never submits
// it to a model. Only the process started here is closed.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const pty=require('node-pty');
const {configureCodexEditorInput}=require('../core/codex-editor-input');
const privateParent=path.resolve(__dirname,'../artifacts/assistant-editor-probe');fs.mkdirSync(privateParent,{recursive:true});
const root=fs.mkdtempSync(path.join(privateParent,'private-work-'));
const variant=process.argv[2]||'raw';if(!['raw','csiu','win32','modify-other','seeded','warning'].includes(variant))throw new Error('invalid variant');
const output=path.resolve(__dirname,'../artifacts/assistant-editor-probe',variant);fs.mkdirSync(output,{recursive:true});
const authHome=path.join(root,'codex');fs.mkdirSync(authHome);
fs.writeFileSync(path.join(authHome,'config.toml'),`model = "gpt-6-astra"\n[projects.'${root.toLowerCase()}']\ntrust_level = "trusted"\n[notice]\nhide_full_access_warning = true\n`);
const config=JSON.parse(fs.readFileSync(path.join(os.homedir(),'.claude-session-hub/config.json'),'utf8'));
const account=config.providers.codex.subscription_profiles.find(p=>p.label==='主账号');
fs.copyFileSync(path.join(account.home,'auth.json'),path.join(authHome,'auth.json'));
const env={...process.env,CODEX_HOME:authHome,TERM:'xterm-256color'};
for(const key of Object.keys(env))if(key.startsWith('CLAUDE_')||key.startsWith('HUB_')||['OPENAI_API_KEY','CODEX_API_KEY','CLAUDECODE','VISUAL','EDITOR'].includes(key))delete env[key];
const bridge=configureCodexEditorInput(env,{dataDir:root,cwd:root});
const child=pty.spawn('C:/DevTools/Codex/0.159.3/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe',
  ['--dangerously-bypass-approvals-and-sandbox','--no-alt-screen','-c','check_for_update_on_startup=false'],{cwd:root,env,cols:120,rows:36,name:'xterm-256color',useConpty:true});
let raw='',done=false;const samples=[];
const result={root,pid:child.pid,version:'0.159.3',sentEnter:false,variant};
child.onData(data=>{raw+=data;bridge.onOutput(data);fs.writeFileSync(path.join(output,'live-raw.txt'),raw);if(data.includes('\x1b[6n'))child.write('\x1b[1;1R');});
child.onExit(event=>{done=true;result.exit=event;});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
 try{
   for(let i=0;i<120&&!done&&!/Ask Codex to do anything/.test(raw);i++)await sleep(500);
   await sleep(1000);
   result.ready=/Ask Codex to do anything/.test(raw)&&!/Trust this folder\?/.test(raw);
   if(!result.ready)throw new Error('TUI readiness not observed');
   if(variant==='seeded'){child.write('诊断草稿');await sleep(500);}
   if(variant==='warning'){child.write('\x1bOQ');await sleep(500);fs.writeFileSync(path.join(output,'warnings-raw.txt'),raw);child.write('\x1b');await sleep(500);}
   await sleep(1000);
   const monitor=setInterval(()=>{const p=bridge.pending;samples.push({at:Date.now(),pending:p?{suspended:p.suspended,resumed:p.resumed,frame:p.frame}:null,files:fs.readdirSync(bridge.directory)});},100);
   const keys={raw:'\x07',seeded:'\x07',warning:'\x07',csiu:'\x1b[103;5u',win32:'\x1b[71;34;7;1;8;1_', 'modify-other':'\x1b[27;5;103~'};
   try{result.loaded=await bridge.load('仅作为未提交输入测试。'.repeat(250),()=>child.write(keys[variant]));}catch(error){result.error=error.message;}
   clearInterval(monitor);result.transfer=bridge.lastTransfer;result.finalFiles=fs.readdirSync(bridge.directory);
 }catch(error){result.error=error.message;}
 finally{
   fs.writeFileSync(path.join(output,'terminal-raw.txt'),raw);fs.writeFileSync(path.join(output,'samples.json'),JSON.stringify(samples,null,2));fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));
   child.kill();bridge.dispose();fs.rmSync(path.join(authHome,'auth.json'),{force:true});console.log(JSON.stringify(result));
 }
})();
