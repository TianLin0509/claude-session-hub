'use strict';
// 干净启动环境（core/clean-launch-env.js，2026-10-19，保守版）：由 Hub 拉起自己的路径都去掉会话标记与确认不该用的
// CodeAgent 配置目录；PATH 与其他用户变量不动；工作目录只在明显异常时修正。
//   node --test tests/unit-clean-launch-env.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const L = require('../core/clean-launch-env');

const repo = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(repo, rel), 'utf8');
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-clean-launch-')); t.after(() => fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 })); return d; };
const decision = (reason, over = {}) => ({ variable: 'CODEAGENT3_CONFIG_DIR', inherited: 'C:\\x', adopt: reason.startsWith('adopted'), reason, ...over });

test('清单：只含确认会出问题的会话标记，每个都写了原因', () => {
  for (const [name, reason] of Object.entries({ ...L.SESSION_VARS, ...L.SESSION_PREFIXES })) assert.ok(reason.length >= 4, name);
  for (const n of ['CLAUDE_HUB_SESSION_ID', 'CLAUDE_HUB_PORT', 'CLAUDE_HUB_TOKEN', 'CODEAGENT_HUB_X', 'codeagent_hub_lower', 'CODEAGENT3_LAUNCHER_PID', 'AI_HUB_NO_CHOICE'])
    assert.equal(L.isSessionMarker(n), true, n);
  // 实例身份、显式设置、其他用户变量、PATH 都不在清单里
  for (const n of ['CLAUDE_HUB_DATA_DIR', 'CLAUDE_HUB_HOME_DIR', 'CLAUDE_HUB_E2E', 'AI_HUB_CODEAGENT_CONFIG_DIR', 'CODEAGENT3_CONFIG_DIR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME',
    'DEEPSEEK_API_KEY', 'PATH', 'Path', 'PSModulePath', 'USERPROFILE', 'CLAUDECODE', 'MY_VAR'])
    assert.equal(L.isSessionMarker(n), false, n);
});

test('去掉会话标记；PATH、用户变量、实例身份原样保留；不改传入的环境', () => {
  const base = { Path: 'C:\\launcher\\junk;C:\\Windows', MY_VAR: 'keep', DEEPSEEK_API_KEY: 'k', CLAUDE_HUB_DATA_DIR: 'D:\\t', CLAUDE_HUB_HOME_DIR: 'D:\\h',
    AI_HUB_CODEAGENT_CONFIG_DIR: 'C:\\explicit', CLAUDE_CONFIG_DIR: 'C:\\c', CODEAGENT3_CONFIG_DIR: 'C:\\pool\\acc1',
    CODEAGENT_HUB_X: '1', CODEAGENT3_LAUNCHER_PID: '42', AI_HUB_NO_CHOICE: '1', CLAUDE_HUB_SESSION_ID: 's', CLAUDE_HUB_PORT: '3456', CLAUDE_HUB_TOKEN: 't' };
  const frozen = JSON.stringify(base);
  const r = L.buildCleanLaunchEnv(base);
  assert.equal(JSON.stringify(base), frozen);
  assert.deepEqual(r.env, { Path: 'C:\\launcher\\junk;C:\\Windows', MY_VAR: 'keep', DEEPSEEK_API_KEY: 'k', CLAUDE_HUB_DATA_DIR: 'D:\\t', CLAUDE_HUB_HOME_DIR: 'D:\\h',
    AI_HUB_CODEAGENT_CONFIG_DIR: 'C:\\explicit', CLAUDE_CONFIG_DIR: 'C:\\c', CODEAGENT3_CONFIG_DIR: 'C:\\pool\\acc1' }, '没有判定时 CODEAGENT3_CONFIG_DIR 不动');
  assert.deepEqual(r.removed.map(x => x.name).sort(), ['AI_HUB_NO_CHOICE', 'CLAUDE_HUB_PORT', 'CLAUDE_HUB_SESSION_ID', 'CLAUDE_HUB_TOKEN', 'CODEAGENT3_LAUNCHER_PID', 'CODEAGENT_HUB_X']);
});

