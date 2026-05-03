const assert = require('assert');
const { parsePorcelain } = require('../core/worktree/git-probe');

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

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
