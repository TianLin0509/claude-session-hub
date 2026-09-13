'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createBrokerConnector}=require('../main/broker-connect-singleflight');
test('a concurrent restore discovers/starts the broker once and keeps view channels independent',async()=>{
  let starts=0,existing=0,resolve;
  const ready=new Promise(r=>resolve=r),metadata={serviceId:'one'};
  const acquire=createBrokerConnector(async()=>{starts++;await ready;return {metadata};},async(_dir,meta)=>{existing++;assert.equal(meta,metadata);return {metadata};});
  const waiting=Array.from({length:30},()=>acquire({dataDir:process.cwd()}));
  resolve();const clients=await Promise.all(waiting);
  assert.equal(starts,1);assert.equal(existing,29);assert.equal(new Set(clients).size,30);
});
test('failed discovery is reported to all waiters and does not poison the next attempt',async()=>{
  let starts=0;
  const acquire=createBrokerConnector(async()=>{starts++;if(starts===1)throw Error('offline');return {metadata:{}};},async()=>({}));
  const results=await Promise.allSettled([acquire({dataDir:process.cwd()}),acquire({dataDir:process.cwd()})]);
  assert(results.every(r=>r.status==='rejected'&&r.reason.message==='offline'));
  await acquire({dataDir:process.cwd()});assert.equal(starts,2);
});
