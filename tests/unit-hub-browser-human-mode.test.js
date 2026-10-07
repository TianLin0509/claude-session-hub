'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const {HubChrome}=require('../core/hub-chrome');
const guard=require('../core/web-risk-guard');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-human-mode-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const hub=new HubChrome({root,env:{}});hub.lifecycle=fn=>fn();hub.waitForCheck=async()=>{};return hub;}
test('打开 in a running Hub Chrome adds a window to it and never closes the browser',async t=>{
 const hub=fixture(t),calls=[];hub.endpoint=async()=>({port:1});hub.workTabs=async()=>1;
 hub.close=async()=>assert.fail('Tools keep their pages');
 hub._openOrdinary=async()=>assert.fail('No switch to ordinary mode for a plain visit');
 hub._openVisible=async(identity,url)=>{calls.push({identity,url});return{targetId:'T1'};};
 const result=await hub.openWebsite('main','claude');
 assert.equal(result.mode,'shared');assert.deepEqual(calls,[{identity:'main',url:'https://claude.ai/'}]);
});
test('an orphaned headless Chrome is closed instead of refusing the click',async t=>{
 const hub=fixture(t),calls=[];let running=true;
 hub.endpoint=async()=>running?{port:1,headless:true}:null;hub.workTabs=async()=>0;hub.profileHeld=()=>false;
 hub.close=async()=>{calls.push('close');running=false;};
 hub._openVisible=async()=>{calls.push('visible');return{targetId:'T'};};
 await hub.openWebsite('main','chatgpt');
 assert.deepEqual(calls,['close','visible']);
});
test('去登录/去验证 with tool pages open use a window in the running Chrome, nothing closed',async t=>{
 const hub=fixture(t),visible=[];hub.endpoint=async()=>({port:1});hub.workTabs=async()=>1;
 hub.close=async()=>assert.fail('Must preserve the existing page');
 hub.browser=async()=>{throw Error('no cookie reset in this unit');};
 hub._openVisible=async(identity,url)=>{visible.push(url);return{targetId:'T'+visible.length};};
 const login=await hub.openLogin('main',['claude']);
 assert.equal(login.mode,'shared');assert.deepEqual(visible,['https://claude.ai/']);
 const {lease}=await guard.openForHuman(hub,{identity:'main',url:'https://claude.ai/'});
 assert.equal(lease.mode,'shared');assert.equal(guard.handoff(hub.root).targetId,'T2');
});
test('ordinary handoff survives expiry while the profile is held and releases only on close',async t=>{
 const hub=fixture(t);guard.recordChallenge(hub.root,{identity:'main',site:'claude'});
 const lease=guard.startHandoff(hub.root,{identity:'main',site:'claude',now:Date.now()-3600000});
 const state=guard.read(hub.root);state.handoff.mode='ordinary';fs.writeFileSync(path.join(hub.root,'web-risk.json'),JSON.stringify(state));
 hub.endpoint=async()=>null;hub.profileHeld=()=>true;
 assert.equal((await guard.settleHandoff(hub)).id,lease.id);
 assert.ok(guard.blocked(hub.root,'main','claude'));
 hub.profileHeld=()=>false;assert.equal(await guard.settleHandoff(hub),null);
 assert.equal(guard.read(hub.root).handoff,null);
 const cool=guard.blocked(hub.root,'main','claude');
 assert.equal(cool.kind,'cooldown','after a person passed, automation waits a cool-down instead of returning at once');
 assert.ok(cool.until-Date.now()>19*60000&&cool.until-Date.now()<=20*60000);
 assert.throws(()=>guard.assertAutomationAllowed(hub.root,{identity:'main',url:'https://claude.ai/'}),e=>e.code==='HUB_COOLDOWN'&&/^Hub cooldown: .*冷静到/.test(e.message));
 assert.equal(guard.read(hub.root).sites['main:claude'].strikes,1,'Retain escalation history');
});
test('a failed ordinary launch ends its handoff',async t=>{
 const hub=fixture(t);hub.endpoint=async()=>null;
 hub._openOrdinary=async()=>{throw Error('launch failed');};
 await assert.rejects(guard.openForHuman(hub,{identity:'main',url:'https://claude.ai/',reset:false}),/launch failed/);
 assert.equal(guard.handoff(hub.root),null);
});
test('a starting ordinary process retains its handoff before the profile lock appears',async t=>{
 const hub=fixture(t);guard.startHandoff(hub.root,{identity:'main',site:'claude'});
 const state=guard.read(hub.root);Object.assign(state.handoff,{mode:'ordinary',browserPid:process.pid});fs.writeFileSync(path.join(hub.root,'web-risk.json'),JSON.stringify(state));
 hub.endpoint=async()=>null;hub.profileHeld=()=>false;
 assert.ok(await guard.settleHandoff(hub));assert.ok(guard.handoff(hub.root));
});

test('visits while an ordinary window is open keep the requested profile and reuse its window',async t=>{
 const hub=fixture(t),launches=[];hub.endpoint=async()=>null;hub.profileHeld=()=>true;
 hub.launch=async(identity,options)=>{launches.push({identity,options});hub.lastLaunchPid=process.pid;};
 await hub.openWebsite('main','chatgpt');await hub.openWebsite('main','claude');await hub.openWebsite('alt','chatgpt');
 assert.deepEqual(launches.map(l=>l.identity),['main','main','alt']);
 assert.ok(launches.every(l=>l.options.debug===false&&l.options.newWindow===false));
 for(const l of launches)assert.ok(!hub.launchArgs(l.identity,l.options).includes('--new-window'));
 hub.profileHeld=()=>false;hub.ensure=async()=>({port:1});
 hub._openVisible=async()=>({targetId:'T'});
 assert.equal((await hub.openWebsite('main','claude')).mode,'shared','Nothing running: the Hub Chrome starts so tools can work alongside');
});
test('a cool-down holds the tools back but a person just opens the site',async t=>{
 const hub=fixture(t),calls=[];hub.endpoint=async()=>({port:1});hub.workTabs=async()=>0;
 guard.coolSite(hub.root,'main','chatgpt');
 hub._openVisible=async(identity,url)=>{calls.push(url);return{targetId:'T'};};
 const r=await hub.openWebsite('main','chatgpt');
 assert.equal(r.mode,'shared');assert.equal(r.handoff,undefined);assert.equal(guard.handoff(hub.root),null);
});
