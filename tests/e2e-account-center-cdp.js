'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),net=require('net'),assert=require('assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const port=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
async function main(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-accounts-gui-')),data=path.join(root,'data'),home=path.join(root,'home'),cwd=path.join(root,'project');
 for(const p of [data,home,cwd,path.join(root,'empty')])fs.mkdirSync(p,{recursive:true});
 fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({proxy:'',providers:{codex:{backend:'subscription',api_key:'fixture-codex-key',subscription_profiles:[{id:'default',label:'Main',home:path.join(home,'.codex')},{id:'second',label:'Second',home:path.join(home,'.codex-second')}]},deepseek:{api_key:'fixture-deepseek-key'}},unrelatedFixture:'preserve-me'}));
 fs.writeFileSync(path.join(data,'prepared-projects.json'),JSON.stringify({schemaVersion:1,projects:[],migrations:[]}));
 const out=path.resolve('artifacts/account-center-cdp');fs.mkdirSync(out,{recursive:true});
 const result={passed:false,boundary:'真实隔离 Hub、DOM、IPC、文件持久化与账号子进程夹具；没有真实登录、短信或模型请求',checks:[],root};let hub,cdp;
 const until=async(expr,label)=>{for(const end=Date.now()+35000;Date.now()<end;){if(await cdp.eval('Boolean('+expr+')')){console.log('PASS '+label);return;}await sleep(120);}throw Error('timeout: '+label);};
 const click=async selector=>{await until('!!document.querySelector('+JSON.stringify(selector)+') && !document.querySelector('+JSON.stringify(selector)+').disabled','enabled '+selector);const box=await cdp.eval(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...box});await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...box});};
 const snap=async name=>{const v=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(v.data,'base64'));};
 const trace=()=>{try{return fs.readFileSync(path.join(home,'account-fixture.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);}catch(e){if(e.code==='ENOENT')return [];throw e;}};
 let sweeps=0;
 // Wait on the button's own busy state: the "已刷新" notice from a previous sweep would
 // otherwise satisfy the wait before this sweep has actually run.
 const refresh=async label=>{
  await click('[data-ac=refresh]');sweeps++;
  await sleep(300);
  await until('document.querySelector("[data-ac=refresh]").disabled===false && document.querySelector(".ac-status").textContent.includes("已刷新")',label);
 };
 const text=selector=>cdp.eval(`document.querySelector(${JSON.stringify(selector)}).innerText`);
 // Disclosure toggles are driven to a state, not blindly clicked: a background re-render can
 // land between reading the button's box and dispatching, and a blind retry would undo itself.
 const setToggle=async(action,want,label)=>{
  const sel='[data-ac='+action+']';
  for(let i=0;i<4;i++){
   if(await cdp.eval(`document.querySelector('${sel}').getAttribute('aria-expanded')==='${want}'`)){console.log('PASS '+label);return;}
   await click(sel);await sleep(400);
  }
  throw Error('toggle never reached '+want+': '+label);
 };
 try{
  hub=await launchIsolatedHub({dataDir:data,port:await port(),windowMode:'visible',label:'accounts-center',extraEnv:{CLAUDE_HUB_HOME_DIR:home,CODEX_HOME:path.join(home,'.codex'),CLAUDE_CONFIG_DIR:path.join(home,'.claude'),AI_HUB_WORKSPACE_ROOT:root,
   CLAUDE_HUB_ACCOUNT_FIXTURE:path.resolve('tests/fixtures/account-center-cli.js'),CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.resolve('tests/fixtures/codex-app-server.js'),CLAUDE_HUB_NATIVE_FIXTURE_STORE:path.join(root,'threads.json'),
   HUB_SESSION_SEARCH_CODEX_ROOTS:path.join(root,'empty'),HUB_SESSION_SEARCH_CLAUDE_ROOTS:path.join(root,'empty'),HUB_SESSION_SEARCH_KIMI_ROOTS:path.join(root,'empty'),HUB_SESSION_SEARCH_GEMINI_ROOTS:path.join(root,'empty')}});
  result.pid=hub.pid;result.port=hub.port;cdp=await connectFirstPage(hub);await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:960,deviceScaleFactor:1,mobile:false});
  await until('typeof accountCenterPanel!=="undefined"','renderer initialized');

  // One card per account, its uses listed inside; no tabs, filters, search or check buttons.
  await click('#btn-rail-accounts');await until('document.querySelectorAll(".ac-card").length>5','account cards');
  assert.equal(await cdp.eval('document.querySelector("#account-page").hidden'),false);
  assert.deepEqual(await cdp.eval('[...document.querySelectorAll(".ac-card")].map(c=>c.dataset.card)'),
   ['openai','openai#codex-second','openai#secondary','anthropic','google','moonshot','deepseek','doubao','qwen']);
  assert.equal(await cdp.eval('document.querySelectorAll("[data-ac-tab],#ac-search,[data-ac=check],[data-ac=filter],[data-ab-select]").length'),0,'simplified page has no tabs, search, filters or check buttons');
  assert.equal(await cdp.eval('document.querySelector("#config-modal #cfg-codex-key")'),null);
  assert.equal(await cdp.eval('document.querySelector("#config-modal #cfg-aliyun-token")'),null);
  result.checks.push('没有会话也能速览；一个账号一张卡；旧的页签、搜索、筛选和"检查"按钮已移除；账号与服务密钥仍在权限页');await snap('01-overview');

  // The ChatGPT account shows its four other uses as sub-rows, each with its own proof.
  const openai='.ac-card[data-card="openai"]';
  assert.deepEqual(await cdp.eval(`[...document.querySelectorAll('${openai} .ac-feature')].map(el=>el.dataset.feature)`),
   ['codex-default','bridge','chatgpt-web','web-chatgpt','image-primary']);
  assert.deepEqual(await cdp.eval(`[...document.querySelectorAll('${openai} .ac-feature .ac-feature-name')].map(el=>el.textContent)`),
   ['Codex 客户端','公司拉取 / 同步','Codex Web GPT','网页对话（专用浏览器）','网页生图']);
  await until(`document.querySelector('${openai} .ac-feature[data-feature=codex-default] .ac-dot').classList.contains('ok')`,'native receipt inside the card');
  assert.equal(await cdp.eval(`document.querySelector('${openai} .ac-feature[data-feature=bridge] .ac-dot').classList.contains('ok')`),false,'one confirmed use must not vouch for the others');
  assert.ok((await text(openai+' .ac-card-title')).includes('已登录'));
  // Which account each use runs on is the question the platform grouping made hard to answer.
  await until(`document.querySelector('${openai} .ac-feature[data-feature=codex-default] .ac-feature-account').textContent==='fixture-main@example.com'`,'client row names its account');
  assert.equal(await cdp.eval(`document.querySelector('${openai} .ac-feature[data-feature=image-primary] .ac-feature-account').textContent`),'FIXTURE POOL');
  assert.equal(await cdp.eval(`document.querySelector('${openai} .ac-feature[data-feature=chatgpt-web] .ac-feature-account').textContent`),'账号未标注','an unlabelled use says so instead of borrowing a neighbour’s account');
  // A different Codex profile and the backup image account are separate accounts, not sub-features.
  assert.ok((await text('.ac-card[data-card="openai#codex-second"] .ac-card-title')).includes('Second'));
  assert.ok((await text('.ac-card[data-card="openai#secondary"]')).includes('需要登录'));
  result.checks.push('同一个 ChatGPT 账号的 Codex、公司中转、Codex Web GPT、网页与生图收成一张卡的五个子功能，状态各自独立；另一个 Codex 账号与生图备用账号仍是独立卡片');

  // Two real polling cycles: unchanged data must not replace controls or lose focus.
  await cdp.eval(`(()=>{
   const body=document.querySelector('.ac-content'),button=body.querySelector('.ac-feature[data-feature=web-gemini] button');
   button.focus({preventScroll:true});body.scrollTop=120;
   window.accountRefreshProbe={button,top:body.scrollTop,replacements:0};
   window.accountRefreshObserver=new MutationObserver(records=>{accountRefreshProbe.replacements+=records.filter(r=>r.target===body&&r.removedNodes.length).length;});
   accountRefreshObserver.observe(body,{childList:true});
  })()`);
  await sleep(11000);
  const polling=await cdp.eval(`(()=>{accountRefreshObserver.disconnect();return {replacements:accountRefreshProbe.replacements,sameButton:accountRefreshProbe.button.isConnected,focusRetained:document.activeElement===accountRefreshProbe.button,scrollBefore:accountRefreshProbe.top,scrollAfter:document.querySelector('.ac-content').scrollTop};})()`);
  fs.writeFileSync(path.join(out,'polling.json'),JSON.stringify(polling,null,2));
  assert.equal(polling.replacements,0,'unchanged polling must not rebuild the account page');
  assert.equal(polling.sameButton,true);assert.equal(polling.focusRetained,true);assert.equal(polling.scrollAfter,polling.scrollBefore);
  result.checks.push('跨两次真实定时刷新，未变化的账号页面零整页替换，按钮焦点和滚动位置保留');

  // A background poll that is still in flight must not stack another one behind it.
  await cdp.eval(`(()=>{
   window.accountOriginalInvoke=ipcRenderer.invoke;window.accountSnapshotCalls=0;
   ipcRenderer.invoke=function(channel,...args){
    const response=accountOriginalInvoke.call(this,channel,...args);
    if(channel!=='accounts:snapshot')return response;
    accountSnapshotCalls++;
    window.accountSnapshotDelivered=response.then(value=>new Promise(resolve=>{window.accountSnapshotRelease=()=>resolve(value);}));
    return accountSnapshotDelivered;
   };
  })()`);
  await until('typeof accountSnapshotRelease==="function"','background response held');
  await sleep(5500);
  assert.equal(await cdp.eval('accountSnapshotCalls'),1,'polls do not overlap');
  await cdp.eval('(async()=>{ipcRenderer.invoke=accountOriginalInvoke;accountSnapshotRelease();await accountSnapshotDelivered;})()');
  result.checks.push('延迟真实 IPC 回执的竞态验证：后台请求不重叠');

  // Opening a website is not a login: it must not take the lease or change the receipt.
  await click(`${openai} .ac-feature[data-feature=image-primary] button`);
  await until('document.querySelector(".ac-status").textContent.includes("原账号网页")','webpage open acknowledged');
  const beforeLogin=await cdp.eval('(async()=>{const r=await ipcRenderer.invoke("accounts:snapshot");return r.data.connections.find(x=>x.id==="image-primary");})()');
  assert.equal(beforeLogin.pending,false);assert.equal(beforeLogin.state,'signed_in');
  assert.equal(trace().filter(x=>x.action==='login'&&x.id==='image-primary').length,0);
  assert.equal(trace().filter(x=>x.action==='open'&&x.id==='image-primary').length,1);
  result.checks.push('已登录的网页用途只提供"打开"，走独立 IPC/子进程，不启动登录、不占登录锁、不改登录状态');

  // The account button fans out to the exact connection ids that still need a login.
  assert.equal(await cdp.eval(`document.querySelector('${openai} [data-ac=card-login]').textContent`),'登录（3 项）');
  await click(`${openai} [data-ac=card-login]`);
  await until('document.querySelector(".ac-status").textContent.includes("登录")','account login started');
  for(const end=Date.now()+20000;Date.now()<end&&trace().filter(x=>x.action==='login').length<3;)await sleep(150);
  for(const id of ['bridge','chatgpt-web','web-chatgpt'])assert.equal(trace().filter(x=>x.action==='login'&&x.id===id).length,1,id);
  for(const id of ['codex-default','image-primary'])assert.equal(trace().filter(x=>x.action==='login'&&x.id===id).length,0,id);
  assert.ok(!trace().some(x=>x.id==='openai'),'a platform grouping id must never reach the login interface');
  result.checks.push('账号卡的"登录"按钮只对还缺登录的 3 个原始授权 ID 逐个开窗；已登录的 Codex 与生图被跳过；分组 ID 不进入登录接口');

  // A finished login is confirmed by the page itself, with no check button to press.
  await until(`document.querySelector('${openai} .ac-feature[data-feature=bridge] .ac-dot').classList.contains('ok')`,'login confirmed automatically');
  assert.ok((await text(openai+' .ac-card-title')).includes('5/5'));
  assert.equal(await cdp.eval(`document.querySelector('${openai} [data-ac=card-login]').textContent`),'重新登录');
  assert.equal(await cdp.eval('document.querySelectorAll(".ac-card[data-card=anthropic] [data-ac=card-login]").length'),0,'a one-use account shows one button, not two');
  result.checks.push('登录完成后页面自行确认，无需点任何"检查"按钮；卡片计数与主按钮随之变化');await snap('02-confirmed');

  // An account with a single use takes the single-connection login path, not the batch one.
  await click('.ac-card[data-card="deepseek"] .ac-feature[data-feature=web-deepseek] button');
  await until('document.querySelector(".ac-status").textContent.includes("官方登录窗口")','single login acknowledged');
  assert.equal(trace().filter(x=>x.action==='login'&&x.id==='web-deepseek').length,1);
  await until(`document.querySelector('.ac-card[data-card="deepseek"] .ac-dot').classList.contains('ok')`,'single account confirmed itself');
  result.checks.push('单一用途的账号走单连接登录 IPC，完成后同样自行确认');

  // The reported bug: a browser that is merely closed must not read as "not signed in".
  fs.writeFileSync(path.join(home,'fixture-offline-web-deepseek'),'1');
  await refresh('offline sweep finished');
  const closed='.ac-card[data-card="deepseek"] .ac-feature[data-feature=web-deepseek]';
  await until(`document.querySelector('${closed} .ac-dot').classList.contains('rest')`,'closed browser keeps its login');
  assert.match(await text(closed+' .ac-feature-state'),/已登录 · 浏览器已关闭/);
  assert.equal(await cdp.eval(`document.querySelector('${closed} button').textContent`),'打开','nothing to log in again — just reopen it');
  fs.unlinkSync(path.join(home,'fixture-offline-web-deepseek'));
  result.checks.push('专用浏览器关掉后仍显示"已登录 · 浏览器已关闭"并给"打开"，不再谎报未登录');

  // Refreshing asks every connection once, and keeps that sweep out of the activity list.
  const before=trace().filter(x=>x.action==='check').length;
  await refresh('refresh finished');
  assert.ok(trace().filter(x=>x.action==='check').length>before+5,'refresh must reach the tools that are not probed automatically');
  await setToggle('toggle-history',true,'activity list open');await until('!!document.querySelector(".ac-log")','activity list');
  await until(`document.querySelector('.ac-log').innerText.includes('刷新状态')`,'refresh recorded once');
  assert.equal(await cdp.eval(`[...document.querySelectorAll('.ac-log li')].filter(el=>el.innerText.includes('检查完成')).length`),0,'a status sweep must not bury the real actions');
  assert.equal(await cdp.eval(`[...document.querySelectorAll('.ac-log li')].filter(el=>el.innerText.includes('刷新状态')).length`),sweeps,'one summary line per sweep, not one per connection');
  await setToggle('toggle-history',false,'activity list closed');
  await until(`document.querySelector('${openai} .ac-feature[data-feature=bridge] .ac-feature-account').textContent==='fixture-bridge@example.com'`,'bridge names its own account');
  assert.match(await text(openai+' .ac-card-title'),/3 个账号/,'one platform card holding three logins must say three');
  result.checks.push('每项用途显示它自己所属的账号（含公司中转与生图池的标注），未标注就直说；一张卡里有几个账号在标题写清楚');
  result.checks.push('"刷新状态"一次覆盖全部连接（含不自动探测的中转、生图与服务），活动记录只留一行汇总');

  // API keys and service tokens stay out of the account cards.
  assert.equal(await cdp.eval('document.querySelectorAll(".ac-card .ac-feature[data-feature^=api-]").length'),0);
  await setToggle('toggle-others',true,'other integrations open');await until('!!document.querySelector(".ac-features.plain")','other integrations');
  const others=await cdp.eval(`[...document.querySelectorAll('.ac-features.plain .ac-feature')].map(el=>el.dataset.feature)`);
  assert.deepEqual(others.sort(),['api-claude','api-codex','api-deepseek','feishu','server-monitor','token-plan']);
  await snap('03-other-integrations');
  result.checks.push('API 密钥与服务授权归入"其他接入"，不混进账号卡片');

  // Account configuration still persists through the real config file.
  await click('[data-ac=config][data-id=codex]');await until('!document.querySelector("#account-editor").hidden','account config opened');
  await until('document.querySelector("#cfg-detail-codex").classList.contains("active")','Codex form');
  await cdp.eval('document.querySelector("#cfg-codex-profile-default-label").value="验证主账号"');
  await click('#account-config-save');await until('document.querySelector("#account-config-msg").textContent.includes("已保存")','account config persisted');
  let config=JSON.parse(fs.readFileSync(path.join(data,'config.json'),'utf8'));
  assert.equal(config.unrelatedFixture,'preserve-me');assert.ok(JSON.stringify(config).includes('验证主账号'));
  await snap('04-native-config');
  await click('[data-ac=back]');await until('!!document.querySelector(".ac-card")','back to the account list');
  assert.equal(await cdp.eval('document.querySelector("#account-editor").hidden'),true);
  await click('[data-ac=config][data-id=server]');
  await until('document.querySelector("#cfg-detail-server").classList.contains("active")','server credentials');
  await cdp.eval('document.querySelector("#cfg-aliyun-token").value="fixture-monitor-token"');await click('#account-config-save');
  await until('document.querySelector("#account-config-msg").textContent.includes("已保存")','server token saved');
  await cdp.eval('openConfigModal()');await until('!document.querySelector("#config-modal").classList.contains("hidden")','general settings');
  await cdp.eval('document.querySelector("#cfg-proxy").value="http://127.0.0.1:7890"');await click('#config-save');
  await until('document.querySelector("#config-save-msg").textContent.includes("已保存")','settings saved');
  config=JSON.parse(fs.readFileSync(path.join(data,'config.json'),'utf8'));
  assert.equal(config.providers.codex.api_key,'fixture-codex-key');assert.equal(config.providers.deepseek.api_key,'fixture-deepseek-key');
  assert.ok(JSON.stringify(config).includes('fixture-monitor-token'));assert.ok(JSON.stringify(config).includes('验证主账号'));
  await click('#config-close');
  const publicState=await cdp.eval('ipcRenderer.invoke("accounts:snapshot")');
  assert.ok(!JSON.stringify(publicState).includes('fixture-monitor-token'));
  assert.ok(!JSON.stringify(publicState).includes('fixture-codex-key'));
  result.checks.push('账号与服务器密钥在权限页真实保存到隔离 config.json，普通设置保存不覆盖；账号总览不返回任何密钥');

  await click('[data-ac=back]');
  await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});
  assert.equal(await cdp.eval('document.querySelector("#account-page").hidden'),true);
  const s=await cdp.eval('ipcRenderer.invoke("create-session",'+JSON.stringify({kind:'codex',opts:{cwd,model:'gpt-6-astra',effort:'medium',mcpProfile:'none'}})+')');assert.ok(s.id,JSON.stringify(s));
  await click('.session-item[data-session-id="'+s.id+'"]');await until('!!document.querySelector(".floating-input-box")','composer');
  await cdp.eval('document.querySelector(".floating-input-box").textContent="保留这份草稿"');
  await click('#btn-rail-accounts');await until('!document.querySelector("#account-page").hidden','accounts during normal session');await click('[data-ac="close"]');
  assert.equal(await cdp.eval('document.querySelector(".floating-input-box").textContent'),'保留这份草稿');
  result.checks.push('普通会话进入/退出账号页保留草稿和会话');

  const slot={kind:'codex',model:'gpt-6-astra',effort:'medium',mcpProfile:'none'};
  const meeting=await cdp.eval('ipcRenderer.invoke("create-meeting",'+JSON.stringify({title:'账号页群聊验证',scene:'general',groupChat:true,workspace:cwd,slots:[slot,slot]})+')');assert.equal(meeting.subSessions.length,2);
  await cdp.eval('window.MeetingRoom.openMeeting('+JSON.stringify(meeting.id)+','+JSON.stringify(meeting)+')');
  await until('!!document.querySelector("#mr-input-box")','group composer');
  await click('#mr-input-box');await cdp.send('Input.insertText',{text:'群聊草稿保留'});await click('[data-group-layout="two"]');
  await until('document.querySelectorAll(".gms-member-view:not([hidden])").length===2','two members mounted');
  await click('#btn-rail-accounts');await until('!document.querySelector("#account-page").hidden','accounts during group');await click('[data-ac="close"]');
  assert.equal(await cdp.eval('document.querySelector("#mr-input-box").textContent'),'群聊草稿保留');
  assert.equal(await cdp.eval('document.querySelectorAll(".gms-member-view:not([hidden])").length'),2);
  result.checks.push('群聊双成员视图进入/退出账号页保留共享草稿和两份成员视图');

  await click('#btn-rail-accounts');await click('#btn-rail-memory');await until('!document.querySelector("#memory-page").hidden','memory opens');assert.equal(await cdp.eval('document.querySelector("#account-page").hidden'),true);
  await click('#btn-rail-accounts');await until('!document.querySelector("#account-page").hidden','accounts opens from memory');assert.equal(await cdp.eval('document.querySelector("#memory-page").hidden'),true);
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:920,height:820,deviceScaleFactor:1,mobile:false});await snap('05-narrow');
  result.checks.push('与记忆页互斥；窄窗口真实渲染');result.passed=true;
 }catch(e){result.error=e.stack;if(hub)result.log=hub.log();if(cdp){try{await snap('failure');result.dom=await cdp.eval('document.body.innerText');}catch{}}throw e;}finally{fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));if(cdp)await cdp.close();if(hub)await gracefulQuit(hub);}
 console.log(JSON.stringify(result,null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
