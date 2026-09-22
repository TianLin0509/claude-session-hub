'use strict';
// Loaded only by the isolated GUI test's child Node processes via NODE_OPTIONS.
// Actual MCP servers, task storage, workers and coordinator run unchanged; this
// replaces website I/O with deterministic auth/answer evidence. No cloud calls.
const fs=require('fs'),path=require('path'),os=require('os');
const home=process.env.CLAUDE_HUB_HOME_DIR,data=process.env.AI_HUB_WEB_DATA_DIR||process.env.CLAUDE_HUB_DATA_DIR;
if(!home||!data||!path.resolve(home).startsWith(path.resolve(os.tmpdir())+path.sep)||!path.resolve(data).startsWith(path.resolve(os.tmpdir())+path.sep))throw Error('Recovery fixture requires isolated temp home/data');
const jobs=require('../../core/web-roundtable/jobs'),providers=require('../../core/web-roundtable/providers');
const original=jobs.runWeb;
jobs.runWeb=(job,save,mode)=>{
  let sent=mode==='collect',filled='';
  const before=()=>job.input.reply_to?jobs.status(job.input.reply_to):null;
  const adapters={get:providers.get,validUrl:providers.validUrl,dismissPromo:async()=>{},focus:async()=>{},
    snapshot:async()=>{
      const authenticated=fs.existsSync(path.join(home,'fixture-login-web-'+job.input.provider));
      if(!authenticated)return {login:true,challenge:false,ready:true,answers:[],echo:0};
      const parent=before(),baseline=job.baseline||{count:parent?1:0,echo:0};
      const answer={text:'Fixture answer for '+job.id,done:true,key:job.id};
      const answers=sent?[...Array.from({length:baseline.count},()=>({text:parent?.answer||'prior',done:true,key:'prior'})),answer]:parent?[{text:parent.answer,done:true,key:parent.id}]:[];
      return {ready:true,login:false,challenge:false,url:job.url||parent?.url||providers.get(job.input.provider).url,answers,echo:sent?baseline.echo+1:0,composerText:filled};
    },send:async()=>{sent=true;fs.appendFileSync(path.join(home,'web-sends.jsonl'),JSON.stringify({id:job.id,provider:job.input.provider})+'\n');}
  };
  return original(job,save,mode,{adapters,open:async()=>({headless:true,owned:true,page:{call:async(name,args)=>{if(name==='Input.insertText')filled=args.text;}},close:async()=>{if(mode==='collect')fs.appendFileSync(path.join(home,'web-collects.jsonl'),JSON.stringify({id:job.id})+'\n');}})});
};
