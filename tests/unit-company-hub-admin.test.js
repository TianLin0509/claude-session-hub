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

test('等满 30 分钟仍有任务在跑：照常重启并说明', async t => {
  const r = setup(t); await pair(r);
  r.cs.map.set('s-busy', { id: 's-busy', kind: 'codeagent', status: 'idle' }); r.cs.busy.add('s-busy'); r.box.ids.push('s-busy');
  const sent = await r.home.hubAdmin({ op: 'update' });
  await roundTrip(r);
  r.clock.now += 29 * MIN; await r.company.checkNow();
  assert.ok(!r.box.controller.calls.includes('apply'));
  r.clock.now += 2 * MIN; await r.company.checkNow(); await r.home.checkNow();
  assert.ok(r.box.controller.calls.includes('apply'));
  assert.match(statuses(r).find(x => x.id === sent.id && x.phase === 'restarting').note, /等了 30 分钟仍有 1 个任务在跑，照常重启到 v2\.1\.9/);
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
