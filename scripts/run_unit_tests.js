#!/usr/bin/env node
'use strict';
/**
 * 单元测试总入口 —— 给合并脚本当闸门用。
 *
 * 为什么要有它：散落的 unit-*.test.js 之前只能一个一个手跑，
 * 合并脚本没法用「一条命令 + 退出码」判断该不该合。
 *
 * 用法：
 *   node scripts/run_unit_tests.js              # 全跑
 *   node scripts/run_unit_tests.js workflow     # 只跑文件名含 workflow 的
 *   node scripts/run_unit_tests.js --jobs 8     # 调并发
 *   node scripts/run_unit_tests.js --no-lock    # 不与别的总入口互斥（不推荐）
 *   node scripts/run_unit_tests.js --strict     # 连诊断复测都不跑，首次失败直接判失败
 *   node scripts/run_unit_tests.js --lenient    # 复测通过就放行（需维护者明确采纳）
 *
 * 约定：子进程退出码非 0 即失败。测试文件自己 print 什么不管。
 * **默认口径：任何文件在正式跑里失败过，就是失败。** 串行复测只产出诊断信息，
 * 不改变结论 —— 复测通过只能说明失败不稳定，不能说明它是负载造成的。
 */
const { spawn, spawnSync } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO = path.resolve(__dirname, '..');
const TESTS = path.join(REPO, 'tests');

const argv = process.argv.slice(2);
let jobs = Math.max(2, Math.min(16, os.cpus().length));
// Let merge_task keep the same full gate while bounding this run's CPU load.
// --jobs still takes precedence; coverage, budgets and failure rules are unchanged.
const envJobs = Number(process.env.HUB_UNIT_JOBS);
if (Number.isInteger(envJobs) && envJobs > 0) jobs = Math.min(16, envJobs);
let useLock = process.env.HUB_UNIT_NO_LOCK !== '1';
// 首次失败是否阻断闸门。**默认阻断** —— 串行复测只是诊断证据，不是放行理由：
// 复测通过只能证明这次失败不稳定，不能证明它是负载造成的（2026-09-06 合并位的阻断项）。
// 要不要「复测通过就放行」是维护者的规则决定，没拍板之前不由脚本替他决定，
// 所以放宽走显式开关：--lenient 或 HUB_UNIT_LENIENT=1。
let lenient = process.env.HUB_UNIT_LENIENT === '1';
// 连诊断复测都不想跑（省时间）时用它。
let skipRetest = process.env.HUB_UNIT_STRICT === '1';
const filters = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--jobs') { jobs = Math.max(1, parseInt(argv[++i], 10) || jobs); }
  else if (argv[i] === '--no-lock') { useLock = false; }
  else if (argv[i] === '--strict') { skipRetest = true; }
  else if (argv[i] === '--lenient') { lenient = true; }
  else if (!argv[i].startsWith('--')) { filters.push(argv[i]); }
}

if (!fs.existsSync(TESTS)) {
  console.error('找不到 tests 目录：' + TESTS);
  process.exit(2);
}

