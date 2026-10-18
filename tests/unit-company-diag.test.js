'use strict';
// 直查通道（2026-10-18，core/company-bridge/diag.js + hub-admin.js op:'diag' + home.js diag）：
// 各段采集用假的系统接口夹具；进程分类（Hub 进程树、会话、CodeAgent、树外残留）；脱敏；大小降级；代次、限频、段落白名单；家里取结果、MCP、命令行。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { rig, pair } = require('./helpers/company-bridge-rig');
const D = require('../core/company-bridge/diag');

const NOW = 1_800_000_000_000;
const GB = 1024 ** 3, MB = 1024 ** 2;
const proc = (pid, ppid, name, mem, extra = {}) => ({ pid, ppid, name, cmd: extra.cmd || name, startedAt: extra.startedAt ?? NOW - 3600000 + pid, wsBytes: mem * MB, privBytes: mem * MB });

// 一台假电脑：Hub 主进程 100（AIGroupChatHub.exe）+ 界面 101 + 隐藏窗口 102；会话 s-1 的终端 200 → CodeAgent 201 + serve 202；
// 树外：300 是上一次 Hub 留下的 CodeAgent（父进程已不在），301 别的 Electron，302 系统进程；400 自称 Hub 的孩子但比 Hub 早启动（PID 复用）。
function fakeProcesses() {
  return { sampledAt: NOW, processes: [
    proc(100, 4, 'AIGroupChatHub.exe', 300, { startedAt: NOW - 7200000 }),
    proc(101, 100, 'AIGroupChatHub.exe', 500, { cmd: 'AIGroupChatHub.exe --type=renderer' }),
    proc(102, 100, 'AIGroupChatHub.exe', 200, { cmd: 'AIGroupChatHub.exe --type=renderer --hidden' }),
    proc(200, 100, 'powershell.exe', 60, { cmd: 'powershell.exe -NoProfile -NoLogo' }),
    proc(201, 200, 'node.exe', 900, { cmd: 'node C:\\tools\\codeagent\\cli.js' }),
    proc(202, 201, 'node.exe', 400, { cmd: 'node C:\\tools\\codeagent\\cli.js serve --token=abc' }),
    proc(300, 7777, 'node.exe', 1100, { cmd: 'node C:\\tools\\codeagent\\cli.js serve', startedAt: NOW - 86400000 }),
    proc(301, 4, 'electron.exe', 150, { cmd: 'electron.exe C:\\other-app' }),
    proc(302, 4, 'explorer.exe', 120),
    proc(400, 100, 'node.exe', 80, { cmd: 'node something', startedAt: NOW - 9000000 }),
  ] };
}

test('进程分类：Hub 自身、会话进程树、CodeAgent（树内 / 树外）、残留嫌疑（父进程不在的 CodeAgent / node）与 PID 复用', () => {
  const a = D.analyzeProcesses(fakeProcesses(), { hubPid: 100, hubExe: 'AIGroupChatHub.exe', sessionPids: [{ id: 's-1-abcdefgh', pid: 200 }], now: NOW });
  assert.equal(a.hubFound, true);
  assert.deepEqual(a.summary.hubSelf, { count: 3, memMB: 1000 });
  assert.deepEqual(a.summary.codeAgent, { count: 3, memMB: 2400, inHub: 2, outside: 1 });
  assert.deepEqual(a.summary.hubSessions, { sessions: 1, processes: 3, memMB: 1360 });
  assert.deepEqual(a.leftovers.map(x => x.pid), [300, 400], '父进程不在的 CodeAgent / node 才算（CodeAgent 排前）；PID 复用的 400 不算 Hub 的孩子；父进程活着的 Electron 301 不算');
  const l300 = a.leftovers[0];
  assert.equal(l300.kind, 'codeagent'); assert.equal(l300.parentAlive, false); assert.equal(l300.hint, 'CodeAgent（serve）'); assert.equal(l300.ageMin, 1440);
  assert.ok(!a.leftovers.some(x => [301, 302].includes(x.pid)), '别的程序、系统进程不算残留');
  assert.equal(a.top[0].pid, 300); assert.equal(a.top.length, 10);
  assert.equal(a.top.find(x => x.pid === 201).session, 's-1-abcd');
  assert.equal(a.sessions.get('s-1-abcdefgh').memMB, 1360);
  assert.ok(!JSON.stringify(a.top).includes('token'), '不回传命令行');
  assert.ok(!('cmd' in a.top[0]) && !('cmd' in a.leftovers[0]));
});

