'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

// 2026-10-24：第二个 Claude 账号目录从没装过 Hub hook / statusLine，额度一直是「—」。
test('every existing Claude account directory gets Hub hooks at startup and before launch', () => {
  const main = read('main.js');
  assert.match(main, /\[path\.join\(_home, '\.claude'\), deepseekClaudeDir, \.\.\.claudeProfileHookDirs\(\)\]/);
  assert.match(main, /sessionManager\.deployClaudeProfileHooks = dir => \{ if \(!isIsolatedHub\(\)\) \{ alignClaudeProfileDir\(dir\); ensureHooksDeployed\(dir\); \} \}/);
  assert.match(main, /if \(!isIsolatedHub\(\)\) for \(const dir of claudeProfileHookDirs\(\)\) alignClaudeProfileDir\(dir\);/);
  const manager = read('core/session-manager.js');
  const at = manager.indexOf('sessionEnv.CLAUDE_CONFIG_DIR = claudeProfile.home;');
  assert.ok(at > 0 && manager.slice(at, at + 600).includes('this.deployClaudeProfileHooks(claudeProfile.home)'));
});
