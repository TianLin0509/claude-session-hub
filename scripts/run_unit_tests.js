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
 *
 * 约定：子进程退出码非 0 即失败。测试文件自己 print 什么不管。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO = path.resolve(__dirname, '..');
const TESTS = path.join(REPO, 'tests');

const argv = process.argv.slice(2);
let jobs = Math.max(2, Math.min(16, os.cpus().length));
const filters = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--jobs') { jobs = Math.max(1, parseInt(argv[++i], 10) || jobs); }
  else if (!argv[i].startsWith('--')) { filters.push(argv[i]); }
}

if (!fs.existsSync(TESTS)) {
  console.error('找不到 tests 目录：' + TESTS);
  process.exit(2);
}

// 单个测试卡死不能拖垮整场，但预算必须对得上真实耗时，否则闸门会自己抖。
//
// 2026-09-06：unit-dev-flow-stress 在正式合并闸门里跑到 A4 被 180 秒 SIGKILL，
//   报出来只是「退出码 null」，合并位只能猜是不是新代码把它卡死了。实测：它在
//   master 上单跑就要 101～138 秒（A2 一个用例就占 51 秒 —— 20 次真合并，每次都要
//   起 python 解释器加一串 git 进程）。180 秒对它连 1.4 倍余量都不到，而它还要和
//   另外 15 个 node 进程抢 CPU，超时是迟早的事。
//   注意：慢的原因是它真的在跑 20 次合并，不是它有 bug —— 它恰好是守合并闸门的那个
//   文件，不能为了让闸门变绿去砍它的覆盖，只能把预算调到符合事实。
const DEFAULT_TIMEOUT_MS = 180_000;
const FILE_TIMEOUT_MS = {
  // 真 git + 真 python 子进程，数量级和别的单测不在一个层次
  'unit-dev-flow-stress.test.js': 600_000,
};
const timeoutFor = file => FILE_TIMEOUT_MS[file] || DEFAULT_TIMEOUT_MS;

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

// 工作位通常由隔离 Hub 启动，会继承它的 CLAUDE_HUB_DATA_DIR。原样传给单测会让
// 测试把自己创建的临时账本误判成「隔离 Hub 访问外部正式库」。每次总跑建立唯一父目录，
// 同时作为系统临时目录和 Hub 数据目录，既不碰生产数据，也让安全边界保持真实。
const SUITE_TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-unit-run-'));

const t0 = Date.now();
console.log(`单元测试：${files.length} 个文件，并发 ${jobs}`);

const failures = [];
let done = 0;
let idx = 0;

function runOne(file) {
  return new Promise((resolve) => {
    const childEnv = Object.assign({}, process.env, {
      NODE_ENV: 'test',
      TEMP: SUITE_TEMP,
      TMP: SUITE_TEMP,
      CLAUDE_HUB_DATA_DIR: SUITE_TEMP,
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

    // 预算见上面的 FILE_TIMEOUT_MS。超时要能被认出来：被 SIGKILL 的进程 code 是 null，
    // 光看「退出码 null」分不清是卡死、是崩了、还是预算不够，只能靠猜。
    const budgetMs = timeoutFor(file);
    const startedAt = Date.now();
    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      try { p.kill('SIGKILL'); } catch (e) {}
    }, budgetMs);

    p.on('close', (code) => {
      clearTimeout(killer);
      done++;
      if (code !== 0) {
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
        const tail = out.trim().split('\n').slice(-12).join('\n');
        failures.push(timedOut
          ? {
            file,
            code,
            out: `【超时】跑了 ${elapsed}s 仍未结束，超过 ${(budgetMs / 1000).toFixed(0)}s 预算被强杀。`
              + `\n（不一定是卡死：机器忙的时候这个文件本来就慢，先看下面最后的输出停在哪个用例）\n${tail}`,
          }
          : { file, code, out: tail });
        process.stdout.write('x');
      } else {
        process.stdout.write('.');
      }
      if (done % 80 === 0) process.stdout.write(` ${done}/${files.length}\n`);
      resolve();
    });
    p.on('error', (err) => {
      clearTimeout(killer);
      done++;
      failures.push({ file, code: -1, out: String(err && err.message) });
      process.stdout.write('x');
      resolve();
    });
  });
}

async function worker() {
  while (idx < files.length) {
    await runOne(files[idx++]);
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

Promise.all(Array.from({ length: Math.min(jobs, files.length) }, worker)).then(() => {
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('\n');
  console.log('─'.repeat(50));
  if (!failures.length) {
    console.log(`全部通过：${files.length} 个文件，用时 ${secs}s`);
    cleanupSuiteTemp();
    process.exit(0);
  }
  console.log(`失败 ${failures.length} / ${files.length}，用时 ${secs}s\n`);
  for (const f of failures) {
    console.log(`  ✗ ${f.file}  (退出码 ${f.code})`);
    for (const ln of f.out.split('\n')) console.log(`      ${ln}`);
    console.log('');
  }
  cleanupSuiteTemp();
  process.exit(1);
});
