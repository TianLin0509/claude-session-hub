'use strict';
// 远程维护（2026-10-18 三期，core/company-bridge/remote-act.js + hub-admin op:'act' + home.js act）：
// 每个动作的白名单与拒绝路径——用户会话不休眠、非残留进程不杀、PID+启动时间不匹配拒绝、Hub 进程树永不结束、开关关闭拒绝、超出上下限拒绝、到点恢复。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { rig, pair } = require('./helpers/company-bridge-rig');

const NOW = 1_800_000_000_000;
const MB = 1024 ** 2, GB = 1024 ** 3;
const proc = (pid, ppid, name, mem, extra = {}) => ({ pid, ppid, name, cmd: extra.cmd || name, startedAt: extra.startedAt ?? NOW - 3600000 + pid, wsBytes: mem * MB, privBytes: mem * MB });
// Hub 100 + 界面 101；会话终端 200 → CodeAgent 201；树外：300 父进程已不在、活了一天的 CodeAgent（可结束）；
// 301 刚变孤儿 5 分钟的 CodeAgent（不到 30 分钟，不可结束）；400 父进程活着的 node（不是残留）；500 别的 Hub 主进程 → 501 它名下的 CodeAgent。
function processes(over = {}) {
  const list = [
    proc(100, 4, 'AIGroupChatHub.exe', 300), proc(101, 100, 'AIGroupChatHub.exe', 400, { cmd: 'x --type=renderer' }),
    proc(200, 100, 'powershell.exe', 60, { cmd: 'powershell.exe -NoProfile -NoLogo' }), proc(201, 200, 'node.exe', 900, { cmd: 'node C:\\npm\\node_modules\\@huawei\\codeagent\\dist\\cli.js' }),
    proc(300, 7777, 'node.exe', 1100, { cmd: 'node C:\\npm\\node_modules\\@huawei\\codeagent\\dist\\cli.js serve', startedAt: NOW - 86400000 }),
    proc(301, 7778, 'node.exe', 700, { cmd: 'node C:\\npm\\node_modules\\@huawei\\codeagent\\dist\\cli.js', startedAt: NOW - 5 * 60000 }),
    proc(302, 4, 'explorer.exe', 100), proc(400, 302, 'node.exe', 50, { cmd: 'node tool.js' }),
    proc(500, 9, 'AIGroupChatHub.exe', 250, { startedAt: NOW - 90000000 }), proc(501, 500, 'node.exe', 800, { cmd: 'node C:\\npm\\node_modules\\@huawei\\codeagent\\dist\\cli.js', startedAt: NOW - 90000000 }),
  ];
  return { sampledAt: NOW, processes: list.map(p => (over[p.pid] ? { ...p, ...over[p.pid] } : p)).filter(p => !over[p.pid]?.gone) };
}
function setup(t, extra = {}) {
  const box = { ids: [], snap: processes(), killed: [], suspended: [], free: 2 * GB, stubborn: [], cpu: {} };
  const r = rig(t, { companyDeps: { appUpdate: () => null, currentVersion: '2.1.12', listSessionIds: () => box.ids, hubPid: 100, hubExecPath: 'C:\\AI HUB\\AIGroupChatHub.exe', hubStartedAt: NOW - 7200000,
    sessionPtyPids: () => [{ id: 's-b1', pid: 200 }], poolDiag: () => null, accountSecrets: () => [],
    memory: () => ({ total: 16 * GB, free: box.free, ratio: box.free / (16 * GB) }),
    killProcess: pid => { box.killed.push(pid); box.free += 1100 * MB; },
    processAlive: pid => box.stubborn.includes(pid) || !box.killed.includes(pid),
    suspendSession: (id, opts) => { box.suspended.push({ id, opts }); box.free += 1300 * MB; return { ok: true }; },
    ...extra } });
  Object.defineProperty(r.company.deps, 'diagSys', { get: () => ({ processSnapshot: async () => box.snap,
    // 结束进程前隔 1.5 秒采两次：默认都没动 CPU，box.cpu 可以给某个 PID 设用量
    sampleProcesses: async () => ({ ...box.snap, cpuWindowMs: 1500, cpuCount: 4, processes: box.snap.processes.map(p => ({ ...p, cpuDeltaMs: box.cpu[p.pid] ?? 0 })) }), sleep: async () => {}, clock: (() => { let n = 0; return () => (n += 5); })(),
    os: { totalmem: () => 16 * GB, freemem: () => box.free, cpus: () => [], uptime: () => 100, platform: () => 'win32', release: () => 'x' }, statfs: async () => ({ blocks: 1, bsize: 1, bavail: 1 }), drives: () => [] }), configurable: true });
  r.clock.now = NOW;
  return Object.assign(r, { box });
}
async function round(r, send) {
  const sent = await send();
  await r.company.checkNow();
  await r.company.hubAdmin.diagTask; await r.company.hubAdmin.actTask;
  await r.home.checkNow();
  return sent;
}
const act = (r, action, params = {}) => round(r, () => r.home.hubAdmin({ op: 'act', action, params }));
const actResult = (r, id) => r.home.actView(id);
const diag = r => round(r, () => r.home.hubAdmin({ op: 'diag', sections: ['processes'] }));