test('环境里另有正在运行的 Hub、Hub 后台脚本、别的 Electron 程序：都不算残留；残留分「嫌疑」「可结束」两档；保护名单', () => {
  const snap = fakeProcesses();
  snap.processes.push(
    // 另一个正在运行的 Hub（父进程早已退出，同 bootstrap 拉起后退出的情形）：名下界面、会话、CodeAgent
    proc(500, 9, 'AIGroupChatHub.exe', 250, { startedAt: NOW - 90000000 }), proc(501, 500, 'AIGroupChatHub.exe', 300, { cmd: 'x --type=renderer' }),
    proc(502, 500, 'powershell.exe', 30), proc(503, 502, 'node.exe', 700, { cmd: 'node C:\\tools\\codeagent\\cli.js serve' }),
    // 开着窗口、没有子进程的开发版 Hub（命令行带源码目录）；空空的安装版 Hub 主进程；开发版 Hub（目录是 Hub 源码）
    { ...proc(510, 9, 'electron.exe', 120, { cmd: 'electron.exe C:\\Users\\x\\claude-session-hub' }), hasWindow: true },
    proc(600, 9, 'AIGroupChatHub.exe', 90),
    proc(902, 9, 'electron.exe', 110, { cmd: '"C:\\hub\\node_modules\\electron\\dist\\electron.exe" D:\\AIWork\\x\\wt --remote-debugging-port=9333' }),
    // 别的 Electron 程序（目录不是 Hub）：不是别的 Hub，也不是残留
    proc(901, 9, 'electron.exe', 100, { cmd: 'electron.exe D:\\other\\app' }),
    // Hub 后台脚本：用 Hub 的程序跑的普通浏览器守护进程（父进程已退出）、网页圆桌 worker、更新替换脚本
    proc(910, 9, 'AIGroupChatHub.exe', 80, { cmd: '"C:\\Program Files\\AI HUB\\AIGroupChatHub.exe" "C:\\Program Files\\AI HUB\\resources\\app.asar\\core\\ordinary-browser-daemon.js" {}' }),
    proc(911, 9, 'electron.exe', 60, { cmd: 'electron.exe D:\\hub\\core\\web-roundtable\\worker.js abc run' }),
    proc(912, 9, 'powershell.exe', 40, { cmd: 'powershell.exe -NoProfile -NonInteractive -File "D:\\x\\apply-update.ps1" -Plan "p.json"' }),
    // 孤立的 Electron 子进程；父进程活着的 node（别的程序起的）；已知残留形态：空着的会话外壳；刚变孤儿 5 分钟的 CodeAgent；命令行里只是「提到」codeagent 的 node
    proc(700, 9999, 'AIGroupChatHub.exe', 60, { cmd: 'AIGroupChatHub.exe --type=gpu-process' }), proc(800, 302, 'node.exe', 40, { cmd: 'node tool.js' }),
    proc(950, 9998, 'powershell.exe', 30, { cmd: 'powershell.exe -NoProfile -NoLogo' }),
    proc(960, 9997, 'node.exe', 500, { cmd: 'node C:\\tools\\codeagent\\cli.js', startedAt: NOW - 5 * 60000 }),
    proc(970, 9996, 'node.exe', 45, { cmd: 'node -e "setInterval(()=>{},1e9)" codeagent-mentioned', startedAt: NOW - 3 * 3600000 }));
  const a = D.analyzeProcesses(snap, { hubPid: 100, hubExe: 'AIGroupChatHub.exe', now: NOW, isHubAppDir: dir => dir === 'D:\\AIWork\\x\\wt' });
  assert.deepEqual(a.leftovers.map(x => [x.pid, x.kind, x.killable]),
    [[300, 'codeagent', true], [950, 'pattern', true], [400, 'node', false], [970, 'node', false], [700, 'electron-helper', false]]);
  assert.match(a.leftovers.find(x => x.pid === 700).hint, /孤立的 Electron 子进程/);
  assert.equal(a.leftovers.find(x => x.pid === 950).hint, 'Agent 会话外壳');
  assert.equal(a.leftovers.find(x => x.pid === 970).hint, 'Node', '命令行里只是提到 codeagent 的 node 不算 CodeAgent');
  for (const pid of [500, 501, 502, 503, 510, 600, 800, 901, 902, 910, 911, 912, 960]) assert.ok(!a.leftovers.some(x => x.pid === pid), pid + ' 不该算残留');
  const others = Object.fromEntries(a.otherHubs.map(x => [x.pid, x]));
  assert.deepEqual(Object.keys(others).map(Number).sort((x, y) => x - y), [500, 510, 600, 902], '别的 Electron 程序（901）和 Hub 后台脚本（910/911）不是别的 Hub');
  assert.deepEqual([others[500].processes, others[500].treeMemMB, others[500].idle], [3, 1280, false]);
  assert.equal(others[510].hasWindow, true); assert.equal(others[600].idle, true);
  assert.deepEqual(a.summary.hubScripts, { count: 3, memMB: 180 });
  assert.deepEqual(a.summary.leftovers, { count: 5, memMB: 1100 + 30 + 80 + 45 + 60, killable: 2, killableMemMB: 1130 });
  for (const pid of [100, 101, 102, 200, 201, 202, 500, 501, 503, 510, 600, 902, 910, 911, 912]) assert.ok(a.protectedPids.has(pid), pid + ' 应在保护名单');
  for (const pid of [300, 400, 700, 950]) assert.ok(!a.protectedPids.has(pid));
  const rowOf = pid => a.top.find(x => x.pid === pid) || null;
  assert.equal(rowOf(503).otherHub, true);
  assert.deepEqual([rowOf(300).leftover, rowOf(300).killable], [true, true], 'top 行与残留列表同一套规则');
  // 改短最短存活时间（隔离测试用）：刚变孤儿的 CodeAgent 也进可结束
  const b = D.analyzeProcesses(snap, { hubPid: 100, hubExe: 'AIGroupChatHub.exe', now: NOW, suspectMinAgeMs: 0, killMinAgeMs: 0 });
  assert.equal(b.leftovers.find(x => x.pid === 960).killable, true);
});

