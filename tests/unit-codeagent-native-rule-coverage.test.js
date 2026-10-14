'use strict';
// CodeAgent 自己会读工作目录及每一层上层目录的 AGENTS.md（2026-10-14 公司真机探测，有无 git 都读）。
// Hub 的「共享工作区规则」不该再把同一份正文随第一条消息重复发一遍。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { captureNativeRuleCoverage, stillCovered } = require('../core/native-rule-coverage.js');

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ca-cover-'));
  const configDir = path.join(base, 'cac-home');
  const root = path.join(base, 'Workspaces');
  const cwd = path.join(root, 'proj');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(path.join(cwd, '.cac'), { recursive: true });
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# 工作区规则\n产物放 artifacts/');
  fs.writeFileSync(path.join(cwd, '.cac', 'AGENTS.md'), 'CAC-ONLY');
  return { configDir, root, cwd };
}

test('CodeAgent：上层目录的 AGENTS.md 算作 CLI 已经读到，Hub 不再重复发送', () => {
  const { configDir, cwd } = setup();
  const rows = captureNativeRuleCoverage({ kind: 'codeagent', cwd, env: {}, codeagentConfigDir: configDir });
  assert.ok(stillCovered('# 工作区规则\n产物放 artifacts/', rows));
  assert.ok(!rows.some(r => /CAC-ONLY/.test(r.content)), '.cac/AGENTS.md 实测不读，不能算覆盖');
});

test('CodeAgent：配置里出现任何排除规则文件的设置时保守处理，照常由 Hub 发送', () => {
  const { configDir, cwd } = setup();
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ agentsMdExcludes: ['**/AGENTS.md'] }));
  assert.deepEqual(captureNativeRuleCoverage({ kind: 'codeagent', cwd, env: {}, codeagentConfigDir: configDir }), []);
});

test('CodeAgent：项目配置写坏（不是合法 JSON）时同样保守处理', () => {
  const { configDir, cwd } = setup();
  fs.writeFileSync(path.join(cwd, '.cac', 'settings.json'), '{oops');
  assert.deepEqual(captureNativeRuleCoverage({ kind: 'codeagent', cwd, env: {}, codeagentConfigDir: configDir }), []);
});
