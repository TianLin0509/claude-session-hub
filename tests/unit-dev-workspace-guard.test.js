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

test('默认工作根这种「存在但不是仓库」的目录被挡住', () => {
  // 这就是用户问的那一种：C:\AIWork 真实存在，只是它不是任何项目。
  const v = checkDevWorkspace(PLAIN);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.reason, 'not-a-repo');
  assert(v.message.includes('git 仓库'), '要说清楚为什么不行');
  assert(v.message.includes('通用'), '要给出「只想随便问一句」的出路，别把人堵死');
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

test('选「开发」场景时把 workspace 默认档切成「选择已有路径」', () => {
  // 默认档是平铺工作根，对开发场景一定是错的。不替用户切，等于明知会错还放着。
  assert(/radio\.value === 'dev' && _meetingWorkspaceMode !== 'existing'/.test(modal),
    '选中 dev 时要检查当前档位');
  assert(/_meetingWorkspaceMode = 'existing'/.test(modal), '要切到 existing');
  // 悄悄替用户改档位而不说一声，下次他会以为是自己选的。那块提示 DOM 本来就在，一直空着。
  assert(/hint\.textContent = '开发场景要开在项目根上/.test(modal),
    '切档位的同时要在界面上说明为什么');
  assert(/project-prep/.test(modal), '提示里要点名该跑哪个 skill');
});

try { require('child_process').execSync(`cmd /c rmdir /S /Q "${ROOT}"`, { stdio: 'ignore' }); } catch (e) {}
console.log('\n──────────────');
console.log('通过 ' + pass + ' / 失败 0');
