'use strict';
// Real Chrome + local HTTPS origin + recording CONNECT proxy. No website or
// production profile is contacted: Chromium itself must choose the right route.
const fs=require('fs'),os=require('os'),path=require('path'),https=require('https'),http=require('http'),net=require('net'),assert=require('node:assert/strict');
const {spawn,spawnSync}=require('child_process');
const {HubChrome}=require('../core/hub-chrome');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-routing-e2e-'));
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',()=>r(s.address().port)));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{let origin,proxy,hub;const tunnels=new Set(),seen=[],results=[];
try{
 const openssl=process.env.HUB_TEST_OPENSSL||'C:/Program Files/Git/usr/bin/openssl.exe';
 const cert=path.join(root,'cert.pem'),key=path.join(root,'key.pem');
 const gen=spawnSync(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=fixture.test'],{windowsHide:true});
 assert.equal(gen.status,0,'test certificate generation');
 origin=https.createServer({key:fs.readFileSync(key),cert:fs.readFileSync(cert)},(req,res)=>{res.setHeader('content-type','text/html');res.end('<body>ROUTE_OK '+req.headers.host+'</body>');});const port=await listen(origin);
 proxy=http.createServer((req,res)=>{res.writeHead(502);res.end();});
 proxy.on('connect',(req,socket,head)=>{
  const u=new URL('https://'+req.url);if(Number(u.port)!==port){socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');return;}
  seen.push(u.hostname);const upstream=net.connect(port,'127.0.0.1',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream);upstream.pipe(socket);});
  for(const s of [socket,upstream]){tunnels.add(s);s.on('close',()=>tunnels.delete(s));s.on('error',()=>{socket.destroy();upstream.destroy();});}
 });const proxyPort=await listen(proxy);let configured='http://127.0.0.1:'+proxyPort;
 hub=new HubChrome({root:path.join(root,'profile'),proxy:()=>configured,spawnImpl:(exe,args,opts)=>spawn(exe,[...args,'--host-resolver-rules=MAP * 127.0.0.1','--ignore-certificate-errors','--disable-background-networking'],opts)});
 await hub.ensure({headless:true});assert.equal(hub.routingStatus().state,'applied');
 for(const [host,expected] of [['chatgpt.com','proxy'],['claude.ai','proxy'],['gemini.google.com','proxy'],['accounts.google.com','proxy'],['chat.deepseek.com','direct'],['www.kimi.com','direct'],['statics.moonshot.cn','direct'],['www.qianwen.com','direct'],['g.alicdn.com','direct'],['www.doubao.com','direct'],['deepseek.com.evil.test','proxy']]){
  const {targetId}=await hub.openTab('main','about:blank');const page=await hub.page(targetId);
  try{await page.call('Page.navigate',{url:'https://'+host+':'+port+'/probe'});
   let text='';for(let i=0;i<60;i++){try{text=await page.evaluate('document.body?.innerText||""');}catch{}if(text.startsWith('ROUTE_OK'))break;await sleep(50);}
   assert.ok(text.startsWith('ROUTE_OK'),host+' loaded');const actual=seen.includes(host)?'proxy':'direct';assert.equal(actual,expected,host);results.push({host,expected,actual});
  }finally{page.close();await hub.closeTab(targetId);}
 }
 configured='http://127.0.0.1:1';assert.equal(hub.routingStatus().state,'restart_required');await assert.rejects(hub.ensure(),{code:'HUB_BROWSER_ROUTE_CHANGED'});
 console.log(JSON.stringify({passed:true,boundary:'isolated real Chromium with local HTTPS and recording proxy',results,changedProxyBlocked:true},null,2));
}finally{await hub?.close();for(const s of tunnels)s.destroy();origin?.closeAllConnections();proxy?.closeAllConnections();await Promise.all([origin,proxy].filter(Boolean).map(s=>new Promise(r=>s.close(r))));/* Keep the isolated profile for evidence; no production data is touched. */}})().catch(e=>{console.error(e);process.exitCode=1;});
