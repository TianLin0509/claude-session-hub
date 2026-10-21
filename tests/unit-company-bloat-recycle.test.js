'use strict';
// 通道会话「膨胀回收」（2026-10-21，Q-1021-05 公司真机只读回执）：CodeAgent CLI 每轮追问多起一批 MCP 插件、旧批不关，
// 一个会话涨到 4.1–4.8 GB。答完空闲 2 分钟、进程树实测 ≥ 3.2 GB 的通道会话先收起，追问时按编号恢复（只剩一批插件）。
const test = require('node:test');
const assert = require('node:assert/strict');
const care = require('../core/company-bridge/session-care');
const { rig } = require('./helpers/company-bridge-rig');

const MIN = 60000, GB = 1024 ** 3;
const NOW = 1_800_000_000_000;
const ROOMY = { total: 32 * GB, free: 16 * GB, ratio: 0.5 };

// ---------------------------------------------------------------- planRelease 膨胀规则（纯函数）
test('膨胀：4.6 GB 空闲 3 分钟 → 收，reason 带 GB；空闲 1 分钟 → 不收；2.5 GB 空闲 3 分钟未到保温 → 不收', () => {
  assert.equal(care.BLOAT_BYTES, 3.2 * GB);
  assert.equal(care.BLOAT_MIN_IDLE_MS, 2 * MIN);
  const plan = care.planRelease({ now: NOW, keepWarmMs: 45 * MIN, memory: ROOMY, candidates: [
    { sessionId: 'big3', threadId: 'Q-1', idleSince: NOW - 3 * MIN, askerActive: false, bytes: 4.6 * GB },
    { sessionId: 'big1', threadId: 'Q-2', idleSince: NOW - 1 * MIN, askerActive: false, bytes: 4.6 * GB },
    { sessionId: 'ok3', threadId: 'Q-3', idleSince: NOW - 3 * MIN, askerActive: false, bytes: 2.5 * GB },
    { sessionId: 'bigAsker', threadId: 'Q-4', idleSince: NOW - 3 * MIN, askerActive: true, bytes: 4.6 * GB },
  ] });
  assert.deepEqual(plan.map(p => p.sessionId), ['big3', 'bigAsker'], '发问方活跃也收：恢复后的会话照样能接着答');
  assert.equal(plan[0].rule, 'bloat');
  assert.match(plan[0].reason, /进程树 4\.6 GB/);
  assert.match(plan[0].reason, /GB.*答完 3 分钟空闲.*追问时自动续上/);
});

test('膨胀：bytes 缺失时行为与原来完全一致（回归）', () => {
  const candidates = [
    { sessionId: 'a', threadId: 'Q-1', idleSince: NOW - 50 * MIN, askerActive: false },
    { sessionId: 'b', threadId: 'Q-2', idleSince: NOW - 50 * MIN, askerActive: true },
    { sessionId: 'c', threadId: 'Q-3', idleSince: NOW - 3 * MIN, askerActive: false },
  ];
  const plan = care.planRelease({ now: NOW, keepWarmMs: 45 * MIN, memory: ROOMY, candidates });
  assert.deepEqual(plan.map(p => p.sessionId), ['a']);
  assert.equal(plan[0].reason, '答完 50 分钟没人追问（保温 45 分钟）');
  // 内存紧：按每会话估计值累加，收的个数与原来一致（2 GB 可用 / 32 GB，按 3.8 GB 一个要收到 ≥ 9.6 GB → 2 个）
  const tight = { total: 32 * GB, free: 2 * GB, ratio: 2 / 32 };
  const many = Array.from({ length: 5 }, (_, i) => ({ sessionId: 's' + i, threadId: 'Q-' + i, idleSince: NOW - (10 + i) * MIN, askerActive: false }));
  const p2 = care.planRelease({ now: NOW, keepWarmMs: 45 * MIN, memory: tight, candidates: many });
  assert.deepEqual(p2.map(p => p.sessionId), ['s4', 's3'], '2 + 3.8×2 = 9.6 GB 正好 30%');
  assert.ok(p2.every(p => p.rule === 'memory' && !/进程树/.test(p.reason)));
});

