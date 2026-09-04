'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  describeWriters,
  findCodexThreadWriters,
} = require('../core/codex-thread-writer.js');

const SID_A = '01a05397-7f2b-7d61-8270-040765f51db1';
const SID_B = '01a05397-7f40-79a1-85a9-1cc8eb4ee4bb';

function fakeExecFile(processes) {
  return async () => ({ stdout: JSON.stringify({ processes }), stderr: '' });
}

const skipOnPosix = { skip: process.platform !== 'win32' ? '仅 Windows 有 codex.exe 命令行形态' : false };

test('a live `codex resume <sid>` process marks that thread as occupied', skipOnPosix, async () => {
  const occupied = await findCodexThreadWriters([SID_A, SID_B], {
    execFile: fakeExecFile([
      { pid: 40496, cmd: `codex.exe resume ${SID_A} --dangerously-bypass-approvals-and-sandbox --model gpt-5.6-sol` },
    ]),
  });
  assert.deepEqual([...occupied.keys()], [SID_A]);
  assert.equal(occupied.get(SID_A)[0].pid, 40496);
  assert.equal(describeWriters(occupied.get(SID_A)), 'PID 40496');
});

test('sid matching is case-insensitive in both directions', skipOnPosix, async () => {
  const occupied = await findCodexThreadWriters([SID_A.toUpperCase()], {
    execFile: fakeExecFile([{ pid: 7, cmd: `codex.exe resume ${SID_A.toUpperCase()}` }]),
  });
  assert.equal(occupied.size, 1);
  assert.ok(occupied.has(SID_A));
});

test('our own pids are excluded so a Hub never blocks itself', skipOnPosix, async () => {
  const occupied = await findCodexThreadWriters([SID_A], {
    execFile: fakeExecFile([{ pid: 999, cmd: `codex.exe resume ${SID_A}` }]),
    excludePids: [999],
  });
  assert.equal(occupied.size, 0);
});

test('an unrelated codex process does not mark anything occupied', skipOnPosix, async () => {
  const occupied = await findCodexThreadWriters([SID_A], {
    execFile: fakeExecFile([{ pid: 1, cmd: 'codex.exe --model gpt-5.6-sol' }, { pid: 2, cmd: '' }]),
  });
  assert.equal(occupied.size, 0);
});

test('enumeration failure is reported as "not occupied", never as occupied', skipOnPosix, async () => {
  // 这条是刻意的方向选择：探测失败只该退回今天的行为（照常 resume），
  // 反过来误判成占用会把本可以续上的会话降级成 fresh，丢掉上下文。
  const warned = [];
  const occupied = await findCodexThreadWriters([SID_A], {
    execFile: async () => { throw new Error('powershell exploded'); },
    logger: { warn: (...args) => warned.push(args.join(' ')) },
  });
  assert.equal(occupied.size, 0);
  assert.match(warned.join('\n'), /按未占用处理/);
});

test('empty stdout and empty sid lists short-circuit without spawning anything', async () => {
  let spawned = 0;
  const counting = async () => { spawned += 1; return { stdout: '', stderr: '' }; };
  assert.equal((await findCodexThreadWriters([], { execFile: counting })).size, 0);
  assert.equal((await findCodexThreadWriters(['', null, undefined], { execFile: counting })).size, 0);
  assert.equal(spawned, 0, '没有要查的 sid 时不该起 PowerShell');
});

test('describeWriters lists every holder so the log names all of them', () => {
  assert.equal(describeWriters([{ pid: 11 }, { pid: 22 }]), 'PID 11 / PID 22');
  assert.equal(describeWriters(null), '');
});
