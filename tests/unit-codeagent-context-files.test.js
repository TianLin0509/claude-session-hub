'use strict';
// 「发送内容」面板对 CodeAgent 会话列出它会读的规则文件和自动记忆（2026-10-14 用户要求）。
// CodeAgent 是 Claude Code 的改版：配置目录 .cac、规则文件 AGENTS.md。2026-10-14 公司真机探测确认了
// 读哪些、不读哪些（见 core/prompt-inspect.js discoverCodeAgentChain）；没测过的位置仍要标「推断」。
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
  fs.writeFileSync(path.join(project, 'AGENTS.md'), 'PROJECT-RULE\n@extra.md\n');
  fs.writeFileSync(path.join(project, 'extra.md'), 'IMPORTED-RULE');
  fs.writeFileSync(path.join(project, 'AGENTS.local.md'), 'LOCAL-RULE');
  fs.writeFileSync(path.join(base, 'work', 'AGENTS.local.md'), 'PARENT-LOCAL-RULE');
  fs.mkdirSync(path.join(project, '.cac', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(project, '.cac', 'rules', 'style.md'), 'RULES-DIR-RULE');
  // 实测不读的位置
  fs.writeFileSync(path.join(project, '.cac', 'AGENTS.md'), 'CWD-CAC-RULE');
  // Claude 的规则文件 CodeAgent 不读，不能混进来
  fs.writeFileSync(path.join(project, 'CLAUDE.md'), 'CLAUDE-ONLY');
  const memDir = path.join(configDir, 'projects', projectSlug(fs.realpathSync.native(project)), 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, 'MEMORY.md'), '- [偏好](pref.md) — 用中文回答');
  fs.writeFileSync(path.join(memDir, 'pref.md'), '用中文回答');
  return { base, configDir, project };
}

test('CodeAgent 会话：按公司实测列出规则链和自动记忆，没测过的位置标推断', () => {
  const { configDir, project } = setup();
  const insp = buildInspection({ cwd: project, kind: 'codeagent', codeagentConfigDir: configDir });
  const asm = buildAssembly(insp);
  assert.equal(asm.kind, 'codeagent');
  const texts = asm.segments.map(s => (s.text || '').trim());
  assert.deepEqual(texts, ['USER-RULE', 'PARENT-RULE', 'PARENT-LOCAL-RULE', 'PROJECT-RULE\n@extra.md', 'IMPORTED-RULE',
    'LOCAL-RULE', 'RULES-DIR-RULE', '- [偏好](pref.md) — 用中文回答']);
  for (const unread of ['CLAUDE-ONLY', 'PARENT-CAC-RULE', 'CWD-CAC-RULE']) {
    assert.ok(!texts.includes(unread), `${unread} 所在位置 CodeAgent 实测不读，不该列出`);
  }
  const evidence = asm.segments.map(s => s.evidence);
  assert.deepEqual(evidence, ['verified', 'verified', 'inferred', 'verified', 'verified', 'verified', 'verified', 'verified']);
  assert.equal(insp.totals.memoryFiles, 2);

  const composition = buildComposition({ turn: { text: 'hi' }, kind: 'codeagent', assembly: asm });
  const startup = composition.groups.find(g => g.id === 'startup');
  const memory = startup.parts.find(p => /MEMORY\.md/.test(p.title));
  assert.ok(memory, '自动记忆要出现在「会话开头自动带上的规则与记忆」里');
  assert.ok(!/推断/.test(memory.note || ''), '自动记忆索引已实测');
  const parentLocal = startup.parts.find(p => p.text === 'PARENT-LOCAL-RULE');
  assert.match(parentLocal.note, /推断/, '上层目录的 AGENTS.local.md 没测过，要标推断');
  assert.ok(startup.parts.some(p => /\.cac\/rules\/style\.md/.test(p.title)), '规则目录的文件要列出来');

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
