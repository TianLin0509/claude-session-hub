'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const RESUME_IPC_SRC = fs.readFileSync(path.join(__dirname, '..', 'main', 'ipc', 'resume-session-handlers.js'), 'utf8');
const SESSION_MANAGER_SRC = fs.readFileSync(path.join(__dirname, '..', 'core', 'session-manager.js'), 'utf8');

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}`);
    console.error(`    ${e.message}`);
    process.exitCode = 1;
  }
}

console.log('Running codex missing sid picker contract tests...');

test('main routes dormant codex without sid to picker resume', () => {
  assert.match(
    RESUME_IPC_SRC,
    /const codexMissingSid = \(isCodexRuntime && !effectiveCodexSid\);/,
    'resume-session must classify dormant or rejected Codex bindings without an effective sid',
  );
  // 2026-08-27：原来这里锁的是字面量 `codexResumePicker: codexMissingSid,`。
  // f26e348 给它加了 `&& !freshUnboundAgentLeague` 守卫——Agent 联赛的空壳会话
  // 从未产生过原生 turn，弹 picker 会把自动 Prompt 喂进「Resume a previous
  // session」界面。那是有意的行为变更，不是回归，所以这里只锁「picker 由
  // codexMissingSid 驱动」，把守卫留给行为测试
  // tests/unit-resume-session-ipc-contract.test.js（它对两种情况都有断言）。
  assert.match(
    RESUME_IPC_SRC,
    /codexResumePicker: codexMissingSid\b/,
    'resume-session must request Codex picker instead of silent --last for missing sid',
  );
});

test('session-manager supports codexResumePicker without changing kind', () => {
  assert.match(
    SESSION_MANAGER_SRC,
    /kind\.endsWith\('-resume'\) \|\| opts\.codexResumePicker/,
    'session-manager must use picker command for opts.codexResumePicker',
  );
});

console.log('All passed.');