// ── 超时预算 ────────────────────────────────────────────────────────────────
//
// 单个测试卡死不能拖垮整场，但预算必须对得上真实耗时，否则闸门会自己抖。
//
// 2026-09-06 第一版：unit-dev-flow-stress 在正式合并闸门里跑到 A4 被 180 秒 SIGKILL，
//   报出来只是「退出码 null」。实测它单跑就要 101～138 秒（A2 一个用例就占 51 秒 ——
//   20 次真合并，每次都要起 python 解释器加一串 git 进程），于是给它单列了预算。
//
// 2026-09-06 第二版（本次）：合并位反复报「很多测试 180 秒超时」，实测发现根因不是
//   哪个测试写错了，而是**固定墙钟预算 + 不受控并行**这个组合本身不成立：
//     并发 16（闲机）：全场 117.4s，各文件耗时之和 664s，最慢的非 stress 文件 40.9s，0 失败
//     并发 48（压满）：全场 142.7s，各文件耗时之和 1697s（2.6 倍），dev-scene-contract
//                      从 12.3s 涨到 34.0s，且 unit-preview-file-watch 直接判错
//   也就是说：一台机器上同时有 N 个工作位自测 + 合并闸门 + 生产 Hub 时，40～66 秒的文件
//   会被推到 100 秒以上，再多一路就越过 180 秒被强杀，报成「超时」。
//   注意：上面这组数是「单进程内把并发从 16 提到 48」，它证明的是 CPU 争抢会让同一个
//   文件的墙钟显著变长，**不等于**三场独立测试同时跑的精确复现，也不构成「再加并发必然
//   跨过 180 秒」的证明。真实闸门里的超时仍需按各自运行日志确认。
//
// 于是这一版做三件事：
//   1. 总入口之间互斥（见 acquireSuiteLock）—— 从源头消掉争抢
//   2. 预算改成「闲机基线 × 倍数」与固定值取大 —— 预算不再是拍脑袋的常数
//   3. 判超时/失败的文件串行复测一次 —— 区分「真卡死」和「被饿着」，首次证据全留
const DEFAULT_TIMEOUT_MS = 180_000;
const FILE_TIMEOUT_MS = {
  // 真 git + 真 python 子进程，数量级和别的单测不在一个层次
  'unit-dev-flow-stress.test.js': 600_000,
};
// 基线来自历次干净运行的最小观测值（min 收敛到闲机真值：被争抢时只会更大，不会更小）。
const BASELINE_FILE = path.join(TESTS, '.timing-baseline.json');
const FLAKY_LOG_FILE = path.join(TESTS, '.load-related-failures.json');
const BASELINE_FACTOR = 4;
const BASELINE_MAX_BUDGET_MS = 900_000;
// 只给测试用：把兜底预算调到毫秒级，才能在几秒内验完「超时怎么报、预算怎么算」。
const DEFAULT_BUDGET_MS = Number(process.env.HUB_UNIT_DEFAULT_TIMEOUT_MS) > 0
  ? Number(process.env.HUB_UNIT_DEFAULT_TIMEOUT_MS)
  : DEFAULT_TIMEOUT_MS;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return fallback; }
}
const baseline = readJson(BASELINE_FILE, {}) || {};

// 预算 = max(固定预算, 基线 × 倍数)。基线缺失时退回固定预算 —— 新机器/首次运行不受影响。
const timeoutFor = (file) => {
  const fixed = FILE_TIMEOUT_MS[file] || DEFAULT_BUDGET_MS;
  const base = Number(baseline[file]);
  if (!(base > 0)) return fixed;
  return Math.max(fixed, Math.min(BASELINE_MAX_BUDGET_MS, Math.round(base * BASELINE_FACTOR)));
};

// 超时表里的重量级文件排到队首：让它们和几十个轻量测试重叠着跑，而不是排在末尾把整场拖长
//（实测全量从 140～174 秒降到 117 秒）。预算本身见上面的 FILE_TIMEOUT_MS。
const isHeavy = f => Object.prototype.hasOwnProperty.call(FILE_TIMEOUT_MS, f);
let files = fs.readdirSync(TESTS)
  .filter(f => /^unit-.*\.test\.js$/.test(f))
  .sort()
  .sort((a, b) => Number(isHeavy(b)) - Number(isHeavy(a)));
if (filters.length) files = files.filter(f => filters.some(k => f.includes(k)));

if (!files.length) {
  console.error('没有匹配的测试文件' + (filters.length ? `（过滤词：${filters.join(', ')}）` : ''));
  process.exit(2);
}

// ── 总入口之间的互斥锁 ──────────────────────────────────────────────────────
//
// 只锁「本脚本的实例之间」：拿的是一个 OS 级的具名管道/套接字，进程一死内核就回收，
// 不需要任何超时清理，也**不影响生产 Hub、不影响任何别的 node 进程** —— 别人根本
// 不知道这个名字。合并闸门和各 worktree 的工作位自测因此排成队，而不是互相饿死。
//
// 等待是有上限的：外层还有评审步骤的预算（开发群聊默认 25 分钟，且要跑两遍全量），
// 排队等太久会把外层拖超时，那就本末倒置了。等满上限就降级为「不排队直接跑」，
// 并把降级明说出来 —— 宁可这一场慢，也不要闸门无声地卡住。
// 锁名固定（同一台机器上的所有总入口，含各 worktree，排同一条队）。
// HUB_UNIT_LOCK_NAME 只给测试用：换个名字就能验互斥而不去抢真实闸门那把锁。
const LOCK_NAME = String(process.env.HUB_UNIT_LOCK_NAME || 'hub-unit-suite-lock');
const LOCK_ADDRESS = process.platform === 'win32'
  ? '\\\\.\\pipe\\' + LOCK_NAME
  : path.join(os.tmpdir(), LOCK_NAME + '.sock');
