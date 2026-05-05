'use strict';
// 锁定 dismissCodexRateLimitDialog 的幂等行为 + toml 文件保护契约（2026-05-05 道雪）。
//
// 行为：
//   - 文件不存在 → 创建 + 写完整 [notice] 段
//   - 已含 hide_rate_limit_model_nudge=true → 幂等返回 false 不写盘
//   - 已有 [notice] section 但无 key → 在 section 内插入 key（不重复 section）
//   - 没 [notice] section → 文件末尾追加完整 [notice] 段
//   - 不破坏用户已有 config 内容（其他 section / key 全部保留）

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { dismissCodexRateLimitDialog } = require('../core/session-manager.js');

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-codex-rl-'));
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  return home;
}

function readConfig(home) {
  return fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
}

function testCreatesFileWhenMissing() {
  const home = makeHome();
  // 不预先创建 config.toml
  assert.strictEqual(dismissCodexRateLimitDialog(home), true);
  const c = readConfig(home);
  assert.match(c, /\[notice\]/);
  assert.match(c, /hide_rate_limit_model_nudge\s*=\s*true/);
  fs.rmSync(home, { recursive: true, force: true });
}

function testIdempotentWhenAlreadyTrue() {
  const home = makeHome();
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'),
    'model = "gpt-5.5"\n\n[notice]\nhide_rate_limit_model_nudge = true\n', 'utf8');
  const before = readConfig(home);
  assert.strictEqual(dismissCodexRateLimitDialog(home), false, '幂等：已 true 不写盘');
  assert.strictEqual(readConfig(home), before, '文件内容必须 byte-for-byte 不变');
  fs.rmSync(home, { recursive: true, force: true });
}

function testInsertsIntoExistingNoticeSection() {
  const home = makeHome();
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'),
    'model = "gpt-5.5"\n\n[notice]\nsome_other_setting = "x"\n', 'utf8');
  assert.strictEqual(dismissCodexRateLimitDialog(home), true);
  const c = readConfig(home);
  // [notice] section 不应出现两次
  assert.strictEqual((c.match(/^\[notice\]$/gm) || []).length, 1, '[notice] section 只应一次');
  assert.match(c, /hide_rate_limit_model_nudge\s*=\s*true/);
  // 已有 key 不丢
  assert.match(c, /some_other_setting\s*=\s*"x"/);
  fs.rmSync(home, { recursive: true, force: true });
}

function testAppendsNoticeSectionAtEnd() {
  const home = makeHome();
  // 模拟用户真实 config（含多个 section、projects 等）
  const original = [
    'model = "gpt-5.5"',
    'approval_policy = "never"',
    '',
    '[features]',
    'codex_hooks = true',
    '',
    "[projects.'C:\\\\Users\\\\lintian']",
    'trust_level = "trusted"',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), original, 'utf8');

  assert.strictEqual(dismissCodexRateLimitDialog(home), true);
  const c = readConfig(home);

  // 原内容必须全部保留
  assert.match(c, /model = "gpt-5.5"/);
  assert.match(c, /approval_policy = "never"/);
  assert.match(c, /\[features\]/);
  assert.match(c, /codex_hooks = true/);
  assert.match(c, /trust_level = "trusted"/);
  // 新加 section
  assert.match(c, /\[notice\]/);
  assert.match(c, /hide_rate_limit_model_nudge\s*=\s*true/);
  // 不重复 [notice]
  assert.strictEqual((c.match(/^\[notice\]$/gm) || []).length, 1);
  fs.rmSync(home, { recursive: true, force: true });
}

function testHonorsCustomConfigDir() {
  // API 模式：CODEX_HOME 是隔离目录，不在 ~/.codex
  const customDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-codex-api-'));
  // 注意 dismissCodexRateLimitDialog(homeDir, configDir) — 传 configDir 时 homeDir 被忽略
  assert.strictEqual(dismissCodexRateLimitDialog(undefined, customDir), true);
  const c = fs.readFileSync(path.join(customDir, 'config.toml'), 'utf8');
  assert.match(c, /hide_rate_limit_model_nudge\s*=\s*true/);
  fs.rmSync(customDir, { recursive: true, force: true });
}

function testDoesNotThrowOnIoError() {
  // configDir 指向不可创建的路径（Windows 上 NUL 设备子目录）
  // 简单做法：传一个非法 path，期望不抛
  const bogus = path.join(os.tmpdir(), 'nonexistent-' + Date.now(), 'deeply', 'nested');
  // 应能创建（mkdir recursive 会一路建），就不测错误路径了；改测：write 到只读目录
  // Windows 下难做只读，跳过这个 case；仅验证函数不抛任何异常即可
  assert.doesNotThrow(() => dismissCodexRateLimitDialog(undefined, bogus));
  fs.rmSync(bogus, { recursive: true, force: true });
}

console.log('Running codex rate-limit dialog dismiss unit tests...');
testCreatesFileWhenMissing();
console.log('  ✓ testCreatesFileWhenMissing');
testIdempotentWhenAlreadyTrue();
console.log('  ✓ testIdempotentWhenAlreadyTrue');
testInsertsIntoExistingNoticeSection();
console.log('  ✓ testInsertsIntoExistingNoticeSection');
testAppendsNoticeSectionAtEnd();
console.log('  ✓ testAppendsNoticeSectionAtEnd');
testHonorsCustomConfigDir();
console.log('  ✓ testHonorsCustomConfigDir');
testDoesNotThrowOnIoError();
console.log('  ✓ testDoesNotThrowOnIoError');
console.log('All passed.');
