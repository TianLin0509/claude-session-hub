'use strict';
// 公司版 CI 与会议室运行时（v3.1.0 起有这条约束，v3.1.3 起换了形态）：
// ① 公司版 CI 不再单独下载会议室运行时 —— 安装包从 v3.1.3 起根本不含这 76.8MB，
//    所以目标 overlay 里那份 ci.yml 已删除，导出的公司库直接用社区版那份，两边不会再漂；
// ② 运行时改由客户端按签名清单现下，地址必须是官方公开 release，期望值只认 baseline.json。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');

test('公司版不再单独覆盖 CI，导出后就是社区版那份（没有额外的运行时下载步骤）', () => {
  const companyOverlay = path.join(root, 'community/targets/company/overlay/.github/workflows');
  assert.equal(fs.existsSync(path.join(companyOverlay, 'ci.yml')), false, '公司版 ci.yml 已随 v3.1.3 删除');
  const community = read('community/overlay/.github/workflows/ci.yml');
  assert.doesNotMatch(community, /meeting-room runtime/);
  assert.doesNotMatch(community, /AI_HUB_ROOM_RUNTIME_SOURCE/);
});

test('公司打包不再自带运行时，也不再挂 beforePack 钩子', () => {
  const target = JSON.parse(read('community/targets/company/target.json'));
  assert.equal(target.build.beforePack, undefined);
  assert.equal(target.buildAsarUnpackAppend, undefined);
  assert.ok(target.buildFilesAppend.includes('!core/company-assistant/room-component/runtime/**'),
    '即使本机手工放了 runtime/ 也不打进安装包');
});

test('下载走 Electron 的网络栈（跟系统代理），主进程显式注入，核心模块自己也会解析', () => {
  assert.match(read('main.js'), /roomFetch: \(\.\.\.args\) => net\.fetch\(\.\.\.args\)/,
    '主进程要给会议室下载注入 net.fetch；Node 内置 fetch 不读系统代理');
  const { resolveFetch } = require('../core/company-assistant/room-runtime-download');
  const fake = () => 'x';
  assert.strictEqual(resolveFetch(fake), fake, '调用方明确给了就走它（单测、隔离源）');
  assert.strictEqual(typeof resolveFetch(), 'function', '没给也要解析出一个能用的 fetch');
});

test('下载地址是官方公开 release，期望值只认签名清单上的版本、大小和哈希', () => {
  const { SOURCES } = require('../core/company-assistant/room-runtime-download');
  const baseline = JSON.parse(read('core/company-assistant/room-component/baseline.json'));
  const github = SOURCES.find(s => s.id === 'github');
  assert.match(github.files, /^https:\/\/github\.com\/TianLin0509\/mishu-terminator\/releases\/download\/v\{version\}\/$/);
  assert.strictEqual(baseline.version, '2.1.0');
  assert.strictEqual(baseline.exe.file, 'MishuTerminator-2.1.0.exe');
  assert.strictEqual(baseline.exe.size, 80568759);
  assert.match(baseline.exe.sha256, /^[0-9a-f]{64}$/);
});
