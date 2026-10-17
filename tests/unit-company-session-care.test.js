'use strict';
// 会话管理 × AI特战队通道 第一步（2026-10-16 田哥「全部按推荐实现并发布」；设计见 core/company-bridge/session-care.js 开头）：
// 名额只算干活中、已有会话的线索先派；发出后核实提问进没进记录；答完的会话按追问规律与内存余量休眠；补收；家里报发问方活跃。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const care = require('../core/company-bridge/session-care');
const { CompanyBridge } = require('../core/company-bridge/company');
const { transcriptHasRequest, receiptPromptFingerprint } = require('../core/company-bridge/receipt-reader');

const MIN = 60000, GB = 1024 ** 3;

// ---------------------------------------------------------------- 保温时长与回收计划（纯函数）
const thread = (...gapsMin) => {
  let t = 1_800_000_000_000;
  const rounds = [{ round: 1, receivedAt: t, replyAt: t + MIN }];
  for (const [i, g] of gapsMin.entries()) {
    const prev = rounds[rounds.length - 1];
    rounds.push({ round: i + 2, receivedAt: prev.replyAt + g * MIN, replyAt: prev.replyAt + g * MIN + MIN });
  }
  return { id: 'Q', rounds };
};

test('保温时长：样本不足 8 个用 45 分钟；够了取追问间隔的 90% 分位，限在 10–120 分钟', () => {
  assert.deepEqual(care.learnKeepWarm([thread(2, 3)]), { ms: 45 * MIN, samples: 2, learned: false });
  // 今天家里派单记录的真实分布：中位 2.4 分，90% 分位 53 分左右
  const real = thread(1, 2, 2, 2.4, 3, 5, 10, 21, 30, 53, 64);
  const k = care.learnKeepWarm([real]);
  assert.equal(k.learned, true); assert.equal(k.samples, 11);
  assert.equal(Math.round(k.ms / MIN), 53, '11 个样本的 90% 分位取第 10 小的，与回放的 53 分钟一致');
  assert.equal(care.learnKeepWarm([thread(1, 1, 1, 1, 1, 1, 1, 1)]).ms, 10 * MIN, '下限 10 分钟');
  assert.equal(care.learnKeepWarm([thread(300, 300, 300, 300, 300, 300, 300, 300)]).ms, 120 * MIN, '上限 120 分钟');
});

test('回收计划：内存宽裕时只收超过保温时长的；发问方活跃的保温加倍', () => {
  const now = 1_800_000_000_000, memory = { total: 32 * GB, free: 16 * GB, ratio: 0.5 };
  const plan = care.planRelease({ now, keepWarmMs: 45 * MIN, memory, candidates: [
    { sessionId: 'a', threadId: 'Q-1', idleSince: now - 50 * MIN, askerActive: false },
    { sessionId: 'b', threadId: 'Q-2', idleSince: now - 50 * MIN, askerActive: true },
    { sessionId: 'c', threadId: 'Q-3', idleSince: now - 10 * MIN, askerActive: false },
  ] });
  assert.deepEqual(plan.map(p => p.sessionId), ['a']);
  assert.match(plan[0].reason, /答完 50 分钟没人追问（保温 45 分钟）/);
});

test('回收计划：内存低于 20% 时先收最冷的（发问方不活跃、答完最久），收到 30% 为止', () => {
  const now = 1_800_000_000_000, memory = { total: 32 * GB, free: 2.5 * GB, ratio: 2.5 / 32 };
  const plan = care.planRelease({ now, keepWarmMs: 45 * MIN, memory, candidates: [
    { sessionId: 'warm-asker', threadId: 'Q-1', idleSince: now - 30 * MIN, askerActive: true },
    { sessionId: 'old', threadId: 'Q-2', idleSince: now - 40 * MIN, askerActive: false },
    { sessionId: 'new', threadId: 'Q-3', idleSince: now - 5 * MIN, askerActive: false },
    { sessionId: 'n4', threadId: 'Q-4', idleSince: now - 4 * MIN, askerActive: false },
    { sessionId: 'n5', threadId: 'Q-5', idleSince: now - 3 * MIN, askerActive: false },
    { sessionId: 'n6', threadId: 'Q-6', idleSince: now - 2 * MIN, askerActive: false },
    { sessionId: 'n7', threadId: 'Q-7', idleSince: now - 1 * MIN, askerActive: false },
    { sessionId: 'n8', threadId: 'Q-8', idleSince: now - 1 * MIN, askerActive: false },
  ] });
  // 需要从 2.5 GB 升到 ≥9.6 GB（30%），每个约 1.3 GB → 收 6 个；发问方活跃的排在最后，不在这 6 个里
  assert.deepEqual(plan.map(p => p.sessionId), ['old', 'new', 'n4', 'n5', 'n6', 'n7']);
  assert.ok(plan.every(p => /内存紧/.test(p.reason)));
});