test('suspend-idle：只休眠空闲的通道会话；人自己开的、在干活的、还有排队问题的一律不动；回报内存前后', async t => {
  const r = setup(t); await pair(r);
  const S = (id, extra) => { r.cs.map.set(id, { id, kind: 'codeagent', status: 'idle', title: id, ...extra }); r.box.ids.push(id); };
  S('s-b1', { purpose: 'company-bridge' }); S('s-b2', { purpose: 'company-bridge' }); S('s-b3', { purpose: 'company-bridge' }); S('s-user', {}); S('s-b4', { purpose: 'company-bridge', status: 'dormant' });
  r.cs.busy.add('s-b2');
  const thread = (id, sessionId, state) => r.company.saveThread({ id, gen: r.company.link.gen(), title: id, sessionId, createdAt: NOW, rounds: [state === 'queued' ? { round: 1, question: 'q', receivedAt: NOW } : { round: 1, question: 'q', receivedAt: NOW, sentAt: NOW, reply: 'a', replyAt: NOW }] });
  thread('Q-1018-01', 's-b1', 'replied'); thread('Q-1018-02', 's-b2', 'replied'); thread('Q-1018-04', 's-b3', 'replied'); thread('Q-1018-03', 's-b3', 'queued'); thread('Q-1018-05', 's-user', 'replied'); thread('Q-1018-06', 's-b4', 'replied');
  const sent = await act(r, 'suspend-idle');
  const v = actResult(r, sent.id);
  assert.equal(v.status, '已执行');
  assert.deepEqual(r.box.suspended.map(x => x.id), ['s-b1']);
  assert.deepEqual(r.box.suspended[0].opts, { reason: 'remote-suspend-idle', minIdleMs: 60000, excludePinned: true, excludeFocused: true, excludeMeeting: true });
  const why = Object.fromEntries(v.act.skipped.map(x => [x.thread, x.why]));
  assert.deepEqual(why, { 'Q-1018-02': '正在干活', 'Q-1018-04': '还有排队或在途的问题', 'Q-1018-05': '不是通道会话' });
  assert.equal(v.act.freedMB, 1300); assert.match(v.note, /休眠了 1 个空闲通道会话，可用内存 2048 → 3348 MB/);
  // 公司：审计日志、轻提示（中性措辞）
  assert.match(fs.readFileSync(path.join(r.root, 'company', 'logs', 'company-act.log'), 'utf8'), new RegExp(`done ${sent.id} suspend-idle`));
  const n = r.notices.find(x => /对端执行了：让空闲的通道会话休眠/.test(x.title));
  assert.ok(n && n.quiet && !/家里/.test(n.title + n.text));
});

