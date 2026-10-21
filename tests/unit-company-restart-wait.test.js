'use strict';
// 重启 / 更新前等通道在途轮次（2026-10-21，同事公司 Hub 3.0.1：重启丢在途轮次 4 轮）：core/company-bridge/hub-admin.js。
// 覆盖：在途时更新被推迟、超时后照常（中断—恢复）、--force 立即、空闲时立即；公司电脑上点「立即重启」的弹窗分支；
// 默认宽限 20 分钟与旧默认 3 的迁移；--hub-status 写明「等 N 个通道问题答完再重启，预计最晚…」。
const test = require('node:test');
const assert = require('node:assert/strict');
const { rig, pair } = require('./helpers/company-bridge-rig');

const MIN = 60000;
function fakeController() {
  const c = { calls: [], state: { phase: 'idle', current: '3.0.1' } };
  c.getState = () => c.state;
  c.lastResult = () => null;
  c.check = async () => { c.calls.push('check'); c.state = { ...c.state, phase: 'available', latest: { version: '3.0.2' }, plan: { kind: 'incremental', bytes: 1048576 } }; return c.state; };
  c.download = async () => { c.calls.push('download'); c.state = { ...c.state, phase: 'ready' }; return c.state; };
  c.apply = () => { c.calls.push('apply'); c.state = { ...c.state, phase: 'applying' }; return c.state; };
  return c;
}
function setup(t) {
  const box = { controller: fakeController(), ids: [], relaunched: 0 };
  const r = rig(t, { companyDeps: { appUpdate: () => box.controller, currentVersion: '3.0.1', relaunch: () => { box.relaunched += 1; }, listSessionIds: () => box.ids } });
  return Object.assign(r, { box });
}
async function roundTrip(r) {
  await r.company.checkNow();
  if (r.company.hubAdmin.runner) await r.company.hubAdmin.runner;
  await r.company.checkNow();
  await r.home.checkNow();
}
const statuses = r => (r.home.adminState().statuses || []).slice().reverse();
// 通道里一个在作答的问题（会话在忙）。
async function channelWork(r) {
  r.hs.map.set('home-s', { id: 'home-s', kind: 'claude', status: 'idle' });
  const { thread } = await r.home.ask('home-s', { question: '请帮我看一下公司 L2 的 HARQ 合并逻辑，回答要写出合并方式' });
  await r.company.checkNow(); await r.company.checkNow();
  const sid = r.cs.created[0].opts.id;
  r.cs.busy.add(sid); r.box.ids.push(sid);
  return { thread, sid };
}

test('默认宽限 20 分钟；旧版存下的旧默认 3 换成 20，graceRev 之后自己选的 3 保留', async t => {
  const r = setup(t); await pair(r);
  assert.equal(r.company.settings().restartGraceMinutes, 20);
  r.company.store.set('settings', { ...r.company.store.get('settings'), restartGraceMinutes: 3, graceRev: undefined });
  assert.equal(r.company.settings().restartGraceMinutes, 20, '没有 graceRev 的 3 是旧默认');
  r.company.setSettings({ restartGraceMinutes: 3 });
  assert.equal(r.company.settings().restartGraceMinutes, 3, '新版里自己选的 3 保留');
  assert.equal(r.company.store.get('settings').graceRev, 1);
});

test('空闲时：远程更新与公司电脑上点「立即重启」都立即替换', async t => {
  const r = setup(t); await pair(r);
  await r.home.hubAdmin({ op: 'update' });
  await roundTrip(r);
  assert.deepEqual(r.box.controller.calls, ['check', 'download', 'apply']);

  const l = setup(t); await pair(l);
  l.box.controller.state = { ...l.box.controller.state, phase: 'ready', latest: { version: '3.0.2' } };
  const out = await l.company.hubAdmin.localApply({ mode: 'auto' });
  assert.ok(!out.needsConfirm);
  assert.deepEqual(l.box.controller.calls, ['apply']);
  await l.home.checkNow();
  assert.match(statuses(l).find(x => x.phase === 'restarting').note, /即将重启到 v3\.0\.2（公司电脑上点的更新）/, '家里也知道公司本机更新了');
});

