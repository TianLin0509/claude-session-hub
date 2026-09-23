'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createJunctionFixture,createJunctionFixtureSync}=require('./helpers/junction-fixture');
test('fixture junction retries transient creation errors but still creates a real link',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'junction-fixture-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=path.join(root,'source'),target=path.join(root,'link');fs.mkdirSync(source);let calls=0;
  await createJunctionFixture(source,target,{symlink:async(...args)=>{if(++calls===1)throw Object.assign(Error('busy'),{code:'EBUSY'});return fs.promises.symlink(...args);}});
  assert.ok(calls>=2);assert.equal(fs.realpathSync(target),fs.realpathSync(source));fs.unlinkSync(target);
});
test('permanent fixture failure remains a failure; non-transient errors are not retried',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'junction-errors-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const target=path.join(root,'link');let calls=0,waits=0;
  const denied=Object.assign(Error('busy'),{code:'EBUSY'});
  await assert.rejects(createJunctionFixture(root,target,{symlink:async()=>{calls++;throw denied;},wait:async()=>{waits++;}}),e=>e===denied);
  assert.equal(calls,6);assert.equal(waits,5);
  const io=Object.assign(Error('disk failure'),{code:'EIO'});calls=0;
  await assert.rejects(createJunctionFixture(root,target,{symlink:async()=>{calls++;throw io;},wait:async()=>assert.fail()}),e=>e===io);
  assert.equal(calls,1);
  fs.mkdirSync(target);calls=0;
  await assert.rejects(createJunctionFixture(root,target,{symlink:async()=>{calls++;throw denied;},wait:async()=>assert.fail()}),e=>e===denied);
  assert.equal(calls,1);assert.equal(fs.statSync(target).isDirectory(),true);
});

test('synchronous fixtures retain bounded retries and never replace an existing entry',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'junction-sync-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=path.join(root,'source'),target=path.join(root,'link');fs.mkdirSync(source);
  const busy=Object.assign(Error('busy'),{code:'EBUSY'});let calls=0,waits=0;
  createJunctionFixtureSync(source,target,{symlink:(...args)=>{if(++calls===1)throw busy;return fs.symlinkSync(...args);}});
  assert.ok(calls>=2);assert.equal(fs.realpathSync(target),fs.realpathSync(source));fs.unlinkSync(target);
  calls=0;
  assert.throws(()=>createJunctionFixtureSync(source,target,{symlink:()=>{calls++;throw busy;},wait:()=>waits++}),e=>e===busy);
  assert.equal(calls,6);assert.equal(waits,5);
  fs.mkdirSync(target);calls=0;
  assert.throws(()=>createJunctionFixtureSync(source,target,{symlink:()=>{calls++;throw busy;},wait:()=>assert.fail()}),e=>e===busy);
  assert.equal(calls,1);assert.ok(fs.statSync(target).isDirectory());
});
