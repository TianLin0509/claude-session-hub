'use strict';
// 造梦师的 AI 下拉只列本发行版装了的 AI（2026-10-16）：公司版只有 CodeAgent，以前默认值写死 Codex，
// 第一次点造梦就会拿一个不存在的 AI 去开会话。
const test = require('node:test');
const assert = require('node:assert/strict');
const { dreamKinds } = require('../renderer/memory-panel');

test('公司版（只装 CodeAgent 和 PowerShell）：只有 CodeAgent，默认就是它', () => {
  const allowed = k => ['codeagent', 'powershell'].includes(k);
  assert.deepEqual(dreamKinds(allowed), ['codeagent']);
});

test('家里版（不限种类）：Codex 打头、默认 Codex，其余 AI 都在', () => {
  const kinds = dreamKinds(() => true);
  assert.equal(kinds[0], 'codex');
  assert.ok(kinds.includes('claude') && kinds.includes('codeagent'));
});

test('源码里不再写死默认 Codex', () => {
  const src = require('node:fs').readFileSync(require.resolve('../renderer/memory-panel'), 'utf8');
  assert.doesNotMatch(src, /let kind = "codex"/);
  assert.match(src, /let kind = DEFAULT_DREAM_KIND/);
});
