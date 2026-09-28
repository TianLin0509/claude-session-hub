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

/**
 * 容错清理：刚被 Start-Process 拉起来的替身进程可能还攥着文件句柄，
 * 直接 rmSync 会 EPERM。重试几次，实在删不掉就留给系统的临时目录清理。
 */
function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch { /* 临时目录残留无害，不让清理失败盖掉真正的断言结果 */ }
}

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
 * 编译一个最小的 .exe 替身。它把自己的名字、收到的参数和运行时看到的
 * CLAUDE_HUB_DATA_DIR 追加到 SHIM_LOG，并按 SHIM_DROP_FILE 造出"下载好"的文件。
 *
 * 必须是 .exe 而不是 .cmd：批处理调用另一个 .cmd 不加 call 就不会把控制权交还，
 * 用 .cmd 替身会把"下载完有没有真的启动它"测成假绿（轮次2 踩过）。
 */
// 编译一次就够：Add-Type 每次都要拉起 PowerShell + csc，在闸门默认并发 16 下
// 编译五遍足以把同批别的测试饿到超时（2026-09-28 实测：8 个无关文件首次失败、
// 串行复测全过，耗时差 7-20 倍）。所以本文件只编译一个模板，之后都是复制。
let _shimTemplate = null;

function buildShimTemplate() {
  if (_shimTemplate && fs.existsSync(_shimTemplate)) return _shimTemplate;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-shim-template-'));
  const exePath = path.join(dir, 'shim-template.exe');
  const srcPath = path.join(dir, 'shim.cs');
  // argv 必须逐项记录。用空格把参数拼回一个字符串，正好会把"路径被拆成两段"
  // 这种缺陷重新粘合成原样 —— 轮次4 的 P1 就是这么被测成假绿的。
  // \u001F(US) 作分隔符：Windows 路径里不可能出现。
  fs.writeFileSync(srcPath, `
using System; using System.IO; using System.Text;
public class Shim {
  public static int Main(string[] args) {
    string log = Environment.GetEnvironmentVariable("SHIM_LOG");
    if (!String.IsNullOrEmpty(log)) {
      string self = Path.GetFileName(Environment.GetCommandLineArgs()[0]);
      string dd = Environment.GetEnvironmentVariable("CLAUDE_HUB_DATA_DIR");
      File.AppendAllText(log, self + "|ARGC=" + args.Length
        + "|" + String.Join("\\u001F", args)
        + "|CLAUDE_HUB_DATA_DIR=" + (dd == null ? "(unset)" : dd) + Environment.NewLine, Encoding.UTF8);
    }
    string drop = Environment.GetEnvironmentVariable("SHIM_DROP_FILE");
    if (!String.IsNullOrEmpty(drop) && !File.Exists(drop)) File.WriteAllText(drop, "# downloaded");
    return 0;
  }
}`, 'utf8');
  const build = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Add-Type -TypeDefinition (Get-Content -Raw '${srcPath}') -OutputType ConsoleApplication -OutputAssembly '${exePath}'`],
    { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  assert.ok(fs.existsSync(exePath), `编译替身模板失败：\n${build.stdout}${build.stderr}`);
  _shimTemplate = exePath;
  return exePath;
}

/**
 * 放一个最小的 .exe 替身到指定位置。它把自己的名字、收到的参数和运行时看到的
 * CLAUDE_HUB_DATA_DIR 追加到 SHIM_LOG，并按 SHIM_DROP_FILE 造出"下载好"的文件。
 *
 * 必须是 .exe 而不是 .cmd：批处理调用另一个 .cmd 不加 call 就不会把控制权交还，
 * 用 .cmd 替身会把"下载完有没有真的启动它"测成假绿（轮次2 踩过）。
 */
function compileShimExe(exePath) {
  fs.mkdirSync(path.dirname(exePath), { recursive: true });
  fs.copyFileSync(buildShimTemplate(), exePath);
  return exePath;
}

/** 编译 powershell.exe 替身，返回可前置到 PATH 的目录。 */
function compilePowerShellShim(dir) {
  const binDir = path.join(dir, 'shim-exe');
  compileShimExe(path.join(binDir, 'powershell.exe'));
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
  t.after(() => cleanup(dir));

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
  t.after(() => cleanup(dir));

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
  t.after(() => cleanup(dir));

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

  const calls = shimRecords(log, 'powershell.exe');
  assert.ok(calls.length >= 2,
    `应先下载再执行，实际调用：\n${readShimLog(log).join('\n')}`);
  assert.match(calls[0].argv.join(' '), /raw\.githubusercontent\.com/,
    '第一次调用应该是去取 install-hub.ps1');

  // 逐项取 -File 的下一个参数：脚本路径必须是完整的一个参数。
  const last = calls[calls.length - 1];
  const fileIdx = last.argv.findIndex((a) => /^-File$/i.test(a));
  assert.ok(fileIdx >= 0 && fileIdx + 1 < last.argv.length,
    `下载完要真的执行它，实际参数：${JSON.stringify(last.argv)}`);
  assert.match(last.argv[fileIdx + 1], /install-hub\.ps1$/i,
    `应执行下载下来的那个脚本，实际：${JSON.stringify(last.argv)}`);
});

test('clone 前发现目标目录已有内容：明确失败，绝不删除', { skip: !WINDOWS }, (t) => {
  const dir = tmpdir('no-delete');
  t.after(() => cleanup(dir));

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
  t.after(() => cleanup(dir));

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
  t.after(() => cleanup(dir));

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
  t.after(() => cleanup(dir));

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

// ---------------------------------------------------------------------------
// 自定义 -DataDir 必须贯穿整条链路。
//
// Codex 2 轮次2 审查复现：用 -DataDir D 装完并写了网关配置后，
//   - 脚本打印的"切回个人账号"命令里没有 -DataDir，照着敲会在默认目录新建配置，
//     D 里仍然是 api 模式；
//   - Start-Process 不设 CLAUDE_HUB_DATA_DIR，桌面快捷方式也只带源码目录，
//     于是 Hub 启动后读的是默认目录 —— 写 A 读 B。
// core/data-dir.js 只认 CLAUDE_HUB_DATA_DIR，所以每一个出口都得把它带上。
//
// 这组用例把 USERPROFILE 也指到临时目录，因此默认数据目录和"桌面"都在沙箱里，
// 不会碰到真实桌面或生产 ~/.claude-session-hub。
// ---------------------------------------------------------------------------

/**
 * 搭一个能跑完整条 setup.ps1 的沙箱：假 Hub 源码 + 假 HOME + npm/claude/electron 替身。
 * hubName / homeName 可以带中文和空格，用来验证安装器不会在路径上丢字符。
 */
function makeInstallSandbox(tag, { hubName = 'hub', homeName = 'home' } = {}) {
  const root = tmpdir(tag);
  const hub = path.join(root, hubName);
  const home = path.join(root, homeName);
  const binDir = path.join(root, 'bin');
  const log = path.join(root, 'shim.log');

  // 没有 .git 的源码树 = 解压 zip 的场景，setup.ps1 会就地安装，不需要 git 远端。
  seedHubTree(hub);
  fs.copyFileSync(path.join(ROOT, 'setup.ps1'), path.join(hub, 'setup.ps1'));
  fs.mkdirSync(path.join(home, 'Desktop'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude-session-hub'), { recursive: true });

  // npm / claude 只要"存在且成功"；electron 是 exe 替身，负责记录它看到的数据目录。
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'npm.cmd'), '@echo off\r\nexit /b 0\r\n', 'ascii');
  fs.writeFileSync(path.join(binDir, 'claude.cmd'), '@echo off\r\nexit /b 0\r\n', 'ascii');
  compileShimExe(path.join(hub, 'node_modules', 'electron', 'dist', 'electron.exe'));

  return {
    root, hub, home, log,
    setup: path.join(hub, 'setup.ps1'),
    env: { USERPROFILE: home, SHIM_LOG: log, PATH: `${binDir};${process.env.PATH}` },
    defaultDataDir: path.join(home, '.claude-session-hub'),
    lnk: path.join(home, 'Desktop', 'AI Hub.lnk'),
  };
}

function readLnkTarget(lnkPath) {
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${lnkPath}'); `
    + `[pscustomobject]@{Target=$s.TargetPath;Arguments=$s.Arguments} | ConvertTo-Json -Compress`],
    { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  return JSON.parse((res.stdout || '').replace(/^﻿/, ''));
}

