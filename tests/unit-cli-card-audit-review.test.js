'use strict';
// 2026-09-26 对 fix/cli-card-audit 的独立审查修正：
//   去掉「未确认 / 补发」横幅时，明确的发送失败也一起变成了无声，而输入框在发送前已清空；
//   千问 / GLM 超时一次后占位不释放，之后每次发送都报「仍在执行」；
//   发送途中 CLI 退回命令行只报无声的 stuck。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('explicit send failures return the text; unconfirmed has a receipt-bound recovery entry', () => {
  const src = read('renderer/renderer.js');
  assert.match(src, /function reportFloatingSendFailure\(sessionId, inputBox, text, reason\) \{/);
  assert.match(src, /if \(restored\) \{ replaceContenteditableText\(inputBox, text\); saveFloatingInputDraft\(sessionId, inputBox\); \}/);
  assert.match(src, /if \(!result\?\.ok && !result\?\.unconfirmed\) \{\s*reportFloatingSendFailure\(/, 'a failed result reaches the user');
  assert.match(src, /else reportFloatingSendFailure\(sessionId, inputBox, text, err && err\.message/, 'IPC failure of a PTY send is visible too');
  assert.match(src, /if \(result\?\.sendStatus === 'content-mismatch'\) \{ notifyPromptContentMismatch\(delivery\); return; \}/);
  assert.match(src, /if \(state\.status === 'content-mismatch' && !state\.dismissed\) notifyPromptContentMismatch\(state\);/);
  // 当前用户提供的项目规则要求未确认可见，补发绑定本次消息。
  assert.match(src, /resend\.className = 'fi-stuck-resend'/);
  assert.match(src, /invoke\('session:resend-prompt', \{ sessionId, clientSubmissionId: delivery.clientSubmissionId \}\)/);
});

test('unknown results keep their unconfirmed flag through the submit handler', () => {
  assert.match(read('main/ipc/prompt-submit-handlers.js'), /\.\.\.\(result\.unconfirmed \? \{unconfirmed:true\} : \{\}\),/);
});

test('Qwen and GLM release only their own pending send when it times out', () => {
  assert.match(read('core/qwen-cli-session.js'), /timer:setTimeout\(\(\)=>\{if\(this\.pending\?\.id===id\)this\.pending=null;resolve\(\{ok:false,sendStatus:'stuck',unconfirmed:true\}\);\},15000\)/);
  assert.match(read('core/martty-cli-session.js'), /timer:setTimeout\(\(\)=>\{if\(this\.pending\?\.id===pendingId\)this\.pending=null;resolve\(\{ok:false,sendStatus:'stuck',unconfirmed:true\}\);\}/);
});

test('a CLI that drops back to the shell during the acknowledgement wait is reported, not left as silent stuck', () => {
  const src = read('core/group-chat-watcher.js');
  assert.match(src, /detectHostShellTakeover\(sessionManager\.getSessionBuffer\(sid\)\)\) \{ cliExitedDuringAck = true; break; \}/);
  assert.match(src, /if \(!acknowledgement && cliExitedDuringAck\) \{\s*return \{ ok: false, sendStatus: 'cli-exited', error: 'cli-exited'/);
  assert.doesNotMatch(src.slice(src.indexOf("sendStatus: 'cli-exited'"), src.indexOf("sendStatus: 'cli-exited'") + 200), /notSent/,
    'the text may already be inside the CLI: never offered as unsent');
});
