const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const { parsePorcelain } = require('../core/worktree/git-probe');

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gprobe-'));
  cp.execSync('git init -q -b main', { cwd: dir });
  cp.execSync('git config user.email t@t', { cwd: dir });
  cp.execSync('git config user.name t', { cwd: dir });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one');
  cp.execSync('git add . && git commit -q -m init', { cwd: dir });
  return dir;
}

let pass = 0, fail = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ✓ ${name}`); pass++; })
    .catch(e => { console.log(`  ✗ ${name}\n    ${e.message}`); fail++; });
}

(async () => {
  console.log('git-probe parsePorcelain:');

  await test('解析 branch.head 与 ahead/behind', () => {
    const input = [
      '# branch.oid abc123',
      '# branch.head master',
      '# branch.upstream origin/master',
      '# branch.ab +2 -1',
    ].join('\n');
    const r = parsePorcelain(input);
    assert.strictEqual(r.branch, 'master');
    assert.strictEqual(r.ahead, 2);
    assert.strictEqual(r.behind, 1);
    assert.deepStrictEqual(r.dirty, []);
  });

  await test('解析 unmerged 行', () => {
    const input = [
      '# branch.head main',
      '# branch.ab +0 -0',
      'u UU N... 100644 100644 100644 100644 abc def ghi src/conflict.js',
    ].join('\n');
    const r = parsePorcelain(input);
    assert.strictEqual(r.dirty.length, 1);
    assert.deepStrictEqual(r.dirty[0], { path: 'src/conflict.js', status: 'C' });
  });

  await test('解析 modified / untracked / renamed', () => {
    const input = [
      '# branch.head main',
      '# branch.ab +0 -0',
      '1 .M N... 100644 100644 100644 abc def src/foo.js',
      '? notes.md',
      '2 R. N... 100644 100644 100644 ghi jkl R100 src/new.js\tsrc/old.js',
    ].join('\n');
    const r = parsePorcelain(input);
    assert.strictEqual(r.branch, 'main');
    assert.strictEqual(r.dirty.length, 3);
    assert.deepStrictEqual(r.dirty[0], { path: 'src/foo.js', status: 'M' });
    assert.deepStrictEqual(r.dirty[1], { path: 'notes.md', status: 'U' });
    assert.deepStrictEqual(r.dirty[2], { path: 'src/new.js', status: 'R', from: 'src/old.js' });
  });

  await test('无 upstream 时 ahead/behind 都是 0', () => {
    const input = '# branch.head feat-x\n';
    const r = parsePorcelain(input);
    assert.strictEqual(r.ahead, 0);
    assert.strictEqual(r.behind, 0);
  });

  await test('parseWorktreeList: 解析多 worktree', () => {
    const { parseWorktreeList } = require('../core/worktree/git-probe');
    const input = [
      'worktree C:/repos/main',
      'HEAD abc123',
      'branch refs/heads/master',
      '',
      'worktree C:/temp/feat-x',
      'HEAD def456',
      'branch refs/heads/feat-x',
      '',
    ].join('\n');
    const r = parseWorktreeList(input);
    assert.strictEqual(r.length, 2);
    assert.deepStrictEqual(r[0], { cwd: 'C:/repos/main', head: 'abc123', branch: 'master' });
    assert.deepStrictEqual(r[1], { cwd: 'C:/temp/feat-x', head: 'def456', branch: 'feat-x' });
  });

  await test('parseWorktreeList: detached HEAD', () => {
    const { parseWorktreeList } = require('../core/worktree/git-probe');
    const input = 'worktree C:/repos/x\nHEAD abc\ndetached\n';
    const r = parseWorktreeList(input);
    assert.strictEqual(r[0].branch, null);
  });

  await test('parseWorktreeList: refs/remotes branch falls back to bare slice', () => {
    const { parseWorktreeList } = require('../core/worktree/git-probe');
    const input = 'worktree C:/x\nHEAD abc\nbranch refs/remotes/origin/main\n';
    const r = parseWorktreeList(input);
    assert.strictEqual(r[0].branch, 'refs/remotes/origin/main');
  });

  const { probeRepo, _resetCacheForTest } = require('../core/worktree/git-probe');

  await test('probeRepo: 真仓库返回 isRepo=true 与 branch', async () => {
    _resetCacheForTest();
    const dir = makeRepo();
    const r = await probeRepo(dir, { force: true });
    assert.strictEqual(r.isRepo, true);
    assert.strictEqual(r.branch, 'main');
    assert.strictEqual(r.repoRoot, fs.realpathSync(dir));
    assert.deepStrictEqual(r.dirty, []);
  });

  await test('probeRepo: 修改文件后 dirty 含该文件', async () => {
    _resetCacheForTest();
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'two');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'new');
    const r = await probeRepo(dir, { force: true });
    const paths = r.dirty.map(d => d.path).sort();
    assert.deepStrictEqual(paths, ['a.txt', 'b.txt']);
  });

  await test('probeRepo: 非 git 目录 → isRepo=false', async () => {
    _resetCacheForTest();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nogit-'));
    const r = await probeRepo(dir, { force: true });
    assert.strictEqual(r.isRepo, false);
  });

  await test('probeRepo: 缓存命中（同 cwd 30s 内不重复 spawn）', async () => {
    _resetCacheForTest();
    const dir = makeRepo();
    const t1 = Date.now();
    await probeRepo(dir, { force: true });
    const t2 = Date.now();
    await probeRepo(dir);  // 第二次必须命中缓存
    const t3 = Date.now();
    assert.ok((t3 - t2) < (t2 - t1) / 2, '第二次应明显更快');
  });

  await test('probeRepo: 同 cwd 并发去重 (spawn 计数)', async () => {
    _resetCacheForTest();
    const dir = makeRepo();
    const cp = require('child_process');
    const origSpawn = cp.spawn;
    let spawnCount = 0;
    cp.spawn = function(...args) { spawnCount++; return origSpawn.apply(this, args); };
    try {
      await Promise.all([probeRepo(dir, { force: true }), probeRepo(dir, { force: true })]);
      // 单次 probeRepo 内部最多 spawn 4 次（rev-parse toplevel + rev-parse common-dir + status + log）
      // 并发两次去重成功 → 仍是 4 次（共享同一 in-flight Promise）
      // 去重失败 → 8 次
      assert.ok(spawnCount <= 4, `expected <= 4 spawns, got ${spawnCount}`);
    } finally {
      cp.spawn = origSpawn;
    }
  });

  await test('probeRepo: 真实 worktree 共享 gitCommonDir', async () => {
    _resetCacheForTest();
    const main = makeRepo();
    const wt = path.join(os.tmpdir(), 'gprobe-wt-' + Date.now());
    cp.execSync(`git -C "${main}" worktree add "${wt}" -b feat-wt-test HEAD`, { shell: true });
    try {
      const a = await probeRepo(main, { force: true });
      const b = await probeRepo(wt, { force: true });
      assert.ok(a.gitCommonDir, 'main has gitCommonDir');
      assert.ok(b.gitCommonDir, 'wt has gitCommonDir');
      assert.strictEqual(a.gitCommonDir, b.gitCommonDir, 'same gitCommonDir for main + wt');
      assert.notStrictEqual(a.repoRoot, b.repoRoot, 'different repoRoot for main vs wt');
    } finally {
      try { cp.execSync(`git -C "${main}" worktree remove "${wt}" --force`, { shell: true }); } catch (_) {}
    }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
