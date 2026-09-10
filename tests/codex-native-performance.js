'use strict';
// Real TUI baseline versus real App Server candidate, same model/effort/tier,
// same workload and isolated homes. Run alone to avoid competing GUI tests.
const fs=require('fs'),path=require('path'),os=require('os'),net=require('net'),assert=require('assert/strict'),cp=require('child_process'),{promisify}=require('util');
const execFile=promisify(cp.execFile),{launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher'),{connectFirstPage}=require('./helpers/cdp-client');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const port=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
function productDigest(repo){
  const hash=require('crypto').createHash('sha256'),files=['main.js','package.json'];
  function walk(dir){for(const entry of fs.readdirSync(path.join(repo,dir),{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())walk(file);else files.push(file);}}
  for(const dir of ['core','main','renderer'])walk(dir);
  for(const file of files.sort()){hash.update(file.replace(/\\/g,'/'));hash.update(fs.readFileSync(path.join(repo,file)));}
  return hash.digest('hex');
}
async function initializeDatabase(home,cwd,model,effort){
  // Codex 0.153.4 can race its first SQLite schema migration when several
  // TUIs open a brand-new home simultaneously. Give BOTH versions one equal,
  // model-free initialization before the measured multi-session startup.
  const {CodexAppServerClient}=require('../main/codex-app-server-client');
  const {scrubParentControlEnv}=require('./helpers/hub-launcher');
  const client=new CodexAppServerClient({cwd,env:{...scrubParentControlEnv(process.env),CODEX_HOME:home,HUB_PERF_FIXTURE_KEY:'isolated-fixture-only'}});
  try {await client.start();const opened=await client.request('thread/start',{cwd,model,approvalPolicy:'never',sandbox:'danger-full-access',config:{model_reasoning_effort:effort,'windows.sandbox':'unelevated'}});await client.request('thread/unsubscribe',{threadId:opened.thread.id});}
  finally {client.close();await client.waitForExit();}
}
async function processes(rootPid){
  const code=`$all=@(Get-CimInstance Win32_Process);$byPid=@{};foreach($p in $all){$byPid[[int]$p.ProcessId]=$p};$ids=[Collections.Generic.HashSet[int]]::new();[void]$ids.Add(${rootPid});do{$changed=$false;foreach($p in $all){if($ids.Contains([int]$p.ParentProcessId) -and $p.CreationDate -ge $byPid[[int]$p.ParentProcessId].CreationDate -and $ids.Add([int]$p.ProcessId)){$changed=$true}}}while($changed);$rows=@($all | Where-Object {$ids.Contains([int]$_.ProcessId)} | ForEach-Object {[pscustomobject]@{id=[int]$_.ProcessId;parent=[int]$_.ParentProcessId;cpu=[double]$_.KernelModeTime+[double]$_.UserModeTime;private=[double]$_.PrivatePageCount;name=$_.Name;createdAt=$_.CreationDate.ToUniversalTime().ToString("o")}});ConvertTo-Json -InputObject $rows -Compress`;
  const r=await execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',code],{windowsHide:true,timeout:15000,maxBuffer:1024*1024});return {at:Date.now(),rows:JSON.parse(r.stdout)};
}
function summarize(samples){
  const a=samples[0],b=samples.at(-1),old=new Map(a.rows.map(p=>[p.id,p.cpu])),last=new Map();
  for(const sample of samples)for(const p of sample.rows)last.set(p.id,p.cpu);
  return {cpuPct:[...last].reduce((n,[id,cpu])=>n+Math.max(0,cpu-(old.get(id)||0)),0)/10000/(b.at-a.at)/os.cpus().length*100,
    privateMiB:Math.max(...samples.map(s=>s.rows.reduce((n,p)=>n+p.private,0)/1024/1024)),processes:Math.max(...samples.map(s=>s.rows.length))};
}
async function run({label,repo,count,repeat,source,model,effort,tier,out}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-native-perf-')),home=path.join(root,'codex'),cwd=path.join(root,'workspace');fs.mkdirSync(home);fs.mkdirSync(cwd);
  if(process.env.HUB_PERF_REAL_MODEL==='1')fs.copyFileSync(path.join(source,'auth.json'),path.join(home,'auth.json'));if(fs.existsSync(path.join(source,'models_cache.json')))fs.copyFileSync(path.join(source,'models_cache.json'),path.join(home,'models_cache.json'));
  const fixture=process.env.HUB_PERF_REAL_MODEL==='1'?null:await require('./fixtures/codex-responses-server').startResponsesFixture();
  const fixtureConfig=fixture?'model_provider="hub_perf_fixture"\n[model_providers.hub_perf_fixture]\nname="Hub performance fixture"\nbase_url="http://127.0.0.1:'+fixture.port+'/v1"\nwire_api="responses"\nenv_key="HUB_PERF_FIXTURE_KEY"\nsupports_websockets=false\nrequires_openai_auth=false\n':'';
  fs.writeFileSync(path.join(home,'config.toml'),'model='+JSON.stringify(model)+'\nmodel_reasoning_effort='+JSON.stringify(effort)+'\n'+(tier?'service_tier='+JSON.stringify(tier)+'\n':'')+fixtureConfig+'[windows]\nsandbox="unelevated"\n[notice]\nhide_full_access_warning=true\n');
  const r={label,count,repeat,root,model,effort,tier,productDigest:productDigest(repo),passed:false},folder=path.join(out,label+'-'+count+'-'+repeat);fs.mkdirSync(folder);let hub,cdp;
  const until=async(expr,name,ms=60000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await cdp.eval(expr))return;await sleep(250);}throw Error('timeout '+name);};
  const measure=async(name,duration,start)=>{
    await cdp.eval('ipcRenderer.invoke("native-perf:reset")');const samples=[await processes(hub.pid)],end=Date.now()+duration;
    if(start)await start();
    do {await sleep(2000);samples.push(await processes(hub.pid));}while(Date.now()<end);
    const main=await cdp.eval('ipcRenderer.invoke("native-perf:read")');
    return {name,...summarize(samples),loopP95:main.loopP95,loopMax:main.loopMax,counters:main.counters,raw:samples,main};
  };
  try{
    await initializeDatabase(home,cwd,model,effort);r.databasePreinitialized=true;
    hub=await launchIsolatedHub({entryPath:path.join(__dirname,'helpers/codex-native-perf-entry.js'),dataDir:path.join(root,'data'),port:await port(),label:'perf-'+label,extraEnv:{CODEX_HOME:home,CLAUDE_CONFIG_DIR:path.join(root,'claude'),CLAUDE_HUB_NATIVE_PERF_ROOT:repo,HUB_PERF_FIXTURE_KEY:'isolated-fixture-only'}});r.pid=hub.pid;cdp=await connectFirstPage(hub);await until('typeof sessions!=="undefined"','renderer');
    r.ids=[];
    for(let i=0;i<count;i++){
      const s=await cdp.eval('ipcRenderer.invoke("create-session",'+JSON.stringify({kind:'codex',opts:{cwd,model,effort,title:'性能验收 '+i,userRenamed:true,autoTitleGenerated:true,mcpProfile:'none',codexSpeedTier:'inherit',approvalPolicy:'never',sandbox:'danger-full-access'}})+')');r.ids.push(s.id);
    }
    const ids=JSON.stringify(r.ids);
    if(label==='candidate')await until(ids+'.every(id=>sessions.get(id)?.nativeRuntime?.state==="idle")','native ready');
    else {await sleep(7000);r.initial=await cdp.eval('ipcRenderer.invoke("native-perf:read")');assert(r.initial.sessions.every(s=>s.screen && /context left|上下文剩余|gpt-6-astra|Codex/.test(s.screen)),'all TUI processes must launch');}
    // Equal startup allowance includes the Hub account/usage helper in both runs.
    await sleep(process.env.HUB_PERF_PROBE==='1'?0:30000);
    await until('document.querySelector(\'.session-item[data-session-id="'+r.ids[0]+'"]\')','sidebar');await cdp.eval('document.querySelector(\'.session-item[data-session-id="'+r.ids[0]+'"]\').click()');await sleep(2000);
    r.idle=await measure('idle',process.env.HUB_PERF_PROBE==='1'?2000:12000);console.log(JSON.stringify({label,count,repeat,phase:'idle',cpu:r.idle.cpuPct,memory:r.idle.privateMiB}));
    // Same bounded command, output volume and reasoning configuration for both.
    const prompt=fixture?'这是固定响应服务的性能验收，请输出预定样本。':'这是隔离性能验收。请只调用一次 exec_command，使用 PowerShell 执行：1..20 | ForEach-Object { Write-Output "HUB_PERF_SAMPLE_$_"; Start-Sleep -Milliseconds 500 }。允许轮询这一条命令直到退出。不要使用其他工具，不要写文件。命令完成后只回复 HUB_PERF_DONE。';
    r.startAt=Date.now();
    r.execution=await measure('execution',20000,()=>cdp.eval('window.perfSend=Promise.all('+ids+'.map((id,i)=>ipcRenderer.invoke("session:send-prompt",{sessionId:id,text:'+JSON.stringify(prompt)+',clientSubmissionId:"perf-'+repeat+'-"+i}))).then(x=>window.perfSendResults=x);true'));
    await until('!!window.perfSendResults','receipts',90000);r.receipts=await cdp.eval('perfSendResults');assert(r.receipts.every(x=>x.ok && x.sendStatus==='ok'),JSON.stringify(r.receipts));
    await until('(async()=>{const x=await ipcRenderer.invoke("native-perf:read");return x.sessions.every(s=>s.completedAt>'+r.startAt+');})()','every native completion',120000);
    r.final=await cdp.eval('ipcRenderer.invoke("native-perf:read")');
    assert.equal(productDigest(repo),r.productDigest,'product code changed during measurement');
    if(fixture){const primary=fixture.requests.filter(x=>x.purpose==='workload');assert.equal(primary.length,count);assert(primary.every(x=>x.completed&&x.chunks===200&&x.model===model&&x.effort===effort));}
    r.passed=true;
  }finally{
    if(cdp){try{r.finalUI=await cdp.eval('document.body.innerText.slice(-3500)');if(!r.passed)r.failureState=await cdp.eval('ipcRenderer.invoke("native-perf:read")');const shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(folder,'final.png'),Buffer.from(shot.data,'base64'));}catch(e){r.captureError=e.message;}await cdp.close();}
    if(hub){fs.writeFileSync(path.join(folder,'hub.log'),hub.log().join('\n'));r.exit=await gracefulQuit(hub);}
    if(fixture){r.responseFixture=fixture.requests;await fixture.close();}
    fs.rmSync(path.join(home,'auth.json'),{force:true});fs.writeFileSync(path.join(folder,'result.json'),JSON.stringify(r,null,2));console.log(JSON.stringify({label,count,repeat,passed:r.passed,exit:r.exit}));
  }
  return r;
}
async function main(){
  const source=process.env.CODEX_HOME || path.join(os.homedir(),'.codex'),config=fs.readFileSync(path.join(source,'config.toml'),'utf8'),read=k=>config.match(new RegExp('^'+k+'\\s*=\\s*"([^"]+)"','m'))?.[1];
  const model=read('model'),effort=read('model_reasoning_effort'),tier=read('service_tier');assert(model&&effort);
  const out=path.resolve('artifacts/codex-native-runtime/performance-'+Date.now());fs.mkdirSync(out,{recursive:true});const rows=[];
  const counts=process.env.HUB_PERF_COUNTS?process.env.HUB_PERF_COUNTS.split(',').map(Number):[1,4,8],repeats=Number(process.env.HUB_PERF_REPEATS)||3;
  const candidateDigest=productDigest(path.resolve('.'));
  for(const count of counts)for(let repeat=1;repeat<=repeats;repeat++)for(const label of repeat%2?['baseline','candidate']:['candidate','baseline']){
    const repo=label==='baseline'?path.resolve('artifacts/codex-native-runtime/baseline-8c5c6928'):path.resolve('.');
    if(label==='candidate')assert.equal(productDigest(repo),candidateDigest,'freeze product code for the full performance run');
    rows.push(await run({label,repo,count,repeat,source,model,effort,tier,out}));fs.writeFileSync(path.join(out,'rows.json'),JSON.stringify(rows,null,2));
  }
  const mean=xs=>xs.reduce((a,b)=>a+b,0)/xs.length;const comparisons=[];
  for(const count of counts)for(const phase of ['idle','execution']){
    const b=rows.filter(r=>r.label==='baseline'&&r.count===count).map(r=>r[phase]),c=rows.filter(r=>r.label==='candidate'&&r.count===count).map(r=>r[phase]);
    const x={count,phase,baseline:{},candidate:{}};for(const key of ['cpuPct','privateMiB','processes','loopP95']){x.baseline[key]=mean(b.map(v=>v[key]));x.candidate[key]=mean(c.map(v=>v[key]));}
    x.pass=x.candidate.cpuPct<=x.baseline.cpuPct+2 && x.candidate.privateMiB<=x.baseline.privateMiB+Math.max(100,x.baseline.privateMiB*.1) && x.candidate.loopP95<=x.baseline.loopP95+10;comparisons.push(x);
  }
  fs.writeFileSync(path.join(out,'comparison.json'),JSON.stringify({model,effort,tier,counts,repeats,comparisons},null,2));console.log(JSON.stringify({out,comparisons}));assert(comparisons.every(x=>x.pass),'performance regression threshold failed');
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
