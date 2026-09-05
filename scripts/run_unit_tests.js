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

let files = fs.readdirSync(TESTS)
  .filter(f => /^unit-.*\.test\.js$/.test(f))
  .sort();
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

    // 单个测试卡死不能拖垮整场。
    // 为什么是 180 秒而不是 60：unit-dev-flow-stress 单跑要 56 秒（12 个真 git 场景），
    // 机器上同时有别的活时就会越过 60 秒被误杀，表现为「退出码 null」的假失败——
    // 而它恰好是守合并闸门的那个文件，闸门自己抖是最糟的一种抖。
    // 真卡死的仍然拦得住，只是晚两分钟。
    const killer = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) {} }, 180_000);

    p.on('close', (code) => {
      clearTimeout(killer);
      done++;
      if (code !== 0) {
        failures.push({ file, code, out: out.trim().split('\n').slice(-12).join('\n') });
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
