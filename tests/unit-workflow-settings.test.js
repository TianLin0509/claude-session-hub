'use strict';
const assert = require('node:assert/strict');
const S = require('../core/workflow-settings');
const F = require('../core/dev-file-workflow');
const people = ['a','b','c','d'].map((memberId,i)=>({memberId,title:`成员 ${i+1}`}));
for (const preset of S.PRESETS) {
  const d=S.createPreset(preset.id,people); S.validate(d,people.map(m=>m.memberId));
  assert.equal(d.rounds.length,3);
  const c=S.toConfig({fileFlow:{executedRounds:4,budgetStart:0},unknown:'preserve'},d,people.map(m=>m.memberId));
  assert.equal(c.executionLimit,6);assert.equal(c.unknown,'preserve');
  assert.deepEqual(S.fromConfig(c,people).rounds,d.rounds);
  if(d.kind==='file') {
    assert.equal(c.fileFlow.executedRounds,4);
    const m={groupChat:true,serialWorkflow:c};
    assert(F.enabled(m),'file workflow works outside legacy dev scene');
    const p=F.phasePrompt(m,'task-directory',F.spec('build',2));
    assert(p.includes(d.rounds[1].prompt));assert(p.includes('需返工-合并手册-轮次1.md'));assert(p.includes('已完成-实现手册-轮次2.md'));
  }
}
const d=S.createPreset('custom',people);assert.throws(()=>S.validate(d,['a']),/prompt/);
d.rounds[0].prompt='test';d.rounds[0].members=['a','b','c','d'];assert.throws(()=>S.validate(d,['a','b','c','d']),/1–3/);
d.rounds[0].members=['missing'];assert.throws(()=>S.validate(d,['a']),/已移除/);
d.rounds[0].members=['a'];d.rounds=Array.from({length:7},()=>structuredClone(d.rounds[0]));assert.throws(()=>S.validate(d,['a']),/1–6/);
const dev=S.createPreset('development',people);dev.rounds[2].members=['a'];assert.throws(()=>S.validate(dev,['a','b']),/独立评审/);
const legacy={steps:[['a'],['b']],stepConfigs:[{name:'旧步骤',prompt:'保留中文 prompt',timeoutMs:123000}],loop:{enabled:true},fileFlow:{executedRounds:3}};
assert.equal(S.fromConfig(legacy,people).rounds[0].timeoutMs,123000);
assert.equal(S.fromConfig(legacy,people).rounds[0].prompt,'保留中文 prompt');
console.log('workflow settings: templates, full file prompt, metadata preservation, limits and legacy conversion passed');
