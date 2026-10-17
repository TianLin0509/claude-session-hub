'use strict';
// 家里远程让公司 Hub 更新 / 重启（2026-10-17，core/company-bridge/hub-admin.js）：两端走同一套内存通道夹具，
// 公司的一键更新控制器用替身（只记调用，状态照真控制器的阶段名走）。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { rig, pair } = require('./helpers/company-bridge-rig');
const { CompanyBridge } = require('../core/company-bridge/company');

const MIN = 60000;
function fakeController({ current = '2.1.8', latest = '2.1.9', check = 'available', download = 'ready', lastResult = null, kind = 'incremental' } = {}) {
  const c = { calls: [], state: { phase: 'idle', current, ...(lastResult ? { lastResult } : {}) } };
  c.getState = () => c.state;
  // 和真控制器一样：界面 dismiss 后 state 里没有了，lastResult() 仍返回本次启动读到的结果。
  c.lastResult = () => lastResult;
  if (lastResult) delete c.state.lastResult;
  c.check = async () => {
    c.calls.push('check');
    c.state = check === 'none' ? { ...c.state, phase: 'none', latest: { version: current } }
      : check === 'error' ? { ...c.state, phase: 'error', error: '所有更新源都连不上，暂时查不到新版本' }
      : { ...c.state, phase: 'available', latest: { version: latest }, plan: { kind, bytes: 7 * 1048576, reason: kind === 'full' ? '底层运行时从 Electron 41.2.0 升到 42.0.0，需要完整安装包' : '只需下载变化的程序文件' } };
    return c.state;
  };
  c.download = async () => {
    c.calls.push('download');
    c.state = download === 'ready' ? { ...c.state, phase: 'ready' }
      : { ...c.state, phase: 'error', error: '所有下载源都失败了。', attempts: [{ id: 'aliyun', name: '阿里云', reason: '连接超时' }] };
    return c.state;
  };
  c.apply = () => { c.calls.push('apply'); c.state = { ...c.state, phase: 'applying' }; return c.state; };
  return c;
}
function setup(t, { controller = fakeController(), extra = {} } = {}) {
  const box = { controller, ids: [], relaunched: 0 };
  const r = rig(t, { companyDeps: { appUpdate: () => box.controller, currentVersion: '2.1.8', relaunch: () => { box.relaunched += 1; }, listSessionIds: () => box.ids, ...extra } });
  return Object.assign(r, { box });
}
// 家里发 → 公司收并跑完能跑的部分 → 家里收回报。
async function roundTrip(r) {
  await r.company.checkNow();
  if (r.company.hubAdmin.runner) await r.company.hubAdmin.runner;
  await r.company.checkNow();
  await r.home.checkNow();
}
const phases = r => (r.home.status().companyHub.recent || []).map(x => x.phase).reverse();
const statuses = r => (r.home.adminState().statuses || []).slice().reverse();

test('update：查到新版本 → 下载 → 没有在途任务就报「即将重启」并调用 apply；家里存下回报并发通知', async t => {
  const r = setup(t); await pair(r);
  r.notices.length = 0;
  const sent = await r.home.hubAdmin({ op: 'update' });
  assert.match(sent.id, /^HA-\d{4}-[a-f0-9]{6}$/);
  assert.equal(r.home.polling().active, true, '指令没结果前家里加快检查');
  await roundTrip(r);
  assert.deepEqual(r.box.controller.calls, ['check', 'download', 'apply']);
  assert.deepEqual(phases(r).filter(p => p !== 'online'), ['downloading', 'downloaded', 'restarting']);
  const all = statuses(r).filter(x => x.id === sent.id);
  assert.ok(all.every(x => x.current === '2.1.8'));
  assert.match(all.find(x => x.phase === 'downloading').note, /开始下载 v2\.1\.9（增量包，7\.0 MB）/);
  assert.match(all.find(x => x.phase === 'restarting').note, /即将重启到 v2\.1\.9/);
  assert.ok(r.notices.some(n => n.title === '公司联动 · 公司 Hub' && /即将重启到 v2\.1\.9/.test(n.text)));
  assert.equal(r.company.hubAdmin.job().phase, 'applying');
});

