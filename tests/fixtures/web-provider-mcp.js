'use strict';
// Protocol fixture, never loaded by a production entrypoint.
const fs=require('fs'),path=require('path');
const {serve}=require('../../core/web-roundtable/rpc');
const provider=process.argv[2],root=process.env.HUB_WEB_FIXTURE_ROOT;
if(!root)throw Error('isolated fixture root required');
const schema={type:'object',properties:{},additionalProperties:true};
serve('fixture-'+provider,['web_ask','web_get','web_cancel'].map(name=>({name,inputSchema:schema})),async(name,args)=>{
  const file=id=>path.join(root,id+'.json');
  if(name==='web_ask'){
    const id=args.request_id;
    if(fs.existsSync(file(id)))return JSON.parse(fs.readFileSync(file(id),'utf8'));
    fs.appendFileSync(path.join(root,'sends.jsonl'),JSON.stringify({provider,...args})+'\n','utf8');
    const j={id,state:provider===process.env.HUB_WEB_FIXTURE_FAIL?'needs_attention':'succeeded',answer:'观点 '+provider+' '+id,input:{prompt:args.prompt},url:provider==='deepseek'?'https://chat.deepseek.com/a/chat/s/fixture':'https://www.kimi.com/chat/fixture',error:provider===process.env.HUB_WEB_FIXTURE_FAIL?'Login required':null};
    fs.writeFileSync(file(id),JSON.stringify(j));return j;
  }
  if(name==='web_get')return JSON.parse(fs.readFileSync(file(args.task_id),'utf8'));
  return {cancelRequested:true};
});
