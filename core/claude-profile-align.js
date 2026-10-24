'use strict';

// Claude 多账号对齐（2026-10-24 用户要求「账号 1 和 2 完全对齐」）。
// 主账号（~/.claude + ~/.claude.json）是唯一标准，单向同步到每个独立账号目录：
//   - settings.json：主账号的全部设置覆盖过来（权限模式、hook、模型、环境变量、插件开关……），
//     账号目录独有、主账号没有的键保留；
//   - skills / agents / output-styles / commands：按文件镜像，跳过点开头的目录和依赖/缓存目录；
//     只删除上次由本模块同步过来、而主账号已经删掉的文件（清单记在 .hub-align-manifest.json），
//     账号目录里自己新建的文件不动；
//   - plugins/installed_plugins.json、known_marketplaces.json：直接复用主账号已装好的插件；
//   - .claude.json 的 mcpServers：与主账号一致。
// 登录凭据（.credentials.json）、会话记录（projects/、history.jsonl）等账号自身数据一律不碰。
// 第一次对齐前把账号目录原来的 settings.json / .claude.json 备份到 .hub-align-backup/。
const fs = require('fs');
const path = require('path');

const MIRROR_DIRS = ['skills', 'agents', 'output-styles', 'commands'];
const PLUGIN_FILES = ['installed_plugins.json', 'known_marketplaces.json'];
const SKIP_DIRS = new Set(['node_modules', '__pycache__']);
const MANIFEST = '.hub-align-manifest.json';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJsonAtomic(file, value) {
  const temp = `${file}.hub-align-${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temp, file);
}

function listFiles(root, rel = '', out = []) {
  let entries;
  try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const child = rel ? path.join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) listFiles(root, child, out);
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

function sameFile(a, b) {
  try {
    const sa = fs.statSync(a); const sb = fs.statSync(b);
    return sa.size === sb.size && Math.abs(sa.mtimeMs - sb.mtimeMs) < 2000;
  } catch { return false; }
}

function mirrorDir(source, target, previous = []) {
  const files = listFiles(source);
  let copied = 0; let removed = 0;
  for (const rel of files) {
    const from = path.join(source, rel); const to = path.join(target, rel);
    if (sameFile(from, to)) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    const stat = fs.statSync(from);
    fs.utimesSync(to, stat.atime, stat.mtime);
    copied++;
  }
  const current = new Set(files);
  for (const rel of previous) {
    if (current.has(rel)) continue;
    try { fs.unlinkSync(path.join(target, rel)); removed++; } catch { /* 已不存在 */ }
  }
  return { files, copied, removed };
}

function backupOnce(profileDir) {
  const dir = path.join(profileDir, '.hub-align-backup');
  if (fs.existsSync(dir)) return null;
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['settings.json', '.claude.json']) {
    const file = path.join(profileDir, name);
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(dir, name));
  }
  return dir;
}

function alignClaudeProfile({ primaryDir, primaryStateFile, profileDir }) {
  const report = { profileDir, backup: null, settings: false, mirrored: {}, plugins: 0, mcpServers: false, errors: [] };
  if (!profileDir || path.resolve(profileDir).toLowerCase() === path.resolve(primaryDir).toLowerCase()) return report;
  if (!fs.existsSync(profileDir)) return report;
  try { report.backup = backupOnce(profileDir); } catch (error) { report.errors.push('备份失败：' + error.message); return report; }

  try {
    const primary = readJson(path.join(primaryDir, 'settings.json'));
    if (primary) {
      const file = path.join(profileDir, 'settings.json');
      const own = readJson(file) || {};
      const next = { ...own, ...primary };
      if (JSON.stringify(next) !== JSON.stringify(own)) { writeJsonAtomic(file, next); report.settings = true; }
    }
  } catch (error) { report.errors.push('settings.json：' + error.message); }

  const manifestFile = path.join(profileDir, MANIFEST);
  const manifest = readJson(manifestFile) || {};
  const nextManifest = {};
  for (const name of MIRROR_DIRS) {
    const source = path.join(primaryDir, name);
    if (!fs.existsSync(source)) { nextManifest[name] = []; continue; }
    try {
      const result = mirrorDir(source, path.join(profileDir, name), manifest[name] || []);
      nextManifest[name] = result.files;
      report.mirrored[name] = { copied: result.copied, removed: result.removed };
    } catch (error) {
      nextManifest[name] = manifest[name] || [];
      report.errors.push(name + '：' + error.message);
    }
  }
  try { writeJsonAtomic(manifestFile, nextManifest); } catch (error) { report.errors.push('清单：' + error.message); }

  for (const name of PLUGIN_FILES) {
    try {
      const from = path.join(primaryDir, 'plugins', name); const to = path.join(profileDir, 'plugins', name);
      if (!fs.existsSync(from) || (fs.existsSync(to) && fs.readFileSync(from).equals(fs.readFileSync(to)))) continue;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      report.plugins++;
    } catch (error) { report.errors.push('plugins/' + name + '：' + error.message); }
  }

  try {
    const primaryState = readJson(primaryStateFile);
    const stateFile = path.join(profileDir, '.claude.json');
    const state = readJson(stateFile);
    if (primaryState && state && JSON.stringify(state.mcpServers || {}) !== JSON.stringify(primaryState.mcpServers || {})) {
      state.mcpServers = primaryState.mcpServers || {};
      writeJsonAtomic(stateFile, state);
      report.mcpServers = true;
    }
  } catch (error) { report.errors.push('.claude.json：' + error.message); }
  return report;
}

module.exports = { alignClaudeProfile, mirrorDir, listFiles, MIRROR_DIRS };
