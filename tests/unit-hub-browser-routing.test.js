'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const r=require('../core/hub-browser-routing'),{HubChrome}=require('../core/hub-chrome');
test('foreign AI uses Hub proxy; domestic endpoints, assets and auth bypass it',()=>{
 const proxy='http://127.0.0.1:7890',p=r.policy(proxy);
 assert.ok(p.args.includes('--proxy-server='+proxy));
 for(const host of ['chatgpt.com','auth.openai.com','claude.ai','gemini.google.com','accounts.google.com','www.gstatic.com','challenges.cloudflare.com','deepseek.com.evil.test'])assert.equal(r.route('https://'+host,proxy),'hub_proxy',host);
 for(const host of ['chat.deepseek.com','www.kimi.com','kimi.moonshot.cn','statics.moonshot.cn','www.qianwen.com','g.alicdn.com','www.doubao.com']){
  assert.equal(r.route('https://'+host,proxy),'direct',host);
 }
 assert.ok(p.bypass.includes('deepseek.com;*.deepseek.com'));assert.ok(!p.bypass.includes('*deepseek.com;'));
 assert.deepEqual(r.policy('').args,['--no-proxy-server']);
 for(const bad of ['bad','http://u:p@localhost:7890','http://localhost:7890/path','file:///x'])assert.throws(()=>r.policy(bad),/代理地址无效/);
});
test('each launch reads current Hub settings, and both ordinary and debugging launches use the same route',()=>{
 let proxy='http://127.0.0.1:7890';const h=new HubChrome({root:os.tmpdir(),proxy:()=>proxy});
 assert.ok(h.launchArgs('main').includes('--proxy-server='+proxy));proxy='http://127.0.0.1:9876';
 for(const options of [{},{visible:true,debug:false},{headless:true}])assert.ok(h.launchArgs('alt',options).includes('--proxy-server='+proxy));
});
test('old or changed browser routing cannot silently reuse the wrong running browser',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-route-unit-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const plan=r.policy('http://127.0.0.1:7890');
 assert.equal(r.status(root,plan,false).state,'next_launch');assert.throws(()=>r.assertCurrent(root,plan,true),{code:'HUB_BROWSER_ROUTE_CHANGED'});
 r.record(root,plan,process.pid);assert.equal(r.status(root,plan,true).state,'applied');
 assert.throws(()=>r.assertCurrent(root,r.policy('http://127.0.0.1:8899'),true),{code:'HUB_BROWSER_ROUTE_CHANGED'});
 fs.writeFileSync(path.join(root,'browser-routing.json'),JSON.stringify({pid:2147483646,fingerprint:plan.fingerprint}));
 assert.equal(r.status(root,plan,true).state,'restart_required');
});
