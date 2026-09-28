'use strict';

// 安装入口的行为守卫（Windows）。
//
// 背景：轮次1 的实现单测全绿，但 Codex 2 独立审查发现组员照文档操作照样会摔：
//   1. install.ps1 用数组 splat 转发参数 -> PowerShell 按位置传参 -> 合法的 64 位
//      Token 被当成参数名，报 "got length 6"。
//   2. install-hub.bat 执行的是旁边的 install-hub.ps1，而文档只让下载 .bat 和
//      setup.ps1，承诺"只下 bat 也行"。空目录里双击直接失败。
//   3. git clone 失败会对目标目录执行递归强删 —— 目标要是用户已有的目录就没了。
//   4. 脚本在自己的 clone 里运行时先命中"本地副本"分支，永远走不到 git pull，
//      于是"重跑安装即可更新"是假的。
//
// 这些都不是语法问题，Parser 全绿也照样发生，所以这里真实执行候选脚本本体，
// 只把网络/包管理器换成受控替身。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const WINDOWS = process.platform === 'win32';
const TOKEN = 'a'.repeat(64);

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `hub-entry-${tag}-`));
}

/** PowerShell 的 Set-Content -Encoding UTF8 会写 BOM，JSON.parse 认不得。 */
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

/** 造一个看起来像 Hub 仓库的目录（Test-HubRepo 只认这三样）。 */
function seedHubTree(dir) {
  fs.mkdirSync(path.join(dir, 'core'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'hub', version: '9.9.9' }));
  fs.writeFileSync(path.join(dir, 'main.js'), '// fixture\n');
  fs.writeFileSync(path.join(dir, 'core', 'placeholder.js'), '// fixture\n');
}

/**
 * 放一批 .cmd 替身到独立目录，返回可前置到 PATH 的路径。
 * 每个替身把自己的完整命令行追加到日志里，便于断言"到底调了什么"。
 */
function makeShims(dir, shims) {
  const binDir = path.join(dir, 'shim-bin');
  fs.mkdirSync(binDir, { recursive: true });
  for (const [name, body] of Object.entries(shims)) {
    fs.writeFileSync(path.join(binDir, `${name}.cmd`), body.replace(/\n/g, '\r\n'), 'ascii');
  }
  return binDir;
}

/**
 * 编译一个最小的 powershell.exe 替身，返回可前置到 PATH 的目录。
 * 它把收到的参数追加到 SHIM_LOG，并按 SHIM_DROP_FILE 造出"下载好"的文件。
 * 用 .exe 而不是 .cmd，是因为批处理调用 .cmd 不加 call 就不会把控制权交还。
 */
