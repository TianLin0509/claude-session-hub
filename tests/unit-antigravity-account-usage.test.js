'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createAntigravityUsage,parseUsage}=require('../main/usage/antigravity-account-usage');
const payload=(name,data)=>({status:'SUCCESS',num_turns:0,command:{name,data}});
const sample=payload('usage',{groups:[{name:'Gemini Models',buckets:[{id:'gemini-weekly',window:'weekly',remaining_fraction:0.5963972806930542,reset_time:'2026-10-27T07:24:20Z'},{id:'gemini-5h',window:'5h',remaining_fraction:1}]},{name:'Claude and GPT models',buckets:[{id:'3p-weekly',window:'weekly',remaining_fraction:0.9205882549285889}]}]});
test('official usage sample preserves group windows and converts remaining to used',()=>{
  const v=parseUsage(sample,42); assert.equal(v.groups[0].id,'gemini');assert.equal(v.groups[1].id,'thirdParty');
  assert.equal(v.groups[0].usage5h.pct,0);assert.ok(Math.abs(v.usage7d.pct-40.36027193069458)<1e-8);
  assert.throws(()=>parseUsage({...sample,num_turns:1},42),/只读/);
  assert.throws(()=>parseUsage(payload('usage',{groups:[]}),42),/为空/);
});
test('zero credits, coalescing, TTL, independent failures and recovery',async()=>{
  let clock=0,calls=0,failUsage=false,failCredits=false;
  const reader=createAntigravityUsage({env:{},now:()=>clock,runImpl:async(exe,args)=>{
    calls++; const name=args.at(-1).slice(1);
    if(name==='usage'&&failUsage || name==='credits'&&failCredits) return {code:1,stdout:''};
    return {code:0,stdout:JSON.stringify(name==='usage'?sample:payload('credits',{remaining_credits:0}))};
  }});
  const [a,b]=await Promise.all([reader.refresh(),reader.refresh()]);assert.equal(a,b);assert.equal(calls,2);assert.equal(a.credits,0);
  await reader.refresh(); assert.equal(calls,2);
  clock=300001;failCredits=true;const partial=await reader.refresh();assert.equal(partial.credits,0);assert.match(partial.creditsError,/未刷新/);
  clock++;failUsage=true;failCredits=false;const failed=await reader.refresh(true);assert.match(failed.error,/查询失败/);assert.equal(failed.observedAt,300001);assert.equal(failed.creditsObservedAt,clock);assert.equal(failed.creditsError,undefined);
  clock++;failUsage=false;const recovered=await reader.refresh(true);assert.equal(recovered.error,undefined);assert.equal(recovered.observedAt,clock);
});
test('isolated Hub never queries the real account without an explicit fixture',async()=>{
  let called=false;const r=createAntigravityUsage({env:{CLAUDE_HUB_HOME_DIR:'isolated'},runImpl:async()=>{called=true;}});
  await assert.rejects(r.refresh(),/隔离/);assert.equal(called,false);
});
