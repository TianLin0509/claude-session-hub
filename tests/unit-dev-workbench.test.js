'use strict';
const assert = require('node:assert/strict');
const DP = require('../renderer/dev-progress');

// A historical PASS must not hide a new active or failed run on the same group.
assert.equal(DP.deriveStage({serialWorkflow:{loopState:{status:'running',currentStep:'builder',history:[{pass:true}]}}}).key, 'working');
assert.equal(DP.deriveStage({serialWorkflow:{loopState:{status:'paused',history:[{pass:true}]}}}).key, 'paused');
const Feed = require('../core/dev-workbench-feed');
const a=(id,content,extra={})=>({id,role:'assistant',content,turnNum:1,sid:'s1',speaker:'工作席',createdAt:100,...extra});
let summary=Feed.summarizeGroupState({messages:[
  {role:'user',content:'PROGRESS: 不能当成 Agent 进展'},
  a('a1','PROGRESS: 完成第一版\nVERIFIED: 12 项通过\nRISK: 无\nREPORT: C:\\demo\\验收.html'),
  a('a2','UPDATE: 正在检查旧配置兼容性',{createdAt:200}),
]});
assert.equal(summary.card.progress,'完成第一版');
assert.equal(summary.update.text,'正在检查旧配置兼容性');
assert.equal(summary.update.messageId,'a2');
assert.equal(summary.review,null);
assert.equal(Feed.summarizeGroupState({messages:[a('a','UPDATE: 继续实现')]}).card,null,'process update is not a final handoff');
summary=Feed.summarizeGroupState({messages:[null,42,{role:'tool',content:'PROGRESS: 工具输出'},a('a','```text\nRESULT: PASS\n```\n> PROGRESS: 引用\nUPDATE: 真正的进展')]});
assert.equal(summary.card,null);assert.equal(summary.review,null);assert.equal(summary.update.text,'真正的进展');
summary=Feed.summarizeGroupState({messages:[a('a','UPDATE: 早期\nUPDATE: 最新\nPROGRESS: 已完成\nVERIFIED: 2 项\nRESULT: FAIL\nBLOCKERS: 窄屏溢出\nREPORT: C:\\demo.html')]});
assert.equal(summary.update.text,'最新');assert.equal(summary.review.blockers,'窄屏溢出');
assert.equal(summary.review.report,'C:\\demo.html');
assert.equal(Feed.summarizeGroupState({messages:'bad'}).card,null);
console.log('dev-workbench feed and state regressions: PASS');
