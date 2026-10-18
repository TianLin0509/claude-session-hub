'use strict';
// 公司 Hub 远程重启后的两处误判（2026-10-18 v2.1.10 真机 Q-1017-23 第 12/13 轮）：
//   1. 这一轮正在「中断—恢复」时家里补收（recollect），公司回「补收不到」把它判成没答上，家里只好整题重发；
//   2. 恢复出来的会话 CLI 还没就绪，派发（和恢复发的「继续」）报 cli-not-ready 直接判失败。
// 两端走同一套内存通道夹具（tests/helpers/company-bridge-rig.js）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { rig, pair } = require('./helpers/company-bridge-rig');
const { CompanyBridge, NOT_READY_RETRY_MS, NOT_READY_MAX_MS } = require('../core/company-bridge/company');

const MIN = 60000;
function setup(t) {
  const box = { ids: [], relaunched: 0 };
  const r = rig(t, { companyDeps: { appUpdate: () => null, currentVersion: '2.1.10', relaunch: () => { box.relaunched += 1; }, listSessionIds: () => box.ids } });
  return Object.assign(r, { box });
}
async function roundTrip(r) {
  await r.company.checkNow();
  if (r.company.hubAdmin.runner) await r.company.hubAdmin.runner;
  await r.company.checkNow();
  await r.home.checkNow();
}
// 公司有一个正在作答的通道轮次（会话在忙）。
async function withWork(r) {
  r.hs.map.set('home-s', { id: 'home-s', kind: 'claude', status: 'idle' });
  const { thread } = await r.home.ask('home-s', { question: '请帮我看一下公司 L2 的 HARQ 合并逻辑，回答要写出合并方式' });
  await r.company.checkNow(); await r.company.checkNow();
  assert.equal(r.cs.created.length, 1);
  const sid = r.cs.created[0].opts.id;
  r.cs.busy.add(sid); r.box.ids.push(sid);
  return { thread, sid };
}
// 模拟重启：会话都停了（变成休眠记录），同一数据目录新建公司一端。
function restartCompany(r, { keep = () => true } = {}) {
  if (!r.first) {
    r.first = r.company; r.extras = [];
    const close = r.first.close.bind(r.first);
    r.first.close = () => { try { close(); } catch {} for (const x of r.extras) { try { x.close(); } catch {} } };
  }
  r.company.close();
  for (const [id, s] of r.cs.map) if (keep(id)) r.cs.stored.set(id, { ...s, status: 'dormant' });
  r.cs.map.clear(); r.cs.busy.clear();
  const again = new CompanyBridge({ ...r.company.deps });
  r.extras.push(again);
  r.company = again;
  return again;
}
// 发送入口替身：前 n 次报 CLI 没就绪（明确没发），之后照常。n = Infinity 表示一直不就绪。
function notReadyFirst(r, company, n) {
  const calls = [];
  const real = company.deps.sendPrompt;
  company.deps.sendPrompt = async (id, text, cid) => {
    calls.push({ id, text, at: r.clock.now });
    if (calls.length <= n) return { ok: false, notSent: true, sendStatus: 'rejected', error: 'cli-not-ready', message: '助理启动尚未完成，本条消息未发送；稍后再发送即可。' };
    return real(id, text, cid);
  };
  return calls;
}
const continues = r => r.cs.sent.filter(x => x.text === '继续');

