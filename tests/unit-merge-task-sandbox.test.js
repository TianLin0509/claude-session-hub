'use strict';
/**
 * 合并脚本 · 沙箱实测。
 *
 * merge_task.py 是整条流水线上唯一「不靠 AI 自觉」的一环 —— 它亲自跑测试、
 * 决定合还是不合。所以它自己必须被真跑一遍，不能只靠读代码判断。
 *
 * 用一次性 git 仓库跑真实路径：正常合入 / 测试失败自动回滚 / 脏工作区拒绝 /
 * 主干已被别人推进过时先对齐。不碰 AI HUB，也不碰 SuperRAN。
 */
const assert = require('assert');
const { execSync, spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC = path.resolve(__dirname, '..', 'scripts', 'merge_task.py');
const SANDBOX = path.join(os.tmpdir(), 'merge-task-sandbox-' + Date.now());

let pass = 0;
function test(name, fn) { fn(); pass++; console.log('  ✓ ' + name); }

function sh(cmd, cwd) {
  return execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf-8' });
}
function runMerge(args, cwd) {
  const r = spawnSync('python', [path.join(cwd, 'scripts', 'merge_task.py'), ...args],
    { cwd, encoding: 'utf-8', env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }) });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

console.log('merge-task-sandbox');

// ── 搭沙箱 ────────────────────────────────────────────────────────────────
fs.mkdirSync(path.join(SANDBOX, 'scripts'), { recursive: true });
fs.mkdirSync(path.join(SANDBOX, '.agents'), { recursive: true });
fs.copyFileSync(SRC, path.join(SANDBOX, 'scripts', 'merge_task.py'));

// 一个「测试」：读 value.txt，是 good 就通过
fs.writeFileSync(path.join(SANDBOX, 'scripts', 'check.py'),
  'import sys,io,os,time\nv=io.open("value.txt",encoding="utf-8").read().strip()\n'
  + 'marker=os.environ.get("MERGE_TEST_MARKER")\n'
  + 'if marker:\n io.open(marker,"w",encoding="utf-8").write("started")\n'
  + 'hold=int(os.environ.get("MERGE_TEST_HOLD_MS","0"))\n'
  + 'if hold:\n time.sleep(hold/1000)\n'
  + 'print("value =",v)\nsys.exit(0 if v=="good" else 1)\n', 'utf-8');
fs.writeFileSync(path.join(SANDBOX, '.agents', 'project.json'), JSON.stringify({
  name: '沙箱', trunk: 'main', test: ['python scripts/check.py'], afterMerge: [],
}, null, 2), 'utf-8');
fs.writeFileSync(path.join(SANDBOX, 'value.txt'), 'good\n', 'utf-8');

sh('git init -q -b main', SANDBOX);
sh('git config user.email t@t && git config user.name t', SANDBOX);
sh('git add -A && git commit -q -m base', SANDBOX);
const BASE = sh('git rev-parse HEAD', SANDBOX).trim();

// 好分支：测试仍然过
sh('git checkout -q -b good-branch', SANDBOX);
fs.writeFileSync(path.join(SANDBOX, 'feature.txt'), 'new feature\n', 'utf-8');
sh('git add -A && git commit -q -m "add feature"', SANDBOX);

// 坏分支：把 value 改坏，测试会红
sh(`git checkout -q -b bad-branch ${BASE}`, SANDBOX);
fs.writeFileSync(path.join(SANDBOX, 'value.txt'), 'broken\n', 'utf-8');
sh('git add -A && git commit -q -m "break it"', SANDBOX);
sh('git checkout -q main', SANDBOX);

// ── 用例 ──────────────────────────────────────────────────────────────────
test('--dry-run 验证通过后回滚，主干一动不动', () => {
  const before = sh('git rev-parse main', SANDBOX).trim();
  const r = runMerge(['good-branch', '--dry-run'], SANDBOX);
  assert.strictEqual(r.code, 0, '应通过：\n' + r.out);
  assert(/验证通过/.test(r.out), '应报告验证通过');
  assert.strictEqual(sh('git rev-parse main', SANDBOX).trim(), before, 'dry-run 不该改主干');
});