test('CodeAgent 按可执行文件 / 入口脚本路径认，不按命令行里任意位置的字样', () => {
  const yes = [{ name: 'codeagent.exe', cmd: 'codeagent.exe' }, { name: 'node.exe', cmd: '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@huawei\\codeagent\\dist\\cli.js" serve' },
    { name: 'node.exe', cmd: 'node --max-old-space-size=4096 D:\\CodeAgent3\\bin\\main.js' }];
  const no = [{ name: 'node.exe', cmd: 'node -e "require(1)" codeagent' }, { name: 'node.exe', cmd: 'node D:\\tools\\grep.js --pattern codeagent' }, { name: 'powershell.exe', cmd: 'powershell -c codeagent --version' }];
  for (const p of yes) assert.equal(D.isCodeAgentProc(p), true, p.cmd);
  for (const p of no) assert.equal(D.isCodeAgentProc(p), false, p.cmd);
});

test('脱敏：号身份、口令/令牌样式、配对码、网址、本机用户目录；UUID 与普通文字保留', () => {
  const redact = D.makeRedactor({ scrub: s => s.split('w001****11').join('号池里的一个号'), home: 'C:\\Users\\w00123456', user: 'w00123456', extra: ['wenxinwukui-test'] });
  const line = 'open w001****11 token=abcdef123 password: hunter2 Bearer abcdefghijkl AIHUB-LINK-1.eyJ1IjoiaHR0cHMi https://x.test/drop/tok/api?k=1 '
    + 'C:\\Users\\w00123456\\AppData sk-abcdefghijklmnopqrstuvwx 0123456789abcdef0123456789abcdef01 wenxinwukui-test session=4b0c7a8e-5d1c-4c1e-9a77-1f2e3d4c5b6a 内存紧';
  const out = redact(line);
  for (const leak of ['w001****11', 'abcdef123', 'hunter2', 'abcdefghijkl', 'eyJ1Ijoi', 'x.test', 'w00123456', 'sk-abcdef', '0123456789abcdef0123', 'wenxinwukui-test']) assert.ok(!out.includes(leak), '漏了 ' + leak + '：' + out);
  assert.match(out, /4b0c7a8e-5d1c-4c1e-9a77-1f2e3d4c5b6a/); assert.match(out, /内存紧/); assert.match(out, /%USERPROFILE%\\AppData/);
  assert.deepEqual(D.deepRedact({ a: ['token=xyz', 3, true], b: { c: 'password=1' } }, redact), { a: ['token=<已隐去>', 3, true], b: { c: 'password=<已隐去>' } });
});

