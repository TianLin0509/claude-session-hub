'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dispatcherPath = path.join(root, 'main', 'groupchat', 'dispatcher.js');
const conductorPath = path.join(root, 'main', 'groupchat', 'committee-conductor.js');
const orchestratorPath = path.join(root, 'core', 'group-chat-orchestrator.js');
const readyDetectorPath = path.join(root, 'core', 'group-chat-cli-ready-detector.js');
const watcherPath = path.join(root, 'core', 'turn-completion-watcher.js');
const groupWatcherPath = path.join(root, 'core', 'group-chat-watcher.js');
const mainPath = path.join(root, 'main.js');
const dispatcherSrc = fs.readFileSync(dispatcherPath, 'utf8');
const conductorSrc = fs.readFileSync(conductorPath, 'utf8');
const orchestratorSrc = fs.readFileSync(orchestratorPath, 'utf8');
const readyDetectorSrc = fs.readFileSync(readyDetectorPath, 'utf8');
const watcherSrc = fs.readFileSync(watcherPath, 'utf8');
const groupWatcherSrc = fs.readFileSync(groupWatcherPath, 'utf8');
const mainSrc = fs.readFileSync(mainPath, 'utf8');
const { _parseGroupTargets } = require(dispatcherPath);

const members = [
  {
    sid: 's1',
    index: 0,
    memberId: 'm1',
    kind: 'codex',
    displayName: 'Codex',
    aliases: ['m1', 'Codex', 'codex'],
  },
  {
    sid: 's2',
    index: 1,
    memberId: 'm2',
    kind: 'gemini',
    displayName: 'Gemini',
    aliases: ['m2', 'Gemini', 'gemini'],
  },
];

assert.deepStrictEqual(
  _parseGroupTargets('@all please answer', members, [0]).targets.map(m => m.sid),
  ['s1', 's2'],
  '@all should target every active member'
);

assert.deepStrictEqual(
  _parseGroupTargets('@Gemini what do you think?', members, [0]).targets.map(m => m.sid),
  ['s2'],
  '@displayName should override selected participants'
);

assert.deepStrictEqual(
  _parseGroupTargets('regular question', members, [0]).targets.map(m => m.sid),
  ['s1'],
  'without mentions, selected participants should be used'
);

assert.ok(/createGroupChatDispatcher\(\{[\s\S]*kindLabels:\s*KIND_LABELS[\s\S]*transcriptTap[\s\S]*\}\)/.test(mainSrc),
  'main.js should initialize the dispatcher with explicit dependencies');

assert.ok(/markProcessExitForSession\(sessionId,\s*exitInfo\)/.test(mainSrc),
  'PTY process exit should still be forwarded to active groupchat watchers');

assert.ok(/getActiveWatchers:\s*groupChatDispatcher\.getActiveWatchers/.test(mainSrc),
  'recovery IPC should receive the dispatcher-owned active watcher registry');

assert.ok(/groupChatWatcher:\s*groupChatDispatcher\.getGroupChatWatcher\(\)/.test(mainSrc),
  'recovery IPC should keep using the same initialized groupchat watcher');

assert.ok(/activeWatchers\.set\(sid,\s*watcher\)/.test(dispatcherSrc) &&
  /activeWatchers\.delete\(sid\)/.test(dispatcherSrc),
  'dispatcher should own watcher lifecycle registration and cleanup');

assert.ok(/SEAT_ORDER\[member\.index\]/.test(dispatcherSrc) &&
  /seatKey:\s*committeeSeatKey/.test(dispatcherSrc),
  'committee dispatch should pass slot keys so duplicate Claude/Codex kinds keep distinct personas');

assert.ok(/buildCommitteePersona\(opts\.seatKey\s*\|\|\s*opts\.kind\)/.test(orchestratorSrc),
  'committee prompt should prefer slot persona over model kind');

assert.ok(/AUTH_FAILURE_RE/.test(dispatcherSrc) &&
  /auth_required/.test(dispatcherSrc) &&
  /watcher\.markErrored/.test(dispatcherSrc),
  'dispatcher should settle unauthenticated CLI turns instead of waiting indefinitely');

