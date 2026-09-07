'use strict';
/**
 * 版本号自动抬升 —— 复现用户实际踩到的那次打回，再证明它不会再发生。
 *
 * 真实事故（2026-09-06）：两个开发群聊并行开发 Hub。
 *   第一轮 合并位报「版本与最新主干同为 1.6.83，须同步提升三处版本」→ 打回；
 *   第二轮 工作位再抬一次，dry-run 直接在 package.json / package-lock.json 上
 *          合并冲突，测试都没跑就退出码 1 → 再打回。
 * 每一轮打回 = 一次完整实现 + 一次全量单测，代价很大，而问题本身毫无技术含量。
 *
 * 根因不是谁写错了，是「让分支自己抬版本号」这条规则在并行开发下结构性必然冲突：
 * 那三行是所有分支都要改的同三行，而「我是第几个合进去的」只有合并那一刻才知道。
 *
 * 这里用真 git + 真 python 跑完整合并脚本，覆盖：
 *   B1 分支完全不碰版本号 → 合并脚本自己抬，落在同一个合并提交里
 *   B2 两个分支都按老习惯抬到同一个值 → 第二个不再冲突，自动化解并重新抬
 *   B3 版本号文件里有真冲突（不只是版本行）→ 仍然照旧报冲突，不许糊弄过去
 *   B4 项目没配 versionBump → 一个字节都不动（SuperRAN 这类项目的行为不变）
 *   B5 定点替换不许误伤同名同值的依赖条目
 *   B7 --dry-run（合并位每次先跑的那条）抬完版本后必须完整回滚
 */
const assert = require('assert');
const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const ROOT = path.join(os.tmpdir(), 'merge-version-autobump-' + Date.now());

let pass = 0;
const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf-8' }).trim();
const commit = (dir, msg) => execSync(`git commit -q -m "${msg}"`,
  { cwd: dir, stdio: 'pipe', env: { ...process.env, HUB_ALLOW_MAIN_COMMIT: '1' } });

function pkgJson(version) {
  return JSON.stringify({ name: 'demo', version, private: true, scripts: { start: 'node .' } }, null, 2) + '\n';
}
// 真实 lockfile 的形状：顶层一处、packages[""] 一处，外加一个**版本号恰好相同**的依赖条目。
// 那个依赖条目是这个测试的重点之一 —— 按字符串全局替换的写法会连它一起改掉，
// 而那种破坏不会报错，只会在下一次 npm ci 时爆炸。
function lockJson(version) {
  return JSON.stringify({
    name: 'demo', version, lockfileVersion: 3, requires: true,
    packages: {
      '': { name: 'demo', version, dependencies: { leftpad: '^1.0.0' } },
      'node_modules/leftpad': { version, resolved: 'https://example.invalid/leftpad', license: 'MIT' },
    },
  }, null, 2) + '\n';
}

function makeRepo(name, { versionBump = true } = {}) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.agents'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'scripts', 'merge_task.py'), path.join(dir, 'scripts', 'merge_task.py'));
  fs.copyFileSync(path.join(REPO, 'scripts', 'bump-version.js'), path.join(dir, 'scripts', 'bump-version.js'));
  // 测试命令顺带守住「三处一致」，和 Hub 的 unit-hub-version-sync 是同一条不变量。
  fs.writeFileSync(path.join(dir, 'scripts', 'check.js'), [
    'const fs=require("fs");',
    'const pkg=JSON.parse(fs.readFileSync("package.json","utf8"));',
    'const lock=JSON.parse(fs.readFileSync("package-lock.json","utf8"));',
    'if(lock.version!==pkg.version||lock.packages[""].version!==pkg.version){console.error("版本三处不一致");process.exit(1);}',
    'process.exit(0);',
  ].join('\n'), 'utf-8');
  fs.writeFileSync(path.join(dir, '.agents', 'project.json'), JSON.stringify({
    name, trunk: 'main', test: ['node scripts/check.js'], afterMerge: [],
    ...(versionBump ? { versionFiles: ['package.json', 'package-lock.json'], versionBump: ['node scripts/bump-version.js'] } : {}),
  }, null, 2), 'utf-8');
  fs.writeFileSync(path.join(dir, 'package.json'), pkgJson('1.0.0'), 'utf-8');
  fs.writeFileSync(path.join(dir, 'package-lock.json'), lockJson('1.0.0'), 'utf-8');
  fs.writeFileSync(path.join(dir, '.gitignore'), '__pycache__/\n*.pyc\n', 'utf-8');
  sh('git init -q -b main', dir);
  sh('git config user.email s@s && git config user.name s', dir);
  sh('git add -A', dir);
  commit(dir, 'base');
  return dir;
}