test('内存紧：释放量按候选自己的实测 bytes 累加（4.6 / 2.4 GB），缺失的才按每会话估计', () => {
  const tight = { total: 32 * GB, free: 2 * GB, ratio: 2 / 32 };
  // 都没到膨胀线（空闲 1 分钟），只看内存规则。要收到 ≥ 9.6 GB
  const two = [
    { sessionId: 'x', threadId: 'Q-x', idleSince: NOW - 1.5 * MIN, askerActive: false, bytes: 4.6 * GB },
    { sessionId: 'y', threadId: 'Q-y', idleSince: NOW - 1 * MIN, askerActive: false, bytes: 2.4 * GB },
    { sessionId: 'z', threadId: 'Q-z', idleSince: NOW - 0.5 * MIN, askerActive: false },
  ];
  const plan = care.planRelease({ now: NOW, keepWarmMs: 45 * MIN, memory: tight, candidates: two, sessionBytes: 3.8 * GB });
  // 2 + 4.6 = 6.6 → 加 2.4 = 9.0（仍 < 9.6）→ 加 z 的 3.8 = 12.8 才够；若都按 3.8 算，收 x、y 两个就够了
  assert.deepEqual(plan.map(p => p.sessionId), ['x', 'y', 'z']);
  assert.match(plan[0].reason, /进程树 4\.6 GB/);
  // 已按膨胀收掉的那个也按实测计入腾出的空间（可用 1 GB）：膨胀收掉 x 后 1 + 4.6 = 5.6 GB（17.5%），再按实测收 y（2.4）= 8.0，仍不到 9.6 再收 z
  const withBloat = care.planRelease({ now: NOW, keepWarmMs: 45 * MIN, memory: { total: 32 * GB, free: 1 * GB, ratio: 1 / 32 }, sessionBytes: 3.8 * GB, candidates: [
    { sessionId: 'x', threadId: 'Q-x', idleSince: NOW - 3 * MIN, askerActive: false, bytes: 4.6 * GB }, ...two.slice(1)] });
  assert.deepEqual(withBloat.map(p => [p.sessionId, p.rule]), [['x', 'bloat'], ['y', 'memory'], ['z', 'memory']]);
  const enough = care.planRelease({ now: NOW, keepWarmMs: 45 * MIN, memory: { total: 32 * GB, free: 5.5 * GB, ratio: 5.5 / 32 }, sessionBytes: 3.8 * GB, candidates: [
    { sessionId: 'x', threadId: 'Q-x', idleSince: NOW - 3 * MIN, askerActive: false, bytes: 4.6 * GB }, ...two.slice(1)] });
  assert.deepEqual(enough.map(p => p.sessionId), ['x'], '5.5 + 4.6 = 10.1 GB ≥ 30%，不再多收');
  const notTight = care.planRelease({ now: NOW, keepWarmMs: 45 * MIN, memory: tight, sessionBytes: 3.8 * GB, candidates: [
    { sessionId: 'x', threadId: 'Q-x', idleSince: NOW - 3 * MIN, askerActive: false, bytes: 4.6 * GB }, ...two.slice(1)] });
  assert.deepEqual(notTight.map(p => p.sessionId), ['x'], '可用 2 GB 时膨胀收掉 x 后 6.6 GB（20.6%）已不算紧，若按 3.8 GB 估则 5.8 GB 仍紧、会多收');
});

// ---------------------------------------------------------------- 估计器：每会话实测
test('估计器：测量返回 [{id, bytes}] 后 byId / bytesOf 可读；测量失败时 byId 为空、不抛错', async () => {
  let fail = false;
  const est = care.createSessionMemEstimator({ now: () => NOW, measure: async () => {
    if (fail) throw new Error('进程枚举超时');
    return [{ id: 'a', bytes: 4.6 * GB }, { id: 'b', bytes: 2.4 * GB }, { id: 'tiny', bytes: 100 * 1024 ** 2 }];
  } });
  assert.deepEqual(est.current().byId, {}, '还没测：空');
  assert.equal(est.bytesOf('a'), null);
  await est.refresh();
  const cur = est.current();
  assert.equal(cur.byId.a, 4.6 * GB); assert.equal(cur.byId.b, 2.4 * GB);
  assert.equal(cur.byId.tiny, 100 * 1024 ** 2, '没加载完的会话不当均值样本，但它自己的实测照留');
  assert.equal(cur.samples, 2); assert.equal(cur.bytes, Math.round(3.5 * GB));
  assert.equal(est.bytesOf('b'), 2.4 * GB); assert.equal(est.bytesOf('nope'), null);
  cur.byId.a = 0; assert.equal(est.bytesOf('a'), 4.6 * GB, 'current() 给的是副本');
  fail = true;
  await assert.doesNotReject(est.refresh());
  assert.deepEqual(est.current().byId, {}); assert.equal(est.bytesOf('a'), null);
  assert.equal(est.current().source, 'default');
  // 老格式（只给字节数）照常算均值，byId 为空
  const old = care.createSessionMemEstimator({ now: () => NOW, measure: async () => [2 * GB, 2 * GB] });
  await old.refresh();
  assert.equal(old.current().samples, 2); assert.deepEqual(old.current().byId, {});
});

// ---------------------------------------------------------------- company 层：careSessions（tests/helpers/company-bridge-rig.js）
function setup(t, { memory = null, measure } = {}) {
  const r = rig(t, { companyDeps: {
    ...(memory ? { memory: () => memory } : {}),
    measureSessionMem: measure,
  } });
  r.cs.suspended = [];
  // rig 的假会话没有休眠，这里挂到 company.deps 上
  r.company.deps.suspendSession = (id, opts) => { r.cs.suspended.push({ id, opts }); r.cs.stored.set(id, r.cs.map.get(id)); r.cs.map.delete(id); return { ok: true }; };
  const add = (id, sessionId, extra = {}) => {
    r.cs.map.set(sessionId, { id: sessionId, kind: 'codeagent', status: 'idle' });
    r.company.saveThread({ id, gen: 'g1', title: id, createdAt: r.clock.now - 30 * MIN, sessionId,
      rounds: [{ round: 1, question: id, reply: 'ok', receivedAt: r.clock.now - 20 * MIN, replyAt: r.clock.now - 3 * MIN }], ...extra });
  };
  return { ...r, add };
}

