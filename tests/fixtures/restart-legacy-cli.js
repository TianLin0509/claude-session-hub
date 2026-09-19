'use strict';
// Protocol fixture behind a real Windows PTY. No provider/network requests.
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const kind=process.argv[2],args=process.argv.slice(3),flag=kind==='kimi'?'--session':kind==='deepseek'?'resume':'--resume';
const index=args.indexOf(flag),id=index>=0?args[index+1]:randomUUID();
const root=process.env.HUB_RESTART_LEGACY_ROOT;
if(!root || !process.env.CLAUDE_HUB_DATA_DIR)throw Error('fixture requires isolation');
const append=(file,row)=>fs.appendFileSync(file,JSON.stringify(row)+'\n','utf8');
let transcript;
if(kind==='kimi'){
  const sessionDir=path.join(process.env.KIMI_CODE_HOME,'sessions','fixture',id);
  transcript=path.join(sessionDir,'agents','main','wire.jsonl');fs.mkdirSync(path.dirname(transcript),{recursive:true});
  if(!fs.existsSync(transcript))fs.writeFileSync(transcript,'');
  append(path.join(process.env.KIMI_CODE_HOME,'session_index.jsonl'),{sessionId:id,sessionDir,workDir:process.cwd()});
}else if(kind==='deepseek'){
  const dir=path.join(process.env.CODEX_HOME,'sessions',...new Date().toISOString().slice(0,10).split('-'));
  fs.mkdirSync(dir,{recursive:true});transcript=path.join(dir,'rollout-fixture-'+id+'.jsonl');
  if(!fs.existsSync(transcript))append(transcript,{type:'session_meta',timestamp:new Date().toISOString(),payload:{id,cwd:process.cwd(),source:'cli',originator:'codex_cli_rs'}});
}else{
  const project=path.join(process.env.CLAUDE_HUB_HOME_DIR,'.gemini','tmp','fixture');
  fs.mkdirSync(path.join(project,'chats'),{recursive:true});fs.writeFileSync(path.join(project,'.project_root'),process.cwd());
  transcript=path.join(project,'chats','session-'+id+'.jsonl');
  if(!fs.existsSync(transcript))append(transcript,{type:'session_meta',sessionId:id});
}
append(path.join(root,'legacy-trace.jsonl'),{kind,id,event:'start',pid:process.pid,args});
process.stdout.write(('fixture terminal ready '.repeat(35))+'\r\n'+(kind==='kimi'?'context: 0%':kind==='deepseek'?'Context 100% left':'Type your message')+'\r\n');
process.stdin.setEncoding('utf8');process.stdin.setRawMode?.(true);process.stdin.resume();let buffer='';
process.stdin.on('data',chunk=>{
  for(const char of chunk){
    if(char==='\x15'){buffer='';continue;}
    if(char==='\r'){
      const text=buffer.replace(/\x1b\[(200|201)~/g,'');buffer='';if(!text.trim())continue;
      const timestamp=Date.now();
      append(path.join(root,'legacy-trace.jsonl'),{kind,id,event:'prompt',text});
      append(transcript,kind==='kimi'?{type:'turn.prompt',timestamp,input:[{type:'text',text}],origin:{kind:'user'}}
        :kind==='deepseek'?{type:'event_msg',timestamp:new Date(timestamp).toISOString(),payload:{type:'user_message',message:text,turn_id:randomUUID()}}
        :{$set:{messages:[{type:'user',timestamp:new Date(timestamp).toISOString(),id:randomUUID(),content:[{text}]}],lastUpdated:new Date(timestamp).toISOString()}});
      if(kind==='deepseek')append(transcript,{type:'event_msg',timestamp:new Date().toISOString(),payload:{type:'task_started',turn_id:randomUUID()}});
      process.stdout.write('\r\nfixture task active\r\n');
    }else{buffer+=char;process.stdout.write(char);}
  }
});