test('段落白名单与日志行数', () => {
  assert.deepEqual(D.parseSections(['hub', 'machine', 'rm -rf /', 'HUB']), { sections: ['machine', 'hub'], ignored: ['rm -rf /'] });
  assert.deepEqual(D.parseSections(undefined).sections, D.SECTIONS);
  assert.deepEqual(D.parseSections(['nope']), { sections: D.SECTIONS, ignored: ['nope'] });
  assert.equal(D.parseLines(undefined), 80); assert.equal(D.parseLines(5000), 200); assert.equal(D.parseLines('x'), 80);
});

// 公司一端的假系统接口
function fakeSys(t, extra = {}) {
  let tick = 0;
  const cpus = () => { tick += 1; return [0, 1, 2, 3].map(() => ({ model: 'Fake CPU @ 3GHz', times: { user: 100 * tick, nice: 0, sys: 50 * tick, irq: 0, idle: 150 * tick } })); };
  return {
    os: { totalmem: () => 16 * GB, freemem: () => 2 * GB, cpus, uptime: () => 36000, platform: () => 'win32', release: () => '10.0.26200' },
    statfs: dir => { if (dir.startsWith('D')) throw Object.assign(new Error('no'), { code: 'ENOENT' }); return { blocks: 500 * 1024, bsize: 1024 * 1024, bavail: 100 * 1024 }; },
    processSnapshot: async () => fakeProcesses(),
    sleep: async () => {},
    drives: () => ['C:\\', 'D:\\'],
    clock: (() => { let n = 0; return () => (n += 7); })(),
    mtime: () => NOW - 120000,
    ...extra,
  };
}
const POOL = () => ({
  personal: { state: 'ready', models: ['GLM-4.6'], defaultModel: 'GLM-4.6', activeSessions: 1 },
  accounts: [
    { id: 'abc123', note: '张三的号', accountLabel: 'w001****11', dir: 'C:\\pool\\abc123', state: 'ready', models: ['GLM-4.6', 'DeepSeek-V3'], defaultModel: 'GLM-4.6', activeSessions: 2 },
    { id: 'def456', note: '李四', accountLabel: 'w002****22', dir: 'C:\\pool\\def456', state: 'login-required', models: [], defaultModel: '', activeSessions: 0, duplicateOf: null },
  ],
});
function setup(t, extra = {}) {
  const box = { ids: [], sys: null, sleepHook: null };
  const r = rig(t, {
    homeDeps: { sleep: async ms => { if (box.sleepHook) await box.sleepHook(ms); } },
    companyDeps: { appUpdate: () => null, currentVersion: '2.1.11', listSessionIds: () => box.ids, hubPid: 100, hubExecPath: 'C:\\Program Files\\AI HUB\\AIGroupChatHub.exe', hubStartedAt: NOW - 7200000,
      sessionPtyPids: () => [{ id: 's-1-abcdefgh', pid: 200 }], poolDiag: POOL, poolLanes: () => 1,
      accountSecrets: () => ['abc123', 'w001****11', '张三的号', 'def456', 'w002****22', '李四'],
      memory: () => ({ total: 16 * GB, free: 2 * GB, ratio: 0.125 }),
      ...extra } });
  box.sys = fakeSys(t);
  Object.defineProperty(r.company.deps, 'diagSys', { get: () => box.sys, configurable: true });
  r.clock.now = NOW;
  return Object.assign(r, { box });
}
async function diagRound(r, args = {}) {
  const sent = await r.home.hubAdmin({ op: 'diag', ...args });
  await r.company.checkNow();
  await r.company.hubAdmin.diagTask;
  await r.home.checkNow();
  return { sent, view: r.home.diagView(sent.id) };
}

