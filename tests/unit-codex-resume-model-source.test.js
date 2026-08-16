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

test('group-chat Codex sessions cannot downgrade reasoning effort', () => {
  const groupReasoningConst = 'CODEX_GROUP_CHAT_' + 'REASONING_EFFORT';
  assert.doesNotMatch(
    SRC,
    new RegExp(groupReasoningConst),
    'group-chat Codex must not have a separate lower reasoning tier',
  );
  assert.doesNotMatch(
    SRC,
    /meetingId\s*\?\s*[^:]+:\s*CODEX_REASONING_EFFORT/,
    'meeting sessions must not branch to a lower Codex reasoning effort',
  );
  // 单人 Codex 会话现在可以在新建弹窗里分别选思考强度与 service_tier。
  // 但群聊成员必须继续钉死共享的 max ——
  // 一个房间里成员各调各的档位，产出就没法互相比较了。
  const pins = SRC.match(/buildCodexReasoningConfigArg\(\s*\n?\s*(?:opts\.)?meetingId \? CODEX_REASONING_EFFORT : normalizeCodexEffort\(/g) || [];
  assert.equal(
    pins.length,
    2,
    'createSession 与 relaunch 两条 Codex 命令都必须在 meetingId 存在时钉死 max effort',
  );
  assert.doesNotMatch(
    SRC,
    /normalizeCodexEffort\([^)]*\)\s*:\s*CODEX_REASONING_EFFORT/,
    '三目不能写反：群聊拿到的必须是 CODEX_REASONING_EFFORT，不是用户选的档位',
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

console.log('All passed.');
