'use strict';
// 2026-09-06：守住单测运行器的超时预算与超时可读性。
//
// 起因：正式合并闸门里 unit-dev-flow-stress 跑到 A4 被 180 秒 SIGKILL，报出来只有
// 「退出码 null」，合并位没法判断是新代码把它卡死了、还是预算本来就不够，只能停下来
// 猜。实测它在 master 上单跑就要 101～138 秒（A2 一个用例 51 秒：20 次真合并，每次
// 都要起 python 解释器加一串 git 进程），180 秒连 1.4 倍余量都没有，而它还要和另外
// 15 个 node 进程抢 CPU。
//
// 这里锁两件事：
//   1. 那个重量级文件的预算必须留够余量（别哪天又被"顺手统一成 180 秒"）
//   2. 超时必须以「超时」的名义报出来，不能退化成一个裸退出码

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const RUNNER = path.join(__dirname, '..', 'scripts', 'run_unit_tests.js');
const src = fs.readFileSync(RUNNER, 'utf8');

// 实测最慢一次 138 秒；预算至少要有 3 倍，才扛得住闸门里 16 路并发的抢占。
const STRESS_MIN_BUDGET_MS = 420_000;

test('重量级测试文件有单独的超时预算，且余量足够', () => {
  const table = /const FILE_TIMEOUT_MS = \{([\s\S]*?)\};/.exec(src);
  assert.ok(table, '运行器要有一张按文件的超时表');
  const entry = /'unit-dev-flow-stress\.test\.js':\s*([\d_]+)/.exec(table[1]);
  assert.ok(entry, 'unit-dev-flow-stress 必须在超时表里单列 —— 它是唯一会起几十个 git/python 子进程的单测');
  const budget = Number(entry[1].replace(/_/g, ''));
  assert.ok(budget >= STRESS_MIN_BUDGET_MS,
    `预算 ${budget / 1000}s 不够：这个文件单跑实测就要 101～138 秒，闸门里还要和 15 个进程抢 CPU，`
    + `至少要 ${STRESS_MIN_BUDGET_MS / 1000}s`);

  const fallback = /const DEFAULT_TIMEOUT_MS = ([\d_]+)/.exec(src);
  assert.ok(fallback, '其余文件仍要有统一的兜底预算');
  assert.ok(Number(fallback[1].replace(/_/g, '')) > 0);
});

test('超时必须报成「超时」，不能退化成一个裸退出码', () => {
  assert.match(src, /timedOut = true/, '强杀前要先记下这是超时');
  assert.match(src, /【超时】/, '失败摘要里要直说是超时，别让人对着 code=null 猜');
  assert.match(src, /超过 \$\{\(budgetMs \/ 1000\)/, '要把预算数字打出来，方便判断是该调预算还是真卡死');
});

console.log('unit-test-runner-budget OK');
