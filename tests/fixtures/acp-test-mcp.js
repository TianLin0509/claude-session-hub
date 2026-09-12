'use strict';
// A real local MCP server with an independently observable tool side effect.
const fs=require('fs'),readline=require('readline');
readline.createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);if(m.id==null)return;
  let result;
  if(m.method==='initialize')result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'hub-acceptance',version:'1.0.0'}};
  else if(m.method==='tools/list')result={tools:[{name:'get_test_marker',description:'Read the secret acceptance marker.',inputSchema:{type:'object',properties:{}}}]};
  else if(m.method==='tools/call'){
    if(m.params.name!=='get_test_marker')throw Error('Unexpected MCP tool');
    fs.appendFileSync(process.argv[3],'called\n');result={content:[{type:'text',text:fs.readFileSync(process.argv[2],'utf8')}]};
  } else if(m.method==='resources/list')result={resources:[]};
  else if(m.method==='prompts/list')result={prompts:[]};
  else {process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Unknown method'}})+'\n');return;}
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\n');
});