test('恢复中补收：不判失败、轮次仍在途，回一句「刚重启、正在接着做」；之后回答照常归这一轮', async t => {
  const r = setup(t); await pair(r);
  const { thread, sid } = await withWork(r);
  await r.home.hubAdmin({ op: 'restart', force: true });
  await roundTrip(r);
  assert.equal(r.box.relaunched, 1);
  const again = restartCompany(r);
  // 发出 20 分钟以上没回执，家里 Agent 发补收；公司这一轮还标着「待恢复」
  r.clock.now += 21 * MIN;
  assert.equal(again.thread(thread).rounds[0].resumePending, true);
  await r.home.invoke({ name: 'recollect_company', callerSessionId: 'home-s', arguments: { thread } });
  await again.checkNow(); await r.home.checkNow();
  let home = r.home.thread(thread).rounds[0];
  assert.ok(!home.error, '补收不把这一轮判成没答上');
  assert.equal(home.status, 'running');
  // 同一轮定时器里紧接着恢复完成，家里最后看到的是恢复回报；补收的那句在下面「恢复后」再核对原文
  assert.match(home.note, /正在自动接着做|已恢复会话接着做/);
  // 同一轮里恢复已完成、发了「继续」，还没写出新回答：再补收仍是同样的说法
  assert.equal(continues(r).length, 1);
  const round = again.thread(thread).rounds[0];
  assert.ok(round.resumedAt); assert.ok(!round.error); assert.equal(again.thread(thread).state, 'running');
  r.clock.now += 2 * MIN;
  await r.home.invoke({ name: 'recollect_company', callerSessionId: 'home-s', arguments: { thread } });
  await again.checkNow(); await r.home.checkNow();
  home = r.home.thread(thread).rounds[0];
  assert.ok(!home.error); assert.match(home.note, /公司 Hub 刚重启，这一轮正在自动接着做，回执到了会照常发回，不用重问/);
  assert.equal(again.thread(thread).rounds.length, 1, '没有多出一轮');
  // 追问规则不变：上一轮没回执前不能追问
  await assert.rejects(r.home.invoke({ name: 'followup_company', callerSessionId: 'home-s', arguments: { thread, question: '再看一下' } }), /还没回执/);
  // 会话接着做完 → 回执归第 1 轮
  r.cs.answer(sid, 'HARQ 合并方式是 Chase 合并，按 RV 顺序软合并。');
  r.clock.now += 20000;
  await again.checkNow(); await r.home.checkNow();
  assert.match(r.home.thread(thread).rounds[0].reply || '', /Chase 合并/);
  assert.equal(continues(r).length, 1, '只发过一次「继续」');
});

test('恢复失败后补收：走原有流程（取不到就回「补收不到」）', async t => {
  const r = setup(t); await pair(r);
  const { thread } = await withWork(r);
  await r.home.hubAdmin({ op: 'restart', force: true });
  await roundTrip(r);
  const again = restartCompany(r, { keep: () => false });
  await again.checkNow(); await r.home.checkNow();
  assert.match(again.thread(thread).rounds[0].error, /重启后没能接着做这一轮/);
  await r.home.invoke({ name: 'recollect_company', callerSessionId: 'home-s', arguments: { thread } });
  await again.checkNow(); await r.home.checkNow();
  assert.match(r.home.thread(thread).rounds[0].error, /补收不到/);
});

test('派发撞上 cli-not-ready：前 2 次没就绪 → 退回排队、15 秒后再发，就绪后只发一次', async t => {
  const r = setup(t); await pair(r);
  const calls = notReadyFirst(r, r.company, 2);
  r.hs.map.set('home-s', { id: 'home-s', kind: 'claude', status: 'idle' });
  const { thread } = await r.home.ask('home-s', { question: '请帮我看一下公司 L2 的 HARQ 合并逻辑' });
  await r.company.checkNow(); await r.company.checkNow();
  assert.equal(calls.length, 1);
  let round = r.company.thread(thread).rounds[0];
  assert.equal(r.company.thread(thread).state, 'queued'); assert.ok(!round.error); assert.ok(!round.sentAt);
  assert.equal(round.retryAt, r.clock.now + NOT_READY_RETRY_MS);
  await r.home.checkNow();
  assert.ok(!r.home.thread(thread).rounds[0].error);
  assert.match(r.home.thread(thread).rounds[0].note, /还没启动就绪.*就绪后自动发出/);
  // 不到 15 秒不重发
  r.clock.now += 5000; await r.company.checkNow();
  assert.equal(calls.length, 1);
  r.clock.now += NOT_READY_RETRY_MS; await r.company.checkNow();
  assert.equal(calls.length, 2);
  r.clock.now += NOT_READY_RETRY_MS; await r.company.checkNow();
  assert.equal(calls.length, 3);
  assert.equal(r.cs.created.length, 1, '会话只开一次，重试沿用');
  assert.equal(r.cs.sent.length, 1, '正文只发出一次');
  round = r.company.thread(thread).rounds[0];
  assert.equal(r.company.thread(thread).state, 'running'); assert.ok(round.sentAt); assert.ok(!round.notReadySince); assert.ok(!round.retryAt);
  r.clock.now += NOT_READY_RETRY_MS; await r.company.checkNow();
  assert.equal(calls.length, 3, '发出后不再重发');
});