test('在途时更新被推迟：等通道问题答完再重启，--hub-status 与界面写明等几个、最晚几点；答完立即重启', async t => {
  const r = setup(t); await pair(r);
  const { sid } = await channelWork(r);
  const sent = await r.home.hubAdmin({ op: 'update' });
  await roundTrip(r);
  assert.deepEqual(r.box.controller.calls, ['check', 'download'], '有在途问题不替换');
  const waiting = statuses(r).find(x => x.id === sent.id && x.phase === 'waiting');
  assert.match(waiting.note, /已下载 v3\.0\.2，等 1 个通道问题答完再重启到 v3\.0\.2（最多等 20 分钟，预计最晚 \d\d:\d\d；/);
  const view = r.company.status().hubAdmin.restartWait;
  assert.equal(view.count, 1); assert.equal(view.bridgeCount, 1); assert.equal(view.graceMinutes, 20);
  assert.match(view.text, /^等 1 个通道问题答完再重启到 v3\.0\.2，已等 0 分钟，预计最晚 \d\d:\d\d 重启$/);
  // --hub-status
  await r.home.hubAdmin({ op: 'status' });
  await r.company.checkNow(); await r.home.checkNow();
  assert.match(statuses(r).filter(x => x.phase === 'status').pop().note, /等 1 个通道问题答完再重启到 v3\.0\.2.*家里带 --force 可立即重启/);
  r.clock.now += 10 * MIN; await r.company.checkNow();
  assert.deepEqual(r.box.controller.calls, ['check', 'download'], '10 分钟时还在等');
  r.cs.busy.delete(sid); r.cs.answer(sid, 'HARQ 用 Chase 合并。');
  r.clock.now += 20000;
  await r.company.checkNow(); await r.company.checkNow();
  assert.deepEqual(r.box.controller.calls, ['check', 'download', 'apply'], '答完、回执收走后立即重启');
  assert.equal(r.company.hubAdmin.state().resumeAfterRestart || null, null, '没有中断任何问题');
});

test('会话停着、回答还没发回的轮次也等（以前不等，重启后被判「会话已关闭」）', async t => {
  const r = setup(t); await pair(r);
  const { sid, thread } = await channelWork(r);
  r.cs.busy.delete(sid); // 会话停了，回答还没读到
  r.clock.now += 5 * MIN;
  assert.equal(r.company.hubAdmin.workingList().length, 0, '不算在干活（不发「继续」）');
  assert.deepEqual(r.company.hubAdmin.waitList().map(x => [x.thread, x.delivering]), [[thread, true]], '但重启要等它');
  await r.home.hubAdmin({ op: 'restart' });
  await roundTrip(r);
  assert.equal(r.box.relaunched, 0);
});

test('超时后照常重启：等满 20 分钟还没答完，记下、中断、重启后自动接着做', async t => {
  const r = setup(t); await pair(r);
  const { thread, sid } = await channelWork(r);
  const sent = await r.home.hubAdmin({ op: 'restart' });
  await roundTrip(r);
  r.clock.now += 19 * MIN; await r.company.checkNow();
  assert.equal(r.box.relaunched, 0, '19 分钟还在等');
  r.clock.now += 1 * MIN + 1000; await r.company.checkNow(); await r.home.checkNow();
  assert.equal(r.box.relaunched, 1);
  assert.deepEqual(r.company.hubAdmin.state().resumeAfterRestart.items.map(x => [x.sessionId, x.thread]), [[sid, thread]]);
  assert.match(statuses(r).find(x => x.id === sent.id && x.phase === 'restarting').note, /中断 1 个任务后重启（等了 20 分钟/);
});