assert.ok(/PASTE_TRAPPED_CODEX_ENTER_RETRIES\s*=\s*3/.test(dispatcherSrc) &&
  /writeSubmitSignal\(sessionManager,\s*sid,\s*kind,\s*monitor\.enterRetries\)/.test(dispatcherSrc),
  'Codex paste-trapped recovery should rotate submit signals instead of repeating CR only');

assert.ok(/writeSubmitFallbackSignals/.test(groupWatcherSrc) &&
  /submitTries\s*=\s*isCodexCliKind\(kind\)\s*\?\s*3\s*:\s*1/.test(groupWatcherSrc) &&
  /rewriteSettleMs\s*=\s*isCodexCliKind\(kind\)\s*\?\s*500/.test(groupWatcherSrc) &&
  /await writeSubmitFallbackSignals\(sessionManager,\s*sid,\s*kind,\s*submitTries/.test(groupWatcherSrc),
  'Codex resend should rotate CR/LF/CRLF submit signals after rewrite instead of sending a single LF');

assert.ok(/if\s*\(isCodexCliKind\(kind\)\)\s*\{[\s\S]*await writeSubmitFallbackSignals\(sessionManager,\s*sid,\s*kind,\s*ENTER_RETRY_TRIES,\s*ENTER_RETRY_GAP_MS\)/.test(groupWatcherSrc),
  'Codex first-send path should rotate CR/LF/CRLF submit signals even when prompt echo is observed');

assert.ok(/if\s*\(isClaudeFamily\(kind\)\)\s*\{[\s\S]*for\s*\(let i = 0; i < ENTER_RETRY_TRIES; i \+= 1\)[\s\S]*sessionManager\.writeToSession\(sid,\s*'\\r'\)/.test(groupWatcherSrc),
  'Claude-family bracketed-paste path should send repeated Enter signals so a swallowed first Enter does not wait for hard timeout');

assert.ok(/CODEX_PROMPT_SUBMIT_VERIFY_MS\s*=\s*25\s*\*\s*1000/.test(dispatcherSrc) &&
  /CODEX_TRANSCRIPT_BIND_GRACE_MS\s*=\s*90\s*\*\s*1000/.test(dispatcherSrc) &&
  /CODEX_PROMPT_SUBMIT_WAIT_MAX_MS\s*=\s*16\s*\*\s*60\s*\*\s*1000/.test(dispatcherSrc) &&
  /prompt-submitted/.test(dispatcherSrc) &&
  /armCodexPromptSubmitCheck/.test(dispatcherSrc) &&
  /elapsed\s*<\s*CODEX_TRANSCRIPT_BIND_GRACE_MS/.test(dispatcherSrc) &&
  /CODEX_TRANSCRIPT_BIND_GRACE_MS\s*-\s*elapsed/.test(dispatcherSrc) &&
  /boundNow\s*=\s*hasBoundCodexTranscript\(currentWaitSession\)/.test(dispatcherSrc) &&
  /promptSubmitSinceTs/.test(dispatcherSrc) &&
  /codexPromptSubmittedAt/.test(dispatcherSrc) &&
  /currentWaitSession\s*=\s*sessionManager\.getSession\(sid\)\s*\|\|\s*waitSession/.test(dispatcherSrc) &&
  /hasCodexUserMessageSince\(sid,\s*sincePromptTs\)/.test(dispatcherSrc) &&
  /retryElapsedMs\s*=\s*Date\.now\(\)\s*-\s*startTs/.test(dispatcherSrc) &&
  /Math\.round\(retryElapsedMs\s*\/\s*1000\)/.test(dispatcherSrc) &&
  /bindGrace=\$\{Math\.round\(CODEX_TRANSCRIPT_BIND_GRACE_MS\s*\/\s*1000\)\}s/.test(dispatcherSrc) &&
  /transcript not bound/.test(dispatcherSrc) &&
  /Codex prompt submission is not observed yet/.test(dispatcherSrc) &&
  /Codex transcript is not bound yet/.test(dispatcherSrc) &&
  /Codex prompt was submitted only/.test(dispatcherSrc) &&
  /groupChatWatcher\.resendCurrentPrompt/.test(dispatcherSrc) &&
  /kind:\s*t\.kind,\s*prompt:\s*t\.prompt,\s*promptSubmitSinceTs:\s*t\.promptSubmitSinceTs/.test(dispatcherSrc),
  'dispatcher should retry bound Codex prompts and start hard-timeout answer budget only after rollout user_message submission is observed');

assert.ok(/HARD_TIMEOUT_ACTIVE_GRACE_MS\s*=\s*150\s*\*\s*1000/.test(dispatcherSrc) &&
  /HARD_TIMEOUT_ACTIVE_EXTEND_MS\s*=\s*180\s*\*\s*1000/.test(dispatcherSrc) &&
  /HARD_TIMEOUT_ACTIVE_MAX_EXTRA_MS\s*=\s*8\s*\*\s*60\s*\*\s*1000/.test(dispatcherSrc) &&
  /getGroupChatLastActivity\(sid\)/.test(dispatcherSrc) &&
  /hard timeout reached[\s\S]*PTY was active[\s\S]*extending/.test(dispatcherSrc),
  'dispatcher hard timeout should extend once for recently active PTYs instead of skipping active work');

const internalDispatchSrc = dispatcherSrc.slice(
  dispatcherSrc.indexOf('async function dispatchInternalPrompt'),
  dispatcherSrc.indexOf('async function dispatchGroupChatTurn')
);
assert.ok(/dispatchInternalPrompt\(meetingId,\s*meeting,\s*targetMembers,\s*userInput,\s*turnTimeoutMs\)/.test(dispatcherSrc) &&
  /if\s*\(silent\)\s*\{[\s\S]*return await dispatchInternalPrompt/.test(dispatcherSrc) &&
  /allowActiveExtend:\s*false/.test(dispatcherSrc) &&
  /allowActiveExtend/.test(dispatcherSrc) &&
  internalDispatchSrc && !/beginTurn/.test(internalDispatchSrc) && !/rollbackTurn/.test(internalDispatchSrc),
  'silent internal dispatch should bypass visible turn state and use a strict no-extension timeout');

assert.ok(/CHECKUP_OCR_TIMEOUT_MS\s*=\s*60\s*\*\s*1000/.test(conductorSrc) &&
  /buildCheckupOcrPrompt[\s\S]*CHECKUP_OCR_TIMEOUT_MS,\s*\{[\s\S]*targetMemberIds:\s*\[seats\.chair\.memberId\][\s\S]*silent:\s*true[\s\S]*allowActiveExtend:\s*false[\s\S]*\}/.test(conductorSrc),
  'committee image OCR should use silent chair-only dispatch with a short no-extension timeout');

assert.ok(/markErrored\(reason/.test(watcherSrc),
  'turn completion watcher should expose an explicit error-settle hook');

assert.ok(/Try "edit/.test(readyDetectorSrc),
  'Claude-family ready detection should recognize the newer Try "edit footer');

assert.ok(/ROLLCALL_TIMEOUT_MS\s*=\s*4\s*\*\s*60\s*\*\s*1000/.test(conductorSrc),
  'committee rollcall should keep a bounded warmup window for non-Codex seats');

assert.ok(/rollcallKeys\s*=\s*\[\.\.\.scene\.ANALYST_KEYS\][\s\S]*seats\[k\]\.kind\s*!==\s*'codex'/.test(conductorSrc),
  'committee rollcall should not mark Codex or chair seats suspect before their long-budget turns');

assert.ok(/ROLLCALL_ENABLED\s*=\s*process\.env\.COMMITTEE_ENABLE_ROLLCALL\s*===\s*'1'/.test(conductorSrc),
  'committee rollcall should be opt-in so normal live runs do not spend 4 minutes on warmup false negatives');

assert.ok(/点名预热未返回/.test(conductorSrc) &&
  /继续主轮全预算，不计降级/.test(conductorSrc) &&
  !/点名未应答席位/.test(conductorSrc),
  'committee rollcall misses should remain warmup misses instead of degrading analyst seats');

assert.ok(/compressedDefendKeys\s*=\s*defendKeys\.filter[\s\S]*seats\[k\]\.kind\s*===\s*'codex'/.test(conductorSrc) &&
  /activeDefendKeys\s*=\s*defendKeys\.filter[\s\S]*seats\[k\]\.kind\s*!==\s*'codex'/.test(conductorSrc) &&
  /幕二答辩压缩/.test(conductorSrc),
  'committee act2 defense should not re-wake Codex analyst seats after they already produced act1 reports');

console.log('Groupchat dispatcher contract: ok');
