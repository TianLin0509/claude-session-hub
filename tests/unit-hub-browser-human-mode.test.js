'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const {HubChrome}=require('../core/hub-chrome');
const guard=require('../core/web-risk-guard');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-human-mode-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const hub=new HubChrome({root,env:{}});hub.lifecycle=fn=>fn();hub.assertAvailable=()=>{};return hub;}
test('opening an account website from an idle automated Chrome uses ordinary Chrome',async t=>{
 const hub=fixture(t),calls=[];hub.endpoint=async()=>({port:1});hub.workTabs=async()=>0;
 hub._openVisible=async()=>{throw Error('The account website must use ordinary Chrome');};
 hub._openOrdinary=async(identity,url)=>{calls.push({identity,url});return{identity,mode:'ordinary'};};
 const result=await hub.openWebsite('main','claude');
 assert.equal(result.mode,'ordinary');assert.deepEqual(calls,[{identity:'main',url:'https://claude.ai/'}]);
});
test('a website or draft prevents an ordinary switch without closing or resetting anything',async t=>{
 const hub=fixture(t);hub.endpoint=async()=>({port:1});hub.workTabs=async()=>1;
 hub.close=async()=>assert.fail('Must preserve the existing page');
 hub.launch=async()=>assert.fail('Must not launch while busy');
 hub.browser=async()=>assert.fail('Must not reset cookies while busy');
 await assert.rejects(hub.openWebsite('main','claude'),{code:'HUB_BROWSER_BUSY'});
 await assert.rejects(guard.openForHuman(hub,{identity:'main',url:'https://claude.ai/'}),{code:'HUB_BROWSER_BUSY'});
 assert.equal(guard.handoff(hub.root),null);
});
test('ordinary handoff survives expiry while the profile is held and releases only on close',async t=>{
 const hub=fixture(t);guard.recordChallenge(hub.root,{identity:'main',site:'claude'});
 const lease=guard.startHandoff(hub.root,{identity:'main',site:'claude',now:Date.now()-3600000});
 const state=guard.read(hub.root);state.handoff.mode='ordinary';fs.writeFileSync(path.join(hub.root,'web-risk.json'),JSON.stringify(state));
 hub.endpoint=async()=>null;hub.profileHeld=()=>true;
 assert.equal((await guard.settleHandoff(hub)).id,lease.id);
 assert.ok(guard.blocked(hub.root,'main','claude'));
 hub.profileHeld=()=>false;assert.equal(await guard.settleHandoff(hub),null);
 assert.equal(guard.read(hub.root).handoff,null);assert.equal(guard.blocked(hub.root,'main','claude'),null);
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