test('端到端（内存通道）：家里发 diag → 公司直接采集、压缩回报 → 家里解开；字段齐全、没有号身份与令牌、不开会话', async t => {
  const r = setup(t); await pair(r);
  // 会话：通道会话 s-1（号池号 abc123），人自己开的 s-2（个人）
  r.cs.map.set('s-1-abcdefgh', { id: 's-1-abcdefgh', kind: 'codeagent', status: 'idle', title: '1018-Q1-codex', purpose: 'company-bridge', codeagentPoolAccount: 'abc123', lastMessageTime: NOW - 60000 });
  r.cs.map.set('s-2-zzzzzzzz', { id: 's-2-zzzzzzzz', kind: 'codeagent', status: 'dormant', title: '我自己的会话', lastMessageTime: NOW - 600000 });
  r.box.ids.push('s-1-abcdefgh', 's-2-zzzzzzzz');
  // 日志里埋令牌与号身份
  const logs = path.join(r.root, 'company', 'logs'); fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, 'company-bridge.log'), Array.from({ length: 120 }, (_, i) => `2026-10-18T08:00:${String(i % 60).padStart(2, '0')}Z route Q-1018-0${i % 9} account=w001****11（张三的号） token=SECRET${i}x`).join('\n') + '\n');
  // 两个问题：内存只够 1 个 → 第二个排队，排队原因写明受内存余量限制
  r.hs.map.set('home-s', { id: 'home-s', kind: 'claude', status: 'idle' });
  await r.home.ask('home-s', { question: '请看一下 L2 HARQ 合并的实现细节' });
  await r.home.ask('home-s', { question: '再看一下 L2 调度器的优先级计算' });
  await r.company.checkNow(); await r.company.checkNow();
  const createdBefore = r.cs.created.length;
  r.notices.length = 0;

  let secretReads = 0; const readSecrets = r.company.deps.accountSecrets; r.company.deps.accountSecrets = () => { secretReads += 1; return readSecrets(); };
  const { sent, view } = await diagRound(r);
  const text0 = () => JSON.stringify(view);
  assert.ok(secretReads <= 2, `整份回报脱敏只读号身份 1~2 次（实际 ${secretReads}）`);
  assert.match(sent.id, /^HA-\d{4}-[a-f0-9]{6}$/);
  assert.deepEqual(sent.sections, D.SECTIONS);
  assert.equal(view.status, '已回报');
  assert.equal(r.cs.created.length, createdBefore, '直查不开 CodeAgent 会话');
  const d = view.diag;
  // machine
  assert.deepEqual(d.machine.memory, { totalMB: 16384, freeMB: 2048, usedPct: 88, freePct: 13 });
  assert.equal(d.machine.cpu.busyPct, 50); assert.equal(d.machine.uptimeHours, 10);
  assert.deepEqual(d.machine.disks, [{ drive: 'C:', totalGB: 500, freeGB: 100, freePct: 20 }, { drive: 'D:', error: '没有这个盘' }]);
  // processes
  assert.equal(d.processes.summary.codeAgent.count, 3); assert.equal(d.processes.leftovers[0].pid, 300);
  // hub：并行受内存限制、队列快照、会话列表（号用代称）
  assert.equal(d.hub.version, '2.1.11'); assert.equal(d.hub.pid, 100); assert.equal(d.hub.uptimeMin, 120);
  assert.equal(d.hub.parallel.cap, 1); assert.equal(d.hub.parallel.limitedBy, '内存余量');
  assert.equal(d.hub.queue.running, 1); assert.equal(d.hub.queue.queued, 1);
  const q = d.hub.queue.threads.find(x => x.phase === 'queued');
  assert.match(q.queueNote, /受内存余量限制/); assert.equal(q.sessionAlive, false);
  const running = d.hub.queue.threads.find(x => x.phase === 'running');
  assert.equal(running.sessionAlive, true); assert.equal(typeof running.sessionBusy, 'boolean');
  const s1 = d.hub.sessions.list.find(x => x.id === 's-1-abcd');
  assert.deepEqual({ purpose: s1.purpose, state: s1.state, pid: s1.pid, memMB: s1.memMB, account: s1.account }, { purpose: 'company-bridge', state: 'active', pid: 200, memMB: 1360, account: '号 1' });
  assert.equal(d.hub.sessions.list.find(x => x.id === 's-2-zzzz').state, 'dormant');
  assert.equal(s1.title, '1018-Q1-codex'); assert.equal(d.hub.sessions.list.find(x => x.id === 's-2-zzzz').title, '', '非通道会话不带标题（可能有公司项目名）');
  assert.ok(!text0().includes('我自己的会话'));
  // pool：只有代称
  assert.deepEqual(d.pool.accounts.map(a => [a.alias, a.state, a.activeSessions]), [['个人', '可用', 1], ['号 1', '可用', 2], ['号 2', '需登录', 0]]);
  // logs：默认 80 行，已脱敏
  const bridgeLog = d.logs.files.find(f => f.key === 'bridge');
  assert.equal(bridgeLog.lines.length, 80); assert.equal(d.logs.files.find(f => f.key === 'care').error, '还没有这份日志');
  assert.ok(d.timings.machine >= 0 && d.elapsedMs > 0);
  // 隐私：账号编号、备注、工号掩码、令牌都不在
  const text = JSON.stringify(view);
  for (const leak of ['abc123', 'def456', '张三', '李四', 'w001****11', 'w002****22', 'SECRET', 'C:\\pool']) assert.ok(!text.includes(leak), '回报里出现了 ' + leak);
  // 公司：轻提示（中性措辞、不弹系统通知）、审计日志、历史里不存压缩包
  const notice = r.notices.find(n => /对端查看了这台电脑的状态/.test(n.title));
  assert.ok(notice && notice.quiet === true && !/家里/.test(notice.title + notice.text));
  assert.match(fs.readFileSync(path.join(logs, 'company-diag.log'), 'utf8'), new RegExp(`diag ${sent.id} sections=machine,processes,hub,pool,logs elapsed=\\d+ms bytes=\\d+`));
  assert.ok(!JSON.stringify(r.company.hubAdmin.state().history).includes('"diag":"'), '公司历史里不存回报内容');
  assert.equal(r.company.status().hubAdmin.lastDiag.id, sent.id);
  // 家里：不发通知、不算待办的远程指令；摘要可读
  assert.ok(!r.notices.some(n => /公司联动/.test(n.title) && /这台电脑的状态/.test(n.text)), '直查结果不弹通知');
  assert.equal(r.home.status().companyHub.pending.length, 0);
  assert.equal(r.home.status().companyDiag.latest.id, sent.id);
  assert.match(view.summary, /内存可用 13%.*CodeAgent 3 个.*残留嫌疑 2 个.*通道 1 个在跑、1 个排队（上限 1，受内存余量限制）/);
  assert.ok(view.bytes > 0 && view.bytes < 60000);
});