// 等待上限怎么定的：外层评审步骤的预算是 25 分钟（开发群聊默认值），而合同要求它跑
// 两遍全量（dry-run 一次 + 正式合并一次），一遍闲机约 2 分钟。留给排队的预算按
// 「两遍都排一次队也不撑破外层」倒推，取 10 分钟。
// 实测（2026-09-06，三路并发跑全量）：排队 94s / 243s / 301s —— 老的 300 秒上限刚好
// 被第三路踩穿并降级。10 分钟能覆盖到五路左右；再多就该降级，那也是安全的：
// 降级只是回到本次改动之前的行为，而串行复测那一层仍然兜着假失败。
const LOCK_WAIT_MAX_MS = Math.max(0, Number(process.env.HUB_UNIT_LOCK_WAIT_MS) || 600_000);
const LOCK_POLL_MS = 2_000;
const LOCK_HEARTBEAT_MS = 15_000;

function tryListen() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => {
      if (process.platform !== 'win32' && err && err.code === 'EADDRINUSE') {
        // POSIX 上进程崩溃会留下 socket 文件；连得上说明真有人在跑，连不上就是残留。
        const probe = net.connect(LOCK_ADDRESS);
        probe.once('connect', () => { probe.destroy(); resolve(null); });
        probe.once('error', () => {
          try { fs.unlinkSync(LOCK_ADDRESS); } catch (e) {}
          resolve(null);
        });
        return;
      }
      resolve(null);
    });
    server.once('listening', () => resolve(server));
    try { server.listen(LOCK_ADDRESS); } catch (e) { resolve(null); }
  });
}

async function acquireSuiteLock() {
  // 嵌套调用（万一将来有测试要起总入口）直接放行，避免自己等自己。
  if (!useLock || process.env.HUB_UNIT_SUITE_LOCK_HELD === '1') {
    return { held: false, waitedMs: 0, degraded: false, skipped: true, release: () => {} };
  }
  const startedAt = Date.now();
  let announced = false;
  let lastHeartbeatAt = 0;
  for (;;) {
    const server = await tryListen();
    if (server) {
      const waitedMs = Date.now() - startedAt;
      if (announced) console.log(`拿到执行权，排队了 ${(waitedMs / 1000).toFixed(0)}s`);
      return {
        held: true, waitedMs, degraded: false, skipped: false,
        release: () => { try { server.close(); } catch (e) {} },
      };
    }
    const waited = Date.now() - startedAt;
    if (waited >= LOCK_WAIT_MAX_MS) {
      console.log(`⚠ 排队已等满 ${(LOCK_WAIT_MAX_MS / 1000).toFixed(0)}s，降级为不排队直接跑`);
      console.log('  （另一场单测仍在跑，本场会和它抢 CPU，耗时和超时判定都会偏悲观）');
      return { held: false, waitedMs: waited, degraded: true, skipped: false, release: () => {} };
    }
    if (!announced) {
      announced = true;
      console.log('另一场单测正在跑，排队等待执行权…（本进程不占 CPU，等待与执行分开计时）');
    }
    // 心跳既是给人看的，也是给外层看的：合并位那一步的硬超时会因为 PTY 仍有输出而延期，
    // 排队期间保持输出，外层就不会把「在排队」误判成「卡死了」。
    // 轮询比心跳密（2s），前一场一结束就立刻接上，不白等一个心跳周期。
    if (Date.now() - lastHeartbeatAt >= LOCK_HEARTBEAT_MS) {
      lastHeartbeatAt = Date.now();
      console.log(`  …仍在排队 ${(waited / 1000).toFixed(0)}s`);
    }
    await new Promise(r => setTimeout(r, LOCK_POLL_MS));
  }
}

// 工作位通常由隔离 Hub 启动，会继承它的 CLAUDE_HUB_DATA_DIR。原样传给单测会让
// 测试把自己创建的临时账本误判成「隔离 Hub 访问外部正式库」。每次总跑建立唯一父目录，
// 同时作为系统临时目录和 Hub 数据目录，既不碰生产数据，也让安全边界保持真实。
const SUITE_TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-unit-run-'));

const failures = [];
const durations = new Map();
let done = 0;
let idx = 0;
let total = 0;

