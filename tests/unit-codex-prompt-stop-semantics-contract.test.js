const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const tapSrc = fs.readFileSync(path.join(root, 'core', 'transcript-tap.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const rendererSrc = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const activitySrc = fs.readFileSync(path.join(root, 'renderer', 'terminal-activity-monitor.js'), 'utf8');

assert.ok(
  /eventType\s*===\s*['"]user_message['"][\s\S]{0,500}this\.emit\(['"]prompt-submitted['"]/.test(tapSrc),
  'CodexTap must emit prompt-submitted from rollout user_message events',
);

assert.ok(
  /b\.on\(['"]prompt-submitted['"],\s*\(ev\)\s*=>\s*this\.emit\(['"]prompt-submitted['"],\s*ev\)\)/.test(tapSrc),
  'TranscriptTap must forward prompt-submitted events from backend taps',
);

assert.ok(
  /transcriptTap\.on\(['"]prompt-submitted['"][\s\S]{0,450}sendToRenderer\(['"]prompt-submitted-event['"]/.test(mainSrc),
  'main.js must forward prompt-submitted to renderer',
);

assert.ok(
  /ipcRenderer\.on\(['"]prompt-submitted-event['"][\s\S]{0,120}onPromptSubmittedFromTranscriptEvent/.test(rendererSrc),
  'renderer must listen for prompt-submitted-event',
);

const promptStart = rendererSrc.indexOf('function onPromptSubmittedFromTranscriptEvent');
const promptEnd = rendererSrc.indexOf('\n// Hook-server health indicator', promptStart);
const promptSubmittedFn = promptStart >= 0 && promptEnd > promptStart
  ? rendererSrc.slice(promptStart, promptEnd)
  : '';
assert.ok(
  promptSubmittedFn.includes('buildPreviewFromUserMessage(text)') &&
  promptSubmittedFn.includes('markCodexCardWorking(hubSessionId'),
  'Codex prompt event must mark the session running and update sidebar preview from user text',
);
assert.ok(
  /function\s+markCodexCardWorking\s*\([\s\S]{0,800}session\.status\s*=\s*['"]running['"]/.test(rendererSrc),
  'markCodexCardWorking must set Codex session status to running',
);

assert.ok(
  /function\s+hasSemanticCardWorking/.test(rendererSrc) &&
  /if \(!hasSemanticCardWorking\(session\)\) session\.status\s*=\s*['"]idle['"]/.test(activitySrc),
  'Codex semantic working state must survive PTY silence until task_complete clears it',
);

assert.ok(
  rendererSrc.includes("_codexSubmitPendingTimers") &&
  rendererSrc.includes("_CODEX_CARD_SUBMIT_PENDING_MS") &&
  rendererSrc.includes("cardWorkingSource === 'floating_input'"),
  'Codex optimistic submit indicator must self-expire if rollout user_message never confirms work',
);

assert.ok(
  /function\s+onReplyCompleteFromTranscriptEvent\s*\([\s\S]{0,900}session\.status\s*=\s*['"]idle['"]/.test(rendererSrc),
  'Codex task_complete event must mark the session idle',
);

console.log('codex prompt/stop semantics contract ok');
