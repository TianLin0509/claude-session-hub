'use strict';
// startedAt() 是同步 spawn 一次 powershell（wmic 在 Win11 26200 已被移除，实测
// ENOENT），2026-09-22 实测 342~688 ms，而且跑在 Electron 主进程上 —— 这段时间
// 界面完全不响应。一次「打开被中断的原生会话」最坏会对同一批 PID 问六次：
// claude 的 _start 两次、claimThread 两次、session-open-ownership 两次。
// 进程的启动时间不会变，所以同一个 PID 在短时间内只该真正探一次。
//
// 这里刻意不打桩：要守的就是「第二次没有再 spawn 进程」，而计时是唯一能证明
// 这件事的判据，打一个假 probe 反而什么都没验证。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { startedAt, matches } = require('../core/owned-process');

test('同一个 PID 的启动时间在短时间内只探一次', { skip: process.platform !== 'win32' && '只有 Windows 走 powershell 探测' },
  async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},8000)'], { stdio: 'ignore' });
    try {
      await new Promise(resolve => setTimeout(resolve, 50));
      const first = process.hrtime.bigint();
      const birth = startedAt(child.pid);
      const firstMs = Number(process.hrtime.bigint() - first) / 1e6;
      const second = process.hrtime.bigint();
      const again = startedAt(child.pid);
      const secondMs = Number(process.hrtime.bigint() - second) / 1e6;

      assert.ok(Number.isFinite(birth) && birth > 0, '第一次必须真的拿到启动时间：' + birth);
      assert.equal(again, birth, '缓存命中不能改变答案');
      // 实测下限 342 ms，这里留 7 倍余量；缓存命中是一次 Map 查找。
      assert.ok(secondMs < 50, `第二次仍然 spawn 了进程：${Math.round(firstMs)}ms → ${Math.round(secondMs)}ms`);
    } finally { child.kill(); }
  });

test('自己的 PID 从来不 spawn 进程', () => {
  const started = process.hrtime.bigint();
  const birth = startedAt(process.pid);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 50, '本进程的启动时间来自 process.uptime()');
  assert.ok(Math.abs(birth - (Date.now() - process.uptime() * 1000)) < 50);
});

test('注入的读取器仍然优先，缓存不许劫持它', () => {
  // 归属判定的可测性靠这个注入点；缓存只包在默认探测里，不能把它吃掉。
  assert.equal(matches(process.pid, Date.now() + 1000, () => 1), true);
  assert.equal(matches(process.pid, 500, () => 1000), false, '进程比记录更晚出生 = PID 被重用');
});
