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

// 勘误（2026-07-29）：本用例原本断言「绝对路径 import 不展开」。用本地捕获代理抓
// Claude Code 的真实请求体实测推翻了这个假设——探针 CLAUDE.md 里写
// `@C:/…/abs-target.md`，目标文件正文的标记 MK_ABS_EXPAND_0003 确实出现在请求体中。
// 判定改为：目标存在即 effective，与相对/绝对无关；不存在才不生效。
test('@import 绝对路径同样会展开，只有目标不存在才不生效', () => {
  withTree((root) => {
    const target = path.join(root, 'MEMORY.md');
    fs.writeFileSync(target, 'IDX', 'utf8');
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'sub', 'rel.md'), 'REL', 'utf8');
    const imports = PI.expandImports(`@${target}\n@sub/rel.md\n@sub/missing.md\n`, root);

    const abs = imports.find(i => i.absolute);
    assert.ok(abs, '绝对路径 import 应被识别');
    assert.strictEqual(abs.exists, true);
    assert.strictEqual(abs.effective, true, '绝对路径目标存在时会被展开');

    const rel = imports.find(i => !i.absolute && i.spec === 'sub/rel.md');
    assert.strictEqual(rel.effective, true, '相对路径目标存在时会被展开');

    const dead = imports.find(i => i.spec === 'sub/missing.md');
    assert.strictEqual(dead.exists, false);
    assert.strictEqual(dead.effective, false, '目标不存在才不生效');
  });
});

// 去重：链里已有的文件被 @import 再引一次，不产生第二份正文（抓包实测 Claude 按
// 解析后路径去重）。段仍列出但标 duplicateOf、零字节、不占偏移。
test('buildAssembly 对已注入过的路径去重，不假报重复注入', () => {
  withTree((root) => {
    const inner = path.join(root, 'proj');
    fs.mkdirSync(inner, { recursive: true });
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'ROOT-RULES', 'utf8');
    // 内层 CLAUDE.md 反过来 @import 外层那份——外层本来就在链上
    fs.writeFileSync(path.join(inner, 'CLAUDE.md'), `@${path.join(root, 'CLAUDE.md')}\nINNER`, 'utf8');

    const insp = PI.buildInspection({ cwd: inner, kind: 'claude' });
    const asm = PI.buildAssembly(insp);
    const rootKey = path.resolve(root, 'CLAUDE.md').toLowerCase();
    const hits = asm.segments.filter(s => String(s.path || '').toLowerCase() === rootKey);
    assert.ok(hits.length >= 2, '重复引用的段应当仍被列出，便于用户看见死配置');
    assert.strictEqual(hits.filter(s => !s.duplicateOf).length, 1, '只有一份真正带正文');
    const dup = hits.find(s => s.duplicateOf);
    assert.strictEqual(dup.bytes, 0, '重复段不计字节');
    assert.strictEqual(dup.start, dup.end, '重复段不占偏移');
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