function runOne(file, opts = {}) {
  return new Promise((resolve) => {
    const childEnv = Object.assign({}, process.env, {
      NODE_ENV: 'test',
      TEMP: SUITE_TEMP,
      TMP: SUITE_TEMP,
      CLAUDE_HUB_DATA_DIR: SUITE_TEMP,
      HUB_UNIT_SUITE_LOCK_HELD: '1',
    });
    delete childEnv.CHUXIN_AGENT_LEAGUE_ALLOW_EXTERNAL_SCHEDULER;
    const p = spawn(process.execPath, [path.join(TESTS, file)], {
      cwd: REPO,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });

    // 预算见上面的 timeoutFor。超时要能被认出来：被 SIGKILL 的进程 code 是 null，
    // 光看「退出码 null」分不清是卡死、是崩了、还是预算不够，只能靠猜。
    const budgetMs = timeoutFor(file);
    const startedAt = Date.now();
    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      try { p.kill('SIGKILL'); } catch (e) {}
    }, budgetMs);

    const settle = (code, errText) => {
      clearTimeout(killer);
      const elapsedMs = Date.now() - startedAt;
      durations.set(file, elapsedMs);
      const elapsed = (elapsedMs / 1000).toFixed(1);
      const tail = errText || out.trim().split('\n').slice(-12).join('\n');
      const record = code === 0 ? null : {
        file,
        code,
        timedOut,
        elapsedMs,
        budgetMs,
        out: timedOut
          ? `【超时】跑了 ${elapsed}s 仍未结束，超过 ${(budgetMs / 1000).toFixed(0)}s 预算被强杀。`
            + `\n（不一定是卡死：机器忙的时候这个文件本来就慢，先看下面最后的输出停在哪个用例）\n${tail}`
          : tail,
      };
      if (!opts.silentProgress) {
        done++;
        process.stdout.write(code === 0 ? '.' : 'x');
        if (done % 80 === 0) process.stdout.write(` ${done}/${total}\n`);
      }
      resolve(record);
    };

    p.on('close', (code) => settle(code));
    p.on('error', (err) => settle(-1, String(err && err.message)));
  });
}

async function worker() {
  while (idx < files.length) {
    const file = files[idx++];
    const record = await runOne(file);
    if (record) failures.push(record);
  }
}

function containsReparsePoint(root) {
  const pending = [root];
  while (pending.length) {
    const dir = pending.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) return true;
      if (entry.isDirectory()) pending.push(full);
    }
  }
  return false;
}

function cleanupSuiteTemp() {
  try {
    const tempBase = fs.realpathSync.native(os.tmpdir());
    const target = fs.realpathSync.native(SUITE_TEMP);
    const relative = path.relative(tempBase, target);
    const safe = relative && !relative.startsWith('..') && !path.isAbsolute(relative)
      && path.basename(target).startsWith('hub-unit-run-');
    if (!safe) throw new Error('临时目录边界校验失败：' + target);
    if (containsReparsePoint(target)) throw new Error('临时目录含 reparse point，拒绝递归清理：' + target);
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
  } catch (error) {
    console.warn('单测临时目录未自动清理：' + (error && error.message || error));
  }
}

function currentSha() {
  try {
    const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' });
    return (r.stdout || '').trim() || 'unknown';
  } catch (e) { return 'unknown'; }
}

// 干净跑完的文件才更新基线，取 min —— 被争抢时的观测只会偏大，min 自然收敛到闲机真值。
function updateBaseline() {
  try {
    const next = Object.assign({}, baseline);
    let changed = false;
    for (const [file, ms] of durations) {
      if (failures.some(f => f.file === file)) continue;
      const prev = Number(next[file]);
      if (!(prev > 0) || ms < prev) { next[file] = ms; changed = true; }
    }
    if (changed) fs.writeFileSync(BASELINE_FILE, JSON.stringify(next, null, 1), 'utf8');
  } catch (error) {
    console.warn('基线未能写入（不影响本次结论）：' + (error && error.message || error));
  }
}

// 首次失败的证据必须留档：串行复测通过并不等于「没有 bug」，只说明它与负载相关。
function recordLoadRelated(entries, sha) {
  if (!entries.length) return;
  try {
    const log = readJson(FLAKY_LOG_FILE, []) || [];
    log.push({
      at: new Date().toISOString(),
      sha,
      jobs,
      files: entries.map(e => ({
        file: e.file,
        firstCode: e.code,
        firstTimedOut: e.timedOut,
        firstElapsedMs: e.elapsedMs,
        budgetMs: e.budgetMs,
        retryElapsedMs: e.retryElapsedMs,
        firstOutputTail: String(e.out || '').split('\n').slice(-12).join('\n'),
      })),
    });
    fs.writeFileSync(FLAKY_LOG_FILE, JSON.stringify(log.slice(-100), null, 1), 'utf8');
  } catch (error) {
    console.warn('负载相关失败未能留档：' + (error && error.message || error));
  }
}

