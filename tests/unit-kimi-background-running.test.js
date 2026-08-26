'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  KimiTap,
  extractOutstandingAgentCallsFromText,
} = require('../core/kimi-transcript-tap.js');

function loop(event, time) {
  return { type: 'context.append_loop_event', event, time };
}

const tap = new KimiTap({ pollMs: 1000 });
const events = [];
tap.on('background-work-changed', (event) => events.push(event));
const bound = {
  hubSessionId: 'hub-kimi-background',
  wirePath: 'C:\\fixture\\wire.jsonl',
  steps: new Map(),
  completedSteps: new Set(),
  backgroundAgentCalls: new Set(),
  turnText: '',
  streamingText: '',
};

tap._processRecord(bound, loop({
  type: 'tool.call',
  stepUuid: 'step-1',
  toolCallId: 'agent-job-1',
  name: 'Agent',
  args: { description: 'long background render' },
}, 1000));
tap._processRecord(bound, loop({
  type: 'tool.call',
  stepUuid: 'step-1',
  toolCallId: 'agent-job-1',
  name: 'Agent',
  args: { description: 'duplicate record must be ignored' },
}, 1001));
tap._processRecord(bound, loop({
  type: 'tool.call',
  stepUuid: 'step-1',
  toolCallId: 'bash-job',
  name: 'Bash',
}, 1002));
assert.deepStrictEqual(events.map((event) => [event.phase, event.jobId, event.remaining]), [
  ['started', 'agent-job-1', 1],
]);
assert.strictEqual(events[0].description, 'long background render');

tap._processRecord(bound, loop({
  type: 'tool.result',
  parentUuid: 'agent-job-1',
  result: { output: 'done' },
}, 2000));
assert.deepStrictEqual(events.map((event) => [event.phase, event.jobId, event.remaining]), [
  ['started', 'agent-job-1', 1],
  ['finished', 'agent-job-1', 0],
]);

const historical = [
  loop({ type: 'tool.call', toolCallId: 'old-done', name: 'Agent', args: { description: 'done' } }, 1),
  loop({ type: 'tool.result', toolCallId: 'old-done', result: { output: 'ok' } }, 2),
  loop({ type: 'tool.call', toolCallId: 'still-running', name: 'Agent', args: { description: 'resume me' } }, 3),
].map(JSON.stringify).join('\n');
assert.deepStrictEqual(
  extractOutstandingAgentCallsFromText(historical).map((job) => [job.jobId, job.description]),
  [['still-running', 'resume me']],
  'resume reconciliation must recover only Agent calls without a matching result',
);
tap.dispose();

const root = path.join(__dirname, '..');
const transcriptTapSource = fs.readFileSync(path.join(root, 'core', 'transcript-tap.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const rendererSource = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');

function expect(pattern, source, message) {
  assert.ok(pattern.test(source), message);
}

expect(
  /b\.on\('background-work-changed',[\s\S]{0,120}this\.emit\('background-work-changed'/,
  transcriptTapSource,
  'TranscriptTap must forward Kimi background Agent lifecycle events',
);
expect(
  /transcriptTap\.on\('background-work-changed',[\s\S]{0,600}sendToRenderer\('background-work-event'/,
  mainSource,
  'main must broadcast background work to the renderer',
);
expect(
  /ipcRenderer\.on\('background-work-event',[\s\S]{0,160}onKimiBackgroundWorkEvent/,
  rendererSource,
  'renderer must subscribe to background work events',
);
expect(
  /function onKimiBackgroundWorkEvent\(payload\)[\s\S]{0,2400}markCodexCardWorking\(hubSessionId, 'kimi_background_agent'/,
  rendererSource,
  'an Agent start must mark the Kimi session as running',
);
expect(
  /function onReplyCompleteFromTranscriptEvent\(payload\)[\s\S]{0,500}hasKimiBackgroundWork\(session\)/,
  rendererSource,
  'ordinary completion must not clear a still-running Kimi Agent',
);
expect(
  /cardWorkingSource !== 'kimi_background_agent'[\s\S]{0,600}state: RUNTIME_UNKNOWN[\s\S]{0,200}kimi-background-finished-no-turn-complete/,
  rendererSource,
  'a missing final Kimi record must degrade to bounded unknown rather than false idle',
);

console.log('unit-kimi-background-running: PASS');