test('CODEAGENT3_CONFIG_DIR：只在落在号池里、或只在进程里出现时去掉；采用的、注册表读不到的、个人目录已显式指定的都不动', () => {
  const base = { CODEAGENT3_CONFIG_DIR: 'C:\\pool\\acc1', MY_VAR: 'v' };
  for (const reason of ['in-pool', 'process-only']) {
    const r = L.buildCleanLaunchEnv(base, { decision: decision(reason) });
    assert.deepEqual(r.env, { MY_VAR: 'v' }, reason);
    assert.equal(r.removed[0].name, 'CODEAGENT3_CONFIG_DIR');
  }
  for (const reason of ['adopted-user-env', 'adopted-system-env', 'unverified', 'explicit']) {
    assert.deepEqual(L.buildCleanLaunchEnv(base, { decision: decision(reason) }).env, base, reason);
  }
  // 变量名改过（AI_HUB_CODEAGENT_CONFIG_ENV）时按改过的名字
  const custom = L.buildCleanLaunchEnv({ MY_CAC: 'C:\\pool\\acc1', CODEAGENT3_CONFIG_DIR: 'C:\\other' }, { decision: decision('in-pool', { variable: 'MY_CAC' }) });
  assert.deepEqual(custom.env, { CODEAGENT3_CONFIG_DIR: 'C:\\other' });
});

test('工作目录：只在不存在或在 Windows 系统目录里时才算异常', () => {
  const opts = { exists: d => !/gone/i.test(d), systemRoot: 'C:\\Windows', platform: 'win32' };
  assert.equal(L.abnormalCwd('C:\\Windows\\System32', opts), true);
  assert.equal(L.abnormalCwd('c:\\windows', opts), true);
  assert.equal(L.abnormalCwd('C:\\gone\\dir', opts), true);
  assert.equal(L.abnormalCwd('', opts), true);
  for (const ok of ['C:\\WindowsApps\\x', 'D:\\AIWork', 'C:\\Users\\u', 'C:\\Program Files\\Hub']) assert.equal(L.abnormalCwd(ok, opts), false, ok);
  const t = { execPath: 'C:\\Program Files\\Hub\\Hub.exe', isPackaged: true };
  assert.equal(L.cwdFix('D:\\AIWork', t, opts), null, '正常的工作目录沿用');
  assert.equal(L.cwdFix('C:\\Windows\\System32', t, { ...opts, exists: () => true }), path.resolve('C:\\Program Files\\Hub'));
  assert.equal(L.launchCwd({ execPath: 'C:\\x\\electron.exe', appRoot: 'C:\\src\\hub', exists: () => true }), path.resolve('C:\\src\\hub'), '源码运行是程序目录');
  assert.equal(L.launchCwd({ execPath: 'C:\\x\\electron.exe', appRoot: 'C:\\gone', exists: () => false, homeDir: 'C:\\Users\\u' }), 'C:\\Users\\u');
});

test('启动自检：会话标记立刻删掉、工作目录异常才改；原始环境留给直查；日志只写变量名', () => {
  const env = { CODEAGENT_HUB_X: '1', CLAUDE_HUB_SESSION_ID: 's', CODEAGENT3_CONFIG_DIR: 'C:\\pool\\acc1', MY_VAR: 'v', Path: 'P' };
  let chdirTo = null;
  const logs = [];
  const report = L.cleanOwnEnvAtStartup({ env, appRoot: __dirname, chdir: d => { chdirTo = d; }, cwd: () => 'C:\\Windows\\System32',
    systemRoot: 'C:\\Windows', exists: () => true, logger: { warn: m => logs.push(m) } });
  assert.deepEqual(env, { CODEAGENT3_CONFIG_DIR: 'C:\\pool\\acc1', MY_VAR: 'v', Path: 'P' });
  if (process.platform === 'win32') assert.equal(chdirTo, path.resolve(__dirname));
  assert.deepEqual(report.removed.map(r => r.name).sort(), ['CLAUDE_HUB_SESSION_ID', 'CODEAGENT_HUB_X']);
  assert.equal(L.inheritedEnv().CODEAGENT_HUB_X, '1');
  assert.ok(logs.length === 1 && /CODEAGENT_HUB_X/.test(logs[0]) && !/pool/.test(logs[0]));
  // 正常工作目录：不改、不记
  let chdir2 = null; const logs2 = [];
  L.cleanOwnEnvAtStartup({ env: { MY_VAR: 'v' }, appRoot: __dirname, chdir: d => { chdir2 = d; }, cwd: () => __dirname, logger: { warn: m => logs2.push(m) } });
  assert.equal(chdir2, null); assert.deepEqual(logs2, []);
});