test('kill-orphans：只结束 5 分钟内直查列为「可结束」、PID 与启动时间都对得上的进程；Hub 进程树、别的 Hub、非残留一律不动', async t => {
  const r = setup(t); await pair(r);
  // 没做过直查：拒绝
  let v = actResult(r, (await act(r, 'kill-orphans', { targets: [{ pid: 300, startedAt: NOW - 86400000 }] })).id);
  assert.equal(v.status, '已执行'); assert.equal(v.act.ok, false); assert.match(v.act.error, /5 分钟内没有带进程段的直查/);
  assert.deepEqual(r.box.killed, []);
  await diag(r);
  const listed = r.company.hubAdmin.state().lastDiagKillable.list.map(x => x.pid);
  assert.deepEqual(listed, [300], '直查只把活了一天、父进程已不在的 CodeAgent 列为可结束');
  r.clock.now += 61000;
  const targets = [
    { pid: 300, startedAt: NOW - 86400000 },           // 对得上 → 结束
    { pid: 300 + 0, startedAt: NOW - 1 },               // 同 PID、启动时间不对 → 已在上一条处理过，这条对不上
    { pid: 301, startedAt: NOW - 5 * 60000 },           // 不到 30 分钟，直查没列 → 不动
    { pid: 201, startedAt: NOW - 3600000 + 201 },       // 当前 Hub 会话里的 CodeAgent → 不动
    { pid: 501, startedAt: NOW - 90000000 },            // 别的 Hub 名下 → 不动
    { pid: 400, startedAt: NOW - 3600000 + 400 },       // 父进程活着的 node → 不动
  ];
  v = actResult(r, (await act(r, 'kill-orphans', { targets })).id);
  assert.deepEqual(r.box.killed, [300], '只按 PID 结束了 300');
  assert.deepEqual(v.act.results.map(x => [x.pid, x.ok]), [[300, true], [300, false], [301, false], [201, false], [501, false], [400, false]]);
  assert.ok(v.act.results.slice(1).every(x => /对不上/.test(x.why)));
  assert.equal(v.act.freedMB, 1100); assert.match(v.note, /结束了 1 个，5 个没动；可用内存 2048 → 3148 MB/);
  // 结束过的从清单里划掉；60 秒内再来一次被限频
  assert.deepEqual(r.company.hubAdmin.state().lastDiagKillable.list, []);
  v = actResult(r, (await act(r, 'kill-orphans', { targets: [{ pid: 300, startedAt: NOW - 86400000 }] })).id);
  assert.equal(v.status, '公司没处理'); assert.match(v.note, /60 秒内只做一次/);
});

test('kill-orphans 硬保护：即使清单被篡改成 Hub 进程、PID 被复用、或重新判定已不是残留，都不结束', async t => {
  const r = setup(t); await pair(r);
  await diag(r);
  const st = r.company.hubAdmin.state();
  // 假设清单里混进了当前 Hub 的主进程、别的 Hub 的进程（启动时间也对得上）
  r.company.hubAdmin.save({ lastDiagKillable: { ...st.lastDiagKillable, list: [...st.lastDiagKillable.list, { pid: 100, startedAt: NOW - 3600000 + 100 }, { pid: 501, startedAt: NOW - 90000000 }, { pid: 500, startedAt: NOW - 90000000 }] } });
  // 300 的 PID 被一个新进程复用了
  r.box.snap = processes({ 300: { startedAt: NOW - 1000 } });
  const v = actResult(r, (await act(r, 'kill-orphans', { targets: [{ pid: 100, startedAt: NOW - 3600000 + 100 }, { pid: 501, startedAt: NOW - 90000000 }, { pid: 500, startedAt: NOW - 90000000 }, { pid: 300, startedAt: NOW - 86400000 }] })).id);
  assert.deepEqual(r.box.killed, []);
  assert.deepEqual(v.act.results.map(x => x.why), ['属于正在运行的 Hub，不动', '属于正在运行的 Hub，不动', '属于正在运行的 Hub，不动', '这个 PID 现在是另一个进程（启动时间变了），不动']);
  // 父进程回来了（不再像残留）
  r.clock.now += 61000;
  r.box.snap = processes();
  await diag(r);
  assert.deepEqual(r.company.hubAdmin.state().lastDiagKillable.list.map(x => x.pid), [300]);
  r.box.snap = processes({ 300: { ppid: 302 }, 302: { startedAt: NOW - 2 * 86400000 } }); // 父进程（比它早启动的 explorer）还活着
  r.clock.now += 61000;
  const v2 = actResult(r, (await act(r, 'kill-orphans', { targets: [{ pid: 300, startedAt: NOW - 86400000 }] })).id);
  assert.deepEqual(r.box.killed, []); assert.match(v2.act.results[0].why, /不再是「可结束」/);
  // 直查超过 5 分钟：不认
  r.clock.now += 5 * 60000 + 1;
  const v3 = actResult(r, (await act(r, 'kill-orphans', { targets: [{ pid: 300, startedAt: NOW - 86400000 }] })).id);
  assert.match(v3.act.error, /5 分钟内没有带进程段的直查/);
});