// ---------------------------------------------------------------- 通道：名额、核实、收放、补收
function rig(t, { memory = { total: 32 * GB, free: 16 * GB, ratio: 0.5 } } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-session-care-'));
  const clock = { now: 1_800_000_000_000 };
  const s = { map: new Map(), busy: new Set(), finals: new Map(), sent: [], suspended: [], landed: new Map(), stored: new Map(), resumed: [] };
  const company = new CompanyBridge({ dataDir: root, noTimer: true, now: () => clock.now, fallbackCwd: root, isDirectory: () => true,
    fetchImpl: async () => { throw new Error('offline'); }, memory: () => memory,
    createSession: async (kind, opts) => { const x = { id: opts.id, kind, status: 'idle', opts }; s.map.set(opts.id, x); return x; },
    sendPrompt: async (id, text) => { s.sent.push({ id, text }); return { ok: true }; },
    getSession: id => s.map.get(id) || null,
    getSessionMetadata: id => s.map.get(id) || s.stored.get(id) || null,
    resumeSession: async id => { const m = s.stored.get(id); if (m) { s.map.set(id, { ...m }); s.resumed.push(id); } },
    isAgentTurnActive: id => s.busy.has(id),
    readFinals: meta => s.finals.get(meta.id) || [],
    transcriptHasRequest: (meta, r) => s.landed.has(`${meta?.id}#${r.round}`) ? s.landed.get(`${meta.id}#${r.round}`) : null,
    suspendSession: (id, opts) => { s.suspended.push({ id, opts }); s.stored.set(id, s.map.get(id)); s.map.delete(id); return { ok: true }; },
    sessionInputAt: id => s.inputAt?.get(id) || 0,
  });
  company.link.saveConfig({ state: 'paired', gen: 'g1', secret: require('../core/company-bridge/crypto').newSecret(), baseUrl: 'https://fixture.invalid/api' });
  company.link.flush = async () => {};
  t.after(() => { company.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const add = (id, rounds, extra = {}) => company.saveThread({ id, gen: 'g1', title: id, createdAt: clock.now, sessionId: null, rounds, ...extra });
  const replies = () => (company.store.get('outbox') || []).filter(x => x.type === 'reply').length;
  return { company, clock, s, add, replies, root };
}

test('名额只算干活中：一个线索回答写完只在等核对（会话空闲），不再挡住新问题', async t => {
  const x = rig(t);
  x.s.map.set('sess-a', { id: 'sess-a', status: 'idle' });
  x.add('Q-A', [{ round: 1, question: 'a', receivedAt: x.clock.now, sentAt: x.clock.now - 20 * MIN }], { sessionId: 'sess-a' });
  x.s.map.set('sess-b', { id: 'sess-b', status: 'idle' }); x.s.busy.add('sess-b');
  x.add('Q-B', [{ round: 1, question: 'b', receivedAt: x.clock.now, sentAt: x.clock.now - 20 * MIN }], { sessionId: 'sess-b' });
  x.add('Q-C', [{ round: 1, question: '新问题', receivedAt: x.clock.now }]);
  await x.company.advance();
  assert.equal(x.company.thread('Q-C').state, 'running', '上限 2：只有 Q-B 真在干活，Q-C 能开工');
  assert.ok(x.s.sent.some(m => /新问题/.test(m.text)));
});

test('排队时已有会话的线索（追问、改写）先派', async t => {
  const x = rig(t);
  x.company.setSettings({ maxParallel: 1 });
  x.add('Q-NEW', [{ round: 1, question: '新开会话的问题', receivedAt: x.clock.now }], { createdAt: x.clock.now - 10 * MIN });
  x.s.map.set('sess-f', { id: 'sess-f', status: 'idle' });
  x.add('Q-FOLLOW', [{ round: 1, question: 'x', reply: 'y', replyAt: x.clock.now - MIN }, { round: 2, question: '追问', receivedAt: x.clock.now }], { sessionId: 'sess-f', everAnswered: true });
  await x.company.advance();
  assert.equal(x.company.thread('Q-FOLLOW').state, 'running');
  assert.equal(x.company.thread('Q-NEW').state, 'queued');
});

test('发出 3 分钟后记录里没有这条提问：重发一次；重发后仍没有，直接报出来（不再干等 30 分钟）', async t => {
  const x = rig(t);
  x.s.map.set('sess-a', { id: 'sess-a', status: 'idle' });
  x.add('Q-A', [{ round: 1, question: 'a', receivedAt: x.clock.now, sentAt: x.clock.now }], { sessionId: 'sess-a' });
  x.s.landed.set('sess-a#1', false);
  x.clock.now += 4 * MIN; await x.company.collect(x.company.thread('Q-A'));
  let r = x.company.thread('Q-A').rounds[0];
  assert.equal(r.resent, true); assert.equal(r.sentAt, null, '回到排队，dispatch 会重发');
  x.company.patchRound(x.company.thread('Q-A'), 1, { sentAt: x.clock.now });
  x.clock.now += 4 * MIN; await x.company.collect(x.company.thread('Q-A'));
  r = x.company.thread('Q-A').rounds[0];
  assert.match(r.error, /提问没能送进公司的 CodeAgent/);
  // 记录里有这条提问：只记一笔，照常等回答
  x.add('Q-B', [{ round: 1, question: 'b', receivedAt: x.clock.now, sentAt: x.clock.now }], { sessionId: 'sess-a' });
  x.s.landed.set('sess-a#1', true);
  x.clock.now += 4 * MIN; await x.company.collect(x.company.thread('Q-B'));
  assert.equal(x.company.thread('Q-B').rounds[0].landed, true);
  assert.equal(x.company.thread('Q-B').rounds[0].error ?? null, null);
});

test('答完的通道会话：过了学到的保温时长就休眠（带原因写日志）；在途的、正在干活的不收', async t => {
  const x = rig(t);
  for (const id of ['s-old', 's-fresh', 's-busy', 's-run']) x.s.map.set(id, { id, status: 'idle' });
  x.s.busy.add('s-busy');
  x.add('Q-OLD', [{ round: 1, question: 'a', reply: 'b', replyAt: x.clock.now - 60 * MIN }], { sessionId: 's-old' });
  x.add('Q-FRESH', [{ round: 1, question: 'a', reply: 'b', replyAt: x.clock.now - 5 * MIN }], { sessionId: 's-fresh' });
  x.add('Q-BUSY', [{ round: 1, question: 'a', reply: 'b', replyAt: x.clock.now - 90 * MIN }], { sessionId: 's-busy' });
  x.add('Q-RUN', [{ round: 1, question: 'a', reply: 'b', replyAt: x.clock.now - 90 * MIN }, { round: 2, question: 'c', receivedAt: x.clock.now, sentAt: x.clock.now }], { sessionId: 's-run' });
  x.company.careSessions();
  assert.deepEqual(x.s.suspended.map(v => v.id), ['s-old']);
  assert.equal(x.s.suspended[0].opts.reason, 'company-bridge-idle');
  assert.equal(x.s.suspended[0].opts.excludeFocused, true); assert.equal(x.s.suspended[0].opts.excludePinned, true); assert.equal(x.s.suspended[0].opts.excludeMeeting, true);
  const log = fs.readFileSync(path.join(x.root, 'logs', 'company-session-care.log'), 'utf8');
  assert.match(log, /suspend Q-OLD session=s-old 答完 60 分钟没人追问（保温 45 分钟）/);
  assert.equal(x.company.status().care.keepWarmMinutes, 45);
  // 一分钟内不重复巡检
  x.company.careSessions(); assert.equal(x.s.suspended.length, 1);
});

test('家里报发问方还在活动：保温加倍；休眠后的追问照常按编号恢复会话', async t => {
  const x = rig(t);
  x.s.map.set('s-a', { id: 's-a', status: 'idle' });
  x.add('Q-A', [{ round: 1, question: 'a', reply: 'b', replyAt: x.clock.now - 60 * MIN }], { sessionId: 's-a', everAnswered: true });
  x.company.receive({ type: 'asker', gen: 'g1', threads: ['Q-A'] });
  x.company.careSessions();
  assert.equal(x.s.suspended.length, 0, '60 分钟 < 45×2');
  x.clock.now += 35 * MIN; x.company.lastCareAt = 0;
  x.company.careSessions();
  assert.equal(x.s.suspended.length, 1, '95 分钟 > 90，且「活跃」报告已过期（15 分钟）');
  x.company.receive({ type: 'followup', thread: 'Q-A', gen: 'g1', round: 2, question: '再问一句', mid: 'm2' });
  await x.company.advance();
  assert.deepEqual(x.s.resumed, ['s-a']);
  assert.ok(x.s.sent.some(m => /再问一句/.test(m.text)));
});

test('补收：没答上的一轮取回发出之后最新的回答（开头注明补收）；没有新回答就回一条说明', async t => {
  const x = rig(t);
  x.s.map.set('s-a', { id: 's-a', status: 'idle' });
  x.s.finals.set('s-a', [{ id: 'old', text: '上一轮的回答', timestamp: x.clock.now - 60 * MIN }, { id: 'new', text: '这一轮其实写好的回答', timestamp: x.clock.now - 5 * MIN }]);
  x.add('Q-A', [{ round: 1, question: 'a', reply: '上一轮的回答', replyAt: x.clock.now - 60 * MIN },
    { round: 2, question: 'b', receivedAt: x.clock.now - 40 * MIN, sentAt: x.clock.now - 40 * MIN, baseline: 'old', error: '会话停下了，但一直没读到回答', failedAt: x.clock.now - 10 * MIN }], { sessionId: 's-a' });
  await x.company.recollect({ type: 'recollect', thread: 'Q-A', gen: 'g1', round: 2 });
  const r = x.company.thread('Q-A').rounds[1];
  assert.match(r.reply, /^（补收：/); assert.match(r.reply, /这一轮其实写好的回答/);
  assert.equal(r.error, null); assert.equal(r.meta.recollected, true);
  assert.equal(x.replies(), 1);
  // 没有新回答
  x.add('Q-B', [{ round: 1, question: 'a', receivedAt: x.clock.now, sentAt: x.clock.now, error: '会话停下了', failedAt: x.clock.now }], { sessionId: 's-a' });
  x.s.finals.set('s-a', [{ id: 'old', text: '旧的', timestamp: x.clock.now - 60 * MIN }]);
  const sent = [];
  x.company.link.send = async (type, body) => { sent.push({ type, body }); };
  await x.company.recollect({ type: 'recollect', thread: 'Q-B', gen: 'g1', round: 1 });
  assert.equal(x.company.thread('Q-B').rounds[0].reply, undefined);
  assert.ok(sent.some(m => m.type === 'status' && m.body.state === 'error' && /补收不到/.test(m.body.note)));
});

test('提问是否写进记录：同一项目目录里发送后改过的任何记录文件都算（CLI 恢复后可能换了文件）', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-landed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bound = path.join(dir, 'old-id.jsonl'), other = path.join(dir, 'new-id.jsonl');
  const sentAt = Date.now() - 1000;
  const prompt = '## 成员追问（编号 Q-1016-02，第 5 轮）\n\n重发第 4 轮';
  fs.writeFileSync(bound, JSON.stringify({ type: 'user', timestamp: new Date(sentAt - 3600000).toISOString(), message: { role: 'user', content: '更早的提问' } }) + '\n');
  const request = { sentAt, round: 5, threadId: 'Q-1016-02', promptFingerprint: receiptPromptFingerprint(prompt) };
  assert.equal(transcriptHasRequest({ transcriptPath: bound }, request), false);
  fs.writeFileSync(other, JSON.stringify({ type: 'user', timestamp: new Date(sentAt + 500).toISOString(), message: { role: 'user', content: [{ type: 'text', text: '[Image #0]' + prompt }] } }) + '\n');
  assert.equal(transcriptHasRequest({ transcriptPath: bound }, request), true);
  assert.equal(transcriptHasRequest({}, request), null, '不知道记录在哪就不下结论');
});

test('有人在答完的通道会话里直接打过字：从最后一次输入算起，不按回执时间收', t => {
  const x = rig(t);
  x.s.map.set('s-a', { id: 's-a', status: 'idle' });
  x.add('Q-A', [{ round: 1, question: 'a', reply: 'b', replyAt: x.clock.now - 120 * MIN }], { sessionId: 's-a' });
  x.s.inputAt = new Map([['s-a', x.clock.now - 10 * MIN]]);
  x.company.careSessions();
  assert.equal(x.s.suspended.length, 0);
});

// 2026-10-16 田哥：白天算力紧、晚上和周末几乎不受限；通道也要用上号池，加速往返。
test('并行上限：工作日忙时用设定值；晚上、周末放宽；再按可用账号数与内存收', () => {
  // 按本机时区构造（忙时按公司电脑本地时间算）
  const at = (iso) => { const [d, t] = iso.split('T'); const [y, mo, day] = d.split('-').map(Number); const [h, mi] = t.split(':').map(Number); return new Date(y, mo - 1, day, h, mi); };
  const mem = free => ({ total: 32 * GB, free: free * GB, ratio: free / 32 });
  // 周五 10:00 忙时：设定 2、只有个人账号 → 2
  assert.equal(care.parallelCap({ date: at('2026-10-16T10:00:00+08:00'), peakCap: 2, idleCap: 6, lanes: 1, memory: mem(16) }).cap, 2);
  // 周五 21:50 闲时、只有个人账号：每号闲时放到 6 个（2026-10-17 田哥：晚上同时开 6 个没问题）→ 闲时上限 6
  const night = care.parallelCap({ date: at('2026-10-16T21:50:00+08:00'), peakCap: 2, idleCap: 6, lanes: 1, memory: mem(16) });
  assert.equal(night.cap, 6); assert.equal(night.peak, false); assert.equal(night.limitedBy, '闲时上限');
  // 2026-10-17 新默认：工作日忙时 3 个、每号忙时 3 个 → 个人账号白天就能开 3 个
  assert.equal(care.parallelCap({ date: at('2026-10-16T10:00:00+08:00'), lanes: 1, memory: mem(16) }).cap, 3);
  // 每号忙时上限可调：设成 2 时，忙时设定 4 也只开 2
  const peakOne = care.parallelCap({ date: at('2026-10-16T10:00:00+08:00'), peakCap: 4, perAccountPeak: 2, lanes: 1, memory: mem(16) });
  assert.equal(peakOne.cap, 2); assert.match(peakOne.limitedBy, /可用账号数/);
  // 周六白天：号池 2 个号 + 个人 = 3 条道 → 闲时上限 6
  assert.equal(care.parallelCap({ date: at('2026-10-17T10:00:00+08:00'), peakCap: 2, idleCap: 6, lanes: 3, memory: mem(20) }).cap, 6);
  // 内存保底默认 10%：32 GB 剩 4 GB，再开一个就低于 3.2 GB → 只能维持现有的 2 个
  const tight = care.parallelCap({ date: at('2026-10-17T10:00:00+08:00'), peakCap: 2, idleCap: 6, lanes: 3, working: 2, memory: mem(4) });
  assert.equal(tight.cap, 2); assert.equal(tight.limitedBy, '内存余量');
  // 同样剩 7.5 GB：保底 10% 还能再开 3 个（共 5），保底调到 20% 就只能维持 2 个
  assert.equal(care.parallelCap({ date: at('2026-10-17T10:00:00+08:00'), idleCap: 6, lanes: 3, working: 2, memory: mem(7.5) }).cap, 5);
  assert.equal(care.parallelCap({ date: at('2026-10-17T10:00:00+08:00'), idleCap: 6, lanes: 3, working: 2, memory: mem(7.5), memFloor: 0.2 }).cap, 2);
  // 午休 12:30 不算忙时
  assert.equal(care.isPeak(at('2026-10-16T12:30:00+08:00')), false);
});

test('通道：晚上排队的问题按放宽后的上限开工；新会话走号池，号池挑不出号时退回个人账号；排队的报回第几个、为什么等', async t => {
  const x = rig(t);
  x.clock.now = new Date(2026, 9, 16, 21, 50).getTime();
  const created = [];
  let poolFails = false;
  x.company.deps.poolLanes = () => 2;
  x.company.deps.createSession = async (kind, opts) => {
    if (opts.codeagentAccount === 'pool' && poolFails) throw new Error('号池里暂时没有可用的号');
    created.push(opts); const s = { id: opts.id, kind, status: 'idle' }; x.s.map.set(opts.id, s); return s;
  };
  for (const id of ['Q-1', 'Q-2', 'Q-3', 'Q-4', 'Q-5', 'Q-6', 'Q-7']) x.add(id, [{ round: 1, question: id + ' 的问题', receivedAt: x.clock.now }], { createdAt: x.clock.now + Number(id.slice(2)) });
  const sent = [];
  x.company.link.send = async (type, body) => { sent.push({ type, body }); };
  await x.company.advance();
  assert.equal(created.length, 6, '闲时上限 6（3 条道 × 3 = 9，取 6）');
  assert.ok(created.every(o => o.codeagentAccount === 'pool'));
  assert.equal(x.company.thread('Q-7').state, 'queued');
  assert.ok(sent.some(m => m.body.thread === 'Q-7' && /排队第 1 个：.*上限 6（受闲时上限限制）/.test(m.body.note)));
  // 号池挑不出号：退回个人账号，照常开工
  poolFails = true;
  x.add('Q-8', [{ round: 1, question: 'Q-8 的问题', receivedAt: x.clock.now }]);
  x.company.setSettings({ maxParallelIdle: 8 });
  await x.company.advance();
  assert.ok(created.some(o => o.codeagentAccount === undefined), '退回个人账号');
});