test('继承目录判定出来后：确认不该用才从进程环境去掉；之后的再启动沿用同一判定', () => {
  const env = { CODEAGENT3_CONFIG_DIR: 'C:\\pool\\acc1', MY_VAR: 'v' };
  assert.equal(L.applyConfigDirDecision(decision('unverified'), { env, logger: {} }), null);
  assert.equal(env.CODEAGENT3_CONFIG_DIR, 'C:\\pool\\acc1');
  const info = L.applyConfigDirDecision(decision('in-pool'), { env, logger: {} });
  assert.deepEqual(info, { removed: ['CODEAGENT3_CONFIG_DIR'], reason: 'in-pool' });
  assert.deepEqual(env, { MY_VAR: 'v' });
  const plan = L.prepareHubLaunch({ env: { CODEAGENT3_CONFIG_DIR: 'C:\\pool\\acc1', CODEAGENT_HUB_X: '1' }, currentCwd: () => __dirname });
  assert.deepEqual(plan.env, {}, '再启动沿用判定');
  assert.equal(plan.cwd, null);
  L.applyConfigDirDecision(null, { env: {}, logger: {} });
  const early = L.prepareHubLaunch({ env: { CODEAGENT3_CONFIG_DIR: 'C:\\pool\\acc1' }, decide: () => decision('in-pool'), currentCwd: () => __dirname });
  assert.deepEqual(early.env, {}, '判定还没出来时用 decide 现算');
});

test('app.relaunch：调用那一刻进程环境里没有会话标记，工作目录异常时换掉；调用后立刻恢复', t => {
  const dir = tmp(t);
  const savedCwd = process.cwd();
  process.env.CODEAGENT_HUB_UNIT_X = '1';
  t.after(() => { delete process.env.CODEAGENT_HUB_UNIT_X; process.chdir(savedCwd); });
  let seen = null;
  const app = { relaunch: opts => { seen = { opts, marker: process.env.CODEAGENT_HUB_UNIT_X, cwd: process.cwd(), path: process.env.PATH }; } };
  const summary = L.relaunchApp(app, { args: ['a'] }, {}, { logger: {}, prepare: () => ({ ...L.buildCleanLaunchEnv(process.env), cwd: dir }) });
  assert.deepEqual(seen.opts, { args: ['a'] });
  assert.equal(seen.marker, undefined);
  assert.equal(seen.path, process.env.PATH, 'PATH 不动');
  assert.equal(fs.realpathSync(seen.cwd), fs.realpathSync(dir));
  assert.equal(process.env.CODEAGENT_HUB_UNIT_X, '1', '本进程环境恢复');
  assert.equal(process.cwd(), savedCwd);
  assert.ok(summary.removed.includes('CODEAGENT_HUB_UNIT_X'));
  // 工作目录正常：不换
  L.relaunchApp({ relaunch: () => { seen.cwd2 = process.cwd(); } }, {}, {}, { logger: {}, prepare: () => ({ ...L.buildCleanLaunchEnv(process.env), cwd: null }) });
  assert.equal(seen.cwd2, savedCwd);
});

