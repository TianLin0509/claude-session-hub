'use strict';
// 休眠 CodeAgent 会话后补杀进程树残余（core/session-tree-sweep.js）：node-pty 只结束挂在伪终端上的进程，
// 带独立 conhost 的 MCP 插件会成孤儿。喂假快照，验证补杀的 PID 集合：只按 PID + 启动时间认人。
const test = require('node:test');
const assert = require('node:assert/strict');
const sweep = require('../core/session-tree-sweep');

const p = (pid, ppid, startedAt, name = 'x.exe') => ({ pid, ppid, startedAt, name, wsBytes: 100 });
const T = 1_800_000_000_000;

// 会话树：pwsh(100) → codeagentcli(101) → serve(102) → cmd(110) → uvx(111) → python(112) → conhost(113)
//                                              └→ node(120) → conhost(121)
// 另有：Hub(1)、别的会话根(200) 和它的孩子(201)、无关进程(300)
const beforeSnap = { processes: [
  p(1, 0, T - 100000, 'aigroupchathub.exe'),
  p(100, 1, T, 'powershell.exe'), p(101, 100, T + 1000, 'codeagentcli.exe'), p(102, 101, T + 2000, 'codeagentcli.exe'),
  p(110, 102, T + 3000, 'cmd.exe'), p(111, 110, T + 3100, 'uvx.exe'), p(112, 111, T + 3200, 'python.exe'), p(113, 112, T + 3300, 'conhost.exe'),
  p(120, 102, T + 4000, 'node.exe'), p(121, 120, T + 4100, 'conhost.exe'),
  p(200, 1, T + 500, 'powershell.exe'), p(201, 200, T + 600, 'codeagentcli.exe'),
  p(300, 1, T - 5000, 'notepad.exe'),
] };

test('captureTree：从快照取整棵树（含根）；根不在快照里返回空', () => {
  const tree = sweep.captureTree(beforeSnap, 100);
  assert.deepEqual(tree.map(m => m.pid).sort((a, b) => a - b), [100, 101, 102, 110, 111, 112, 113, 120, 121]);
  assert.equal(tree.find(m => m.pid === 112).startedAt, T + 3200);
  assert.deepEqual(sweep.captureTree(beforeSnap, 999), []);
  assert.deepEqual(sweep.captureTree(null, 100), []);
});

test('residualTargets：根结束后还活着、PID + 启动时间对得上的才补杀；快照后新派生的孩子一并算上', () => {
  const before = sweep.captureTree(beforeSnap, 100);
  const afterSnap = { processes: [
    p(1, 0, T - 100000, 'aigroupchathub.exe'),
    // pwsh/codeagentcli/serve/cmd/uvx 已被 node-pty 结束；python 和它的 conhost 成了孤儿
    p(112, 111, T + 3200, 'python.exe'), p(113, 112, T + 3300, 'conhost.exe'),
    // node(120) 的 PID 还在但启动时间对不上：PID 被一个新程序复用了，不碰；它下面的 121 也是新程序的孩子
    p(120, 1, T + 90000, 'chrome.exe'), p(121, 120, T + 90100, 'chrome.exe'),
    // 快照之后才由 serve(102，已死) 派生的又一批插件：父是树成员、启动晚于父 → 算
    p(130, 102, T + 60000, 'cmd.exe'), p(131, 130, T + 60100, 'python.exe'),
    // 父 PID 是树成员 101，但启动时间早于 101：不是它的孩子
    p(140, 101, T - 50000, 'svchost.exe'),
    p(200, 1, T + 500, 'powershell.exe'), p(201, 200, T + 600, 'codeagentcli.exe'),
    p(300, 1, T - 5000, 'notepad.exe'),
  ] };
  const targets = sweep.residualTargets(before, afterSnap, { protect: [1, 200] });
  assert.deepEqual(targets.map(t => t.pid).sort((a, b) => a - b), [112, 113, 130, 131]);
  // 原树还活着的成员也算（比如 serve 没被 node-pty 结束）；protect 里的 PID 绝不碰
  const alive = { processes: [...beforeSnap.processes] };
  const all = sweep.residualTargets(before, alive, { protect: [1, 200, 102] }).map(t => t.pid).sort((a, b) => a - b);
  assert.deepEqual(all, [100, 101, 110, 111, 112, 113, 120, 121]);
  assert.deepEqual(sweep.residualTargets([], alive), []);
});

test('createTreeSweeper：capture 用最近快照、sweep 重新枚举后按 PID 结束；枚举失败不杀任何进程', async () => {
  const killed = [], logs = [];
  let after = { processes: [p(1, 0, T - 100000), p(112, 111, T + 3200, 'python.exe'), p(113, 112, T + 3300, 'conhost.exe')] };
  const inspector = { getCached: () => beforeSnap, snapshot: async opts => { assert.equal(opts.force, true); if (!after) throw new Error('枚举超时'); return after; } };
  let timer = null;
  const s = sweep.createTreeSweeper({ inspector, kill: pid => killed.push(pid), protect: () => [1], log: l => logs.push(l), setTimer: (fn, ms) => { timer = { fn, ms }; } });
  const before = s.capture(100);
  assert.equal(before.length, 9);
  assert.equal(s.schedule(before, 'session=abc'), true);
  assert.equal(timer.ms, sweep.DEFAULT_SWEEP_DELAY_MS);
  timer.fn();
  await new Promise(r => setImmediate(r));
  assert.deepEqual(killed.sort((a, b) => a - b), [112, 113]);
  assert.match(logs[0], /残余补杀 session=abc：原树 9 个进程，根结束后还剩 2 个，已结束 2 个/);
  // 已经自己退出的（ESRCH）不算失败
  const gone = sweep.createTreeSweeper({ inspector, kill: () => { const e = new Error('gone'); e.code = 'ESRCH'; throw e; }, protect: () => [1] });
  const r = await gone.sweep(before);
  assert.equal(r.failed.length, 0); assert.equal(r.killed.length, 0);
  // 重新枚举失败：一个都不杀
  after = null; killed.length = 0;
  const r2 = await s.sweep(before, 'x');
  assert.equal(r2.killed.length, 0); assert.ok(r2.error);
  // 快照里没有根（还没测过）：capture 为空，schedule 不排
  const empty = sweep.createTreeSweeper({ inspector: { getCached: () => null }, kill: () => {} });
  assert.deepEqual(empty.capture(100), []);
  assert.equal(empty.schedule([], 'x'), false);
});
