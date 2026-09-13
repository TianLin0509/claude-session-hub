'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');
const {prepareToolRoute,normalizedLaunch}=require('../core/shared-runtime-tool-route');
const {writeControlFile}=require('../core/hub-control');
const script=path.resolve(__dirname,'../core/research-mcp-server.js');
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-tool-route-'));return {root,config:port=>({mcpServers:{research:{command:process.execPath,args:[script],env:{ARENA_MEETING_ID:'room',ARENA_HUB_PORT:String(port),ARENA_HOOK_TOKEN:'token-'+port,ARENA_AI_KIND:'claude'}}}})};}
test('Claude and Codex callback routing changes neither tool scope nor original config',()=>{
  const {root,config}=fixture(),a=path.join(root,'a.json'),b=path.join(root,'b.json');
  fs.writeFileSync(a,JSON.stringify(config(10)));fs.writeFileSync(b,JSON.stringify(config(20)));
  const options={nativeProvider:'claude',hubDataDir:root,launchArgs:['--model','model','--mcp-config',a,'--strict-mcp-config']};
  const before=normalizedLaunch(options),route=prepareToolRoute(options);
  assert.deepEqual(normalizedLaunch(options),before);
  assert.deepEqual(normalizedLaunch({...options,launchArgs:['--model','model','--mcp-config',b,'--strict-mcp-config']}),before);
  assert.equal(JSON.parse(fs.readFileSync(a)).mcpServers.research.env.ARENA_HUB_PORT,'10');
  const changed=config(20);changed.mcpServers.research.env.ARENA_MEETING_ID='other';fs.writeFileSync(b,JSON.stringify(changed));
  assert.notDeepEqual(normalizedLaunch({...options,launchArgs:['--model','model','--mcp-config',b,'--strict-mcp-config']}),before);
  const codex={hubDataDir:root,processArgs:['-c','mcp_servers.arena_research.args='+JSON.stringify([script]),'-c','mcp_servers.arena_research.env.ARENA_HUB_PORT="10"']};
  const codexBefore=normalizedLaunch(codex),codexRoute=prepareToolRoute(codex);
  assert.deepEqual(normalizedLaunch(codex),codexBefore);assert(codex.processArgs.some(arg=>arg.includes('ARENA_HUB_ROUTE_FILE=')));
  route.dispose();codexRoute.dispose();
});
test('one real MCP process follows control transfer after the first Hub server closes',async()=>{
  const {root,config}=fixture(),file=path.join(root,'mcp.json');fs.writeFileSync(file,JSON.stringify(config(10)));
  const options={nativeProvider:'claude',hubDataDir:root,launchArgs:['--mcp-config',file]},route=prepareToolRoute(options);
  const received=[],servers=[];let child;
  try {
    for(const pid of [101,202]) {
      const server=require('node:http').createServer((req,res)=>{let text='';req.on('data',chunk=>text+=chunk);req.on('end',()=>{received.push({pid,body:JSON.parse(text)});res.end(JSON.stringify({source:pid}));});});
      await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));servers.push(server);
      writeControlFile({pid,dataDir:root,hookPort:server.address().port,token:'secret-'+pid});
    }
    route.update({hubPid:101},true);
    child=spawn(process.execPath,[script],{windowsHide:true,env:{...process.env,ARENA_MEETING_ID:'room',ARENA_HUB_ROUTE_FILE:route.file,ARENA_HUB_DATA_DIR:root,SPIRIT_REGISTRY_ROOT:path.join(root,'spirits')}});
    const replies=new Map();let errors='';child.stderr.on('data',chunk=>errors+=chunk);
    require('node:readline').createInterface({input:child.stdout}).on('line',line=>{const response=JSON.parse(line);replies.set(response.id,response);});
    async function call(id){child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name:'stock_static',arguments:{symbol:'000001'}}})+'\n');const end=Date.now()+5000;while(!replies.has(id)&&Date.now()<end)await new Promise(r=>setTimeout(r,10));assert(replies.has(id),errors);return replies.get(id);}
    await call(1);assert.equal(received[0].pid,101);assert.equal(received[0].body.token,'secret-101');
    route.update({hubPid:202},true);await new Promise(resolve=>servers[0].close(resolve));
    await call(2);assert.equal(received[1].pid,202);assert.equal(received[1].body.token,'secret-202');
    route.update({hubPid:202},false);const failed=await call(3);
    assert(JSON.stringify(failed).includes('操作窗口已断开'));assert.equal(received.length,2);
  } finally {
    if(child){child.stdin.end();await new Promise(resolve=>child.once('exit',resolve));}
    for(const server of servers)if(server.listening)await new Promise(resolve=>server.close(resolve));route.dispose();
  }
});
test('relative MCP paths use session cwd and failed constructors leave no copied config',async()=>{
  const {root,config}=fixture();fs.writeFileSync(path.join(root,'relative.json'),JSON.stringify(config(10)));
  const options={id:'id',nativeProvider:'claude',sessionId:'uuid',cwd:root,hubDataDir:root,launchArgs:['--mcp-config','relative.json']};
  assert(normalizedLaunch(options).claudeArgs[1].mcpServers);
  const {CodexRuntimeBroker}=require('../core/codex-runtime-broker');
  const broker=new CodexRuntimeBroker({sessionFactory(){throw Error('constructor failed');}}),peer={views:new Map(),send(){}};
  for(let i=0;i<2;i++)await assert.rejects(broker.handle(peer,'attach',{options,view:{viewId:'v',sessionId:'id'}}),/constructor failed/);
  assert.equal(broker.records.size,0);assert.deepEqual(fs.readdirSync(path.join(root,'native-runtime-control')),[]);
});
test('failed route persistence during disconnect cannot escape the peer close callback',async()=>{
  const {root,config}=fixture(),file=path.join(root,'mcp.json');fs.writeFileSync(file,JSON.stringify(config(10)));
  const {EventEmitter}=require('node:events'),{CodexRuntimeBroker}=require('../core/codex-runtime-broker');
  const native=new EventEmitter();Object.assign(native,{runtime:{connection:'connected',state:'idle'},start:async()=>{},readTranscript:()=>[],blocks:()=>[],finalText:()=>'',kill(){}});
  const broker=new CodexRuntimeBroker({sessionFactory:()=>native}),peer={views:new Map(),send(){}};
  await broker.handle(peer,'attach',{options:{id:'id',nativeProvider:'claude',sessionId:'uuid',hubDataDir:root,launchArgs:['--mcp-config',file]},view:{viewId:'v',sessionId:'id',hubPid:process.pid}});
  const record=[...broker.records.values()][0],rename=fs.renameSync,log=console.error,diagnostics=[];
  try {
    fs.renameSync=()=>{throw Object.assign(Error('route denied'),{code:'EACCES'});};console.error=(...args)=>diagnostics.push(args.join(' '));
    assert.doesNotThrow(()=>broker.disconnect(peer));
    assert.equal(peer.views.size,0);assert.equal(record.views.size,0);assert(!fs.existsSync(record.toolRoute.file));
    assert(diagnostics.some(line=>line.includes('route denied')));
  } finally {fs.renameSync=rename;console.error=log;clearTimeout(record.cleanupTimer);record.toolRoute.dispose();}
});