test('重启后：替换成功报「已更新到 vX」，失败报原因与「已回滚」；家里面板版本随之更新', async t => {
  for (const [last, re] of [[{ ok: true, version: '2.1.9', from: '2.1.8', at: 'a1' }, /公司 Hub 已更新到 v2\.1\.9/],
    [{ ok: false, version: '2.1.9', from: '2.1.8', reason: '替换 app.asar 失败：文件被占用', rolledBack: true, at: 'a2' }, /更新失败：替换 app\.asar 失败：文件被占用，已回滚到 v2\.1\.8/]]) {
    const r = setup(t); await pair(r);
    const sent = await r.home.hubAdmin({ op: 'update' });
    await roundTrip(r);
    // 模拟重启：同一数据目录新建公司一端，控制器带着替换脚本写下的结果。
    r.company.close();
    const ctl = fakeController({ current: last.ok ? '2.1.9' : '2.1.8', lastResult: last });
    const again = new CompanyBridge({ ...r.company.deps, appUpdate: () => ctl });
    await again.checkNow();
    await r.home.checkNow();
    const final = statuses(r).find(x => x.id === sent.id && ['updated', 'rolled-back'].includes(x.phase));
    assert.ok(final, '家里收到重启后的结果');
    assert.match(final.note, re);
    assert.deepEqual(final.lastResult, last);
    assert.equal(r.home.status().companyHub.version, last.ok ? '2.1.9' : '2.1.8');
    assert.equal(r.home.status().companyHub.pending.length, 0);
    assert.equal(again.hubAdmin.job().phase, final.phase);
    // 再重启一次不重复报
    const before = statuses(r).length;
    await again.checkNow(); await r.home.checkNow();
    assert.equal(statuses(r).length, before);
    again.close();
  }
});

test('已是最新 / 查不到 / 下载失败：如实回报，不调用 apply', async t => {
  for (const [opts, phase, re] of [[{ check: 'none' }, 'up-to-date', /已是最新 v2\.1\.8/], [{ check: 'error' }, 'failed', /查不到新版本：所有更新源都连不上/],
    [{ download: 'error' }, 'failed', /下载失败：所有下载源都失败了/], [{ kind: 'full' }, 'failed', /需要完整安装包（底层运行时.*远程不做/]]) {
    const r = setup(t, { controller: fakeController(opts) }); await pair(r);
    const sent = await r.home.hubAdmin({ op: 'update' });
    await roundTrip(r);
    const last = statuses(r).filter(x => x.id === sent.id).pop();
    assert.equal(last.phase, phase); assert.match(last.note, re);
    assert.ok(!r.box.controller.calls.includes('apply'));
    assert.equal(r.home.status().companyHub.pending.length, 0);
  }
});

test('有在途任务时等它答完再重启；等待期间不派发新任务；force 不等', async t => {
  const r = setup(t); await pair(r);
  r.cs.map.set('s-busy', { id: 's-busy', kind: 'codeagent', status: 'idle' }); r.cs.busy.add('s-busy'); r.box.ids.push('s-busy');
  const sent = await r.home.hubAdmin({ op: 'update' });
  await roundTrip(r);
  assert.deepEqual(r.box.controller.calls, ['check', 'download']);
  const waiting = statuses(r).find(x => x.id === sent.id && x.phase === 'waiting');
  assert.match(waiting.note, /已下载 v2\.1\.9，等 1 个任务答完后重启到 v2\.1\.9/);
  // 等待期间来了新问题：先排队，不开会话
  r.hs.map.set('home-s', { id: 'home-s', kind: 'claude', status: 'idle' });
  await r.home.ask('home-s', { question: '请帮我看一下公司 L2 的 HARQ 合并逻辑' });
  await r.company.checkNow(); await r.company.checkNow();
  assert.equal(r.cs.created.length, 0, '等待重启时新任务先排队');
  // 任务答完 → 下一轮定时器就重启
  r.cs.busy.delete('s-busy');
  await r.company.checkNow();
  assert.deepEqual(r.box.controller.calls, ['check', 'download', 'apply']);

  const f = setup(t); await pair(f);
  f.cs.map.set('s-busy', { id: 's-busy', kind: 'codeagent', status: 'idle' }); f.cs.busy.add('s-busy'); f.box.ids.push('s-busy');
  await f.home.hubAdmin({ op: 'update', force: true });
  await roundTrip(f);
  assert.deepEqual(f.box.controller.calls, ['check', 'download', 'apply'], 'force 不等任务');
});