test('派发一直不就绪：5 分钟后按原有失败流程报回，写明 cli-not-ready', async t => {
  const r = setup(t); await pair(r);
  const calls = notReadyFirst(r, r.company, Infinity);
  r.hs.map.set('home-s', { id: 'home-s', kind: 'claude', status: 'idle' });
  const { thread } = await r.home.ask('home-s', { question: '请帮我看一下公司 L2 的 HARQ 合并逻辑' });
  await r.company.checkNow(); await r.company.checkNow();
  const start = r.clock.now;
  for (let i = 0; i < 40 && !r.company.thread(thread).rounds[0].error; i += 1) { r.clock.now += NOT_READY_RETRY_MS; await r.company.checkNow(); }
  const round = r.company.thread(thread).rounds[0];
  assert.match(round.error, /公司这边没能开始：公司会话的 CodeAgent 等了 5 分钟仍没启动就绪（cli-not-ready）/);
  assert.ok(r.clock.now - start >= NOT_READY_MAX_MS);
  assert.ok(calls.length >= 20 && calls.length <= 23, `大约每 15 秒一次：${calls.length}`);
  await r.home.checkNow();
  assert.match(r.home.thread(thread).rounds[0].error, /cli-not-ready/);
  // 点重试：从头再等，不会因为上一次的计时立刻失败
  r.company.retry(thread);
  await r.company.checkNow();
  assert.ok(!r.company.thread(thread).rounds[0].error);
});

test('重启后恢复发「继续」撞上 cli-not-ready：清单留着、到点再发，只发一次；恢复中补收仍回「正在接着做」', async t => {
  const r = setup(t); await pair(r);
  const { thread, sid } = await withWork(r);
  await r.home.hubAdmin({ op: 'restart', force: true });
  await roundTrip(r);
  // 发出 20 分钟以上没回执（家里才能补收）；重启后第一次发「继续」时 CLI 还没就绪，同一轮里家里来了补收
  r.clock.now += 21 * MIN;
  const again = restartCompany(r);
  const calls = notReadyFirst(r, again, 2);
  await r.home.invoke({ name: 'recollect_company', callerSessionId: 'home-s', arguments: { thread } });
  await again.checkNow(); await r.home.checkNow();
  assert.deepEqual(r.cs.resumed, [sid]);
  assert.equal(calls.length, 1); assert.equal(continues(r).length, 0);
  const plan = again.hubAdmin.state().resumeAfterRestart;
  assert.equal(plan.items[0].state, 'waiting-ready');
  assert.equal(again.thread(thread).rounds[0].resumePending, true);
  assert.ok(!again.thread(thread).rounds[0].error);
  assert.ok(!r.home.thread(thread).rounds[0].error);
  assert.match(r.home.thread(thread).rounds[0].note, /公司 Hub 刚重启，这一轮正在自动接着做/);
  for (let i = 0; i < 4 && again.hubAdmin.state().resumeAfterRestart; i += 1) { r.clock.now += NOT_READY_RETRY_MS; await again.checkNow(); }
  assert.equal(again.hubAdmin.state().resumeAfterRestart, null, '恢复完清单清空');
  assert.equal(continues(r).length, 1, '「继续」只发出一次');
  const round = again.thread(thread).rounds[0];
  assert.equal(round.resumePending, null); assert.ok(round.resumedAt); assert.ok(!round.error);
  assert.equal(r.cs.resumed.length, 1, '会话只恢复一次');
});

test('重启后恢复一直不就绪：5 分钟后这一轮按失败流程报回，写明 cli-not-ready', async t => {
  const r = setup(t); await pair(r);
  const { thread } = await withWork(r);
  await r.home.hubAdmin({ op: 'restart', force: true });
  await roundTrip(r);
  const again = restartCompany(r);
  notReadyFirst(r, again, Infinity);
  for (let i = 0; i < 40 && again.hubAdmin.state().resumeAfterRestart; i += 1) { await again.checkNow(); r.clock.now += NOT_READY_RETRY_MS; }
  assert.equal(again.hubAdmin.state().resumeAfterRestart, null);
  assert.match(again.thread(thread).rounds[0].error, /重启后没能接着做这一轮（会话恢复后 CodeAgent 等了 5 分钟仍没启动就绪（cli-not-ready）/);
  await r.home.checkNow();
  assert.match(r.home.thread(thread).rounds[0].error, /cli-not-ready/);
  assert.equal(continues(r).length, 0);
});
