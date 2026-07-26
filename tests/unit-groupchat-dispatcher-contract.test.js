'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dispatcherPath = path.join(root, 'main', 'groupchat', 'dispatcher.js');
const readyDetectorPath = path.join(root, 'core', 'group-chat-cli-ready-detector.js');
const watcherPath = path.join(root, 'core', 'turn-completion-watcher.js');
const groupWatcherPath = path.join(root, 'core', 'group-chat-watcher.js');
const mainPath = path.join(root, 'main.js');
const dispatcherSrc = fs.readFileSync(dispatcherPath, 'utf8');
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

assert.ok(/const\s+groupChatTurnQueue\s*=\s*new Map\(\)/.test(dispatcherSrc) &&
  /previous\.catch\(\(\)\s*=>\s*\{\}\)\.then\(\(\)\s*=>\s*runGroupChatTurn\(meetingId,\s*\{\s*\.\.\.args,\s*_dispatchSeq:\s*dispatchSeq\s*\}\)\)/.test(dispatcherSrc) &&
  !/if\s*\(\s*groupChatInProgress\.has\(meetingId\)\s*\)\s*return\s*\{\s*status:\s*'busy'/.test(dispatcherSrc),
  'group chat should queue overlapping user sends instead of rejecting them as busy');

// 抢占式连发（2026-06-24 道雪）：用户点发送即放行 —— 新一轮进来抢占结算上一轮没答完的 AI，
//   让卡死的 AI 不再无限期挂起整个串行队列。
assert.ok(/function supersedeActiveWatchersForMeeting\(meetingId\)/.test(dispatcherSrc) &&
  /watcher\.supersede\(\)/.test(dispatcherSrc) &&
  /const meetingDispatchSeq\s*=\s*new Map\(\)/.test(dispatcherSrc),
  'dispatcher should preempt the previous turn by superseding in-flight watchers');

assert.ok(/if\s*\(!args\.silent\)\s*\{[\s\S]*meetingDispatchSeq\.set\(key,\s*dispatchSeq\)[\s\S]*supersedeActiveWatchersForMeeting\(meetingId\)/.test(dispatcherSrc),
  'real user sends (non-silent) should bump the dispatch sequence and preempt the prior turn');

assert.ok(/wasSuperseded\s*=\s*_dispatchSeq\s*!=\s*null\s*&&\s*meetingDispatchSeq\.get\(String\(meetingId\s*\|\|\s*''\)\)\s*!==\s*_dispatchSeq/.test(dispatcherSrc) &&
  /superseded:\s*wasSuperseded/.test(dispatcherSrc),
  'turn-complete should carry a superseded flag when a newer turn has preempted this one');

assert.ok(/if\s*\(partial\.status\s*===\s*'superseded'\)\s*return/.test(dispatcherSrc),
  'superseded settle should not be pushed as a partial-update (avoids flashing the preempted card)');

assert.ok(/markProcessExitForSession\(sessionId,\s*exitInfo\)/.test(mainSrc),
  'PTY process exit should still be forwarded to active groupchat watchers');

assert.ok(/getActiveWatchers:\s*groupChatDispatcher\.getActiveWatchers/.test(mainSrc),
  'recovery IPC should receive the dispatcher-owned active watcher registry');

assert.ok(/groupChatWatcher:\s*groupChatDispatcher\.getGroupChatWatcher\(\)/.test(mainSrc),
  'recovery IPC should keep using the same initialized groupchat watcher');

assert.ok(/activeWatchers\.set\(sid,\s*watcher\)/.test(dispatcherSrc) &&
  /activeWatchers\.delete\(sid\)/.test(dispatcherSrc),
  'dispatcher should own watcher lifecycle registration and cleanup');

// 2026-07-12：auth 判定收紧——dispatcher 不再对整个 ring buffer 裸测 AUTH_FAILURE_RE
//   （AI 回答里提到 "not logged in" 会误杀正常回答），改用 host-shell-detector 的
//   createAuthBannerMonitor（tail + 连续 2 次命中 + 期间 PTY 静默）。
assert.ok(/createAuthBannerMonitor/.test(dispatcherSrc) &&
  /authBannerMonitor\.tick\(buf,\s*sessionManager\.getGroupChatLastActivity\(sid\)\)\s*===\s*'confirmed'/.test(dispatcherSrc) &&
  /auth_required/.test(dispatcherSrc) &&
  /watcher\.markErrored/.test(dispatcherSrc) &&
  !/AUTH_FAILURE_RE\.test\(buf\)/.test(dispatcherSrc),
  'dispatcher should settle unauthenticated CLI turns via the tightened auth banner monitor, not a raw full-buffer regex');

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

assert.ok(/if\s*\(isClaudeFamily\(kind\)\s*\|\|\s*isCodexCliKind\(kind\)\)\s*\{[\s\S]*for\s*\(let i = 0; i < ENTER_RETRY_TRIES; i \+= 1\)[\s\S]*sessionManager\.writeToSession\(sid,\s*'\\r'\)/.test(groupWatcherSrc),
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

assert.ok(/markErrored\(reason/.test(watcherSrc),
  'turn completion watcher should expose an explicit error-settle hook');

assert.ok(/Try "edit/.test(readyDetectorSrc),
  'Claude-family ready detection should recognize the newer Try "edit footer');

console.log('Groupchat dispatcher contract: ok');
