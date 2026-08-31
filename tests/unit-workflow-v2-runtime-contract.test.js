'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const room = fs.readFileSync(path.join(root, 'renderer', 'meeting-room.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const loopEngine = fs.readFileSync(path.join(root, 'main', 'groupchat', 'loop-engine.js'), 'utf8');
const loopHandlers = fs.readFileSync(path.join(root, 'main', 'ipc', 'loop-handlers.js'), 'utf8');
const modal = fs.readFileSync(path.join(root, 'renderer', 'workflow-config-modal.js'), 'utf8');

assert(index.includes('<script src="workflow-templates.js"></script>'), 'workflow template module must load in renderer');
assert(index.indexOf('workflow-templates.js') < index.indexOf('meeting-room.js'), 'template module must load before meeting-room runtime');
assert(modal.includes('data-wf="task-preset"'), 'serial workflow modal must expose task preset buttons');
assert(modal.includes("action === 'task-preset'"), 'task preset buttons must populate the editable serial workflow');
assert(loopEngine.includes('WT.buildSerialStepPrompt(state.goal, stepConfigs[index], index, steps.length)'), 'main-process serial runtime must build per-step prompts');
assert(loopEngine.includes("dispatchMode: 'serial'") && loopEngine.includes('workflowRun:'), 'serial dispatcher must receive checkpoint identity and per-step prompt');
assert(room.includes("ipcRenderer.invoke('serial:start'") && room.includes("ipcRenderer.invoke('meeting-append-user-turn'"), 'renderer must persist the original goal then delegate serial execution to main');
assert(!room.includes(['async function run', 'LoopWorkflow('].join('')), 'renderer must not retain a second loop state-machine driver');
assert(loopEngine.includes("state.status = 'paused'"), 'loop failures must enter paused instead of leaving running');
assert(loopEngine.includes('builderRolePrompt') && loopEngine.includes('reviewerRolePrompt'), 'loop runtime must inject editable role prompts');
for (const channel of ['loop:resume', 'serial:start', 'serial:resume', 'workflow:stop', 'workflow:status']) {
  assert(loopHandlers.includes(`'${channel}'`), `workflow IPC missing: ${channel}`);
}
assert(loopEngine.includes('serialRunState') && loopEngine.includes('workflowSteps'), 'serial checkpoints and exactly-once evidence must both be durable');

console.log('workflow v2 runtime contract ok');
