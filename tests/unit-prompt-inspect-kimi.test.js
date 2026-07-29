'use strict';
// core/prompt-inspect.js 的 kimi 分支单测。
// 断言依据 2026-07-29 探针实测（4 组路径起真实 kimi 会话 + wire.jsonl 核对 From 来源）：
//   - 只读 AGENTS.md，最近 .git 根向下收集到 cwd，嵌套 git 仓库会挡住外层
//   - 没有 .git 时退化为只读 cwd 自己那一份
//   - 全局 = ~/.kimi-code/AGENTS.md；无 Claude 式 memory 桶 → 记忆检查按 kind 跳过

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PI = require('../core/prompt-inspect.js');

function test(name, fn) {
  try {
    fn();
    console.log(`  OK ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

function withTree(fn) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-kimi-inspect-')));
  try {
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// 项目级条目 = 在 tmp root 内的那部分（全局 ~/.kimi-code/AGENTS.md 视本机情况可有可无）
function projectEntries(chain, root) {
  return chain.entries.filter(e => e.path.startsWith(root));
}

console.log('Running prompt-inspect kimi tests...');

test('kimi 链：.git 根向下收集到 cwd，根之上的 AGENTS.md 不读', () => {
  withTree((root) => {
    const deep = path.join(root, 'proj', 'sub', 'deep');
    fs.mkdirSync(deep, { recursive: true });
    fs.mkdirSync(path.join(root, 'proj', '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'OUTER', 'utf8');           // git 根之上 → 不读
    fs.writeFileSync(path.join(root, 'proj', 'AGENTS.md'), 'PROJ', 'utf8');
    fs.writeFileSync(path.join(root, 'proj', 'sub', 'AGENTS.md'), 'SUB', 'utf8');

    const chain = PI.discoverKimiChain(deep);
    assert.strictEqual(chain.projectRoot, path.join(root, 'proj'));
    assert.deepStrictEqual(chain.markers, ['.git']);
    const rels = projectEntries(chain, root).map(e => path.relative(root, e.path));
    assert.deepStrictEqual(rels, [path.join('proj', 'AGENTS.md'), path.join('proj', 'sub', 'AGENTS.md')]);
  });
});

test('kimi 链：嵌套 git 仓库挡住外层根', () => {
  withTree((root) => {
    const deep = path.join(root, 'outer', 'inner', 'sub');
    fs.mkdirSync(deep, { recursive: true });
    fs.mkdirSync(path.join(root, 'outer', '.git'), { recursive: true });
    fs.mkdirSync(path.join(root, 'outer', 'inner', '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, 'outer', 'AGENTS.md'), 'OUTER', 'utf8');   // 被内层 .git 挡住
    fs.writeFileSync(path.join(root, 'outer', 'inner', 'AGENTS.md'), 'INNER', 'utf8');

    const chain = PI.discoverKimiChain(deep);
    assert.strictEqual(chain.projectRoot, path.join(root, 'outer', 'inner'));
    const rels = projectEntries(chain, root).map(e => path.relative(root, e.path));
    assert.deepStrictEqual(rels, [path.join('outer', 'inner', 'AGENTS.md')]);
  });
});

test('kimi 链：没有 .git 时只读 cwd 自己那一份', () => {
  withTree((root) => {
    const sub = path.join(root, 'plain', 'sub');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(root, 'plain', 'AGENTS.md'), 'PARENT', 'utf8');  // 父目录 → 不读
    fs.writeFileSync(path.join(sub, 'AGENTS.md'), 'CWD', 'utf8');

    const chain = PI.discoverKimiChain(sub);
    assert.strictEqual(chain.projectRoot, null);
    const rels = projectEntries(chain, root).map(e => path.relative(root, e.path));
    assert.deepStrictEqual(rels, [path.join('plain', 'sub', 'AGENTS.md')]);
  });
});

test('kimi 体检：不再报 CLAUDE.md 链，也不再有记忆桶假警告', () => {
  withTree((root) => {
    const proj = path.join(root, 'proj');
    fs.mkdirSync(proj, { recursive: true });
    fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'AGENTS.md'), 'RULES', 'utf8');

    const insp = PI.buildInspection({ cwd: proj, kind: 'kimi' });
    const titles = insp.health.map(c => c.title + ' ' + c.detail).join('\n');
    assert.ok(!titles.includes('CLAUDE.md'), `kimi 体检不应出现 CLAUDE.md 链：\n${titles}`);
    assert.ok(!titles.includes('记忆桶') && !titles.includes('桶名已塌缩') && !titles.includes('规范库'),
      `kimi 体检不应出现记忆桶检查：\n${titles}`);
    assert.ok(insp.health.some(c => c.title.includes('AGENTS.md')), '应报告 AGENTS.md 份数');
    assert.ok(insp.health.some(c => c.title.startsWith('project root')), '应报告 project root');
  });
});

test('kimi 体检：无 .git 时给出明确警告', () => {
  withTree((root) => {
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain, { recursive: true });
    const insp = PI.buildInspection({ cwd: plain, kind: 'kimi' });
    assert.ok(insp.health.some(c => c.level === 'warn' && c.title.includes('.git')),
      '无 .git 应警告只读 cwd');
  });
});

test('kimi 的 ruleBytes 按 AGENTS.md 链（kimi）统计，不按 CLAUDE.md 链', () => {
  withTree((root) => {
    const proj = path.join(root, 'proj');
    fs.mkdirSync(proj, { recursive: true });
    fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'AGENTS.md'), 'RULES', 'utf8');
    fs.writeFileSync(path.join(proj, 'CLAUDE.md'), 'X'.repeat(500), 'utf8');    // 干扰项：不应计入

    const insp = PI.buildInspection({ cwd: proj, kind: 'kimi' });
    const kimiBytes = insp.kimi.entries.reduce((s, e) => s + e.bytes, 0);
    assert.strictEqual(insp.totals.ruleBytes, kimiBytes);
  });
});

test('kimi 拼装预览：只拼 kimi 链，无 memory 索引段', () => {
  withTree((root) => {
    const proj = path.join(root, 'proj');
    fs.mkdirSync(proj, { recursive: true });
    fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'AGENTS.md'), 'RULES', 'utf8');

    const insp = PI.buildInspection({ cwd: proj, kind: 'kimi' });
    const asm = PI.buildAssembly(insp);
    assert.strictEqual(asm.kind, 'kimi');
    assert.ok(asm.segments.every(s => s.role !== 'memory-index'), 'kimi 不应有 memory 索引段');
    const fromProj = asm.segments.filter(s => s.path.startsWith(root));
    assert.strictEqual(fromProj.length, 1);
    assert.strictEqual(path.basename(fromProj[0].path), 'AGENTS.md');
  });
});

test('claude / codex 分支行为未被 kimi 改动影响', () => {
  withTree((root) => {
    const proj = path.join(root, 'proj');
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, 'CLAUDE.md'), 'C', 'utf8');

    const claudeInsp = PI.buildInspection({ cwd: proj, kind: 'claude' });
    const claudeTitles = claudeInsp.health.map(c => c.title).join('\n');
    assert.ok(claudeTitles.includes('CLAUDE.md'), 'claude 仍检查 CLAUDE.md 链');
    assert.ok(claudeTitles.includes('记忆'), 'claude 仍检查记忆桶');

    const codexInsp = PI.buildInspection({ cwd: proj, kind: 'codex' });
    const codexTitles = codexInsp.health.map(c => c.title).join('\n');
    assert.ok(codexTitles.includes('AGENTS.md'), 'codex 仍检查 AGENTS.md 链');
    assert.ok(codexTitles.includes('记忆'), 'codex 仍检查记忆桶');
  });
});
