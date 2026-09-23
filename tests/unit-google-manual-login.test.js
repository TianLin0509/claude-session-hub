'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{EventEmitter}=require('node:events');
const {AccountBrowser}=require('../core/account-browser');
function setup(t,owners=[]){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-google-login-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const launches=[];const browser=new AccountBrowser({dataDir:root,spawnImpl:(exe,args,options)=>{launches.push({exe,args,options});const child=new EventEmitter();child.unref=()=>{};queueMicrotask(()=>child.emit('spawn'));return child;}});
 browser.executable=()=>'/fixture/chrome';browser.profileOwners=async()=>owners;
 return {root,browser,launches};
}
test('Gemini human login launches ordinary Chrome using the same persistent profile',async t=>{
 const {browser,launches}=setup(t);browser.command=()=>assert.fail('manual login must not attach CDP');
 const result=await browser.open('gemini');assert.match(result.message,/关闭.*检查/);
 assert.equal(launches.length,1);const args=launches[0].args;
 assert.ok(args.includes('--user-data-dir='+browser.profile('gemini')));
 assert.ok(args.includes('https://gemini.google.com/app'));
 assert.ok(!args.some(a=>/remote-debugging|automation|headless|disable-blink/.test(a)));
});
test('old automated Google window must close before starting a manual window',async t=>{
 const {browser,launches}=setup(t,[{pid:123,automated:true}]);
 const result=await browser.open('gemini');assert.match(result.message,/关闭.*旧/);assert.equal(result.stage,'manual');assert.equal(launches.length,0);
});
test('manual window remains untouched during checks and cannot prove login',async t=>{
 const {browser,launches}=setup(t,[{pid:123,automated:false}]);browser.probeClosedManual=()=>assert.fail('do not probe while human is signing in');
 const result=await browser.check('gemini');assert.equal(result.state,'unknown');assert.match(result.message,/关闭/);assert.equal(launches.length,0);
});
test('fresh profile has no login proof and does not start a background login attempt',async t=>{
 const {browser}=setup(t);browser.probeClosedManual=()=>assert.fail('uninitialized profile');
 assert.equal((await browser.check('gemini')).state,'unknown');
});
test('after manual window closes, check uses only fresh website proof and explicit data directory',async t=>{
 const {browser,root}=setup(t);fs.mkdirSync(path.join(browser.profile('gemini'),'Default'),{recursive:true});let closed=0;
 browser.openProbe=async(provider,url,options)=>{assert.equal(provider,'gemini');assert.equal(options.dataDir,root);return {page:{evaluate:async()=>({host:'gemini.google.com',profile:true})},close:async()=>closed++};};
 const result=await browser.check('gemini');assert.equal(result.state,'signed_in');assert.equal(closed,1);
});
test('a Google redirect requests human sign-in and never automates the authentication form',async t=>{
 const {browser}=setup(t);fs.mkdirSync(path.join(browser.profile('gemini'),'Default'),{recursive:true});let closed=0;
 browser.openProbe=async()=>({page:{evaluate:async()=>({host:'accounts.google.com'})},close:async()=>closed++});
 assert.equal((await browser.check('gemini')).state,'login_required');assert.equal(closed,1);
});
test('browser process match is exact, quoted-path safe and rejects similarly prefixed profiles',()=>{
 const {matchesProfile}=require('../core/account-browser-processes');const profile='C:\\Test Files\\gemini';
 assert.ok(matchesProfile('chrome.exe "--user-data-dir='+profile+'" --new-window',profile));
 assert.ok(matchesProfile('chrome.exe --user-data-dir="'+profile+'"',profile));
 assert.ok(!matchesProfile('chrome.exe "--user-data-dir='+profile+'-other"',profile));
 assert.ok(!matchesProfile('chrome.exe --user-data-dir=C:\\personal',profile));
});
test('manual login respects the explicit account data root lock and reports inspection errors',async t=>{
 const {browser,root,launches}=setup(t);const store=require('../core/web-roundtable/store');
 const release=store.acquire('browser-gemini',path.join(root,'web-roundtable'));
 try{assert.match((await browser.open('gemini')).message,/正在检查/);assert.equal(launches.length,0);}finally{release();}
 browser.profileOwners=async()=>{throw Error('process inspection failed');};
 await assert.rejects(browser.open('gemini'),/inspection failed/);assert.equal(launches.length,0);
 const retry=store.acquire('browser-gemini',path.join(root,'web-roundtable'));assert.ok(retry);retry();
});