test('测试没过就不合，并自动回滚（闸门的核心）', () => {
  const before = sh('git rev-parse main', SANDBOX).trim();
  const r = runMerge(['bad-branch'], SANDBOX);
  assert.strictEqual(r.code, 1, '应失败');
  assert(/测试没过/.test(r.out), '应说明是测试没过：\n' + r.out);
  assert(/已回滚/.test(r.out), '应报告已回滚');
  assert.strictEqual(sh('git rev-parse main', SANDBOX).trim(), before, '主干必须回到原位');
  // 工作区也要干净，不能留着冲突或半合状态
  assert.strictEqual(sh('git status --porcelain', SANDBOX).trim(), '', '回滚后工作区必须干净');
});

test('正常路径：测试过了才真合进主干', () => {
  const before = sh('git rev-parse main', SANDBOX).trim();
  const r = runMerge(['good-branch'], SANDBOX);
  assert.strictEqual(r.code, 0, '应成功：\n' + r.out);
  assert(/已合并/.test(r.out));
  const after = sh('git rev-parse main', SANDBOX).trim();
  assert.notStrictEqual(after, before, '主干应该前进');
  assert(fs.existsSync(path.join(SANDBOX, 'feature.txt')), '改动应该真的落到主干');
  assert(/撤回：git revert/.test(r.out), '应给出撤回办法');
});

test('与本次改动无关的未提交文件不挡路，且原样保留', () => {
  // 2026-09-05 起改成精确判据：一刀切「一脏就拒」会让一份陈年半成品
  // 把闸门永久锁死（生产上真发生过）。只有会被覆盖的才拦。
  fs.writeFileSync(path.join(SANDBOX, 'someone-else.txt'), 'wip\n', 'utf-8');
  const r = runMerge(['good-branch'], SANDBOX);
  assert.strictEqual(r.code, 0, '无关的脏不该挡住合并：\n' + r.out);
  assert(/与本次合并无关/.test(r.out), '要明说保留了哪些无关改动：\n' + r.out);
  assert.strictEqual(fs.readFileSync(path.join(SANDBOX, 'someone-else.txt'), 'utf-8'), 'wip\n',
    '别人的文件必须一字不差还在');
  fs.unlinkSync(path.join(SANDBOX, 'someone-else.txt'));
});

test('会被本次合并覆盖的未提交改动，必须拦下来', () => {
  // 必须用一个**尚未合入**的分支：已合入的分支相对主干改动集为空，
  // 判成「无关」是对的（上一条 good-branch 到这时已经合进去了）。
  sh('git checkout -q main', SANDBOX);
  sh('git checkout -q -b overlap-branch main', SANDBOX);
  fs.writeFileSync(path.join(SANDBOX, 'shared-file.txt'), '分支版本\n', 'utf-8');
  sh('git add -A', SANDBOX);
  execSync('git commit -q -m "branch touches shared-file"', {
    cwd: SANDBOX, env: Object.assign({}, process.env, { HUB_ALLOW_MAIN_COMMIT: '1' }), stdio: 'pipe' });
  sh('git checkout -q main', SANDBOX);

  // 同一个文件在主目录也被改到一半 —— 真会被踩到
  fs.writeFileSync(path.join(SANDBOX, 'shared-file.txt'), '我改到一半的内容\n', 'utf-8');
  const r = runMerge(['overlap-branch'], SANDBOX);
  assert.strictEqual(r.code, 2, '重叠必须拒绝：\n' + r.out);
  assert(/会碰到你未提交的这些文件/.test(r.out), '要说清是「会被覆盖」而非笼统的脏：\n' + r.out);
  assert.strictEqual(fs.readFileSync(path.join(SANDBOX, 'shared-file.txt'), 'utf-8'), '我改到一半的内容\n',
    '被拒时不能动它一个字');
  fs.unlinkSync(path.join(SANDBOX, 'shared-file.txt'));
});

test('分支不存在时明确报错，不是静默成功', () => {
  const r = runMerge(['no-such-branch'], SANDBOX);
  assert.strictEqual(r.code, 2);
  assert(/分支不存在/.test(r.out));
});

