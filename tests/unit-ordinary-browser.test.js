'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path'),{EventEmitter}=require('events');
const {OrdinarySession,EXTENSION_ID,readToken}=require('../core/ordinary-browser-session');
const client=require('../core/ordinary-browser-client');
function fixture(t,{human=false}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ordinary-browser-unit-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const calls=[];let clock=0,lease=null;
  class Page extends EventEmitter{constructor(url='about:blank'){super();this.location=url;this.closed=false;this.probe={challenge:false};this.keyboard={insertText:async value=>calls.push(['input',value]),down:async value=>calls.push(['down',value]),up:async value=>calls.push(['up',value])};}url(){return this.location;}isClosed(){return this.closed;}async goto(url){calls.push(['goto',url]);this.location=url;}async close(){calls.push(['close',this.location]);this.closed=true;}async evaluate(){return this.probe;}}
  const pages=[new Page(human?'https://chatgpt.com/c/existing-persons-chat':`chrome-extension://${EXTENSION_ID}/connect.html`)];
  const context={pages:()=>pages,newPage:async()=>{const p=new Page();pages.push(p);return p;}};
  class Browser extends EventEmitter{constructor(){super();this.connected=true;}isConnected(){return this.connected;}contexts(){return [context];}async close(){this.connected=false;calls.push(['detach']);this.emit('disconnected');}}
  const browser=new Browser(),options={identity:'main',browserRoot:root,playwright:path.join(root,'playwright.js'),tokenFile:path.join(root,'pairing.json')};
  const risk={CHALLENGE_PROBE:'probe',siteOf:url=>url.startsWith('https://chatgpt.com')?'chatgpt':url.startsWith('https://www.kimi.com')?'kimi':null,
    assertAutomationAllowed:(root,opts)=>{calls.push(['guard',opts]);if(lease)throw Error('Human handoff');},handoff:()=>lease,
    recordChallenge:()=>calls.push(['challenge']),releaseSite:()=>calls.push(['release']),endHandoff:()=>{lease=null;}};
  const session=new OrdinarySession(options,{token:()=> 'fake-pairing-token-unit',launch:async()=>calls.push(['ordinary-open']),factory:async cfg=>{calls.push(['factory',cfg]);return {browser};},risk,settleMs:1000,now:()=>clock,wait:async ms=>{clock+=ms;}});
  return {session,browser,pages,calls,root,options,lease:value=>{lease=value;}};
}
test('ordinary broker shares one connection but owns separate pages for separate MCPs',async t=>{
  const f=fixture(t);await Promise.all([f.session.execute('images-primary',['open']),f.session.execute('roundtable-kimi',['open']),f.session.execute('company-bridge',['open'])]);
  assert.equal(f.calls.filter(c=>c[0]==='factory').length,1);assert.equal(f.pages.length,4);
  assert.notEqual(await f.session.page('images-primary'),await f.session.page('roundtable-kimi'));
  assert.equal(JSON.stringify(f.calls).includes('remote-debugging-port'),false);
});
test('existing human page is refused and never closed or navigated',async t=>{
  const f=fixture(t,{human:true});await assert.rejects(f.session.execute('images-primary',['open']),/ownership/);assert.equal(f.pages[0].closed,false);assert.equal(f.calls.some(c=>c[0]==='goto'),false);
});
test('missing pairing does not launch or navigate any browser',async t=>{
  const f=fixture(t);f.session.token=()=>{throw Error('Extension pairing required');};await assert.rejects(f.session.execute('company-bridge',['open']),/pairing/);assert.equal(f.calls.length,1);assert.equal(f.calls[0][0],'guard');
});
test('a wrong-profile encrypted pairing is refused before decryption',t=>{
  const f=fixture(t);fs.writeFileSync(f.options.tokenFile,JSON.stringify({version:1,identity:'alt',root:f.root,protectedToken:'fake'}));assert.throws(()=>readToken(f.options),/pairing/);
});
test('bounded automatic check clears without a reload or human input',async t=>{
  const f=fixture(t);let reads=0;const page={url:()=> 'https://chatgpt.com/',evaluate:async()=>({challenge:++reads<3})};assert.equal(await f.session.inspect(page,'bridge'),false);assert.equal(reads,3);assert.equal(f.calls.length,0);
});
test('persistent verification leaves the page and detaches all owned automation',async t=>{
  const f=fixture(t);await f.session.execute('images-primary',['open']);const page=await f.session.page('images-primary');page.location='https://chatgpt.com/';page.probe={challenge:true,kind:'cloudflare'};await assert.rejects(f.session.step(page,'images-primary',async()=>{throw Error('Must not submit');}),/Site challenged/);assert.equal(page.url(),'about:blank');assert.equal(f.browser.connected,false);assert.equal(f.calls.filter(c=>c[0]==='challenge').length,1);
});
test('manual operation preserves the browser and blocks every MCP lane',async t=>{
  const f=fixture(t);await f.session.execute('company-bridge',['open']);const page=await f.session.page('company-bridge');f.lease({id:'one',identity:'main',site:'chatgpt'});await assert.rejects(f.session.execute('roundtable-kimi',['open']),/Human handoff/);assert.equal(page.closed,false);assert.equal(f.browser.connected,false);
});
test('finishing another site cannot end the person handoff',async t=>{
  const f=fixture(t);f.lease({id:'one',identity:'main',site:'kimi'});await assert.rejects(f.session.execute('images-primary',['human-done','https://chatgpt.com/']),/another site/);assert.equal(f.calls.some(c=>c[0]==='release'),false);
});
test('closing a provider page preserves other MCP pages and the ordinary Chrome',async t=>{
  const f=fixture(t);await f.session.execute('images-primary',['open']);await f.session.execute('roundtable-kimi',['open']);const image=await f.session.page('images-primary');await f.session.execute('roundtable-kimi',['close']);assert.equal(image.closed,false);assert.equal(f.browser.connected,true);assert.equal(f.pages[0].closed,false);
});
test('bridge auth save preserves old standalone snapshot without exporting cookies',async t=>{
  const f=fixture(t),file=path.join(f.root,'auth.json'),original=JSON.stringify({cookies:[{value:'unit-secret'}]});fs.writeFileSync(file,original);const out=await f.session.execute('company-bridge',['state-save',file+'.new']);assert.equal(out.exported,false);assert.equal(fs.readFileSync(file+'.new','utf8'),original);assert.equal(f.calls.length,0);
});
test('isolated and arbitrary bindings cannot discover production ordinary browser',t=>{
  const f=fixture(t);assert.equal(client.enabled({root:f.root,identity:'main'},{}),false);assert.equal(client.enabled({identity:'main'},{HUB_CHROME_ROOT:f.root}),false);
  fs.writeFileSync(path.join(f.root,'ordinary-automation.json'),JSON.stringify({version:1,transport:'extension',identities:['main']}));
  assert.equal(client.enabled({identity:'main'},{HUB_PERSONAL_CHROME_ROOT:f.root}),true);assert.equal(client.enabled({identity:'alt'},{HUB_PERSONAL_CHROME_ROOT:f.root}),false);
});
test('bridge patch prevents shared-window hiding, is idempotent, and rejects unknown code',t=>{
  const f=fixture(t);const {execFileSync}=require('child_process');
  const code='import importlib.util,sys; s=importlib.util.spec_from_file_location("p",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);source=m.SIGNATURE+"    raise AssertionError()\\n";after=m.patched(source);assert m.patched(after)==after;scope={"Any":object};exec(after,scope);assert scope["_hide_named_browser"]({"shared_browser":True}) is False\ntry:\n m.patched("unrecognized source")\nexcept ValueError:\n pass\nelse:\n raise AssertionError("unknown source accepted")\nprint("safe")';
  const output=execFileSync('python',['-X','utf8','-c',code,path.join(__dirname,'../scripts/update-bridge-shared-browser.py')],{encoding:'utf8',windowsHide:true});assert.match(output,/safe/);
});

