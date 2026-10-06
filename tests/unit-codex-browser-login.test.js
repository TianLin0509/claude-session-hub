'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os');
const {EventEmitter}=require('events');
const {CodexBrowserLogin,loginIdentity}=require('../core/codex-browser-login');
function setup(t,email='db@example.com') {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codex-login-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'Local State'),JSON.stringify({profile:{info_cache:{main:{user_name:'main@example.com'},alt:{user_name:'db@example.com'}}}}));
  const calls=[],completed=[];
  class Client extends EventEmitter {
    async start(){}async request(method){calls.push(method);return method==='account/login/start'?{authUrl:'https://auth.openai.com/oauth/authorize?fixture=1'}:{account:{type:'chatgpt',email}};}
    close(){calls.push('close');}async waitForExit(){}
  }
  const client=new Client(),chrome={root,lifecycle:fn=>fn(),_openOrdinary:async identity=>calls.push(identity)};
  const service=new CodexBrowserLogin({createClient:()=>client,chrome,onComplete:r=>completed.push(r)});
  t.after(()=>service.close());
  return {service,client,chrome,calls,completed,row:{id:'codex-default',home:root,profileLabel:'副账号 · DB'}};
}
test('DB authorization opens the secondary ordinary Chrome and reuses one login flight',async t=>{
  const {service,row,chrome,calls,client,completed}=setup(t);
  assert.deepEqual(loginIdentity(row,chrome),{identity:'alt',expected:'db@example.com'});
  await service.login(row,{});await service.login(row,{});
  assert.equal(calls.filter(x=>x==='alt').length,1);
  client.emit('notification',{method:'account/login/completed',params:{success:true}});
  await new Promise(r=>setImmediate(r));assert.equal(completed[0].success,true);assert.equal(service.flights.size,0);
});
test('a different returned account is logged out rather than silently bound to DB',async t=>{
  const {service,row,client,calls,completed}=setup(t,'main@example.com');await service.login(row,{});
  client.emit('notification',{method:'account/login/completed',params:{success:true}});
  await new Promise(r=>setImmediate(r));assert(calls.includes('account/logout'));assert.equal(completed[0].success,false);
});
test('existing native email chooses the matching browser even if the display label changes',t=>{
  const {row,chrome}=setup(t);assert.equal(loginIdentity({...row,profileLabel:'备用',accountLabel:'db@example.com'},chrome).identity,'alt');
});
