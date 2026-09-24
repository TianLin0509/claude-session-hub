'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {accountRows,accountCards,cardKey,featureName,featureAction,cardAction,needsAttention,statusText,tone}=require('../renderer/account-center-view');

test('attention badges require a human login need, not an offline browser or unknown proof',()=>{
 for(const state of ['offline','unknown','unavailable','configured'])assert.equal(needsAttention({state}),false);
 assert.equal(needsAttention({state:'login_required'}),true);
 assert.equal(needsAttention({state:'login_required',enabled:false}),false);
 assert.equal(needsAttention({state:'unknown',pending:true}),true);
 assert.equal(needsAttention({state:'signed_in',pending:true,stale:false}),false);
});
test('row actions separate opening a website, starting a login, reopening a stuck window and configuring',()=>{
 const web={id:'web-chatgpt',type:'web',action:'login',state:'signed_in'};
 assert.deepEqual(featureAction(web),{action:'open',label:'打开',id:'web-chatgpt'});
 assert.equal(featureAction({...web,state:'unknown'}).action,'login');
 assert.equal(featureAction({...web,state:'login_required'}).action,'login');
 assert.equal(featureAction({...web,pending:true}).action,'relogin');
 assert.equal(featureAction({...web,type:'native'}).action,'relogin');
 assert.equal(featureAction({...web,type:'native',state:'unknown'}).action,'login');
 assert.deepEqual(featureAction({action:'configure',configProvider:'server'}),{action:'config',label:'配置',id:'server'});
});
test('status wording never turns a stale or offline record into a fresh login',()=>{
 assert.equal(statusText({state:'signed_in',stale:true}),'上次已登录');
 assert.equal(statusText({state:'signed_in'}),'已登录');
 assert.equal(statusText({state:'offline'}),'浏览器未在线');
 assert.equal(statusText({state:'unknown',pending:true}),'登录窗口已打开，完成后自动确认');
 assert.equal(statusText({state:'signed_in',enabled:false}),'已停用');
 assert.equal(statusText({state:'signed_in',webRecovery:[{id:'t1'}]}),'1 项网页任务等登录后继续');
 assert.equal(tone({state:'signed_in',stale:true}),'idle');
 assert.equal(tone({state:'signed_in'}),'ok');
 assert.equal(tone({state:'login_required'}),'warn');
});

function lanes(){return ['primary','secondary'].flatMap(loginGroup=>Array.from({length:4},(_,i)=>{
 const accountId=loginGroup+(i?'-'+(i+1):'');
 return {id:'image-'+accountId,accountId,loginGroup,provider:'images',type:'web',action:'login',enabled:true,state:'signed_in',stale:false,observedAt:100,uses:['网页生图 MCP']};
}));}
test('eight browser lanes become two account entries without modifying raw action identities',()=>{
 const input=lanes(),before=JSON.stringify(input),rows=accountRows(input);
 assert.deepEqual(rows.map(r=>r.name),['ChatGPT 生图 · 主账号','ChatGPT 生图 · 备用账号']);
 assert.deepEqual(rows.map(r=>r.id),['image-primary','image-secondary']);
 assert.equal(rows[0].members.length,4);assert.equal(JSON.stringify(input),before);
});
test('a failing child remains visible and login actions route to that exact browser',()=>{
 const input=lanes();input[2].state='login_required';input[2].observedAt=0;input[2].stale=true;
 const row=accountRows(input)[0];assert.equal(row.state,'login_required');assert.equal(row.id,'image-primary-3');
 assert.equal(row.accountId,'primary-3');assert.equal(row.stale,true);assert.equal(row.observedAt,0);
 assert.equal(featureAction(row).id,'image-primary-3');
});
test('disabled lanes do not produce false login alarms but remain inspectable',()=>{
 const input=lanes();input[1].enabled=false;input[1].state='login_required';
 const row=accountRows(input)[0];assert.equal(row.state,'signed_in');assert.equal(row.id,'image-primary');assert.equal(row.connectionCount,3);assert.equal(row.members.length,4);
});
test('no name-suffix or masked-email guessing; legacy records stay separate',()=>{
 const input=lanes().slice(0,2).map(({loginGroup,...row})=>({...row,identity:'a•••@example.com'}));
 assert.equal(accountRows(input).length,2);assert.ok(accountRows(input).every(r=>!r.members));
});

