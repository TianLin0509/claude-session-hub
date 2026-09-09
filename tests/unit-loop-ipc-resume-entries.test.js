'use strict';
/**
 * 「继续 / 重发本轮」这几个**用户入口**本身的契约。
 *
 * 2026-09-08 合并位在真实隔离 Hub 上点出来的：引擎侧我做得没问题，但 IPC 白名单漏了状态 ——
 *   · 开题报告已接收、用户又点过停止（kickoff.status = accepted_stopped）→ 点「重发」报 no_resumable_run
 *   · 循环被停止（loopState.status = stopped_user）→ 点「继续」同样被拒
 * 上一轮我的往返用例直接调引擎，正好绕过了这一层，所以没暴露。这个文件补的就是这一层。
 *
 * 跑法：node tests/unit-loop-ipc-resume-entries.test.js
 */
const assert = require('node:assert');
const { registerLoopIpc } = require('../main/ipc/loop-handlers.js');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (error) { fail++; console.log('  ✗ ' + name + '\n      ' + (error && error.message)); }
}

/** 最小 ipcMain：只记住 handler，方便直接调。 */
function fakeIpc() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, args) => {
      const fn = handlers.get(channel);
      if (!fn) throw new Error('no handler for ' + channel);
      return fn({}, args);
    },
    has: (channel) => handlers.has(channel),
  };
}

function fakeEngine(status = {}) {
  const calls = { kickoff: [], loop: [], clearStop: [] };
  let stopIntent = status.stopRequested || null;
  return {
    calls,
    getStopIntent: () => stopIntent,
    engine: {
      isRunning: () => false,
      getStatus: () => ({ running: false, loopState: null, serialRunState: null, kickoff: null, ...status }),
      validateLoop: () => ({ ok: true }),
      validateResume: () => ({ ok: true }),
      validateSerial: () => ({ ok: true }),
      clearStopIntent: (id) => { calls.clearStop.push(id); stopIntent = null; },
      stopIntentOf: () => stopIntent,
      runKickoff: async (id, opts) => { calls.kickoff.push({ id, opts }); return { ok: true }; },
      runLoop: async (id, input, persisted) => { calls.loop.push({ id, input, persisted }); return { status: 'running' }; },
      runSerial: async () => ({ status: 'running' }),
      stopLoop: () => true,
    },
  };
}

