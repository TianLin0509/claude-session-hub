'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const B=require('../core/orchestration/budget-intent');
test('explicit natural language recognizes Arabic and Chinese limits with time units',()=>{
  for(const [text,rounds] of [['允许10轮以内迭代',10],['最多十轮',10],['迭代不超过二十轮',20],['只做一轮',1]])assert.equal(B.extract(text).roundCap,rounds);
  assert.equal(B.extract('运行时间最多半小时').timeCapMin,30);
  assert.equal(B.extract('最多两小时').timeCapMin,120);
  assert.equal(B.extract('总时间30分钟').timeCapMin,30);
  assert.equal(B.extract('原来允许8轮，现在允许10轮以内迭代').roundCap,10);
});
test('task data and unspecified dimensions never invent budget changes',()=>{
  assert.equal(B.extract('生成10轮比赛的赛程表'),null);
  const ledger={budget:{roundCap:8,timeCapMs:180*60000}};
  assert.deepEqual(B.forPlan(ledger),{roundCap:8,timeCapMin:180});
  ledger.budgetIntent=B.extract('允许10轮以内迭代');
  assert.equal(B.forPlan(ledger).timeCapMin,180);
  assert.equal(B.forPlan(ledger).roundCap,10);
});
test('model interpretation must quote an actual user budget and respect the latest explicit value',()=>{
  const ledger={budget:{roundCap:8,timeCapMs:180*60000},userMessages:['输入10条数据','最多五轮','最多十轮'],budgetIntent:B.extract('最多十轮')};
  assert.throws(()=>B.forPlan(ledger,{roundCap:12,sourceQuote:'最多十二轮'}),/原话/);
  assert.throws(()=>B.forPlan({...ledger,budgetIntent:null},{roundCap:10,sourceQuote:'输入10条数据'}),/相应额度/);
  assert.throws(()=>B.forPlan(ledger,{roundCap:5,sourceQuote:'最多五轮'}),/最近/);
  assert.equal(B.forPlan(ledger,{roundCap:10,sourceQuote:'最多十轮'}).roundCap,10);
});
test('unsupported limits are explicit errors rather than silently clamped',()=>{
  assert.throws(()=>B.extract('允许40轮以内迭代'),/不会静默截断/);
  assert.throws(()=>B.validate({roundCap:1.5}),/整数轮/);
});
