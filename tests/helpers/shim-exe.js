'use strict';

// 一个最小的「记录用」可执行替身，给安装脚本的测试顶替 electron / powershell。
//
// 为什么必须是 .exe 而不是 .cmd：批处理里不加 call 直接调另一个 .cmd，控制权
// 一去不返，于是「下载完到底有没有启动它」这种断言会被测成假绿（轮次2 踩过）。
//
// 为什么逐项记录 argv：用空格把参数拼回一个字符串，正好会把「带空格的路径被拆成
// 两段」这种缺陷重新粘合成原样（轮次4 的 P1 就是这么漏过去的）。分隔符用
// \u001F(US)，Windows 路径里不可能出现。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SOURCE = `
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
}`;

// 编译一次就够：Add-Type 每次都要拉起 PowerShell + csc，在闸门默认并发 16 下
// 反复编译足以把同批别的测试饿到超时。
let _template = null;

function buildShimTemplate() {
  if (_template && fs.existsSync(_template)) return _template;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-shim-template-'));
  const exePath = path.join(dir, 'shim-template.exe');
  const srcPath = path.join(dir, 'shim.cs');
  fs.writeFileSync(srcPath, SOURCE, 'utf8');
  const build = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Add-Type -TypeDefinition (Get-Content -Raw '${srcPath}') -OutputType ConsoleApplication -OutputAssembly '${exePath}'`],
    { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  assert.ok(fs.existsSync(exePath), `编译替身模板失败：\n${build.stdout}${build.stderr}`);
  _template = exePath;
  return exePath;
}

/** 把替身放到指定位置（复制模板，不重复编译）。 */
function placeShimExe(exePath) {
  fs.mkdirSync(path.dirname(exePath), { recursive: true });
  fs.copyFileSync(buildShimTemplate(), exePath);
  return exePath;
}

const readShimLog = (logPath) => (fs.existsSync(logPath)
  ? fs.readFileSync(logPath, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean)
  : []);

/** 解析一行：`<exe>|ARGC=n|<arg0>\u001F<arg1>...|CLAUDE_HUB_DATA_DIR=<dir>` */
function parseShimLine(line) {
  const m = line.match(/^([^|]+)\|ARGC=(\d+)\|([\s\S]*)\|CLAUDE_HUB_DATA_DIR=([\s\S]*)$/);
  assert.ok(m, `替身日志格式不对：${JSON.stringify(line)}`);
  const argc = Number(m[2]);
  const argv = argc === 0 ? [] : m[3].split('\u001F');
  assert.equal(argv.length, argc, `ARGC 与实际参数数量不符：${JSON.stringify(line)}`);
  return { exe: m[1], argv, dataDir: m[4] };
}

// argv[0] 取决于调用方怎么写的：bat 里是 `powershell`，Start-Process 给的是全路径。
const baseName = (s) => s.replace(/\.exe$/i, '').toLowerCase();

const shimRecords = (logPath, exe) => readShimLog(logPath)
  .map(parseShimLine).filter((r) => baseName(r.exe) === baseName(exe));

module.exports = { placeShimExe, buildShimTemplate, readShimLog, parseShimLine, shimRecords };
