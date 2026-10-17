'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const zlib=require('node:zlib');
const {EventEmitter}=require('node:events');
const {createTransport}=require('../core/cloud/transport');
function fixture(t){const home=fs.mkdtempSync(path.join(os.tmpdir(),'hub-cloud-ssh-'));fs.mkdirSync(path.join(home,'.ssh'));fs.writeFileSync(path.join(home,'.ssh/codex_aliyun'),'fixture only');t.after(()=>fs.rmSync(home,{recursive:true,force:true}));return home;}
test('SSH uses a bounded fixed command and carries the collector over stdin',async t=>{
  const home=fixture(t);let observed;
  const request=createTransport({home,run:(exe,args,options,callback)=>{observed={exe,args,options};const stdin=new EventEmitter();stdin.end=payload=>{observed.source=zlib.gunzipSync(Buffer.from(payload,'base64')).toString('utf8');queueMicrotask(()=>callback(null,'{"items":[],"warnings":[]}',''));};return {stdin};}});
  assert.deepEqual(await request('plan'),{items:[],warnings:[]});assert.equal(observed.exe,'ssh');assert.ok(observed.args.join(' ').length<2000);assert.ok(observed.args.includes('StrictHostKeyChecking=yes'));assert.match(observed.source,/function Get-Plan/);assert.equal(observed.options.windowsHide,true);
});
test('SSH failure does not expose command text, credentials or raw stderr',async t=>{
  const home=fixture(t);
  const request=createTransport({home,run:(_exe,_args,_options,callback)=>{const stdin=new EventEmitter();stdin.end=()=>queueMicrotask(()=>callback(new Error('secret command'),'','Permission denied: private-sensitive-text'));return {stdin};}});
  await assert.rejects(request('metrics'),e=>e.message==='ssh_auth_failed');
});
