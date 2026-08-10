'use strict';
// Claude Code buckets `memory/` by cwd, so every fresh _scratch\inbox-* task used
// to start with an empty memory store while the real library sat in the home
// bucket. These tests pin the junction that reconnects them.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { canonicalMemoryDir, ensureMemoryLink } = require('../core/claude-memory-link.js');
const { CLAUDE_PROJECT_ROOT_DIRS, projectSlug } = require('../core/claude-transcript-locator.js');

const SESSION_MANAGER_SRC = fs.readFileSync(path.join(__dirname, '..', 'core', 'session-manager.js'), 'utf8');
const MEMORY_LINK_SRC = fs.readFileSync(path.join(__dirname, '..', 'core', 'claude-memory-link.js'), 'utf8');

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

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-memlink-'));
  try {
    const canonical = canonicalMemoryDir(home);
    fs.mkdirSync(canonical, { recursive: true });
    fs.writeFileSync(path.join(canonical, 'MEMORY.md'), '# Memory Router\n', 'utf8');
    fn(home, canonical);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

console.log('Running claude memory link tests...');

test('canonical store is the home directory bucket', () => {
  const home = 'C:\\Users\\lintian';
  assert.strictEqual(
    canonicalMemoryDir(home),
    path.join(home, '.claude', 'projects', 'C--Users-lintian', 'memory'),
  );
});

test('a fresh scratch cwd gets memory linked for every CLI root', () => {
  withHome((home, canonical) => {
    const cwd = 'C:\\Vibe\\_scratch\\inbox-abc';
    const result = ensureMemoryLink(cwd, { homeDir: home, logger: { warn() {} } });

    assert.deepStrictEqual(result.errors, []);
    assert.strictEqual(result.linked.length, CLAUDE_PROJECT_ROOT_DIRS.length,
      'claude and deepseek roots must both see the shared library');
    for (const root of CLAUDE_PROJECT_ROOT_DIRS) {
      const linked = path.join(home, root, 'projects', projectSlug(cwd), 'memory');
      assert.ok(fs.lstatSync(linked).isSymbolicLink(), `${root} must be a junction`);
      assert.strictEqual(fs.readFileSync(path.join(linked, 'MEMORY.md'), 'utf8'), '# Memory Router\n');
    }
    assert.ok(fs.existsSync(canonical), 'canonical store must be untouched');
  });
});

test('a provider-scoped call touches only that provider bucket', () => {
  withHome((home) => {
    const cwd = 'C:\\Vibe\\_scratch\\provider-scoped';
    const slug = projectSlug(cwd);
    const result = ensureMemoryLink(cwd, {
      homeDir: home,
      projectRootDirs: ['.claude'],
      logger: { warn() {} },
    });

    assert.deepStrictEqual(result.errors, []);
    assert.strictEqual(result.linked.length, 1);
    assert.ok(fs.existsSync(path.join(home, '.claude', 'projects', slug, 'memory')));
    assert.strictEqual(fs.existsSync(path.join(home, '.claude-deepseek', 'projects', slug)), false,
      'Claude spawn must not manufacture an empty DeepSeek bucket');
  });
});

// 2026-07-29 三方审查——本用例语义整体翻转，理由记在这里供下一轮复核：
//
// 原断言是「真实 memory 目录永不被替换」（skip + 保持非 symlink）。它保护的是**目录**，
// 而用户真正要的是**记忆能被读到**，两者在这里是冲突的：实测生产环境
// `C--Vibe--scratch-inbox-20260727-231940-87d878` 桶里被这条 skip 困死了 22,780 字节的
// 无线大赛项目记忆（当天上午还在写），任何别的 cwd 一个字都读不到，且这条路径保证它
// 永不自愈；同一小时内又新长出一个空目录孤岛，证明是持续产生。
//
// 「项目私有记忆」从来不是设计目标——见 claude-memory-link.js 头注释：Hub 每个任务都开在
// 新的 _scratch/inbox-*，做这个 junction 就是为了让记忆库全局共享。私有桶是 skip 的副产品。
//
// 所以现在断言更强的性质：**一个字都不能丢**（并入规范库 + 同名不覆盖 + 原目录留底），
// 而不是「目录别动」。
test('an existing real memory directory is merged into the canonical store, never lost', () => {
  withHome((home) => {
    const cwd = 'C:\\Vibe\\AI\\has-own-memory';
    const own = path.join(home, '.claude', 'projects', projectSlug(cwd), 'memory');
    fs.mkdirSync(own, { recursive: true });
    fs.writeFileSync(path.join(own, 'MEMORY.md'), 'project-local\n', 'utf8');
    fs.writeFileSync(path.join(own, 'island-only.md'), 'ISLAND ONLY\n', 'utf8');

    const canonicalDir = canonicalMemoryDir(home);
    const canonicalIndexBefore = fs.readFileSync(path.join(canonicalDir, 'MEMORY.md'), 'utf8');

    const result = ensureMemoryLink(cwd, { homeDir: home, logger: { warn() {}, log() {} } });

    assert.ok(fs.lstatSync(own).isSymbolicLink(), '桶必须换成 junction，否则记忆仍是孤岛');
    assert.strictEqual(fs.readFileSync(path.join(own, 'island-only.md'), 'utf8'), 'ISLAND ONLY\n',
      '独有记忆必须并入规范库并可通过 junction 读到');
    assert.strictEqual(fs.readFileSync(path.join(canonicalDir, 'MEMORY.md'), 'utf8'), canonicalIndexBefore,
      '同名文件绝不覆盖规范库（MEMORY.md 两边都在写）');
    assert.ok(fs.readdirSync(canonicalDir).some(name => name.startsWith('MEMORY.island-') && name.endsWith('.md')),
      '冲突的那份要另存待人工比对，不能悄悄丢弃');
    const bucketDir = path.dirname(own);
    assert.ok(fs.readdirSync(bucketDir).some(n => n.startsWith('memory.island-backup-')),
      '原目录必须留底，整个操作可回滚');
    assert.ok(result.merged.some(x => x.endsWith('island-only.md')), 'merged 要如实上报');
    assert.ok(result.conflicts.some(x => x.endsWith('MEMORY.md')), 'conflicts 要如实上报');
  });
});

test('same-name identical files are deduplicated instead of creating fake conflicts', () => {
  withHome((home, canonical) => {
    const cwd = 'C:\\Vibe\\AI\\same-memory';
    const own = path.join(home, '.claude', 'projects', projectSlug(cwd), 'memory');
    fs.mkdirSync(own, { recursive: true });
    fs.writeFileSync(path.join(own, 'MEMORY.md'), '# Memory Router\n', 'utf8');

    const result = ensureMemoryLink(cwd, { homeDir: home, logger: { warn() {}, log() {} } });
    assert.ok(fs.lstatSync(own).isSymbolicLink());
    assert.strictEqual(result.conflicts.length, 0);
    assert.ok(result.deduplicated.some(x => x.endsWith('/MEMORY.md')));
    assert.strictEqual(fs.readdirSync(canonical).filter(n => n.startsWith('MEMORY.island-')).length, 0);
  });
});

test('nested or special entries hard-stop before writes and leave the real directory visible', () => {
  withHome((home, canonical) => {
    const cwd = 'C:\\Vibe\\AI\\nested-memory';
    const own = path.join(home, '.claude', 'projects', projectSlug(cwd), 'memory');
    fs.mkdirSync(path.join(own, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(own, 'nested', 'note.md'), 'KEEP VISIBLE\n', 'utf8');

    const result = ensureMemoryLink(cwd, { homeDir: home, logger: { warn() {}, log() {} } });
    assert.ok(result.errors.some(x => x.includes('非普通文件')));
    assert.strictEqual(fs.lstatSync(own).isSymbolicLink(), false);
    assert.strictEqual(fs.readFileSync(path.join(own, 'nested', 'note.md'), 'utf8'), 'KEEP VISIBLE\n');
    assert.ok(!fs.existsSync(path.join(canonical, 'note.md')));
  });
});

test('a junction to the wrong store is reported and never overwritten silently', () => {
  withHome((home) => {
    const cwd = 'C:\\Vibe\\AI\\wrong-link';
    const own = path.join(home, '.claude', 'projects', projectSlug(cwd), 'memory');
    const alternate = path.join(home, 'alternate-memory');
    fs.mkdirSync(path.dirname(own), { recursive: true });
    fs.mkdirSync(alternate, { recursive: true });
    fs.writeFileSync(path.join(alternate, 'private.md'), 'PRIVATE\n', 'utf8');
    fs.symlinkSync(alternate, own, 'junction');

    const result = ensureMemoryLink(cwd, { homeDir: home, logger: { warn() {}, log() {} } });
    assert.ok(result.errors.some(x => x.includes('没有指向规范库')));
    assert.ok(fs.lstatSync(own).isSymbolicLink());
    assert.strictEqual(fs.realpathSync.native(own), fs.realpathSync.native(alternate));
    assert.strictEqual(fs.readFileSync(path.join(own, 'private.md'), 'utf8'), 'PRIVATE\n');
  });
});

test('junction failure restores the source and rolls back files copied into canonical', () => {
  withHome((home, canonical) => {
    const cwd = 'C:\\Vibe\\AI\\link-fails';
    const own = path.join(home, '.claude', 'projects', projectSlug(cwd), 'memory');
    fs.mkdirSync(own, { recursive: true });
    fs.writeFileSync(path.join(own, 'only-here.md'), 'SOURCE\n', 'utf8');
    const originalSymlink = fs.symlinkSync;
    fs.symlinkSync = () => { throw new Error('synthetic link failure'); };
    try {
      const result = ensureMemoryLink(cwd, { homeDir: home, logger: { warn() {}, log() {} } });
      assert.ok(result.errors.length >= 1);
    } finally {
      fs.symlinkSync = originalSymlink;
    }
    assert.strictEqual(fs.lstatSync(own).isSymbolicLink(), false);
    assert.strictEqual(fs.readFileSync(path.join(own, 'only-here.md'), 'utf8'), 'SOURCE\n');
    assert.ok(!fs.existsSync(path.join(canonical, 'only-here.md')), 'partial canonical copy must be rolled back');
  });
});

test('linking the canonical bucket to itself is a no-op', () => {
  withHome((home) => {
    const result = ensureMemoryLink(home, { homeDir: home, logger: { warn() {} } });
    assert.deepStrictEqual(result.errors, []);
    assert.strictEqual(result.linked.includes(canonicalMemoryDir(home)), false);
    assert.ok(fs.existsSync(path.join(canonicalMemoryDir(home), 'MEMORY.md')));
  });
});

test('missing canonical store degrades to a no-op instead of creating junk', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-memlink-empty-'));
  try {
    const result = ensureMemoryLink('C:\\Vibe\\_scratch\\inbox-x', { homeDir: home, logger: { warn() {} } });
    assert.deepStrictEqual(result.linked, []);
    assert.deepStrictEqual(result.errors, []);
    assert.strictEqual(result.skipped.length, 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('session-manager links memory only for Claude-family consumers and skips isolated hubs', () => {
  // 这条断言两轮内因为「行内写法变了」失配了两次（先是 cwd fallback 改多行块，再是
  // ensureMemoryLink 的返回值要被接住）。锁死行内写法会让每次正当重构都撞一次，
  // 所以改成结构性断言：只验证两层守卫的嵌套顺序，不管里面怎么写。
  const guardAt = SESSION_MANAGER_SRC.search(/if \(!process\.env\.CLAUDE_HUB_DATA_DIR\) \{/);
  const familyAt = SESSION_MANAGER_SRC.indexOf('if (isClaude || isDeepSeekLegacy) {', guardAt);
  const linkAt = SESSION_MANAGER_SRC.indexOf('ensureMemoryLink(spawnCwd,', familyAt);
  assert.ok(
    guardAt > 0 && familyAt > guardAt && linkAt > familyAt,
    'only Claude / migration-only DeepSeek may mutate Claude memory buckets, never Codex-backed DeepSeek / Kimi / PowerShell or isolated E2E',
  );
  // 2026-07-29：fallback 从单行 `if (!spawnCwd) spawnCwd = ...` 改成多行块（要给回落
  // 留痕 cwdFellBack），原来的字面量匹配失配。断言的意图没变——link 必须在 cwd 定下来
  // 之后跑，所以改成匹配块的起始行，顺序检查照旧。
  const spawnAt = SESSION_MANAGER_SRC.indexOf('ensureMemoryLink(spawnCwd,');
  const cwdAt = SESSION_MANAGER_SRC.search(/if \(!spawnCwd\) \{/);
  assert.ok(cwdAt > 0 && spawnAt > cwdAt, 'link must run after the cwd fallback is resolved');
  // 回落必须留痕：静默回 Home 会让「规则没注入 / 记忆是空的 / 产物写错地方」同时发生
  // 而现场没有任何线索指向 cwd（2026-07-29 三方审查，Codex 2 提出）。
  assert.match(SESSION_MANAGER_SRC, /cwdFellBackFrom/, 'cwd 回落必须在 session 上留痕供 UI 提示');
  assert.match(MEMORY_LINK_SRC, /acquireLock\(lockPath\)/,
    'multiple Hub processes must serialize merge + rename + junction for the same bucket');
  assert.match(MEMORY_LINK_SRC, /finally \{[\s\S]*releaseLock\(lockFd, lockPath\)/,
    'memory link lock must be released on every success/failure/continue path');
});

if (!process.exitCode) console.log('All claude memory link tests passed.');
