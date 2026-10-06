'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), path = require('path'), os = require('os');
const { matchesBinding } = require('../core/hub-tool-binding');
const { imageStatus } = require('../core/web-tool-status');
const { aiHtml } = require('../renderer/account-workspace-view');
const esc = s => String(s ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'web-tool-experience-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const write = (file, value) => { fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value)); return file; };
  return { root, write };
}
test('registered daemon transport keeps its identity; changed wrappers cannot masquerade as a binding', t => {
  const {root,write}=fixture(t), chrome=path.join(root,'hub-chrome'), pool=path.join(root,'pool');
  const binding={id:'images-primary',tool:'images',identity:'main',config:path.join(pool,'accounts/primary/config/settings.json'),entry:path.join(chrome,'tool-entrypoints/images-primary.cjs')};
  const original={id:binding.id,tool:binding.tool,identity:binding.identity,root:chrome,playwright:path.join(root,'playwright.js')};
  const module=write(path.join(root,'plugin/scripts/tab_client.cjs'),'// installed transport');
  write(binding.entry,`'use strict';\nrequire(${JSON.stringify(path.join(root,'hub/core/hub-browser-tool.js'))}).main(${JSON.stringify(original)});\n`);
  const active=path.join(pool,'entrypoints/images-primary.cjs'), options={...original,hubCore:path.join(root,'hub/core'),poolRoot:pool};
  write(active,`'use strict';\nrequire(${JSON.stringify(module)}).main(${JSON.stringify(options)});\n`);
  const config={cli_entry:active,hub_cli_entry:binding.entry}; write(binding.config,config);
  assert.equal(matchesBinding(binding,config),true);
  write(active,`'use strict';\nrequire(${JSON.stringify(module)}).main(${JSON.stringify({...options,identity:'alt'})});\n`);
  assert.equal(matchesBinding(binding,config),false);
  write(active,'process.exit(0);'); assert.equal(matchesBinding(binding,config),false);
  assert.equal(matchesBinding(binding,{...config,hub_cli_entry:'wrong'}),false);
});
test('Codex health and recent success remain separate from ChatGPT website identity and fresh login', t => {
  const {root,write}=fixture(t), pool=path.join(root,'tool-fixtures/ChatGPTWebImagesPool'), now=Date.now();
  write(path.join(pool,'codex-fallback.json'),{enabled:true,prefer:'codex',codex_home:root,private:'SECRET-AUTH-PATH'});
  write(path.join(root,'auth.json'),{auth_mode:'chatgpt',private:'SECRET'});
  write(path.join(pool,'codex-lane-health.json'),{pid:process.pid,beat:now/1000,version:'0.7.32',private:'SECRET'});
  let images=imageStatus(root,{CLAUDE_HUB_DATA_DIR:root},now);assert.equal(images.codex.ready,true);assert.equal(JSON.stringify(images).includes('SECRET'),false);
  const state={identities:[{id:'main',sites:[{key:'chatgpt',state:'unknown'}]}],webTools:{images}};
  const html=aiHtml(state,'',esc,now);assert.match(html,/生图可用.*Codex 订阅/);assert.doesNotMatch(html,/已登录|data-ac="recover"/);
  assert.equal(imageStatus(root,{CLAUDE_HUB_DATA_DIR:root},now+31000).codex.ready,false);
  write(path.join(pool,'stop-codex'),'stop');assert.equal(imageStatus(root,{CLAUDE_HUB_DATA_DIR:root},now).codex.ready,false);
});
test('recovery action belongs only to the main profile and original provider, never a second account', t => {
  const state={identities:['main','alt'].map(id=>({id,sites:[{key:'deepseek',state:'unknown'}]})),webTools:{roundtable:{waiting:[{provider:'deepseek',canResume:true,submitted:true}]}}};
  const html=aiHtml(state,'',esc);assert.equal((html.match(/data-ac="recover"/g)||[]).length,1);assert.match(html,/只补收原回答/);
  assert.match(html,/data-ac="recover" data-site="deepseek" data-identity="main"/);
});
test('bridge login evidence is not mistaken for a successful operation and network errors do not request login', t => {
  const {bridgeOutcome}=require('../core/hub-browser-tool'), {combine}=require('../core/hub-account-activity'), {usage}=require('../renderer/account-workspace-view');
  assert.equal(bridgeOutcome({logged_in:false,auth_state:'login_required'}),'login_required');
  assert.equal(bridgeOutcome({logged_in:false,challenge:true}),'verification_required');
  assert.equal(bridgeOutcome({logged_in:false,auth_state:'page_not_ready'}),'failed');
  for(const outcome of ['network_error','adapter_changed','rate_limited','quota_exhausted']) assert.equal(usage(combine([{identity:'main',site:'chatgpt',source:'bridge',outcome,at:Date.now()}])['main:chatgpt']).login,false);
});
test('fresh official proof resumes only the correct original roundtable tasks and reports partial recovery', async t => {
  const {root}=fixture(t), calls=[], {HubAccounts}=require('../core/hub-accounts'), {HubChrome}=require('../core/hub-chrome');
  const acc=new HubAccounts({hubChrome:new HubChrome({root}),env:{CLAUDE_HUB_DATA_DIR:root},getConfig:()=>({}),recovery:{resume:async row=>{calls.push(row.provider);return {errors:[{}]};}}});
  acc.progress={};await acc.resumeWaiting([{id:'main',sites:[{key:'deepseek',state:'signed_in',live:true},{key:'kimi',state:'signed_in',live:true,stale:true},{key:'qwen',state:'unknown',live:true}]},{id:'alt',sites:[{key:'deepseek',state:'signed_in',live:true}]}]);
  assert.deepEqual(calls,['deepseek']);assert.equal(acc.progress.warnings.length,1);
});

test('roundtable wait reports the settled quota issue and observes original child progress without submitting', async t => {
  const {root}=fixture(t),store=require('../core/web-roundtable/store'),status=require('../core/web-roundtable/status');
  const previous=process.env.AI_HUB_WEB_DATA_DIR;process.env.AI_HUB_WEB_DATA_DIR=root;
  t.after(()=>{if(previous===undefined)delete process.env.AI_HUB_WEB_DATA_DIR;else process.env.AI_HUB_WEB_DATA_DIR=previous;});
  const job={id:'roundtable-progress-fixture',kind:'roundtable',state:'running',pid:process.pid,input:{providers:['kimi'],rounds:1},rounds:[],inFlight:{kimi:{task_id:'web-progress-fixture'}}};
  store.write(job.id,job);store.write('web-progress-fixture',{id:'web-progress-fixture',kind:'web',state:'opening',pid:process.pid});
  const update=setTimeout(()=>store.write('web-progress-fixture',{id:'web-progress-fixture',state:'needs_attention',errorCode:'quota_exhausted',submissionAttempted:false}),50);
  t.after(()=>clearTimeout(update));
  const start=Date.now(),value=await status.readProgress(job.id,2);
  assert.ok(Date.now()-start<1500);assert.equal(value.progress.participants[0].errorCode,'quota_exhausted');
  assert.match(value.progress.participants[0].nextAction,/无需因此重新登录/);
  store.write(job.id,{...job,state:'partial'});
  assert.equal((await status.readProgress(job.id,20)).state,'partial');
  await assert.rejects(status.readProgress(job.id,21),/integer/);
  assert.equal(fs.readdirSync(store.root()).filter(f=>f.endsWith('.json')).length,2);
});
