'use strict';
// 找 welink-cli（2026-10-19 田哥：新电脑上装了 welink-cli，Hub 却说没找到，助理一直不同步）。
// 快速查找认 npm 配置文件里改过的全局目录；还找不到就在后台全盘找，找到记进设置、马上取数；也能手动选。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const W = require('../core/company-assistant/welink');
const { CompanyAssistant } = require('../core/company-assistant/service');
const { NoticeBus } = require('../core/company-assistant/notice-bus');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'welink-find-'));
function plant(dir) {
  const exe = path.join(dir, 'node_modules', '@welink', 'welink-cli', 'welink-cli.exe');
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, '');
  fs.writeFileSync(path.join(dir, 'welink-cli.cmd'), '@echo off\r\n');
  return exe;
}

test('快速查找：npm 全局目录改到别处（.npmrc 的 prefix）也能找到；APPDATA 默认目录照旧', () => {
  const home = tmp(), custom = path.join(home, 'D-drive', 'nodejs', 'node_global');
  const exe = plant(custom);
  fs.writeFileSync(path.join(home, '.npmrc'), `registry=https://example.invalid/\nprefix=${custom}\n`);
  assert.equal(W.resolveCli({ env: { USERPROFILE: home, PATH: '' } }), exe);
  const appData = tmp(), def = plant(path.join(appData, 'npm'));
  assert.equal(W.resolveCli({ env: { APPDATA: appData, PATH: '' } }), def);
  assert.equal(W.resolveCli({ env: { USERPROFILE: tmp(), PATH: '' } }), null);
  assert.ok(W.npmPrefixes({ USERPROFILE: home, NVM_SYMLINK: 'C:/nvm/nodejs' }).includes('C:/nvm/nodejs'), 'nvm 的目录也看');
});

test('全盘找：在给定目录里按文件名找到 welink-cli.exe', async () => {
  const root = tmp(), exe = plant(path.join(root, 'tools', 'node', 'global'));
  // Registry/npm belong to the test fixture; only the bounded directory walk is real.
  const execFileImpl = (file, args, opts, callback) => {
    if (file === 'reg.exe' || file === 'cmd.exe') { callback(null, ''); return; }
    return require('node:child_process').execFile(file, args, opts, callback);
  };
  const r = await W.findCliDeep({ env: { ...process.env, USERPROFILE: root }, execFileImpl, roots: [[root, 8]], timeoutMs: 60000 });
  assert.equal(r.path, exe);
  // 没有的目录：返回空（这台测试机本身没装 welink-cli，系统路径和 npm 那两步也找不到）
  assert.equal((await W.findCliDeep({ env: { ...process.env, USERPROFILE: tmp() }, execFileImpl, roots: [[tmp(), 8]], timeoutMs: 30000 })).path, null);
});

test('服务：取数时没找到 welink-cli 就在后台全盘找，找到记进设置并马上取数；没找到 6 小时内不重复自动找；手动选 .cmd 换成真 exe', async () => {
  const dir = tmp(), found = plant(path.join(dir, 'global'));
  let calls = 0, answer = null;
  const svc = new CompanyAssistant({ dataDir: dir, noTimer: true, noTools: true, bus: new NoticeBus(),
    resolveCli: ({ configured }) => (configured && fs.existsSync(configured) ? configured : null),
    findCliDeep: async () => { calls += 1; return answer; },
    welinkRun: async (args, opts) => { if (!opts.cli) throw Object.assign(new Error('没找到 welink-cli'), { code: 'WELINK_MISSING' }); return { code: 0, stdout: 'UID: u1\nUser Token: VALID\n', stderr: '' }; },
    createSession: async () => ({ id: 'x' }), sendPrompt: async () => ({ ok: true }), getSession: () => null, readFinals: () => [] });
  svc.welink = (args, opts = {}) => svc.deps.welinkRun(args, { ...opts, cli: svc.cli() });
  answer = { path: null };
  let snap = await svc.refresh({ force: true });
  assert.equal(snap.login.reason, 'missing');
  await svc.cliSearching;
  assert.equal(calls, 1, '没找到就自动全盘找');
  assert.equal(svc.status().cliSearch.state, 'notfound');
  await svc.refresh({ force: true });
  assert.equal(calls, 1, '刚找过没找到，不反复自动找');
  answer = { path: found, via: 'disk' };
  await svc.findCli({ force: true });
  assert.equal(calls, 2, '「再找一次」不受 6 小时限制');
  assert.equal(svc.settings().cliPath, found, '找到的路径记进设置');
  assert.equal(svc.status().cliFound, true);
  assert.match(fs.readFileSync(path.join(svc.workspace, 'welink-ro.cmd'), 'utf8'), /CLAUDE_HUB_WELINK_CLI=.*welink-cli\.exe/, '助理会话用的只读包装也换成找到的路径');
  svc.setSettings({ cliPath: '' });
  assert.equal(svc.useCliPath(path.join(dir, 'global', 'welink-cli.cmd')).path, found, '选 .cmd 换成旁边的真 exe');
  assert.throws(() => svc.useCliPath(path.join(dir, 'nope.exe')), /不存在/);
  svc.close();
});