for (const [label, memory] of [['内存宽裕（rig 默认钉 50%）', null], ['内存紧（可用约 3%）', { total: 32 * GB, free: 1 * GB, ratio: 1 / 32 }]]) {
  test(`company：某空闲通道会话实测 4.6 GB → 按膨胀休眠；在途、正在干活、非通道会话不动 · ${label}`, async t => {
    const bytes = { 's-bloat': 4.6 * GB, 's-run': 4.8 * GB, 's-busy': 4.7 * GB, 's-mine': 4.9 * GB, 's-ok': 2.5 * GB };
    const x = setup(t, { memory, measure: async () => Object.entries(bytes).map(([id, b]) => ({ id, bytes: b })) });
    x.add('Q-BLOAT', 's-bloat');
    x.add('Q-OK', 's-ok');
    x.add('Q-RUN', 's-run', { state: 'running', rounds: [{ round: 1, question: 'q', receivedAt: x.clock.now - 5 * MIN, sentAt: x.clock.now - 5 * MIN }] });
    x.add('Q-BUSY', 's-busy'); x.cs.busy.add('s-busy');
    x.cs.map.set('s-mine', { id: 's-mine', kind: 'codeagent', status: 'idle' }); // 用户自己开的 CodeAgent 会话：没有通道线索指向它
    await x.company.sessionMem.refresh();
    x.company.careSessions();
    const ids = x.cs.suspended.map(v => v.id);
    assert.ok(ids.includes('s-bloat'), '膨胀的空闲通道会话被收');
    const bloat = x.cs.suspended.find(v => v.id === 's-bloat');
    assert.equal(bloat.opts.reason, 'company-bridge-bloat');
    assert.equal(bloat.opts.excludePinned, true); assert.equal(bloat.opts.excludeFocused, true); assert.equal(bloat.opts.excludeMeeting, true);
    for (const id of ['s-run', 's-busy', 's-mine']) assert.ok(!ids.includes(id), `${id} 不动`);
    if (!memory) assert.deepEqual(ids, ['s-bloat'], '内存宽裕：2.5 GB 的会话未到保温不收');
    else {
      // 1 + 4.6 = 5.6 GB（17.5%）仍低于 20% → 再按实测收 s-ok（2.5 GB）
      assert.deepEqual(ids, ['s-bloat', 's-ok']);
      assert.equal(x.cs.suspended[1].opts.reason, 'company-bridge-idle');
    }
    // --diag hub / 状态里能看到每个会话的实测 GB、是否因膨胀被收
    const st = x.company.careState;
    assert.equal(st.bloatGB, 3.2);
    const row = st.sessions.find(s => s.threadId === 'Q-BLOAT');
    assert.equal(row.gb, 4.6); assert.equal(row.release, 'bloat'); assert.equal(row.idleMinutes, 3);
    assert.equal(st.sessions.find(s => s.threadId === 'Q-OK').gb, 2.5);
    assert.deepEqual(st.bloatSuspended.map(b => [b.threadId, b.gb, b.ok]), [['Q-BLOAT', 4.6, true]]);
    const log = require('node:fs').readFileSync(require('node:path').join(x.root, 'company', 'logs', 'company-session-care.log'), 'utf8');
    assert.match(log, /suspend Q-BLOAT session=s-bloat 进程树 4\.6 GB/);
    // 下一轮（60 秒后）careState 里的膨胀记录保留
    x.clock.now += MIN;
    x.company.careSessions();
    assert.equal(x.company.careState.bloatSuspended.length, 1);
  });
}

test('company：只认答完之后的测量（休眠前的旧值不套到恢复后的会话上）；没有测量时行为不变', async t => {
  let calls = 0;
  const x = setup(t, { measure: async () => { calls += 1; return [{ id: 's-a', bytes: 4.6 * GB }]; } });
  await x.company.sessionMem.refresh(); // 在 NOW 测到 4.6 GB
  x.clock.now += 2 * MIN;
  // 之后这个会话又答了一轮（replyAt 晚于测量），空闲 3 分钟——测量比答完早，不按膨胀收
  x.add('Q-A', 's-a', { rounds: [{ round: 1, question: 'a', reply: 'ok', replyAt: x.clock.now - 1 * MIN }] });
  x.clock.now += 2 * MIN;
  x.company.sessionMem.current = () => ({ bytes: 3.8 * GB, source: 'measured', samples: 1, at: x.clock.now - 4 * MIN, byId: { 's-a': 4.6 * GB } });
  x.company.careSessions();
  assert.equal(x.cs.suspended.length, 0);
  assert.equal(x.company.careState.sessions[0].gb, null);
  assert.ok(calls >= 1);
});
