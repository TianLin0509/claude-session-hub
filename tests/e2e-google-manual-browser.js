'use strict';
// Real Chrome and persistent profile; all site content is localhost fixture data.
const fs=require('fs'),os=require('os'),path=require('path'),http=require('http'),assert=require('assert/strict');
const {spawn,execFile}=require('child_process');
const {AccountBrowser,SITES}=require('../core/account-browser');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-manual-google-e2e-')),out=path.resolve('artifacts/google-manual-login');fs.mkdirSync(out,{recursive:true});
 const proof={root,passed:false,boundary:'Real normal Chrome -> same profile headless read-only check, localhost login fixture only; no Google credentials or sign-in attempts'};
 let child,closed=false;const receipts=[];
 const server=http.createServer((req,res)=>{
  if(req.url==='/receipt'){let text='';req.on('data',c=>text+=c);req.on('end',()=>{receipts.push(JSON.parse(text));res.end('ok');});return;}
  const remembered=/hub_manual_fixture=remembered/.test(req.headers.cookie||'');
  res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Set-Cookie','hub_manual_fixture=remembered; Max-Age=3600; SameSite=Lax');
  res.end('<!doctype html><meta charset="utf-8"><title>Hub isolated manual login fixture</title>'+(remembered?'<button data-testid="accounts-profile-button">Fixture account</button>':'<p>Isolated first login fixture</p>')+'<script>fetch("/receipt",{method:"POST",body:JSON.stringify({webdriver:navigator.webdriver,remembered:'+remembered+'})})</script>');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const oldSite=SITES.gemini;SITES.gemini='http://127.0.0.1:'+server.address().port+'/';
 const browser=new AccountBrowser({dataDir:root,spawnImpl:(exe,args,opts)=>{child=spawn(exe,[...args,'--window-position=-2500,-2500'],opts);proof.args=args;proof.pid=child.pid;return child;}});
 async function closeTestWindow(){
  if(closed||!child||child.exitCode!==null)return;
  const owners=await browser.profileOwners('gemini');assert.ok(owners.some(x=>x.pid===child.pid&&!x.automated),'only close the exact normal Chrome PID created by this test');
  const script=`$ErrorActionPreference='Stop'; $testBrowser=Get-Process -Id ${child.pid}; if(!$testBrowser.CloseMainWindow()){throw 'Cannot close isolated fixture window'}; if(!$testBrowser.WaitForExit(10000)){throw 'Isolated browser did not exit'}`;
  await new Promise((resolve,reject)=>execFile('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:15000},e=>e?reject(e):resolve()));closed=true;
 }
 try{
  await browser.open('gemini');for(const end=Date.now()+20000;Date.now()<end&&!receipts.length;)await wait(100);
  assert.equal(receipts[0]?.webdriver,false,'human login window must not advertise automation');
  assert.equal(fs.existsSync(path.join(browser.profile('gemini'),'DevToolsActivePort')),false);
  assert.equal((await browser.check('gemini')).state,'unknown','do not attach while user is signing in');
  await closeTestWindow();assert.equal((await browser.check('gemini')).state,'signed_in');
  assert.ok(receipts.some(x=>x.webdriver===true&&x.remembered),'read-only check must reuse the real persistent cookie');
  proof.receipts=receipts;proof.passed=true;console.log('PASS: ordinary Chrome webdriver=false, no CDP; no takeover while open; persistent cookie reused by closed-window read-only check');
 }finally{
  try{await closeTestWindow();}finally{SITES.gemini=oldSite;await new Promise(r=>server.close(r));fs.writeFileSync(path.join(out,'browser-verification.json'),JSON.stringify(proof,null,2),'utf8');}
 }
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
