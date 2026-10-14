'use strict';
// 「发送内容」面板对 CodeAgent 会话列出它会读的规则文件和自动记忆（2026-10-14 用户要求）。
// CodeAgent 是 Claude Code 的改版：配置目录 .cac、规则文件 AGENTS.md。只有工作目录里那份
// AGENTS.md 经过真机实测，其余位置是推断，面板必须把两者区分开。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { buildInspection, buildAssembly, collectRawSources, projectSlug } = require('../core/prompt-inspect.js');
const { buildComposition } = require('../core/prompt-composition.js');

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ca-ctx-'));
  const configDir = path.join(base, 'cac-home');
  const project = path.join(base, 'work', 'proj');
  fs.mkdirSync(path.join(base, 'work', '.cac'), { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'AGENTS.md'), 'USER-RULE');
  fs.writeFileSync(path.join(base, 'work', 'AGENTS.md'), 'PARENT-RULE');
  fs.writeFileSync(path.join(base, 'work', '.cac', 'AGENTS.md'), 'PARENT-CAC-RULE');
  fs.writeFileSync(path.join(project, 'AGENTS.md'), 'PROJECT-RULE');
  // Claude 的规则文件 CodeAgent 不读，不能混进来
  fs.writeFileSync(path.join(project, 'CLAUDE.md'), 'CLAUDE-ONLY');
  const memDir = path.join(configDir, 'projects', projectSlug(fs.realpathSync.native(project)), 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, 'MEMORY.md'), '- [偏好](pref.md) — 用中文回答');
  fs.writeFileSync(path.join(memDir, 'pref.md'), '用中文回答');
  return { base, configDir, project };
}

test('CodeAgent 会话：按 .cac / AGENTS.md 规则列出规则链和自动记忆，并区分实测与推断', () => {
  const { configDir, project } = setup();
  const insp = buildInspection({ cwd: project, kind: 'codeagent', codeagentConfigDir: configDir });
  const asm = buildAssembly(insp);
  assert.equal(asm.kind, 'codeagent');
  const texts = asm.segments.map(s => s.text);
  assert.deepEqual(texts, ['USER-RULE', 'PARENT-RULE', 'PARENT-CAC-RULE', 'PROJECT-RULE', '- [偏好](pref.md) — 用中文回答']);
  assert.ok(!texts.includes('CLAUDE-ONLY'), 'CLAUDE.md 不该出现在 CodeAgent 的列表里');
  const evidence = asm.segments.map(s => s.evidence);
  assert.deepEqual(evidence, ['inferred', 'inferred', 'inferred', 'verified', 'inferred']);
  assert.equal(insp.totals.memoryFiles, 2);

  const composition = buildComposition({ turn: { text: 'hi' }, kind: 'codeagent', assembly: asm });
  const startup = composition.groups.find(g => g.id === 'startup');
  const memory = startup.parts.find(p => /MEMORY\.md/.test(p.title));
  assert.ok(memory, '自动记忆要出现在「会话开头自动带上的规则与记忆」里');
  assert.match(memory.note, /推断/);
  const projectRule = startup.parts.find(p => p.text === 'PROJECT-RULE');
  assert.ok(!/推断/.test(projectRule.note || ''), '工作目录里的 AGENTS.md 是实测过的，不标推断');

  // 原文查看的白名单也要包含这些文件
  const allowed = collectRawSources(insp).map(s => s.path);
  assert.ok(allowed.includes(path.join(configDir, 'AGENTS.md')));
  assert.ok(allowed.some(p => p.endsWith('MEMORY.md') && p.startsWith(configDir)));
});

test('CodeAgent 会话在没有记忆的新目录：体检提示每个新目录从空记忆开始', () => {
  const { configDir, base } = setup();
  const fresh = path.join(base, 'fresh');
  fs.mkdirSync(fresh);
  const insp = buildInspection({ cwd: fresh, kind: 'codeagent', codeagentConfigDir: configDir });
  const check = insp.health.find(c => /自动记忆/.test(c.title));
  assert.ok(check && check.level === 'warn' && /空记忆/.test(check.detail), JSON.stringify(insp.health));
});

test('Claude 会话的拼装不受影响', () => {
  const { project } = setup();
  const asm = buildAssembly(buildInspection({ cwd: project, kind: 'claude' }));
  assert.equal(asm.kind, 'claude');
  assert.ok(asm.segments.some(s => s.text === 'CLAUDE-ONLY'));
  assert.ok(!asm.segments.some(s => s.text === 'PROJECT-RULE'));
});
