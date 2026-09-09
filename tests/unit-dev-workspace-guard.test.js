'use strict';
/**
 * 开发场景的工作目录闸门。
 *
 * 用户问的正是这个：「假如我工作目录选择默认目录 AIWork 会怎么样？AI 不会自己切过去吗？」
 * 答案是**不会**——dev-task 预设读的是「本仓库的 .agents/AUTHOR.md」，仓库内相对路径。
 * cwd 落在平铺工作根上，agent 找不到那个文件，而它并不知道你指的是哪个项目。
 *
 * 更糟的是建群弹窗**默认就选着「默认工作目录」**，也就是说不动手就一定踩中。
 * 所以这一条要在建群那一刻挡住，而不是等几分钟后在第一步空转。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkDevWorkspace } = require('../renderer/dev-workspace-guard.js');

let pass = 0;
function test(name, fn) { fn(); pass++; console.log('  ✓ ' + name); }

console.log('dev-workspace-guard');

const ROOT = path.join(os.tmpdir(), 'devwsguard-' + Date.now());
const PLAIN = path.join(ROOT, 'flat-work-root');          // 像 C:\AIWork：存在，但不是仓库
const REPO_RAW = path.join(ROOT, 'repo-not-prepared');    // 是仓库，但没整理过
const REPO_OK = path.join(ROOT, 'repo-prepared');         // 整理过
const A_FILE = path.join(ROOT, 'a-file.txt');

fs.mkdirSync(PLAIN, { recursive: true });
fs.mkdirSync(path.join(REPO_RAW, '.git'), { recursive: true });
fs.mkdirSync(path.join(REPO_OK, '.git'), { recursive: true });
fs.mkdirSync(path.join(REPO_OK, '.agents'), { recursive: true });
fs.writeFileSync(path.join(REPO_OK, '.agents', 'project.json'),
  JSON.stringify({ trunk: 'master', test: ['echo ok'] }), 'utf-8');
fs.writeFileSync(A_FILE, 'x', 'utf-8');

test('整理过的仓库放行', () => {
  const v = checkDevWorkspace(REPO_OK);
  assert.strictEqual(v.ok, true, '有 .git 和 .agents/project.json 就该放行');
  assert.strictEqual(v.reason, 'ready');
});

test('「存在但不是仓库」的目录，没告诉闸门它是工作根时仍然挡住', () => {
  // 临时目录、随便选的文件夹都走这条：既不是项目，也没有项目库语义。
  const v = checkDevWorkspace(PLAIN);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.reason, 'not-a-repo');
  assert(v.message.includes('git 仓库'), '要说清楚为什么不行');
  assert(v.message.includes('项目库'), '要告诉用户有一键选项目的路');
  assert(v.message.includes('通用'), '要给出「只想随便问一句」的出路，别把人堵死');
});

test('2026-09-06：平铺工作根本身放行，reason 标成 work-root 让建群路径去拼项目库', () => {
  // 用户的原话：「允许用户选择默认路径（AIwork），但是后续给 AI 的提示词里要加上，
  // 让 AI 自己根据用户提问找到对应的项目路径」。放行的代价由 prompt 承担，不由闸门承担。
  const v = checkDevWorkspace(PLAIN, { workRoot: PLAIN });
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.reason, 'work-root');
  // 路径写法差异不能让它误判：尾随分隔符、正反斜杠、大小写
  assert.strictEqual(checkDevWorkspace(PLAIN + path.sep, { workRoot: PLAIN }).reason, 'work-root');
  assert.strictEqual(checkDevWorkspace(PLAIN.replace(/\\/g, '/'), { workRoot: PLAIN }).reason, 'work-root');
  assert.strictEqual(checkDevWorkspace(PLAIN.toUpperCase(), { workRoot: PLAIN }).reason, 'work-root');
  // 给了工作根但选的是别的非仓库目录：照挡
  const other = path.join(ROOT, 'other-plain');
  fs.mkdirSync(other, { recursive: true });
  assert.strictEqual(checkDevWorkspace(other, { workRoot: PLAIN }).reason, 'not-a-repo');
  // 给了工作根、选的是整理过的项目：正常放行，reason 仍是 ready（不是 work-root）
  assert.strictEqual(checkDevWorkspace(REPO_OK, { workRoot: PLAIN }).reason, 'ready');
});

test('是仓库但没整理过 —— 报错要直接给出下一步命令', () => {
  const v = checkDevWorkspace(REPO_RAW);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.reason, 'not-prepared');
  assert(v.message.includes('project-prep'), '必须点名 skill，否则用户不知道该干嘛');
  assert(v.message.includes('.agents/AUTHOR.md'), '要说清楚缺的是什么');
  assert(v.message.includes('一次性'), '要说明整理只做一次，不是每个群聊都要');
});

test('路径为空 / 只有空格', () => {
  for (const bad of ['', '   ', null, undefined]) {
    const v = checkDevWorkspace(bad);
    assert.strictEqual(v.ok, false, JSON.stringify(bad));
    assert.strictEqual(v.reason, 'no-path');
  }
});

test('目录不存在', () => {
  const v = checkDevWorkspace(path.join(ROOT, 'nope-does-not-exist'));
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.reason, 'not-found');
});

test('选中的是文件不是目录', () => {
  const v = checkDevWorkspace(A_FILE);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.reason, 'not-dir');
});

test('.agents 存在但缺 project.json 仍然算没整理过', () => {
  const half = path.join(ROOT, 'repo-half');
  fs.mkdirSync(path.join(half, '.git'), { recursive: true });
  fs.mkdirSync(path.join(half, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(half, '.agents', 'AUTHOR.md'), '# x', 'utf-8');
  const v = checkDevWorkspace(half);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.reason, 'not-prepared');
});

test('fs 抛别的错也不能崩，按「找不到」处理', () => {
  const boom = { statSync() { throw new Error('EPERM'); } };
  const v = checkDevWorkspace('C:/whatever', { fs: boom });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.reason, 'not-found');
});

// ── 契约：光有函数不算数，得真的接在建群那条路上 ──────────────────────
const modal = fs.readFileSync(
  path.join(__dirname, '..', 'renderer', 'meeting-create-modal.js'), 'utf-8');

test('建群时 dev 场景确实调用了闸门，且在 create-meeting 之前', () => {
  assert(/checkDevWorkspace/.test(modal), '必须引用闸门');
  const iGuard = modal.indexOf('checkDevWorkspace(workspace');
  const iCreate = modal.indexOf("invoke('create-meeting'");
  assert(iGuard > 0 && iCreate > 0, '两处都要在');
  assert(iGuard < iCreate, '闸门必须挡在真正建群之前，否则挡了也白挡');
  assert(/if \(!verdict\.ok\) throw new Error\(verdict\.message\)/.test(modal),
    '不通过必须抛出，让用户看到那段说明');
});

test('选「开发」场景不再替用户切档位；说明文字要把两条路都讲清', () => {
  // 2026-09-06 用户明确：不想每次找项目路径。默认档留给 AI 自己定位（见 work-root 用例），
  // 想指定项目就走「选择已有路径 → 项目库」一键选。
  assert(!/radio\.value === 'dev' && _meetingWorkspaceMode !== 'existing'/.test(modal),
    '不许再在选中 dev 时强制切到 existing');
  assert(/hint\.textContent = '开发场景要开在项目根上/.test(modal), '说明文字仍然要有');
  const hintAt = modal.indexOf("hint.textContent = '开发场景要开在项目根上");
  const hintBody = modal.slice(hintAt, hintAt + 400);
  assert(/默认工作目录/.test(hintBody) && /项目库/.test(hintBody),
    '说明要同时提到「默认工作目录也行」和「项目库一键选」');
  assert(/project-prep/.test(modal), '提示里要点名该跑哪个 skill');
});

test('「选择已有路径」那一行有项目库下拉：点开列已整理项目，点一项即选中', () => {
  // 用户的原话：「AI HUB 就应该作为一个选项，我点击就行，不需要我自己输入路径去找」
  assert(/id="mcm-project-library-button"/.test(modal), '要有「项目库」按钮');
  assert(/id="mcm-project-library"/.test(modal) && /role="listbox"/.test(modal), '要有下拉列表容器');
  assert(/invoke\('workspace:prepared-projects'\)/.test(modal), '数据要从主进程的项目库接口来');
  assert(/data-mcm-project-path/.test(modal), '每一项要带路径');
  assert(/invoke\('workspace:select', item\.path\)/.test(modal),
    '点选后要走 workspace:select 归一化，和「选择文件夹…」同一条路');
  // 切到 existing 且没选过目录：先展开项目库，而不是直接弹系统对话框
  const switchAt = modal.indexOf("_meetingWorkspaceMode === 'existing' && !_meetingWorkspace");
  const switchBody = modal.slice(switchAt, switchAt + 600);
  assert(/_toggleProjectLibrary\(true\)/.test(switchBody), '切档后先展开项目库');
  assert(/if \(!items\.length\)/.test(switchBody) && /_chooseMeetingExistingWorkspace\(\)/.test(switchBody),
    '项目库为空才回落到系统对话框');
  // 主进程接口真的注册了，且不递归扫盘
  const handlers = fs.readFileSync(path.join(__dirname, '..', 'main', 'ipc', 'workspace-handlers.js'), 'utf-8');
  assert(/ipcMain\.handle\('workspace:prepared-projects'/.test(handlers), '主进程要注册 workspace:prepared-projects');
  assert(/prepared-project-library\.js/.test(handlers), '要用 core 里的项目库模块，不在 IPC 里重写判据');
  assert(!/readdirSync\([^)]*recursive/.test(handlers), '不许递归扫盘');
});

try { require('child_process').execSync(`cmd /c rmdir /S /Q "${ROOT}"`, { stdio: 'ignore' }); } catch (e) {}
console.log('\n──────────────');
test('阻断 失效目录不该在建房这一刻硬报错：有像样的落脚点就放行并带回它', () => {
  // 任务书第七节：不存在的 cwd 会让 CLI 在启动前就失败，Hub 应当在**有效目录**
  // 进入只读定位流程，而不是把用户挡在建房外面（2026-09-08 合并位在真实入口复现）。
  const SEP = String.fromCharCode(92);
  // 真实场景：用户选的是某个项目里已经被删掉的子目录 / 过期 worktree 路径。
  const REPO = 'C:' + SEP + 'projects' + SEP + 'demo';
  const files = new Set([REPO, [REPO, '.git'].join(SEP), [REPO, '.agents', 'project.json'].join(SEP)]);
  const fakeFs = {
    statSync(target) {
      if (!files.has(target)) throw new Error('ENOENT');
      return { isDirectory: () => !target.endsWith('project.json') };
    },
  };
  const verdict = checkDevWorkspace([REPO, 'ghost', 'deeper'].join(SEP), { fs: fakeFs });
  assert.strictEqual(verdict.ok, true, '路径所属的项目还在，就不该把用户挡在建房外');
  assert.strictEqual(verdict.reason, 'ready-fallback');
  assert.strictEqual(verdict.resolvedRoot, REPO, '要退回它所属的项目根');
  assert.ok(/不存在/.test(verdict.message), '得让用户看见路径被纠正过');
});

test('落脚点不属于任何项目时，仍然如实报「目录不存在」', () => {
  // 退到一个随便什么存在的文件夹并不能解决问题，只是把失败推迟到第一步。
  const SEP = String.fromCharCode(92);
  const PLAIN = 'C:' + SEP + 'tmpdir';
  const files = new Set([PLAIN]);
  const fakeFs = {
    statSync(target) {
      if (!files.has(target)) throw new Error('ENOENT');
      return { isDirectory: () => true };
    },
  };
  assert.strictEqual(checkDevWorkspace([PLAIN, 'ghost'].join(SEP), { fs: fakeFs }).reason, 'not-found');
  const nothing = { statSync() { throw new Error('ENOENT'); } };
  assert.strictEqual(checkDevWorkspace(['Z:', 'nope', 'deeper'].join(SEP), { fs: nothing }).reason, 'not-found');
});

test('合法仓库子目录不该被拦：向上找到仓库根，并把它带回给调用方', () => {
  // 用户选到 repo/src 时，原来只看 repo/src/.git 在不在 → 判成「不是 git 仓库」，
  // 但那明明就是那个项目（2026-09-08 合并位在真实隔离 IPC 上复现）。
  const SEP = String.fromCharCode(92);          // Windows 路径分隔符，避免源码里堆转义
  const ROOT = 'C:' + SEP + 'repo';
  const at = (...parts) => [ROOT, ...parts].join(SEP);
  const files = new Set([ROOT, at('.git'), at('.agents', 'project.json'), at('src'), at('src', 'deep')]);
  const fakeFs = {
    statSync(target) {
      if (!files.has(target)) throw new Error('ENOENT');
      return { isDirectory: () => !target.endsWith('project.json') };
    },
  };
  const verdict = checkDevWorkspace(at('src', 'deep'), { fs: fakeFs });
  assert.strictEqual(verdict.ok, true, '子目录必须放行');
  assert.strictEqual(verdict.reason, 'ready-subdir');
  assert.strictEqual(verdict.resolvedRoot, ROOT, '要把仓库根带回去，建群按它走');
  assert.strictEqual(checkDevWorkspace(ROOT, { fs: fakeFs }).reason, 'ready', '本来就在根上还是 ready');
});

test('worktree（.git 是文件）同样放行', () => {
  const SEP = String.fromCharCode(92);
  const WT = 'C:' + SEP + 'wt';
  const files = new Set([WT, [WT, '.git'].join(SEP), [WT, '.agents', 'project.json'].join(SEP)]);
  const fakeFs = {
    statSync(target) {
      if (!files.has(target)) throw new Error('ENOENT');
      return { isDirectory: () => target === WT };   // .git 是文件，不是目录
    },
  };
  assert.strictEqual(checkDevWorkspace(WT, { fs: fakeFs }).ok, true);
});

test('建群时子目录会被换成仓库根', () => {
  const modal = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'meeting-create-modal.js'), 'utf-8');
  assert(/verdict\.reason === 'ready-subdir' \|\| verdict\.reason === 'ready-fallback'/.test(modal),
    '子目录和「路径被纠正过」两种都要按带回来的项目根建群');
  assert(/workspace = \{ \.\.\.workspace, path: verdict\.resolvedRoot \}/.test(modal));
});

console.log('通过 ' + pass + ' / 失败 0');
