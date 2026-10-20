'use strict';
// Reuse the secretary's signed shell and code-update contract. No new booking engine.
const fs = require('node:fs'), path = require('node:path');
const crypto = require('node:crypto'), { execFile } = require('node:child_process');
const { downloadWithFallback } = require('../app-update/downloader');
const BUNDLE = path.join(__dirname, 'room-component');
const PUBLIC_KEY = crypto.createPublicKey({ key: Buffer.from('302a300506032b6570032100484b4c7e2085c284d6a569b95c8defd152dec09a2f3015a9be18c5df8ec2bed4', 'hex'), format: 'der', type: 'spki' });
const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, ordered(value[k])])) : value;
const version = v => String(v).split('.').map(Number).reduce((n, v) => n * 1000 + v, 0);
function manifest(file) {
  const m = JSON.parse(fs.readFileSync(file, 'utf8')), { signature, ...body } = m;
  if (m.app !== 'mishu-terminator' || !/^\d+\.\d+\.\d+$/.test(m.version)
      || !crypto.verify(null, Buffer.from(JSON.stringify(ordered(body)), 'utf8'), PUBLIC_KEY, Buffer.from(signature || '', 'hex'))) throw new Error('秘书组件签名不正确，未安装');
  for (const a of [m.code, m.exe].filter(Boolean)) {
    if (!/^[A-Za-z0-9_.-]+$/.test(a.file) || !Number.isSafeInteger(a.size) || a.size < 1 || !/^[a-f0-9]{64}$/.test(a.sha256)) throw new Error('秘书组件清单格式不正确');
  }
  return m;
}
function verified(file, asset) {
  return fs.existsSync(file) && fs.statSync(file).size === asset.size
    && crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') === asset.sha256;
}
const exec = (file, args, options = {}) => new Promise((resolve, reject) => {
  execFile(file, args, { windowsHide: true, timeout: 10000, encoding: 'utf8', maxBuffer: 1024 * 1024, ...options }, (error, stdout) => error ? reject(error) : resolve(stdout));
});
async function discover(a) {
  if (a.settings().rooms?.exePath && fs.existsSync(a.settings().rooms.exePath)) return a.settings().rooms.exePath;
  const local = path.join(a.dir, 'mishu'), candidates = [];
  if (process.platform === 'win32') {
    const script = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_Process -Filter \"Name LIKE 'MishuTerminator%' OR Name = '秘书终结者.exe'\" | Select-Object -ExpandProperty ExecutablePath -Unique";
    try { candidates.push(...(await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 5000 })).trim().split(/\r?\n/)); }
    catch (error) { console.warn('[company-assistant] 秘书进程定位未完成', error.message); }
  }
  for (const dir of [local, path.join(process.env.LOCALAPPDATA || a.dir, 'MishuTerminator'), path.join(process.env.USERPROFILE || a.dir, 'Downloads', '秘书终结者')]) {
    if (fs.existsSync(dir)) candidates.push(...fs.readdirSync(dir).filter(f => /^(?:MishuTerminator.*|秘书终结者)\.exe$/i.test(f)).map(f => path.join(dir, f)));
  }
  return [...new Set(candidates.filter(f => f && fs.existsSync(f)))][0] || '';
}
async function install(a, { onProgress = () => {}, fetchImpl, sources } = {}) {
  const existing = await discover(a);
  if (existing) return existing;
  const m = manifest(path.join(BUNDLE, 'baseline.json')), dest = path.join(a.dir, 'mishu', m.exe.file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (!fetchImpl) { try { fetchImpl = require('electron').net.fetch; } catch { fetchImpl = globalThis.fetch; } }
  const result = await downloadWithFallback({ sources: sources || [
    { id: 'github', name: 'GitHub', files: 'https://github.com/TianLin0509/mishu-terminator/releases/download/v{version}/' },
    { id: 'aliyun', name: '阿里云', files: 'https://me.lt-stockpartner.tech/hub-update/mishu/' },
  ], version: m.version, expect: { file: m.exe.file, bytes: m.exe.size, sha256: m.exe.sha256 }, dest, fetchImpl, onProgress });
  if (!result.ok) throw new Error('秘书组件下载失败：' + result.attempts.map(x => `${x.name}：${x.reason}`).join('；'));
  return dest;
}
async function stage(a, exe, home) {
  const m = manifest(path.join(BUNDLE, 'control.json')), source = path.join(BUNDLE, m.code.file);
  if (!verified(source, m.code)) throw new Error('秘书控制组件校验不通过');
  const updates = path.join(home, 'updates'), currentFile = path.join(updates, 'current.json');
  let current = null;
  try { current = JSON.parse(fs.readFileSync(currentFile, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw new Error('秘书更新记录读不了，请在秘书里检查更新状态'); }
  if (current && version(current.version) > version(m.version)) return { newer: true };
  if (current?.version === m.version && current.sha256 === m.code.sha256 && (current.bad || Number(current.boots) >= 3))
    throw new Error('此控制组件启动失败后已回退，未再次启用；请保留秘书现有版本，待修复组件后再接通');
  if (current?.version === m.version && current.sha256 === m.code.sha256 && !current.bad && verified(path.join(updates, m.code.file), m.code)) return { ready: true };
  // Query the shell against a temporary data directory; don't consume boot-retry count in the user's data.
  const probe = fs.mkdtempSync(path.join(a.dir, 'mishu-probe-')), output = path.join(probe, 'version.json');
  await exec(exe, ['--version-json', output], { env: { ...process.env, MSZ_HOME: probe } });
  const info = JSON.parse(fs.readFileSync(output, 'utf8'));
  if (info.exe_shell !== m.shell) throw new Error('现有秘书运行环境不兼容，请更新秘书后再接通');
  if (version(info.exe_version) >= version(m.version)) return { bundled: true };
  fs.mkdirSync(updates, { recursive: true });
  const dest = path.join(updates, m.code.file);
  if (fs.existsSync(dest) && !verified(dest, m.code)) throw new Error('已有同名秘书组件内容不同，未覆盖；请先在秘书里检查更新');
  if (!fs.existsSync(dest)) fs.copyFileSync(source, dest);
  if (current && !fs.existsSync(path.join(updates, 'before-hub-control.json'))) fs.writeFileSync(path.join(updates, 'before-hub-control.json'), JSON.stringify(current), 'utf8');
  const next = { version: m.version, file: m.code.file, sha256: m.code.sha256, shell: m.shell, boots: 0, bad: false, installed: Date.now() / 1000 };
  fs.writeFileSync(currentFile + '.hub.tmp', JSON.stringify(next), 'utf8'); fs.renameSync(currentFile + '.hub.tmp', currentFile);
  return { installed: true, version: m.version };
}
module.exports = { manifest, verified, discover, install, stage };