test('--force 立即：不等在途问题，记下后马上重启', async t => {
  const r = setup(t); await pair(r);
  await channelWork(r);
  await r.home.hubAdmin({ op: 'update', force: true });
  await roundTrip(r);
  assert.deepEqual(r.box.controller.calls, ['check', 'download', 'apply']);
  assert.equal(r.company.hubAdmin.state().resumeAfterRestart.items.length, 1);
});

test('公司电脑上点「立即重启」：有在途问题先问；选「答完再重启」就等，选「立即重启」写明打断几个；可取消', async t => {
  const r = setup(t); await pair(r);
  const { sid } = await channelWork(r);
  r.box.controller.state = { ...r.box.controller.state, phase: 'ready', latest: { version: '3.0.2' } };
  const ask = await r.company.hubAdmin.localApply({ mode: 'auto' });
  assert.equal(ask.needsConfirm, true);
  assert.equal(ask.confirm.count, 1); assert.equal(ask.confirm.text, '1 个通道问题'); assert.equal(ask.confirm.graceMinutes, 20);
  assert.deepEqual(r.box.controller.calls, [], '没选之前不动手');
  assert.equal(r.company.hubAdmin.job() || null, null);
  // 答完再重启
  const waiting = await r.company.hubAdmin.localApply({ mode: 'wait' });
  assert.match(waiting.restartWait.text, /^等 1 个通道问题答完再重启到 v3\.0\.2/);
  assert.equal(waiting.restartWait.local, true);
  assert.equal(r.company.hubAdmin.holdingDispatch(), true, '等待期间新问题先排队');
  assert.deepEqual(r.box.controller.calls, []);
  // 取消
  await r.company.hubAdmin.localApply({ mode: 'cancel' });
  assert.equal(r.company.hubAdmin.job().phase, 'cancelled');
  assert.equal(r.company.hubAdmin.holdingDispatch(), false);
  // 再点，选立即重启：在途的记下，马上替换
  await r.company.hubAdmin.localApply({ mode: 'wait' });
  await r.company.hubAdmin.localApply({ mode: 'now' });
  assert.deepEqual(r.box.controller.calls, ['apply']);
  assert.deepEqual(r.company.hubAdmin.state().resumeAfterRestart.items.map(x => x.sessionId), [sid]);
  // 弹窗与标题栏的文案契约
  const ui = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'renderer', 'app-update.js'), 'utf8');
  assert.match(ui, /立即重启（打断 \$\{c\.count\} 个问题）/);
  assert.match(ui, /data-au="apply-wait">答完再重启/);
  assert.match(ui, /答完再重启 · 最晚/);
});

test('IPC：没有通道（家里版 / 没 gate）照旧直接替换；有 gate 时按 mode 交给 hub-admin', async () => {
  const { registerAppUpdateIpc } = require('../main/app-update-controller');
  const handlers = {}; const ipc = { handle: (k, f) => { handlers[k] = f; } };
  const calls = [];
  const ctl = { getState: () => ({ phase: 'ready' }), view: () => ({ phase: 'ready', restartWait: null }), apply: () => { calls.push('apply'); return { phase: 'applying' }; } };
  registerAppUpdateIpc(ipc, ctl);
  assert.equal((await handlers['app-update:apply']({}, { mode: 'auto' })).phase, 'applying');
  assert.deepEqual(calls, ['apply']);
  const seen = [];
  registerAppUpdateIpc(ipc, ctl, { gate: { apply: opts => { seen.push(opts.mode); return { phase: 'ready', needsConfirm: true }; } } });
  assert.equal((await handlers['app-update:apply']({}, { mode: 'bogus' })).needsConfirm, true);
  await handlers['app-update:apply']({}, { mode: 'now' });
  assert.deepEqual(seen, ['auto', 'now']);
  assert.deepEqual(calls, ['apply'], 'gate 接手后控制器不直接替换');
  // gate 返回 null（不是公司角色）：退回直接替换
  registerAppUpdateIpc(ipc, ctl, { gate: { apply: () => null } });
  await handlers['app-update:apply']({}, {});
  assert.deepEqual(calls, ['apply', 'apply']);
});
