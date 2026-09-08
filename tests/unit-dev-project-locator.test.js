'use strict';
/**
 * 项目定位（任务书第七节 / E01–E04）。
 *
 * 守的是同一句话：**界面上选的工作目录不是真相**。
 *   E01 任务里点名了项目 → 唯一确认后自主继续，不要求用户再选一次
 *   E02 界面路径不存在 / 指着别的有效仓库 → 在有效目录只读定位，不在错仓库写
 *   E03 多个同名候选、路径只是例子 → 只问一个具体问题，不猜也不满盘扫
 *   E04 仓库子目录与 worktree 都算有效现场；已核实的路径要能同步给 Hub
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const L = require('../core/dev-project-locator.js');

let pass = 0;
function test(name, fn) { fn(); pass++; console.log('  ✓ ' + name); }
function tmp(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'locator-'));
  return name ? path.join(dir, name) : dir;
}

console.log('dev-project-locator');

test('E04 .git 是文件的 worktree 同样是有效现场，不能因为不是目录就丢掉', () => {
  const repo = tmp();
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  assert.strictEqual(L.classifyRepo(repo).kind, 'repo');

  const wt = tmp();
  fs.writeFileSync(path.join(wt, '.git'), 'gitdir: C:/somewhere/.git/worktrees/x', 'utf8');
  const classified = L.classifyRepo(wt);
  assert.strictEqual(classified.kind, 'worktree');
  assert.strictEqual(classified.valid, true, 'worktree 是合法现场');
  assert.strictEqual(classified.worktree, true);
});

test('E04 仓库子目录能认出所属仓库根', () => {
  const repo = tmp();
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const sub = path.join(repo, 'src', 'deep');
  fs.mkdirSync(sub, { recursive: true });
  const classified = L.classifyRepo(sub);
  assert.strictEqual(classified.kind, 'subdir');
  assert.strictEqual(path.resolve(classified.repoRoot), path.resolve(repo));
});

test('不是仓库就是不是，不要顺手认下来', () => {
  const plain = tmp();
  assert.strictEqual(L.classifyRepo(plain).valid, false);
  assert.strictEqual(L.classifyRepo(path.join(plain, '不存在')).valid, false);
});

test('E02 界面路径不存在 → 退到最近的存在祖先，并标明这是纠正过的', () => {
  const root = tmp();
  const real = path.join(root, 'projects');
  fs.mkdirSync(real, { recursive: true });
  const missing = path.join(real, 'ghost', 'deeper');
  const resolved = L.resolveLaunchDir(missing, root);
  assert.strictEqual(resolved.corrected, true);
  assert.strictEqual(path.resolve(resolved.dir), path.resolve(real));
  assert.strictEqual(resolved.requested, missing, '要把用户原本配的那个路径带出来，界面上才说得清');
});

test('路径存在时一个字都不改', () => {
  const root = tmp();
  const resolved = L.resolveLaunchDir(root, 'C:/whatever');
  assert.strictEqual(resolved.corrected, false);
  assert.strictEqual(path.resolve(resolved.dir), path.resolve(root));
});

test('聚合根不能被当成落脚点', () => {
  assert.strictEqual(L.isAggregateRoot('C:\\Users\\lintian'), true);
  assert.strictEqual(L.isAggregateRoot('C:/Vibe'), true);
  assert.strictEqual(L.isAggregateRoot('C:\\Users\\lintian\\claude-session-hub'), false);
});

test('E01 任务里点名了项目 → 唯一命中，直说用它、不要求用户再选', () => {
  const projects = [
    { name: 'AI 群聊 Hub', path: 'C:\\Users\\lintian\\claude-session-hub' },
    { name: '初心投研', path: 'C:\\Users\\lintian\\chuxin-research' },
  ];
  const matched = L.matchProjects('请改一下 AI 群聊 Hub 的开发流程', projects);
  assert.strictEqual(matched.length, 1);
  const block = L.buildLocatorBlock({
    taskText: '请改一下 AI 群聊 Hub 的开发流程', projects,
    launch: { dir: 'C:\\Users\\lintian', corrected: false }, atWorkRoot: true,
  });
  assert(/唯一确认/.test(block));
  assert(/不要再问维护者选哪个/.test(block), 'E01 明确要求：唯一确认就自主继续');
  assert(block.includes('C:\\Users\\lintian\\claude-session-hub'));
});

test('E03 多个候选 → 只问一个具体问题，不许自己挑', () => {
  const projects = [
    // 同名不同路径：这就是任务书 E03 说的「多个同名候选」
    { name: '报告工具', path: 'C:\\a\\report-tool' },
    { name: '报告工具', path: 'C:\\b\\report-tool' },
  ];
  const block = L.buildLocatorBlock({
    taskText: '改一下报告工具的导出', projects,
    launch: { dir: 'C:\\work', corrected: false },
  });
  assert(/无法唯一确定/.test(block));
  assert(/只问一个具体问题/.test(block));
  assert(/不要自己挑一个开始改/.test(block));
  assert(block.includes('C:\\a\\report-tool') && block.includes('C:\\b\\report-tool'), '候选要列全');
});

test('E03 任务里的路径可能只是例子；一个都对不上时要求问，不满盘扫', () => {
  const block = L.buildLocatorBlock({
    taskText: '照着 C:\\somewhere\\example.md 里写的做',
    projects: [{ name: '别的项目', path: 'C:\\x\\other' }],
    launch: { dir: 'C:\\work', corrected: false },
  });
  assert(/没有能唯一确定项目的线索/.test(block));
  assert(/可能只是\*\*例子或引用\*\*|只是\*\*例子/.test(block) || /例子或引用/.test(block));
  assert(/不许全盘搜索/.test(block) && /聚合根/.test(block));
  assert(/不许自动 git init/.test(block), '不许自动初始化一个新仓库');
});

test('E02 路径被纠正过时，prompt 必须明说这只是落脚点、先别写文件', () => {
  const block = L.buildLocatorBlock({
    taskText: '随便什么任务', projects: [],
    launch: { dir: 'C:\\work', corrected: true, requested: 'C:\\work\\ghost', reason: 'configured_path_missing' },
  });
  assert(/现在不存在/.test(block));
  assert(/不是\*\*目标项目|不是目标项目/.test(block) || /不是\*\*目标项目\*\*/.test(block));
  assert(/确认之前不要在这里写任何文件/.test(block), 'E02 的要害就是别在错地方写');
});

