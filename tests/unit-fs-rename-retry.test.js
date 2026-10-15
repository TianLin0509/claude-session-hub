'use strict';
// 进程级改名重试（core/fs-rename-retry.js）：Windows 短暂占用稍等重试，其他错误立即抛出，自带重试的调用不叠加。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { wrapSync, wrapAsync, install, installed } = require('../core/fs-rename-retry');

const busy = code => Object.assign(new Error(code), { code });

test('同步：EPERM/EBUSY 重试到成功；ENOENT 立即抛；超过次数抛出并带 renameRetried 标记', () => {
  let n = 0;
  const ok = wrapSync(() => { n += 1; if (n < 3) throw busy(n === 1 ? 'EPERM' : 'EBUSY'); return 'done'; }, { sleep: () => {} });
  assert.equal(ok('a', 'b'), 'done'); assert.equal(n, 3);
  n = 0;
  const missing = wrapSync(() => { n += 1; throw busy('ENOENT'); }, { sleep: () => {} });
  assert.throws(() => missing('a', 'b'), /ENOENT/); assert.equal(n, 1);
  n = 0;
  const stuck = wrapSync(() => { n += 1; throw busy('EPERM'); }, { retries: 4, sleep: () => {} });
  assert.throws(() => stuck('a', 'b'), e => e.renameRetried === 4); assert.equal(n, 5);
});

test('异步：同样只重试 EPERM/EBUSY', async () => {
  let n = 0;
  const ok = wrapAsync(async () => { n += 1; if (n < 2) throw busy('EBUSY'); }, { delayMs: 0 });
  await ok('a', 'b'); assert.equal(n, 2);
  const missing = wrapAsync(async () => { throw busy('ENOENT'); }, { delayMs: 0 });
  await assert.rejects(missing('a', 'b'), /ENOENT/);
});

test('自带重试的 renameWithRetrySync 遇到已重试过的错误不再叠加', () => {
  const { renameWithRetrySync } = require('../core/claude-project-trust');
  let n = 0;
  const fsImpl = { renameSync: () => { n += 1; throw Object.assign(busy('EPERM'), { renameRetried: 20 }); } };
  assert.throws(() => renameWithRetrySync('a', 'b', { fsImpl, sleep: () => {} }), /EPERM/); assert.equal(n, 1);
});

test('安装：只在 Windows 生效且只装一次；单测运行器与 Hub 主进程都在最开始装上', () => {
  assert.equal(install({ platform: 'linux' }), false);
  if (process.platform === 'win32') { install(); assert.equal(installed(), true); assert.equal(install(), false); }
  const root = path.join(__dirname, '..');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.ok(main.indexOf("require('./core/fs-rename-retry').install()") < main.indexOf("require('electron')"));
  assert.match(fs.readFileSync(path.join(root, 'scripts', 'run_unit_tests.js'), 'utf8'), /\['--require', RENAME_RETRY_REGISTER\][\s\S]*spawn\(process\.execPath, \[\.\.\.RENAME_RETRY_ARGS, /);
});

test('装上后真实文件改名照常工作', () => {
  if (process.platform === 'win32') install();
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'rename-retry-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.tmp'), 'x'); fs.renameSync(path.join(dir, 'a.tmp'), path.join(dir, 'a.json'));
    assert.equal(fs.readFileSync(path.join(dir, 'a.json'), 'utf8'), 'x');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
