'use strict';
const assert=require('node:assert/strict');
const Model=require('../renderer/dev-workbench-model');
const rows=[{id:'old',createdAt:100,activityAt:900},{id:'new',createdAt:300,activityAt:500},{id:'top',pinned:true,createdAt:50},{id:'bottom',bottomed:true,createdAt:1000}];
assert.deepEqual(Model.sortRows(rows).map(r=>r.id),['top','old','new','bottom']);
assert.deepEqual(Model.sortRows(rows,'created-desc').map(r=>r.id),['top','new','old','bottom']);
assert.deepEqual(Model.sortRows(rows,'updated-asc').map(r=>r.id),['top','new','old','bottom']);
assert.deepEqual(Model.sortRows([{id:'z'},{id:'a'}]).map(r=>r.id),['a','z']);
assert.equal(Model.projectKey({workspace:'C:\\AIHub\\Project\\'}),Model.projectKey({workspace:'c:/aihub/project'}));
const groups=Model.groupProjects([
  {id:'a',project:'同名项目',workspace:'C:\\a',stage:{key:'paused'},activityAt:10},
  {id:'b',project:'同名项目',workspace:'C:\\b',stage:{key:'passed'},activityAt:20},
  {id:'c',workspace:'C:/A/',stage:{key:'timeout'},activityAt:30},
  {id:'d',workspace:'C:/A/',stage:{key:'stoppedUser'},activityAt:5},
]);
assert.equal(groups.length,2,'Labels never collapse different workspaces');
assert.equal(groups[0].current.length,2,'Paused/timeout tasks remain actionable current work');
assert.equal(groups[0].history.length,1);assert.equal(groups[1].history.length,1);
const paused={goal:'验收布局',stage:{key:'paused'},flow:{currentStep:'reviewer',status:'paused'}};
assert.equal(Model.flowSteps(paused).find(s=>s.state==='current').label,'审核');
assert.equal(Model.flowSteps({...paused,review:{decision:'pass'}})[3].state,'pending','An old PASS cannot advance the current workflow');
assert.equal(Model.flowSteps({...paused,stage:{key:'passed'}})[3].state,'current');
assert(!Model.flowSteps({...paused,stage:{key:'chatting'},flow:{status:'done'}}).some(s=>s.state==='current'),'Fresh manual chat does not inherit an old completed position');
assert.equal(rows[0].id,'old','Sorting never mutates the incoming projection');
console.log('workbench rows model: PASS (14 assertions)');
