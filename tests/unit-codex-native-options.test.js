'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os');
const {buildNativeCodexOptions}=require('../core/session-manager')._private;
test('native launch preserves explicit tuning, policy, cwd, instructions and resume identity',()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'native-options-'));
  const info={kind:'codex',cwd:home,currentModel:{id:'gpt-6-astra'},effort:'xhigh',contextMax:400000,mcpProfile:'none',codexSpeedTier:'standard'};
  const opts={useResume:true,codexSid:'native-id',approvalPolicy:'on-request',sandbox:'read-only',codexInstructionFile:path.join(home,'rules.md')};
  const o=buildNativeCodexOptions(info,opts,{CODEX_HOME:home});
  assert.deepEqual(o.threadParams,{cwd:home,model:'gpt-6-astra',approvalPolicy:'on-request',sandbox:'read-only',config:{model_reasoning_effort:'xhigh','windows.sandbox':'unelevated','notice.hide_full_access_warning':true,model_context_window:400000,model_instructions_file:opts.codexInstructionFile}});
  assert.deepEqual(o.turnParams,{model:'gpt-6-astra',effort:'xhigh'});assert.equal(o.resumeId,'native-id');assert.equal(o.picker,false);
  assert(o.processArgs.includes('service_tier="default"'));assert(o.processArgs.includes('features.fast_mode=false'));
  const inherit=buildNativeCodexOptions({...info,codexSpeedTier:'inherit'}, {},{CODEX_HOME:home});
  assert(!inherit.processArgs.some(x=>/service_tier|fast_mode/.test(x)));
  const fast=buildNativeCodexOptions({...info,codexSpeedTier:'fast'}, {},{CODEX_HOME:home});assert(fast.processArgs.includes('service_tier="fast"'));
});
test('MCP none disables only real configured transports; scoped custom entries remain exact',()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'native-mcp-'));
  fs.writeFileSync(path.join(home,'config.toml'),'[mcp_servers.example]\ncommand="node"\n[mcp_servers.playwright]\ncommand="node"\n');
  const info={kind:'codex',cwd:home,currentModel:{id:'gpt-6-astra'},effort:'xhigh',mcpProfile:'none',codexSpeedTier:'inherit'};
  const none=buildNativeCodexOptions(info,{}, {CODEX_HOME:home});
  assert.deepEqual(none.processArgs.filter(x=>x!=='-c').sort(),['mcp_servers.example.enabled=false','mcp_servers.playwright.enabled=false']);
  const entry={name:'room',command:'node',args:['room.js','中文 空格'],env:{ROOM_ID:'exact-id'}};
  const scoped=buildNativeCodexOptions({...info,mcpProfile:'browser'},{codexMcpEntries:[entry]}, {CODEX_HOME:home});
  assert(scoped.processArgs.includes('mcp_servers.playwright.enabled=true'));
  assert(scoped.processArgs.includes('mcp_servers.example.enabled=false'));
  assert(scoped.processArgs.includes('mcp_servers.room.args='+JSON.stringify(entry.args)));
  assert(scoped.processArgs.includes('mcp_servers.room.env.ROOM_ID="exact-id"'));
});

test('SessionManager preserves account scopes including group members and API settings; rejects implicit account fallback',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-profiles-')),data=path.join(root,'data'),aHome=path.join(root,'account-a'),bHome=path.join(root,'account-b');
  for(const dir of [data,aHome,bHome])fs.mkdirSync(dir);
  const webRoot=path.join(root,'chatgpt'),webHome=path.join(webRoot,'codex-home');
  fs.mkdirSync(path.join(webRoot,'runtime'),{recursive:true});fs.mkdirSync(webHome);
  fs.writeFileSync(path.join(webRoot,'isolation.json'),JSON.stringify({version:1,purpose:'ai-hub-chatgpt-only',port:17861}));
  fs.writeFileSync(path.join(webRoot,'runtime','config.json'),JSON.stringify({host:'127.0.0.1',port:17861,mode:'full',proAvailable:true}));
  const env={AI_HUB_CHATGPT_ROOT:webRoot,CLAUDE_HUB_DATA_DIR:data,CODEX_HOME:aHome,CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.join(__dirname,'fixtures/codex-app-server.js'),HUB_CODEX_BACKEND:'subscription',HUB_CODEX_API_KEY:'',HUB_CODEX_API_BASE_URL:'http://127.0.0.1:9/v1',HUB_CODEX_PROFILE:'default'};
  const before=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);
  const config={providers:{codex:{backend:'subscription',subscription_profiles:[{id:'default',label:'A',home:aHome},{id:'second',label:'B',home:bHome}]}}};
  fs.writeFileSync(path.join(data,'config.json'),JSON.stringify(config));
  const {SessionManager,clearSessionManagerConfigCache}=require('../core/session-manager');
  const reset=()=>{require('../core/hub-config').clearConfigCache();clearSessionManagerConfigCache();};
  const manager=new SessionManager(),drivers=[];
  try{
    reset();const opts={cwd:root,model:'gpt-6-astra',effort:'xhigh',mcpProfile:'none',codexSpeedTier:'standard'};
    const launch=async(extra)=>{const s=manager.createSession('codex',{...opts,...extra}),d=manager.getNativeCodex(s.id);drivers.push(d);await d.start();return d;};
    const a=await launch({codexProfile:'default'}),a2=await launch({codexProfile:'default'}),b=await launch({codexProfile:'second',meetingId:'test-group'});
    assert.equal(a.options.env.CODEX_HOME,aHome);assert.equal(b.options.env.CODEX_HOME,bHome);assert.equal(a.pid,a2.pid);assert.notEqual(a.pid,b.pid);
    const originalConfig=fs.readFileSync(path.join(aHome,'config.toml'),'utf8');
    const web=await launch({model:'chatgpt-web/high',effort:'high'});
    assert.equal(web.options.env.CODEX_HOME,webHome);assert.notEqual(web.pid,a.pid);
    assert(web.options.processArgs.includes('openai_base_url="http://127.0.0.1:17861/v1"'));
    assert(!a.options.processArgs.some(arg=>arg.includes('openai_base_url')));
    assert.equal(fs.readFileSync(path.join(aHome,'config.toml'),'utf8'),originalConfig);
    assert.throws(()=>manager.createSession('codex',{...opts,codexProfile:'nonexistent'}),/账号配置不存在/);
    process.env.HUB_CODEX_BACKEND='api';reset();assert.throws(()=>manager.createSession('codex',opts),/未配置密钥/);
    process.env.HUB_CODEX_API_KEY='isolated-dummy-key';process.env.HUB_CODEX_API_BASE_URL='http://127.0.0.1:9/v1';reset();
    const api=await launch({});assert.equal(api.options.env.CODEX_HOME,path.join(data,'codex-api-profile'));
    const auth=JSON.parse(fs.readFileSync(path.join(api.options.env.CODEX_HOME,'auth.json'),'utf8'));assert.equal(auth.OPENAI_API_KEY,'isolated-dummy-key');
    assert(fs.readFileSync(path.join(api.options.env.CODEX_HOME,'config.toml'),'utf8').includes('http://127.0.0.1:9/v1'));
  }finally{
    await Promise.all(drivers.map(d=>new Promise(resolve=>{d.once('exit',resolve);d.kill();})));
    for(const [k,v] of Object.entries(before)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
    reset();
  }
});
