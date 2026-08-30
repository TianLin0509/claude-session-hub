'use strict';

// 2026-08-29 事故：用户报「AI HUB 的文件预览突然打不开」，报错
// `加载失败：预览进程异常退出：launch-failed`。
//
// 排查结论（全部实测，不是推断）：
//   * 当时合进去的代码没问题 —— 同一分钟、同一台机器、同样内存压力下，
//     新起的隔离实例预览完全正常，而两个生产实例 3/3 失败。
//   * 元凶是品牌化副本的重建：升版本号 → stamp 失配 → 下次启动把**正在运行的**
//     AIGroupChatHub.exe 改名成 .stale-*、换上新副本。Windows 允许改名运行中的
//     映像，所以这套动作以前一直被认为是安全的；实测不是 —— 换完之后那些实例
//     再也起不了 Chromium 子进程，webview 一律
//     `render-process-gone reason=launch-failed exitCode=57`。
//     预览是唯一按需新建渲染进程的功能，所以它第一个死。
//   * 用真 Hub 复现成功（换 exe 前 loaded / 换 exe 后 launch-failed）。
//     ⚠ 用最小 Electron app 复现不出来，会给出假阴性。
//
// 「每次改动同步升版本号」是铁律，等于每次改动都会触发重建，所以这个闸门必须在。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  brandedExeInUse,
  ensureBrandedHubExe,
} = require('../core/hub-exe-branding.js');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-brand-inuse-'));
const dist = path.join(tmpRoot, 'dist');
fs.mkdirSync(dist, { recursive: true });
const branded = path.join(dist, 'AIGroupChatHub.exe');
const host = path.join(dist, 'electron.exe');
fs.writeFileSync(branded, 'branded');
fs.writeFileSync(host, 'host');

// --- 没人跑的普通文件：可写 → 不算占用 ---
assert.strictEqual(
  brandedExeInUse({ brandedExePath: branded, execPath: host, platform: 'win32' }),
  false,
  '没有实例在跑时必须允许重建，否则图标永远刷不上',
);

// --- 副本还不存在（首次生成）→ 不算占用 ---
assert.strictEqual(
  brandedExeInUse({ brandedExePath: path.join(dist, 'nope.exe'), execPath: host, platform: 'win32' }),
  false,
);

// --- 当前进程就跑在这个副本上 → 一定算占用（换掉它会打断自己） ---
assert.strictEqual(
  brandedExeInUse({ brandedExePath: branded, execPath: branded, platform: 'win32' }),
  true,
  'brand-hub-exe.js 是 Hub 用 ELECTRON_RUN_AS_NODE spawn 的，execPath 就是父 Hub 的 exe',
);
// 大小写与分隔符不同也要判为同一路径（Windows 路径不区分大小写）
assert.strictEqual(
  brandedExeInUse({ brandedExePath: branded, execPath: branded.toUpperCase(), platform: 'win32' }),
  true,
);

// --- 写打开被拒（EBUSY = 正在被执行）→ 算占用 ---
const busyFs = {
  existsSync: () => true,
  openSync: () => { const e = new Error('busy'); e.code = 'EBUSY'; throw e; },
  closeSync: () => {},
};
assert.strictEqual(
  brandedExeInUse({ brandedExePath: branded, execPath: host, fsModule: busyFs, platform: 'win32' }),
  true,
);
for (const code of ['EPERM', 'EACCES']) {
  const denyFs = { ...busyFs, openSync: () => { const e = new Error(code); e.code = code; throw e; } };
  assert.strictEqual(
    brandedExeInUse({ brandedExePath: branded, execPath: host, fsModule: denyFs, platform: 'win32' }),
    true,
    `${code} 也要判为占用`,
  );
}
// 其它错误（例如 ENOENT）不算占用，别把「文件没了」误判成「有人在跑」
const enoentFs = { ...busyFs, openSync: () => { const e = new Error('gone'); e.code = 'ENOENT'; throw e; } };
assert.strictEqual(
  brandedExeInUse({ brandedExePath: branded, execPath: host, fsModule: enoentFs, platform: 'win32' }),
  false,
);

// --- 非 Windows 不做这套判断 ---
assert.strictEqual(
  brandedExeInUse({ brandedExePath: branded, execPath: branded, platform: 'darwin' }),
  false,
);

// --- ensureBrandedHubExe：占用时必须原地返回，且一个字节都不许改 ---
const guardDist = path.join(tmpRoot, 'guard');
fs.mkdirSync(guardDist, { recursive: true });
const guardHost = path.join(guardDist, 'electron.exe');
const guardBranded = path.join(guardDist, 'AIGroupChatHub.exe');
const guardIco = path.join(guardDist, 'app.ico');
fs.writeFileSync(guardHost, Buffer.alloc(2 * 1024 * 1024, 1));
fs.writeFileSync(guardBranded, Buffer.alloc(2 * 1024 * 1024, 2));
fs.writeFileSync(guardIco, 'ico');

const beforeStat = fs.statSync(guardBranded);
const beforeNames = fs.readdirSync(guardDist).sort();
let reseditCalled = false;
const result = ensureBrandedHubExe({
  execPath: guardBranded,                 // 自己就跑在副本上
  icoPath: guardIco,
  productVersion: '9.9.9',                // 必然与 stamp 失配
  platform: 'win32',
  resedit: { get NtExecutable() { reseditCalled = true; return {}; } },
  logger: { log() {}, warn() {}, debug() {} },
});
assert.strictEqual(result.changed, false);
assert.strictEqual(result.reason, 'branded-exe-in-use');
assert.strictEqual(result.deferred, true);
assert.strictEqual(reseditCalled, false, '占用时不该白跑 220MB 的读改写');
assert.strictEqual(fs.statSync(guardBranded).mtimeMs, beforeStat.mtimeMs, '副本不得被改写');
assert.deepStrictEqual(fs.readdirSync(guardDist).sort(), beforeNames, '不得留下 .stale-* / .tmp-* 残骸');

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log('unit-hub-exe-branding-in-use: OK');