test('set-parallel：复用设置校验与上下限；带「N 小时后恢复」到点恢复原值并告诉对端；超出范围拒绝', async t => {
  const r = setup(t); await pair(r);
  const before = r.company.settings();
  let v = actResult(r, (await act(r, 'set-parallel', { memFloorPct: 5, maxParallel: 1, restoreAfterHours: 1 })).id);
  assert.equal(v.act.ok, true);
  assert.deepEqual([r.company.settings().memFloorPct, r.company.settings().maxParallel], [5, 1]);
  assert.deepEqual(v.act.previous, { memFloorPct: before.memFloorPct, maxParallel: before.maxParallel });
  assert.match(v.note, /memFloorPct 10 → 5，maxParallel 3 → 1；现在最多同时 \d+ 个.*1 小时后恢复原值/);
  r.clock.now += 11000;
  v = actResult(r, (await act(r, 'set-parallel', { memFloorPct: 60 })).id);
  assert.equal(v.act.ok, false); assert.match(v.act.error, /内存保底百分比只能是 5–50/);
  assert.equal(r.company.settings().memFloorPct, 5, '超出范围不改');
  r.clock.now += 11000;
  await assert.rejects(act(r, 'set-parallel', {}), /至少一项/, '家里先核参数');
  r.clock.now += 3600000;
  await r.company.checkNow(); await r.home.checkNow();
  assert.deepEqual([r.company.settings().memFloorPct, r.company.settings().maxParallel], [before.memFloorPct, before.maxParallel], '一小时后恢复原值');
  assert.equal(r.company.hubAdmin.state().parallelRestore, null);
  assert.ok((r.home.adminState().statuses || []).some(x => /已到时恢复/.test(x.note)));
});

test('set-parallel usePool：对端可停用号池（通道新开会话只用个人账号），到点恢复；非布尔值拒绝（2026-10-18 号池额度用完）', async t => {
  const r = setup(t); await pair(r);
  assert.equal(r.company.settings().usePool, true);
  let v = actResult(r, (await act(r, 'set-parallel', { usePool: false, restoreAfterHours: 2 })).id);
  assert.equal(v.act.ok, true);
  assert.equal(r.company.settings().usePool, false);
  assert.deepEqual(v.act.previous, { usePool: true });
  assert.match(v.note, /usePool true → false/);
  r.clock.now += 11000;
  await assert.rejects(act(r, 'set-parallel', { usePool: 'off' }), /usePool 要是 true \/ false/, '家里先核参数');
  r.clock.now += 2 * 3600000;
  await r.company.checkNow(); await r.home.checkNow();
  assert.equal(r.company.settings().usePool, true, '两小时后恢复用号池');
});

