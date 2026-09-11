'use strict';
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

// Resolve the binary belonging to the selected npm shim, never another PATH version.
// The npm JS wrapper spawns a console process without windowsHide on Windows.
function resolveWindowsCodex(env = process.env, options = {}) {
  const shim = options.shim || path.join(env.APPDATA || '', 'npm', 'codex.cmd');
  const match = fs.readFileSync(shim, 'utf8').match(/"([^"\r\n]*[\\/]bin[\\/]codex(?:-managed)?\.js)"/i);
  if (!match) throw new Error('无法解析 Codex npm 启动器：' + shim);
  const script = match[1].replace(/%dp0%/gi, path.dirname(shim) + path.sep);
  const source = fs.readFileSync(script, 'utf8');
  const packageRoot = path.resolve(path.dirname(script), '..');
  const arch = options.arch || process.arch;
  const triple = { x64: 'x86_64', arm64: 'aarch64' }[arch];
  if (!triple) throw new Error('不支持的 Codex Windows 架构：' + arch);
  let vendor = path.join(packageRoot, 'vendor');
  try {
    vendor = path.join(path.dirname(createRequire(script).resolve(`@openai/codex-win32-${arch}/package.json`)), 'vendor');
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
  }
  const target = path.join(vendor, triple + '-pc-windows-msvc');
  const command = ['bin', 'codex'].map(dir => path.join(target, dir, 'codex.exe')).find(file => fs.existsSync(file));
  if (!command) throw new Error('Codex 原生程序不存在：' + target);
  const managed = source.match(/CODEX_MANAGED_PACKAGE_ROOT:\s*("(?:[^"\\]|\\.)*")/);
  const launchEnv = { ...env, CODEX_MANAGED_PACKAGE_ROOT: managed ? JSON.parse(managed[1]) : packageRoot };
  for (const key of ['NPM', 'BUN', 'PNPM', 'VITE_PLUS']) delete launchEnv['CODEX_MANAGED_BY_' + key];
  launchEnv.CODEX_MANAGED_BY_NPM = '1';
  const pathKey = Object.keys(launchEnv).find(key => key.toLowerCase() === 'path') || 'PATH';
  const pathDir = path.join(target, 'path');
  if (fs.existsSync(pathDir)) launchEnv[pathKey] = pathDir + path.delimiter + (launchEnv[pathKey] || '');
  return { command, args: [], env: launchEnv };
}
module.exports = { resolveWindowsCodex };