const backendsOf = (cfgPath) => {
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  return `claude=${cfg.providers.claude.backend},codex=${cfg.providers.codex.backend}`;
};

test('自定义 -DataDir 贯穿回退命令、快捷方式与启动，默认目录不受影响', { skip: !WINDOWS }, (t) => {
  const sb = makeInstallSandbox('datadir');
  t.after(() => cleanup(sb.root));

  // 默认目录里放个哨兵，安装结束时它必须原封不动，也不该多出 config.json。
  const sentinel = path.join(sb.defaultDataDir, 'sentinel.txt');
  fs.writeFileSync(sentinel, '默认目录不该被碰', 'utf8');
  // 路径带空格：脚本打印的命令必须能直接粘贴执行。
  const customData = path.join(sb.root, 'my data dir');

  // 127.0.0.1:1 必然连不上 -> 走"网关探测失败"分支，正是要检查的那段提示。
  const install = runPowerShell(sb.setup,
    ['-Token', TOKEN, '-DataDir', customData, '-MeridianUrl', 'http://127.0.0.1:1'],
    { cwd: sb.hub, env: sb.env });
  assert.equal(install.code, 0, `安装应成功完成：\n${install.out}`);

  // 1) 配置写在自定义目录，默认目录纹丝不动
  const customCfg = path.join(customData, 'config.json');
  assert.ok(fs.existsSync(customCfg), `配置没写进 -DataDir：\n${install.out}`);
  assert.equal(backendsOf(customCfg), 'claude=api,codex=api');
  assert.equal(fs.readFileSync(sentinel, 'utf8'), '默认目录不该被碰');
  assert.ok(!fs.existsSync(path.join(sb.defaultDataDir, 'config.json')),
    '不该在默认目录凭空造一份配置');

  // 2) 提示里的回退命令必须带 -DataDir，而且照抄能用
  const fallback = install.out.split(/\r?\n/)
    .map((l) => l.trim().replace(/^WARN:\s*/, ''))
    .find((l) => /^powershell .*-UseOwnAccount/.test(l));
  assert.ok(fallback, `网关失败时应打印可执行的回退命令：\n${install.out}`);
  assert.match(fallback, /-DataDir/, '回退命令漏了 -DataDir —— 照做只会在默认目录另建一份');
  assert.ok(fallback.includes(customData), '回退命令里的路径要是安装时那一个');

  const switched = spawnSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', fallback],
    { cwd: sb.hub, env: { ...process.env, ...sb.env }, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  assert.equal(switched.status, 0, `${switched.stdout}${switched.stderr}`);
  assert.equal(backendsOf(customCfg), 'claude=subscription,codex=subscription',
    '照着提示执行后，自定义目录里的后端必须真的切过来');
  assert.ok(!fs.existsSync(path.join(sb.defaultDataDir, 'config.json')),
    '回退命令仍然不该动默认目录');

  // 3) 启动时 Hub 真的拿到了这个目录，且源码路径是完整的一个参数
  const launches = shimRecords(sb.log, 'electron.exe');
  assert.ok(launches.length >= 1, `应当启动过 electron 替身：\n${readShimLog(sb.log).join('\n')}`);
  for (const rec of launches) {
    assert.equal(rec.dataDir, customData, 'Hub 启动时看到的数据目录不对');
    assert.deepEqual(rec.argv, [sb.hub],
      `源码目录必须是完整的一个参数，实际：${JSON.stringify(rec.argv)}`);
  }

  // 4) 桌面快捷方式经由启动器带上同一个目录
  const launcher = path.join(sb.hub, 'launch-hub.ps1');
  assert.ok(fs.existsSync(launcher), '自定义数据目录需要一个能设环境变量的启动器');
  const launcherText = fs.readFileSync(launcher, 'utf8').replace(/^﻿/, '');
  assert.match(launcherText, /CLAUDE_HUB_DATA_DIR/);
  assert.ok(launcherText.includes(customData));
  const lnk = readLnkTarget(sb.lnk);
  assert.match(lnk.Target.toLowerCase(), /powershell\.exe$/,
    '快捷方式要经由 PowerShell 启动器，直指 electron.exe 就会读回默认目录');
  assert.ok(lnk.Arguments.includes(launcher), `快捷方式没指向启动器：${lnk.Arguments}`);
});

test('默认数据目录时快捷方式仍直指 electron.exe，不多造启动器', { skip: !WINDOWS }, (t) => {
  const sb = makeInstallSandbox('datadir-default');
  t.after(() => cleanup(sb.root));

  const install = runPowerShell(sb.setup, ['-NoLaunch'], { cwd: sb.hub, env: sb.env });
  assert.equal(install.code, 0, install.out);

  assert.ok(!fs.existsSync(path.join(sb.hub, 'launch-hub.ps1')),
    '默认安装不该多出启动器（会白白闪一个控制台窗口）');
  const lnk = readLnkTarget(sb.lnk);
  assert.equal(lnk.Target.toLowerCase(),
    path.join(sb.hub, 'node_modules', 'electron', 'dist', 'electron.exe').toLowerCase());
  assert.ok(lnk.Arguments.includes(sb.hub));
});

test('损坏的 config.json 会让安装明确失败，而不是打印 SETUP COMPLETE', { skip: !WINDOWS }, (t) => {
  const sb = makeInstallSandbox('broken-cfg');
  t.after(() => cleanup(sb.root));

  const cfgPath = path.join(sb.defaultDataDir, 'config.json');
  const damaged = '{"providers":{"claude":{"backend":"api","api_key":"REAL-KEY"';
  fs.writeFileSync(cfgPath, damaged, 'utf8');

  const res = runPowerShell(sb.setup, ['-UseOwnAccount', '-NoLaunch'], { cwd: sb.hub, env: sb.env });
  assert.notEqual(res.code, 0, `必须失败退出：\n${res.out}`);
  assert.doesNotMatch(res.out, /SETUP COMPLETE/,
    '配置没改成却报成功 —— 这正是轮次2 的 P1 缺陷');
  assert.equal(fs.readFileSync(cfgPath, 'utf8'), damaged, '原配置必须原样保留');
});

// ---------------------------------------------------------------------------
// 桌面入口必须原样带住路径里的中文。
//
// Codex 2 轮次3 在真实安装里复现：`-DataDir <...>\data-中文资料` 装完退出 0，
// 但生成的 launch-hub.cmd 里写着 `data-????` —— 中文已不可逆丢失。当时的启动器
// 是用 ASCIIEncoding 写的 .cmd，而 .cmd 本身还要按控制台代码页解释，双重不靠谱。
// 于是安装当场看着正常，以后双击桌面图标却打开了一个不存在的目录。
//
// 这条用例不看文件内容就下结论：它把 .lnk 交给 Windows 外壳真正执行一遍，
// 再看 electron 进程实际拿到的 CLAUDE_HUB_DATA_DIR 是否与中文路径逐字相等。
// ---------------------------------------------------------------------------

/** PowerShell 单引号字面量：只有 ' 需要转义，反斜杠原样（别用 JSON.stringify）。 */
const psLit = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * 跑 setup.ps1 并按 UTF-8 收集输出。PowerShell 5.1 的控制台默认不是 UTF-8，
 * 直接用 -File 拿到的中文是乱码，没法断言“打印出来的路径还是原样”。
 * 开关（-Foo）不能加引号，否则会被当成位置参数的值。
 */
function runPowerShellUtf8(scriptPath, args, { cwd, env } = {}) {
  const argLine = args.map((a) => (String(a).startsWith('-') ? String(a) : psLit(a))).join(' ');
  const cmd = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; `
    + `& ${psLit(scriptPath)} ${argLine}; exit $LASTEXITCODE`;
  const res = spawnSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd],
    { cwd, env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true, timeout: 180000 });
  return { code: res.status, out: `${res.stdout || ''}${res.stderr || ''}` };
}

/** 让 Windows 外壳按快捷方式定义启动它，并等到 electron 替身落日志为止。 */
function launchViaShortcut(lnkPath, logPath, env) {
  const ps = [
    `Start-Process -FilePath ${psLit(lnkPath)}`,
    '$deadline = (Get-Date).AddSeconds(25)',
    'while ((Get-Date) -lt $deadline) {',
    `  if ((Test-Path ${psLit(logPath)}) -and `
      + `(Select-String -Path ${psLit(logPath)} -Pattern 'electron.exe' -SimpleMatch -Quiet)) { break }`,
    '  Start-Sleep -Milliseconds 200',
    '}',
  ].join('; ');
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
    { env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true, timeout: 120000 });
}

const readShimLog = (logPath) => (fs.existsSync(logPath)
  ? fs.readFileSync(logPath, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean)
  : []);

/**
 * 解析替身写的一行：`<exe>|ARGC=n|<arg0>\u001F<arg1>...|CLAUDE_HUB_DATA_DIR=<dir>`
 * 返回逐项 argv，绝不把它们拼回一个字符串 —— 那样就分不出
 * 「一个带空格的参数」和「两个参数」。
 */
function parseShimLine(line) {
  const m = line.match(/^([^|]+)\|ARGC=(\d+)\|([\s\S]*)\|CLAUDE_HUB_DATA_DIR=([\s\S]*)$/);
  assert.ok(m, `替身日志格式不对：${JSON.stringify(line)}`);
  const argc = Number(m[2]);
  const argv = argc === 0 ? [] : m[3].split('\u001F');
  assert.equal(argv.length, argc, `ARGC 与实际参数数量不符：${JSON.stringify(line)}`);
  return { exe: m[1], argv, dataDir: m[4] };
}

// argv[0] 取决于调用方怎么写的：bat 里是 `powershell`，Start-Process 给的是全路径，
// 所以比较时统一去掉 .exe 后缀。
const baseName = (s) => s.replace(/\.exe$/i, '').toLowerCase();
const shimRecords = (logPath, exe) => readShimLog(logPath)
  .map(parseShimLine).filter((r) => baseName(r.exe) === baseName(exe));

test('中文 + 空格路径：桌面快捷方式实际启动时拿到的仍是原路径', { skip: !WINDOWS }, (t) => {
  // 源码目录、用户目录、数据目录三处都带中文，再加空格。
  const sb = makeInstallSandbox('unicode', { hubName: 'Hub 源码目录', homeName: '用户 张三' });
  t.after(() => cleanup(sb.root));

  const sentinel = path.join(sb.defaultDataDir, 'sentinel.txt');
  fs.writeFileSync(sentinel, '默认目录不该被碰', 'utf8');
  const customData = path.join(sb.root, 'data-中文资料 带空格');

  const install = runPowerShell(sb.setup, ['-DataDir', customData, '-NoLaunch'],
    { cwd: sb.hub, env: sb.env });
  assert.equal(install.code, 0, `安装应成功：\n${install.out}`);

  // 1) 启动器文件里的路径逐字正确（?? 就是当初的症状）
  const launcher = path.join(sb.hub, 'launch-hub.ps1');
  assert.ok(fs.existsSync(launcher), `应生成启动器：\n${install.out}`);
  const launcherText = fs.readFileSync(launcher, 'utf8').replace(/^﻿/, '');
  assert.ok(launcherText.includes(customData),
    `启动器里的数据目录被写坏了：\n${launcherText}`);
  assert.ok(launcherText.includes(sb.hub), '源码目录同样不能被写坏');
  assert.doesNotMatch(launcherText, /\?\?/, '出现 ?? 说明又用了装不下中文的编码');

  // 2) 真的按快捷方式启动一次，看进程拿到什么
  const beforeCount = shimRecords(sb.log, 'electron.exe').length;
  const launched = launchViaShortcut(sb.lnk, sb.log, sb.env);
  assert.equal(launched.status, 0, `${launched.stdout}${launched.stderr}`);

  const records = shimRecords(sb.log, 'electron.exe').slice(beforeCount);
  assert.ok(records.length >= 1,
    `双击快捷方式应当真的把 Hub 拉起来：\n${launched.stdout}${launched.stderr}\n${readShimLog(sb.log).join('\n')}`);
  for (const rec of records) {
    assert.equal(rec.dataDir, customData, '快捷方式启动后 Hub 看到的目录不对');
    // 重点是参数数量：被空格拆成两段的路径，拼回去正好等于原路径，
    // 所以只能逐项比对 —— 轮次4 的 P1 就是被"拼回去再 includes"放过的。
    assert.deepEqual(rec.argv, [sb.hub],
      `源码目录被空格拆开了，实际：${JSON.stringify(rec.argv)}`);
  }

  // 3) 默认目录仍旧没被碰
  assert.equal(fs.readFileSync(sentinel, 'utf8'), '默认目录不该被碰');
  assert.ok(!fs.existsSync(path.join(sb.defaultDataDir, 'config.json')));
});

test('中文数据目录：写进去的配置能被 Hub 的配置加载器读回来', { skip: !WINDOWS }, (t) => {
  const sb = makeInstallSandbox('unicode-cfg', { homeName: '用户 李四' });
  t.after(() => cleanup(sb.root));

  const customData = path.join(sb.root, '数据目录 中文');
  const install = runPowerShellUtf8(sb.setup,
    ['-Token', TOKEN, '-DataDir', customData, '-SkipHealthCheck', '-NoLaunch'],
    { cwd: sb.hub, env: sb.env });
  assert.equal(install.code, 0, install.out);

  const cfgPath = path.join(customData, 'config.json');
  assert.ok(fs.existsSync(cfgPath), `配置应落在中文目录里：\n${install.out}`);
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.equal(cfg.providers.claude.backend, 'api');
  assert.equal(cfg.providers.claude.api_key, TOKEN);

  // 收尾汇总里打印的目录也必须是原样的中文，组员要照着它排查问题。
  assert.ok(install.out.includes(customData),
    `收尾汇总里的数据目录被写坏了：\n${install.out}`);
});

test('纯英文但带空格的安装路径：快捷方式启动同样不能把路径拆开', { skip: !WINDOWS }, (t) => {
  // 中文只是把问题放大了；真正的根因是参数边界，纯 ASCII 带空格照样中招。
  const sb = makeInstallSandbox('spaces', { hubName: 'Hub With Spaces', homeName: 'User Name' });
  t.after(() => cleanup(sb.root));

  const customData = path.join(sb.root, 'My Hub Data');
  const install = runPowerShell(sb.setup, ['-DataDir', customData, '-NoLaunch'],
    { cwd: sb.hub, env: sb.env });
  assert.equal(install.code, 0, install.out);

  const beforeCount = shimRecords(sb.log, 'electron.exe').length;
  const launched = launchViaShortcut(sb.lnk, sb.log, sb.env);
  assert.equal(launched.status, 0, `${launched.stdout}${launched.stderr}`);

  const records = shimRecords(sb.log, 'electron.exe').slice(beforeCount);
  assert.ok(records.length >= 1,
    `快捷方式没把 Hub 拉起来：\n${launched.stdout}${launched.stderr}\n${readShimLog(sb.log).join('\n')}`);
  for (const rec of records) {
    assert.equal(rec.argv.length, 1,
      `应用路径必须是一个参数，实际 ${rec.argv.length} 个：${JSON.stringify(rec.argv)}`);
    assert.equal(rec.argv[0], sb.hub);
    assert.equal(rec.dataDir, customData);
  }
});