test('cancel-queued / retry：取消排队中的问题（家里收到「被对端取消」）；在跑的不能取消；重试失败的轮次', async t => {
  const r = setup(t, { memory: () => ({ total: 16 * GB, free: 0.5 * GB, ratio: 0.03 }) }); await pair(r);
  r.hs.map.set('home-s', { id: 'home-s', kind: 'claude', status: 'idle' });
  const a = await r.home.ask('home-s', { question: '请看一下 L2 HARQ 合并的实现细节' });
  const b = await r.home.ask('home-s', { question: '再看一下 L2 调度器的优先级计算' });
  await r.company.checkNow(); await r.company.checkNow();
  assert.equal(r.company.thread(b.thread).state, 'queued'); assert.equal(r.company.thread(a.thread).state, 'running');
  let v = actResult(r, (await act(r, 'cancel-queued', { thread: a.thread })).id);
  assert.equal(v.act.ok, false); assert.match(v.act.error, /只能取消还在排队的/);
  r.clock.now += 11000;
  v = actResult(r, (await act(r, 'cancel-queued', { thread: b.thread })).id);
  assert.equal(v.act.ok, true); assert.equal(r.company.thread(b.thread).state, 'cancelled');
  await r.home.checkNow();
  assert.match(r.home.thread(b.thread).rounds[0].error, /被对端取消/);
  // retry：让 a 失败后重试
  const ta = r.company.thread(a.thread);
  r.company.failRound(ta, ta.rounds[0], '会话已关闭，没有读到回答');
  r.clock.now += 11000;
  v = actResult(r, (await act(r, 'retry', { thread: a.thread })).id);
  assert.equal(v.act.ok, true); assert.deepEqual(v.act.rounds, [1]);
  assert.ok(!r.company.thread(a.thread).rounds[0].error);
});

test('开关、白名单、代次：远程维护关了回 refused；不认识的动作、参数不对拒绝；上一次配对的指令不处理；家里先核参数和公司能力', async t => {
  const r = setup(t); await pair(r);
  r.company.setSettings({ allowRemoteMaintain: false });
  let v = actResult(r, (await act(r, 'suspend-idle')).id);
  assert.equal(v.status, '公司没处理'); assert.match(v.note, /没允许对端远程维护/);
  r.company.setSettings({ allowRemoteMaintain: true });
  await assert.rejects(r.home.hubAdmin({ op: 'act', action: 'format-disk' }), /action 只能是/);
  await assert.rejects(r.home.hubAdmin({ op: 'act', action: 'cancel-queued', params: { thread: '../x' } }), /问题编号/);
  await assert.rejects(r.home.hubAdmin({ op: 'act', action: 'kill-orphans', params: { targets: [{ pid: 'x' }] } }), /PID 和启动时间/);
  // 绕过家里直接塞：公司同样拒绝
  r.company.hubAdmin.receive({ type: 'hub-admin', op: 'act', id: 'HA-1018-cccccc', gen: r.company.link.gen(), action: 'shell', params: { cmd: 'del *' } });
  await r.company.hubAdmin.actTask;
  assert.match(r.company.hubAdmin.state().history[0].note, /不认识的动作/);
  // 上一次配对的
  r.company.hubAdmin.actTask = undefined;
  r.company.hubAdmin.receive({ type: 'hub-admin', op: 'act', id: 'HA-1018-dddddd', gen: 'old', action: 'suspend-idle' });
  assert.equal(r.company.hubAdmin.actTask, undefined);
  // 公司没报 act 能力（旧版）：家里直接说明
  const st = r.home.adminState();
  r.home.store.set('hubAdmin', { ...st, company: { ...st.company, caps: ['diag'] } });
  await assert.rejects(r.home.hubAdmin({ op: 'act', action: 'suspend-idle' }), /不支持远程维护/);
});