test('宽限期（默认 3 分钟）内任务答完就直接重启，不记恢复清单', async t => {
  const r = setup(t); await pair(r);
  r.cs.map.set('s-busy', { id: 's-busy', kind: 'codeagent', status: 'idle' }); r.cs.busy.add('s-busy'); r.box.ids.push('s-busy');
  const sent = await r.home.hubAdmin({ op: 'restart' });
  await roundTrip(r);
  assert.equal(r.box.relaunched, 0);
  assert.match(statuses(r).find(x => x.id === sent.id && x.phase === 'accepted').note, /最多等 3 分钟，到时先记下、重启后自动接着做/);
  assert.match(statuses(r).find(x => x.id === sent.id && x.phase === 'waiting').note, /等 1 个任务答完后重启（最多等 3 分钟，到时先记下、中断，重启后自动接着做/);
  r.clock.now += 2 * MIN; await r.company.checkNow();
  assert.equal(r.box.relaunched, 0, '宽限内还在等');
  r.cs.busy.delete('s-busy'); await r.company.checkNow(); await r.home.checkNow();
  assert.equal(r.box.relaunched, 1);
  assert.equal(r.company.hubAdmin.state().resumeAfterRestart || null, null, '没有被中断的任务');
  assert.match(statuses(r).find(x => x.id === sent.id && x.phase === 'restarting').note, /^即将重启$/);
});

