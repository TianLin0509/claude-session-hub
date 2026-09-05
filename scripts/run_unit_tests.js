#!/usr/bin/env node
'use strict';
/**
 * 单元测试总入口 —— 给合并脚本当闸门用。
 *
 * 为什么要有它：337 个 unit-*.test.js 之前只能一个一个手跑，
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

const t0 = Date.now();
console.log(`单元测试：${files.length} 个文件，并发 ${jobs}`);

const failures = [];
let done = 0;
let idx = 0;

function runOne(file) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(TESTS, file)], {
      cwd: REPO,
      env: Object.assign({}, process.env, { NODE_ENV: 'test' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });

    // 单个测试卡死不能拖垮整场
    const killer = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) {} }, 60_000);

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

Promise.all(Array.from({ length: Math.min(jobs, files.length) }, worker)).then(() => {
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('\n');
  console.log('─'.repeat(50));
  if (!failures.length) {
    console.log(`全部通过：${files.length} 个文件，用时 ${secs}s`);
    process.exit(0);
  }
  console.log(`失败 ${failures.length} / ${files.length}，用时 ${secs}s\n`);
  for (const f of failures) {
    console.log(`  ✗ ${f.file}  (退出码 ${f.code})`);
    for (const ln of f.out.split('\n')) console.log(`      ${ln}`);
    console.log('');
  }
  process.exit(1);
});