test('限频：30 秒内第二次直查回 refused（家里拿到原因、不弹通知）；过了 30 秒照常', async t => {
  const r = setup(t); await pair(r);
  assert.equal((await diagRound(r, { sections: ['machine'] })).view.status, '已回报');
  r.clock.now += 10000;
  const second = await diagRound(r, { sections: ['machine'] });
  assert.equal(second.view.status, '公司没处理'); assert.match(second.view.note, /30 秒内只查一次：上一次在 10 秒前/);
  assert.ok(!r.notices.some(n => /公司联动 · 公司 Hub/.test(n.title) && /30 秒内/.test(n.text)));
  assert.match(fs.readFileSync(path.join(r.root, 'company', 'logs', 'company-diag.log'), 'utf8'), /refused HA-/);
  r.clock.now += 21000;
  const third = await diagRound(r, { sections: ['machine'] });
  assert.equal(third.view.status, '已回报'); assert.deepEqual(Object.keys(third.view.diag).filter(k => D.SECTIONS.includes(k)), ['machine']);
});

test('代次不符、编号格式不对：不处理、不回报；段落白名单：家里不认识的直接报错，公司只采白名单里的', async t => {
  const r = setup(t); await pair(r);
  const outbox = () => (r.company.store.get('outbox') || []).length;
  assert.equal(r.company.hubAdmin.receive({ type: 'hub-admin', op: 'diag', id: 'HA-1018-aaaaaa', gen: 'old-gen' }), true);
  assert.equal(r.company.hubAdmin.receive({ type: 'hub-admin', op: 'diag', id: 'bad id!', gen: r.company.link.gen() }), true);
  assert.equal(r.company.hubAdmin.diagTask, undefined); assert.equal(outbox(), 0); assert.equal(r.company.hubAdmin.state().lastDiagAt, undefined);
  await assert.rejects(r.home.hubAdmin({ op: 'diag', sections: ['machine', 'shell'] }), /sections 只能是 machine \/ processes \/ hub \/ pool \/ logs，不认识：shell/);
  // 绕过家里直接塞：公司只采白名单段落，其余记为 ignored
  r.company.hubAdmin.receive({ type: 'hub-admin', op: 'diag', id: 'HA-1018-bbbbbb', gen: r.company.link.gen(), sections: ['machine', 'Get-Process | Stop-Process'] });
  await r.company.hubAdmin.diagTask;
  const st = r.company.hubAdmin.state().history[0];
  assert.equal(st.phase, 'diag'); assert.deepEqual(st.sections, ['machine']);
  await r.home.checkNow();
  const got = r.home.diagEntry('HA-1018-bbbbbb').result;
  assert.deepEqual(got.sections, ['machine']); assert.equal(got.ignored.length, 1); assert.ok(!got.processes && !got.logs);
});

