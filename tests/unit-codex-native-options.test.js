'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os');
const {buildNativeCodexOptions}=require('../core/session-manager')._private;
test('native launch preserves explicit tuning, policy, cwd, instructions and resume identity',()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'native-options-'));
  const info={kind:'codex',cwd:home,currentModel:{id:'gpt-6-astra'},effort:'xhigh',contextMax:400000,mcpProfile:'none',codexSpeedTier:'standard'};
  const opts={useResume:true,codexSid:'native-id',approvalPolicy:'on-request',sandbox:'read-only',codexInstructionFile:path.join(home,'rules.md')};
  const o=buildNativeCodexOptions(info,opts,{CODEX_HOME:home});
  assert.deepEqual(o.threadParams,{cwd:home,model:'gpt-6-astra',approvalPolicy:'on-request',sandbox:'read-only',config:{model_reasoning_effort:'xhigh','windows.sandbox':'unelevated','notice.hide_full_access_warning':true,model_context_window:400000,model_instructions_file:opts.codexInstructionFile}});
  assert.deepEqual(o.turnParams,{model:'gpt-6-astra',effort:'xhigh',serviceTier:'default'});assert.equal(o.resumeId,'native-id');assert.equal(o.picker,false);
  const lazy=buildNativeCodexOptions({...info,kind:'codex-resume'},{lazyStart:true,useResume:true,codexResumePicker:true},{CODEX_HOME:home});
  assert.equal(lazy.picker,false);assert.equal(lazy.resumeLatest,false);
  assert(o.processArgs.includes('service_tier="default"'));assert(o.processArgs.includes('features.fast_mode=true'));
  const inherit=buildNativeCodexOptions({...info,codexSpeedTier:'inherit'}, {},{CODEX_HOME:home});
  assert(!inherit.processArgs.some(x=>/service_tier|fast_mode/.test(x)));
  assert.equal(Object.hasOwn(inherit.turnParams,'serviceTier'),false);
  const fast=buildNativeCodexOptions({...info,codexSpeedTier:'fast'}, {},{CODEX_HOME:home});assert(fast.processArgs.includes('service_tier="fast"'));
  assert.equal(fast.turnParams.serviceTier,'fast');
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
  const env={CLAUDE_HUB_DATA_DIR:data,CODEX_HOME:aHome,CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.join(__dirname,'fixtures/codex-app-server.js'),HUB_CODEX_BACKEND:'subscription',HUB_CODEX_API_KEY:'',HUB_CODEX_API_BASE_URL:'http://127.0.0.1:9/v1',HUB_CODEX_PROFILE:'default'};
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