/** 造一个分支：改一个业务文件，并可选地按老习惯自己抬版本号。 */
function makeBranch(dir, branch, file, { bumpTo = '', base = 'main' } = {}) {
  sh(`git checkout -q -b ${branch} ${base}`, dir);
  fs.writeFileSync(path.join(dir, file), branch + '\n', 'utf-8');
  if (bumpTo) {
    fs.writeFileSync(path.join(dir, 'package.json'), pkgJson(bumpTo), 'utf-8');
    fs.writeFileSync(path.join(dir, 'package-lock.json'), lockJson(bumpTo), 'utf-8');
  }
  sh('git add -A', dir);
  commit(dir, branch);
  sh('git checkout -q main', dir);
}

function merge(dir, branch, extra) {
  const r = spawnSync('python', [path.join(dir, 'scripts', 'merge_task.py'), branch, ...(extra || [])],
    { cwd: dir, encoding: 'utf-8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const versionOf = dir => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
const lockOf = dir => JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'));

function test(name, fn) { fn(); pass++; console.log('  ✓ ' + name); }

fs.mkdirSync(ROOT, { recursive: true });
console.log('merge-version-autobump');

test('B1 · 分支完全不碰版本号，合并脚本自己抬，且落在那个合并提交里', () => {
  const dir = makeRepo('clean');
  makeBranch(dir, 'feat/a', 'a.txt');
  const r = merge(dir, 'feat/a');
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(versionOf(dir), '1.0.1', '合并后主干版本必须已经 +1');
  assert.strictEqual(lockOf(dir).version, '1.0.1');
  assert.strictEqual(lockOf(dir).packages[''].version, '1.0.1');
  // 必须进合并提交，不能变成一个游离在工作区里的未提交改动
  assert.strictEqual(sh('git status --porcelain', dir), '', '合并后工作区必须是干净的');
  const shown = sh('git show --stat --oneline HEAD', dir);
  assert(/package\.json/.test(shown) && /package-lock\.json/.test(shown), '版本号改动必须在合并提交里：' + shown);
});

test('B2 · 两个分支都按老习惯抬到同一个值 —— 正是被打回两次的那个场景', () => {
  const dir = makeRepo('collide');
  // 两个分支都基于 1.0.0 起步，都自己抬到 1.0.1（各自都以为自己是第一个）
  makeBranch(dir, 'feat/a', 'a.txt', { bumpTo: '1.0.1' });
  makeBranch(dir, 'feat/b', 'b.txt', { bumpTo: '1.0.1' });

  const first = merge(dir, 'feat/a');
  assert.strictEqual(first.code, 0, first.out);
  assert.strictEqual(versionOf(dir), '1.0.2', '第一个合进来的以主干值为准继续抬');

  // 老行为在这里会 CONFLICT (content): package.json，退出码 1，测试都跑不到
  const second = merge(dir, 'feat/b');
  assert.strictEqual(second.code, 0, '第二个分支不该再因为版本号被打回：\n' + second.out);
  assert(/只有版本号撞了/.test(second.out), '应当明确说明是自动化解的版本号冲突：\n' + second.out);
  assert.strictEqual(versionOf(dir), '1.0.3');
  assert.strictEqual(lockOf(dir).packages[''].version, '1.0.3');
  assert.strictEqual(sh('git status --porcelain', dir), '', '化解冲突后不许留半合状态');
  // 两个分支的业务改动都必须在
  assert(fs.existsSync(path.join(dir, 'a.txt')) && fs.existsSync(path.join(dir, 'b.txt')));
});

test('B3 · 版本号文件里有真冲突时照旧报冲突，不许被自动化解糊弄过去', () => {
  const dir = makeRepo('real-conflict');
  // 两个分支都改 package.json 的 description（不是版本行），必然真冲突
  const withDesc = (v, d) => JSON.stringify({ name: 'demo', version: v, private: true, description: d, scripts: { start: 'node .' } }, null, 2) + '\n';
  for (const [branch, desc] of [['feat/x', '来自 X'], ['feat/y', '来自 Y']]) {
    sh(`git checkout -q -b ${branch} main`, dir);
    fs.writeFileSync(path.join(dir, 'package.json'), withDesc('1.0.1', desc), 'utf-8');
    sh('git add -A', dir);
    commit(dir, branch);
    sh('git checkout -q main', dir);
  }
  assert.strictEqual(merge(dir, 'feat/x').code, 0);
  const second = merge(dir, 'feat/y');
  assert.strictEqual(second.code, 1, '真冲突必须仍然打回：\n' + second.out);
  assert(/冲突/.test(second.out), second.out);
  assert.strictEqual(sh('git status --porcelain', dir), '', '失败后不许留半合状态');
  assert.strictEqual(sh('git rev-list --count main', dir), '3', '失败必须完整回滚，主干不许前进');
});

test('B4 · 项目没配 versionBump 时行为一个字节都不变', () => {
  const dir = makeRepo('unconfigured', { versionBump: false });
  makeBranch(dir, 'feat/a', 'a.txt');
  const r = merge(dir, 'feat/a');
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(versionOf(dir), '1.0.0', '没配就不许动版本号');
  assert(!/抬版本号/.test(r.out), '没配就不该出现这一步：\n' + r.out);
});

test('B5 · 定点替换不许误伤版本号恰好相同的依赖条目', () => {
  const dir = makeRepo('lookalike');
  makeBranch(dir, 'feat/a', 'a.txt');
  assert.strictEqual(merge(dir, 'feat/a').code, 0);
  const lock = lockOf(dir);
  assert.strictEqual(lock.version, '1.0.1');
  assert.strictEqual(lock.packages[''].version, '1.0.1');
  assert.strictEqual(lock.packages['node_modules/leftpad'].version, '1.0.0',
    '依赖自己的 version 与本项目无关，被改掉是一种不报错、只会在 npm ci 时爆炸的破坏');
  // 只应改到 3 行以内（package.json 1 行 + lock 2 行）
  const stat = sh('git show --numstat --format= HEAD -- package.json package-lock.json', dir);
  for (const line of stat.split('\n').filter(Boolean)) {
    const [added, removed] = line.split('\t');
    assert(Number(added) <= 2 && Number(removed) <= 2, '改动行数异常，可能整份重写了：' + line);
  }
});

test('B7 · --dry-run 抬完版本跑完测试后必须完整回滚（合并位每次都先跑它）', () => {
  const dir = makeRepo('dryrun');
  makeBranch(dir, 'feat/a', 'a.txt');
  const r = merge(dir, 'feat/a', ['--dry-run']);
  assert.strictEqual(r.code, 0, r.out);
  assert(/抬版本号/.test(r.out), 'dry-run 也要抬版本，否则验的不是将要合进去的那份代码');
  assert.strictEqual(versionOf(dir), '1.0.0', 'dry-run 结束必须把版本号还原');
  assert.strictEqual(sh('git status --porcelain', dir), '', 'dry-run 不许留下未提交的版本号改动');
  assert.strictEqual(sh('git rev-list --count main', dir), '1', 'dry-run 不许推进主干');
  // 紧接着真合，仍然从主干的值开始抬
  assert.strictEqual(merge(dir, 'feat/a').code, 0);
  assert.strictEqual(versionOf(dir), '1.0.1');
});

test('B6 · 版本号不是纯数字三段式时明确报错，不猜', () => {
  const bump = require('../scripts/bump-version.js');
  assert.strictEqual(bump.bumpPatch('1.6.87'), '1.6.88');
  assert.throws(() => bump.bumpPatch('1.7.0-beta.1'), /三段式/);
  assert.strictEqual(bump.setJsonPathString('{\n  "a": 1\n}', ['version'], '2.0.0'), null,
    '定位不到目标路径必须返回 null，让调用方整体失败，而不是改错地方');
});

try {
  execSync(`cmd /c rmdir /S /Q "${ROOT}"`, { stdio: 'ignore' });
} catch (e) { /* 清理失败不影响结论 */ }

console.log('\n──────────────');
console.log('通过 ' + pass + ' / 失败 0');