// 公司有一个正在作答的通道轮次（会话在忙）和一个人自己开的、在忙的 CodeAgent 会话。
async function withWork(r, { local = true } = {}) {
  r.hs.map.set('home-s', { id: 'home-s', kind: 'claude', status: 'idle' });
  const { thread } = await r.home.ask('home-s', { question: '请帮我看一下公司 L2 的 HARQ 合并逻辑，回答要写出合并方式' });
  await r.company.checkNow(); await r.company.checkNow();
  assert.equal(r.cs.created.length, 1, '通道已为这个问题开了会话');
  const sid = r.cs.created[0].opts.id;
  r.cs.busy.add(sid); r.box.ids.push(sid);
  if (local) { r.cs.map.set('s-local', { id: 's-local', kind: 'codeagent', status: 'idle', title: '我自己的 CodeAgent' }); r.cs.busy.add('s-local'); r.box.ids.push('s-local'); }
  return { thread, sid };
}
// 模拟重启：进程退出时会话都停了（变成休眠记录），同一数据目录新建公司一端。
// 夹具在测试结束时只关最初那个公司一端（关完就删临时目录）：新建的几个挂在它的 close 上一起关。
function restartCompany(t, r, { keep = () => true } = {}) {
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
const continues = r => r.cs.sent.filter(x => x.text === '继续');

test('宽限到了还有任务在跑：记下清单（通道 + 本机会话）后立即重启，回报「中断 N 个任务后重启」；重启前不派新任务', async t => {
  const r = setup(t); await pair(r);
  const { thread, sid } = await withWork(r);
  const sent = await r.home.hubAdmin({ op: 'restart' });
  await roundTrip(r);
  assert.equal(r.box.relaunched, 0);
  r.clock.now += 3 * MIN + 1000; await r.company.checkNow(); await r.home.checkNow();
  assert.equal(r.box.relaunched, 1);
  const plan = r.company.hubAdmin.state().resumeAfterRestart;
  assert.deepEqual(plan.items.map(x => [x.kind, x.sessionId, x.thread, x.round]), [['bridge', sid, thread, 1], ['local', 's-local', null, null]]);
  assert.ok(plan.items.every(x => x.interruptedAt === r.clock.now));
  assert.equal(r.company.thread(thread).rounds[0].resumePending, true);
  assert.match(statuses(r).find(x => x.id === sent.id && x.phase === 'restarting').note, /中断 2 个任务后重启（等了 3 分钟；重启后自动恢复这些会话并接着做）/);
  assert.match(r.home.thread(thread).rounds[0].note, /公司 Hub 要重启：这一轮先记下/);
  // 已报「即将重启」、进程还没退出：新问题只排队
  assert.equal(r.company.hubAdmin.holdingDispatch(), true);
  await r.home.ask('home-s', { question: '另一个问题：公司 L2 的 RLC 分段上限是多少' });
  await r.company.checkNow(); await r.company.checkNow();
  assert.equal(r.cs.created.length, 1, 'restarting 阶段不派发');
});

test('重启后逐个恢复会话，只发纯「继续」（正规发送入口）；通道轮次保持在途，回执照常发回家里；清单只处理一次', async t => {
  const r = setup(t); await pair(r);
  const { thread, sid } = await withWork(r);
  const sent = await r.home.hubAdmin({ op: 'restart', force: true });
  await roundTrip(r);
  assert.equal(r.box.relaunched, 1);
  assert.match(statuses(r).find(x => x.id === sent.id && x.phase === 'restarting').note, /中断 2 个任务后重启（force：不等/);
  const before = r.cs.sent.length;
  const again = restartCompany(t, r);
  assert.equal(again.hubAdmin.holdingDispatch(), false, '新进程里 restarting 标记不挡派发');
  await again.checkNow(); await r.home.checkNow();
  assert.deepEqual(r.cs.resumed.sort(), [sid, 's-local'].sort(), '两个会话都按原编号恢复');
  assert.deepEqual(r.cs.sent.slice(before).map(x => x.text), ['继续', '继续'], '只发纯「继续」，一字不多');
  assert.equal(again.hubAdmin.state().resumeAfterRestart, null, '清单处理完即清空');
  const round = again.thread(thread).rounds[0];
  assert.equal(round.resumePending, null); assert.ok(round.resumedAt); assert.ok(!round.error);
  assert.equal(again.thread(thread).state, 'running');
  const phasesOf = statuses(r).filter(x => x.id === sent.id).map(x => x.phase);
  assert.deepEqual(phasesOf.slice(-2), ['restarted', 'resumed']);
  assert.match(statuses(r).find(x => x.id === sent.id && x.phase === 'restarted').note, /重启前中断的 2 个任务正在恢复/);
  assert.match(statuses(r).find(x => x.id === sent.id && x.phase === 'resumed').note, /重启后恢复被中断的任务：已恢复 2 个，失败 0 个/);
  // 会话接着做完 → 回执照常发回家里
  r.cs.answer(sid, 'HARQ 合并方式是 Chase 合并，按 RV 顺序软合并。');
  r.clock.now += 20000;
  await again.checkNow(); await r.home.checkNow();
  assert.match(r.home.thread(thread).rounds[0].reply || '', /Chase 合并/);
  // 再来几轮、再重启一次：不再发「继续」
  await again.checkNow();
  const third = restartCompany(t, r);
  await third.checkNow();
  assert.equal(continues(r).length, 2, '同一会话只恢复一次');
});

test('恢复失败：通道轮次按失败流程报回家里（可补收 / 追问）；本机会话在侧栏标「重启打断」', async t => {
  const r = setup(t); await pair(r);
  const { thread, sid } = await withWork(r);
  await r.home.hubAdmin({ op: 'restart', force: true });
  await roundTrip(r);
  // 两个会话的记录都没了（例如被人删了）：恢复不了
  const again = restartCompany(t, r, { keep: () => false });
  await again.checkNow(); await r.home.checkNow();
  assert.equal(continues(r).length, 0);
  const round = again.thread(thread).rounds[0];
  assert.match(round.error, /公司 Hub 重启后没能接着做这一轮（会话记录已经不在了）；可以补收（recollect）或追问重问/);
  assert.equal(again.thread(thread).state, 'failed');
  assert.match(r.home.thread(thread).rounds[0].error, /重启后没能接着做/);
  const issues = again.status().hubAdmin.resumeIssues;
  assert.deepEqual(issues.map(x => x.sessionId), ['s-local']);
  assert.match(statuses(r).find(x => x.phase === 'resumed').note, /已恢复 0 个，失败 2 个（.*第 1 轮：会话记录已经不在了；本机会话「我自己的 CodeAgent」：会话记录已经不在了）/);
  assert.ok(r.notices.some(n => /重启后有任务没能接着做/.test(n.title)));
  // 侧栏标记：渲染层从 bridge:status 读出，「重启打断」，悬停看原因
  const ui = require('../renderer/bridge-thread-renderer');
  const badge = ui.restartBadge('s-local', ui.restartIssuesFromStatus(again.status()));
  assert.equal(badge.chip, '重启打断'); assert.equal(badge.state, 'failed');
  assert.match(badge.sub, /^重启打断，未能自动恢复：会话记录已经不在了/);
  assert.equal(ui.restartBadge(sid, ui.restartIssuesFromStatus(again.status())), null, '通道会话走通道串自己的「没答上」');
  // 有人在那个会话里打过字：标记消失
  again.deps.sessionInputAt = id => (id === 's-local' ? r.clock.now + 1 : 0);
  assert.equal(again.status().hubAdmin.resumeIssues.length, 0);
});

test('恢复途中又重启：标了「恢复中」的不再发第二遍「继续」，通道轮次报失败', async t => {
  const r = setup(t); await pair(r);
  const { thread } = await withWork(r, { local: false });
  await r.home.hubAdmin({ op: 'restart', force: true });
  await roundTrip(r);
  const plan = r.company.hubAdmin.state().resumeAfterRestart;
  // 上一次启动已经标了「恢复中」，没来得及发就又重启了
  r.company.hubAdmin.save({ resumeAfterRestart: { ...plan, boot: 'previous-boot', items: plan.items.map(x => ({ ...x, state: 'resuming' })) } });
  const again = restartCompany(t, r);
  await again.checkNow(); await r.home.checkNow();
  assert.equal(continues(r).length, 0);
  assert.deepEqual(r.cs.resumed, []);
  assert.match(again.thread(thread).rounds[0].error, /上次恢复途中公司 Hub 又重启了，没有再发「继续」/);
  assert.equal(again.hubAdmin.state().resumeAfterRestart, null);
});

test('宽限设为 0 = 立即；设置范围 0–30；恢复后会话已自己接着做就不再发', async t => {
  const r = setup(t); await pair(r);
  assert.equal(r.company.settings().restartGraceMinutes, 3, '默认 3 分钟');
  assert.throws(() => r.company.setSettings({ restartGraceMinutes: 31 }), /0–30/);
  r.company.setSettings({ restartGraceMinutes: 0 });
  r.cs.map.set('s-local', { id: 's-local', kind: 'codeagent', status: 'idle' }); r.cs.busy.add('s-local'); r.box.ids.push('s-local');
  const sent = await r.home.hubAdmin({ op: 'restart' });
  await roundTrip(r);
  assert.equal(r.box.relaunched, 1);
  assert.match(statuses(r).find(x => x.id === sent.id && x.phase === 'restarting').note, /中断 1 个任务后重启（宽限设为 0/);
  const again = restartCompany(t, r);
  // CodeAgent 恢复后自己补了「继续」接着做（Q-1016-05 真机见过）：不再叠一句
  const resume = again.deps.resumeSession;
  again.deps.resumeSession = async id => { await resume(id); r.cs.busy.add(id); };
  await again.checkNow(); await r.home.checkNow();
  assert.equal(continues(r).length, 0);
  assert.match(statuses(r).find(x => x.phase === 'resumed').note, /已恢复 1 个，失败 0 个/);
});

test('看门狗：发出重启 3 分钟后进程还在 → 清掉标记、指令判失败并回报，之后能派发、能接新指令；没被停掉的会话不发「继续」', async t => {
  const r = setup(t); await pair(r);
  const { thread } = await withWork(r, { local: false });
  const sent = await r.home.hubAdmin({ op: 'restart', force: true });
  await roundTrip(r);
  assert.equal(r.box.relaunched, 1);
  assert.equal(r.company.hubAdmin.job().phase, 'restarting');
  r.clock.now += 2 * MIN; await r.company.checkNow();
  assert.equal(r.company.hubAdmin.job().phase, 'restarting', '3 分钟内不动');
  r.clock.now += 2 * MIN; await r.company.checkNow(); await r.home.checkNow();
  assert.equal(r.company.hubAdmin.job().phase, 'failed');
  assert.match(statuses(r).find(x => x.id === sent.id && x.phase === 'failed').note, /重启没有完成：发出 3 分钟后公司 Hub 还没退出.*可以再发一次/);
  assert.equal(r.company.hubAdmin.holdingDispatch(), false);
  assert.equal(continues(r).length, 0, '会话一直在跑，没被中断');
  assert.equal(r.company.hubAdmin.state().resumeAfterRestart, null);
  assert.equal(r.company.thread(thread).rounds[0].resumePending, null);
  // 之后能接新指令（不再回「上一条还在执行」）
  const next = await r.home.hubAdmin({ op: 'restart', force: true });
  await roundTrip(r);
  assert.ok(!statuses(r).some(x => x.id === next.id && x.phase === 'busy'));
  assert.equal(r.box.relaunched, 2);
});

test('配对变了（解除 / 重新配对）：等待中的指令作废并记下', async t => {
  const r = setup(t); await pair(r);
  r.cs.map.set('s-busy', { id: 's-busy', kind: 'codeagent', status: 'idle' }); r.cs.busy.add('s-busy'); r.box.ids.push('s-busy');
  const sent = await r.home.hubAdmin({ op: 'restart' });
  await roundTrip(r);
  assert.equal(r.company.hubAdmin.job().gen, r.company.link.gen(), 'job 记下配对代次');
  r.company.unpair();
  await r.company.checkNow();
  const job = r.company.hubAdmin.job();
  assert.equal(job.phase, 'failed'); assert.equal(job.id, sent.id);
  assert.match(job.note, /配对已变化（解除或重新配对），这条远程指令作废/);
  assert.equal(r.box.relaunched, 0);
  assert.equal(r.company.hubAdmin.holdingDispatch(), false);
});

test('新指令遇到等待中的旧指令：force 或换了动作就接手（旧的报「被取代」），同动作不带 force 仍回 busy', async t => {
  const r = setup(t); await pair(r);
  r.cs.map.set('s-busy', { id: 's-busy', kind: 'codeagent', status: 'idle' }); r.cs.busy.add('s-busy'); r.box.ids.push('s-busy');
  const up = await r.home.hubAdmin({ op: 'update' });
  await roundTrip(r);
  assert.equal(r.company.hubAdmin.job().phase, 'waiting');
  const same = await r.home.hubAdmin({ op: 'update' });
  await roundTrip(r);
  assert.match(statuses(r).find(x => x.id === same.id && x.phase === 'busy').note, new RegExp('上一条远程指令（' + up.id + '）还在执行'));
  const rs = await r.home.hubAdmin({ op: 'restart' });
  await roundTrip(r);
  assert.match(statuses(r).find(x => x.id === up.id && x.phase === 'superseded').note, new RegExp('被新指令 ' + rs.id + '（重启）取代'));
  assert.equal(r.company.hubAdmin.job().id, rs.id); assert.equal(r.company.hubAdmin.job().phase, 'waiting');
  assert.ok(!r.home.status().companyHub.pending.includes(up.id), '家里把「被取代」算结束');
  const forced = await r.home.hubAdmin({ op: 'restart', force: true });
  await roundTrip(r);
  assert.ok(statuses(r).some(x => x.id === rs.id && x.phase === 'superseded'));
  assert.equal(r.box.relaunched, 1, 'force 接手后立即重启');
  assert.equal(r.company.hubAdmin.job().id, forced.id);
  assert.ok(!r.box.controller.calls.includes('apply'), '被取代的更新不再替换');
});

test('长任务：会话表里看不出在忙、但原生记录还在写（transcriptFresh）的通道轮次也算在干活，到时记进清单', async t => {
  const box = { mtime: 0 };
  const r = setup(t, { extra: { transcriptMtime: () => box.mtime } }); await pair(r);
  const { thread, sid } = await withWork(r, { local: false });
  r.cs.busy.delete(sid);
  r.cs.map.set(sid, { ...r.cs.map.get(sid), transcriptPath: 'D:/fake/' + sid + '.jsonl' });
  r.clock.now += 5 * MIN; // 过了刚发出的 3 分钟起步期
  box.mtime = r.clock.now - 60000; // 1 分钟前还在写（AirView 编译中）
  assert.deepEqual(r.company.hubAdmin.workingList().map(x => [x.kind, x.thread]), [['bridge', thread]]);
  box.mtime = r.clock.now - 11 * MIN; // 记录 10 分钟以上没动：不算
  assert.deepEqual(r.company.hubAdmin.workingList(), []);
  box.mtime = r.clock.now;
  await r.home.hubAdmin({ op: 'restart', force: true });
  await roundTrip(r);
  assert.equal(r.box.relaunched, 1);
  assert.deepEqual(r.company.hubAdmin.state().resumeAfterRestart.items.map(x => x.sessionId), [sid]);
});

test('重启后发的话必须被回执核对认作同一轮的延续', () => {
  const { RESUME_TEXT } = require('../core/company-bridge/hub-admin');
  const { BARE_CONTINUE } = require('../core/company-bridge/receipt-reader');
  assert.equal(RESUME_TEXT, '继续');
  assert.ok(BARE_CONTINUE.test(RESUME_TEXT));
});

test('restart：等任务答完后 relaunch；重启后报「已重启」', async t => {
  const r = setup(t); await pair(r);
  const sent = await r.home.hubAdmin({ op: 'restart' });
  await roundTrip(r);
  assert.equal(r.box.relaunched, 1);
  assert.deepEqual(r.box.controller.calls, []);
  r.company.close();
  const again = new CompanyBridge({ ...r.company.deps });
  await again.checkNow(); await r.home.checkNow();
  assert.match(statuses(r).find(x => x.id === sent.id && x.phase === 'restarted').note, /公司 Hub 已重启（v2\.1\.8）/);
  again.close();
});

test('关掉开关 / 不是安装版 / 旧代次 / 重复投递 / 两条并发只跑一个 / status 只回报', async t => {
  const r = setup(t); await pair(r);
  r.company.setSettings({ allowRemoteAdmin: false });
  assert.equal(r.company.settings().allowRemoteAdmin, false);
  let sent = await r.home.hubAdmin({ op: 'update' });
  await roundTrip(r);
  assert.match(statuses(r).find(x => x.id === sent.id).note, /公司端没允许远程更新/);
  r.company.setSettings({ allowRemoteAdmin: true });

  r.box.controller = null;
  sent = await r.home.hubAdmin({ op: 'update' });
  await roundTrip(r);
  assert.equal(statuses(r).find(x => x.id === sent.id).note, '这台 Hub 不是安装版，不能远程更新');
  r.box.controller = fakeController();

  // 旧代次与没带代次：公司不理
  await r.home.link.send('hub-admin', { id: 'HA-old-1', gen: 'old-gen', op: 'update' });
  await r.home.link.send('hub-admin', { id: 'HA-old-2', op: 'update' });
  await roundTrip(r);
  assert.deepEqual(r.box.controller.calls, []);
  assert.ok(!statuses(r).some(x => /^HA-old/.test(x.id || '')));

  // 两条并发
  const a = await r.home.hubAdmin({ op: 'update' }), b = await r.home.hubAdmin({ op: 'update' });
  // 同一编号重复投递
  await r.home.link.send('hub-admin', { id: a.id, gen: r.home.link.gen(), op: 'update' });
  await roundTrip(r);
  assert.deepEqual(r.box.controller.calls, ['check', 'download', 'apply']);
  assert.match(statuses(r).find(x => x.id === b.id && x.phase === 'busy').note, new RegExp('上一条远程指令（' + a.id + '）还在执行'));

  const st = await r.home.hubAdmin({ op: 'status' });
  await roundTrip(r);
  const rep = statuses(r).find(x => x.id === st.id);
  assert.equal(rep.phase, 'status');
  assert.match(rep.note, /当前 v2\.1\.8 · 发行源最新 v2\.1\.9/);
  assert.match(rep.note, /远程指令 HA-.* 进行中/);
});

test('公司 Hub 启动后接通就报一次版本（家里面板显示），版本不变不重复报；手动更新的结果也报', async t => {
  const r = setup(t); await pair(r);
  await r.company.checkNow(); await r.home.checkNow();
  assert.equal(r.home.status().companyHub.version, '2.1.8');
  const n = statuses(r).length;
  r.notices.length = 0;
  await r.company.checkNow(); await r.home.checkNow();
  assert.equal(statuses(r).length, n);
  assert.ok(!r.notices.some(x => /公司 Hub/.test(x.title)), '「在线」不发通知');
  r.box.controller = fakeController({ current: '2.1.9', lastResult: { ok: true, version: '2.1.9', from: '2.1.8', at: 'manual' } });
  await r.company.checkNow(); await r.home.checkNow();
  assert.match(statuses(r).pop().note, /公司 Hub 已更新到 v2\.1\.9/);
});

test('中途重启：停在下载 / 等待的指令如实报失败，可以再发', async t => {
  const r = setup(t); await pair(r);
  r.cs.map.set('s-busy', { id: 's-busy', kind: 'codeagent', status: 'idle' }); r.cs.busy.add('s-busy'); r.box.ids.push('s-busy');
  const sent = await r.home.hubAdmin({ op: 'update' });
  await roundTrip(r);
  assert.equal(r.company.hubAdmin.job().phase, 'waiting');
  r.company.close();
  const again = new CompanyBridge({ ...r.company.deps });
  await again.checkNow(); await r.home.checkNow();
  assert.match(statuses(r).find(x => x.id === sent.id && x.phase === 'failed').note, /中途重启，这条指令没做完/);
  again.close();
});

test('MCP 工具清单有 company_hub_update；命令行认 --hub-update / --hub-restart / --hub-status / --force', async t => {
  const mcp = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'company-bridge-mcp.js')], {
    input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n', encoding: 'utf8', timeout: 15000 });
  const tool = JSON.parse(mcp.stdout.trim().split('\n')[0]).result.tools.find(x => x.name === 'company_hub_update');
  assert.ok(tool); assert.deepEqual(tool.inputSchema.properties.op.enum, ['update', 'restart', 'status']);
  // 命令行经本机接口调用：起一个真的家里一端接口，用会话通行证调用。
  const r = setup(t); await pair(r);
  r.hs.map.set('home-cli', { id: 'home-cli', kind: 'claude', status: 'idle' });
  await r.home.start();
  t.after(() => { try { r.home.server.close(); } catch {} });
  const fs = require('node:fs');
  const run = args => new Promise(resolve => {
    const child = require('node:child_process').spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'company-ask.js'), ...args], {
      env: { ...process.env, HUB_BRIDGE_SESSION_ID: 'home-cli', HUB_BRIDGE_SESSION_PASS: r.home.passFor('home-cli'), HUB_BRIDGE_ENDPOINT_FILE: r.home.endpointFile } });
    let out = ''; child.stdout.on('data', d => { out += d; }); child.on('close', () => resolve(JSON.parse(out)));
  });
  assert.ok(fs.existsSync(r.home.endpointFile));
  const up = await run(['--hub-update', '--force']);
  assert.equal(up.ok, true); assert.equal(up.op, 'update'); assert.match(up.next, /force/);
  assert.equal((await run(['--hub-restart'])).op, 'restart');
  assert.equal((await run(['--hub-status'])).op, 'status');
  const cmds = r.home.adminState().commands.map(c => c.op + (c.force ? '!' : ''));
  assert.deepEqual(cmds, ['status', 'restart', 'update!']);
  const bad = await r.home.invoke({ name: 'company_hub_update', arguments: { op: 'downgrade' }, callerSessionId: 'home-cli' }).catch(e => e.message);
  assert.match(bad, /op 只能是/);
});