test('afterMerge 会执行（项目专属产物在这一步出）', () => {
  const cfgPath = path.join(SANDBOX, '.agents', 'project.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
  cfg.afterMerge = ['python -c "import io;io.open(\'artifact.txt\',\'w\').write(\'made\')"'];
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf-8');
  sh('git add -A && git commit -q -m "cfg"', SANDBOX);

  sh(`git checkout -q -b good2 main`, SANDBOX);
  fs.writeFileSync(path.join(SANDBOX, 'f2.txt'), 'x\n', 'utf-8');
  sh('git add -A && git commit -q -m f2', SANDBOX);
  sh('git checkout -q main', SANDBOX);

  const r = runMerge(['good2'], SANDBOX);
  assert.strictEqual(r.code, 0, '应成功：\n' + r.out);
  assert(fs.existsSync(path.join(SANDBOX, 'artifact.txt')), 'afterMerge 应该真的跑了');
});

function waitForFile(file, timeoutMs = 5000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (fs.existsSync(file)) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error('等待首个合并进入测试阶段超时'));
      }
    }, 25);
  });
}

function waitChild(child) {
  return new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, out }));
  });
}

async function runConcurrencyCase() {
  const artifact = path.join(SANDBOX, 'artifact.txt');
  if (fs.existsSync(artifact)) fs.unlinkSync(artifact);
  const before = sh('git rev-parse main', SANDBOX).trim();
  sh('git checkout -q -b parallel-a main', SANDBOX);
  fs.writeFileSync(path.join(SANDBOX, 'parallel-a.txt'), 'a\n', 'utf-8');
  sh('git add parallel-a.txt && git commit -q -m parallel-a', SANDBOX);
  sh('git checkout -q main', SANDBOX);
  sh('git checkout -q -b parallel-b main', SANDBOX);
  fs.writeFileSync(path.join(SANDBOX, 'parallel-b.txt'), 'b\n', 'utf-8');
  sh('git add parallel-b.txt && git commit -q -m parallel-b', SANDBOX);
  sh('git checkout -q main', SANDBOX);

  const marker = path.join(os.tmpdir(), 'merge-task-first-testing-' + Date.now() + '.marker');
  const first = spawn('python', [path.join(SANDBOX, 'scripts', 'merge_task.py'), 'parallel-a', '--dry-run'], {
    cwd: SANDBOX,
    encoding: 'utf-8',
    env: Object.assign({}, process.env, {
      PYTHONIOENCODING: 'utf-8',
      MERGE_TEST_MARKER: marker,
      MERGE_TEST_HOLD_MS: '1800',
    }),
  });
  const firstDone = waitChild(first);
  try {
    await waitForFile(marker);
    const second = runMerge(['parallel-b', '--dry-run'], SANDBOX);
    const firstResult = await firstDone;

    assert.strictEqual(second.code, 2,
      '已有合并在验收时，第二个合并必须被互斥锁拒绝，不能同时改主工作区：\n' + second.out);
    assert(/另一个合并任务正在运行/.test(second.out), '拒绝原因必须让非代码维护者看得懂：\n' + second.out);
    assert.strictEqual(firstResult.code, 0, '首个 dry-run 应正常完成：\n' + firstResult.out);
    assert.strictEqual(sh('git rev-parse main', SANDBOX).trim(), before, '并发验证后主干必须回到原位');
    assert.strictEqual(sh('git status --porcelain', SANDBOX).trim(), '', '并发验证后工作区必须干净');
  } finally {
    if (fs.existsSync(marker)) fs.unlinkSync(marker);
  }
}

(async () => {
  await runConcurrencyCase();
  pass++;
  console.log('  ✓ 两个合并位同时启动时，第二个被明确拒绝');
  console.log('\n──────────────');
  console.log('通过 ' + pass + ' / 失败 0');
})().catch((error) => {
  console.error('  ✗ 合并互斥：' + (error && error.stack || error));
  process.exitCode = 1;
}).finally(() => {
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) {}
});
