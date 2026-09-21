'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {accountRows,isPrimary,bindingRows,isOpenAI,accountSections}=require('../renderer/account-center-view');
const {needsAttention,accountAction}=require('../renderer/account-center-view');
test('attention badges require a human login need, not an offline browser or unknown proof',()=>{
 for(const state of ['offline','unknown','unavailable','configured'])assert.equal(needsAttention({state}),false);
 assert.equal(needsAttention({state:'login_required'}),true);
 assert.equal(needsAttention({state:'login_required',enabled:false}),false);
 assert.equal(needsAttention({state:'unknown',pending:true}),true);
 assert.equal(needsAttention({state:'signed_in',pending:true,stale:false}),false);
});
test('primary actions distinguish opening webpages from starting a login and native authorization',()=>{
 const web={id:'web-chatgpt',type:'web',action:'login',state:'signed_in'};
 assert.equal(accountAction(web).action,'open');assert.equal(accountAction({...web,state:'unknown'}).action,'open');
 assert.equal(accountAction({...web,state:'login_required'}).action,'login');assert.equal(accountAction({...web,pending:true}).action,'attention');
 assert.equal(accountAction({...web,type:'native'}).action,'select');assert.equal(accountAction({...web,type:'native',state:'unknown'}).action,'login');
 assert.deepEqual(accountAction({action:'configure',configProvider:'server'}),{action:'config',label:'接入配置',id:'server'});
});
function lanes(){return ['primary','secondary'].flatMap(loginGroup=>Array.from({length:4},(_,i)=>{
 const accountId=loginGroup+(i?'-'+(i+1):'');
 return {id:'image-'+accountId,accountId,loginGroup,provider:'images',type:'web',action:'login',enabled:true,state:'signed_in',stale:false,observedAt:100,uses:['网页生图 MCP']};
}));}
test('eight browser lanes become two account entries and one feature without modifying raw action identities',()=>{
 const input=lanes(),before=JSON.stringify(input),rows=accountRows(input);
 assert.deepEqual(rows.map(r=>r.name),['ChatGPT 生图 · 主账号','ChatGPT 生图 · 备用账号']);
 assert.deepEqual(rows.map(r=>r.id),['image-primary','image-secondary']);
 assert.equal(rows[0].members.length,4);assert.equal(bindingRows(rows).length,1);
 assert.equal(bindingRows(rows)[0].accounts.length,2);assert.equal(JSON.stringify(input),before);
});
test('a failing child remains visible and login/batch actions route to that exact browser',()=>{
 const input=lanes();input[2].state='login_required';input[2].observedAt=0;input[2].stale=true;
 const row=accountRows(input)[0];assert.equal(row.state,'login_required');assert.equal(row.id,'image-primary-3');
 assert.equal(row.accountId,'primary-3');assert.equal(row.stale,true);assert.equal(row.observedAt,0);
 assert.equal(row.members[0].state,'signed_in');
});
test('disabled lanes do not produce false login alarms but remain inspectable',()=>{
 const input=lanes();input[1].enabled=false;input[1].state='login_required';
 const row=accountRows(input)[0];assert.equal(row.state,'signed_in');assert.equal(row.id,'image-primary');assert.equal(row.connectionCount,3);assert.equal(row.members.length,4);
 input.slice(0,4).forEach(r=>r.enabled=false);assert.equal(isPrimary(accountRows(input)[0]),false);
});
test('no name-suffix or masked-email guessing; legacy records stay separate',()=>{
 const input=lanes().slice(0,2).map(({loginGroup,...row})=>({...row,identity:'a•••@example.com'}));
 assert.equal(accountRows(input).length,2);assert.ok(accountRows(input).every(r=>!r.members));
});
test('auxiliary integrations are secondary, while native agents, managed websites and bridge remain visible',()=>{
 assert.equal(isPrimary({type:'native',provider:'codex'}),true);
 assert.equal(isPrimary({type:'native',provider:'claude'}),true);
 assert.equal(!!isPrimary({type:'native',provider:'gemini'}),false);
 assert.equal(isPrimary({type:'web',provider:'gemini',managedBrowser:true}),true);
 assert.equal(isPrimary({provider:'bridge'}),true);
 assert.equal(!!isPrimary({type:'api',provider:'codex'}),false);
 assert.equal(!!isPrimary({type:'service',provider:'server'}),false);
});

test('OpenAI groups authorizations without merging identities, states or action targets',()=>{
 const rows=[{id:'claude',provider:'claude',type:'native'},
 {id:'codex-main',provider:'codex',type:'native',state:'signed_in',identity:'one'},
 {id:'codex-other',provider:'codex',type:'native',state:'login_required',identity:'two'},
 {id:'web-chatgpt',provider:'chatgpt',managedBrowser:true,state:'unknown'},
 ...accountRows(lanes()),{id:'bridge',provider:'bridge'},
 {id:'api-codex',provider:'codex',type:'api'},{id:'gemini',provider:'gemini',managedBrowser:true}];
 const before=JSON.stringify(rows),sections=accountSections(rows),family=sections.find(s=>s.id==='openai');
 assert.equal(sections.length,4);assert.equal(family.rows.length,6);
 assert.equal(family.rows[0],rows[1]);assert.equal(family.rows[1].state,'login_required');
 assert.equal(family.rows[2].state,'unknown');assert.equal(family.rows[3].members.length,4);
 assert.equal(JSON.stringify(rows),before);assert.equal(!!isOpenAI(rows.at(-2)),false);
 assert.equal(isOpenAI({provider:'chatgpt-web'}),true);
});
