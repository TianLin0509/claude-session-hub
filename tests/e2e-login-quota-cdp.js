'use strict';
// Real isolated Hub mouse/keyboard flow. CLI and browser authorization are
// explicit fixtures; no production login, session or clipboard is touched.
const fs=require('fs'),path=require('path'),os=require('os'),net=require('net'),assert=require('assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const out=path.resolve('artifacts/login-quota');fs.mkdirSync(out,{recursive:true});
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-login-quota-'));
const data=path.join(root,'data'),home=path.join(root,'home'),a=path.join(home,'a'),b=path.join(home,'b'),cwd=path.join(root,'work');
for(const p of [data,home,a,b,cwd])fs.mkdirSync(p,{recursive:true});
const configFile=path.join(data,'config.json');
fs.writeFileSync(configFile,JSON.stringify({unrelated:'keep',proxy:'',providers:{codex:{backend:'subscription',subscription_profile:'default',subscription_profiles:[{id:'default',label:'主账号',home:a},{id:'second',label:'副账号 · DB',home:b}]}}}));
const jwt=email=>'x.'+Buffer.from(JSON.stringify({email})).toString('base64url')+'.y';
for(const [dir,email] of [[a,'main@example.com'],[b,'db@example.com']])fs.writeFileSync(path.join(dir,'auth.json'),JSON.stringify({auth_mode:'chatgpt',tokens:{id_token:jwt(email),access_token:'fixture-only',refresh_token:'fixture-only'}}));
const report={passed:false,root,boundary:'真实隔离 Hub 鼠标键盘与启动、恢复、重启接口；CLI 推理和登录采用显式夹具',checks:[]};
let hub,cdp;
const port=()=>new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
const until=async(expr,label)=>{for(const end=Date.now()+40000;Date.now()<end;){if(await cdp.eval(expr))return;await new Promise(r=>setTimeout(r,100));}throw Error('timeout '+label);};
const invoke=(name,arg)=>cdp.eval(`ipcRenderer.invoke(${JSON.stringify(name)},${JSON.stringify(arg)})`);
async function click(selector){
 await until(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)return false;const r=e.getBoundingClientRect();return r.width>0&&r.height>0;})()`,selector);
 await cdp.eval(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({behavior:'instant',block:'nearest'})`);
 await cdp.eval('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
 const box=await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,topmost:e.contains(document.elementFromPoint(x,y))};})()`);
 assert(box.topmost,'click target covered: '+selector);delete box.topmost;
 await Promise.all(['mousePressed','mouseReleased'].map(type=>cdp.send('Input.dispatchMouseEvent',{type,...box,button:'left',clickCount:1})));
}
async function create(text){const s=await invoke('create-session',{kind:'codex',opts:{cwd,model:'gpt-6-astra',effort:'max',mcpProfile:'none'}});await until(`sessions.get(${JSON.stringify(s.id)})?.nativeRuntime?.connection==='connected'`,'connect');if(text){assert((await invoke('session:send-prompt',{sessionId:s.id,text,clientSubmissionId:s.id+'-once'})).ok);await until(`sessions.get(${JSON.stringify(s.id)})?.nativeRuntime?.state===${JSON.stringify(text==='fixture:hold'?'running':'completed')}`,'turn');}return await cdp.eval(`JSON.parse(JSON.stringify(sessions.get(${JSON.stringify(s.id)})))`);}
(async()=>{try {
 hub=await launchIsolatedHub({dataDir:data,port:await port(),label:'login-quota',windowMode:'background',extraEnv:{
  CLAUDE_HUB_AGENT_RUNTIME:'native',CLAUDE_HUB_HOME_DIR:home,CLAUDE_CONFIG_DIR:path.join(home,'.claude'),CODEX_HOME:a,CODEX_SQLITE_HOME:'',HUB_CODEX_PROFILE:'',HUB_CODEX_BACKEND:'subscription',DEEPSEEK_API_KEY:'',
  AI_HUB_WORKSPACE_ROOT:path.join(root,'workspaces'),CLAUDE_HUB_ACCOUNT_FIXTURE:path.resolve('tests/fixtures/account-center-cli.js'),
  CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.resolve('tests/fixtures/codex-app-server.js'),CLAUDE_HUB_NATIVE_FIXTURE_CONTEXT:'1',CLAUDE_HUB_NATIVE_FIXTURE_STORE_DIR:path.join(root,'threads'),CLAUDE_HUB_NATIVE_FIXTURE_WRITER_DIR:path.join(root,'writers'),
  HUB_SESSION_SEARCH_CODEX_ROOTS:path.join(root,'empty'),HUB_SESSION_SEARCH_CLAUDE_ROOTS:path.join(root,'empty'),HUB_SESSION_SEARCH_KIMI_ROOTS:path.join(root,'empty'),HUB_SESSION_SEARCH_GEMINI_ROOTS:path.join(root,'empty')}});
 cdp=await connectFirstPage(hub);await until('typeof accountCenterPanel!=="undefined"&&!!window.WorkspaceController','renderer');
 await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
 const idle=await create('remember primary history'),busy=await create('fixture:hold'),sleeping=await create('sleeping history');
 assert((await invoke('close-session',sleeping.id)).ok);await until(`!sessions.has(${JSON.stringify(sleeping.id)})||sessions.get(${JSON.stringify(sleeping.id)}).status==='dormant'`,'dormant');
 await click('#btn-rail-accounts');await until('!!document.querySelector("[data-ac=codex-quota][data-profile=second]")','quota control');
 await click('[data-ac="codex-quota"][data-profile="second"]');await until('document.querySelector("[data-ac=codex-quota][data-profile=second]").textContent==="当前用量账号"','saved quota');
 const config=JSON.parse(fs.readFileSync(configFile));assert.equal(config.providers.codex.subscription_profile,'second');assert.equal(config.providers.codex.switch_scope,'launch');assert.equal(config.unrelated,'keep');
 for(const s of [idle,busy])assert.equal(await cdp.eval(`sessions.get(${JSON.stringify(s.id)}).codexProfile`),'default');
 assert.equal(await cdp.eval(`sessions.get(${JSON.stringify(busy.id)}).nativeRuntime.state`),'running');
 assert((await invoke('session:send-prompt',{sessionId:idle.id,text:'continue primary',clientSubmissionId:idle.id+'-continue'})).ok);
 await until(`sessions.get(${JSON.stringify(idle.id)}).nativeRuntime.state==='completed'`,'primary continues');
 assert.equal(await cdp.eval(`sessions.get(${JSON.stringify(idle.id)}).codexProfile`),'default');
 report.checks.push('账号页一次点击切换后续用量账号；正在运行和已打开的空闲会话保持主账号，后续发送仍保持主账号');
 const shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'20261005-codex-quota-switch-codex.png'),Buffer.from(shot.data,'base64'));
 const resumed=await invoke('resume-session',{...sleeping,hubId:sleeping.id});assert.equal(resumed.codexProfile,'second');assert.equal(resumed.codexSid,sleeping.codexSid);
 await until(`sessions.get(${JSON.stringify(sleeping.id)}).nativeRuntime.connection==='connected'`,'resume with DB');
 const restarted=await invoke('restart-session',idle.id);assert.equal(restarted.codexProfile,'second');assert.equal(restarted.codexSid,idle.codexSid);assert.equal(restarted.nativeRuntime.sqliteHome,a);
 report.checks.push('休眠恢复与显式重启使用副账号；原生线程 ID 和主账号历史数据库保留');
 await click('#account-page [data-ac="close"]');
 await click('#btn-home');
 await click('#home-create-session');await click('.new-session-option[data-kind="codex"]');await until('document.querySelector("#new-session-account").value==="second"','new launch DB');
 const beforeIds=await cdp.eval('[...sessions.keys()]');await click('#new-session-submit');await until(`([...sessions.keys()].some(id=>!${JSON.stringify(beforeIds)}.includes(id)))`,'new UI launch');
 const newId=await cdp.eval(`[...sessions.keys()].find(id=>!${JSON.stringify(beforeIds)}.includes(id))`);assert.equal(await cdp.eval(`sessions.get(${JSON.stringify(newId)}).codexProfile`),'second');
 report.checks.push('启动中心新建会话直接使用副账号额度');
 fs.writeFileSync(path.join(home,'fixture-unauthorized-codex-second'),'1');
 await click('#btn-home');await click('#home-create-session');await click('.new-session-option[data-kind="codex"]');const beforeAuth=await cdp.eval('sessions.size');
 await click('#new-session-submit');await until('document.querySelector("#new-session-menu").innerText.includes("官方登录界面")','automatic login status');
 await until('(()=>{const e=document.querySelector("#new-session-error"),r=e.getBoundingClientRect();return !e.hidden&&r.height>0&&r.top>0&&r.bottom<document.querySelector("#new-session-submit").getBoundingClientRect().top;})()','login guidance visible above submit');
 assert(fs.existsSync(path.join(home,'fixture-login-codex-second')));assert.equal(await cdp.eval('sessions.size'),beforeAuth);
 const authShot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'20261005-auto-login-launch-codex.png'),Buffer.from(authShot.data,'base64'));
 await click('#new-session-submit');await until(`sessions.size>${beforeAuth}`,'retry after login');
 const log=fs.readFileSync(path.join(home,'account-fixture.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 assert.equal(log.filter(r=>r.action==='login'&&r.id==='codex-second').length,1);
 report.checks.push('未登录时自动打开对应官方入口并保留启动选择；登录完成后用户再次启动成功，未重复弹窗');
 report.passed=true;
 }catch(error){report.error=error.stack;process.exitCode=1;if(cdp)try{report.ui=await cdp.eval('document.body.innerText.slice(-6000)');}catch{}}
 finally{if(cdp)await cdp.close();if(hub){fs.writeFileSync(path.join(out,'20261005-isolated-hub-codex.log'),hub.log().join('\n'));await gracefulQuit(hub);}fs.writeFileSync(path.join(out,'20261005-login-quota-e2e-codex.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
})();
