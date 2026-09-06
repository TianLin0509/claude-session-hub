'use strict';
// 2026-09-06：闸门在多路并行下不能再误报。
//
// 背景：合并位反复报「很多测试 180 秒超时」。实测（本机 20 核，373 个文件）：
//   并发 16 闲机：全场 117.4s，最慢的非 stress 文件 40.9s，0 失败
//   并发 48 压满：各文件耗时之和 664s → 1697s，dev-scene-contract 12.3s → 34.0s，
//                 且 unit-preview-file-watch 直接判错（单跑 0.16s、8 用例全过）
// 结论是没有哪个测试的条件写错，是「固定墙钟预算 + 不受控并行」这个组合不成立。
// 注意这组数字是同一进程内把并发从 16 提到 48，它证明争抢会显著拉长同一个文件的墙钟，
// **不等于**三场独立测试并跑的精确复现。
//
// 这个文件用一个"假仓库"（临时目录里放 scripts/ + tests/）把运行器整套跑起来，验四件事：
//   1. 总入口之间互斥：第二个实例排队，不是和第一个抢 CPU；排队与执行分开计时
//   2. 首次失败 → 串行复测：复测通过判为「负载相关，根因待查」并留档首次证据
//   3. 复测仍失败 → 真失败，退出码 1；--strict 则首次失败即拦
//   4. 预算 = max(固定预算, 基线 × 4)，超时报成超时并打印预算

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const REAL_RUNNER = path.join(__dirname, '..', 'scripts', 'run_unit_tests.js');

function makeFakeRepo(fixtures) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-gate-test-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'tests'));
  fs.copyFileSync(REAL_RUNNER, path.join(root, 'scripts', 'run_unit_tests.js'));
  for (const [name, body] of Object.entries(fixtures)) {
    fs.writeFileSync(path.join(root, 'tests', name), body, 'utf8');
  }
  return root;
}

function runRunner(root, args = [], env = {}) {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'run_unit_tests.js'), ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    env: Object.assign({}, process.env, {
      // 假仓库里的运行器不许去抢真实机器上那把闸门锁
      HUB_UNIT_NO_LOCK: '1',
      HUB_UNIT_STRICT: '',
      HUB_UNIT_DEFAULT_TIMEOUT_MS: '',
    }, env),
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

const PASS_FIXTURE = 'process.exit(0);\n';
const HARD_FAIL_FIXTURE = 'console.log("assert boom");\nprocess.exit(1);\n';
const HANG_FIXTURE = 'setInterval(() => {}, 1000);\n';
// 第一次跑失败、留个标记，第二次跑就通过 —— 模拟"被 CPU 饿着才失败"的负载相关失败
const FLAKY_FIXTURE = `
const fs = require('fs'), path = require('path');
const marker = path.join(__dirname, '.flaky-marker');
if (fs.existsSync(marker)) { console.log('second run ok'); process.exit(0); }
fs.writeFileSync(marker, '1');
console.log('first run fails under load');
process.exit(1);
`;

test('两个总入口实例互斥排队，排队与执行分开计时', async () => {
  const rootA = makeFakeRepo({ 'unit-slow.test.js': 'setTimeout(() => process.exit(0), 4000);\n' });
  const rootB = makeFakeRepo({ 'unit-quick.test.js': PASS_FIXTURE });
  const lockName = 'hub-unit-gate-test-' + process.pid;
  const spawnRunner = (root) => new Promise((resolve) => {
    let out = '';
    const p = spawn(process.execPath, [path.join(root, 'scripts', 'run_unit_tests.js')], {
      cwd: root,
      env: Object.assign({}, process.env, {
        HUB_UNIT_LOCK_NAME: lockName,
        HUB_UNIT_NO_LOCK: '0',
        HUB_UNIT_SUITE_LOCK_HELD: '',
      }),
    });
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });

  const a = spawnRunner(rootA);
  await new Promise(r => setTimeout(r, 800));   // 让 A 先拿到锁
  const b = spawnRunner(rootB);
  const [resA, resB] = await Promise.all([a, b]);

  assert.equal(resA.code, 0, 'A 应当正常跑完：' + resA.out);
  assert.equal(resB.code, 0, 'B 应当在 A 之后跑完：' + resB.out);
  assert.match(resB.out, /排队等待执行权/, 'B 必须排队，而不是和 A 抢 CPU');
  assert.match(resB.out, /排队 [\d.]+s \+ 执行 [\d.]+s/, '排队与执行必须分开计时');
  // 只认汇总行的数字：排队心跳行里也有「仍在排队 0s」，别把它当成结论
  const waited = Number(/排队 ([\d.]+)s \+ 执行/.exec(resB.out)[1]);
  assert.ok(waited >= 2, `B 的排队时长应当覆盖 A 的执行（实际 ${waited}s）`);
});