// ---- 调用点契约：所有由 Hub 拉起自己的路径都先经过干净启动环境 ----
test('契约：五处再启动路径都经过干净启动环境', () => {
  const main = read('main.js');
  // 1. 远程重启（hub-admin）
  assert.match(main, /relaunch: \(\) => \{ relaunchHubClean\(\); app\.quit\(\); \}/);
  assert.match(main, /function relaunchHubClean\([^)]*\) \{[\s\S]{0,200}return require\('\.\/core\/clean-launch-env'\)\.relaunchApp\(app,/);
  // 2. 重启并继续
  assert.match(main, /registerHubRestartIpc\(ipcMain, \{[\s\S]{0,400}relaunchHub: relaunchHubClean/);
  assert.match(read('main/ipc/hub-restart-handlers.js'), /relaunchHub\(\{args:\[\.\.\.args,ARG\+plan\.token\]\}\)/);
  // 3/4. 增量更新替换脚本、完整安装包
  assert.match(main, /createAppUpdateController\(\{[\s\S]{0,300}prepareLaunch: prepareHubLaunchClean/);
  const ctrl = read('main/app-update-controller.js');
  assert.match(ctrl, /launch = prepareLaunch\(\)/);
  assert.match(ctrl, /spawnImpl\(staged\.installer, \[\], \{[^}]*\.\.\.\(launch \? \{ env: launch\.env/);
  assert.match(ctrl, /launchHelper\(staged\.paths, \{ env: launch \? launch\.env : env, spawnImpl \}\)/);
  // 5. 任务栏「新 Hub」
  assert.match(main, /ipcMain\.handle\('hub:new-instance'[\s\S]{0,500}env: prepareHubLaunchClean\(\)\.env/);
  // 启动自检在 main.js 之前；继承目录判定出来后去掉
  const boot = read('main-bootstrap.js');
  assert.ok(boot.indexOf('cleanOwnEnvAtStartup') > 0 && boot.indexOf('cleanOwnEnvAtStartup') < boot.indexOf("require('./main.js')"));
  assert.match(main, /loadInheritedDecision\(\{ env: launchEnv\.inheritedEnv\(\)[\s\S]{0,200}applyConfigDirDecision\(decision/);
});

test('契约：源码里没有别处直接 app.relaunch（新增再启动路径必须走 relaunchHubClean）', () => {
  const offenders = [];
  const scan = rel => { for (const l of read(rel).split('\n')) if (/\bapp\.relaunch\(/.test(l) && !/^\s*\/\//.test(l)) offenders.push(rel + ': ' + l.trim()); };
  const walk = dir => {
    for (const ent of fs.readdirSync(path.join(repo, dir), { withFileTypes: true })) {
      const rel = dir + '/' + ent.name;
      if (ent.isDirectory()) walk(rel);
      else if (/\.js$/.test(ent.name) && rel !== 'core/clean-launch-env.js') scan(rel);
    }
  };
  walk('core'); walk('main'); scan('main.js'); scan('main-bootstrap.js');
  // 允许的只有两处兜底：重启处理器没拿到 relaunchHub 时（单测）、relaunchHubClean 清环境出错时
  assert.deepEqual(offenders, [
    'main/ipc/hub-restart-handlers.js: const relaunchHub = deps.relaunchHub || (options => app.relaunch(options));',
    'main.js: app.relaunch(options && Object.keys(options).length ? options : undefined);',
  ], offenders.join('\n'));
});

test('增量更新：替换脚本拿到的是干净环境（真跑一遍，新程序里没有会话标记、PATH 不变）', { skip: process.platform !== 'win32', timeout: 90000 }, async t => {
  const root = tmp(t);
  const { packPayload } = require('../core/app-update/payload');
  const { stageIncremental, launchHelper } = require('../core/app-update/apply');
  const res = path.join(root, 'build', 'resources'); fs.mkdirSync(res, { recursive: true }); fs.writeFileSync(path.join(res, 'app.asar'), 'NEW');
  const installed = path.join(root, 'install', 'resources'); fs.mkdirSync(installed, { recursive: true }); fs.writeFileSync(path.join(installed, 'app.asar'), 'OLD');
  const payload = path.join(root, 'u.gz'); packPayload(res, payload);
  const dump = path.join(root, 'dump.js'), out = path.join(root, 'child-env.json');
  fs.writeFileSync(dump, `require('fs').writeFileSync(process.argv[2], JSON.stringify({ cwd: process.cwd(), env: process.env }));`);
  const staged = stageIncremental({ dataDir: path.join(root, 'data'), payloadFile: payload, resourcesDir: installed, version: '1.0.1', from: '1.0.0',
    exe: process.execPath, args: [dump, out], pid: 0, relaunch: true });
  const launch = L.prepareHubLaunch({ env: { ...process.env, CODEAGENT_HUB_X: '1', CLAUDE_HUB_SESSION_ID: 's', CODEAGENT3_CONFIG_DIR: 'C:\\pool\\acc1' },
    decide: () => decision('in-pool'), currentCwd: () => __dirname });
  launchHelper(staged.paths, { env: launch.env });
  for (let i = 0; i < 300 && !fs.existsSync(out); i++) await new Promise(r => setTimeout(r, 200));
  await new Promise(r => setTimeout(r, 300));
  const got = JSON.parse(fs.readFileSync(out, 'utf8'));
  const keys = Object.keys(got.env).map(k => k.toUpperCase());
  for (const k of ['CODEAGENT_HUB_X', 'CLAUDE_HUB_SESSION_ID', 'CODEAGENT3_CONFIG_DIR']) assert.ok(!keys.includes(k), k + ' 不带下去');
  const pathKey = o => Object.keys(o).find(k => k.toUpperCase() === 'PATH');
  assert.ok(String(got.env[pathKey(got.env)]).includes(String(process.env[pathKey(process.env)]).split(';')[0]), 'PATH 原样带下去');
  assert.equal(fs.readFileSync(path.join(installed, 'app.asar'), 'utf8'), 'NEW');
});

test('兜底：准备干净环境出错（prepare 或读工作目录抛错）时退回原来的 app.relaunch，并记日志；Hub 照样被拉起', () => {
  process.env.CODEAGENT_HUB_UNIT_FB = '1';
  try {
    for (const [label, opts] of [
      ['prepare 抛错', { prepare: () => { throw new Error('boom-prepare'); } }],
      ['读工作目录抛错', { prepare: () => ({ removed: [], cwd: null, env: {} }), cwd: () => { throw new Error('boom-cwd'); } }],
      ['prepare 返回坏结果', { prepare: () => ({}) }],
    ]) {
      const calls = [], warns = [];
      const summary = L.relaunchApp({ relaunch: o => calls.push({ o, marker: process.env.CODEAGENT_HUB_UNIT_FB }) }, { args: ['x'] }, {}, { ...opts, logger: { warn: m => warns.push(m) } });
      assert.equal(calls.length, 1, label + '：app.relaunch 只调一次');
      assert.deepEqual(calls[0].o, { args: ['x'] }, label + '：参数原样');
      assert.equal(summary.fallback, true, label);
      assert.ok(warns.some(m => /准备干净启动环境失败/.test(m)), label + '：记了日志');
      assert.equal(process.env.CODEAGENT_HUB_UNIT_FB, '1', label + '：本进程环境没被动过');
    }
    // 没有参数时按无参调用（和改动前的 app.relaunch() 一致）
    const calls = [];
    L.relaunchApp({ relaunch: (...a) => calls.push(a) }, {}, {}, { prepare: () => { throw new Error('x'); }, logger: {} });
    assert.deepEqual(calls, [[undefined]]);
  } finally { delete process.env.CODEAGENT_HUB_UNIT_FB; }
});

test('契约：main.js 的 relaunchHubClean 整段兜底，出错退回 app.relaunch', () => {
  const main = read('main.js');
  const body = main.slice(main.indexOf('function relaunchHubClean('), main.indexOf('function prepareHubLaunchClean('));
  assert.match(body, /try \{[\s\S]*relaunchApp\(app, options[\s\S]*\} catch \(error\) \{[\s\S]*app\.relaunch\(/);
});

test('清单注释：AI_HUB_NO_CHOICE 是自动派活会话的内部标记，无条件清掉', () => {
  assert.match(read('core/clean-launch-env.js'), /fix\/no-choice-prompt[\s\S]{0,120}用户不会持久设置这个开关/);
  assert.equal(L.isSessionMarker('AI_HUB_NO_CHOICE'), true);
});
