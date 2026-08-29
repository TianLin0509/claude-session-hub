'use strict';

// 版本号一致性守卫。
//
// 用户 2026-08-29 的规矩：每次改 Hub 都要在同一提交里升版本号 —— 因为 Hub 是源码
// 模式运行且没有单实例锁，桌面上常年并存多个实例各持不同时刻的代码，窗口标题里的
// `v<version>`（main.js 的 _hubTitle 动态读 package.json）是唯一能一眼确认"这个
// 窗口跑的是不是新代码"的信号。
//
// 版本号写在 3 个地方，手改极易只改到 package.json 而漏掉 lock 的两处。这里只守
// 一致性，不守"必须比上次大" —— 后者是提交纪律，不是代码不变量。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, name), 'utf8'));

test('package.json 与 package-lock.json 的版本号三处一致', () => {
  const pkg = readJson('package.json');
  const lock = readJson('package-lock.json');

  assert.equal(typeof pkg.version, 'string');
  assert.notEqual(pkg.version, '');
  // lock 顶层
  assert.equal(lock.version, pkg.version,
    `package-lock.json 顶层 version=${lock.version} 与 package.json ${pkg.version} 不一致`);
  // lock 的根包条目（npm v2+ lockfile 的 packages[""]）
  const rootEntry = lock.packages && lock.packages[''];
  assert.ok(rootEntry, 'package-lock.json 缺少 packages[""] 根条目');
  assert.equal(rootEntry.version, pkg.version,
    `package-lock.json packages[""].version=${rootEntry.version} 与 package.json ${pkg.version} 不一致`);
  // 名字也一起对一下，防止 lock 是从别的项目拷来的
  assert.equal(lock.name, pkg.name);
  assert.equal(rootEntry.name, pkg.name);
});

test('版本号是 PE 版本资源能表达的纯数字三段式', () => {
  const { version } = readJson('package.json');
  // core/hub-exe-branding.js 的 parseVersionQuad 会把非数字段落夹成 0，
  // 预发布标签（1.7.0-beta.1）会让 exe 的版本资源退化成 1.7.0.0，看不出区别。
  assert.match(version, /^\d+\.\d+\.\d+$/,
    `版本号 ${version} 不是纯数字三段式；预发布标签在 exe 版本资源里会退化`);
  for (const part of version.split('.')) {
    assert.ok(Number(part) <= 65535, `版本号段 ${part} 超过 PE 的 16 位上限`);
  }
});

test('窗口标题的版本号来源没有被改成硬编码', () => {
  // main.js 必须继续动态读 package.json —— 硬编码会漂移，而漂移的后果正是
  // "重启后看标题以为是新代码，其实不是"。
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  assert.match(main, /require\('\.\/package\.json'\)\.version/,
    'main.js 不再动态读 package.json 的版本号');
  assert.match(main, /AI 群聊 Hub：PID \$\{process\.pid\}\$\{_pkgVersion \? ` v\$\{_pkgVersion\}` : ''\}/,
    '窗口标题不再带版本号，用户将无法从标题分辨实例跑的是哪一版代码');
});