function fleet(){return [
 {id:'claude',name:'Claude Code',provider:'claude',type:'native',action:'login',state:'signed_in',identity:'c•••@example.com'},
 {id:'codex-default',name:'Codex · 主账号',provider:'codex',type:'native',action:'login',isDefault:true,state:'signed_in',identity:'l•••@gmail.com'},
 {id:'codex-second',name:'Codex · 第二账号',provider:'codex',type:'native',action:'login',state:'login_required',identity:'w•••@gmail.com'},
 {id:'gemini-cli',name:'Gemini CLI',provider:'gemini',type:'native',action:'login',state:'configured'},
 {id:'kimi',name:'Kimi Code',provider:'kimi',type:'native',action:'login',state:'signed_in'},
 {id:'bridge',name:'ChatGPT · 公司中转',provider:'bridge',type:'web',action:'login',state:'signed_in'},
 {id:'chatgpt-web',name:'ChatGPT · Codex Web GPT',provider:'chatgpt-web',type:'web',action:'login',state:'unknown'},
 {id:'web-chatgpt',name:'ChatGPT · 网页',provider:'chatgpt',type:'web',action:'login',managedBrowser:true,state:'login_required'},
 {id:'web-kimi',name:'Kimi · 网页',provider:'kimi',type:'web',action:'login',managedBrowser:true,state:'unknown'},
 {id:'web-deepseek',name:'DeepSeek · 网页',provider:'deepseek',type:'web',action:'login',managedBrowser:true,state:'signed_in'},
 {id:'api-deepseek',name:'DeepSeek API',provider:'deepseek',type:'api',action:'configure',configProvider:'deepseek',state:'configured'},
 {id:'server-monitor',name:'服务器监控授权',provider:'server',type:'service',action:'configure',configProvider:'server',state:'unknown'},
 ...accountRows(lanes()),
];}
test('one ChatGPT account holds its feature list; a second ChatGPT login stays a separate card',()=>{
 const rows=fleet(),before=JSON.stringify(rows),{cards,others}=accountCards(rows);
 const openai=cards.find(c=>c.key==='openai');
 assert.deepEqual(openai.features.map(r=>r.id),['codex-default','bridge','chatgpt-web','web-chatgpt','image-primary']);
 assert.deepEqual(openai.features.map(featureName),['Codex 客户端','公司拉取 / 同步','Codex Web GPT','网页对话（专用浏览器）','网页生图']);
 assert.equal(openai.identity,'l•••@gmail.com');
 assert.equal(openai.name,'ChatGPT / OpenAI');
 // A distinct Codex profile and the backup image account are distinct logins, not sub-features.
 assert.deepEqual(cards.filter(c=>c.alt).map(c=>[c.key,c.name]),[['openai#codex-second','Codex · 第二账号'],['openai#secondary','ChatGPT 生图 · 备用账号']]);
 assert.equal(JSON.stringify(rows),before);
});
test('grouping never merges state: the card only counts what each connection proved',()=>{
 const {cards}=accountCards(fleet()),openai=cards.find(c=>c.key==='openai');
 assert.equal(openai.total,5);assert.equal(openai.signedIn,3);assert.equal(openai.attention,1);
 assert.deepEqual(openai.features.map(r=>r.state),['signed_in','signed_in','unknown','login_required','signed_in']);
});
test('the card button fans out to real connection ids and skips confirmed ones',()=>{
 const {cards}=accountCards(fleet()),openai=cards.find(c=>c.key==='openai');
 const act=cardAction(openai);
 assert.equal(act.primary,true);assert.deepEqual(act.ids,['chatgpt-web','web-chatgpt']);
 assert.equal(act.label,'登录（2 项）');
 assert.ok(!act.ids.includes('openai'),'a platform key must never reach the login interface');
 const claude=cards.find(c=>c.key==='anthropic');
 assert.deepEqual(cardAction(claude),{label:'重新登录',ids:['claude'],primary:false});
 const disabled={key:'x',features:[{id:'a',action:'login',enabled:false,state:'login_required'}]};
 assert.deepEqual(cardAction(disabled).ids,[]);
});
test('API keys and service tokens are listed apart from login accounts and keep their own names',()=>{
 const {cards,others}=accountCards(fleet());
 assert.deepEqual(others.map(r=>r.id),['api-deepseek','server-monitor']);
 assert.deepEqual(others.map(featureName),['DeepSeek API','服务器监控授权']);
 assert.ok(!cards.some(c=>c.features.some(r=>r.type==='api'||r.type==='service')));
 assert.equal(cardKey({type:'api',provider:'codex'}),'');
});
test('platform cards cover every vendor once and keep a stable order',()=>{
 const {cards}=accountCards(fleet());
 assert.deepEqual(cards.map(c=>c.key),['openai','openai#codex-second','openai#secondary','anthropic','google','moonshot','deepseek']);
 assert.deepEqual(cards.find(c=>c.key==='moonshot').features.map(r=>r.id),['kimi','web-kimi']);
 assert.deepEqual(cards.find(c=>c.key==='google').features.map(r=>r.id),['gemini-cli']);
});

test('a web task waiting on a login offers to continue only once that login is proved',()=>{
 const row={id:'web-deepseek',type:'web',action:'login',state:'unknown',webRecovery:[{id:'t1',canResume:true}]};
 assert.equal(featureAction(row).action,'login','no proof yet: log in first');
 assert.deepEqual(featureAction({...row,state:'signed_in'}),{action:'resume',label:'继续任务',id:'web-deepseek'});
 assert.equal(featureAction({...row,state:'signed_in',pending:true}).action,'relogin');
 assert.equal(featureAction({...row,state:'signed_in',webRecovery:[{id:'t1',canResume:false}]}).action,'open');
});
