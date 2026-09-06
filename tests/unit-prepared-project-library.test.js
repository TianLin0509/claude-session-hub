'use strict';
/**
 * 项目库：建群弹窗「选择已有路径 → 项目库」那个下拉里列的东西。
 *
 * 守两条最容易错的：linked worktree 不能混进来（否则同一个项目出现十几次），
 * 以及排序要按活跃时间而不是按注册顺序。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { listPreparedProjects, inspectPreparedProject } = require('../core/prepared-project-library.js');

let pass = 0;
function test(name, fn) { fn(); pass++; console.log('  ✓ ' + name); }

console.log('prepared-project-library');

const ROOT = path.join(os.tmpdir(), 'preplib-' + Date.now());
const HUB = path.join(ROOT, 'hub');            // 整理过，主工作树
const RAN = path.join(ROOT, 'ran');            // 整理过，主工作树，但更早活跃
const WT = path.join(ROOT, 'hub-worktree');    // linked worktree：.git 是文件
const RAW = path.join(ROOT, 'raw-repo');       // 仓库但没整理
const PLAIN = path.join(ROOT, 'plain');        // 普通目录
const NONAME = path.join(ROOT, 'no-name');     // 整理过但 project.json 没写 name

function mkRepo(dir, cfg) {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/master\n', 'utf-8');
  if (cfg) {
    fs.mkdirSync(path.join(dir, '.agents'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.agents', 'project.json'), JSON.stringify(cfg), 'utf-8');
  }
}
mkRepo(HUB, { name: 'AI HUB', trunk: 'master' });
mkRepo(RAN, { name: 'SuperRAN', trunk: 'main' });
mkRepo(RAW, null);
mkRepo(NONAME, { trunk: 'master' });
fs.mkdirSync(PLAIN, { recursive: true });
fs.mkdirSync(path.join(WT, '.agents'), { recursive: true });
fs.writeFileSync(path.join(WT, '.git'), 'gitdir: ' + path.join(HUB, '.git', 'worktrees', 'x') + '\n', 'utf-8');
fs.writeFileSync(path.join(WT, '.agents', 'project.json'), JSON.stringify({ name: 'AI HUB' }), 'utf-8');

// 把 .git 的活动文件时间都拨到过去，让测试自己控制 activeAt
const OLD = new Date(2020, 0, 1);
for (const d of [HUB, RAN, RAW, NONAME]) fs.utimesSync(path.join(d, '.git', 'HEAD'), OLD, OLD);

test('只认「.git 是目录 + 有 .agents/project.json」的目录，其它全部过滤', () => {
  const items = listPreparedProjects([
    { path: HUB }, { path: RAN }, { path: WT }, { path: RAW }, { path: PLAIN },
    { path: path.join(ROOT, 'does-not-exist') }, { path: '' }, null,
  ]);
  const paths = items.map(i => i.path);
  assert(paths.includes(HUB) && paths.includes(RAN), '整理过的主工作树必须在');
  assert(!paths.includes(WT), 'linked worktree 不能混进项目库，否则同一项目会重复出现');
  assert(!paths.includes(RAW), '没整理过的仓库不算');
  assert(!paths.includes(PLAIN), '普通目录不算');
  assert.strictEqual(items.length, 2);
});

test('中文名取 project.json 的 name，缺 name 用目录名', () => {
  const items = listPreparedProjects([{ path: HUB }, { path: NONAME }]);
  const hub = items.find(i => i.path === HUB);
  const noname = items.find(i => i.path === NONAME);
  assert.strictEqual(hub.name, 'AI HUB');
  assert.strictEqual(hub.trunk, 'master');
  assert.strictEqual(noname.name, 'no-name');
});

test('按活跃时间降序；同一路径多次出现取最大活跃时间', () => {
  // 时间戳都要晚于上面拨到 2020 的 .git mtime，否则 mtime 兜底会盖过这里的输入
  const T = Date.UTC(2024, 0, 1);
  const items = listPreparedProjects([
    { path: RAN, activeAt: T + 1000 },
    { path: HUB, activeAt: T + 500 },
    { path: HUB + path.sep, activeAt: T + 3000 },   // 尾随分隔符也算同一路径
    { path: HUB.toUpperCase(), activeAt: T + 200 },  // Windows 大小写不敏感
  ]);
  assert.deepStrictEqual(items.map(i => i.name), ['AI HUB', 'SuperRAN']);
  assert.strictEqual(items[0].activeAt, T + 3000);
  assert.strictEqual(items.filter(i => i.name === 'AI HUB').length, 1, '去重后只能有一条');
});

test('Hub 没记录过活跃时间时，用 .git 里的活动文件 mtime 兜底', () => {
  const recent = new Date();
  fs.utimesSync(path.join(RAN, '.git', 'HEAD'), recent, recent);
  const items = listPreparedProjects([{ path: HUB, activeAt: 0 }, { path: RAN, activeAt: 0 }]);
  assert.strictEqual(items[0].name, 'SuperRAN', '刚在别的终端动过的项目要排前面');
  assert(items[0].activeAt > items[1].activeAt);
});

test('project.json 坏掉的项目不崩，当作没整理过', () => {
  const broken = path.join(ROOT, 'broken');
  mkRepo(broken, null);
  fs.mkdirSync(path.join(broken, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(broken, '.agents', 'project.json'), '{not json', 'utf-8');
  assert.strictEqual(inspectPreparedProject(broken), null);
  assert.strictEqual(listPreparedProjects([{ path: broken }]).length, 0);
});

try { require('child_process').execSync(`cmd /c rmdir /S /Q "${ROOT}"`, { stdio: 'ignore' }); } catch (e) {}
console.log('\n──────────────');
console.log('通过 ' + pass + ' / 失败 0');