test('首次失败但串行复测通过 → 判为负载相关，放行并留档首次证据', () => {
  const root = makeFakeRepo({ 'unit-flaky.test.js': FLAKY_FIXTURE, 'unit-ok.test.js': PASS_FIXTURE });
  const { code, out } = runRunner(root);
  assert.equal(code, 0, '串行复测通过就不该拦住闸门：' + out);
  assert.match(out, /串行复测/);
  assert.match(out, /负载相关失败，根因待查/, '必须明说这不等于"没有 bug"');

  const logFile = path.join(root, 'tests', '.load-related-failures.json');
  assert.ok(fs.existsSync(logFile), '首次失败证据必须留档');
  const log = JSON.parse(fs.readFileSync(logFile, 'utf8'));
  const entry = log[log.length - 1].files.find(f => f.file === 'unit-flaky.test.js');
  assert.equal(entry.firstCode, 1);
  assert.ok(entry.firstOutputTail.includes('first run fails under load'), '要留住首次失败的输出');
  assert.ok(Number(entry.firstElapsedMs) >= 0 && Number(entry.retryElapsedMs) >= 0, '两次耗时都要记');
  assert.ok(log[log.length - 1].sha, '要记下运行时的 SHA');
});

test('串行复测仍失败 → 真失败，退出码 1', () => {
  const root = makeFakeRepo({ 'unit-bad.test.js': HARD_FAIL_FIXTURE });
  const { code, out } = runRunner(root);
  assert.equal(code, 1, '真失败必须拦住闸门');
  assert.match(out, /真失败/);
  assert.match(out, /断言失败/, '要把失败分类写清楚，别让人对着退出码猜');
});

test('--strict：首次失败即判失败，不做串行复测', () => {
  const root = makeFakeRepo({ 'unit-flaky.test.js': FLAKY_FIXTURE });
  const { code, out } = runRunner(root, ['--strict']);
  assert.equal(code, 1);
  assert.doesNotMatch(out, /串行复测这/, '--strict 下不该复测');
});

test('超时报成超时，且预算取「固定预算」与「基线×4」的大者', () => {
  const root = makeFakeRepo({ 'unit-hang.test.js': HANG_FIXTURE });
  // 基线 1200ms × 4 = 4800ms 应当压过 1500ms 的固定预算
  fs.writeFileSync(path.join(root, 'tests', '.timing-baseline.json'),
    JSON.stringify({ 'unit-hang.test.js': 1200 }), 'utf8');
  const { code, out } = runRunner(root, ['--strict'], { HUB_UNIT_DEFAULT_TIMEOUT_MS: '1500' });
  assert.equal(code, 1);
  assert.match(out, /【超时】/, '超时必须以超时的名义报出来');
  assert.match(out, /预算 5s|预算 4s/, '预算要按基线放大后打印出来（4.8s 四舍五入）');
  assert.match(out, /预算不足或进程不退出/, '超时和断言失败必须分开归类');
});

test('干净跑完会写基线，且基线只取更小的观测值', () => {
  const root = makeFakeRepo({ 'unit-ok.test.js': PASS_FIXTURE });
  const baselineFile = path.join(root, 'tests', '.timing-baseline.json');
  fs.writeFileSync(baselineFile, JSON.stringify({ 'unit-ok.test.js': 5 }), 'utf8');
  const { code } = runRunner(root);
  assert.equal(code, 0);
  const after = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  assert.equal(after['unit-ok.test.js'], 5, '已有的更小基线不该被这次更慢的观测覆盖');
});

console.log('unit-test-runner-gate OK');
