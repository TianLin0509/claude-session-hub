'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const room = fs.readFileSync(path.join(root, 'renderer', 'meeting-room.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const loopEngine = fs.readFileSync(path.join(root, 'main', 'groupchat', 'loop-engine.js'), 'utf8');
const modal = fs.readFileSync(path.join(root, 'renderer', 'workflow-config-modal.js'), 'utf8');

assert(index.includes('<script src="workflow-templates.js"></script>'), 'workflow template module must load in renderer');
assert(index.indexOf('workflow-templates.js') < index.indexOf('meeting-room.js'), 'template module must load before meeting-room runtime');
assert(modal.includes('data-wf="task-preset"'), 'serial workflow modal must expose task preset buttons');
assert(modal.includes("action === 'task-preset'"), 'task preset buttons must populate the editable serial workflow');
assert(room.includes('workflowApi.buildSerialStepPrompt(userInput, stepConfigs[i], i, steps.length)'), 'serial runtime must build per-step prompts');
assert(room.includes('userInput: stepInput'), 'serial dispatcher must receive the per-step prompt');
assert(room.includes("ipcRenderer.invoke('meeting-append-user-turn', { meetingId: m.id, text: finalText })"), 'loop path must persist the original user goal before internal prompts');
assert(loopEngine.includes("state.status = 'paused'"), 'loop failures must enter paused instead of leaving running');
assert(loopEngine.includes('builderRolePrompt') && loopEngine.includes('reviewerRolePrompt'), 'loop runtime must inject editable role prompts');

console.log('workflow v2 runtime contract ok');
