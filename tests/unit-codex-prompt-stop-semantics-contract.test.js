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
  /function\s+markCodexCardWorking\s*\([\s\S]{0,1800}observeSessionRuntime\(session,[\s\S]{0,120}state:\s*runtimeState/.test(rendererSrc),
  'markCodexCardWorking must publish starting/running through RuntimeTruth',
);

// 2026-07-27：兜底回收改成先看 _agentWorking === 'card'、再核 maxAge，且只回收
// _runSource === 'semantic' 的 running（避免误伤 PTY 驱动的 running）。语义不变：
// PTY 静默不得清掉语义 running，只有完成事件或 maxAge 到期才能收回。
assert.ok(
  /function\s+hasSemanticCardWorking/.test(rendererSrc),
  'renderer must expose hasSemanticCardWorking',
);
assert.ok(
  /session\._agentWorking === 'card' && !hasSemanticCardWorking\(session\)[\s\S]{0,220}onSemanticWorkExpired/.test(activitySrc),
  'silence sweeper must gate on the card working flag plus its maxAge',
);
assert.ok(
  rendererSrc.includes("source: 'semantic-work-expired'") && rendererSrc.includes('state: RUNTIME_UNKNOWN'),
  'missing completion must degrade to unknown rather than fabricating idle',
);

assert.ok(
  rendererSrc.includes("_codexSubmitPendingTimers") &&
  rendererSrc.includes("_CODEX_CARD_SUBMIT_PENDING_MS") &&
  rendererSrc.includes("cardWorkingSource === 'floating_input'"),
  'Codex optimistic submit indicator must self-expire if rollout user_message never confirms work',
);

// 2026-09-04：原断言用「函数头到 applyReplyCompleted 之间不超过 1400 字符」当代理，
// 057c6e6 在中间插了一条 Claude 专用早退分支（Claude 的收尾走 Stop，转录只是兜底，
// 再跑一遍 reducer 会把未读记两次），距离涨到 2617 就红了 —— 但 Codex 那条路径其实
// 一直在走 reducer，不变量没破。距离本来就不是不变量，改成盯函数体本身。
const replyCompleteBody = (() => {
  const start = rendererSrc.indexOf('function onReplyCompleteFromTranscriptEvent(');
  assert.ok(start >= 0, 'onReplyCompleteFromTranscriptEvent must exist');
  const next = rendererSrc.indexOf('\nfunction ', start + 1);
  return rendererSrc.slice(start, next > 0 ? next : rendererSrc.length);
})();
assert.ok(
  /applyReplyCompleted\(session,/.test(replyCompleteBody)
  && /if \(!transition\.applied\) return;/.test(replyCompleteBody),
  'Codex task_complete must pass through the ordered session-state reducer',
);
// 唯一允许绕过 reducer 的是那条 Claude 分支，而且必须显式按运行时收口。
// 谁把它改成无条件早退，这里就会红 —— 那才是真的把 Codex 的收尾也吞掉了。
assert.ok(
  /if \(isClaudeTranscriptRuntime\) \{/.test(replyCompleteBody),
  'the only reducer bypass must stay gated on the Claude transcript runtime',
);
assert.ok(
  replyCompleteBody.indexOf('if (isClaudeTranscriptRuntime) {')
    < replyCompleteBody.indexOf('applyReplyCompleted(session,'),
  'the Claude bypass must return before the reducer, not after it',
);
assert.ok(
  rendererSrc.includes('sessionNeedsUserInput') && rendererSrc.includes('sessionHasCompletedUnread'),
  'ordinary completed-unread and real needs-input states must remain distinct',
);

console.log('codex prompt/stop semantics contract ok');
