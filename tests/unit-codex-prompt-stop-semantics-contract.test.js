const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const tapSrc = fs.readFileSync(path.join(root, 'core', 'transcript-tap.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const rendererSrc = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const activitySrc = fs.readFileSync(path.join(root, 'renderer', 'terminal-activity-monitor.js'), 'utf8');

assert.ok(
  /codexUserMessageEventFromRecord\(obj\)[\s\S]{0,900}this\.emit\(['"]prompt-submitted['"]/.test(tapSrc),
  'CodexTap must emit prompt-submitted from normalized legacy and Codex 0.147 user-message events',
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

// 2026-07-27：兜底回收改成先看 _agentWorking === 'card'、再核 maxAge，且只回收
// _runSource === 'semantic' 的 running（避免误伤 PTY 驱动的 running）。语义不变：
// PTY 静默不得清掉语义 running，只有完成事件或 maxAge 到期才能收回。
assert.ok(
  /function\s+hasSemanticCardWorking/.test(rendererSrc),
  'renderer must expose hasSemanticCardWorking',
);
assert.ok(
  /session\._agentWorking === 'card' && !hasSemanticCardWorking\(session\)/.test(activitySrc),
  'silence sweeper must gate on the card working flag plus its maxAge',
);
assert.ok(
  /session\.status === 'running' && session\._runSource === 'semantic'[\s\S]{0,80}session\.status\s*=\s*['"]idle['"]/
    .test(activitySrc),
  'only semantic-sourced running may be reclaimed on silence; PTY-driven running must survive',
);

assert.ok(
  rendererSrc.includes("_codexSubmitPendingTimers") &&
  rendererSrc.includes("_CODEX_CARD_SUBMIT_PENDING_MS") &&
  rendererSrc.includes("cardWorkingSource === 'floating_input'"),
  'Codex optimistic submit indicator must self-expire if rollout user_message never confirms work',
);

assert.ok(
  /function\s+onReplyCompleteFromTranscriptEvent\s*\([\s\S]{0,1400}applyReplyCompleted\(session/.test(rendererSrc),
  'Codex task_complete must pass through the ordered session-state reducer',
);
assert.ok(
  rendererSrc.includes('sessionNeedsUserInput') && rendererSrc.includes('sessionHasCompletedUnread'),
  'ordinary completed-unread and real needs-input states must remain distinct',
);

console.log('codex prompt/stop semantics contract ok');
