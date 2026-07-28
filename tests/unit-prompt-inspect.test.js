'use strict';
// core/prompt-inspect.js 的行为必须和两个 CLI 的真实发现算法一致。
// 下面每条断言都对应 2026-07-28 用本地回显代理抓真实请求体 / codex debug prompt-input
// 验证过的结论，详见 core/prompt-inspect.js 头部注释。

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
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-inspect-')));
  try {
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

console.log('Running prompt-inspect tests...');

test('projectSlug 把非字母数字压成短横（与 Claude Code 桶名一致）', () => {
  assert.strictEqual(PI.projectSlug('C:\\Vibe\\AI\\clowder-ai'), 'C--Vibe-AI-clowder-ai');
  // 中文全部塌缩 —— 这正是同父目录下同字数中文名会撞桶的原因
  assert.strictEqual(PI.projectSlug('C:\\Vibe\\AI\\AI-HUB路径重构排查'), 'C--Vibe-AI-AI-HUB------');
});

test('CLAUDE.md 链从外到内收集，且不受 git 边界限制', () => {
  withTree((root) => {
    const deep = path.join(root, 'proj', 'sub');
    fs.mkdirSync(deep, { recursive: true });
    fs.mkdirSync(path.join(root, 'proj', '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'OUTER', 'utf8');
    fs.writeFileSync(path.join(root, 'proj', 'CLAUDE.md'), 'PROJ', 'utf8');

    const chain = PI.discoverClaudeChain(deep).entries.filter(e => e.path.startsWith(root));
    const rels = chain.map(e => path.relative(root, e.path));
    // 跨过了 proj/.git 这一层，外层照样被收进来
    assert.deepStrictEqual(rels, ['CLAUDE.md', path.join('proj', 'CLAUDE.md')]);
  });
});

test('AGENTS.md 没有 CLAUDE.md 引用时被判为孤儿（Claude 读不到）', () => {
  withTree((root) => {
    const proj = path.join(root, 'proj');
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, 'AGENTS.md'), 'RULES', 'utf8');

    const chain = PI.discoverClaudeChain(proj);
    const orphans = PI.findOrphanAgentsMd(proj, chain.entries);
    assert.strictEqual(orphans.length, 1);
    assert.strictEqual(orphans[0].path, path.join(proj, 'AGENTS.md'));
  });
});

test('CLAUDE.md 用 @AGENTS.md 引入后不再是孤儿', () => {
  withTree((root) => {
    const proj = path.join(root, 'proj');
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, 'AGENTS.md'), 'RULES', 'utf8');
    fs.writeFileSync(path.join(proj, 'CLAUDE.md'), '# entry\n\n@AGENTS.md\n', 'utf8');

    const chain = PI.discoverClaudeChain(proj);
    assert.strictEqual(PI.findOrphanAgentsMd(proj, chain.entries).length, 0);
  });
});

test('@import 绝对路径被标成不生效（实测 Claude 不展开）', () => {
  withTree((root) => {
    const target = path.join(root, 'MEMORY.md');
    fs.writeFileSync(target, 'IDX', 'utf8');
    const imports = PI.expandImports(`@${target}\n@sub/rel.md\n`, root);
    const abs = imports.find(i => i.absolute);
    assert.ok(abs, '绝对路径 import 应被识别');
    assert.strictEqual(abs.effective, false, '绝对路径不生效');
    const rel = imports.find(i => !i.absolute);
    assert.strictEqual(rel.absolute, false);
  });
});

test('Codex 的 project root 由 markers 决定，且不越过它', () => {
  withTree((root) => {
    const inner = path.join(root, 'ws');
    fs.mkdirSync(inner, { recursive: true });
    fs.mkdirSync(path.join(inner, '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, '.vibe-root'), '', 'utf8');
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'ROOT', 'utf8');
    fs.writeFileSync(path.join(inner, 'AGENTS.md'), 'WS', 'utf8');

    // 直接验证纯函数逻辑：用 .vibe-root 当 marker 时 root 应上浮到 root
    const cx = PI.discoverCodexChain(inner);
    const projectEntries = cx.entries.filter(e => e.source === 'project');
    if (cx.markers.includes('.vibe-root')) {
      assert.strictEqual(cx.projectRoot, root, 'root 应上浮到 .vibe-root 所在层');
      assert.strictEqual(projectEntries.length, 2, '应收集 root + ws 两份');
    } else {
      // 未配置 .vibe-root 时退回 .git，root 落在 ws 自己
      assert.strictEqual(cx.projectRoot, inner);
      assert.strictEqual(projectEntries.length, 1);
    }
  });
});

test('记忆桶状态判定：空真实目录要被判成 EMPTY_REAL', () => {
  withTree((root) => {
    const fakeHome = path.join(root, 'home');
    const cwd = path.join(root, 'proj');
    fs.mkdirSync(cwd, { recursive: true });
    const bucket = path.join(fakeHome, '.claude', 'projects', PI.projectSlug(cwd), 'memory');
    fs.mkdirSync(bucket, { recursive: true });

    const prev = process.env.USERPROFILE;
    process.env.USERPROFILE = fakeHome;
    try {
      const mem = PI.inspectMemory(cwd);
      assert.strictEqual(mem.state, 'EMPTY_REAL');
      assert.strictEqual(mem.files, 0);
    } finally {
      process.env.USERPROFILE = prev;
    }
  });
});

test('buildInspection 产出体检结论且不抛', () => {
  withTree((root) => {
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# rules', 'utf8');
    const insp = PI.buildInspection({ cwd: root, kind: 'claude' });
    assert.ok(Array.isArray(insp.health) && insp.health.length > 0);
    assert.ok(insp.totals.ruleBytes > 0);
    assert.ok(['NOBUCKET', 'EMPTY_REAL', 'PRIVATE_REAL', 'LINKED'].includes(insp.memory.state));
  });
});

test('不存在的 cwd 也不抛（降级返回）', () => {
  const insp = PI.buildInspection({ cwd: 'C:\\__no_such_dir__\\x', kind: 'codex' });
  assert.ok(insp && insp.health);
});

if (!process.exitCode) console.log('All prompt-inspect tests passed.');
