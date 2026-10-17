'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const zlib=require('node:zlib');
const {buildCommand}=require('../core/cloud/transport');

test('maintenance revalidates paths, age, identity and locks; compression preserves bytes',{skip:process.platform!=='win32'},t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-cloud-files-'));
  const temp=path.join(root,'temp'),logs=path.join(root,'logs'),outside=path.join(root,'business');
  for(const dir of [temp,logs,outside])fs.mkdirSync(dir);
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const old=new Date(Date.now()-10*86400000),files={};
  const write=(dir,name,value,age=true)=>{const f=path.join(dir,name);fs.writeFileSync(f,value);if(age)fs.utimesSync(f,old,old);return f;};
  files.temp=write(temp,'stale.tmp','disposable');files.recent=write(temp,'recent.tmp','recent',false);files.business=write(temp,'business.db','business');files.active=write(logs,'app.log','active');files.archive=write(logs,'app.log.1','repeated historical log\n'.repeat(1000));files.already=write(logs,'already.log.2','history');write(logs,'already.log.2.gz','existing backup');
  const policy={tempRoots:[temp],logRoots:[logs],maxFiles:50,maxFileBytes:10485760,minAgeDays:7};
  const call=(operation,items)=>JSON.parse(execFileSync('powershell',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',buildCommand({operation,items,policy})],{encoding:'utf8',windowsHide:true,timeout:20000,maxBuffer:1024*1024}).replace(/^\uFEFF/,''));
  let plan=call('plan');assert.equal(plan.items.length,3);assert.ok(plan.items.every(i=>[files.temp,files.archive,files.already].includes(i.path)));
  const forged={...plan.items[0],path:write(outside,'outside.tmp','keep')};
  assert.equal(call('execute',[forged]).results[0].status,'failed');assert.equal(fs.readFileSync(forged.path,'utf8'),'keep');
  const candidate=plan.items.find(i=>i.group==='temp');fs.appendFileSync(candidate.path,'changed');
  fs.utimesSync(candidate.path,old,old);
  assert.equal(call('execute',[candidate]).results[0].message,'file_changed');assert.ok(fs.existsSync(candidate.path));
  fs.utimesSync(candidate.path,old,old);plan=call('plan');
  const original=fs.readFileSync(files.archive);const executed=call('execute',plan.items);
  assert.equal(executed.results.filter(i=>i.status==='done').length,2,JSON.stringify(executed));
  assert.ok(!fs.existsSync(files.temp));assert.ok(!fs.existsSync(files.archive));assert.deepEqual(zlib.gunzipSync(fs.readFileSync(files.archive+'.gz')),original);
  for(const key of ['recent','business','active','already'])assert.ok(fs.existsSync(files[key]),key);
  const conflict=executed.results.find(r=>r.id===plan.items.find(i=>i.path===files.already).id);assert.equal(conflict.message,'archive_conflict');assert.equal(conflict.status,'failed');
  assert.ok(call('execute',plan.items.filter(i=>i.path!==files.already)).results.every(r=>r.status==='skipped'));
  assert.ok(call('plan').items.some(i=>i.path===files.already),'conflicting archives stay visible for review');

  // A previous archive succeeded but source deletion failed: retry must recover.
  const recovery=write(logs,'recover.log.3','recoverable history\n'.repeat(500));
  fs.chmodSync(recovery,0o444);t.after(()=>{if(fs.existsSync(recovery))fs.chmodSync(recovery,0o666);});
  const recoveryItem=call('plan').items.find(i=>i.path===recovery);
  const partial=call('execute',[recoveryItem]).results[0];assert.equal(partial.status,'failed');
  assert.ok(fs.existsSync(recovery));assert.ok(fs.existsSync(recovery+'.gz'));
  fs.chmodSync(recovery,0o666);
  assert.ok(call('plan').items.some(i=>i.path===recovery));
  const recovered=call('execute',[recoveryItem]).results[0];assert.equal(recovered.status,'done');assert.equal(recovered.releasedBytes,recoveryItem.bytes);assert.ok(!fs.existsSync(recovery));

  const linked=write(temp,'linked.tmp','business hard link');fs.linkSync(linked,path.join(outside,'protected.txt'));
  const linkedItem=call('plan').items.find(i=>i.path===linked);
  assert.equal(call('execute',[linkedItem]).results[0].message,'linked_path');assert.ok(fs.existsSync(linked));
  const locked=write(temp,'locked.tmp','held by a running service');const lockedItem=call('plan').items.find(i=>i.path===locked);
  const lockPath=Buffer.from(locked,'utf8').toString('base64');const request=Buffer.from(JSON.stringify({operation:'execute',items:[lockedItem],policy})).toString('base64');
  const source=Buffer.from(path.resolve(__dirname,'../core/cloud/remote.ps1')).toString('base64');
  const wrapper=`$ProgressPreference='SilentlyContinue';$f=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${lockPath}'));$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${source}'));$hold=[IO.File]::Open($f,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);try{& ([scriptblock]::Create([IO.File]::ReadAllText($source,[Text.Encoding]::UTF8))) '${request}'}finally{$hold.Dispose()}`;
  const lockResult=JSON.parse(execFileSync('powershell',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(wrapper,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:20000}));
  assert.equal(lockResult.results[0].status,'failed');assert.equal(fs.readFileSync(locked,'utf8'),'held by a running service');
});
