'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const A = require('../core/group-answer-files'), D = require('../core/delivery-workflow');

test('a reconciliation shares run metadata, rechecks accepted files and refreshes next time', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-answer-reconcile-'));
  const base = D.directory(dir, 'room'), run = { id:'run-a', goal:'goal', stages:[{after:'done'}], steps:[] };
  const state = {answerFiles:{}}, applied = [];
  const orch = { state, applyAnswerFile(turn, sid, value) { applied.push({turn,sid,value}); return true; } };
  const original = fs.readFileSync;
  try {
    for (let n=1;n<=30;n++) {
      const step = { id:'step-'+n, number:n, index:0, inputHash:'input', deliveries:{} };
      run.steps.push(step); state.answerFiles[n] = {};
      for(let i=0;i<4;i++) {
        const member = 'm'+i, p = D.paths(base,run,step,member);
        fs.mkdirSync(p.dir,{recursive:true}); fs.writeFileSync(p.ready, D.header(run,step,member)+'\n结果 '+n+' '+member,'utf8');
        step.deliveries[member] = D.readDelivery(base,run,step,member);
        state.answerFiles[n][member] = {kind:'delivery',memberId:member,...p};
      }
    }
    const record = path.join(base,'run.json'); fs.writeFileSync(record,JSON.stringify(run),'utf8');
    let reads = 0;
    fs.readFileSync = function(file,...args) { if(path.resolve(String(file))===record)reads++; return original.call(this,file,...args); };
    assert.equal(A.reconcile(orch),true); assert.equal(applied.length,120);
    assert.equal(reads,1,'120 answer entries must share a single run read');
    reads=0; applied.length=0;
    assert.equal(A.reconcile(orch),false); assert.equal(reads,1);
    // Even with an unchanged card signature, accepted content is verified.
    const changed = state.answerFiles[30].m0;
    fs.writeFileSync(changed.ready,'篡改后的内容','utf8');
    assert.equal(A.reconcile(orch),false); assert.equal(applied.length,0);
    // No memoized JSON survives a pass: external acceptance is seen immediately.
    run.steps[29].deliveries.m0 = D.readDelivery(base,run,run.steps[29],'m0');
    fs.writeFileSync(record,JSON.stringify(run),'utf8');
    assert.equal(A.reconcile(orch),true); assert.equal(applied.at(-1).value.text,'篡改后的内容');
    // Archived runs also share one read and keep checking pinned deliveries.
    const archive = path.join(base,run.id,'已结束运行.json'); fs.writeFileSync(archive,JSON.stringify(run),'utf8');
    fs.writeFileSync(record,JSON.stringify({id:'run-b',steps:[]}),'utf8');
    let archivedReads=0;
    fs.readFileSync = function(file,...args) { if(path.resolve(String(file))===archive)archivedReads++; return original.call(this,file,...args); };
    assert.equal(A.reconcile(orch),false); assert.equal(archivedReads,1);
  } finally { fs.readFileSync=original; fs.rmSync(dir,{recursive:true,force:true}); }
});