function compilePowerShellShim(dir) {
  const binDir = path.join(dir, 'shim-exe');
  fs.mkdirSync(binDir, { recursive: true });
  const csharp = `
using System; using System.IO; using System.Text;
public class Shim {
  public static int Main(string[] args) {
    string log = Environment.GetEnvironmentVariable("SHIM_LOG");
    if (!String.IsNullOrEmpty(log)) File.AppendAllText(log, String.Join(" ", args) + Environment.NewLine, Encoding.UTF8);
    string drop = Environment.GetEnvironmentVariable("SHIM_DROP_FILE");
    if (!String.IsNullOrEmpty(drop) && !File.Exists(drop)) File.WriteAllText(drop, "# downloaded");
    return 0;
  }
}`;
  const srcPath = path.join(binDir, 'shim.cs');
  fs.writeFileSync(srcPath, csharp, 'utf8');
  const exePath = path.join(binDir, 'powershell.exe');
  const build = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Add-Type -TypeDefinition (Get-Content -Raw '${srcPath}') -OutputType ConsoleApplication -OutputAssembly '${exePath}'`],
    { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  assert.ok(fs.existsSync(exePath), `编译 powershell 替身失败：\n${build.stdout}${build.stderr}`);
  return binDir;
}

function runPowerShell(scriptPath, args, { cwd, env } = {}) {
  const res = spawnSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
    { cwd, env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  return { code: res.status, out: `${res.stdout || ''}${res.stderr || ''}` };
}

// 记录自己被调用时的全部参数，然后成功返回。
const LOGGING_NPM = `@echo off\r\n>>"%SHIM_LOG%" echo npm %*\r\nexit /b 1\r\n`;

test('install.ps1 按名透传参数，64 位 Token 不会被当成参数名', { skip: !WINDOWS }, (t) => {
  const dir = tmpdir('forward');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.copyFileSync(path.join(ROOT, 'install.ps1'), path.join(dir, 'install.ps1'));
  // 替身 setup.ps1：参数签名与真品一致，把绑定结果写成 JSON。
  fs.writeFileSync(path.join(dir, 'setup.ps1'), [
    'param([string]$Token,[switch]$UseOwnAccount,[string]$MeridianUrl,[string]$ClaudeModel,',
    '      [string]$CodexModel,[string]$HubDir,[string]$DataDir,[string]$LocalSource,',
    '      [switch]$NoLaunch,[switch]$SkipHealthCheck)',
    '@{ Token=$Token; UseOwnAccount=[bool]$UseOwnAccount; HubDir=$HubDir; DataDir=$DataDir;',
    '   NoLaunch=[bool]$NoLaunch; SkipHealthCheck=[bool]$SkipHealthCheck } |',
    '  ConvertTo-Json -Compress | Set-Content -Encoding UTF8 $env:PROBE_OUT',
  ].join('\n'), 'utf8');

  const probe = path.join(dir, 'probe.json');
  const spacedDir = path.join(dir, 'a b', 'hub');

  const first = runPowerShell(path.join(dir, 'install.ps1'),
    ['-Token', TOKEN, '-NoLaunch', '-HubDir', spacedDir], { env: { PROBE_OUT: probe } });
  assert.equal(first.code, 0, `install.ps1 应成功转发，实际输出：\n${first.out}`);

  const got = readJson(probe);
  assert.equal(got.Token, TOKEN, '这是轮次1 的原缺陷：Token 被绑成了 "-Token"');
  assert.equal(got.HubDir, spacedDir, '带空格的路径必须原样到达');
  assert.equal(got.NoLaunch, true);
  assert.equal(got.SkipHealthCheck, false, '没传的开关不该凭空变 true');
  assert.equal(got.UseOwnAccount, false);

  // 开关型参数与无 Token 场景同样要对。
  const second = runPowerShell(path.join(dir, 'install.ps1'),
    ['-UseOwnAccount', '-SkipHealthCheck'], { env: { PROBE_OUT: probe } });
  assert.equal(second.code, 0, second.out);
  const got2 = readJson(probe);
  assert.equal(got2.UseOwnAccount, true);
  assert.equal(got2.SkipHealthCheck, true);
  assert.equal(got2.Token, '', '没传 Token 就不该有值');
});

test('install-hub.bat 调用同目录的 install-hub.ps1 并透传参数', { skip: !WINDOWS }, (t) => {
  const dir = tmpdir('bat-local');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.copyFileSync(path.join(ROOT, 'install-hub.bat'), path.join(dir, 'install-hub.bat'));
  const probe = path.join(dir, 'probe.txt');
  fs.writeFileSync(path.join(dir, 'install-hub.ps1'),
    'param([Parameter(ValueFromRemainingArguments=$true)]$Rest)\n'
    + 'Set-Content -Encoding UTF8 $env:PROBE_OUT ($Rest -join " ")\n', 'utf8');

  const res = spawnSync('cmd.exe', ['/c', path.join(dir, 'install-hub.bat'), '-Token', TOKEN, '-NoLaunch'],
    { cwd: dir, env: { ...process.env, PROBE_OUT: probe }, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  assert.equal(res.status, 0, `${res.stdout}${res.stderr}`);
  const forwarded = fs.readFileSync(probe, 'utf8').trim();
  assert.match(forwarded, new RegExp(`-Token ${TOKEN}`));
  assert.match(forwarded, /-NoLaunch/);
});

test('只下载 install-hub.bat 时，它会自己去取 install-hub.ps1', { skip: !WINDOWS }, (t) => {
  const dir = tmpdir('bat-boot');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // 目录里只有文档让下载的那一个文件 —— 这正是轮次1 直接失败的场景。
  fs.copyFileSync(path.join(ROOT, 'install-hub.bat'), path.join(dir, 'install-hub.bat'));
  const log = path.join(dir, 'powershell-calls.log');
  const fakeTemp = path.join(dir, 'temp');
  fs.mkdirSync(fakeTemp);
  // 替身必须是真的 .exe：批处理里不加 call 直接调另一个 .cmd 会把控制权一去不返，
  // 于是"下载后有没有真的启动它"这件事根本测不出来（本轮踩过）。
  const binDir = compilePowerShellShim(dir);

  const res = spawnSync('cmd.exe', ['/c', path.join(dir, 'install-hub.bat')], {
    cwd: dir,
    env: {
      ...process.env,
      SHIM_LOG: log, SHIM_DROP_FILE: path.join(fakeTemp, 'install-hub.ps1'),
      TEMP: fakeTemp, TMP: fakeTemp, PATH: `${binDir};${process.env.PATH}`,
    },
    // pause 只在下载失败那条路径上出现；关掉 stdin 保证测试不会挂住等按键。
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8', windowsHide: true, timeout: 120000,
  });
  assert.equal(res.status, 0, `${res.stdout}${res.stderr}`);

  const calls = fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean);
  assert.ok(calls.length >= 2, `应先下载再执行，实际调用：\n${calls.join('\n')}`);
  assert.match(calls[0], /raw\.githubusercontent\.com/, '第一次调用应该是去取 install-hub.ps1');
  assert.match(calls[0], /install-hub\.ps1/);
  assert.match(calls[calls.length - 1], /-File .*install-hub\.ps1/i,
    '下载完要真的执行它，而不是继续指向那个不存在的同目录路径');
});

test('clone 前发现目标目录已有内容：明确失败，绝不删除', { skip: !WINDOWS }, (t) => {
  const dir = tmpdir('no-delete');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.copyFileSync(path.join(ROOT, 'setup.ps1'), path.join(dir, 'setup.ps1'));
  const hubDir = path.join(dir, 'my-stuff');
  fs.mkdirSync(hubDir);
  const sentinel = path.join(hubDir, '重要文件.txt');
  fs.writeFileSync(sentinel, '用户自己的东西', 'utf8');

  const res = runPowerShell(path.join(dir, 'setup.ps1'), ['-HubDir', hubDir, '-NoLaunch']);
  assert.notEqual(res.code, 0, '必须失败退出');
  assert.match(res.out, /already exists and is not empty/, res.out);
  assert.ok(fs.existsSync(sentinel), '用户已有目录被删了 —— 这正是轮次1 的 P1 缺陷');
  assert.equal(fs.readFileSync(sentinel, 'utf8'), '用户自己的东西');
});

test('镜像全部失败时，不删除本来就存在的空目录', { skip: !WINDOWS }, (t) => {
  const dir = tmpdir('empty-keep');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.copyFileSync(path.join(ROOT, 'setup.ps1'), path.join(dir, 'setup.ps1'));
  const hubDir = path.join(dir, 'reserved-empty');
  fs.mkdirSync(hubDir);
  const log = path.join(dir, 'git.log');
  // 替身 git：版本查询成功，clone 一律失败。
  const binDir = makeShims(dir, {
    git: `@echo off\r\n>>"%SHIM_LOG%" echo git %*\r\n`
       + `if "%1"=="--version" (echo git version 2.99.0-fake & exit /b 0)\r\n`
       + `if "%1"=="clone" exit /b 128\r\nexit /b 0\r\n`,
  });

  const res = runPowerShell(path.join(dir, 'setup.ps1'), ['-HubDir', hubDir, '-NoLaunch'],
    { env: { SHIM_LOG: log, PATH: `${binDir};${process.env.PATH}` } });
  assert.notEqual(res.code, 0);
  assert.match(res.out, /clone failed from all mirrors/, res.out);
  assert.ok(fs.existsSync(hubDir), '预先存在的空目录仍然是用户的，不该被清掉');

  const gitCalls = fs.readFileSync(log, 'utf8');
  assert.match(gitCalls, /clone https:\/\/github\.com/, 'GitHub 必须先试');
  const order = [...gitCalls.matchAll(/clone (\S+)/g)].map((m) => m[1]);
  assert.ok(order.length >= 2 && /github\.com/.test(order[0]) && /gitee\.com/.test(order[1]),
    `镜像顺序必须是 GitHub 优先，实际：${order.join(' -> ')}`);
});

test('在已有 git clone 里重跑安装：真的 pull 到新提交，未跟踪文件保留', { skip: !WINDOWS }, (t) => {
  const dir = tmpdir('update');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const git = (args, cwd) => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' });
  const bare = path.join(dir, 'remote.git');
  const seed = path.join(dir, 'seed');
  const old = path.join(dir, 'old-clone');

  git(['init', '--bare', '-b', 'master', bare], dir);
  git(['clone', bare, seed], dir);
  git(['config', 'user.email', 't@example.test'], seed);
  git(['config', 'user.name', 'fixture'], seed);
  seedHubTree(seed);
  fs.copyFileSync(path.join(ROOT, 'setup.ps1'), path.join(seed, 'setup.ps1'));
  git(['add', '-A'], seed);
  git(['commit', '-m', 'v1'], seed);
  git(['push', 'origin', 'master'], seed);

  // 组员当时装的那一版
  git(['clone', bare, old], dir);
  const oldHead = git(['rev-parse', 'HEAD'], old).trim();

  // 之后维护者又发了一版
  fs.writeFileSync(path.join(seed, 'NEWFILE.md'), 'shipped later\n');
  git(['add', '-A'], seed);
  git(['commit', '-m', 'v2'], seed);
  git(['push', 'origin', 'master'], seed);
  const newHead = git(['rev-parse', 'HEAD'], seed).trim();
  assert.notEqual(oldHead, newHead);

  // 组员目录里还有自己的东西，更新不能把它弄丢
  fs.writeFileSync(path.join(old, '我的笔记.txt'), '别删我', 'utf8');

  const log = path.join(dir, 'npm.log');
  // npm 替身：在真正装依赖前把流程截停，第 3 步的结论已经落在输出里了。
  const binDir = makeShims(dir, { npm: LOGGING_NPM });

  const res = runPowerShell(path.join(old, 'setup.ps1'), ['-NoLaunch'],
    { cwd: old, env: { SHIM_LOG: log, PATH: `${binDir};${process.env.PATH}` } });

  assert.match(res.out, /updating existing clone/,
    `在 clone 里重跑必须走更新分支，实际输出：\n${res.out}`);
  assert.doesNotMatch(res.out, /using local copy/,
    '命中"本地副本"分支就意味着永远更新不了 —— 这正是轮次1 的 P2 缺陷');
  assert.match(res.out, /updated [0-9a-f]+ -> [0-9a-f]+/, res.out);
  assert.equal(git(['rev-parse', 'HEAD'], old).trim(), newHead, 'HEAD 必须真的前移到新提交');
  assert.ok(fs.existsSync(path.join(old, 'NEWFILE.md')), '新版本的文件应该到位');
  assert.equal(fs.readFileSync(path.join(old, '我的笔记.txt'), 'utf8'), '别删我',
    '更新不得动用户自己放的文件');
  // 截停发生在依赖安装那一步，证明本用例没有真的装东西。
  assert.match(res.out, /npm install failed/, res.out);
});

test('解压出来的 zip（没有 .git）仍走离线复制，并说明它无法自我更新', { skip: !WINDOWS }, (t) => {
  const dir = tmpdir('zip');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const unzipped = path.join(dir, 'claude-session-hub-master');
  fs.mkdirSync(unzipped);
  seedHubTree(unzipped);
  fs.copyFileSync(path.join(ROOT, 'setup.ps1'), path.join(unzipped, 'setup.ps1'));

  const binDir = makeShims(dir, { npm: LOGGING_NPM });
  const res = runPowerShell(path.join(unzipped, 'setup.ps1'), ['-NoLaunch'],
    { cwd: unzipped, env: { SHIM_LOG: path.join(dir, 'npm.log'), PATH: `${binDir};${process.env.PATH}` } });

  assert.match(res.out, /using local copy/, res.out);
  assert.match(res.out, /cannot update it/,
    'zip 安装无法靠重跑更新，必须明说，不能让人以为重跑就是最新版');
});
