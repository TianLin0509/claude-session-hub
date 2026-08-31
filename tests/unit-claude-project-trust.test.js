'use strict';

// 2026-08-28 实测：往 ~/.claude.json 写 projects[<正斜杠 cwd>].hasTrustDialogAccepted
// 之后，Claude Code v2.1.251 对该目录不再弹信任框。这里守住写入行为的边界 ——
// 共享配置文件不能被 Hub 越权改写。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  claudeStatePathFor,
  ensureClaudeProjectTrusted,
  toClaudeProjectKey,
} = require('../core/claude-project-trust.js');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-trust-test-'));
const configDir = path.join(tmpRoot, 'config');
const statePath = path.join(configDir, '.claude.json');
const projectDir = path.join(tmpRoot, 'ws');
fs.mkdirSync(configDir, { recursive: true });
fs.mkdirSync(projectDir, { recursive: true });

// key 必须是正斜杠形式 —— 真实 ~/.claude.json 里就是这么存的。
assert.strictEqual(toClaudeProjectKey('C:\\Vibe\\_scratch\\x'), 'C:/Vibe/_scratch/x');
assert.strictEqual(claudeStatePathFor(configDir), statePath);

// --- 补写 ---
fs.writeFileSync(statePath, JSON.stringify({
  numStartups: 7,
  projects: { 'C:/other': { allowedTools: ['Bash'] } },
}, null, 2), 'utf8');
const first = ensureClaudeProjectTrusted(projectDir, { configDir });
assert.strictEqual(first.ok, true);
assert.strictEqual(first.changed, true);
let state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
assert.strictEqual(state.projects[toClaudeProjectKey(projectDir)].hasTrustDialogAccepted, true);
// 其它字段一个都不能动：settings/onboarding 类全局开关不归 Hub 管。
assert.strictEqual(state.numStartups, 7);
assert.deepStrictEqual(state.projects['C:/other'], { allowedTools: ['Bash'] });
assert.strictEqual('hasCompletedOnboarding' in state, false);
assert.strictEqual('bypassPermissionsModeAccepted' in state, false);

// Windows Defender/another reader can hold the destination for a few ms.
// A transient EPERM must retry instead of dropping automatic trust entirely.
const retryProjectDir = path.join(tmpRoot, 'ws-retry');
fs.mkdirSync(retryProjectDir, { recursive: true });
let renameAttempts = 0;
const retried = ensureClaudeProjectTrusted(retryProjectDir, {
  configDir,
  renameRetryDelayMs: 0,
  fsImpl: {
    ...fs,
    renameSync(source, target) {
      renameAttempts += 1;
      if (renameAttempts < 3) throw Object.assign(new Error('temporarily busy'), { code: 'EPERM' });
      return fs.renameSync(source, target);
    },
  },
});
assert.strictEqual(retried.ok, true);
assert.strictEqual(renameAttempts, 3);
assert.strictEqual(
  JSON.parse(fs.readFileSync(statePath, 'utf8')).projects[toClaudeProjectKey(retryProjectDir)].hasTrustDialogAccepted,
  true,
);

// --- 幂等：已经 true 就不写 ---
const mtimeBefore = fs.statSync(statePath).mtimeMs;
const second = ensureClaudeProjectTrusted(projectDir, { configDir });
assert.strictEqual(second.ok, true);
assert.strictEqual(second.changed, false);
assert.strictEqual(second.reason, 'already-trusted');
assert.strictEqual(fs.statSync(statePath).mtimeMs, mtimeBefore);

// --- 已有项目条目要保留自定义字段 ---
state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
state.projects[toClaudeProjectKey(projectDir)] = { allowedTools: ['Read'], lastCost: 1.5 };
fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
ensureClaudeProjectTrusted(projectDir, { configDir });
state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const entry = state.projects[toClaudeProjectKey(projectDir)];
assert.strictEqual(entry.hasTrustDialogAccepted, true);
assert.deepStrictEqual(entry.allowedTools, ['Read']);
assert.strictEqual(entry.lastCost, 1.5);

// --- 损坏的配置绝不覆盖 ---
fs.writeFileSync(statePath, '{ this is not json', 'utf8');
const broken = ensureClaudeProjectTrusted(projectDir, { configDir });
assert.strictEqual(broken.ok, false);
assert.strictEqual(broken.reason, 'unparsable-state');
assert.strictEqual(fs.readFileSync(statePath, 'utf8'), '{ this is not json');

// --- 共享 home 配置不存在时不凭空创建 ---
const emptyDir = path.join(tmpRoot, 'no-config');
fs.mkdirSync(emptyDir, { recursive: true });
const missing = ensureClaudeProjectTrusted(projectDir, {
  configDir: null,
  fsImpl: {
    ...fs,
    readFileSync: () => { const err = new Error('ENOENT'); throw err; },
    writeFileSync: () => { throw new Error('must not write'); },
    renameSync: () => { throw new Error('must not rename'); },
    mkdirSync: () => { throw new Error('must not mkdir'); },
  },
});
assert.strictEqual(missing.ok, false);
assert.strictEqual(missing.reason, 'state-missing');

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log('unit-claude-project-trust: OK');