test('MCP company_act：描述写明会改动公司电脑状态、先 diag 再 act；命令行 --act 参数原样交给本机 Hub', async t => {
  const { listTools } = require('../scripts/company-bridge-mcp');
  const tool = listTools({}).find(x => x.name === 'company_act');
  assert.ok(tool && tool.annotations.readOnlyHint === false && tool.annotations.destructiveHint === true);
  assert.match(tool.description, /会改动公司电脑状态/); assert.match(tool.description, /先用 company_diag/);
  assert.deepEqual(tool.inputSchema.properties.action.enum, require('../core/company-bridge/remote-act').ACTIONS);
  const http = require('node:http'), os = require('node:os'), { spawn } = require('node:child_process');
  const bodies = [];
  const server = http.createServer((req, res) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { bodies.push(JSON.parse(b)); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, result: {} })); }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-act-cli-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const endpoint = path.join(dir, 'mcp-endpoint.json');
  fs.writeFileSync(endpoint, JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/tool` }));
  const run = args => new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'company-ask.js'), ...args], { env: { ...process.env, HUB_BRIDGE_SESSION_ID: 's1', HUB_BRIDGE_SESSION_PASS: 'p', HUB_BRIDGE_ENDPOINT_FILE: endpoint }, windowsHide: true });
    child.on('close', code => resolve(code));
  });
  assert.equal(await run(['--act', 'kill-orphans', '--pids', '300:1799913600000,301:1799999700000']), 0);
  assert.equal(await run(['--act', 'set-parallel', '--mem-floor', '5', '--max-parallel', '2', '--restore-hours', '2']), 0);
  assert.equal(await run(['--act', 'cancel-queued', '--thread', 'Q-1018-03']), 0);
  assert.equal(await run(['--act', 'suspend-idle']), 0);
  assert.deepEqual(bodies.map(b => [b.name, b.arguments]), [
    ['company_act', { action: 'kill-orphans', targets: [{ pid: 300, startedAt: 1799913600000 }, { pid: 301, startedAt: 1799999700000 }] }],
    ['company_act', { action: 'set-parallel', memFloorPct: 5, maxParallel: 2, restoreAfterHours: 2 }],
    ['company_act', { action: 'cancel-queued', thread: 'Q-1018-03' }],
    ['company_act', { action: 'suspend-idle' }]]);
});

test('kill-orphans 二审保险：重新枚举找不到当前 Hub 就一个都不结束；最近还在用 CPU 的不结束；发出结束后 5 秒没退出如实写「未确认」', async t => {
  const r = setup(t); await pair(r);
  const target = [{ pid: 300, startedAt: NOW - 86400000 }];
  await diag(r);
  // 进程表里没有当前 Hub 主进程（枚举不完整）：fail-closed
  r.box.snap = processes({ 100: { gone: true } });
  let v = actResult(r, (await act(r, 'kill-orphans', { targets: target })).id);
  assert.equal(v.act.ok, false); assert.match(v.act.error, /没找到当前 Hub 主进程.*一个都不结束/);
  assert.deepEqual(r.box.killed, []);
  // 最近 1.5 秒里还在用 CPU
  r.box.snap = processes(); r.box.cpu = { 300: 900 };
  r.clock.now += 61000;
  v = actResult(r, (await act(r, 'kill-orphans', { targets: target })).id);
  assert.deepEqual(r.box.killed, []); assert.match(v.act.results[0].why, /最近还在用 CPU（15%），不动/);
  // 结束请求发出去了，但它 5 秒内没退
  r.box.cpu = {}; r.box.stubborn = [300];
  r.clock.now += 61000;
  v = actResult(r, (await act(r, 'kill-orphans', { targets: target })).id);
  assert.deepEqual(r.box.killed, [300]);
  assert.deepEqual([v.act.results[0].ok, v.act.results[0].confirmed], [true, false]);
  assert.match(v.note, /结束了 0 个，1 个已发出结束请求、未确认，0 个没动/);
});

test('cancel-queued 竞态：派发 A 还在开会话时取消排队的 B，B 不会被旧对象写回、也不会被派发', async t => {
  let release, first = null;
  const gate = new Promise(res => { release = res; });
  const created = [];
  const r = setup(t, { memory: () => ({ total: 16 * GB, free: 12 * GB, ratio: 0.75 }),
    createSession: async (kind, opts) => { if (!first) { first = opts.id; await gate; } created.push(opts.id); r.cs.map.set(opts.id, { id: opts.id, kind, status: 'idle', title: opts.title, purpose: opts.purpose }); return { id: opts.id }; } });
  await pair(r);
  r.hs.map.set('home-s', { id: 'home-s', kind: 'claude', status: 'idle' });
  const a = await r.home.ask('home-s', { question: '请看一下 L2 HARQ 合并的实现细节' });
  const b = await r.home.ask('home-s', { question: '再看一下 L2 调度器的优先级计算' });
  const pending = r.company.checkNow();
  for (let i = 0; i < 200 && !first; i++) await new Promise(res => setImmediate(res));
  assert.ok(first, 'A 正在开会话');
  assert.equal(r.company.thread(b.thread).state, 'queued');
  const out = await r.company.hubAdmin.remoteAct().cancelQueued({ thread: b.thread });
  assert.equal(out.whole, true);
  release(); await pending;
  await r.company.checkNow();
  assert.equal(r.company.thread(b.thread).state, 'cancelled', 'B 保持已取消');
  assert.equal(created.length, 1, '只给 A 开了会话');
  assert.equal(r.company.thread(a.thread).state, 'running');
});

test('cancel-queued 只取消排队的那一轮：追问轮被取消后问题还能接着追问', async t => {
  const r = setup(t); await pair(r);
  r.hs.map.set('home-s', { id: 'home-s', kind: 'claude', status: 'idle' });
  const a = await r.home.ask('home-s', { question: '请看一下 L2 HARQ 合并的实现细节' });
  await r.company.checkNow();
  const sid = r.company.thread(a.thread).sessionId;
  r.cs.answer(sid, '第一轮的回答');
  await r.company.checkNow(); await r.home.checkNow();
  assert.equal(r.company.thread(a.thread).state, 'replied');
  await r.home.followup('home-s', { thread: a.thread, question: '再细看一下重传' });
  r.cs.busy.add(sid); // 会话在忙：第 2 轮留在排队
  await r.company.checkNow();
  assert.equal(r.company.thread(a.thread).state, 'queued');
  const v = actResult(r, (await act(r, 'cancel-queued', { thread: a.thread })).id);
  assert.equal(v.act.ok, true); assert.equal(v.act.whole, false); assert.equal(v.act.round, 2);
  const ct = r.company.thread(a.thread);
  assert.notEqual(ct.state, 'cancelled', '整个问题没有作废'); assert.match(ct.rounds[1].error, /第 2 轮被对端取消/); assert.equal(ct.rounds[0].reply, '第一轮的回答');
  await r.home.checkNow();
  assert.match(r.home.thread(a.thread).rounds[1].error, /第 2 轮被对端取消/);
  // 之后还能追问
  r.cs.busy.delete(sid);
  await r.home.followup('home-s', { thread: a.thread, question: '那就只看合并比的计算' });
  await r.company.checkNow();
  assert.equal(r.company.thread(a.thread).rounds.length, 3);
  assert.equal(r.company.thread(a.thread).state, 'running');
});

test('set-parallel 恢复：设置页手动改过的键不覆盖（记审计）；第二次调整不带恢复时间时沿用原计划、恢复到最初原值', async t => {
  const r = setup(t); await pair(r);
  const base = r.company.settings();
  await act(r, 'set-parallel', { memFloorPct: 5, maxParallel: 1, restoreAfterHours: 1 });
  const plan = r.company.hubAdmin.state().parallelRestore;
  r.clock.now += 11000;
  // 第二次：不带恢复时间，再改同时处理与闲时上限
  await act(r, 'set-parallel', { maxParallel: 2, maxParallelIdle: 2 });
  const plan2 = r.company.hubAdmin.state().parallelRestore;
  assert.equal(plan2.at, plan.at, '沿用原来的恢复时间');
  assert.deepEqual(plan2.values, { memFloorPct: base.memFloorPct, maxParallel: base.maxParallel, maxParallelIdle: base.maxParallelIdle }, '恢复到最初的原值');
  // 人在设置页把内存保底改成 20
  r.company.setSettings({ memFloorPct: 20 });
  r.clock.now += 3600000;
  await r.company.checkNow();
  const s = r.company.settings();
  assert.deepEqual([s.memFloorPct, s.maxParallel, s.maxParallelIdle], [20, base.maxParallel, base.maxParallelIdle]);
  assert.match(fs.readFileSync(path.join(r.root, 'company', 'logs', 'company-act.log'), 'utf8'), /restore-skip \{"memFloorPct":20\}/);
  await r.home.checkNow();
  assert.ok((r.home.adminState().statuses || []).some(x => /memFloorPct 期间在公司设置页改过，保留现值/.test(x.note)));
});