test('E04 开题报告里的「项目根」行能被读出来，且只有核实通过才允许绑定', () => {
  const repo = tmp();
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const report = ['# 开题报告', '## 目标', 'x', '', `项目根：${repo}`, '## 非目标', 'y'].join('\n');
  assert.strictEqual(L.extractDeclaredProjectRoot(report), repo);
  assert.strictEqual(L.extractDeclaredProjectRoot('没有这一行'), null);
  assert.strictEqual(L.verifyDeclaredProjectRoot(repo).ok, true);

  const notRepo = tmp();
  assert.strictEqual(L.verifyDeclaredProjectRoot(notRepo).ok, false, '不是仓库不给绑');
  assert.strictEqual(L.verifyDeclaredProjectRoot('C:\\Users\\lintian').ok, false, '聚合根不给绑');
  assert.strictEqual(L.verifyDeclaredProjectRoot(path.join(repo, '不存在')).ok, false, '不存在不给绑');
});

test('引擎会把这段说明拼进每一步，且交接文档目录和工作目录互不相干', () => {
  const engine = fs.readFileSync(path.join(__dirname, '..', 'main', 'groupchat', 'loop-engine.js'), 'utf8');
  assert(/withLocator\(withDocBlock\(/.test(engine), '开题 / 实现 / 审查三步都要带定位说明');
  assert((engine.match(/withLocator\(/g) || []).length >= 4);
  assert(/bindProjectRootFromReport\(meetingId, reportPath\)/.test(engine),
    '开题报告接收后要把已核实的项目根绑到本群');
  const docs = fs.readFileSync(path.join(__dirname, '..', 'core', 'dev-task-docs.js'), 'utf8');
  assert(/taskDocsDir\(hubDataDir, meetingId\)/.test(docs) && !/workspace/.test(docs),
    '交接文档目录只由 Hub 数据目录和群聊 id 决定 —— 项目路径怎么纠正都不会让 Hub 去等旧地址');
});

console.log(`\n${pass} passed`);