function printFailure(f) {
  console.log(`  ✗ ${f.file}  (退出码 ${f.code}，耗时 ${(f.elapsedMs / 1000).toFixed(1)}s / 预算 ${(f.budgetMs / 1000).toFixed(0)}s，`
    + `分类：${f.timedOut ? '预算不足或进程不退出' : '断言失败'})`);
  for (const ln of String(f.out).split('\n')) console.log(`      ${ln}`);
  console.log('');
}

async function main() {
  const lock = await acquireSuiteLock();
  const t0 = Date.now();
  total = files.length;
  console.log(`单元测试：${files.length} 个文件，并发 ${jobs}`
    + (lock.held ? '（已取得总入口执行权）' : lock.degraded ? '（降级：未排到执行权）' : ''));

  await Promise.all(Array.from({ length: Math.min(jobs, files.length) }, worker));
  const parallelSecs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('\n');
  console.log('─'.repeat(50));

  const sha = currentSha();
  const timing = `排队 ${(lock.waitedMs / 1000).toFixed(1)}s + 执行 ${parallelSecs}s`;

  if (!failures.length) {
    console.log(`全部通过：${files.length} 个文件，${timing}（SHA ${sha}）`);
    updateBaseline();
    cleanupSuiteTemp();
    lock.release();
    process.exit(0);
  }

  // 串行复测：一个一个单独跑，没有任何争抢。
  // **它是诊断，不是放行理由** —— 复测通过只能说明这次失败不稳定，不能说明它是负载造成的。
  console.log(`并行阶段失败 ${failures.length} / ${files.length}，${timing}（SHA ${sha}）\n`);
  for (const f of failures) printFailure(f);

  if (skipRetest) {
    console.log('（--strict：连诊断复测也不跑，直接判失败）');
    cleanupSuiteTemp();
    lock.release();
    process.exit(1);
  }

  console.log(`── 串行复测这 ${failures.length} 个文件（诊断用，单独跑、无并发争抢）──`);
  const stillFailing = [];
  const unstable = [];
  for (const f of failures) {
    process.stdout.write(`  ${f.file} … `);
    const retryStartedAt = Date.now();
    const record = await runOne(f.file, { silentProgress: true });
    const retryElapsedMs = Date.now() - retryStartedAt;
    if (record) {
      console.log(`仍然失败（退出码 ${record.code}，${(retryElapsedMs / 1000).toFixed(1)}s）`);
      stillFailing.push(record);
    } else {
      console.log(`通过（${(retryElapsedMs / 1000).toFixed(1)}s）`);
      unstable.push(Object.assign({}, f, { retryElapsedMs }));
    }
  }
  console.log('');

  recordLoadRelated(unstable, sha);
  if (unstable.length) {
    console.log(`⚠ 下面 ${unstable.length} 个文件「首次失败、单跑通过」——`
      + '首次失败证据已留档到 tests/.load-related-failures.json。'
      + '这只说明失败不稳定，**既不能证明是负载造成的，也不能证明它没有 bug**，根因待查：');
    for (const f of unstable) {
      console.log(`    ${f.file}：首次 ${f.timedOut ? '超时' : '失败'}（${(f.elapsedMs / 1000).toFixed(1)}s）→ 复测 ${(f.retryElapsedMs / 1000).toFixed(1)}s 通过`);
    }
    console.log('');
  }

  updateBaseline();
  cleanupSuiteTemp();
  lock.release();

  if (stillFailing.length) {
    console.log(`真失败 ${stillFailing.length} / ${files.length}（串行复测仍不过）：`);
    for (const f of stillFailing) printFailure(f);
    process.exit(1);
  }

  // 走到这里 = 全部首次失败都在复测中通过。默认仍然判失败：闸门要不要因为
  // 「复测通过」而放行，是维护者的规则决定，脚本不替他做主。
  if (!lenient) {
    console.log(`判失败：${unstable.length} 个文件在正式跑里失败过。复测通过只是诊断信息，不是放行理由。`);
    console.log('（维护者若决定「复测通过即放行」，用 --lenient 或 HUB_UNIT_LENIENT=1 打开）');
    process.exit(1);
  }
  console.log(`--lenient：${unstable.length} 个首次失败均在串行复测中通过，按维护者设定放行。`);
  console.log('注意：首次失败证据仍已留档，根因待查。');
  process.exit(0);
}

main().catch((error) => {
  console.error('运行器自身异常：', error && error.stack || error);
  cleanupSuiteTemp();
  process.exit(2);
});
