'use strict';
// FIX-D 单测：验证 host-shell-detector 不会误判 CLI 输出 + 能正确识别真实宿主 shell prompt。
//
// 测试矩阵：
//   - 真实 PowerShell prompt（截图实际内容）→ true
//   - 真实 bash prompt → true
//   - 真实 cmd prompt → true
//   - Codex CLI alt-screen 渲染 → false（误判防护）
//   - Claude CLI alt-screen 渲染 → false
//   - Gemini CLI alt-screen 渲染 → false
//   - 空 buffer → false
//   - 历史 prompt 在 tail 之外 → false（仅看最后 500 字符）

const assert = require('assert');
const { detectHostShellTakeover, HOST_SHELL_PROMPT_RE } = require('../core/host-shell-detector.js');

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

console.log('Running host-shell-detector tests...');

test('真实 PowerShell prompt 命中（来自截图：用户实际场景）', () => {
  // 用户截图里 Codex CLI 退出后的实际 buffer 末尾
  const buf = '请检查名称的拼写，如果包括路径，请确保路径正确，然后再试一次。\nPS C:\\Users\\lintian> ';
  assert.ok(detectHostShellTakeover(buf), 'PowerShell prompt with cwd should match');
});

test('PowerShell prompt 末尾无空格也命中', () => {
  const buf = 'something\nPS C:\\Users\\lintian>';
  assert.ok(detectHostShellTakeover(buf));
});

test('bash prompt 命中', () => {
  const buf = 'previous output\nlintian@hostname:~$ ';
  assert.ok(detectHostShellTakeover(buf));
});

test('裸 $ prompt 命中', () => {
  const buf = 'whatever\n$ ';
  assert.ok(detectHostShellTakeover(buf));
});

test('cmd prompt 命中（无 PS 前缀）', () => {
  const buf = 'previous\nC:\\Users\\lintian>';
  assert.ok(detectHostShellTakeover(buf));
});

test('Codex CLI alt-screen 末尾不会误判', () => {
  // Codex CLI 的输入框带 ANSI 框线 + 提示符，但末尾不会是干净的 "PS X:\>" 一行
  const buf = '\x1b[2J\x1b[H╭──────────────╮\n│ Send a message...           │\n╰──────────────╯\n  gpt-5.5 medium · Context 91% left · ~';
  assert.ok(!detectHostShellTakeover(buf), 'Codex TUI should not match host shell prompt');
});

test('Claude CLI alt-screen 末尾不会误判', () => {
  const buf = '\x1b[2J\x1b[H? for shortcuts   bypass permissions\n>                                                  \n';
  assert.ok(!detectHostShellTakeover(buf));
});

test('Gemini CLI 末尾不会误判', () => {
  const buf = '感谢您的问题。我将开始研究...\n\n[Tool: web_search] 正在查询...';
  assert.ok(!detectHostShellTakeover(buf));
});

test('空 buffer 不命中', () => {
  assert.ok(!detectHostShellTakeover(''));
  assert.ok(!detectHostShellTakeover(null));
  assert.ok(!detectHostShellTakeover(undefined));
});

test('历史 prompt 在 tail 之外不命中', () => {
  // PS prompt 在前 1000 字符，tail 只看最后 500 → 应该不命中
  const noise = 'x'.repeat(1000);
  const buf = 'PS C:\\Users\\lintian> echo hi\n' + noise;
  assert.ok(!detectHostShellTakeover(buf));
});

test('PS prompt + 后续 CLI 启动文字混在一起，PS 在最后才命中', () => {
  // 模拟：CLI 启动 → CLI 退出 → PS prompt 在末尾
  const buf = 'Starting Codex CLI...\nUpdating Codex via npm install...\n[some output]\nPS C:\\Users\\lintian> ';
  assert.ok(detectHostShellTakeover(buf));
});

test('正则本身导出可用', () => {
  assert.ok(HOST_SHELL_PROMPT_RE instanceof RegExp);
  assert.ok(HOST_SHELL_PROMPT_RE.test('\nPS C:\\>'));
});

console.log('All passed.');
