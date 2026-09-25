'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const main = read('main.js');
const renderer = read('renderer/renderer.js');
const sidebar = read('renderer/session-list-renderer.js');
const home = read('renderer/home-workbench.js');
const hookIntegration = read('core/claude-hook-integration.js');

test('Claude official lifecycle hooks reach the renderer with bounded evidence', () => {
  for (const eventName of ['StopFailure', 'PermissionRequest', 'Notification']) {
    assert.match(hookIntegration, new RegExp(`\\['${eventName}'`), `${eventName} must be managed`);
  }
  for (const field of ['backgroundTasks', 'sessionCrons', 'errorDetails', 'notificationType', 'toolName', 'agentId']) {
    assert.match(main, new RegExp(`${field}:`), `main hook bridge must forward ${field}`);
  }
  assert.match(main, /const isSubagentContext = !!parsed\.agentId/);
  assert.match(main, /ignored foreign \$\{event\}/,
    'main hook server must reject inherited-env events from another native Claude session');
  assert.match(main, /initialTranscriptBucketMismatch[\s\S]{0,500}projectSlug\(hookTargetSession\.cwd\)/,
    'an unbound session must reject a first hook from another Claude project bucket');
  assert.match(main, /!isSubagentContext && \(parsed\.claudeSessionId \|\| parsed\.transcriptPath\)/,
    'subagent hooks must never replace the parent transcript binding');
  assert.match(renderer, /event === 'stop-failure'\)[\s\S]{0,160}onClaudeStopFailure/);
  assert.match(renderer, /event === 'permission-request'\)[\s\S]{0,180}onClaudeNeedsInput/);
  assert.match(renderer, /event === 'notification'\)[\s\S]{0,180}onClaudeNotification/);
  assert.match(renderer,
    /onReplyCompleteFromHook[\s\S]{0,5000}extractLiveScreenLines\(sessionId\)[\s\S]{0,800}stopHooksActive/,
    'Claude Stop must defer completion while the live PTY still runs Stop hooks');
});

test('Codex, Claude and PTY producers all publish RuntimeTruth observations', () => {
  assert.match(renderer, /claude-user-prompt-submit/);
  assert.match(renderer, /claude-stop/);
  assert.match(renderer, /source: 'claude-transcript-complete'/,
    'Claude transcript terminal events must independently close runtime state');
  assert.match(renderer, /-turn-complete/);
  assert.match(renderer, /codex-turn-aborted/);
  assert.match(renderer, /pty-byte-burst/);
  assert.match(renderer, /pty-\$\{runtime\.reason/);
  assert.match(renderer, /groupchat-watcher-heartbeat/);
});

test('sidebar, card header and home workbench consume the shared truth', () => {
  assert.match(sidebar, /getSessionRuntimeTruth\(s/);
  assert.match(sidebar, /sessionRuntimeIsActive\(s/);
  assert.doesNotMatch(sidebar,
    /else if \(s\.status === 'running'\) running\.push\(s\)/,
    'sidebar running lane must not regress to raw session.status');
  assert.match(home, /getSessionRuntimeTruth\(session/);
  assert.match(home, /sessionRuntimeIsActive\(session/);
  assert.match(renderer, /deriveSessionRuntimeStatus\(session/);
});

test('unknown is retained as an honest state when evidence expires', () => {
  assert.match(renderer, /state: RUNTIME_UNKNOWN,[\s\S]{0,180}observation-expired/);
  assert.match(sidebar, /truth\?\.state === RUNTIME_UNKNOWN/);
});

// 返工 R4（2026-09-25）：Stop hook 的运行帧曾把已被 transcript 结束的一轮重新打开，
// 且没有任何出口，会话 182 秒停在运行中。行为由 tests/e2e-claude-stop-hook-order-cdp.js
// 在真实 renderer + xterm 里验证；这里守住三处结构，防止回退。
test('a PTY turn closed authoritatively cannot be reopened by a Stop-hook frame, and a deferred Stop always resolves', () => {
  assert.match(renderer, /function ptyTurnClosedAuthoritatively\(/);
  assert.match(renderer,
    /const stopHooksActive = [\s\S]{0,260}!ptyTurnClosedAuthoritatively\(session\)/,
    'Stop must not defer completion for a turn the transcript already closed');
  assert.match(renderer,
    /else if \(stopHooksActive\)[\s\S]{0,900}scheduleClaudeStopHookResolution\(sessionId/,
    'a deferred Stop must schedule its own resolution');
  assert.match(renderer, /runtime\.state === 'running' && ptyTurnClosedAuthoritatively\(session, truthBefore\)/,
    'screen observations share the same terminal-state rule');
  assert.doesNotMatch(renderer.slice(renderer.indexOf('function scheduleClaudeStopHookResolution'),
    renderer.indexOf('function applyPtyRuntimeObservation')), /\w\._lastOutputTs/,
    'stale-frame detection must not trust _lastOutputTs (re-reading an old frame refreshes it)');
});