test('大小降级：先截日志、再截进程……整条消息始终小于 60000 字节；采不到的段落只写原因', async t => {
  const r = setup(t); await pair(r);
  const rand = n => Array.from({ length: n }, () => Math.random().toString(36).slice(2, 9)).join(' ');
  const logs = path.join(r.root, 'company', 'logs'); fs.mkdirSync(logs, { recursive: true });
  for (const f of ['company-bridge.log', 'company-session-care.log', 'window-events.log']) fs.writeFileSync(path.join(logs, f), Array.from({ length: 300 }, () => rand(50)).join('\n') + '\n');
  r.box.sys = fakeSys(t, { processSnapshot: async () => { throw new Error('Get-CimInstance 被策略禁止'); } });
  const { view } = await diagRound(r, { lines: 200 });
  assert.equal(view.status, '已回报');
  assert.ok(view.bytes < 60000, '整条消息 ' + view.bytes);
  assert.equal(view.degraded[0], '日志每份截到 40 行');
  assert.deepEqual(view.diag.processes, { error: 'Get-CimInstance 被策略禁止' });
  assert.equal(view.diag.hub.processNote, '会话内存没算出来：Get-CimInstance 被策略禁止');
  assert.ok(view.diag.machine.memory, '其余段落照常');
  assert.match(view.summary, /没采到：进程/);
  // fit 本身：量出来始终超限时退到只留摘要
  const huge = { schema: 1, sections: ['logs'], at: NOW, elapsedMs: 5, logs: { files: [{ key: 'x', lines: [rand(30000)] }] } };
  const tried = [];
  const fitted = D.fit(huge, data => { const d = D.decode(data); tried.push(d.degraded.at(-1) || '原样'); return d.note ? 900 : 70000; });
  assert.deepEqual(tried, ['原样', '日志每份截到 40 行', '日志每份截到 15 行', '进程只留前 10，残留嫌疑只留前 15', '日志省略', '会话列表只留 20 个', '进程只留前 5，残留嫌疑只留前 5，会话列表省略', '只留各段汇总', '全部省略']);
  assert.equal(fitted.result.degraded.at(-1), '全部省略'); assert.ok(fitted.bytes < 60000);
  assert.deepEqual(D.decode(fitted.data).degraded, fitted.result.degraded);
});