(async () => {
  console.log('loop IPC · 接续入口');

  await t('阻断 开题报告已接收但用户停过 → 点「重发」能接着走，不再报 no_resumable_run', async () => {
    const ipc = fakeIpc();
    const f = fakeEngine({
      kickoff: { status: 'accepted_stopped', authorMemberId: 'm2', reportPath: 'C:/hub/task-docs/m/已完成-开题报告.md' },
      stopRequested: { at: Date.now(), reason: 'user_stop' },
    });
    registerLoopIpc(ipc, { loopEngine: f.engine, logger: { error: () => {}, warn: () => {} } });
    const result = await ipc.invoke('dev:redispatch', { meetingId: 'mtg' });
    assert.strictEqual(result.ok, true, '这是用户明确要求接续，不能拒绝');
    assert.strictEqual(result.stage, 'kickoff');
    assert.strictEqual(f.calls.kickoff.length, 1, '走开题那条路重扫已接收的报告');
    assert.strictEqual(f.calls.kickoff[0].opts.authorMemberId, 'm2', '沿用原执笔者，不换人');
    assert.strictEqual(f.calls.kickoff[0].opts.dispatch, false,
      '报告已经交过了：只重扫接着开工，不要再派一次开题任务');
    assert.deepStrictEqual(f.calls.clearStop, ['mtg'], '接续前必须先清掉落盘的停止意图');
    assert.strictEqual(f.getStopIntent(), null);
  });

  await t('阻断 循环被停止（stopped_user）→ 点「继续」和「重发」都能接着走', async () => {
    for (const channel of ['loop:resume', 'dev:redispatch']) {
      const ipc = fakeIpc();
      const f = fakeEngine({
        loopState: { status: 'stopped_user', round: 1, currentStep: 'reviewer', posBase: 1, goal: '原目标' },
        stopRequested: { at: Date.now(), reason: 'user_stop' },
      });
      registerLoopIpc(ipc, { loopEngine: f.engine, logger: { error: () => {}, warn: () => {} } });
      const result = await ipc.invoke(channel, { meetingId: 'mtg' });
      assert.strictEqual(result.ok, true, channel + ' 必须接纳 stopped_user');
      assert.strictEqual(f.calls.loop.length, 1, channel + ' 应当从持久检查点续跑');
      assert.strictEqual(f.calls.loop[0].persisted.status, 'running');
      assert.strictEqual(f.calls.loop[0].persisted.round, 1, '不重置轮次');
      assert.strictEqual(f.calls.loop[0].persisted.posBase, 1, '沿用同一个阶段文件起点');
      assert.deepStrictEqual(f.calls.clearStop, ['mtg'], channel + ' 也要先清停止意图');
    }
  });

  await t('开题 prompt 根本没送进 CLI（dispatch_failed）→ 重发必须能真的再派一次', async () => {
    const ipc = fakeIpc();
    const f = fakeEngine({ kickoff: { status: 'dispatch_failed', authorMemberId: 'm1', lastReason: 'cli_not_ready' } });
    registerLoopIpc(ipc, { loopEngine: f.engine, logger: { error: () => {}, warn: () => {} } });
    const result = await ipc.invoke('dev:redispatch', { meetingId: 'mtg' });
    assert.strictEqual(result.ok, true, '派发失败是最需要「重发」的场景，不能被白名单挡在外面');
    assert.strictEqual(f.calls.kickoff.length, 1);
    assert.notStrictEqual(f.calls.kickoff[0].opts.dispatch, false, '这次是真的要重新派，不是只重扫');
  });

  await t('确实没有可接续的东西时，仍然如实说 no_resumable_run', async () => {
    const ipc = fakeIpc();
    const f = fakeEngine({});
    registerLoopIpc(ipc, { loopEngine: f.engine, logger: { error: () => {}, warn: () => {} } });
    const result = await ipc.invoke('dev:redispatch', { meetingId: 'mtg' });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'no_resumable_run');
    assert.strictEqual(f.calls.kickoff.length + f.calls.loop.length, 0, '没得接就什么都不启动');
  });

  await t('开题还在等报告 → 重发是真的再派一次给原执笔者', async () => {
    const ipc = fakeIpc();
    const f = fakeEngine({ kickoff: { status: 'awaiting_report', authorMemberId: 'm1' } });
    registerLoopIpc(ipc, { loopEngine: f.engine, logger: { error: () => {}, warn: () => {} } });
    const result = await ipc.invoke('dev:redispatch', { meetingId: 'mtg' });
    assert.strictEqual(result.ok, true);
    assert.notStrictEqual(f.calls.kickoff[0].opts.dispatch, false, '报告还没交，这时候重发就是要重新派');
  });

  await t('运行中不许重复提交：双击 / 重复 IPC 只会有一次执行', async () => {
    const ipc = fakeIpc();
    const f = fakeEngine({ loopState: { status: 'paused' } });
    f.engine.isRunning = () => true;
    registerLoopIpc(ipc, { loopEngine: f.engine, logger: { error: () => {}, warn: () => {} } });
    const [a, b] = await Promise.all([
      ipc.invoke('dev:redispatch', { meetingId: 'mtg' }),
      ipc.invoke('dev:redispatch', { meetingId: 'mtg' }),
    ]);
    assert.strictEqual(a.ok, false);
    assert.strictEqual(b.ok, false);
    assert.strictEqual(a.reason, 'already_running');
    assert.strictEqual(f.calls.loop.length, 0);
  });

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
