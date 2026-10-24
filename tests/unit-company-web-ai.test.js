'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {CompanyWebAi,bridgeRoot}=require('../core/company-web-ai');
(async()=>{
 const catalog=[{url:'https://team.test/weekly/'}],root=fs.mkdtempSync(path.join(os.tmpdir(),'web-ai-'));
 const bridge='https://team.test/weekly/api/hub-ai';
 assert.equal(bridgeRoot('https://team.test/weekly/api/polish',catalog),bridge);
 for(const url of ['https://evil.test/weekly/','https://user@team.test/weekly/','http://team.test/weekly/','https://team.test/untrusted/'])assert.equal(bridgeRoot(url,catalog),null);
 const calls=[],events=[];let before,headers,ran=0;
 const worker=new CompanyWebAi({dataDir:root,catalog,onChanged:e=>events.push(e),run:async request=>{ran++;assert.equal(request.text,'material');return {text:'result'};},
 fetch:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>url.endsWith('/claim')?{job:{id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',receipt:'b'.repeat(64),system:'instruction',text:'material'}}:{ok:true}};}});
 try{
  worker.attach({webRequest:{onBeforeSendHeaders:fn=>before=fn,onHeadersReceived:fn=>headers=fn}});
  before({url:'https://evil.test/weekly/',requestHeaders:{'x-hub-ai-client':'leak'}},r=>assert.deepEqual(r.requestHeaders,{}));
  before({url:'https://team.test/weekly/',requestHeaders:{}},r=>assert.equal(r.requestHeaders['X-Hub-AI-Client'],worker.capability));
  worker.roots.set(bridge,false);await worker.poll(bridge);worker.close();
  assert.equal(ran,1);assert.equal(calls.length,2);assert.equal(JSON.parse(calls[1].options.body).text,'result');assert.equal(calls[1].options.redirect,'error');
  assert.equal(events.at(-1).state,'done');
  console.log('PASS company web worker: scoped header, denied origins, claimed task and result receipt');
 }finally{worker.close();fs.rmSync(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
