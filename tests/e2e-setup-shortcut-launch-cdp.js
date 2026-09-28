'use strict';
// 经「安装器真实生成的桌面快捷方式」启动真实 Electron Hub 的验收。
//
// 单元测试里的 electron 是编译出来的记录用替身，能证明参数和环境变量怎么传，
// 但证明不了真 Hub 起得来。这个脚本补上那一段：真实源码 + 真实 Electron，
// 安装路径故意带中文和空格，然后把 .lnk 交给 Windows 外壳启动。
//
// 边界（Codex 2 轮次4 的要求）：
//   - 依赖用 junction 复用主目录，脚本内绝不 npm install；
//   - npm / claude 只用返回 0 的替身顶掉存在性检查，Electron 是真的；
//   - 窗口走 CLAUDE_HUB_E2E_WINDOW_MODE=background，不抢用户焦点；
//   - 只按精确命令行匹配到的 PID 收尾，不碰任何别的 electron 进程。
//
// 用法：node tests/e2e-setup-shortcut-launch-cdp.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const psLit = (s) => `'${String(s).replace(/'/g, "''")}'`;

function ps(command, { env, timeout = 180000 } = {}) {
  return spawnSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true, timeout });
}

/** 按命令行精确匹配找出本次沙箱里的 electron 进程，绝不按进程名一网打尽。 */
function findSandboxElectron(hubDir) {
  const out = ps(`[Console]::OutputEncoding=[Text.Encoding]::UTF8; `
    + `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | `
    + `Where-Object { $_.CommandLine -like ${psLit(`*${hubDir}*`)} } | `
    + `Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress`);
  const text = (out.stdout || '').replace(/^﻿/, '').trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-lnk-e2e-'));
  // 中文 + 空格：两种坑一次覆盖。
  const hub = path.join(root, 'Hub 源码目录');
  const home = path.join(root, '用户 张三');
  const dataDir = path.join(root, 'data-中文资料 带空格');
  const binDir = path.join(root, 'bin');
  const result = { root, hub, dataDir, checks: [], passed: false };
  const started = [];

  try {
    fs.mkdirSync(path.join(home, 'Desktop'), { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });

    // 1. 真实源码副本（不含 node_modules / .git），依赖用 junction 复用主目录
    const copy = spawnSync('robocopy', [ROOT, hub, '/E', '/XD', 'node_modules', '.git', 'artifacts',
      '/XF', '*.log', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { encoding: 'utf8', windowsHide: true });
    assert.ok((copy.status ?? 8) < 8, `robocopy 失败：${copy.status}\n${copy.stdout}`);
    const link = spawnSync('cmd.exe', ['/c', 'mklink', '/J',
      path.join(hub, 'node_modules'), path.join(ROOT, 'node_modules')],
      { encoding: 'utf8', windowsHide: true });
    assert.equal(link.status, 0, `junction 失败：${link.stdout}${link.stderr}`);
    const electronExe = path.join(hub, 'node_modules', 'electron', 'dist', 'electron.exe');
    assert.ok(fs.existsSync(electronExe), '复用的依赖里应当有真实 electron.exe');
    result.checks.push('真实源码副本 + junction 依赖就绪（未执行 npm install）');

    // 2. npm / claude 顶掉存在性检查；Electron 保持真实
    fs.writeFileSync(path.join(binDir, 'npm.cmd'), '@echo off\r\nexit /b 0\r\n', 'ascii');
    fs.writeFileSync(path.join(binDir, 'claude.cmd'), '@echo off\r\nexit /b 0\r\n', 'ascii');

    const installEnv = {
      USERPROFILE: home,
      PATH: `${binDir};${process.env.PATH}`,
      CLAUDE_HUB_E2E_WINDOW_MODE: 'background',
    };
    const install = ps(`[Console]::OutputEncoding=[Text.Encoding]::UTF8; `
      + `& ${psLit(path.join(hub, 'setup.ps1'))} -DataDir ${psLit(dataDir)} -NoLaunch; exit $LASTEXITCODE`,
      { env: installEnv });
    assert.equal(install.status, 0, `安装应成功：\n${install.stdout}${install.stderr}`);
    result.checks.push('setup.ps1 在中文+空格路径下安装成功');

    // 3. 快捷方式确实建出来了，并且指向启动器
    const lnk = path.join(home, 'Desktop', 'AI Hub.lnk');
    assert.ok(fs.existsSync(lnk), '桌面快捷方式没建出来');
    const launcher = path.join(hub, 'launch-hub.ps1');
    assert.ok(fs.existsSync(launcher), '自定义数据目录应生成启动器');
    result.checks.push('.lnk 与 launch-hub.ps1 均已生成');

    // 4. 交给 Windows 外壳启动，等真 Hub 起来
    const launch = ps(`Start-Process -FilePath ${psLit(lnk)}`, { env: installEnv });
    assert.equal(launch.status, 0, `${launch.stdout}${launch.stderr}`);

    let procs = [];
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      procs = findSandboxElectron(hub);
      if (procs.length) break;
      await sleep(500);
    }
    assert.ok(procs.length, '快捷方式没能把真实 Hub 拉起来');
    for (const p of procs) started.push(p.ProcessId);
    result.pids = started.slice();

    // 5. 关键断言：源码路径作为一个完整参数出现（被拆开就不会带引号包住整段）
    const cmdlines = procs.map((p) => p.CommandLine || '');
    assert.ok(cmdlines.some((c) => c.includes(`"${hub}"`)),
      `应用路径没有作为完整参数传入：\n${cmdlines.join('\n')}`);
    result.checks.push('真实 Electron 命令行里源码路径是完整的一个参数');
    result.commandLine = cmdlines[0];

    // 6. Hub 真的在用这个数据目录（core/data-dir.js 只认 CLAUDE_HUB_DATA_DIR）。
    // 等到 Chromium 的 userData 落下来为止 —— 那是主进程真正初始化过的标志，
    // 光有一个 diagnostics 目录还说明不了 Hub 起到了哪一步。
    const wantMarkers = ['electron-userdata', 'state.json'];
    const dataDeadline = Date.now() + 120000;
    let entries = [];
    while (Date.now() < dataDeadline) {
      entries = fs.existsSync(dataDir) ? fs.readdirSync(dataDir) : [];
      if (wantMarkers.some((m) => entries.includes(m))) break;
      await sleep(500);
    }
    assert.ok(entries.length, `Hub 没有往 ${dataDir} 写任何东西，说明它读的是别的目录`);
    assert.ok(wantMarkers.some((m) => entries.includes(m)),
      `Hub 没有在该目录完成初始化，只看到：${entries.join(', ')}`);
    result.dataDirEntries = entries;
    result.checks.push(`数据目录被真实使用并完成初始化：${entries.join(', ')}`);

    // 渲染进程确实起来了：Hub 的 hook server 会把端口写进数据目录，
    // 拿它当"不只是进程活着，而是真的跑起来了"的旁证。
    const diagDir = path.join(dataDir, 'diagnostics');
    if (fs.existsSync(diagDir)) result.diagnostics = fs.readdirSync(diagDir).slice(0, 10);

    // 7. 进程活着，没有起来就崩
    await sleep(3000);
    assert.ok(findSandboxElectron(hub).length, 'Hub 启动后很快就退出了');
    result.checks.push('Hub 启动后保持运行');

    result.passed = true;
  } finally {
    // 只停本次按命令行精确匹配到的 PID
    for (const pid of started) {
      ps(`Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`);
    }
    await sleep(1500);
    try {
      spawnSync('cmd.exe', ['/c', 'rmdir', path.join(hub, 'node_modules')],
        { encoding: 'utf8', windowsHide: true });
      await sleep(500);
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch (e) {
      result.cleanupWarning = e.message;
    }
    console.log(JSON.stringify(result, null, 2));
  }
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
