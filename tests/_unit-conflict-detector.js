const assert = require('assert');
const { classify } = require('../core/worktree/conflict-detector');

let pass = 0, fail = 0;
function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { console.log(`  ✓ ${name}`); pass++; })
    .catch(e => { console.log(`  ✗ ${name}\n    ${e.message}`); fail++; });
}

const repoA = { isRepo: true, cwd: 'C:/a', repoRoot: 'C:/a', dirty: [{path:'src/foo.js'}] };
const repoAOther = { isRepo: true, cwd: 'C:/a', repoRoot: 'C:/a', dirty: [{path:'src/bar.js'}] };
const wtA = { isRepo: true, cwd: 'C:/wt-a', repoRoot: 'C:/a', dirty: [{path:'src/foo.js'}] };
const wtAClean = { isRepo: true, cwd: 'C:/wt-a2', repoRoot: 'C:/a', dirty: [] };
const repoB = { isRepo: true, cwd: 'C:/b', repoRoot: 'C:/b', dirty: [] };

(async () => {
  await test('1. 单飞 git repo → green', () => {
    assert.strictEqual(classify(repoA, []).color, 'green');
  });
  await test('2. 非 repo → green', () => {
    assert.strictEqual(classify({ isRepo: false }, [repoA]).color, 'green');
  });
  await test('3. 同 cwd peer → red', () => {
    const r = classify(repoA, [{ ...repoAOther, sessionId: 'S2' }]);
    assert.strictEqual(r.color, 'red');
    assert.ok(r.reasons.some(s => /同 cwd/.test(s)));
  });
  await test('4. 同 repo 不同 cwd 撞文件 → red', () => {
    const r = classify(repoA, [{ ...wtA, sessionId: 'S2' }]);
    assert.strictEqual(r.color, 'red');
    assert.ok(r.reasons.some(s => /改同文件/.test(s) && /src\/foo\.js/.test(s)));
  });
  await test('5. 同 repo 不同 cwd 不撞文件 → yellow', () => {
    const r = classify(repoA, [{ ...wtAClean, sessionId: 'S2' }]);
    assert.strictEqual(r.color, 'yellow');
  });
  await test('6. 多 peer：1 红 1 黄 → red', () => {
    const r = classify(repoA, [
      { ...wtAClean, sessionId: 'S2' },
      { ...repoAOther, sessionId: 'S3' },
    ]);
    assert.strictEqual(r.color, 'red');
  });
  await test('7. peer 在不同 repo → green', () => {
    const r = classify(repoA, [{ ...repoB, sessionId: 'S2' }]);
    assert.strictEqual(r.color, 'green');
  });

  await test('8. 不同 worktree 同 gitCommonDir → 同 repo 黄', () => {
    const wtMain  = { isRepo: true, cwd: 'C:/repo',     repoRoot: 'C:/repo',     gitCommonDir: 'C:/repo/.git', dirty: [{path:'foo.js'}] };
    const wtFeatA = { isRepo: true, cwd: 'C:/wt-a',     repoRoot: 'C:/wt-a',     gitCommonDir: 'C:/repo/.git', dirty: [{path:'bar.js'}] };
    const r = classify(wtMain, [{ ...wtFeatA, sessionId: 'S2' }]);
    assert.strictEqual(r.color, 'yellow');
  });

  await test('9. 不同 worktree 同 gitCommonDir 撞文件 → 红', () => {
    const wtMain  = { isRepo: true, cwd: 'C:/repo', repoRoot: 'C:/repo', gitCommonDir: 'C:/repo/.git', dirty: [{path:'foo.js'}] };
    const wtFeatA = { isRepo: true, cwd: 'C:/wt-a', repoRoot: 'C:/wt-a', gitCommonDir: 'C:/repo/.git', dirty: [{path:'foo.js'}] };
    const r = classify(wtMain, [{ ...wtFeatA, sessionId: 'S2' }]);
    assert.strictEqual(r.color, 'red');
    assert.ok(r.reasons.some(s => /改同文件/.test(s) && /foo\.js/.test(s)));
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