test('家里 company_diag：默认等回报直接返回结果；带 id 取旧结果；超时返回编号', async t => {
  const r = setup(t); await pair(r);
  r.hs.map.set('home-s', { id: 'home-s', kind: 'claude', status: 'idle' });
  r.box.sleepHook = async () => { await r.company.checkNow(); await r.company.hubAdmin.diagTask; };
  const got = await r.home.invoke({ name: 'company_diag', callerSessionId: 'home-s', arguments: { sections: ['machine', 'hub'] } });
  assert.equal(got.status, '已回报'); assert.ok(got.diag.machine && got.diag.hub && !got.diag.logs);
  const again = await r.home.invoke({ name: 'company_diag', callerSessionId: 'home-s', arguments: { id: got.id } });
  assert.equal(again.status, '已回报'); assert.equal(again.id, got.id);
  await assert.rejects(r.home.invoke({ name: 'company_diag', callerSessionId: 'home-s', arguments: { id: 'HA-0000-000000' } }), /找不到直查编号/);
  // 公司不在线：等到时限返回编号与下一步
  r.box.sleepHook = null; r.clock.now += 60000;
  const late = await r.home.diag({ sections: ['machine'], waitMs: 1 });
  assert.equal(late.status, '等待回报'); assert.match(late.next, /带 id「HA-/);
  assert.equal(r.home.polling().intervalSeconds, 5, '等直查回报时每 5 秒看一次');
});

test('MCP 列出 company_diag（只读）；命令行 --diag 把段落、行数、编号原样交给本机 Hub', async t => {
  const { listTools } = require('../scripts/company-bridge-mcp');
  const tool = listTools({}).find(x => x.name === 'company_diag');
  assert.ok(tool && tool.annotations.readOnlyHint === true);
  assert.match(tool.description, /秒级、不排队、不占公司 CodeAgent/);
  assert.deepEqual(tool.inputSchema.properties.sections.items.enum, D.SECTIONS);
  const bodies = [];
  const server = http.createServer((req, res) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { bodies.push(JSON.parse(b)); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, result: { status: '已回报' } })); }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-diag-cli-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const endpoint = path.join(dir, 'mcp-endpoint.json');
  fs.writeFileSync(endpoint, JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/tool` }));
  const run = args => new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'company-ask.js'), ...args], { env: { ...process.env, HUB_BRIDGE_SESSION_ID: 's1', HUB_BRIDGE_SESSION_PASS: 'p', HUB_BRIDGE_ENDPOINT_FILE: endpoint }, windowsHide: true });
    let out = ''; child.stdout.on('data', c => { out += c; }); child.on('close', code => resolve({ code, out }));
  });
  assert.equal((await run(['--diag', 'machine,hub', '--lines', '30'])).code, 0);
  assert.equal((await run(['--diag'])).code, 0);
  assert.equal((await run(['--diag', '--id', 'HA-1018-abcdef'])).code, 0);
  assert.deepEqual(bodies.map(b => [b.name, b.arguments]), [
    ['company_diag', { sections: ['machine', 'hub'], lines: 30 }], ['company_diag', {}], ['company_diag', { id: 'HA-1018-abcdef' }]]);
});

test('开关：公司关了「状态查看」回 refused；公司报过版本却没报直查能力（旧版）时家里直接说明、不发', async t => {
  const r = setup(t); await pair(r);
  r.company.setSettings({ allowRemoteDiag: false });
  const off = await diagRound(r, { sections: ['machine'] });
  assert.equal(off.view.status, '公司没处理'); assert.match(off.view.note, /没允许对端查看状态/);
  assert.equal(r.company.hubAdmin.state().lastDiagAt, undefined, '关着时不算一次直查');
  r.company.setSettings({ allowRemoteDiag: true });
  assert.ok((r.home.adminState().company.caps || []).includes('diag'), '新版公司的回报带直查能力');
  // 模拟旧版公司：报了版本、没带 caps
  const st = r.home.adminState();
  r.home.store.set('hubAdmin', { ...st, company: { current: '2.1.11', latest: null, at: NOW, caps: null } });
  const posts = r.relay.posts;
  await assert.rejects(r.home.hubAdmin({ op: 'diag' }), /公司 Hub 版本过旧（v2\.1\.11），不支持直查/);
  assert.equal(r.relay.posts, posts, '没有发出去');
});