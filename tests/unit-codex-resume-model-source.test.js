'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'core', 'session-manager.js'), 'utf8');

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

console.log('Running codex resume model source tests...');

test('precise codex resume carries explicit --model', () => {
  assert.match(
    SRC,
    /codex resume \$\{opts\.codexSid\} --dangerously-bypass-approvals-and-sandbox --model \$\{codexModel\}/,
    'codex resume <sid> must carry --model ${codexModel}',
  );
});

test('codex resume --last carries explicit --model', () => {
  assert.match(
    SRC,
    /codex resume --last --dangerously-bypass-approvals-and-sandbox --model \$\{codexModel\}/,
    'codex resume --last must carry --model ${codexModel}',
  );
});

test('codex picker resume carries explicit --model', () => {
  assert.match(
    SRC,
    /codex resume --dangerously-bypass-approvals-and-sandbox --model \$\{codexModel\}/,
    'codex resume picker path must carry --model ${codexModel}',
  );
});

test('codex picker resume enables mtime fallback binding', () => {
  assert.match(
    SRC,
    /\(kind\.endsWith\('-resume'\)\s*\|\|\s*opts\.codexResumePicker\s*\|\|\s*\(opts\.useResume && !opts\.codexSid\)\)/,
    'codex resume picker variants must bind old rollout files by fresh mtime after user selects a session',
  );
});

test('a precise native id wins over the *-resume picker kind', () => {
  const codexExact = SRC.indexOf('} else if (opts.useResume && opts.codexSid) {');
  const codexPicker = SRC.indexOf("} else if (kind.endsWith('-resume') || opts.codexResumePicker) {");
  assert.ok(codexExact >= 0 && codexPicker > codexExact,
    'codex-resume with a bound codexSid must run `codex resume <sid>`, not reopen the picker');

  const legacyStart = SRC.lastIndexOf('if (isDeepSeekLegacy) {');
  const legacyExact = SRC.indexOf('} else if (opts.resumeCCSessionId) {', legacyStart);
  const legacyPicker = SRC.indexOf("} else if (kind === 'deepseek-resume') {", legacyExact);
  assert.ok(legacyExact >= 0 && legacyPicker > legacyExact,
    'legacy DeepSeek resume must prefer its exact Claude session id over the picker');

  const geminiExact = SRC.indexOf('if (opts.useResume && opts.geminiChatId && opts.geminiChatId.length > 8) {');
  const geminiFallback = SRC.indexOf("} else if (kind === 'gemini-resume' || opts.useResume) {", geminiExact);
  assert.ok(geminiExact >= 0 && geminiFallback > geminiExact,
    'gemini-resume with a full native id must prefer the exact session over latest');
});

test('codex PTY sessions default to max reasoning effort and silent full access', () => {
  assert.match(
    SRC,
    /model_reasoning_effort="\$\{effort\}"/,
    'codex command builder must define a reasoning-effort override',
  );
  assert.match(
    SRC,
    /approval_policy="never"/,
    'codex command builder must force approval_policy=never',
  );
  assert.match(
    SRC,
    /sandbox_mode="danger-full-access"/,
    'codex command builder must force sandbox_mode=danger-full-access',
  );
  assert.match(
    SRC,
    /windows\.sandbox="unelevated"/,
    'codex command builder must avoid elevated Windows sandbox setup',
  );
  assert.match(
    SRC,
    /notice\.hide_full_access_warning=true/,
    'codex command builder must hide full-access warning UI',
  );
  assert.match(
    SRC,
    /const CODEX_REASONING_EFFORT = 'max';/,
    'codex reasoning-effort override must default to max',
  );
  const commandUses = SRC.match(/\$\{codexReasoningArg\}/g) || [];
  assert.ok(commandUses.length >= 6, 'new/resume/relaunch codex commands must include dynamic reasoning override');
});

test('group-chat Codex sessions honor each member reasoning effort and speed tier', () => {
  assert.doesNotMatch(
    SRC,
    /(?:opts\.)?meetingId\s*\?\s*CODEX_REASONING_EFFORT\s*:\s*normalizeCodexEffort/,
    'meeting sessions must not override a member-selected effort with shared max',
  );
  const configurableEffortUses = SRC.match(/buildCodexReasoningConfigArg\(normalizeCodexEffort\(/g) || [];
  assert.equal(
    configurableEffortUses.length,
    2,
    'createSession 与 relaunch 两条 Codex 命令都必须沿用成员自己的 effort',
  );
  assert.doesNotMatch(
    SRC,
    /(?:opts\.)?meetingId\s*\?\s*''\s*:\s*buildCodexSpeedTierArg/,
    '群聊成员的 service_tier 不能再被 meetingId 分支吞掉',
  );
});

test('codex API profile uses the same max reasoning effort default', () => {
  assert.match(
    SRC,
    /model_reasoning_effort = \$\{tomlString\(CODEX_REASONING_EFFORT\)\}/,
    'isolated Codex API profile config.toml must use the shared reasoning-effort default',
  );
  assert.match(
    SRC,
    /'sandbox = "unelevated"'/,
    'isolated Codex API profile config.toml must avoid elevated Windows sandbox setup',
  );
});

test('isolated Hub keeps CODEX_HOME for ordinary Codex sessions, not only meetings', () => {
  const apiBranch = SRC.indexOf('if (isCodexApiBackend(cv)) {');
  const profileBranch = SRC.indexOf('} else if (selectedProfileHomeAllowed) {', apiBranch);
  const isolatedBranch = SRC.indexOf('} else if (process.env.CLAUDE_HUB_DATA_DIR && process.env.CODEX_HOME) {', apiBranch);
  const meetingBranch = SRC.indexOf('} else if (opts.meetingId) {', apiBranch);
  assert.ok(apiBranch >= 0 && profileBranch > apiBranch && isolatedBranch > profileBranch && meetingBranch > isolatedBranch,
    'safe explicit profiles win, then ordinary isolated Codex binds its fallback before the meeting branch');
  const isolatedBody = SRC.slice(isolatedBranch, meetingBranch);
  assert.match(isolatedBody, /sessionEnv\.CODEX_HOME = process\.env\.CODEX_HOME/);
  assert.match(isolatedBody, /codexSessionsRoot = path\.join\(process\.env\.CODEX_HOME, 'sessions'\)/);
});

console.log('All passed.');