test('DeepSeek uses one enabled visible send button; ambiguous controls never submit',async()=>{
  const providers=require('../core/web-roundtable/providers');let clicked=0;
  const button=(disabled=false)=>({disabled,getClientRects:()=>[{}],getAttribute:()=>null,click:()=>clicked++});
  let controls=[button(),button(true)];
  const page={evaluate:async code=>require('vm').runInNewContext(code,{document:{querySelectorAll:()=>controls}}),call:async()=>{throw Error('Legacy Enter must not be used');}};
  await providers.send(page,'deepseek');assert.equal(clicked,1);
  controls=[button(),button()];await assert.rejects(providers.send(page,'deepseek'),/Send button unavailable/);assert.equal(clicked,1);
});

test('account live recheck uses the shared login, visible profile evidence and only its own page',async()=>{
  const calls=[];const transport={options:b=>b,call:async(b,l,args)=>{calls.push(args);if(args[0]==='evaluate')return {host:'www.kimi.com',profile:true,login:false,challenge:false};}};
  const result=await require('../core/ordinary-browser-check').check({env:{}},'main','kimi',null,{transport});
  assert.equal(result.state,'signed_in');assert.equal(result.source,'ordinary-chrome-extension');
  assert.deepEqual(calls.map(a=>a[0]),['human-done','open','goto','evaluate','close']);
});
